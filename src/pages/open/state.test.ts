import { describe, expect, it } from "vitest";
import { decodeOpen, encodeOpen, roundTarget } from "./state.ts";

const ok = () => null;
const decode = (q: string, checkVs: (k: string) => string | null = ok) => decodeOpen(new URLSearchParams(q), checkVs);

describe("Tool 07 URL", () => {
  it("leaves every default out, including a plain p=agent", () => {
    const { scenario, dropped } = decode("");
    expect(dropped).toEqual([]);
    expect(encodeOpen(scenario)).toBe("");
    expect(encodeOpen(decode("p=agent").scenario)).toBe("");
  });

  it("round-trips the spec's example", () => {
    const q = "p=chat&y=coding&min=45.5&f=tools,img&lic=no-nc&vs=anthropic:claude-sonnet-5.5&tol=2&span=all&all=1&cov=t&sq=q8_0&sctx=128k";
    const { scenario, dropped } = decode(q);
    expect(dropped).toEqual([]);
    expect(scenario.vs).toBe("anthropic/claude-sonnet-5.5");
    expect(scenario.minScore).toBe(45.5);
    expect(encodeOpen(scenario)).toBe(q);
  });

  it("keeps a custom workload relative to its preset", () => {
    expect(encodeOpen(decode("p=agent&r=50000").scenario)).toBe("p=agent&r=50000");
  });

  it("drops unknown keys, filters this page doesn't use, bad values and wrong-side models, and says so", () => {
    const { scenario, dropped } = decode("m=x&f=open,tools&tol=3&sq=q2_k&min=abc&vs=openai:gpt-oss", () => "an open-weight model");
    expect([...scenario.filters]).toEqual(["tools"]);
    expect(scenario.tol).toBe(0);
    expect(scenario.sq).toBe("q4_k_m");
    expect(scenario.minScore).toBeNull();
    expect(scenario.vs).toBeNull();
    expect(dropped).toHaveLength(6);
    expect(dropped.join(" ")).toContain("open-weight model");
  });

  it("moves targets in half points within 0–100", () => {
    expect(roundTarget(45.26)).toBe(45.5);
    expect(roundTarget(45.2)).toBe(45);
    expect(roundTarget(-3)).toBe(0);
    expect(roundTarget(140)).toBe(100);
    expect(decode("min=47.3").scenario.minScore).toBe(47.5);
  });
});
