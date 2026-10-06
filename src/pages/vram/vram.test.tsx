import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import configs from "../../core/__fixtures__/configs.json" with { type: "json" };
import { parseConfig, type Cfg } from "../../core/arch.ts";
import { modelByKey } from "../../core/catalog.ts";
import { DEVICE_BY_ID, DEVICES } from "../../core/devices.ts";
import { encodeKey } from "../../core/share.ts";
import { estimate, modelMaxContext, type VramModel, type VramSettings } from "../../core/vram.ts";
import { groupsFromConfig } from "../../core/weights.ts";
import { vramModelFor } from "../../weightsData.ts";
import { VramTool } from "../VramTool.tsx";
import { cheapestFix, moves, smallestSetup } from "./moves.ts";
import {
  ctxParam,
  customModel,
  decodeVram,
  defaultModelKey,
  EMPTY_CUSTOM,
  encodeVram,
  MODELS,
  normalize,
  OPEN_MODELS,
  readPastedConfig,
  resolve,
} from "./state.ts";
import { engineFlags } from "./text.ts";

const decode = (q: string) => decodeVram(new URLSearchParams(q), null);
const roundTrip = (q: string) => {
  const { state } = decode(q);
  return encodeVram(state, resolve(state));
};

// Models come from today's catalog, never by name: the daily refresh can delist any of them.
/** A plain listed model: dense, GQA, published in BF16, at least 64K context, not the default. */
const dense = OPEN_MODELS.find((m) => {
  const vm = vramModelFor(m);
  return (
    vm &&
    m.key !== defaultModelKey() &&
    !vm.moe &&
    !vm.ggufFiles?.length &&
    !vm.groups.vision &&
    vm.kv.family === "gqa" &&
    vm.native.format === "bf16" &&
    modelMaxContext(vm, m.contextTokens) >= 64 * 1024
  );
})!;
const DENSE = encodeKey(dense.key);
const closed = MODELS.find((m) => m.weightsStatus === "closed");
const unverified = MODELS.find((m) => m.weightsStatus === "unverified");
const ggufOnly = OPEN_MODELS.find((m) => vramModelFor(m)?.ggufFiles?.length);

/** Qwen3-32B from its real config.json and Hugging Face parameter total, as src/core/vram.test.ts builds it. */
const qwen32b: VramModel = (() => {
  const a = parseConfig((configs as unknown as Record<string, Cfg>)["qwen3-32b"]);
  const params = 32_762_123_264;
  return {
    name: "Qwen3-32B",
    params,
    groups: groupsFromConfig(params, a.dims, a.moe),
    dims: a.dims,
    moe: a.moe,
    kv: a.kv,
    native: { format: "bf16", bits: 16 },
    checkpointBytes: params * 2,
    maxPositions: a.maxPositions,
  };
})();

const settings = (over: Partial<VramSettings> = {}): VramSettings => ({
  engine: "llamacpp",
  format: "q4_k_m",
  fileBytes: null,
  bpw: null,
  ctx: 32768,
  seqs: 1,
  kv: "f16",
  device: DEVICE_BY_ID.get("rtx-4090")!,
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

describe("the catalog has what these tests need", () => {
  it("lists a plain dense model", () => {
    expect(dense).toBeDefined();
  });
});

describe("the default model", () => {
  it("is a rated open-weight model that fits one RTX 4090 at Q4_K_M, 32K, F16 KV, display on", () => {
    const key = defaultModelKey();
    const m = modelByKey(key)!;
    expect(m.openWeights).toBe(true);
    expect(m.scores?.intelligence).not.toBeNull();
    const r = resolve({ ...decode("").state, disp: true });
    expect(r.model?.key).toBe(key);
    expect(estimate(r.vm!, r.settings!).verdict).toBe("fits");
  });
  it("leaves an empty URL empty", () => {
    expect(roundTrip("")).toBe("");
  });
});

describe("the URL", () => {
  it("round-trips readable state and omits defaults", () => {
    const q = `m=${DENSE}&q=q8_0&ctx=16k&seq=4&kv=q8_0&dev=rtx-3090&n=2&fa=0&disp=0`;
    expect(roundTrip(q)).toBe(q);
  });
  it("writes context as k/m shorthand", () => {
    expect(ctxParam(32768)).toBe("32k");
    expect(ctxParam(1048576)).toBe("1m");
    expect(ctxParam(18700)).toBe("18700");
    expect(decode(`m=${DENSE}&ctx=8k`).state.ctx).toBe(8192);
  });
  it("round-trips a custom model", () => {
    const q = "m=custom&b=32.8&layers=64&hidden=5120&heads=64&kvh=8&hd=128&vocab=151936&attn=swa&win=4096&full=16";
    const out = roundTrip(q);
    for (const part of q.split("&")) expect(out).toContain(part);
  });
  it("shares a self-contained link: the model and device even when they're the defaults", () => {
    const { state } = decode("");
    const shared = encodeVram(state, resolve(state), true);
    expect(shared).toBe(`m=${encodeKey(defaultModelKey())}&dev=rtx-4090`);
    // A recipient's remembered rig doesn't replace the device the link names.
    const opened = decodeVram(new URLSearchParams(shared), { dev: "rtx-3060-12gb", eng: null });
    expect(opened.state.device).toBe("rtx-4090");
    const custom = decode("dev=custom").state;
    expect(encodeVram(custom, resolve(custom), true)).toContain("dev=custom&mem=24");
  });
  it("keeps the fit view's own context and format, whatever the model behind Will it fit? allows", () => {
    const small = OPEN_MODELS.find((m) => {
      const vm = vramModelFor(m);
      return vm && m.key !== defaultModelKey() && !vm.ggufFiles?.length && modelMaxContext(vm, m.contextTokens) < 128 * 1024;
    });
    const q = `view=fit${small ? `&m=${encodeKey(small.key)}` : ""}&q=q8_0&ctx=128k`;
    const { state, notices } = decode(q);
    expect(state.ctx).toBe(128 * 1024);
    expect(state.format).toBe("q8_0");
    expect(notices).toEqual([]);
    expect(roundTrip(q)).toBe(q);
  });
});

describe("corrections", () => {
  it("moves vLLM off a Mac with a notice", () => {
    const { state, notices } = decode("dev=m5-max-128gb&eng=vllm");
    expect(resolve(state).engine).toBe("mlx");
    expect(notices.join(" ")).toMatch(/vLLM doesn't run on Macs/);
  });
  it("drops NVFP4 on a GPU that isn't Blackwell", () => {
    const { state, notices } = decode(`m=${DENSE}&eng=vllm&q=nvfp4&dev=h100-sxm`);
    expect(resolve(state).format).not.toBe("nvfp4");
    expect(notices.join(" ")).toMatch(/Blackwell/);
  });
  it("takes a GPU count that splits the heads under tensor parallelism", () => {
    const { state, notices } = decode(`m=${DENSE}&eng=vllm&dev=h100-sxm&n=8`);
    const heads = resolve(state).vm!.dims.heads;
    expect(heads % state.count).toBe(0);
    if (heads % 8) expect(notices.join(" ")).toMatch(/can't split/);
  });
  it.skipIf(!closed)("sends a closed model back to the default", () => {
    const r = decode(`m=${encodeKey(closed!.key)}`);
    expect(r.state.model).toBe(defaultModelKey());
    expect(r.notices.join(" ")).toMatch(/API-only/);
  });
  it.skipIf(!unverified)("keeps an unverified model and explains it", () => {
    const { state } = decode(`m=${encodeKey(unverified!.key)}`);
    expect(resolve(state).problem).toMatch(/couldn't open|haven't read/);
  });
  it("clamps context to the model's maximum", () => {
    const max = resolve(decode(`m=${DENSE}`).state).maxCtx;
    const { state, notices } = decode(`m=${DENSE}&ctx=${max * 2}`);
    expect(state.ctx).toBe(max);
    expect(notices.join(" ")).toMatch(/stops at/);
  });
  it.skipIf(!ggufOnly)("names a GGUF-only repo's own file, not 'Your file'", () => {
    const { notices } = decode(`m=${encodeKey(ggufOnly!.key)}&q=q8_0`);
    expect(notices.join(" ")).toMatch(/isn't offered/);
    expect(notices.join(" ")).not.toMatch(/Your file/);
  });
  it("leaves a cleared custom GPU size empty", () => {
    const { state } = decode("dev=custom&mem=48");
    expect(normalize({ ...state, mem: null }).state.mem).toBeNull();
    expect(resolve({ ...state, mem: null }).device.usableGiB).toBe(24);
  });
});

describe("custom models", () => {
  it("waits for valid fields", () => {
    expect(customModel({ ...EMPTY_CUSTOM, b: 8 }, null).model).toBeNull();
    const bad = customModel({ ...EMPTY_CUSTOM, b: 8, layers: 32, hidden: 4096, heads: 32, kvh: 6, vocab: 128256 }, null);
    expect(bad.errors.kvh).toMatch(/divide/);
  });
  it("sizes a Llama-3.1-8B-shaped model like the listed one, and flags implausible totals", () => {
    const spec = { ...EMPTY_CUSTOM, b: 8.03, layers: 32, hidden: 4096, heads: 32, kvh: 8, vocab: 128256 };
    const ok = customModel(spec, null);
    expect(ok.model).not.toBeNull();
    expect(ok.warning).toBeNull();
    expect(customModel({ ...spec, b: 80 }, null).warning).toMatch(/Check your numbers/);
  });
  it("reads a pasted config and reports what it found", () => {
    const cfg = JSON.stringify({
      model_type: "qwen3",
      num_hidden_layers: 64,
      hidden_size: 5120,
      num_attention_heads: 64,
      num_key_value_heads: 8,
      head_dim: 128,
      vocab_size: 151936,
      intermediate_size: 25600,
      max_position_embeddings: 40960,
    });
    const r = readPastedConfig(cfg, EMPTY_CUSTOM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.report).toMatch(/Read 64 layers · GQA 64\/8 · head_dim 128 · no sliding window · dense/);
      expect(customModel(r.spec, { parsed: r.parsed, filled: r.spec }).fromPaste).toBe(true);
    }
    expect(readPastedConfig("{nope", EMPTY_CUSTOM).ok).toBe(false);
  });
});

describe("moves and fixes", () => {
  it("lists one-change rows, largest first, and finds a fix for a model that's over", () => {
    const { state } = decode(`m=${DENSE}&ctx=40k`);
    const r = resolve(state);
    const e = estimate(r.vm!, r.settings!);
    const ms = moves(state, r, e);
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < ms.length; i++) expect(Math.abs(ms[i - 1].delta)).toBeGreaterThanOrEqual(Math.abs(ms[i].delta));
    if (e.verdict !== "fits") expect(cheapestFix(state, r, e)).not.toBeNull();
  });
  it("looks past the common devices for the smallest setup that fits", () => {
    // About 1.8 TiB of Q4_K_M weights: more than 8 of any common device holds, not more than every listed one.
    const { state } = decode("m=custom&b=3200&layers=96&hidden=16384&heads=128&kvh=8&vocab=163840");
    const r = resolve(state);
    expect(estimate(r.vm!, r.settings!).weightsAlone).toBe(true);
    const text = smallestSetup(state, r)?.text ?? "";
    expect(text).toMatch(/^8 × /);
    for (const d of DEVICES.filter((x) => x.isDefault)) expect(text).not.toContain(d.short);
  });
  it("prints flags llama-server and vLLM accept", () => {
    expect(engineFlags(settings({ kv: "q8_0", seqs: 2 }), "q4_k_m", qwen32b, "Qwen/Qwen3-32B", null)).toBe(
      "llama-server -m Qwen3-32B-Q4_K_M.gguf -c 65536 -np 2 -ngl 99 -fa on -ctk q8_0 -ctv q8_0",
    );
    const h100 = DEVICE_BY_ID.get("h100-sxm")!;
    expect(engineFlags(settings({ engine: "vllm", format: "native", kv: "fp8", device: h100 }), "native", qwen32b, "Qwen/Qwen3-32B", null)).toBe(
      "vllm serve Qwen/Qwen3-32B --max-model-len 32768 --max-num-seqs 1 --tensor-parallel-size 1 --kv-cache-dtype fp8 --gpu-memory-utilization 0.92",
    );
  });
  it("never prints a context of 0, which llama.cpp reads as the model's own maximum", () => {
    expect(engineFlags(settings({ ctx: 0 }), "q4_k_m", qwen32b, "Qwen/Qwen3-32B", null)).toContain("-c <your context> ");
    const h100 = DEVICE_BY_ID.get("h100-sxm")!;
    expect(engineFlags(settings({ engine: "vllm", format: "native", ctx: 0, device: h100 }), "native", qwen32b, "Qwen/Qwen3-32B", null)).toContain(
      "--max-model-len <your context> ",
    );
  });
});

describe("the page renders", () => {
  const render = (q: string) =>
    renderToString(
      <MemoryRouter initialEntries={[`/tools/vram${q}`]}>
        <VramTool />
      </MemoryRouter>,
    );
  it.each([
    "",
    `?m=${DENSE}`,
    `?m=${DENSE}&eng=vllm&dev=h100-sxm&n=2`,
    `?m=${DENSE}&ctx=0`,
    "?dev=m5-max-128gb",
    ...(unverified ? [`?m=${encodeKey(unverified.key)}`] : []),
    "?m=custom",
    "?m=custom&b=8&layers=32&hidden=4096&heads=32&kvh=8&vocab=128256",
    "?m=custom&b=2000&layers=96&hidden=16384&heads=128&kvh=8&vocab=163840",
    "?view=fit",
    "?view=fit&eng=vllm&dev=h100-sxm&n=8&y=coding",
  ])("%s", (q) => {
    const html = render(q);
    expect(html).toContain("VRAM Estimator");
    expect(html).not.toMatch(/NaN|undefined/);
  });
  it("renders every open-weight model on each engine without throwing", () => {
    for (const rig of ["", "&eng=vllm&dev=h100-sxm&n=8", "&dev=m3-ultra-512gb&ctx=1m&seq=4", "&n=2&kv=q4_0&fa=0&cpu=1&swafull=1"]) {
      for (const m of OPEN_MODELS) {
        const html = render(`?m=${encodeKey(m.key)}${rig}`);
        expect(html, `${m.key}${rig}`).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  }, 120_000);
});
