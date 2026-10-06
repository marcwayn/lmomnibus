import Big from "big.js";
import { describe, expect, it } from "vitest";
import { buildBoard, readings } from "./board.ts";
import { card, fixtureModel } from "./fixtures.ts";
import type { Model } from "./model.ts";
import { presetById } from "./presets.ts";

const TODAY = "2026-10-05";
const m = (key: string, price: string, intel: number | null, ctx = 200_000): Model =>
  fixtureModel({
    key,
    displayName: key,
    contextTokens: ctx,
    scores: intel === null ? null : { intelligence: intel, coding: null, agentic: null },
    rates: [["Standard", card({ input: new Big(price), output: new Big(price) })]],
  });

const MODELS = [
  m("noise", "0.01", 10),
  m("weak", "0.1", 20),
  m("ok", "0.5", 30),
  m("good", "1", 40, 1_000_000),
  m("best", "5", 50),
  m("unscored-cheap", "0.001", null, 2_000_000),
];

describe("home board", () => {
  it("never admits a model below 90% of the top score into the near-top reading", () => {
    const models = [m("top", "9", 57.6), m("just-under", "0.1", 51.8), m("just-over", "1", 51.9)];
    const [nearTop] = readings(models, TODAY);
    expect(nearTop.label).toContain("at least 51.9");
    expect(nearTop.point?.model.key).toBe("just-over");
  });

  it("keeps only frontier models at or above the computed percentile floor", () => {
    const board = buildBoard(MODELS, presetById("chat")!, TODAY);
    expect(board.floor).toBe(40);
    expect(board.scoredCount).toBe(5);
    expect(board.rows.map((p) => p.model.key)).toEqual(["good", "best"]);
    expect(board.fullFrontier.map((p) => p.model.key)).toEqual(["noise", "weak", "ok", "good", "best"]);
  });

  it("computes every reading from the catalog", () => {
    const [nearTop, underDollar, longCtx, openBest] = readings(MODELS, TODAY);
    expect(nearTop.label).toContain("at least 45");
    expect(nearTop.point?.model.key).toBe("best");
    // Chat preset: 2,000 in + 500 out per request → price × 2.5 per 1K requests.
    expect(underDollar.point?.model.key).toBe("weak");
    expect(longCtx.point?.model.key).toBe("unscored-cheap");
    expect(longCtx.detail).toBe("2 models have 1M+");
    // No verified open-weight model in this set.
    expect(openBest.id).toBe("open-best");
    expect(openBest.point).toBeNull();
  });

  it("reads the best open-weight model against the best closed one, leaving unverified repos out", () => {
    const open = (k: string, price: string, intel: number) => ({ ...m(k, price, intel), openWeights: true, weightsStatus: "open" as const });
    const models = [
      m("closed-top", "9", 57.6),
      open("open-best", "2", 46.3),
      open("open-cheap", "0.1", 30),
      { ...m("unverified", "0.5", 50), weightsStatus: "unverified" as const },
    ];
    const openBest = readings(models, TODAY)[3];
    expect(openBest.point?.model.key).toBe("open-best");
    expect(openBest.score).toBe("AA 46.3");
    expect(openBest.detail).toBe("11.3 points behind the top closed model");
    expect(openBest.href).toBe("/tools/open?p=agent");

    const leads = readings([m("closed", "1", 40), open("open", "1", 42.5)], TODAY)[3];
    expect(leads.detail).toBe("2.5 points ahead of the top closed model");
  });
});
