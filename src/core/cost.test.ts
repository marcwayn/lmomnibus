import Big from "big.js";
import { describe, expect, it } from "vitest";
import { costFor, type Workload } from "./cost.ts";
import type { Model, RateCard, RateMode, RateTier } from "./model.ts";

/** Inside the Sonnet 5 promo window used below. */
const TODAY = "2026-08-15";

const dec = (s: string) => new Big(s);
const expectMoney = (actual: Big, expected: string) => expect(actual.toFixed(10)).toBe(dec(expected).toFixed(10));

function modelWith(rates: [RateMode, RateCard][]): Model {
  return {
    key: "test/model",
    displayName: "Test Model",
    vendorKey: "test",
    vendorName: "Test",
    released: { year: 2026, month: 1 },
    contextTokens: 1_000_000,
    maxOutputTokens: null,
    modality: "text->text",
    rates,
    provenance: "Aggregate",
  };
}

function card(overrides: Partial<RateCard>): RateCard {
  return { input: dec("0"), output: dec("0"), cacheRead: null, cacheWrite: null, tiers: [], promo: null, ...overrides };
}

const workload = (inputTokens: number, outputTokens: number, requestsPerMonth: number, cachedPct = 0): Workload => ({
  inputTokens,
  outputTokens,
  requestsPerMonth,
  cachedPct,
});

// Mirrors GPT-5.6 Sol: $2.50/$15 base, $5.00/$22.50 above 272K prompt tokens.
const solTier: RateTier = { aboveInputTokens: 272_000, input: dec("5.00"), output: dec("22.50"), cacheRead: null };
const solCard = card({ input: dec("2.50"), output: dec("15.00"), tiers: [solTier] });

// Mirrors Claude Sonnet 5: list $3/$15, promo $2/$10 until 2026-08-31.
const promoCard = (tiers: RateTier[] = []) =>
  card({
    input: dec("3.00"),
    output: dec("15.00"),
    tiers,
    promo: { input: dec("2.00"), output: dec("10.00"), until: "2026-08-31" },
  });

describe("costFor", () => {
  it("prices the whole request at the tier, not marginally", () => {
    const m = modelWith([["Standard", solCard]]);
    const b = costFor(m, workload(300_000, 1_800, 40_000), "Standard", TODAY)!;
    expect(b.tierCrossed).toBe(true);
    // 300_000 * 40_000 tokens = 12,000 MTok * $5.00 = $60,000
    expectMoney(b.inputCost, "60000.00");
    // 1_800 * 40_000 tokens = 72 MTok * $22.50 = $1,620
    expectMoney(b.outputCost, "1620.00");
    expectMoney(b.monthlyCost, "61620.00");
  });

  it("uses the base rate below the tier threshold", () => {
    const m = modelWith([["Standard", solCard]]);
    const b = costFor(m, workload(12_000, 1_800, 1), "Standard", TODAY)!;
    expect(b.tierCrossed).toBe(false);
    expect(b.usesPromo).toBe(false);
  });

  it("applies a live promo below any tier and flags it", () => {
    const m = modelWith([["Standard", promoCard()]]);
    const b = costFor(m, workload(12_000, 1_800, 40_000), "Standard", TODAY)!;
    expect(b.usesPromo).toBe(true);
    // 480 MTok * $2.00 = $960; 72 MTok * $10.00 = $720
    expectMoney(b.inputCost, "960.00");
    expectMoney(b.outputCost, "720.00");
    expectMoney(b.monthlyCost, "1680.00");
    // list rates stay on the card for a durable budget, ignoring the promo
    expectMoney(m.rates[0][1].input, "3.00");
  });

  it("falls back to list rates once a promo expires", () => {
    const m = modelWith([["Standard", promoCard()]]);
    const w = workload(12_000, 1_800, 40_000);
    expect(costFor(m, w, "Standard", "2026-08-31")!.usesPromo).toBe(true);

    const after = costFor(m, w, "Standard", "2026-09-01")!;
    expect(after.usesPromo).toBe(false);
    // 480 MTok * $3.00 + 72 MTok * $15.00
    expectMoney(after.monthlyCost, "2520.00");
  });

  it("does not let a promo discount a long-context tier", () => {
    const tier: RateTier = { aboveInputTokens: 200_000, input: dec("6.00"), output: dec("22.50"), cacheRead: null };
    const m = modelWith([["Standard", promoCard([tier])]]);
    const b = costFor(m, workload(250_000, 0, 4), "Standard", TODAY)!;
    expect(b.tierCrossed).toBe(true);
    expect(b.usesPromo).toBe(false);
    expectMoney(b.effectiveInputRate, "6.00");
    // 1 MTok * $6.00
    expectMoney(b.inputCost, "6.00");
  });

  it("prices cache reads only on the cached share", () => {
    const m = modelWith([
      ["Standard", card({ input: dec("5.00"), output: dec("25.00"), cacheRead: dec("0.50"), cacheWrite: dec("6.25") })],
    ]);
    const b = costFor(m, workload(10_000, 0, 1, 50), "Standard", TODAY)!;
    // 5,000 fresh tokens at $5.00/MTok + 5,000 cached tokens at $0.50/MTok
    expectMoney(b.inputCost, "0.025");
    expectMoney(b.cacheCost, "0.0025");
  });

  it("bills the cached share as input when a model has no cache pricing", () => {
    const m = modelWith([["Standard", card({ input: dec("5.00"), output: dec("25.00") })]]);
    const b = costFor(m, workload(10_000, 0, 1, 50), "Standard", TODAY)!;
    // Same as 0% cached: 10,000 tokens at $5.00/MTok, never free.
    expectMoney(b.monthlyCost, "0.05");
  });

  it("stays exact at token volumes past 2^64", () => {
    // (4e9 + 4e9) * 4e9 = 3.2e19 total tokens, beyond both 2^53 and u64.
    const m = modelWith([["Standard", card({ input: dec("1.00"), output: dec("3.00") })]]);
    const b = costFor(m, workload(4e9, 4e9, 4e9), "Standard", TODAY)!;
    expectMoney(b.blendedPerMTok, "2.00");
  });

  it("returns null for a mode the model doesn't offer", () => {
    const m = modelWith([["Standard", solCard]]);
    expect(costFor(m, workload(1, 1, 1), "Batch", TODAY)).toBeNull();
  });
});
