import { describe, expect, it } from "vitest";
import { appendToTape, changesFor, diffCatalogs, movesText, parseTape, relChange, type RawModel } from "./changes.ts";

const card = (input: string, output: string, promo: RawModel["rates"][0][1]["promo"] = null) => ({ input, output, promo });
const model = (key: string, over: Partial<RawModel> = {}): RawModel => ({
  key,
  display_name: key,
  vendor_name: "V",
  provenance: "Aggregate",
  rates: [["Standard", card("1.00", "2.00")]],
  ...over,
});

describe("diffCatalogs", () => {
  it("records additions, removals (with the last price) and retirements", () => {
    const prev = [model("v/gone", { rates: [["Standard", card("3", "9")]] }), model("v/keep", { retires_on: null })];
    const next = [model("v/keep", { retires_on: "2026-11-01" }), model("v/new")];
    const tape = diffCatalogs(prev, next, "2026-10-01", "2026-10-02");
    expect(tape.map((c) => `${c.kind}:${c.key}`)).toEqual([
      "added:v/new",
      "removed:v/gone",
      "retirement_scheduled:v/keep",
    ]);
    expect(tape.find((c) => c.kind === "removed")?.last).toEqual({ input: "3", output: "9", mode: "Standard", provenance: "Aggregate" });
  });

  it("doesn't call a retirement new when the earlier snapshot didn't track retirements", () => {
    const prev = [{ ...model("v/old"), retires_on: undefined }];
    const next = [model("v/old", { retires_on: "2026-11-01" })];
    expect(diffCatalogs(prev, next, "s", "d")).toEqual([]);
  });

  it("separates vendor list-price changes from aggregate moves, and ignores formatting", () => {
    const prev = [
      model("a/list", { provenance: "FirstParty", rates: [["Standard", card("3.00", "15.00")]] }),
      model("b/agg", { rates: [["Standard", card("0.50", "1.00")]] }),
      model("c/same", { rates: [["Standard", card("2.000000", "8.0")]] }),
    ];
    const next = [
      model("a/list", { provenance: "FirstParty", rates: [["Standard", card("2.00", "10.00")]] }),
      model("b/agg", { rates: [["Standard", card("0.40", "1.00")]] }),
      model("c/same", { rates: [["Standard", card("2.00", "8.00")]] }),
    ];
    const tape = diffCatalogs(prev, next, "s", "d");
    expect(tape.map((c) => `${c.kind}:${c.key}`)).toEqual(["list_price:a/list", "aggregate_move:b/agg"]);
    expect(tape[0].input).toEqual(["3.00", "2.00"]);
  });

  it("tracks modes and promos per mode", () => {
    const prev = [model("v/m", { rates: [["Standard", card("1", "2")], ["Fast", card("2", "4")]] })];
    const next = [
      model("v/m", {
        rates: [
          ["Standard", card("1", "2", { input: "0.5", output: "1", until: "2026-12-31" })],
          ["Batch", card("0.5", "1")],
        ],
      }),
    ];
    const kinds = diffCatalogs(prev, next, "s", "d").map((c) => `${c.kind}:${c.mode}`);
    expect(kinds).toEqual(["promo_start:Standard", "mode_added:Batch", "mode_removed:Fast"]);
  });
});

describe("per-list provenance", () => {
  const checked = (input: string, output: string) => ({ ...card(input, output), checked: true });
  it("calls a move a list-price change only when both sides' price lists were checked", () => {
    const prev = [
      model("a/m", { provenance: "FirstParty", rates: [["Standard", checked("3", "15")], ["Batch", card("1.5", "7.5")]] }),
    ];
    const next = [
      model("a/m", { provenance: "FirstParty", rates: [["Standard", checked("2", "10")], ["Batch", card("1.6", "8")]] }),
    ];
    const kinds = diffCatalogs(prev, next, "s", "d").map((c) => `${c.kind}:${c.mode}`);
    expect(kinds).toEqual(["list_price:Standard", "aggregate_move:Batch"]);
  });

  it("marks a newly checked price replacing an aggregate one as a correction", () => {
    const prev = [model("a/m", { rates: [["Standard", { ...card("3", "15"), checked: false }]] })];
    const next = [model("a/m", { provenance: "FirstParty", rates: [["Standard", { ...card("2", "10"), checked: true }]] })];
    expect(diffCatalogs(prev, next, "s", "d").map((c) => c.kind)).toEqual(["list_correction"]);
  });

  it("records a promo that became the list price as permanent, not as a cut", () => {
    const prev = [
      model("a/m", { provenance: "FirstParty", rates: [["Standard", card("3", "15", { input: "2", output: "10", until: "2026-08-31" })]] }),
    ];
    const next = [model("a/m", { provenance: "FirstParty", rates: [["Standard", card("2.00", "10.00")]] })];
    expect(diffCatalogs(prev, next, "s", "d").map((c) => c.kind)).toEqual(["promo_permanent"]);
  });

  it("records cache-price moves alongside input and output", () => {
    const prev = [model("a/m", { rates: [["Standard", { ...card("1", "2"), cache_read: "0.1", cache_write: null }]] })];
    const next = [model("a/m", { rates: [["Standard", { ...card("1", "2"), cache_read: "0.05", cache_write: null }]] })];
    const [c] = diffCatalogs(prev, next, "s", "d");
    expect(c.kind).toBe("aggregate_move");
    expect(c.cache_read).toEqual(["0.1", "0.05"]);
    expect(c.input).toBeUndefined();
  });

  it("files cache moves on a checked list as aggregate: only input and output are checked", () => {
    const prev = [model("a/m", { provenance: "FirstParty", rates: [["Standard", { ...checked("3", "15"), cache_read: "0.30" }]] })];
    const cacheOnly = [model("a/m", { provenance: "FirstParty", rates: [["Standard", { ...checked("3", "15"), cache_read: "0.25" }]] })];
    expect(diffCatalogs(prev, cacheOnly, "s", "d").map((c) => c.kind)).toEqual(["aggregate_move"]);
    const both = [model("a/m", { provenance: "FirstParty", rates: [["Standard", { ...checked("2", "10"), cache_read: "0.20" }]] })];
    const tape = diffCatalogs(prev, both, "s", "d");
    expect(tape.map((c) => c.kind)).toEqual(["list_price", "aggregate_move"]);
    expect(tape[0].cache_read).toBeUndefined();
    expect(tape[1].cache_read).toEqual(["0.30", "0.20"]);
    expect(tape[1].input).toBeUndefined();
  });

  it("compares the 1-hour write price once the earlier snapshot has it", () => {
    const prev = [model("a/m", { rates: [["Standard", { ...card("1", "2"), cache_write_1h: "2" }]] })];
    const next = [model("a/m", { rates: [["Standard", { ...card("1", "2"), cache_write_1h: "1.6" }]] })];
    expect(diffCatalogs(prev, next, "s", "d")[0].cache_write_1h).toEqual(["2", "1.6"]);
    // A field the earlier snapshot didn't record isn't a move.
    expect(diffCatalogs([model("a/m")], next, "s", "d")).toEqual([]);
  });

  it("still records cache moves when a promo is made permanent", () => {
    const prev = [
      model("a/m", { rates: [["Standard", { ...card("3", "15", { input: "2", output: "10", until: "2026-08-31" }), cache_read: "0.3" }]] }),
    ];
    const next = [model("a/m", { rates: [["Standard", { ...card("2", "10"), cache_read: "0.2" }]] })];
    expect(diffCatalogs(prev, next, "s", "d").map((c) => c.kind)).toEqual(["promo_permanent", "aggregate_move"]);
  });
});

describe("movesText", () => {
  it("describes whichever price fields moved", () => {
    const base = { date: "d", since: "s", key: "a/m", name: "M", vendor: "V", mode: "Standard" };
    expect(movesText({ ...base, kind: "list_price", output: ["10.00", "12.00"] })).toBe("out 10.00 → 12.00");
    expect(movesText({ ...base, kind: "aggregate_move", input: ["1", "0.9"], cache_read: ["", "0.1"] })).toBe(
      "in 1 → 0.9 · cache read none → 0.1",
    );
  });
});

describe("appendToTape", () => {
  it("never drops earlier entries and skips exact repeats", () => {
    const a = { date: "d", since: "s", kind: "added" as const, key: "a/x", name: "X", vendor: "V" };
    const b = { ...a, key: "a/y", name: "Y" };
    expect(appendToTape([a], [a, b])).toEqual([a, b]);
    expect(appendToTape([a, b], [])).toEqual([a, b]);
  });
});

describe("tape helpers", () => {
  it("parses JSON lines and filters by key and date", () => {
    const tape = parseTape(
      ['{"date":"2026-10-02","since":"2026-10-01","kind":"added","key":"a/x","name":"X","vendor":"A"}', "", '{"date":"2026-10-05","since":"2026-10-02","kind":"removed","key":"a/y","name":"Y","vendor":"A"}'].join("\n"),
    );
    expect(tape).toHaveLength(2);
    expect(changesFor(tape, new Set(["a/y"]), "2026-10-02").map((c) => c.key)).toEqual(["a/y"]);
    expect(changesFor(tape, new Set(["a/x"]), "2026-10-02")).toEqual([]);
  });

  it("expresses price moves as a fraction", () => {
    expect(relChange(["5.00", "4.00"])).toBeCloseTo(-0.2);
    expect(relChange(["0", "1"])).toBeNull();
  });
});
