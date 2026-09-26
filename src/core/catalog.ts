import Big from "big.js";
import rawCatalog from "../../data/catalog.json" with { type: "json" };
import type { Model, RateCard, RateMode } from "./model.ts";

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
  rates: [RateMode, RawRateCard][];
  provenance: "FirstParty" | "Aggregate";
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
    rates: m.rates.map(([mode, card]) => [mode, parseCard(card)]),
    provenance: m.provenance,
  };
}

const CATALOG: readonly Model[] = (rawCatalog as unknown as RawModel[]).map(parseModel);
const BY_KEY = new Map(CATALOG.map((m) => [m.key, m]));

export function allModels(): readonly Model[] {
  return CATALOG;
}

export function modelByKey(key: string): Model | undefined {
  return BY_KEY.get(key);
}
