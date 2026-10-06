import Big from "big.js";
import { describe, expect, it } from "vitest";
import { breakEvenReads, inputTokensAt, sessionCost, type Session } from "./agent.ts";
import { card, fixtureModel } from "./fixtures.ts";

const TODAY = "2026-10-06";
const dec = (s: string) => new Big(s);
// Opus-like: $5 in, $25 out, read $0.50, 5-minute write $6.25 (1.25×), 1-hour write $10 (2×).
const opus = fixtureModel({
  rates: [
    ["Standard", card({ input: dec("5"), output: dec("25"), cacheRead: dec("0.5"), cacheWrite: dec("6.25"), cacheWrite1h: dec("10") })],
  ],
});
const s: Session = {
  turns: 3,
  prefixTokens: 10_000,
  userTokens: 0,
  toolTokens: 1_000,
  outputTokens: 1_000,
  sessionsPerMonth: 100,
  cache: "5m",
};

describe("agent sessions", () => {
  it("grows context by every earlier turn", () => {
    expect([1, 2, 3].map((t) => inputTokensAt(s, t))).toEqual([11_000, 13_000, 15_000]);
  });

  it("prices each turn: write the new tokens, read the rest", () => {
    const r = sessionCost(opus, s, TODAY);
    // Turn 1: write 11,000 at $6.25 + 1,000 out at $25 = 0.06875 + 0.025
    expect(r.turns[0].cost.toFixed(6)).toBe("0.093750");
    // Turn 2: read 11,000 at $0.50 + write 2,000 at $6.25 + out = 0.0055 + 0.0125 + 0.025
    expect(r.turns[1].cost.toFixed(6)).toBe("0.043000");
    // Turn 3: read 13,000 + write 2,000 + out = 0.0065 + 0.0125 + 0.025
    expect(r.turns[2].cost.toFixed(6)).toBe("0.044000");
    expect(r.perSession.toFixed(6)).toBe("0.180750");
    expect(r.monthly.toFixed(4)).toBe("18.0750");
  });

  it("compares against no caching: every input token fresh", () => {
    const r = sessionCost(opus, s, TODAY);
    // (11,000 + 13,000 + 15,000) × $5 + 3,000 × $25 = 0.195 + 0.075
    expect(r.uncachedPerSession.toFixed(6)).toBe("0.270000");
  });

  it("uses the 1-hour write price when asked", () => {
    const r = sessionCost(opus, { ...s, cache: "1h", turns: 1 }, TODAY);
    // 11,000 written at $10 + 1,000 out at $25
    expect(r.perSession.toFixed(6)).toBe("0.135000");
  });

  it("flags the turn that outgrows the context window", () => {
    const small = fixtureModel({ ...opus, contextTokens: 13_500 });
    const r = sessionCost(small, s, TODAY);
    expect(r.contextExceededAt).toBe(2);
    // Only turn 1 fits, so only turn 1 is priced.
    expect(r.turns).toHaveLength(1);
    expect(r.perSession.toFixed(6)).toBe("0.093750");
  });

  it("prices nothing when turn 1 alone doesn't fit", () => {
    const tiny = fixtureModel({ ...opus, contextTokens: 8_000 });
    const r = sessionCost(tiny, s, TODAY);
    expect(r.contextExceededAt).toBe(1);
    expect(r.turns).toHaveLength(0);
    expect(r.readShare).toBe(0);
  });

  it("computes how many reads earn back a write", () => {
    // 5m: (6.25 − 5) / (5 − 0.5) ≈ 0.28 · 1h: (10 − 5) / 4.5 ≈ 1.11
    expect(breakEvenReads(opus, "5m")).toBeCloseTo(0.2778, 3);
    expect(breakEvenReads(opus, "1h")).toBeCloseTo(1.1111, 3);
    const noCache = fixtureModel({ rates: [["Standard", card({ input: dec("1"), output: dec("1") })]] });
    expect(breakEvenReads(noCache, "5m")).toBeNull();
  });
});
