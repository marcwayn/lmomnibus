/**
 * Open-weight vs closed models, within one Artificial Analysis snapshot:
 * each side's best score, the gap, what each side charges at a capability
 * bar, how long closed models had held a score before an open-weight model
 * reached it (by OpenRouter listing date), and the cheapest open-weight model
 * that matches a given closed one.
 *
 * Scores are only compared within the snapshot (AA rescales between
 * versions). Listing dates trail release dates, often more for open-weight
 * models; callers say so wherever a lag is shown.
 */
import { cheapestAbove, fits, frontier, scoreOf, type Index, type Priced } from "./frontier.ts";
import type { Workload } from "./cost.ts";
import { daysBetween } from "./date.ts";
import { inputModalities, type Model } from "./model.ts";
import { specBreaks } from "./switch.ts";
import type { LicenceClass } from "./weights.ts";

export type Side = "open" | "closed";

/** Open-weight, closed, or null when the linked repo couldn't be opened (left out of both sides). */
export function sideOf(m: Model): Side | null {
  if (m.weightsStatus === "unverified") return null;
  return m.openWeights ? "open" : "closed";
}

export const SIDE_LABEL: Record<Side, string> = { open: "open-weight", closed: "closed" };

/** Which open-weight licences to include. */
export type LicenceFilter = "any" | "permissive" | "no-nc";

export const LICENCE_FILTER_LABEL: Record<LicenceFilter, string> = {
  any: "Any licence",
  permissive: "Permissive only",
  "no-nc": "Exclude non-commercial and unclassified",
};

export function passesLicence(m: Model, f: LicenceFilter): boolean {
  if (f === "any" || sideOf(m) !== "open") return true;
  const cls: LicenceClass = m.weights?.licence ?? "unclassified";
  return f === "permissive" ? cls === "permissive" : cls === "permissive" || cls === "custom";
}

const rated = (points: readonly Priced[], index: Index) => points.filter((p) => scoreOf(p.model, index) !== null && p.cost > 0);

export function split(points: readonly Priced[]): Record<Side, Priced[]> {
  const out: Record<Side, Priced[]> = { open: [], closed: [] };
  for (const p of points) {
    const s = sideOf(p.model);
    if (s) out[s].push(p);
  }
  return out;
}

/** Each side's own value frontier (cheapest first). */
export function frontiers(points: readonly Priced[], index: Index): Record<Side, Priced[]> {
  const s = split(points);
  return { open: frontier(s.open, index), closed: frontier(s.closed, index) };
}

export interface GapReading {
  best: Record<Side, Priced | null>;
  /** Best closed minus best open-weight score; negative when open-weight leads. */
  gap: number | null;
  /** The best open-weight model's rank among every rated model (1 = top). */
  openRank: number | null;
  rated: number;
}

export function gapReading(points: readonly Priced[], index: Index): GapReading {
  const r = rated(points, index).filter((p) => sideOf(p.model));
  const top = (side: Side) =>
    r.filter((p) => sideOf(p.model) === side).reduce<Priced | null>((a, p) => (!a || scoreOf(p.model, index)! > scoreOf(a.model, index)! || (scoreOf(p.model, index) === scoreOf(a.model, index) && p.cost < a.cost) ? p : a), null);
  const best = { open: top("open"), closed: top("closed") };
  const so = best.open && scoreOf(best.open.model, index);
  const sc = best.closed && scoreOf(best.closed.model, index);
  const gap = so != null && sc != null ? Math.round((sc - so) * 10) / 10 : null;
  const openRank = so != null ? r.filter((p) => scoreOf(p.model, index)! > so).length + 1 : null;
  return { best, gap, openRank, rated: r.length };
}

/** The highest multiple of 5 both sides reach, so the parity reading compares like with like. */
export function defaultTarget(points: readonly Priced[], index: Index): number | null {
  const { best } = gapReading(points, index);
  if (!best.open || !best.closed) return null;
  const lower = Math.min(scoreOf(best.open.model, index)!, scoreOf(best.closed.model, index)!);
  return Math.floor(lower / 5) * 5;
}

export interface ParityRow {
  threshold: number;
  open: Priced | null;
  closed: Priced | null;
  /** Which side's cheapest is pricier at this bar (null when one side is empty or they cost the same). */
  pricier: Side | null;
  /** Pricier ÷ cheaper. */
  ratio: number | null;
}

export function parityRow(points: readonly Priced[], index: Index, threshold: number): ParityRow {
  const s = split(rated(points, index));
  const open = cheapestAbove(s.open, index, threshold);
  const closed = cheapestAbove(s.closed, index, threshold);
  if (!open || !closed || open.cost === closed.cost) return { threshold, open, closed, pricier: null, ratio: open && closed ? 1 : null };
  const pricier: Side = open.cost > closed.cost ? "open" : "closed";
  const ratio = pricier === "open" ? open.cost / closed.cost : closed.cost / open.cost;
  return { threshold, open, closed, pricier, ratio };
}

/** Every multiple of `step` where at least one side has a model, plus the target when it falls between. */
export function parityThresholds(points: readonly Priced[], index: Index, target: number | null, step = 5): number[] {
  const scores = rated(points, index).filter((p) => sideOf(p.model)).map((p) => scoreOf(p.model, index)!);
  if (!scores.length) return [];
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(t);
  if (target !== null && target <= max && !out.includes(target)) out.push(target);
  return out.sort((a, b) => b - a);
}

export interface OneSideZone {
  /** The side that has models above the other's best. */
  side: Side;
  /** The trailing side's best score. */
  from: number;
  count: number;
  minCost: number;
  maxCost: number;
}

/** Scores only one side reaches: everything above the trailing side's best. */
export function oneSideZone(points: readonly Priced[], index: Index): OneSideZone | null {
  const { best } = gapReading(points, index);
  if (!best.open || !best.closed) return null;
  const so = scoreOf(best.open.model, index)!;
  const sc = scoreOf(best.closed.model, index)!;
  if (so === sc) return null;
  const side: Side = sc > so ? "closed" : "open";
  const from = Math.min(so, sc);
  const above = split(rated(points, index))[side].filter((p) => scoreOf(p.model, index)! > from);
  return { side, from, count: above.length, minCost: Math.min(...above.map((p) => p.cost)), maxCost: Math.max(...above.map((p) => p.cost)) };
}

// ---------------------------------------------------------------- listing-date records

export interface ScoreRecord {
  model: Model;
  side: Side;
  listedOn: string;
  score: number;
}

/** Each side's running best by OpenRouter listing date: strict improvements only, oldest first. */
export function runningBest(models: readonly Model[], index: Index, side: Side): ScoreRecord[] {
  const pts = models
    .filter((m) => sideOf(m) === side && m.listedOn && scoreOf(m, index) !== null)
    .map((m) => ({ model: m, side, listedOn: m.listedOn!, score: scoreOf(m, index)! }))
    .sort((a, b) => (a.listedOn < b.listedOn ? -1 : a.listedOn > b.listedOn ? 1 : b.score - a.score));
  const out: ScoreRecord[] = [];
  let best = -Infinity;
  for (const p of pts) {
    if (p.score > best) {
      out.push(p);
      best = p.score;
    }
  }
  return out;
}

export interface Lag {
  open: ScoreRecord;
  /** The first closed record at or above the open record's score; null when no closed model has reached it. */
  closedFirst: ScoreRecord | null;
  /** Days from the closed record's listing to the open one's; negative when open-weight got there first. */
  days: number | null;
}

export function catchUpLag(open: ScoreRecord, closed: readonly ScoreRecord[]): Lag {
  const first = closed.find((c) => c.score >= open.score) ?? null;
  return { open, closedFirst: first, days: first ? daysBetween(first.listedOn, open.listedOn) : null };
}

/** Median lag over open-weight records listed on or after `since`. */
export function medianLagDays(lags: readonly Lag[], since: string): number | null {
  const d = lags.filter((l) => l.open.listedOn >= since && l.days !== null).map((l) => l.days!).sort((a, b) => a - b);
  if (!d.length) return null;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 ? d[mid] : Math.round((d[mid - 1] + d[mid]) / 2);
}

// ---------------------------------------------------------------- open-weight matches for closed models

export interface OpenMatch {
  closed: Priced;
  /** Cheapest open-weight model that keeps the closed one's capabilities and scores at least its score minus `tol`. */
  match: Priced | null;
  /** When nothing matches: the highest-scoring open-weight model that keeps its capabilities. */
  nearest: Priced | null;
  /** Match (or nearest) score minus the closed model's. */
  scoreDelta: number | null;
  /** Match cost ÷ closed cost. */
  costRatio: number | null;
  breaks: string[];
}

/** The Switch Planner's keep rules: tools, reasoning and image input kept; fits the workload; not retiring sooner. */
function keeps(from: Model, to: Model, w: Workload, today: string): boolean {
  if (from.capabilities.tools && !to.capabilities.tools) return false;
  if (from.capabilities.reasoning && !to.capabilities.reasoning) return false;
  if (inputModalities(from).includes("image") && !inputModalities(to).includes("image")) return false;
  if (!fits(to, w)) return false;
  if (to.retiresOn && (to.retiresOn < today || !from.retiresOn || to.retiresOn <= from.retiresOn)) return false;
  return true;
}

export function openMatch(closed: Priced, points: readonly Priced[], index: Index, w: Workload, today: string, tol: number, lic: LicenceFilter): OpenMatch {
  const cs = scoreOf(closed.model, index);
  const pool = split(rated(points, index)).open.filter((p) => passesLicence(p.model, lic) && keeps(closed.model, p.model, w, today));
  let match: Priced | null = null;
  if (cs !== null) {
    for (const p of pool) {
      const s = scoreOf(p.model, index)!;
      if (s < cs - tol) continue;
      if (!match || p.cost < match.cost || (p.cost === match.cost && s > scoreOf(match.model, index)!)) match = p;
    }
  }
  const nearest = match
    ? null
    : pool.reduce<Priced | null>((a, p) => (!a || scoreOf(p.model, index)! > scoreOf(a.model, index)! || (scoreOf(p.model, index) === scoreOf(a.model, index) && p.cost < a.cost) ? p : a), null);
  const pick = match ?? nearest;
  const ps = pick ? scoreOf(pick.model, index) : null;
  return {
    closed,
    match,
    nearest,
    scoreDelta: cs !== null && ps !== null ? Math.round((ps - cs) * 10) / 10 : null,
    costRatio: pick && closed.cost > 0 ? pick.cost / closed.cost : null,
    breaks: pick ? specBreaks(closed, pick) : [],
  };
}

/** Every rated closed model's open-weight match, highest score first. */
export function matchTable(points: readonly Priced[], index: Index, w: Workload, today: string, tol: number, lic: LicenceFilter): OpenMatch[] {
  return split(rated(points, index))
    .closed.sort((a, b) => scoreOf(b.model, index)! - scoreOf(a.model, index)! || a.cost - b.cost)
    .map((c) => openMatch(c, points, index, w, today, tol, lic));
}

// ---------------------------------------------------------------- what each side offers

export interface Coverage {
  total: number;
  tools: number;
  reasoning: number;
  image: number;
  cachePrice: number;
  rated: number;
  longContext: number;
  recent: number;
  medianContext: number;
  vendors: number;
}

export function coverage(models: readonly Model[], side: Side, index: Index, today: string, minScore?: number): Coverage {
  let ms = models.filter((m) => sideOf(m) === side);
  if (minScore !== undefined) ms = ms.filter((m) => (scoreOf(m, index) ?? -Infinity) >= minScore);
  const ctx = ms.map((m) => m.contextTokens).sort((a, b) => a - b);
  const count = (f: (m: Model) => boolean) => ms.filter(f).length;
  return {
    total: ms.length,
    tools: count((m) => m.capabilities.tools),
    reasoning: count((m) => m.capabilities.reasoning),
    image: count((m) => inputModalities(m).includes("image")),
    cachePrice: count((m) => m.rates.some(([, c]) => c.cacheRead !== null)),
    rated: count((m) => scoreOf(m, index) !== null),
    longContext: count((m) => m.contextTokens >= 1_000_000),
    recent: count((m) => m.listedOn !== null && daysBetween(m.listedOn, today) <= 90),
    medianContext: ctx.length ? ctx[Math.floor(ctx.length / 2)] : 0,
    vendors: new Set(ms.map((m) => m.vendorName)).size,
  };
}

/** For the self-host chart: the best score reachable within a memory size, ascending by memory. */
export function selfHostFrontier<T extends { gib: number; score: number }>(pts: readonly T[]): T[] {
  const sorted = [...pts].sort((a, b) => a.gib - b.gib || b.score - a.score);
  const out: T[] = [];
  let best = -Infinity;
  for (const p of sorted) {
    if (p.score > best) {
      out.push(p);
      best = p.score;
    }
  }
  return out;
}
