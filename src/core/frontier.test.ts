import Big from "big.js";
import { describe, expect, it } from "vitest";
import { card, fixtureModel } from "./fixtures.ts";
import {
  alternatives,
  cheapestAbove,
  dominatedBy,
  frontier,
  ladder,
  logTicks,
  passesFilters,
  percentileScore,
  priceAll,
  type Priced,
} from "./frontier.ts";
import type { Model } from "./model.ts";

const TODAY = "2026-10-05";
const W = { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cachedPct: 0, cacheWritePct: 0 };

/** A model whose $ per request equals its input price, scored `intel`. */
function m(key: string, price: string, intel: number | null, extra: Partial<Model> = {}): Model {
  return fixtureModel({
    key,
    displayName: key,
    scores: intel === null ? null : { intelligence: intel, coding: null, agentic: null },
    rates: [["Standard", card({ input: new Big(price), output: new Big("0") })]],
    ...extra,
  });
}

const priced = (models: Model[]): Priced[] => priceAll(models, W, "Standard", TODAY);
const keys = (ps: (Priced | null)[]) => ps.map((p) => p?.model.key ?? null);

describe("frontier", () => {
  const pts = priced([
    m("cheap-weak", "1", 20),
    m("cheap-unscored", "0.5", null),
    m("mid", "3", 40),
    m("mid-worse", "4", 35),
    m("same-price-better", "3", 45),
    m("top", "10", 60),
    m("top-pricier", "12", 60),
  ]);

  it("keeps each model that beats everything cheaper, cheapest first", () => {
    expect(keys(frontier(pts, "intelligence"))).toEqual(["cheap-weak", "same-price-better", "top"]);
  });

  it("never places unscored models on it", () => {
    expect(keys(frontier(pts, "intelligence"))).not.toContain("cheap-unscored");
  });

  it("finds the cheapest model that does at least as well for less", () => {
    const byKey = (k: string) => pts.find((p) => p.model.key === k)!;
    expect(dominatedBy(byKey("mid-worse"), pts, "intelligence")?.model.key).toBe("same-price-better");
    expect(dominatedBy(byKey("mid"), pts, "intelligence")?.model.key).toBe("same-price-better");
    expect(dominatedBy(byKey("top-pricier"), pts, "intelligence")?.model.key).toBe("top");
    expect(dominatedBy(byKey("top"), pts, "intelligence")).toBeNull();
    expect(dominatedBy(byKey("cheap-unscored"), pts, "intelligence")).toBeNull();
  });

  it("answers the cheapest model clearing a bar", () => {
    expect(cheapestAbove(pts, "intelligence", 41)?.model.key).toBe("same-price-better");
    expect(cheapestAbove(pts, "intelligence", 61)).toBeNull();
  });

  it("builds a ladder of cost multiples and score gains", () => {
    const steps = ladder(frontier(pts, "intelligence"), "intelligence");
    expect(steps[0].costMultiple).toBeNull();
    expect(steps[1].costMultiple).toBeCloseTo(3);
    expect(steps[1].scoreGain).toBe(25);
    expect(steps[2].costMultiple).toBeCloseTo(10 / 3);
  });
});

describe("alternatives", () => {
  it("only suggests cheaper models that keep the target's capabilities and fit", () => {
    const tools = { tools: true, reasoning: false, structuredOutput: false };
    const pts = priced([
      m("target", "10", 50, { capabilities: tools }),
      m("cheaper-no-tools", "2", 55),
      m("cheaper-tools", "3", 50, { capabilities: tools }),
      m("cheaper-tools-weaker", "1", 49, { capabilities: tools }),
      m("cheaper-tools-small-ctx", "1.5", 60, { capabilities: tools, contextTokens: 1000 }),
      m("cheapest-tools", "2.5", 52, { capabilities: tools }),
    ]);
    const target = pts.find((p) => p.model.key === "target")!;
    expect(keys(alternatives(target, pts, "intelligence", W))).toEqual(["cheapest-tools", "cheaper-tools"]);
  });

  it("offers nothing for an unscored target", () => {
    const pts = priced([m("target", "10", null), m("other", "1", 90)]);
    expect(alternatives(pts[0], pts, "intelligence", W)).toEqual([]);
  });
});

describe("filters and scales", () => {
  it("filters on modality, capability, fit and score", () => {
    const vision = m("v", "1", 10, { modality: "text+image->text" });
    const plain = m("p", "1", null);
    expect(passesFilters(vision, new Set(["img"]), W, "intelligence")).toBe(true);
    expect(passesFilters(plain, new Set(["img"]), W, "intelligence")).toBe(false);
    expect(passesFilters(plain, new Set(["scored"]), W, "intelligence")).toBe(false);
    expect(passesFilters(m("small", "1", 1, { contextTokens: 10 }), new Set(["fits"]), W, "intelligence")).toBe(false);
  });

  it("takes a nearest-rank percentile of scored models only", () => {
    const models = [10, 20, 30, 40].map((s, i) => m(`s${i}`, "1", s)).concat(m("u", "1", null));
    expect(percentileScore(models, "intelligence", 75)).toBe(30);
    expect(percentileScore(models, "intelligence", 100)).toBe(40);
  });

  it("marks decades as major ticks", () => {
    expect(logTicks(0.3, 60)).toEqual([
      { value: 0.5, major: false },
      { value: 1, major: true },
      { value: 2, major: false },
      { value: 5, major: false },
      { value: 10, major: true },
      { value: 20, major: false },
      { value: 50, major: false },
    ]);
  });
});
