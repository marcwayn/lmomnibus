import { compareReleased, type Model } from "./model.ts";

export interface Query {
  /** Fuzzy, case-insensitive subsequence match against name, key, and vendor. */
  text: string;
  /** OR within this facet; empty means "any vendor". */
  vendors: string[];
  /** Exact-match release year filter. */
  releasedYear: number | null;
  limit: number;
}

export interface VendorCount {
  vendorKey: string;
  vendorName: string;
  count: number;
}

export interface SearchResult {
  hits: Model[];
  /**
   * Vendor, name, and count — counted against the text + date filters, but
   * not the vendor filter itself, so counts never read as zero.
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

function scoreModel(m: Model, textLower: string): number | null {
  if (textLower === "") return 0;
  const byName = fuzzyScore(textLower, m.displayName.toLowerCase());
  const byKey = fuzzyScore(textLower, m.key.toLowerCase());
  const byVendor = fuzzyScore(textLower, m.vendorName.toLowerCase());
  const scores = [byName, byKey === null ? null : byKey - 5, byVendor === null ? null : byVendor - 15].filter(
    (s): s is number => s !== null,
  );
  return scores.length ? Math.max(...scores) : null;
}

/**
 * Ranks the catalog against a query. Facet counts are computed against every
 * filter *except* the one they represent, so the vendor chips re-weight live
 * instead of collapsing to zero the moment one is chosen.
 */
export function search(catalog: readonly Model[], q: Query): SearchResult {
  const textLower = q.text.trim().toLowerCase();
  const passesDate = (m: Model) => q.releasedYear === null || m.released.year === q.releasedYear;

  const counts = new Map<string, VendorCount>();
  for (const m of catalog) {
    if (!passesDate(m) || scoreModel(m, textLower) === null) continue;
    const id = `${m.vendorKey}\u0000${m.vendorName}`;
    const entry = counts.get(id) ?? { vendorKey: m.vendorKey, vendorName: m.vendorName, count: 0 };
    entry.count += 1;
    counts.set(id, entry);
  }

  const vendorFilterActive = q.vendors.length > 0;
  const scored: [number, Model][] = [];
  for (const m of catalog) {
    if (!passesDate(m)) continue;
    if (vendorFilterActive && !q.vendors.includes(m.vendorKey)) continue;
    const s = scoreModel(m, textLower);
    if (s !== null) scored.push([s, m]);
  }

  scored.sort(
    (a, b) =>
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
