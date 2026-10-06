import Big from "big.js";
import { describe, expect, it } from "vitest";
import type { CostBreakdown } from "./cost.ts";
import { card, fixtureModel } from "./fixtures.ts";
import type { Priced } from "./frontier.ts";
import type { Model } from "./model.ts";
import {
  catchUpLag,
  coverage,
  defaultTarget,
  gapReading,
  matchTable,
  medianLagDays,
  oneSideZone,
  openMatch,
  parityRow,
  parityThresholds,
  passesLicence,
  runningBest,
  selfHostFrontier,
  sideOf,
} from "./openclosed.ts";
import type { WeightsIndexEntry } from "./weights.ts";

const W = { inputTokens: 2000, outputTokens: 500, requestsPerMonth: 1000, cachedPct: 0, cacheWritePct: 0 };
const TODAY = "2026-10-06";

function m(key: string, intelligence: number | null, open: boolean, listedOn: string, over: Partial<Model> = {}): Model {
  const weights: WeightsIndexEntry | null = open
    ? { status: "open", licence: "permissive", licenceLabel: "Apache-2.0", total: 1e10, active: null, moe: false, gated: false, native: "bf16" }
    : null;
  return fixtureModel({
    key,
    displayName: key,
    scores: intelligence === null ? null : { intelligence, coding: null, agentic: null },
    openWeights: open,
    weightsStatus: open ? "open" : "closed",
    weights,
    listedOn,
    rates: [["Standard", card({ input: new Big(1), output: new Big(1) })]],
    ...over,
  });
}

/** Priced at a fixed $/1K so tests control cost directly. */
const P = (model: Model, cost: number): Priced => ({
  model,
  breakdown: { mode: "Standard", monthlyCost: new Big(cost), per1k: new Big(cost) } as unknown as CostBreakdown,
  per1k: new Big(cost),
  cost,
});

const closedTop = m("c/top", 57.6, false, "2026-09-01");
const closedMid = m("c/mid", 48, false, "2026-06-20");
const closedOld = m("c/old", 40, false, "2025-12-01");
const openTop = m("o/top", 46.3, true, "2026-10-02");
const openMid = m("o/mid", 41.8, true, "2026-08-01");
const unrated = m("o/unrated", null, true, "2026-09-10");
const gone = m("x/unverified", 70, true, "2026-09-10", { weightsStatus: "unverified", openWeights: false });
const models = [closedTop, closedMid, closedOld, openTop, openMid, unrated, gone];
const pts = [P(closedTop, 100), P(closedMid, 22), P(closedOld, 14), P(openTop, 4.11), P(openMid, 3.27), P(unrated, 1), P(gone, 0.5)];

describe("sides", () => {
  it("leaves unverified repos out of both sides", () => {
    expect(sideOf(gone)).toBeNull();
    expect(sideOf(openTop)).toBe("open");
    expect(sideOf(closedTop)).toBe("closed");
  });
});

describe("gap and parity", () => {
  it("reads the gap between each side's best, ignoring unrated and unverified models", () => {
    const g = gapReading(pts, "intelligence");
    expect(g.best.open?.model.key).toBe("o/top");
    expect(g.best.closed?.model.key).toBe("c/top");
    expect(g.gap).toBe(11.3);
    expect(g.openRank).toBe(3);
  });
  it("defaults the bar to the highest multiple of 5 both sides reach", () => {
    expect(defaultTarget(pts, "intelligence")).toBe(45);
  });
  it("prices the cheapest model on each side at the bar and says which is pricier", () => {
    const r = parityRow(pts, "intelligence", 45);
    expect(r.open?.model.key).toBe("o/top");
    expect(r.closed?.model.key).toBe("c/mid");
    expect(r.pricier).toBe("closed");
    expect(r.ratio).toBeCloseTo(22 / 4.11, 6);
  });
  it("flips honestly when the closed answer is cheaper", () => {
    const r = parityRow([P(closedMid, 3), P(openTop, 40)], "intelligence", 45);
    expect(r.pricier).toBe("open");
  });
  it("lists thresholds high to low, with the target slotted in", () => {
    expect(parityThresholds(pts, "intelligence", 47)).toEqual([55, 50, 47, 45, 40]);
  });
  it("finds the scores only one side reaches", () => {
    const z = oneSideZone(pts, "intelligence")!;
    expect(z).toMatchObject({ side: "closed", from: 46.3, count: 2, minCost: 22, maxCost: 100 });
  });
});

describe("listing-date records", () => {
  it("keeps strict improvements only, oldest first", () => {
    const rb = runningBest(models, "intelligence", "closed");
    expect(rb.map((r) => r.model.key)).toEqual(["c/old", "c/mid", "c/top"]);
  });
  it("measures how long closed models held a score before open weights reached it", () => {
    const closed = runningBest(models, "intelligence", "closed");
    const open = runningBest(models, "intelligence", "open");
    const lag = catchUpLag(open.at(-1)!, closed);
    expect(lag.closedFirst?.model.key).toBe("c/mid");
    expect(lag.days).toBe(104);
    // o/mid (41.8, Aug 1) was first matched by c/mid (Jun 20): 42 days; o/top: 104.
    expect(medianLagDays(open.map((o) => catchUpLag(o, closed)), "2025-10-06")).toBe(73);
  });
  it("reads a negative lag when open weights got there first", () => {
    const early = m("o/early", 60, true, "2026-01-01");
    const lag = catchUpLag(runningBest([early], "intelligence", "open")[0], runningBest(models, "intelligence", "closed"));
    expect(lag.closedFirst).toBeNull();
  });
});

describe("open-weight matches", () => {
  it("picks the cheapest open model at least as good, keeping tools and reasoning", () => {
    const r = openMatch(P(closedOld, 14), pts, "intelligence", W, TODAY, 0, "any");
    expect(r.match?.model.key).toBe("o/mid");
    expect(r.costRatio).toBeCloseTo(3.27 / 14, 6);
    expect(r.scoreDelta).toBe(1.8);
  });
  it("offers the nearest when nothing scores high enough", () => {
    const r = openMatch(P(closedTop, 100), pts, "intelligence", W, TODAY, 0, "any");
    expect(r.match).toBeNull();
    expect(r.nearest?.model.key).toBe("o/top");
    expect(r.scoreDelta).toBe(-11.3);
  });
  it("widens with the tolerance and honours the licence filter", () => {
    expect(openMatch(P(closedMid, 22), pts, "intelligence", W, TODAY, 2, "any").match?.model.key).toBe("o/top");
    const nc = { ...openTop, weights: { ...openTop.weights!, licence: "noncommercial" as const } };
    const pts2 = pts.map((p) => (p.model.key === "o/top" ? P(nc, 4.11) : p));
    expect(passesLicence(nc, "no-nc")).toBe(false);
    expect(openMatch(P(closedMid, 22), pts2, "intelligence", W, TODAY, 2, "no-nc").match).toBeNull();
  });
  it("respects the keep rules", () => {
    const tooly = m("c/tools", 40, false, "2026-01-01", { capabilities: { tools: true, reasoning: false, structuredOutput: false } });
    const r = openMatch(P(tooly, 10), pts, "intelligence", W, TODAY, 0, "any");
    expect(r.match).toBeNull();
  });
  it("tables every rated closed model, best first", () => {
    expect(matchTable(pts, "intelligence", W, TODAY, 0, "any").map((r) => r.closed.model.key)).toEqual(["c/top", "c/mid", "c/old"]);
  });
});

describe("coverage and self-hosting", () => {
  it("counts each side's capabilities", () => {
    const c = coverage(models, "open", "intelligence", TODAY);
    expect(c.total).toBe(3);
    expect(c.rated).toBe(2);
    expect(c.recent).toBe(3);
  });
  it("keeps the best score reachable within each memory size", () => {
    const f = selfHostFrontier([
      { gib: 20, score: 40 },
      { gib: 10, score: 30 },
      { gib: 30, score: 35 },
      { gib: 50, score: 46 },
    ]);
    expect(f.map((p) => p.gib)).toEqual([10, 20, 50]);
  });
});
