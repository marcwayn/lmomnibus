import { describe, expect, it } from "vitest";
import { allModels } from "../../core/catalog.ts";
import type { Model } from "../../core/model.ts";
import { formatOptions, weightBytes, type FormatOption, type VramModel } from "../../core/vram.ts";
import { selfHostTable } from "../../core/selfhost.ts";
import { vramModelFor } from "../../weightsData.ts";
import { pageFigure, pickFormat, selfEstimate, selfSettings } from "./SelfHost.tsx";
import { markBox, placeLabels, placeText, textBox, type Box } from "./shared.tsx";

// Models are picked by property, never by key: the daily refresh can delist any model.
const OPEN = allModels().filter((m) => m.openWeights && vramModelFor(m));
const find = (f: (vm: VramModel, m: Model) => boolean) => OPEN.find((m) => f(vramModelFor(m)!, m)) ?? null;
const gptOssLike = find((vm) => vm.native.format === "mxfp4" && vm.dims.hidden % 256 !== 0);
const denseBf16 = find((vm) => vm.native.format === "bf16" && !vm.moe && !vm.ggufFiles);
const moe = find((vm) => Boolean(vm.moe) && !vm.ggufFiles);
const weightsSize = (vm: VramModel, o: FormatOption) => {
  const w = weightBytes(vm, selfSettings(o, 8192));
  return w.gpu.mid + w.host.mid;
};

describe("§D's format", () => {
  it.skipIf(!gptOssLike)("runs MXFP4-published weights as published unless the type asked for is smaller", () => {
    const vm = vramModelFor(gptOssLike!)!;
    const opts = formatOptions(vm, "llamacpp", null);
    const published = opts.find((o) => o.id === "mxfp4")!;
    for (const sq of ["q8_0", "q4_k_m", "iq4_xs", "q3_k_m"] as const) {
      const pick = pickFormat(vm, sq)!;
      const exact = opts.find((o) => o.id === sq);
      if (pick.id === "mxfp4") expect(!exact || weightsSize(vm, published) <= weightsSize(vm, exact)).toBe(true);
      else expect(weightsSize(vm, pick)).toBeLessThan(weightsSize(vm, published));
    }
  });

  it.skipIf(!denseBf16)("keeps the type asked for on BF16 weights", () => {
    expect(pickFormat(vramModelFor(denseBf16!)!, "q4_k_m")?.id).toBe("q4_k_m");
  });
});

describe("§B's Run it yourself", () => {
  const cases = [denseBf16, moe].filter((m): m is Model => m !== null);
  it.skipIf(!cases.length)("names the model page's figure and smallest setup (headless), not §D's display-attached one", () => {
    for (const m of cases) {
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

  it("always places a label marked must, even where every spot covers a mark", () => {
    const taken: Box[] = [];
    for (let x = 0; x <= 400; x += 8) for (let y = 0; y <= 300; y += 8) taken.push(markBox(x, y, 3, `${x},${y}`));
    expect(placeLabels([{ key: "best", x: 200, y: 150, text: "Headline", must: true }], area, 11, taken).size).toBe(1);
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
