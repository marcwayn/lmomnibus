import { describe, expect, it } from "vitest";
import { modelByKey } from "../../core/catalog.ts";
import { selfHostTable } from "../../core/selfhost.ts";
import { vramModelFor } from "../../weightsData.ts";
import { pageFigure, pickFormat, selfEstimate } from "./SelfHost.tsx";
import { markBox, placeLabels, placeText, textBox, type Box } from "./shared.tsx";

const model = (key: string) => {
  const m = modelByKey(key);
  if (!m) throw new Error(`no ${key} in the catalog`);
  return m;
};

describe("§D's format", () => {
  it("runs MXFP4-published weights as published unless a smaller GGUF type is asked for", () => {
    const vm = vramModelFor(model("openai/gpt-oss-20b"))!;
    expect(pickFormat(vm, "q4_k_m")?.id).toBe("mxfp4");
    expect(pickFormat(vm, "iq4_xs")?.id).toBe("mxfp4");
    expect(pickFormat(vm, "q8_0")?.id).toBe("mxfp4");
    expect(pickFormat(vm, "q3_k_m")?.id).toBe("q3_k_m");
  });

  it("keeps the type asked for on BF16 weights", () => {
    const vm = vramModelFor(model("cohere/command-r-08-2024"))!;
    expect(pickFormat(vm, "q4_k_m")?.id).toBe("q4_k_m");
  });
});

describe("§B's Run it yourself", () => {
  it("names the model page's figure and smallest setup (headless), not §D's display-attached one", () => {
    for (const key of ["cohere/command-r-08-2024", "openai/gpt-oss-120b"]) {
      const m = model(key);
      const fig = pageFigure(m, "q4_k_m", 32 * 1024)!;
      const table = selfHostTable(vramModelFor(m)!, m.contextTokens);
      const row = table.rows.find((r) => r.engine === "llamacpp" && r.format === fig.format.id)!;
      const cell = row.cells.find((c) => c.ctx === fig.ctx)!;
      expect(fig.need).toEqual(cell.need);
      expect(fig.setup?.device.id).toBe(cell.setup?.device.id);
      expect(fig.setup?.count).toBe(cell.setup?.count);
      // §D sizes the same model on one RTX 4090 with a display attached: more memory.
      expect(selfEstimate(m, "intelligence", "q4_k_m", 32 * 1024)!.gib * 2 ** 30).toBeGreaterThan(fig.need.mid);
    }
  });
});

describe("chart text placement", () => {
  const area: Box = { x0: 0, y0: 0, x1: 400, y1: 300 };

  it("keeps a label off other points' marks but not off its own", () => {
    const taken = [markBox(100, 100, 5, "a"), markBox(130, 93, 5, "b")];
    const placed = placeLabels([{ key: "a", x: 100, y: 100, text: "Alpha" }], area, 11, taken);
    const lab = placed.get("a")!;
    const box = textBox(lab.x, lab.y, 5, 11, lab.anchor);
    expect(box.x1 < 125 || box.x0 > 135 || box.y1 < 88 || box.y0 > 98).toBe(true);
  });

  it("leaves a label out rather than cover a mark, and joins placed labels to what later text avoids", () => {
    const taken: Box[] = [];
    for (let x = 0; x <= 400; x += 8) for (let y = 0; y <= 300; y += 8) taken.push(markBox(x, y, 3, `${x},${y}`));
    expect(placeLabels([{ key: "z", x: 200, y: 150, text: "Crowded" }], area, 11, taken).size).toBe(0);

    const open: Box[] = [];
    placeLabels([{ key: "q", x: 100, y: 100, text: "Quiet" }], area, 11, open);
    expect(open).toHaveLength(1);
  });

  it("always places an annotation: the first clear spot, else the one covering least", () => {
    const taken: Box[] = [markBox(50, 45, 5, "m")];
    const spot = placeText(
      [
        { x: 50, y: 50, anchor: "middle" },
        { x: 50, y: 80, anchor: "middle" },
      ],
      6,
      10.5,
      area,
      taken,
    );
    expect(spot.y).toBe(80);
    expect(taken).toHaveLength(2);
    const forced = placeText([{ x: 50, y: 80, anchor: "middle" }], 6, 10.5, area, taken);
    expect(forced.y).toBe(80);
  });
});
