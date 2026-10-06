import Big from "big.js";
import type { Model, RateCard, RateMode } from "./model.ts";

/**
 * Test-only builders. Tests use these rather than live catalog entries, so a
 * catalog refresh (new prices, delisted models) never breaks a test.
 */
export function card(overrides: Partial<RateCard> = {}): RateCard {
  return {
    input: new Big("1"),
    output: new Big("2"),
    cacheRead: null,
    cacheWrite: null,
    tiers: [],
    promo: null,
    ...overrides,
  };
}

export function fixtureModel(overrides: Partial<Model> = {}): Model {
  return {
    key: "test/model",
    displayName: "Test Model",
    vendorKey: "test",
    vendorName: "Test",
    released: { year: 2026, month: 1 },
    contextTokens: 1_000_000,
    maxOutputTokens: null,
    modality: "text->text",
    capabilities: { tools: false, reasoning: false, structuredOutput: false },
    scores: null,
    rates: [["Standard", card()]],
    provenance: "Aggregate",
    ...overrides,
  };
}

/** A model keyed `vendor/slug`, listed in the given year-month. */
export function named(key: string, displayName: string, released: string, rates?: [RateMode, RateCard][]): Model {
  const [vendorKey] = key.split("/");
  const [year, month] = released.split("-").map(Number);
  return fixtureModel({
    key,
    displayName,
    vendorKey,
    vendorName: vendorKey[0].toUpperCase() + vendorKey.slice(1),
    released: { year, month },
    ...(rates ? { rates } : {}),
  });
}
