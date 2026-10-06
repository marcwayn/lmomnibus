import { describe, expect, it } from "vitest";
import configs from "./__fixtures__/configs.json" with { type: "json" };
import { parseConfig, type Cfg } from "./arch.ts";
import { DEVICE_BY_ID, SETUP_LADDER } from "./devices.ts";
import {
  fmtNeed,
  pageSettings,
  selfHostContexts,
  selfHostRows,
  selfHostSummary,
  selfHostTable,
  setupLabel,
  smallestMac,
  smallestSetup,
} from "./selfhost.ts";
import { estimate, GiB, MiB, type VramModel } from "./vram.ts";
import { groupsFromConfig, type NativeFormat } from "./weights.ts";

const C = configs as unknown as Record<string, Cfg>;

/** A model from a real config.json and its Hugging Face parameter total. */
function model(name: string, params: number, native: NativeFormat = "bf16", nativeBits = 16): VramModel {
  const a = parseConfig(C[name]);
  return {
    name,
    params,
    groups: groupsFromConfig(params, a.dims, a.moe),
    dims: a.dims,
    moe: a.moe,
    kv: a.kv,
    native: { format: native, bits: nativeBits },
    checkpointBytes: (params * nativeBits) / 8,
    maxPositions: a.maxPositions,
  };
}

const llama8b = model("llama-3.1-8b", 8_030_261_248);
const qwen32b = model("qwen3-32b", 32_762_123_264);
const oss20 = model("gpt-oss-20b", 20_914_757_184, "mxfp4", 4.6);
const dsv3 = model("deepseek-v3", 684_531_386_000, "fp8", 8.05);

describe("self-host contexts", () => {
  it("stops at the model's maximum and always ends on it", () => {
    expect(selfHostContexts(131_072)).toEqual([8192, 32768, 131072]);
    expect(selfHostContexts(40_960)).toEqual([8192, 32768, 40960]);
    expect(selfHostContexts(1_048_576)).toEqual([8192, 32768, 131072, 1048576]);
    expect(selfHostContexts(4096)).toEqual([4096]);
  });
});

describe("self-host rows", () => {
  it("shows the published weights and FP8 on vLLM, Q8_0 and Q4_K_M on llama.cpp for a BF16 model", () => {
    expect(selfHostRows(qwen32b).map((r) => r.label)).toEqual([
      "As published (BF16) · vLLM",
      "FP8 · vLLM",
      "Q8_0 · llama.cpp",
      "Q4_K_M · llama.cpp",
    ]);
  });

  it("offers no FP8 row for a model published in FP8", () => {
    const labels = selfHostRows(dsv3).map((r) => r.label);
    expect(labels[0]).toBe("As published (FP8) · vLLM");
    expect(labels).not.toContain("FP8 · vLLM");
  });

  it("adds llama.cpp's MXFP4 for an MXFP4 model and never upcasts to Q8_0", () => {
    const labels = selfHostRows(oss20).map((r) => r.label);
    expect(labels).toContain("MXFP4 · llama.cpp");
    expect(labels).not.toContain("Q8_0 · llama.cpp");
  });

  it("lists a GGUF-only repo's own files, smallest first", () => {
    const gguf: VramModel = {
      ...llama8b,
      native: { format: "gguf", bits: 0 },
      checkpointBytes: null,
      ggufFiles: [
        { name: "Model-F16.gguf", bytes: 16e9 },
        { name: "Model-Q4_K_M.gguf", bytes: 4.9e9 },
      ],
    };
    expect(selfHostRows(gguf).map((r) => r.label)).toEqual(["Q4_K_M GGUF (4.90 GB) · llama.cpp", "F16 GGUF (16.00 GB) · llama.cpp"]);
  });
});

describe("smallest setup", () => {
  it("is the first rung of the ladder that fits, and nothing before it does", () => {
    const table = selfHostTable(qwen32b, 131_072);
    for (const row of table.rows) {
      for (const cell of row.cells) {
        const s = pageSettings(row.engine, row.format, cell.ctx);
        const at = cell.setup ? SETUP_LADDER.findIndex(([id, n]) => id === cell.setup!.device.id && n === cell.setup!.count) : SETUP_LADDER.length;
        SETUP_LADDER.forEach(([id, count], i) => {
          const e = estimate(qwen32b, { ...s, device: DEVICE_BY_ID.get(id)!, count });
          const fits = !e.invalid && e.verdict === "fits";
          if (i < at) expect(fits).toBe(false);
          if (i === at) expect(fits).toBe(true);
        });
      }
    }
  });

  it("puts a small model on one consumer card", () => {
    const s = pageSettings("llamacpp", "q4_k_m", 32768);
    expect(setupLabel(smallestSetup(llama8b, s))).toBe("1× RTX 4090");
  });

  it("says when not even the last rung holds it", () => {
    const s = pageSettings("vllm", "native", 32768);
    const huge: VramModel = { ...dsv3, params: dsv3.params * 4, checkpointBytes: dsv3.checkpointBytes! * 4 };
    expect(smallestSetup(huge, s)).toBeNull();
    expect(setupLabel(null)).toBe("> 8× B200");
  });

  it("finds the smallest Mac at the default GPU cap", () => {
    expect(smallestMac(llama8b, pageSettings("llamacpp", "q4_k_m", 32768))?.memoryGb).toBe(32);
    expect(selfHostTable(qwen32b, null).mac).toEqual({ format: "Q4_K_M", ctx: 32768, ramGb: 64 });
  });
});

describe("summaries", () => {
  it("states the headline format and context in plain words", () => {
    expect(selfHostSummary(llama8b, 131_072)).toMatch(/^about \d+(\.\d)? GiB at Q4_K_M with 32K context$/);
    expect(selfHostSummary(oss20, 131_072)).toMatch(/ at MXFP4 with 32K context$/);
  });

  it("rounds big figures to whole GiB", () => {
    expect(fmtNeed(18.07 * GiB)).toBe("18.1 GiB");
    expect(fmtNeed(1458.7 * GiB)).toBe("1,459 GiB");
    expect(fmtNeed(620 * MiB)).toBe("620 MiB");
  });
});
