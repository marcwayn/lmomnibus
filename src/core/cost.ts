import Big from "big.js";
import { effectiveRates, isPromoLive, primaryMode, rateCard, type Model, type RateMode } from "./model.ts";

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
  /**
   * 0-100. Share of input tokens written to the cache on each request, at the
   * (usually dearer) cache-write rate. A simplification: it models "each new
   * token is written once, then read", not cache TTLs or eviction.
   */
  cacheWritePct: number;
}

/** Which price list to compare at. Fast is a per-model choice, not a workload-wide one. */
export type Rate = "Standard" | "Batch";

/**
 * Why a figure is priced the way it is — shown to the reader next to the
 * number, so a simplification is never silent.
 *
 * - `no-cache-price`: cached share billed as fresh input (no cache-read price published)
 * - `storage-fee-not-modelled`: the published write price is below input
 *   (a storage-style fee, e.g. Google's); writes are billed at input instead
 * - `batch-unavailable`: Batch was asked for but the model has no Batch price
 * - `tier-crossed`: the prompt crossed a long-context tier
 */
export type CostNote = "no-cache-price" | "storage-fee-not-modelled" | "batch-unavailable" | "tier-crossed";

export interface CostBreakdown {
  mode: RateMode;
  usesPromo: boolean;
  tierCrossed: boolean;
  /** Fresh (uncached, unwritten) input tokens. */
  inputCost: Big;
  cacheReadCost: Big;
  cacheWriteCost: Big;
  outputCost: Big;
  monthlyCost: Big;
  perRequest: Big;
  /** Cost of 1,000 requests — the unit the site ranks by. */
  per1k: Big;
  blendedPerMTok: Big;
  effectiveInputRate: Big;
  effectiveOutputRate: Big;
  notes: CostNote[];
}

const MTOK = 1_000_000;

/**
 * Full cost breakdown for this workload, at the given rate mode.
 *
 * Long-context tiering prices the *whole* request at whichever tier the
 * prompt length clears (see `effectiveRates`); promotional rates are used
 * when live on `today` (ISO `YYYY-MM-DD`) and the prompt stays below every
 * tier — a promo discounts the base rate, not the tiers.
 *
 * Cache: the read share bills at the cache-read rate (or as input when the
 * model publishes none). The write share bills at max(write price, input):
 * Anthropic/OpenAI-style 1.25× write premiums count in full, while a write
 * price below input (a storage-style fee) never makes writing cheaper than
 * not caching at all. Read + write shares are capped at 100% together.
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
  const notes: CostNote[] = [];
  if (eff.tier) notes.push("tier-crossed");

  const promo = card.promo && eff.tier === null && isPromoLive(card.promo, today) ? card.promo : null;
  const inputRate = promo ? promo.input : eff.input;
  const outputRate = promo ? promo.output : eff.output;

  const readPct = clampPct(workload.cachedPct);
  const writePct = Math.min(clampPct(workload.cacheWritePct), 100 - readPct);
  const input = new Big(workload.inputTokens);
  const readTokens = input.times(readPct).div(100);
  const writeTokens = input.times(writePct).div(100);
  const freshTokens = input.minus(readTokens).minus(writeTokens);

  if (readPct > 0 && eff.cacheRead === null) notes.push("no-cache-price");
  const readRate = eff.cacheRead ?? inputRate;

  // Whether the published write price is a premium (≥ input) is decided on
  // the base card. A premium is a multiple of input, so it scales with the
  // input rate actually in force: a long-context tier (Anthropic bills >200K
  // writes at 1.25× the tier input) or a live promo.
  let writeRate = inputRate;
  if (card.cacheWrite !== null) {
    if (card.cacheWrite.gte(card.input)) {
      const scaled = card.cacheWrite.times(inputRate).div(card.input);
      writeRate = scaled.gt(inputRate) ? scaled : inputRate;
    } else if (writePct > 0) {
      notes.push("storage-fee-not-modelled");
    }
  }

  // Per-request components, then scaled by volume — exact either way.
  const perInput = freshTokens.times(inputRate).div(MTOK);
  const perRead = readTokens.times(readRate).div(MTOK);
  const perWrite = writeTokens.times(writeRate).div(MTOK);
  const perOutput = new Big(workload.outputTokens).times(outputRate).div(MTOK);
  const perRequest = perInput.plus(perRead).plus(perWrite).plus(perOutput);

  const requests = new Big(workload.requestsPerMonth);
  const monthlyCost = perRequest.times(requests);

  const totalTokens = input.plus(workload.outputTokens).times(requests);
  const blendedPerMTok = totalTokens.gt(0) ? monthlyCost.div(totalTokens.div(MTOK)) : new Big(0);

  return {
    mode,
    usesPromo: promo !== null,
    tierCrossed: eff.tier !== null,
    inputCost: perInput.times(requests),
    cacheReadCost: perRead.times(requests),
    cacheWriteCost: perWrite.times(requests),
    outputCost: perOutput.times(requests),
    monthlyCost,
    perRequest,
    per1k: perRequest.times(1000),
    blendedPerMTok,
    effectiveInputRate: inputRate,
    effectiveOutputRate: outputRate,
    notes,
  };
}

/**
 * Price a model at a workload-wide rate choice. Batch falls back to the
 * model's primary mode (noted) when it has no Batch price; `override` pins
 * a specific mode for this one model, e.g. its Fast card.
 */
export function priceAt(
  model: Model,
  workload: Workload,
  rate: Rate,
  today: string,
  override?: RateMode,
): CostBreakdown {
  if (override && rateCard(model, override)) return costFor(model, workload, override, today)!;
  if (rate === "Batch") {
    const batch = costFor(model, workload, "Batch", today);
    if (batch) return batch;
    const fallback = costFor(model, workload, primaryMode(model), today)!;
    return { ...fallback, notes: [...fallback.notes, "batch-unavailable"] };
  }
  return costFor(model, workload, primaryMode(model), today)!;
}

function clampPct(n: number): number {
  return Math.min(Math.max(n, 0), 100);
}

export const NOTE_TEXT: Record<CostNote, string> = {
  "no-cache-price": "No cache-read price published: cached share billed as input",
  "storage-fee-not-modelled": "Published cache-write price is a storage-style fee: writes billed as input, storage not modelled",
  "batch-unavailable": "No batch rate: priced at its regular rate",
  "tier-crossed": "Prompt crosses a long-context tier: whole request priced at the tier",
};
