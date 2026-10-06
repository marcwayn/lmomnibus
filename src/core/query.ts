import { compareReleased, type Model } from "./model.ts";

export interface Query {
  /** Fuzzy, case-insensitive subsequence match against name, key, and vendor. */
  text: string;
  /** OR within this facet; empty means "any vendor". */
  vendors: string[];
  /** Exact-match filter on the year the model was listed. */
  releasedYear: number | null;
  limit: number;
  /** Extra predicate (capability filters etc.), applied to hits and vendor counts alike. */
  filter?: (m: Model) => boolean;
  /**
   * Primary ordering, applied before the limit; ties fall back to relevance,
   * then newest. Omit to rank by relevance.
   */
  compare?: (a: Model, b: Model) => number;
}

export interface VendorCount {
  vendorKey: string;
  vendorName: string;
  count: number;
}

export interface SearchResult {
  hits: Model[];
  /**
   * Vendor, name, and count — counted against every filter except the vendor
   * filter itself, so counts never read as zero.
   */
  vendorCounts: VendorCount[];
  totalMatching: number;
}

/** Plain code-unit ordering, matching how the old Rust `String` comparison sorted names. */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Distinct release years present in the catalog, descending. */
export function availableYears(catalog: readonly Model[]): number[] {
  return [...new Set(catalog.map((m) => m.released.year))].sort((a, b) => b - a);
}

/**
 * Subsequence fuzzy score: every character of `query` must appear in
 * `target`, in order. Rewards runs of consecutive matches and a match at the
 * very start of the string; penalizes a long target matched sparsely.
 * Returns `null` when `query` is non-empty and not a subsequence.
 */
function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;
  const q = Array.from(query);
  const t = Array.from(target);

  let ti = 0;
  let score = 0;
  let consecutive = 0;
  let firstMatchIdx: number | null = null;

  for (const qc of q) {
    let found = false;
    while (ti < t.length) {
      if (t[ti] === qc) {
        if (firstMatchIdx === null) firstMatchIdx = ti;
        consecutive += 1;
        score += 10 + consecutive * 3;
        ti += 1;
        found = true;
        break;
      }
      consecutive = 0;
      ti += 1;
    }
    if (!found) return null;
  }

  if (firstMatchIdx === 0) score += 25;
  score -= Math.floor(Math.max(t.length - q.length, 0) / 4);
  return score;
}

/** Letters, digits and "." count as word characters, so "4.5" is one word and "5" doesn't start a word inside it. */
const isWordChar = (c: string | undefined) => c !== undefined && /[a-z0-9.]/.test(c);

/** Any scattered-subsequence match scores below this; any contiguous match scores above it. */
const FUZZY_CEILING = 90;

/**
 * How well one query token matches one field. A whole-word match beats a
 * word-prefix match, which beats a plain substring, which beats a scattered
 * subsequence — so "opus" ranks "Claude Opus 5" above a key like
 * "openai/gpt-3.5-turbo-instruct" that merely contains o…p…u…s in order.
 * Tokens of one or two characters must match contiguously.
 */
function tokenScore(token: string, target: string): number | null {
  const idx = target.indexOf(token);
  if (idx !== -1) {
    const end = idx + token.length;
    const startsWord = !isWordChar(target[idx - 1]);
    const wholeWord = startsWord && !isWordChar(target[end]);
    return 100 + (wholeWord ? 30 : startsWord ? 20 : 0) + (idx === 0 ? 10 : 0) - Math.floor(target.length / 8);
  }
  if (token.length <= 2) return null;
  const fuzzy = fuzzyScore(token, target);
  return fuzzy === null ? null : Math.min(fuzzy, FUZZY_CEILING);
}

/**
 * Every whitespace-separated token must match the name, key or vendor (each
 * token may match a different one, so "anthropic opus" works). The score sums
 * each token's best match, plus a bonus when the whole query appears as a
 * phrase in the name.
 */
function scoreModel(m: Model, textLower: string): number | null {
  if (textLower === "") return 0;
  const fields: [string, number][] = [
    [m.displayName.toLowerCase(), 0],
    [m.key.toLowerCase(), -5],
    [m.vendorName.toLowerCase(), -15],
  ];
  let total = 0;
  for (const token of textLower.split(/\s+/)) {
    let best: number | null = null;
    for (const [target, weight] of fields) {
      const s = tokenScore(token, target);
      if (s !== null && (best === null || s + weight > best)) best = s + weight;
    }
    if (best === null) return null;
    total += best;
  }
  if (textLower.includes(" ") && fields[0][0].includes(textLower)) total += 50;
  return total;
}

/**
 * Ranks the catalog against a query. Facet counts are computed against every
 * filter *except* the one they represent, so the vendor chips re-weight live
 * instead of collapsing to zero the moment one is chosen.
 */
export function search(catalog: readonly Model[], q: Query): SearchResult {
  const textLower = q.text.trim().toLowerCase();
  const passes = (m: Model) =>
    (q.releasedYear === null || m.released.year === q.releasedYear) && (!q.filter || q.filter(m));

  const counts = new Map<string, VendorCount>();
  for (const m of catalog) {
    if (!passes(m) || scoreModel(m, textLower) === null) continue;
    const id = `${m.vendorKey}\u0000${m.vendorName}`;
    const entry = counts.get(id) ?? { vendorKey: m.vendorKey, vendorName: m.vendorName, count: 0 };
    entry.count += 1;
    counts.set(id, entry);
  }

  const vendorFilterActive = q.vendors.length > 0;
  const scored: [number, Model][] = [];
  for (const m of catalog) {
    if (!passes(m)) continue;
    if (vendorFilterActive && !q.vendors.includes(m.vendorKey)) continue;
    const s = scoreModel(m, textLower);
    if (s !== null) scored.push([s, m]);
  }

  scored.sort(
    (a, b) =>
      (q.compare ? q.compare(a[1], b[1]) : 0) ||
      b[0] - a[0] ||
      compareReleased(b[1].released, a[1].released) ||
      compareStr(a[1].displayName, b[1].displayName),
  );

  const limit = q.limit === 0 ? 25 : q.limit;
  const vendorCounts = [...counts.values()].sort(
    (a, b) =>
      b.count - a.count || compareStr(a.vendorName, b.vendorName) || compareStr(a.vendorKey, b.vendorKey),
  );

  return {
    hits: scored.slice(0, limit).map(([, m]) => m),
    vendorCounts,
    totalMatching: scored.length,
  };
}
