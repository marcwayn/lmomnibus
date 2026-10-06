import Big from "big.js";
import { describe, expect, it } from "vitest";
import { costFor, priceAt, type Workload } from "./cost.ts";
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
    capabilities: { tools: false, reasoning: false, structuredOutput: false },
    scores: null,
    rates,
    provenance: "Aggregate",
  };
}

function card(overrides: Partial<RateCard>): RateCard {
  return { input: dec("0"), output: dec("0"), cacheRead: null, cacheWrite: null, tiers: [], promo: null, ...overrides };
}

const workload = (
  inputTokens: number,
  outputTokens: number,
  requestsPerMonth: number,
  cachedPct = 0,
  cacheWritePct = 0,
): Workload => ({
  inputTokens,
  outputTokens,
  requestsPerMonth,
  cachedPct,
  cacheWritePct,
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
    expectMoney(b.cacheReadCost, "0.0025");
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

  // Mirrors Claude Opus 5: $5/$25, cache read $0.50, cache write $6.25 (1.25×).
  const opus5 = card({
    input: dec("5.00"),
    output: dec("25.00"),
    cacheRead: dec("0.50"),
    cacheWrite: dec("6.25"),
  });

  it("charges cache writes at the write premium", () => {
    const m = modelWith([["Standard", opus5]]);
    const b = costFor(m, workload(60_000, 1_500, 20_000, 90, 10), "Standard", TODAY)!;
    // Per request: 54,000 read × $0.50 + 6,000 written × $6.25 + 1,500 out × $25 (per MTok)
    expectMoney(b.cacheReadCost.div(20_000), "0.027");
    expectMoney(b.cacheWriteCost.div(20_000), "0.0375");
    expectMoney(b.inputCost, "0");
    expectMoney(b.per1k, "102.00");
    expectMoney(b.perRequest, "0.102");
    expectMoney(b.monthlyCost, "2040.00");
  });

  it("bills writes as input when no write price is published", () => {
    const m = modelWith([["Standard", card({ input: dec("1.00"), output: dec("4.00"), cacheRead: dec("0.10") })]]);
    const b = costFor(m, workload(10_000, 0, 1, 0, 50), "Standard", TODAY)!;
    // 5,000 written at $1.00 + 5,000 fresh at $1.00
    expectMoney(b.cacheWriteCost, "0.005");
    expectMoney(b.monthlyCost, "0.01");
    expect(b.notes).toEqual([]);
  });

  it("never lets a storage-style write price undercut input, and says so", () => {
    // Google-style: cache_write $0.0208 is a per-hour storage fee, not a write premium.
    const m = modelWith([
      ["Standard", card({ input: dec("0.375"), output: dec("1.875"), cacheRead: dec("0.0375"), cacheWrite: dec("0.0208") })],
    ]);
    const b = costFor(m, workload(10_000, 0, 1, 0, 100), "Standard", TODAY)!;
    expectMoney(b.cacheWriteCost, "0.00375");
    expect(b.notes).toContain("storage-fee-not-modelled");
  });

  it("caps read and write shares at 100% of input together", () => {
    const m = modelWith([["Standard", opus5]]);
    const b = costFor(m, workload(10_000, 0, 1, 90, 50), "Standard", TODAY)!;
    // 90% read, write capped to the remaining 10%, nothing fresh.
    expectMoney(b.inputCost, "0");
    expectMoney(b.cacheWriteCost, "0.00625");
  });

  it("notes when the cached share has no cache-read price", () => {
    const m = modelWith([["Standard", card({ input: dec("1.00"), output: dec("1.00") })]]);
    expect(costFor(m, workload(10_000, 0, 1, 50), "Standard", TODAY)!.notes).toEqual(["no-cache-price"]);
    expect(costFor(m, workload(10_000, 0, 1, 0), "Standard", TODAY)!.notes).toEqual([]);
  });

  it("prices Batch when offered and falls back to Standard with a note when not", () => {
    const both = modelWith([
      ["Standard", card({ input: dec("2.00"), output: dec("8.00") })],
      ["Batch", card({ input: dec("1.00"), output: dec("4.00") })],
    ]);
    const standardOnly = modelWith([["Standard", card({ input: dec("2.00"), output: dec("8.00") })]]);
    const w = workload(1_000_000, 0, 1);
    expect(priceAt(both, w, "Batch", TODAY).mode).toBe("Batch");
    expectMoney(priceAt(both, w, "Batch", TODAY).monthlyCost, "1.00");
    const fallback = priceAt(standardOnly, w, "Batch", TODAY);
    expect(fallback.mode).toBe("Standard");
    expect(fallback.notes).toContain("batch-unavailable");
    expect(priceAt(standardOnly, w, "Standard", TODAY).notes).toEqual([]);
  });

  it("scales a cache-write premium to a long-context tier, without calling it a storage fee", () => {
    // Mirrors Claude Sonnet 4.5: $3 in, $3.75 write (1.25×); above 200K, $6 in → writes at $7.50.
    const m = modelWith([
      [
        "Standard",
        card({
          input: dec("3.00"),
          output: dec("15.00"),
          cacheRead: dec("0.30"),
          cacheWrite: dec("3.75"),
          tiers: [{ aboveInputTokens: 200_000, input: dec("6.00"), output: dec("22.50"), cacheRead: dec("0.60") }],
        }),
      ],
    ]);
    const b = costFor(m, workload(250_000, 0, 1, 0, 100), "Standard", TODAY)!;
    expect(b.tierCrossed).toBe(true);
    // 250,000 written × $7.50/MTok
    expectMoney(b.cacheWriteCost, "1.875");
    expect(b.notes).not.toContain("storage-fee-not-modelled");
  });

  it("doesn't divide by a $0 base input when scaling a write price", () => {
    const m = modelWith([["Standard", card({ input: dec("0"), output: dec("1.00"), cacheWrite: dec("0") })]]);
    expect(() => costFor(m, workload(1_000, 100, 1), "Standard", TODAY)).not.toThrow();
    const w = modelWith([["Standard", card({ input: dec("0"), output: dec("1.00"), cacheWrite: dec("0.50") })]]);
    expectMoney(costFor(w, workload(1_000_000, 0, 1, 0, 100), "Standard", TODAY)!.cacheWriteCost, "0.50");
  });
});
