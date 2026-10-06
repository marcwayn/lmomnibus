/**
 * The change tape: what moved between two catalog snapshots, one JSON line
 * per change in data/changes.jsonl. Pure functions over the raw on-disk
 * catalog shape, shared by scripts/changes.ts and the Ledger page.
 *
 * Kinds keep vendor facts apart from aggregate noise:
 * - list_price      a hand-checked vendor list price changed (FirstParty both sides)
 * - aggregate_move  OpenRouter's aggregate price moved (provider mix, not a vendor decision)
 * Capability scores are never diffed: Artificial Analysis rescales its
 * indices between versions, so a score change says nothing about the model.
 */

export type ChangeKind =
  | "added"
  | "removed"
  | "mode_added"
  | "mode_removed"
  | "list_price"
  | "aggregate_move"
  | "promo_start"
  | "promo_end"
  | "retirement_scheduled";

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
  /** [old, new] USD per 1M tokens, as decimal strings. */
  input?: [string, string];
  output?: [string, string];
  /** For removals: the last known Standard price, for the tombstone. */
  last?: { input: string; output: string };
  /** For retirements: the scheduled date. */
  retires_on?: string;
  /** For promos: the promo's end date. */
  until?: string;
}

interface RawCard {
  input: string;
  output: string;
  promo: { input: string; output: string; until: string } | null;
}

export interface RawModel {
  key: string;
  display_name: string;
  vendor_name: string;
  provenance: "FirstParty" | "Aggregate";
  rates: [string, RawCard][];
  retires_on?: string | null;
}

/** Compare decimal strings numerically ("2.000000" equals "2.00"). */
const same = (a: string, b: string) => Number(a) === Number(b);

export function diffCatalogs(prev: RawModel[], next: RawModel[], since: string, date: string): Change[] {
  const before = new Map(prev.map((m) => [m.key, m]));
  const after = new Map(next.map((m) => [m.key, m]));
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
      if (!same(was.input, card.input) || !same(was.output, card.output)) {
        const list = old.provenance === "FirstParty" && m.provenance === "FirstParty";
        out.push({
          ...base(m),
          kind: list ? "list_price" : "aggregate_move",
          mode,
          input: [was.input, card.input],
          output: [was.output, card.output],
        });
      }
      if (!was.promo && card.promo) out.push({ ...base(m), kind: "promo_start", mode, until: card.promo.until });
      if (was.promo && !card.promo) out.push({ ...base(m), kind: "promo_end", mode, until: was.promo.until });
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
    const std = new Map(m.rates).get("Standard") ?? m.rates[0]?.[1];
    out.push({ ...base(m), kind: "removed", last: std ? { input: std.input, output: std.output } : undefined });
  }

  const order: ChangeKind[] = [
    "list_price",
    "added",
    "removed",
    "retirement_scheduled",
    "promo_start",
    "promo_end",
    "mode_added",
    "mode_removed",
    "aggregate_move",
  ];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function parseTape(text: string): Change[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Change);
}

/** Relative change of a [old, new] price pair, e.g. -0.2 for a 20% cut; null when old is 0. */
export function relChange(pair: [string, string]): number | null {
  const [a, b] = pair.map(Number);
  return a === 0 ? null : (b - a) / a;
}

/** Changes on or after `since` (exclusive of snapshots at or before it) touching any of `keys`. */
export function changesFor(tape: Change[], keys: ReadonlySet<string>, sinceAsOf: string): Change[] {
  return tape.filter((c) => c.date > sinceAsOf && keys.has(c.key));
}
