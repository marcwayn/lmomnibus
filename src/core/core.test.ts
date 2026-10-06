import Big from "big.js";
import { describe, expect, it } from "vitest";
import { allModels } from "./catalog.ts";
import { isoDateFromUnixSecs, todayIso } from "./date.ts";
import { fmtCompact, fmtInt, fmtMoney, fmtRate, fmtUsd } from "./fmt.ts";
import { isPromoLive, primaryMode } from "./model.ts";
import { card, named } from "./fixtures.ts";
import rawOverrides from "../../data/overrides.json" with { type: "json" };
import { search } from "./query.ts";

const overrides = rawOverrides as { key: string; promo?: { input: string; output: string; until: string } }[];
const promoOf = (p: { input: string; output: string; until: string }) => ({
  input: new Big(p.input),
  output: new Big(p.output),
  until: p.until,
});

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
    expect(primaryMode(named("morph/morph-v3", "Morph V3 Fast", "2025-07", [["Fast", card()]]))).toBe("Fast");
    expect(primaryMode(named("x/y", "Y", "2025-07", [["Batch", card()], ["Fast", card()]]))).toBe("Batch");
    expect(primaryMode(named("x/z", "Z", "2025-07", [["Batch", card()], ["Standard", card()]]))).toBe("Standard");
  });

  it("has no expired promos in the curated overrides", () => {
    // An expired promo silently reverts a price to list. Fail instead, so a
    // person re-checks the vendor's pricing and updates data/overrides.json.
    const expired = overrides.filter((o) => o.promo && !isPromoLive(promoOf(o.promo), todayIso()));
    expect(expired.map((o) => o.key)).toEqual([]);
  });
});

describe("search", () => {
  const CATALOG = [
    named("anthropic/claude-opus-5", "Claude Opus 5", "2026-07"),
    named("anthropic/claude-opus-4.5", "Claude Opus 4.5", "2025-11"),
    named("anthropic/claude-sonnet-5", "Claude Sonnet 5", "2026-06"),
    named("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "2025-09"),
    named("openai/gpt-3.5-turbo-instruct", "GPT-3.5 Turbo Instruct", "2023-09"),
    named("openai/gpt-5", "GPT-5", "2025-08"),
    named("google/gemini-3.7-flash", "Gemini 3.7 Flash", "2026-07"),
  ];
  const top = (text: string, n = 3) =>
    search(CATALOG, { text, vendors: [], releasedYear: null, limit: 25 }).hits.slice(0, n).map((m) => m.key);

  it("ranks a direct name match first", () => {
    expect(top("opus 5", 1)).toEqual(["anthropic/claude-opus-5"]);
  });

  it("prefers a contiguous match over letters scattered through a key", () => {
    // "openai/gpt-3.5-turbo-instruct" contains o…p…u…s in order; it must not outrank Opus.
    expect(top("opus", 2)).toEqual(["anthropic/claude-opus-5", "anthropic/claude-opus-4.5"]);
  });

  it("matches each word of the query against any field", () => {
    expect(top("anthropic opus", 2)).toEqual(["anthropic/claude-opus-5", "anthropic/claude-opus-4.5"]);
    expect(top("opus anthropic", 2)).toEqual(["anthropic/claude-opus-5", "anthropic/claude-opus-4.5"]);
    expect(top("google flash", 1)).toEqual(["google/gemini-3.7-flash"]);
  });

  it("treats a version number as a word, so '5' doesn't match inside '4.5'", () => {
    expect(top("sonnet 5", 1)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("still finds through small typos", () => {
    expect(top("sonet", 1)[0]).toContain("sonnet");
  });

  it("requires every word to match", () => {
    expect(top("opus banana")).toEqual([]);
  });

  it("counts vendors without applying the vendor filter to the counts", () => {
    const r = search(CATALOG, { text: "", vendors: ["openai"], releasedYear: null, limit: 25 });
    expect(r.hits.every((m) => m.vendorKey === "openai")).toBe(true);
    expect(r.vendorCounts.map((v) => v.vendorKey).sort()).toEqual(["anthropic", "google", "openai"]);
  });
});

describe("fmtUsd and fmtCompact", () => {
  it("keeps three significant figures below a dollar", () => {
    expect(fmtUsd(new Big("0.000412"))).toBe("$0.000412");
    expect(fmtUsd(new Big("0.035"))).toBe("$0.035");
    expect(fmtUsd(new Big("0.5"))).toBe("$0.50");
    expect(fmtUsd(new Big("102"))).toBe("$102.00");
    expect(fmtUsd(new Big("0"))).toBe("$0.00");
  });

  it("compacts token counts", () => {
    expect(fmtCompact(1_500)).toBe("1.5K");
    expect(fmtCompact(200_000)).toBe("200K");
    expect(fmtCompact(1_048_576)).toBe("1M");
    expect(fmtCompact(512)).toBe("512");
    expect(fmtCompact(999_950)).toBe("1M");
    expect(fmtCompact(4_294_967_295)).toBe("4.3B");
  });
});

describe("search filters and ordering", () => {
  const CATALOG = [
    named("a/cheap", "Cheap", "2025-01"),
    named("a/dear", "Dear", "2026-01"),
    named("b/mid", "Mid", "2025-06"),
  ];
  const price: Record<string, number> = { "a/cheap": 1, "a/dear": 9, "b/mid": 5 };

  it("orders by a comparator before the limit", () => {
    const r = search(CATALOG, {
      text: "",
      vendors: [],
      releasedYear: null,
      limit: 2,
      compare: (x, y) => price[x.key] - price[y.key],
    });
    expect(r.hits.map((m) => m.key)).toEqual(["a/cheap", "b/mid"]);
    expect(r.totalMatching).toBe(3);
  });

  it("applies the extra filter to hits and vendor counts", () => {
    const r = search(CATALOG, { text: "", vendors: [], releasedYear: null, limit: 25, filter: (m) => m.key !== "a/dear" });
    expect(r.hits.map((m) => m.key)).toEqual(["b/mid", "a/cheap"]);
    expect(r.vendorCounts.find((v) => v.vendorKey === "a")?.count).toBe(1);
  });
});
