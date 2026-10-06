/**
 * The change tape: what moved between two catalog snapshots, one JSON line
 * per change in data/changes.jsonl. Pure functions over the raw on-disk
 * catalog shape, shared by scripts/changes.ts and the Ledger page.
 *
 * Kinds keep vendor facts apart from aggregate noise:
 * - list_price      a hand-checked vendor list price changed (checked both sides)
 * - aggregate_move  OpenRouter's aggregate price moved (provider mix, not a vendor decision)
 * Only input and output are ever checked by hand (data/overrides.json); cache
 * prices always come from OpenRouter, so a cache move is an aggregate move
 * even on a checked price list.
 * Capability scores are never diffed: Artificial Analysis rescales its
 * indices between versions, so a score change says nothing about the model.
 */

export type ChangeKind =
  | "added"
  | "removed"
  | "mode_added"
  | "mode_removed"
  | "list_price"
  | "list_correction"
  | "aggregate_move"
  | "promo_start"
  | "promo_end"
  | "promo_permanent"
  | "promo_change"
  | "tier_change"
  | "retirement_scheduled";

type Pair = [string, string];

export interface Change {
  /** Snapshot (as_of) date where the change was seen. */
  date: string;
  /** The previous snapshot it was compared against. */
  since: string;
  kind: ChangeKind;
  key: string;
  name: string;
  vendor: string;
  mode?: string;
  /** [old, new] USD per 1M tokens, as decimal strings — only the fields that moved. */
  input?: Pair;
  output?: Pair;
  cache_read?: Pair;
  cache_write?: Pair;
  cache_write_1h?: Pair;
  /** For removals: the last known price, its price list and its source. */
  last?: { input: string; output: string; mode?: string; provenance?: "FirstParty" | "Aggregate" };
  /** For retirements: the scheduled date. */
  retires_on?: string;
  /** For promos: the promo's end date. */
  until?: string;
}

interface RawCard {
  input: string;
  output: string;
  cache_read?: string | null;
  cache_write?: string | null;
  cache_write_1h?: string | null;
  tiers?: { above_input_tokens: number; input: string; output: string; cache_read: string | null }[];
  promo: { input: string; output: string; until: string } | null;
  /** Set by ingest on a price list a person checked against the vendor. */
  checked?: boolean;
}

export interface RawModel {
  key: string;
  display_name: string;
  vendor_name: string;
  provenance: "FirstParty" | "Aggregate";
  rates: [string, RawCard][];
  retires_on?: string | null;
}

/** Compare decimal strings numerically ("2.000000" equals "2.00"); null and undefined only equal each other. */
const same = (a: string | null | undefined, b: string | null | undefined) =>
  a == null || b == null ? a == b : Number(a) === Number(b);

/**
 * Whether a price list was hand-checked against the vendor. Snapshots from
 * before ingest recorded this per list are read the way overrides worked
 * then: only the Standard list of a FirstParty model was checked.
 */
function checker(snapshot: RawModel[]) {
  const legacy = !snapshot.some((m) => m.rates.some(([, c]) => "checked" in c));
  return (m: RawModel, mode: string, card: RawCard) =>
    legacy ? m.provenance === "FirstParty" && mode === "Standard" : card.checked === true;
}

/** Kinds the Ledger and the feeds group as "Vendor list prices". */
export const VENDOR_KINDS: ChangeKind[] = ["list_price", "list_correction", "promo_permanent"];

/** Price fields a change can carry, with their reader-facing labels. */
export const PRICE_FIELDS = [
  ["input", "in"],
  ["output", "out"],
  ["cache_read", "cache read"],
  ["cache_write", "cache write"],
  ["cache_write_1h", "1h cache write"],
] as const satisfies readonly (readonly [keyof Change, string])[];

const CACHE_FIELDS = ["cache_read", "cache_write", "cache_write_1h"] as const;

/** "in 3.00 → 2.00 · cache read none → 0.30": whichever price fields the change carries. */
export function movesText(c: Change): string {
  return PRICE_FIELDS.filter(([f]) => c[f])
    .map(([f, label]) => {
      const [a, b] = c[f]!;
      return `${label} ${a === "" ? "none" : a} → ${b === "" ? "none" : b}`;
    })
    .join(" · ");
}

const tierKey = (c: RawCard) =>
  JSON.stringify((c.tiers ?? []).map((t) => [t.above_input_tokens, Number(t.input), Number(t.output), Number(t.cache_read)]));

export function diffCatalogs(prev: RawModel[], next: RawModel[], since: string, date: string): Change[] {
  const before = new Map(prev.map((m) => [m.key, m]));
  const after = new Map(next.map((m) => [m.key, m]));
  const wasChecked = checker(prev);
  const isChecked = checker(next);
  const out: Change[] = [];
  const base = (m: RawModel) => ({ date, since, key: m.key, name: m.display_name.trim(), vendor: m.vendor_name });

  for (const m of next) {
    const old = before.get(m.key);
    if (!old) {
      out.push({ ...base(m), kind: "added" });
      continue;
    }
    const oldCards = new Map(old.rates);
    const newCards = new Map(m.rates);
    for (const [mode, card] of m.rates) {
      const was = oldCards.get(mode);
      if (!was) {
        out.push({ ...base(m), kind: "mode_added", mode });
        continue;
      }
      // Cache prices: only compared when the earlier snapshot recorded the
      // field, so a newly ingested field isn't read as a move.
      const cacheMoved: Partial<Change> = {};
      for (const f of CACHE_FIELDS) {
        if (f in was && !same(was[f], card[f])) cacheMoved[f] = [was[f] ?? "", card[f] ?? ""];
      }
      const cacheMove = Object.keys(cacheMoved).length > 0;
      // A promo that became the list price: the price in force didn't change.
      const madePermanent =
        was.promo && !card.promo && same(was.promo.input, card.input) && same(was.promo.output, card.output);
      if (madePermanent) {
        out.push({ ...base(m), kind: "promo_permanent", mode, input: [was.input, card.input], output: [was.output, card.output] });
        if (cacheMove) out.push({ ...base(m), kind: "aggregate_move", mode, ...cacheMoved });
      } else {
        const moved: Partial<Change> = {};
        if (!same(was.input, card.input)) moved.input = [was.input, card.input];
        if (!same(was.output, card.output)) moved.output = [was.output, card.output];
        const a = wasChecked(old, mode, was);
        const b = isChecked(m, mode, card);
        // Both sides hand-checked: a vendor list-price change. Newly checked:
        // a hand-checked price replacing an aggregate one. Anything else is
        // OpenRouter's aggregate moving.
        const kind: ChangeKind = a && b ? "list_price" : !a && b ? "list_correction" : "aggregate_move";
        if (Object.keys(moved).length) {
          // Cache moves ride along with an aggregate move; next to a checked
          // price they get their own aggregate entry.
          out.push({ ...base(m), kind, mode, ...moved, ...(kind === "aggregate_move" ? cacheMoved : {}) });
          if (cacheMove && kind !== "aggregate_move") out.push({ ...base(m), kind: "aggregate_move", mode, ...cacheMoved });
        } else if (cacheMove) {
          out.push({ ...base(m), kind: "aggregate_move", mode, ...cacheMoved });
        }
        if (!was.promo && card.promo) out.push({ ...base(m), kind: "promo_start", mode, until: card.promo.until });
        if (was.promo && !card.promo) out.push({ ...base(m), kind: "promo_end", mode, until: was.promo.until });
      }
      if (
        was.promo &&
        card.promo &&
        (!same(was.promo.input, card.promo.input) || !same(was.promo.output, card.promo.output) || was.promo.until !== card.promo.until)
      ) {
        out.push({ ...base(m), kind: "promo_change", mode, until: card.promo.until });
      }
      if (was.tiers && card.tiers && tierKey(was) !== tierKey(card)) out.push({ ...base(m), kind: "tier_change", mode });
    }
    for (const [mode] of old.rates) {
      if (!newCards.has(mode)) out.push({ ...base(m), kind: "mode_removed", mode });
    }
    // Only when the earlier snapshot tracked retirements at all: a field that
    // didn't exist yet isn't evidence that a retirement was just announced.
    if (m.retires_on && old.retires_on !== undefined && m.retires_on !== old.retires_on) {
      out.push({ ...base(m), kind: "retirement_scheduled", retires_on: m.retires_on });
    }
  }
  for (const m of prev) {
    if (after.has(m.key)) continue;
    const entry = m.rates.find(([mode]) => mode === "Standard") ?? m.rates[0];
    out.push({
      ...base(m),
      kind: "removed",
      last: entry && {
        input: entry[1].input,
        output: entry[1].output,
        mode: entry[0],
        provenance: wasChecked(m, entry[0], entry[1]) ? "FirstParty" : "Aggregate",
      },
    });
  }

  const order: ChangeKind[] = [
    "list_price",
    "list_correction",
    "promo_permanent",
    "added",
    "removed",
    "retirement_scheduled",
    "promo_start",
    "promo_end",
    "promo_change",
    "mode_added",
    "mode_removed",
    "tier_change",
    "aggregate_move",
  ];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The tape is append-only: a rerun adds only entries it doesn't already
 * hold, so a second refresh on the same day can never erase the first.
 */
export function appendToTape(tape: Change[], fresh: Change[]): Change[] {
  const have = new Set(tape.map((c) => JSON.stringify(c)));
  return [...tape, ...fresh.filter((c) => !have.has(JSON.stringify(c)))];
}

export function parseTape(text: string): Change[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Change);
}

/** Relative change of a [old, new] price pair, e.g. -0.2 for a 20% cut; null when either side is missing or old is 0. */
export function relChange(pair: [string, string]): number | null {
  if (pair[0] === "" || pair[1] === "") return null;
  const [a, b] = pair.map(Number);
  return a === 0 ? null : (b - a) / a;
}

/** Changes on or after `since` (exclusive of snapshots at or before it) touching any of `keys`. */
export function changesFor(tape: Change[], keys: ReadonlySet<string>, sinceAsOf: string): Change[] {
  return tape.filter((c) => c.date > sinceAsOf && keys.has(c.key));
}
