import type Big from "big.js";
import { fits, scoreOf, type Index, type Priced } from "./frontier.ts";
import { inputModalities, rateCard } from "./model.ts";
import type { Workload } from "./cost.ts";

export interface Candidate {
  point: Priced;
  /** Candidate score minus the current model's; null when either is unscored. */
  scoreDelta: number | null;
  /** Monthly saving at this workload (negative = costs more). */
  saving: Big;
  /** Saving as a fraction of the current model's monthly cost. */
  savingPct: number;
  /** What the switch gives up, in plain words. */
  breaks: string[];
}

/** How far below the current model's score a replacement may land and still be listed. */
export const SCORE_TOLERANCE = 5;

/**
 * Replacements for `from`: models that keep what it relies on (tools,
 * reasoning, image input), fit the workload, aren't themselves retiring
 * sooner, and — when `from` is scored — score within SCORE_TOLERANCE of it
 * on `index`. Cheapest first. Each lists its spec breaks against `from`.
 */
export function switchCandidates(
  from: Priced,
  points: readonly Priced[],
  index: Index,
  workload: Workload,
  today: string,
): Candidate[] {
  const f = from.model;
  const fromScore = scoreOf(f, index);
  const needsImage = inputModalities(f).includes("image");
  const total = Number(from.breakdown.monthlyCost);

  return points
    .filter((p) => {
      const m = p.model;
      if (m.key === f.key) return false;
      if (f.capabilities.tools && !m.capabilities.tools) return false;
      if (f.capabilities.reasoning && !m.capabilities.reasoning) return false;
      if (needsImage && !inputModalities(m).includes("image")) return false;
      if (!fits(m, workload)) return false;
      // Never suggest a model that has already retired, or one retiring no later than the one you're leaving.
      if (m.retiresOn && (m.retiresOn < today || !f.retiresOn || m.retiresOn <= f.retiresOn)) return false;
      if (fromScore !== null) {
        const s = scoreOf(m, index);
        if (s === null || s < fromScore - SCORE_TOLERANCE) return false;
      }
      return true;
    })
    .map((p) => {
      const s = scoreOf(p.model, index);
      const saving = from.breakdown.monthlyCost.minus(p.breakdown.monthlyCost);
      return {
        point: p,
        scoreDelta: fromScore !== null && s !== null ? Math.round((s - fromScore) * 10) / 10 : null,
        saving,
        savingPct: total > 0 ? Number(saving) / total : 0,
        breaks: specBreaks(from, p),
      };
    })
    .sort((a, b) => a.point.cost - b.point.cost);
}

/** What moving from one priced model to another gives up, in plain words. */
export function specBreaks(from: Priced, to: Priced): string[] {
  const f = from.model;
  const t = to.model;
  const out: string[] = [];
  if (t.contextTokens < f.contextTokens) out.push("smaller context");
  if (f.maxOutputTokens !== null && t.maxOutputTokens !== null && t.maxOutputTokens < f.maxOutputTokens) {
    out.push("lower output cap");
  }
  if (f.knowledgeCutoff && t.knowledgeCutoff && t.knowledgeCutoff < f.knowledgeCutoff) out.push("earlier cutoff");
  const fCard = rateCard(f, from.breakdown.mode);
  const tCard = rateCard(t, to.breakdown.mode);
  if (fCard?.cacheRead && !tCard?.cacheRead) out.push("no cache pricing");
  if (rateCard(f, "Batch") && !rateCard(t, "Batch")) out.push("no Batch price");
  if (f.capabilities.structuredOutput && !t.capabilities.structuredOutput) out.push("no structured output");
  if (f.openWeights && !t.openWeights) out.push("closed weights");
  if (!f.reasoningMandatory && t.reasoningMandatory) out.push("always reasons (more output)");
  // Moving onto open weights: say when the licence restricts use.
  if (t.openWeights && t.weights) {
    if (t.weights.licence === "noncommercial") out.push("non-commercial licence");
    else if (t.weights.licence === "custom" && f.weights?.licence !== "custom") out.push("custom licence terms");
    else if (t.weights.licence === "unclassified") out.push("licence unclassified");
  }
  return out;
}
