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
    expect(nearTop.label).toContain("≥ 51.9");
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
    const [nearTop, underDollar, longCtx] = readings(MODELS, TODAY);
    expect(nearTop.label).toContain("≥ 45");
    expect(nearTop.point?.model.key).toBe("best");
    // Chat preset: 2,000 in + 500 out per request → price × 2.5 per 1K requests.
    expect(underDollar.point?.model.key).toBe("weak");
    expect(longCtx.point?.model.key).toBe("unscored-cheap");
    expect(longCtx.detail).toBe("2 models have 1M+");
  });
});
