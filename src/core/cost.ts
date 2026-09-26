import Big from "big.js";
import { effectiveRates, isPromoLive, rateCard, type Model, type RateMode } from "./model.ts";

/** A workload shape: what one request looks like, and how many run per month. */
export interface Workload {
  inputTokens: number;
  outputTokens: number;
  requestsPerMonth: number;
  /**
   * 0-100. Share of input tokens served from a cache read instead of a fresh
   * input token, at the (usually cheaper) cache-read rate.
   */
  cachedPct: number;
}

export const DEFAULT_WORKLOAD: Workload = {
  inputTokens: 12_000,
  outputTokens: 1_800,
  requestsPerMonth: 40_000,
  cachedPct: 0,
};

export interface CostBreakdown {
  mode: RateMode;
  usesPromo: boolean;
  tierCrossed: boolean;
  inputCost: Big;
  cacheCost: Big;
  outputCost: Big;
  monthlyCost: Big;
  blendedPerMTok: Big;
  effectiveInputRate: Big;
  effectiveOutputRate: Big;
}

const MTOK = 1_000_000;

/**
 * Full monthly cost breakdown for this workload, at the given rate mode.
 * Long-context tiering prices the *whole* request at whichever tier the
 * prompt length clears (see `effectiveRates`); promotional rates are used
 * when live on `today` (ISO `YYYY-MM-DD`) and the prompt stays below every
 * tier — a promo discounts the base rate, not the tiers. Callers building a
 * durable budget should compare against the card's list rates instead.
 */
export function costFor(
  model: Model,
  workload: Workload,
  mode: RateMode,
  today: string,
): CostBreakdown | null {
  const card = rateCard(model, mode);
  if (!card) return null;
  const eff = effectiveRates(card, workload.inputTokens);

  const promo = card.promo && eff.tier === null && isPromoLive(card.promo, today) ? card.promo : null;
  const inputRate = promo ? promo.input : eff.input;
  const outputRate = promo ? promo.output : eff.output;

  const cachedPct = Math.min(workload.cachedPct, 100);
  const cachedTokens = new Big(workload.inputTokens).times(cachedPct).div(100);
  const freshTokens = new Big(workload.inputTokens).minus(cachedTokens);
  const requests = new Big(workload.requestsPerMonth);

  const inputCost = freshTokens.times(requests).div(MTOK).times(inputRate);
  // A model with no published cache-read rate gets no caching discount: its
  // "cached" share is still billed as ordinary input.
  const cacheRate = eff.cacheRead ?? inputRate;
  const cacheCost = cachedTokens.times(requests).div(MTOK).times(cacheRate);
  const outputCost = new Big(workload.outputTokens).times(requests).div(MTOK).times(outputRate);

  const monthlyCost = inputCost.plus(cacheCost).plus(outputCost);

  const totalTokens = new Big(workload.inputTokens).plus(workload.outputTokens).times(requests);
  const blendedPerMTok = totalTokens.gt(0) ? monthlyCost.div(totalTokens.div(MTOK)) : new Big(0);

  return {
    mode,
    usesPromo: promo !== null,
    tierCrossed: eff.tier !== null,
    inputCost,
    cacheCost,
    outputCost,
    monthlyCost,
    blendedPerMTok,
    effectiveInputRate: inputRate,
    effectiveOutputRate: outputRate,
  };
}
