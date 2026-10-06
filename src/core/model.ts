import Big from "big.js";

/**
 * USD per 1,000,000 tokens. Always `Big`, never a JS `number` — money is
 * exact, not approximated, all the way from the catalog to the number shown
 * on screen.
 */
export type UsdPerMTok = Big;

export type RateMode = "Standard" | "Batch" | "Fast";

export interface ReleaseDate {
  year: number;
  month: number;
}

/** A time-boxed introductory rate that supersedes the list rate while live. */
export interface Promo {
  input: UsdPerMTok;
  output: UsdPerMTok;
  /** ISO date the promo rate stops applying (inclusive), e.g. "2026-08-31". */
  until: string;
}

/**
 * A long-context pricing tier. Vendors price the *whole* request at whichever
 * tier the prompt length clears — not marginally, like a tax bracket.
 */
export interface RateTier {
  aboveInputTokens: number;
  input: UsdPerMTok;
  output: UsdPerMTok;
  cacheRead: UsdPerMTok | null;
}

export interface RateCard {
  input: UsdPerMTok;
  output: UsdPerMTok;
  cacheRead: UsdPerMTok | null;
  cacheWrite: UsdPerMTok | null;
  /** Ascending by `aboveInputTokens`. Empty means a flat rate. */
  tiers: RateTier[];
  promo: Promo | null;
  /** 1-hour-TTL cache write price, where sold (otherwise the default write is ~5 minutes). */
  cacheWrite1h: UsdPerMTok | null;
  /** This price list was checked by hand against the vendor ("list"); otherwise it's OpenRouter's aggregate. */
  checked: boolean;
}

/**
 * Artificial Analysis indices as carried in the OpenRouter feed. Present on
 * roughly a third of the catalog; any one index can be missing on its own.
 */
export interface Scores {
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
}

export interface Capabilities {
  tools: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
}

export interface Model {
  /** "anthropic/claude-opus-5" */
  key: string;
  displayName: string;
  vendorKey: string;
  vendorName: string;
  released: ReleaseDate;
  contextTokens: number;
  maxOutputTokens: number | null;
  /** OpenRouter's modality string, e.g. "text+image->text". */
  modality: string;
  capabilities: Capabilities;
  scores: Scores | null;
  /**
   * Standard is present for almost every model. Batch and Fast are optional
   * *modes of this model* — never separate catalog entries.
   */
  rates: [RateMode, RateCard][];
  provenance: "FirstParty" | "Aggregate";
  /** UTC day the model appeared on OpenRouter (`released` is its year-month). */
  listedOn: string | null;
  /** Vendor's stated training-data cutoff, YYYY-MM-DD. */
  knowledgeCutoff: string | null;
  /** Scheduled retirement, YYYY-MM-DD, when announced. */
  retiresOn: string | null;
  openWeights: boolean;
  /** Always reasons: thinking tokens can't be turned off. */
  reasoningMandatory: boolean;
}

export interface EffectiveRates {
  input: UsdPerMTok;
  output: UsdPerMTok;
  cacheRead: UsdPerMTok | null;
  tier: RateTier | null;
}

/** Whether the promo still applies on `today` (ISO `YYYY-MM-DD`). ISO dates order correctly as strings. */
export function isPromoLive(promo: Promo, today: string): boolean {
  return today <= promo.until;
}

/**
 * The rates that actually apply to a request of this prompt length: the
 * highest tier threshold the prompt clears, or the base rate.
 */
export function effectiveRates(card: RateCard, promptTokens: number): EffectiveRates {
  const tier = card.tiers.findLast((t) => promptTokens > t.aboveInputTokens) ?? null;
  if (tier) {
    return {
      input: tier.input,
      output: tier.output,
      cacheRead: tier.cacheRead ?? card.cacheRead,
      tier,
    };
  }
  return { input: card.input, output: card.output, cacheRead: card.cacheRead, tier: null };
}

export function rateCard(model: Model, mode: RateMode): RateCard | null {
  return model.rates.find(([m]) => m === mode)?.[1] ?? null;
}

/**
 * The mode a model is compared at: Standard when it has one, otherwise its
 * first available mode (a few models are listed with batch- or fast-only
 * pricing).
 */
export function primaryMode(model: Model): RateMode {
  return rateCard(model, "Standard") ? "Standard" : model.rates[0][0];
}

/** The rate card for `primaryMode`. */
export function primaryCard(model: Model): RateCard {
  return rateCard(model, primaryMode(model))!;
}

/** Input modalities, from the part of the modality string before "->". */
export function inputModalities(model: Model): string[] {
  return model.modality.split("->")[0].split("+").filter(Boolean);
}

export function yearMonth(r: ReleaseDate): string {
  return `${String(r.year).padStart(4, "0")}-${String(r.month).padStart(2, "0")}`;
}

export function compareReleased(a: ReleaseDate, b: ReleaseDate): number {
  return a.year - b.year || a.month - b.month;
}
