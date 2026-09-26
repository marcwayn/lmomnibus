import Big from "big.js";
import { describe, expect, it } from "vitest";
import { allModels } from "./catalog.ts";
import { isoDateFromUnixSecs } from "./date.ts";
import { fmtInt, fmtMoney, fmtRate } from "./fmt.ts";
import { primaryMode } from "./model.ts";
import { search } from "./query.ts";

describe("date", () => {
  it("converts known dates in UTC", () => {
    expect(isoDateFromUnixSecs(0)).toBe("1970-01-01");
    // 2026-08-31T23:59:59Z, then one second later
    expect(isoDateFromUnixSecs(1_788_220_799)).toBe("2026-08-31");
    expect(isoDateFromUnixSecs(1_788_220_800)).toBe("2026-09-01");
  });
});

describe("fmt", () => {
  it("formats money with grouping and banker's rounding", () => {
    expect(fmtMoney(new Big("4200"))).toBe("$4,200.00");
    expect(fmtMoney(new Big("1234567.891"))).toBe("$1,234,567.89");
    expect(fmtMoney(new Big("0.125"))).toBe("$0.12");
    expect(fmtMoney(new Big("-12.5"))).toBe("-$12.50");
  });

  it("keeps at least two decimals on rates without rounding fine ones away", () => {
    expect(fmtRate(new Big("0.30"))).toBe("$0.30");
    expect(fmtRate(new Big("0.022"))).toBe("$0.022");
    expect(fmtRate(new Big("3"))).toBe("$3.00");
    expect(fmtRate(new Big("0.0625000000"))).toBe("$0.0625");
    expect(fmtRate(new Big("-1"))).toBe("-$1.00");
  });

  it("groups integers", () => {
    expect(fmtInt(40000)).toBe("40,000");
    expect(fmtInt(999)).toBe("999");
  });
});

describe("catalog", () => {
  it("has only usable rates", () => {
    for (const m of allModels()) {
      expect(m.rates.length, m.key).toBeGreaterThan(0);
      for (const [, card] of m.rates) {
        expect(card.input.gte(0) && card.output.gte(0), m.key).toBe(true);
        expect(card.input.plus(card.output).gt(0), m.key).toBe(true);
      }
    }
  });

  it("resolves a primary mode for batch- or fast-only models", () => {
    const codex = allModels().find((m) => m.key === "openai/gpt-5-codex")!;
    expect(primaryMode(codex)).toBe("Batch");
  });
});

describe("search", () => {
  it("ranks a direct name match first", () => {
    const r = search(allModels(), { text: "opus 5", vendors: [], releasedYear: null, limit: 25 });
    expect(r.hits[0].key).toBe("anthropic/claude-opus-5");
  });

  it("counts vendors without applying the vendor filter to the counts", () => {
    const r = search(allModels(), { text: "", vendors: ["openai"], releasedYear: null, limit: 25 });
    expect(r.hits.every((m) => m.vendorKey === "openai")).toBe(true);
    expect(r.vendorCounts.length).toBeGreaterThan(1);
  });
});
