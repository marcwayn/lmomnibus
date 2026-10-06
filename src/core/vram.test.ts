import { describe, expect, it } from "vitest";
import configs from "./__fixtures__/configs.json" with { type: "json" };
import { parseConfig, type Cfg } from "./arch.ts";
import { DEVICE_BY_ID, type Device } from "./devices.ts";
import {
  estimate,
  fmtCtx,
  formatOptions,
  GiB,
  kvBytes,
  maxContext,
  MiB,
  minUnits,
  parseContext,
  weightBytes,
  type VramModel,
  type VramSettings,
} from "./vram.ts";
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

const dev = (id: string): Device => DEVICE_BY_ID.get(id)!;

const base = (over: Partial<VramSettings> = {}): VramSettings => ({
  engine: "llamacpp",
  format: "q4_k_m",
  fileBytes: null,
  bpw: null,
  ctx: 32768,
  seqs: 1,
  kv: "f16",
  device: dev("rtx-4090"),
  count: 1,
  util: 0.92,
  mbt: null,
  ub: 512,
  flashAttn: true,
  swaFull: false,
  expertsOnHost: false,
  vision: false,
  mtp: false,
  lookupOnHost: true,
  display: false,
  macRaised: false,
  ...over,
});

const llama8b = model("llama-3.1-8b", 8_030_261_248);
const qwen32b = model("qwen3-32b", 32_762_123_264);
const qwen30a3 = model("qwen3-30b-a3b", 30_532_122_624);
const gemma27 = model("gemma-3-27b", 27_432_406_640);
const oss20 = model("gpt-oss-20b", 20_914_757_184, "mxfp4", 4.6);
const next80 = model("qwen3-next-80b", 81_324_996_608);
const dsv3 = model("deepseek-v3", 684_531_386_000, "fp8", 8.05);

const mib = (b: number) => b / MiB;

describe("KV cache matches llama.cpp's own logs", () => {
  it("plain GQA: Llama-3.1-8B at 8,448 tokens is 1,056 MiB", () => {
    expect(mib(kvBytes(llama8b, base({ ctx: 8448 })).total)).toBeCloseTo(1056, 6);
  });
  it("MoE GQA: Qwen3-30B-A3B at 20,480 tokens is 1,920 MiB", () => {
    expect(mib(kvBytes(qwen30a3, base({ ctx: 20480 })).total)).toBeCloseTo(1920, 6);
  });
  it("5:1 sliding window: Gemma-3-27B at 4,096 tokens is 944 MiB (window layers hold 1,024 + 512 cells)", () => {
    expect(mib(kvBytes(gemma27, base({ ctx: 4096 })).total)).toBeCloseTo(944, 6);
  });
  it("alternating window 128: gpt-oss-20b at 8,192 tokens is 192 + 18 MiB", () => {
    expect(mib(kvBytes(oss20, base({ ctx: 8192 })).total)).toBeCloseTo(210, 6);
  });
  it("hybrid DeltaNet: Qwen3-Next-80B, 4 × 64K: 6,144 MiB of KV plus 301.5 MiB of F32 state", () => {
    const k = kvBytes(next80, base({ ctx: 65536, seqs: 4 }));
    expect(mib(k.total - k.state)).toBeCloseTo(6144, 6);
    expect(mib(k.state)).toBeCloseTo(301.5, 6);
  });
});

describe("KV per token and what windows save", () => {
  it("Qwen3-32B caches 256 KiB per token; DeepSeek-V3's latent cache 68.6 KiB", () => {
    expect(kvBytes(qwen32b, base({ ctx: 1024 })).perToken).toBe(262_144);
    expect(kvBytes(dsv3, base({ ctx: 1024, engine: "vllm", format: "native" })).perToken).toBe(61 * 576 * 2);
  });
  it("Gemma-3-27B at 128K: 10.61 GiB with windows, 62 GiB without (--swa-full)", () => {
    expect(kvBytes(gemma27, base({ ctx: 131072 })).total / GiB).toBeCloseTo(10.61, 2);
    expect(kvBytes(gemma27, base({ ctx: 131072, swaFull: true })).total / GiB).toBeCloseTo(62, 6);
  });
  it("quantized KV without flash attention keeps V at F16", () => {
    const fa = kvBytes(llama8b, base({ kv: "q8_0" })).total;
    const noFa = kvBytes(llama8b, base({ kv: "q8_0", flashAttn: false })).total;
    expect(noFa / fa).toBeCloseTo((34 / 32 + 2) / 2 / (34 / 32), 6);
  });
});

describe("weights match real GGUF loads", () => {
  it("Llama-3.1-8B Q4_K_M: 4,403 MiB on the GPU, the 282 MiB embedding table in RAM", () => {
    const w = weightBytes(llama8b, base());
    expect(Math.abs(mib(w.gpu.mid) / 4403.49 - 1)).toBeLessThan(0.01);
    expect(Math.abs(mib(w.host.mid) / 281.81 - 1)).toBeLessThan(0.005);
  });
  it("Qwen3-30B-A3B Q4_K_M: 17,596 MiB on the GPU", () => {
    const w = weightBytes(qwen30a3, base());
    expect(Math.abs(mib(w.gpu.mid) / 17596.42 - 1)).toBeLessThan(0.015);
    expect(Math.abs(mib(w.host.mid) / 166.92 - 1)).toBeLessThan(0.01);
  });
  it("gpt-oss-20b MXFP4: 10,949 MiB on the GPU, 587 MiB in RAM", () => {
    const w = weightBytes(oss20, base({ format: "mxfp4" }));
    expect(Math.abs(mib(w.gpu.mid) / 10949.35 - 1)).toBeLessThan(0.015);
    expect(Math.abs(mib(w.host.mid) / 586.82 - 1)).toBeLessThan(0.01);
  });
  it("tied embeddings: the GPU keeps the output copy, the host its own table", () => {
    const w = weightBytes(gemma27, base());
    expect(w.head).toBeGreaterThan(0);
    expect(w.host.mid).toBeGreaterThan(0);
  });
});

describe("vLLM's KV pool", () => {
  it("gpt-oss-120b on 2 × H100 at 131,072 tokens holds 15.49 sequences (vLLM #46933)", () => {
    // gpt-oss-120b: gpt-oss-20b's attention, 36 layers.
    const cfg = { ...C["gpt-oss-20b"], num_hidden_layers: 36, layer_types: Array.from({ length: 36 }, (_, i) => (i % 2 ? "full_attention" : "sliding_attention")) };
    const a = parseConfig(cfg);
    const m: VramModel = { ...oss20, dims: a.dims, kv: a.kv };
    // That log is vLLM 0.23, which kept one batch of in-flight tokens per window layer; current
    // vLLM (async scheduling) keeps two, so 4,096 here reproduces 0.23's 8,192.
    const k = kvBytes(m, base({ engine: "vllm", format: "native", ctx: 131072, device: dev("h100-sxm"), count: 2, mbt: 4096 }));
    expect((37.06 * GiB) / k.perSeq).toBeCloseTo(15.49, 1);
  });
  it("latent (MLA) caches are copied to every tensor-parallel rank; GQA heads are split", () => {
    const one = kvBytes(dsv3, base({ engine: "vllm", format: "native", device: dev("h200-sxm") }));
    const eight = kvBytes(dsv3, base({ engine: "vllm", format: "native", device: dev("h200-sxm"), count: 8 }));
    expect(eight.perRank).toBe(one.perRank);
    const q1 = kvBytes(qwen32b, base({ engine: "vllm", format: "native", device: dev("h100-sxm") }));
    const q2 = kvBytes(qwen32b, base({ engine: "vllm", format: "native", device: dev("h100-sxm"), count: 2 }));
    expect(q2.perRank).toBe(q1.perRank / 2);
  });
  it("tensor parallelism never splits below one KV head per GPU", () => {
    // Qwen3-30B-A3B has 4 KV heads: 8 GPUs each hold one (replicated), not half.
    const k4 = kvBytes(qwen30a3, base({ engine: "vllm", format: "native", device: dev("h100-sxm"), count: 4 }));
    const k8 = kvBytes(qwen30a3, base({ engine: "vllm", format: "native", device: dev("h100-sxm"), count: 8 }));
    expect(k8.perRank).toBe(k4.perRank);
  });
  it("refuses a GPU count that doesn't divide the attention heads", () => {
    const e = estimate(llama8b, base({ engine: "vllm", format: "native", device: dev("h100-sxm"), count: 8 }));
    expect(e.invalid).toBeNull();
    const odd = { ...llama8b, dims: { ...llama8b.dims, heads: 28 } };
    expect(estimate(odd, base({ engine: "vllm", format: "native", device: dev("h100-sxm"), count: 8 })).invalid).toMatch(/28 attention heads/);
  });
});

describe("estimate", () => {
  it("Qwen3-32B Q4_K_M at 32K won't fit one RTX 4090 but fits a 5090", () => {
    const e = estimate(qwen32b, base());
    expect(e.need.mid / GiB).toBeGreaterThan(26);
    expect(e.need.mid / GiB).toBeLessThan(28.5);
    expect(e.verdict).toBe("wont-fit");
    expect(estimate(qwen32b, base({ device: dev("rtx-5090") })).verdict).toMatch(/fits|tight/);
  });
  it("keeps low ≤ mid ≤ high everywhere", () => {
    for (const m of [llama8b, qwen32b, qwen30a3, gemma27, oss20, next80, dsv3]) {
      for (const engine of ["llamacpp", "vllm"] as const) {
        const e = estimate(m, base({ engine, format: engine === "vllm" ? "native" : m === oss20 ? "mxfp4" : "q4_k_m", device: dev("h100-sxm") }));
        for (const r of [e.need, e.host, ...e.lines.flatMap((l) => l.perGpu)]) {
          expect(r.low).toBeLessThanOrEqual(r.mid);
          expect(r.mid).toBeLessThanOrEqual(r.high);
        }
      }
    }
  });
  it("never needs less as context, sequences or bits go up", () => {
    let last = 0;
    for (const ctx of [1024, 4096, 16384, 65536]) {
      const n = estimate(qwen32b, base({ ctx })).need.mid;
      expect(n).toBeGreaterThan(last);
      last = n;
    }
    expect(estimate(qwen32b, base({ seqs: 2 })).need.mid).toBeGreaterThan(estimate(qwen32b, base()).need.mid);
    expect(estimate(qwen32b, base({ format: "q8_0" })).need.mid).toBeGreaterThan(estimate(qwen32b, base({ format: "q6_k" })).need.mid);
    expect(estimate(qwen32b, base({ kv: "q8_0" })).need.mid).toBeLessThan(estimate(qwen32b, base()).need.mid);
  });
  it("MoE experts in system RAM move most of the weights off the GPU", () => {
    const on = estimate(qwen30a3, base());
    const off = estimate(qwen30a3, base({ expertsOnHost: true }));
    expect(off.need.mid).toBeLessThan(on.need.mid / 3);
    expect(off.host.mid).toBeGreaterThan(on.host.mid * 10);
  });
  it("unified memory compares with the macOS GPU cap, raised or not", () => {
    const mac = dev("m4-max-128gb");
    const e = estimate(qwen32b, base({ engine: "mlx", format: "mlx4", device: mac }));
    expect(e.budget / GiB).toBe(96);
    expect(estimate(qwen32b, base({ engine: "mlx", format: "mlx4", device: mac, macRaised: true })).budget / GiB).toBe(120);
    expect(estimate(qwen32b, base({ engine: "vllm", device: mac })).invalid).toMatch(/Macs/);
  });
});

describe("max context and setups", () => {
  it("finds the exact boundary", () => {
    const s = base();
    const { tokens, limitedBy } = maxContext(qwen32b, s, 131072, "mid");
    expect(limitedBy).toBe("memory");
    const fits = estimate(qwen32b, { ...s, ctx: tokens });
    const over = estimate(qwen32b, { ...s, ctx: tokens + 256 });
    expect(fits.need.mid).toBeLessThanOrEqual(fits.budget);
    expect(over.need.mid).toBeGreaterThan(over.budget);
  });
  it("reports the model's limit when memory isn't the constraint", () => {
    expect(maxContext(llama8b, base({ device: dev("h100-sxm") }), 131072, "high").limitedBy).toBe("model");
  });
  it("DeepSeek-V3 at FP8 (641 GiB of weights) needs 8 × H200; 8 × H100 can't hold it", () => {
    expect(minUnits(dsv3, base({ engine: "vllm", format: "native", ctx: 8192 }), dev("h200-sxm"))).toBe(8);
    expect(minUnits(dsv3, base({ engine: "vllm", format: "native", ctx: 8192 }), dev("h100-sxm"))).toBeNull();
  });
});

describe("formats", () => {
  it("never offers an upcast", () => {
    const ids = formatOptions(dsv3, "vllm", dev("h100-sxm")).map((o) => o.id);
    expect(ids).toContain("native");
    expect(ids).not.toContain("bf16");
    expect(formatOptions(oss20, "llamacpp", null).map((o) => o.id)).not.toContain("q8_0");
  });
  it("offers NVFP4 only on Blackwell", () => {
    expect(formatOptions(qwen32b, "vllm", dev("h100-sxm")).find((o) => o.id === "nvfp4")?.disabled).toBeTruthy();
    expect(formatOptions(qwen32b, "vllm", dev("b200")).find((o) => o.id === "nvfp4")?.disabled).toBeUndefined();
  });
});

describe("context text", () => {
  it("parses and prints shorthand", () => {
    expect(parseContext("32k")).toBe(32768);
    expect(parseContext("1M")).toBe(1048576);
    expect(parseContext("32000")).toBe(32000);
    expect(parseContext("lots")).toBeNull();
    expect(fmtCtx(32768)).toBe("32K");
    expect(fmtCtx(1048576)).toBe("1M");
    expect(fmtCtx(19200)).toBe("18.7K");
  });
});
