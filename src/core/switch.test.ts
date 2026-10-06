import Big from "big.js";
import { describe, expect, it } from "vitest";
import { card, fixtureModel } from "./fixtures.ts";
import { priceAll } from "./frontier.ts";
import type { Model } from "./model.ts";
import { switchCandidates } from "./switch.ts";

const TODAY = "2026-10-06";
const W = { inputTokens: 1_000_000, outputTokens: 0, requestsPerMonth: 1, cachedPct: 0, cacheWritePct: 0 };
const tools = { tools: true, reasoning: false, structuredOutput: true };

function m(key: string, price: string, intel: number | null, extra: Partial<Model> = {}): Model {
  return fixtureModel({
    key,
    displayName: key,
    capabilities: tools,
    scores: intel === null ? null : { intelligence: intel, coding: null, agentic: null },
    rates: [["Standard", card({ input: new Big(price), output: new Big("0"), cacheRead: new Big("0.1") })]],
    ...extra,
  });
}

describe("switchCandidates", () => {
  const models = [
    m("from", "10", 50, { retiresOn: "2026-10-20", knowledgeCutoff: "2026-01-01", contextTokens: 2_000_000 }),
    m("cheaper-close", "4", 47, { knowledgeCutoff: "2025-06-01", contextTokens: 1_500_000 }),
    m("cheaper-better", "6", 55),
    m("too-weak", "1", 40),
    m("no-tools", "2", 60, { capabilities: { tools: false, reasoning: false, structuredOutput: false } }),
    m("retiring-too", "3", 52, { retiresOn: "2026-10-15" }),
    m("already-retired", "2.5", 53, { retiresOn: "2026-10-01" }),
    m("pricier-better", "20", 58),
  ];
  const pts = priceAll(models, W, "Standard", TODAY);
  const from = pts[0];
  const out = switchCandidates(from, pts, "intelligence", W, TODAY);

  it("keeps capabilities, the score window and the retirement horizon, cheapest first", () => {
    expect(out.map((c) => c.point.model.key)).toEqual(["cheaper-close", "cheaper-better", "pricier-better"]);
  });

  it("reports score deltas, savings and spec breaks", () => {
    const close = out[0];
    expect(close.scoreDelta).toBe(-3);
    expect(Number(close.saving)).toBeCloseTo(6);
    expect(close.savingPct).toBeCloseTo(0.6);
    expect(close.breaks).toEqual(["smaller context", "earlier cutoff"]);
    expect(Number(out[2].saving)).toBeCloseTo(-10);
  });
});
