import Big from "big.js";
import rawCatalog from "../../data/catalog.json" with { type: "json" };
import rawMeta from "../../data/catalog-meta.json" with { type: "json" };
import rawWeightsIndex from "../../data/weights-index.json" with { type: "json" };
import type { Model, RateCard, RateMode } from "./model.ts";
import type { WeightsIndexFile } from "./weights.ts";

/**
 * The normalized catalog snapshot, produced by `npm run ingest` and committed
 * to the repo. Bundling it at build time means the running app never makes a
 * network call to have data to show. Re-running ingest and redeploying is how
 * the catalog refreshes.
 *
 * On disk the catalog keeps the snake_case field names and decimal strings
 * the ingest step writes; `parseModel` turns it into the typed domain model.
 */
interface RawRateCard {
  input: string;
  output: string;
  cache_read: string | null;
  cache_write: string | null;
  tiers: { above_input_tokens: number; input: string; output: string; cache_read: string | null }[];
  promo: { input: string; output: string; until: string } | null;
  cache_write_1h?: string | null;
  checked?: boolean;
}

interface RawModel {
  key: string;
  display_name: string;
  vendor_key: string;
  vendor_name: string;
  released: { year: number; month: number };
  context_tokens: number;
  max_output_tokens: number | null;
  modality: string;
  capabilities: { tools: boolean; reasoning: boolean; structured_output: boolean };
  scores: { intelligence: number | null; coding: number | null; agentic: number | null } | null;
  rates: [RateMode, RawRateCard][];
  provenance: "FirstParty" | "Aggregate";
  knowledge_cutoff?: string | null;
  listed_on?: string;
  retires_on?: string | null;
  open_weights?: boolean;
  hf_id?: string | null;
  openness_source?: string;
  reasoning_mandatory?: boolean;
}

const WEIGHTS = (rawWeightsIndex as unknown as WeightsIndexFile).models;

/** Open-weight status: OpenRouter's (or our list's) repo link, confirmed by reading the repo. */
function weightsOf(m: RawModel): Pick<Model, "openWeights" | "weightsStatus" | "hfId" | "opennessSource" | "weights"> {
  const w = WEIGHTS[m.key] ?? null;
  const status: Model["weightsStatus"] = w ? w.status : m.open_weights ? "open" : "closed";
  return { openWeights: status === "open", weightsStatus: status, hfId: m.hf_id ?? null, opennessSource: m.openness_source ?? null, weights: w };
}

const big = (s: string) => new Big(s);
const bigOrNull = (s: string | null) => (s === null ? null : new Big(s));

function parseCard(c: RawRateCard): RateCard {
  return {
    input: big(c.input),
    output: big(c.output),
    cacheRead: bigOrNull(c.cache_read),
    cacheWrite: bigOrNull(c.cache_write),
    tiers: c.tiers.map((t) => ({
      aboveInputTokens: t.above_input_tokens,
      input: big(t.input),
      output: big(t.output),
      cacheRead: bigOrNull(t.cache_read),
    })),
    promo: c.promo && { input: big(c.promo.input), output: big(c.promo.output), until: c.promo.until },
    cacheWrite1h: bigOrNull(c.cache_write_1h ?? null),
    checked: c.checked === true,
  };
}

export function parseModel(m: RawModel): Model {
  return {
    key: m.key,
    displayName: m.display_name,
    vendorKey: m.vendor_key,
    vendorName: m.vendor_name,
    released: m.released,
    contextTokens: m.context_tokens,
    maxOutputTokens: m.max_output_tokens,
    modality: m.modality,
    capabilities: {
      tools: m.capabilities.tools,
      reasoning: m.capabilities.reasoning,
      structuredOutput: m.capabilities.structured_output,
    },
    scores: m.scores,
    rates: m.rates.map(([mode, card]) => [mode, parseCard(card)]),
    provenance: m.provenance,
    listedOn: m.listed_on ?? null,
    knowledgeCutoff: m.knowledge_cutoff ?? null,
    retiresOn: m.retires_on ?? null,
    ...weightsOf(m),
    reasoningMandatory: m.reasoning_mandatory ?? false,
  };
}

const CATALOG: readonly Model[] = (rawCatalog as unknown as RawModel[]).map(parseModel);
const BY_KEY = new Map(CATALOG.map((m) => [m.key, m]));

export interface CatalogMeta {
  /** UTC date the feed was fetched — the honest "prices as of" date. */
  asOf: string;
  source: string;
  models: number;
  /** Distinct vendor display names (Meta appears under two vendor keys). */
  vendors: number;
  scoredIntelligence: number;
  firstParty: number;
  aggregate: number;
}

export const CATALOG_META: CatalogMeta = {
  asOf: rawMeta.as_of,
  source: rawMeta.source,
  models: rawMeta.models,
  vendors: rawMeta.vendors,
  scoredIntelligence: rawMeta.scored_intelligence,
  firstParty: rawMeta.first_party,
  aggregate: rawMeta.aggregate,
};

/** Whole days between the snapshot and `today` (both ISO dates). */
export function snapshotAgeDays(today: string, asOf: string = CATALOG_META.asOf): number {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(asOf)) / 86_400_000));
}

export function allModels(): readonly Model[] {
  return CATALOG;
}

export function modelByKey(key: string): Model | undefined {
  return BY_KEY.get(key);
}
