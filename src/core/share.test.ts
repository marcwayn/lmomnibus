import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET, presetById } from "./presets.ts";
import {
  decodeFrontier,
  decodeKey,
  decodeScenario,
  encodeFrontier,
  encodeKey,
  encodeScenario,
  MAX_BENCH,
  type Scenario,
} from "./share.ts";

const agent = presetById("agent")!;
const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  models: [],
  preset: "agent",
  workload: { ...agent.workload },
  rate: agent.rate,
  modes: new Map(),
  index: "intelligence",
  ...over,
});
const roundTrip = (s: Scenario) => decodeScenario(new URLSearchParams(encodeScenario(s)));

describe("share URLs", () => {
  it("writes keys readably and round-trips only the first colon", () => {
    expect(encodeKey("anthropic/claude-opus-5")).toBe("anthropic:claude-opus-5");
    expect(decodeKey(encodeKey("qwen/qwen-plus-2025-07-28:thinking"))).toBe("qwen/qwen-plus-2025-07-28:thinking");
  });

  it("writes only what differs from the preset", () => {
    expect(encodeScenario(scenario({ models: ["anthropic/claude-opus-5", "openai/gpt-6-sol"] }))).toBe(
      "m=anthropic:claude-opus-5,openai:gpt-6-sol&p=agent",
    );
    const custom = scenario({ workload: { ...agent.workload, requestsPerMonth: 50_000 } });
    expect(encodeScenario(custom)).toBe("p=agent&r=50000");
  });

  it("round-trips a full scenario", () => {
    const s = scenario({
      models: ["anthropic/claude-opus-5", "qwen/qwen-plus-2025-07-28:thinking"],
      preset: null,
      workload: { inputTokens: 1234, outputTokens: 56, requestsPerMonth: 7890, cachedPct: 40, cacheWritePct: 5 },
      rate: "Batch",
      modes: new Map([["anthropic/claude-opus-5", "Fast"]]),
      index: "coding",
    });
    const back = roundTrip(s);
    expect(back.models).toEqual(s.models);
    expect(back.preset).toBeNull();
    expect(back.workload).toEqual(s.workload);
    expect(back.rate).toBe("Batch");
    expect([...back.modes]).toEqual([["anthropic/claude-opus-5", "Fast"]]);
    expect(back.index).toBe("coding");
  });

  it("falls back to preset numbers when values are malformed, and clamps percentages", () => {
    const s = decodeScenario(new URLSearchParams("p=chat&i=abc&o=-5&c=150&w=1e3&r=99999999999"));
    const chat = presetById("chat")!;
    expect(s.workload.inputTokens).toBe(chat.workload.inputTokens);
    expect(s.workload.outputTokens).toBe(chat.workload.outputTokens);
    expect(s.workload.cachedPct).toBe(100);
    expect(s.workload.cacheWritePct).toBe(chat.workload.cacheWritePct);
    expect(s.workload.requestsPerMonth).toBe(4_294_967_295);
  });

  it("treats an unknown preset as custom numbers on the default preset", () => {
    const s = decodeScenario(new URLSearchParams("p=nope"));
    expect(s.preset).toBeNull();
    expect(s.workload).toEqual(DEFAULT_PRESET.workload);
  });

  it("drops duplicate models and caps the bench", () => {
    const many = Array.from({ length: MAX_BENCH + 3 }, (_, i) => `v:m${i}`);
    const s = decodeScenario(new URLSearchParams(`m=v:a,v:a,${many.join(",")}`));
    expect(s.models[0]).toBe("v/a");
    expect(new Set(s.models).size).toBe(s.models.length);
    expect(s.models.length).toBe(MAX_BENCH);
  });

  it("round-trips frontier state and ignores unknown filters", () => {
    const encoded = encodeFrontier({
      preset: "agent",
      workload: agent.workload,
      rate: "Standard",
      index: "coding",
      minScore: 45,
      filters: new Set(["tools", "img"]),
    });
    expect(encoded).toBe("p=agent&y=coding&min=45&f=tools,img");
    const back = decodeFrontier(new URLSearchParams(encoded + ",bogus"));
    expect(back.index).toBe("coding");
    expect(back.minScore).toBe(45);
    expect([...back.filters]).toEqual(["tools", "img"]);
  });
});
