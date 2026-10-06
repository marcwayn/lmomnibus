import type Big from "big.js";
import { priceAt, type CostBreakdown, type Rate, type Workload } from "./cost.ts";
import { inputModalities, type Model, type RateMode } from "./model.ts";

/** Which Artificial Analysis index to rank capability by. */
export type Index = "intelligence" | "coding" | "agentic";

export const INDEX_LABEL: Record<Index, string> = {
  intelligence: "Intelligence",
  coding: "Coding",
  agentic: "Agentic",
};

export function scoreOf(model: Model, index: Index): number | null {
  return model.scores?.[index] ?? null;
}

/** A model priced at a workload. `cost` is $ per 1K requests as a JS number, for ranking only. */
export interface Priced {
  model: Model;
  breakdown: CostBreakdown;
  per1k: Big;
  cost: number;
}

export function priceAll(
  models: readonly Model[],
  workload: Workload,
  rate: Rate,
  today: string,
  overrides: ReadonlyMap<string, RateMode> = new Map(),
): Priced[] {
  return models.map((model) => {
    const breakdown = priceAt(model, workload, rate, today, overrides.get(model.key));
    return { model, breakdown, per1k: breakdown.per1k, cost: Number(breakdown.per1k) };
  });
}

/** Capability filters shared by the market table and the Frontier. */
export type Filter = "img" | "aud" | "tools" | "reasoning" | "open" | "fits" | "scored";

export const FILTER_LABEL: Record<Filter, string> = {
  img: "Image in",
  aud: "Audio in",
  tools: "Tools",
  reasoning: "Reasoning",
  open: "Open weights",
  fits: "Fits my request",
  scored: "Scored only",
};

/** Context window fits input + output, and max output (when known) fits output. */
export function fits(model: Model, workload: Workload): boolean {
  return (
    model.contextTokens >= workload.inputTokens + workload.outputTokens &&
    (model.maxOutputTokens === null || model.maxOutputTokens >= workload.outputTokens)
  );
}

export function passesFilters(
  model: Model,
  filters: ReadonlySet<Filter>,
  workload: Workload,
  index: Index,
): boolean {
  const inputs = inputModalities(model);
  for (const f of filters) {
    if (f === "img" && !inputs.includes("image")) return false;
    if (f === "aud" && !inputs.includes("audio")) return false;
    if (f === "tools" && !model.capabilities.tools) return false;
    if (f === "reasoning" && !model.capabilities.reasoning) return false;
    if (f === "open" && !model.openWeights) return false;
    if (f === "fits" && !fits(model, workload)) return false;
    if (f === "scored" && scoreOf(model, index) === null) return false;
  }
  return true;
}

/**
 * The value frontier on one index: walking from cheapest to dearest, each
 * model that scores strictly higher than everything cheaper. Unscored models
 * are never on it (a missing score is not a zero). Returned cheapest first.
 */
export function frontier(points: readonly Priced[], index: Index): Priced[] {
  const scored = points
    .filter((p) => scoreOf(p.model, index) !== null)
    .sort((a, b) => a.cost - b.cost || scoreOf(b.model, index)! - scoreOf(a.model, index)!);
  const out: Priced[] = [];
  let best = -Infinity;
  for (const p of scored) {
    const s = scoreOf(p.model, index)!;
    if (s > best) {
      out.push(p);
      best = s;
    }
  }
  return out;
}

/**
 * The cheapest model that does at least as well for less: score ≥ and cost
 * ≤, with at least one strictly better. Null when nothing dominates `target`
 * (or it is unscored).
 */
export function dominatedBy(target: Priced, points: readonly Priced[], index: Index): Priced | null {
  const s = scoreOf(target.model, index);
  if (s === null) return null;
  let best: Priced | null = null;
  for (const p of points) {
    if (p.model.key === target.model.key) continue;
    const ps = scoreOf(p.model, index);
    if (ps === null || ps < s || p.cost > target.cost) continue;
    if (ps === s && p.cost === target.cost) continue;
    if (!best || p.cost < best.cost || (p.cost === best.cost && ps > scoreOf(best.model, index)!)) best = p;
  }
  return best;
}

/** The cheapest model scoring at least `minScore`. */
export function cheapestAbove(points: readonly Priced[], index: Index, minScore: number): Priced | null {
  let best: Priced | null = null;
  for (const p of points) {
    const s = scoreOf(p.model, index);
    if (s === null || s < minScore) continue;
    if (!best || p.cost < best.cost) best = p;
  }
  return best;
}

export interface LadderStep {
  point: Priced;
  /** Cost multiple over the previous (cheaper) frontier step; null for the first. */
  costMultiple: number | null;
  /** Score gained over the previous step; null for the first. */
  scoreGain: number | null;
}

export function ladder(front: readonly Priced[], index: Index): LadderStep[] {
  return front.map((point, i) => {
    if (i === 0) return { point, costMultiple: null, scoreGain: null };
    const prev = front[i - 1];
    return {
      point,
      costMultiple: prev.cost > 0 ? point.cost / prev.cost : null,
      scoreGain: scoreOf(point.model, index)! - scoreOf(prev.model, index)!,
    };
  });
}

/**
 * Cheaper models that keep what the target relies on: tools, image input and
 * reasoning (when the target has them), a context that fits the workload, and
 * at least the target's score on `index`. Cheapest first, at most `limit`.
 */
export function alternatives(
  target: Priced,
  points: readonly Priced[],
  index: Index,
  workload: Workload,
  limit = 2,
): Priced[] {
  const s = scoreOf(target.model, index);
  if (s === null) return [];
  const t = target.model;
  const needsImage = inputModalities(t).includes("image");
  return points
    .filter((p) => {
      const m = p.model;
      if (m.key === t.key || p.cost >= target.cost) return false;
      const ps = scoreOf(m, index);
      if (ps === null || ps < s) return false;
      if (t.capabilities.tools && !m.capabilities.tools) return false;
      if (t.capabilities.reasoning && !m.capabilities.reasoning) return false;
      if (needsImage && !inputModalities(m).includes("image")) return false;
      return fits(m, workload);
    })
    .sort((a, b) => a.cost - b.cost)
    .slice(0, limit);
}

/** Value at the given percentile (0-100) of the scored models, by nearest rank. */
export function percentileScore(models: readonly Model[], index: Index, pct: number): number | null {
  const scores = models
    .map((m) => scoreOf(m, index))
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b);
  if (scores.length === 0) return null;
  const rank = Math.min(scores.length - 1, Math.max(0, Math.ceil((pct / 100) * scores.length) - 1));
  return scores[rank];
}

/** Log-scale axis ticks: decades as majors, 2× and 5× as minors, spanning [min, max]. */
export function logTicks(min: number, max: number): { value: number; major: boolean }[] {
  if (!(min > 0) || !(max > min)) return [];
  const ticks: { value: number; major: boolean }[] = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= min && v <= max) ticks.push({ value: v, major: m === 1 });
    }
  }
  return ticks;
}
