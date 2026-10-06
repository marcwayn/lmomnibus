/**
 * GPU memory needed to run an open-weight model for inference: weights at a
 * chosen format, the KV cache (and recurrent state) for a context × a number
 * of sequences, and what the engine keeps for itself. Every part is a
 * low/mid/high range in bytes; the totals are sums of the lows, mids and
 * highs.
 *
 * Constants come from the 2026-10-06 VRAM study: GGUF body bits per weight
 * fitted on real files (median error 0.28% on 121 held-out files), engine
 * allocation rules read from llama.cpp, vLLM and mlx-lm source, and overheads
 * fitted on published engine logs. Engine behaviour is dated: defaults moved
 * several times in 2026.
 */
import type { Dims, KvPlan, MoeLayout } from "./arch.ts";
import type { Device } from "./devices.ts";
import type { NativeFormat, TensorGroups, WeightsRecord } from "./weights.ts";

export const GiB = 2 ** 30;
export const MiB = 2 ** 20;

export const ENGINE_CHECKED = "2026-10-06";

export interface Range {
  low: number;
  mid: number;
  high: number;
}

const R = (low: number, mid: number, high: number): Range => ({ low, mid, high });
const fixed = (x: number): Range => R(x, x, x);
const ZERO = fixed(0);
const add = (...rs: Range[]): Range => rs.reduce((a, b) => R(a.low + b.low, a.mid + b.mid, a.high + b.high), ZERO);
const scale = (r: Range, k: number): Range => R(r.low * k, r.mid * k, r.high * k);
const spread = (mid: number, lowF: number, highF: number): Range => R(mid * lowF, mid, mid * highF);

const pad = (x: number, m: number) => Math.ceil(x / m) * m;

// ---------------------------------------------------------------- engines, formats, KV dtypes

export type Engine = "llamacpp" | "vllm" | "mlx";

export const ENGINE_LABEL: Record<Engine, string> = {
  llamacpp: "llama.cpp (Ollama, LM Studio)",
  vllm: "vLLM / SGLang",
  mlx: "MLX (Apple)",
};

export type GgufType = "q8_0" | "q6_k" | "q5_k_m" | "q4_k_m" | "iq4_xs" | "q3_k_m" | "q2_k" | "iq2_xxs";
export type FormatId = "native" | "bf16" | "fp8" | "int8" | "int4" | "nvfp4" | "mxfp4" | GgufType | "mlx8" | "mlx6" | "mlx4" | "mlx3" | "file" | "custom";

/**
 * GGUF mixes: body bits per weight fitted on real files (dense and MoE
 * columns), the token-embedding and output-head types, and the extra bits
 * ffn_down pays when its row length isn't a multiple of 256 (llama.cpp falls
 * back to a larger block type).
 */
const GGUF: Record<GgufType, { label: string; dense: number; moe: number; embed: number; out: number; downFallback: number; fallback: number }> = {
  q8_0: { label: "Q8_0", dense: 8.503, moe: 8.505, embed: 8.5, out: 8.5, downFallback: 0, fallback: 8.5 },
  q6_k: { label: "Q6_K", dense: 6.566, moe: 6.568, embed: 6.5625, out: 6.5625, downFallback: 1.94, fallback: 8.5 },
  q5_k_m: { label: "Q5_K_M", dense: 5.66, moe: 5.675, embed: 5.5, out: 6.5625, downFallback: 1.22, fallback: 6.0 },
  q4_k_m: { label: "Q4_K_M", dense: 4.802, moe: 4.835, embed: 4.5, out: 6.5625, downFallback: 1.47, fallback: 5.5 },
  iq4_xs: { label: "IQ4_XS", dense: 4.265, moe: 4.262, embed: 4.25, out: 6.5625, downFallback: 0.25, fallback: 4.5 },
  q3_k_m: { label: "Q3_K_M", dense: 3.845, moe: 3.815, embed: 3.4375, out: 6.5625, downFallback: 1.0, fallback: 4.5 },
  q2_k: { label: "Q2_K", dense: 2.932, moe: 2.906, embed: 2.625, out: 6.5625, downFallback: 1.875, fallback: 4.5 },
  iq2_xxs: { label: "IQ2_XXS", dense: 2.108, moe: 2.076, embed: 2.625, out: 5.5, downFallback: 2.44, fallback: 4.5 },
};
const GGUF_TYPES = Object.keys(GGUF) as GgufType[];

/** Safetensors formats (vLLM, SGLang): body bits; embedding and head stay BF16. */
const ST_FORMATS = {
  bf16: { label: "BF16", body: 16 },
  fp8: { label: "FP8", body: 8.002 },
  int8: { label: "INT8 W8A8", body: 8.004 },
  int4: { label: "INT4 (AWQ/GPTQ g128)", body: 4.156 },
  nvfp4: { label: "NVFP4", body: 4.5 },
} as const;

/** MLX affine quantisation, group 64: bits + 0.5 on every linear layer, embedding and head included. */
const MLX_FORMATS = { mlx8: 8, mlx6: 6, mlx4: 4, mlx3: 3 } as const;

export type KvDtype = "f16" | "q8_0" | "q4_0" | "fp8" | "kv8" | "kv4";

export const KV_OPTIONS: Record<Engine, { id: KvDtype; label: string }[]> = {
  llamacpp: [
    { id: "f16", label: "F16" },
    { id: "q8_0", label: "Q8_0" },
    { id: "q4_0", label: "Q4_0" },
  ],
  vllm: [
    { id: "f16", label: "auto (BF16)" },
    { id: "fp8", label: "FP8" },
  ],
  mlx: [
    { id: "f16", label: "F16" },
    { id: "kv8", label: "8-bit" },
    { id: "kv4", label: "4-bit" },
  ],
};

/** Bytes per cached element. */
export const KV_BYTES: Record<KvDtype, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32, fp8: 1, kv8: 1.0625, kv4: 0.5625 };

export function formatLabel(f: FormatId): string {
  if (f in GGUF) return GGUF[f as GgufType].label;
  if (f in ST_FORMATS) return ST_FORMATS[f as keyof typeof ST_FORMATS].label;
  if (f in MLX_FORMATS) return `MLX ${MLX_FORMATS[f as keyof typeof MLX_FORMATS]}-bit`;
  return { native: "As published", mxfp4: "MXFP4", file: "Your file", custom: "Custom bits" }[f as "native" | "mxfp4" | "file" | "custom"];
}

// ---------------------------------------------------------------- the model

/** Everything the estimator needs about a model, from a Hugging Face record or typed in by hand. */
export interface VramModel {
  name: string;
  params: number;
  groups: TensorGroups;
  dims: Dims;
  moe: MoeLayout | null;
  kv: KvPlan;
  native: { format: NativeFormat; bits: number };
  checkpointBytes: number | null;
  ggufFiles?: { name: string; bytes: number }[];
  maxPositions: number | null;
}

export function modelFromRecord(r: WeightsRecord, name: string): VramModel | null {
  if (!r.arch || r.status !== "open") return null;
  return {
    name,
    params: r.params,
    groups: r.groups,
    dims: r.arch.dims,
    moe: r.arch.moe,
    kv: r.arch.kv,
    native: r.native,
    checkpointBytes: r.checkpointBytes,
    ggufFiles: r.ggufFiles,
    maxPositions: r.arch.maxPositions,
  };
}

// ---------------------------------------------------------------- settings

export interface VramSettings {
  engine: Engine;
  format: FormatId;
  /** Bytes of the file you'll run ("file" format, or a GGUF-only repo's file). */
  fileBytes: number | null;
  /** Bits per weight ("custom" format). */
  bpw: number | null;
  /** Tokens per sequence. */
  ctx: number;
  seqs: number;
  kv: KvDtype;
  device: Device;
  count: 1 | 2 | 4 | 8;
  /** vLLM gpu_memory_utilization. */
  util: number;
  /** vLLM max_num_batched_tokens; null = vLLM's default for the GPU. */
  mbt: number | null;
  /** llama.cpp micro-batch. */
  ub: number;
  flashAttn: boolean;
  swaFull: boolean;
  /** llama.cpp --cpu-moe: routed experts in system RAM. */
  expertsOnHost: boolean;
  /** Load the vision/audio encoder. */
  vision: boolean;
  /** Load the MTP (multi-token prediction) layers. */
  mtp: boolean;
  /** Keep n-gram/Engram lookup tables in system RAM (llama.cpp). */
  lookupOnHost: boolean;
  /** This GPU also drives a display. */
  display: boolean;
  /** macOS GPU cap raised with sysctl to RAM − 8 GiB. */
  macRaised: boolean;
}

export const VLLM_UTIL = 0.92;

// ---------------------------------------------------------------- format options

export interface FormatOption {
  id: FormatId;
  label: string;
  /** Approximate body bits per weight. */
  bits: number;
  disabled?: string;
  /** For GGUF-only repos: the file this option stands for. */
  file?: { name: string; bytes: number };
}

/** Bits per weight as served: F32 checkpoints are served at 16. */
const nativeBits = (m: VramModel) => (m.native.format === "gguf" ? 16 : m.native.bits > 20 ? m.native.bits / 2 : m.native.bits || 16);

/** Formats the engine can run, hiding upcasts (more than half a bit above how the weights ship). */
export function formatOptions(m: VramModel, engine: Engine, device: Device | null): FormatOption[] {
  const ceiling = nativeBits(m) + 0.5;
  const nat = m.native.format;
  const opts: FormatOption[] = [];
  if (m.ggufFiles?.length) {
    return m.ggufFiles.map((f) => ({ id: "file" as const, label: `File: ${f.name}`, bits: m.params ? (8 * f.bytes) / m.params : 0, file: f }));
  }
  if (engine === "llamacpp") {
    if (nat === "bf16" || nat === "fp16") opts.push({ id: "bf16", label: "BF16", bits: 16 });
    if (nat === "mxfp4") opts.push({ id: "mxfp4", label: "MXFP4 (as published)", bits: 4.25 });
    for (const t of GGUF_TYPES) {
      const bits = m.moe ? GGUF[t].moe : GGUF[t].dense;
      if (bits <= ceiling) opts.push({ id: t, label: GGUF[t].label, bits });
    }
  } else if (engine === "vllm") {
    opts.push({ id: "native", label: `As published (${nativeLabel(nat)})`, bits: nativeBits(m) });
    for (const [id, f] of Object.entries(ST_FORMATS) as [keyof typeof ST_FORMATS, (typeof ST_FORMATS)[keyof typeof ST_FORMATS]][]) {
      // BF16 is either an upcast or the same as "As published".
      if (f.body > ceiling || id === "bf16") continue;
      if (Math.abs(f.body - nativeBits(m)) < 0.3) continue; // same as native
      opts.push({
        id,
        label: f.label,
        bits: f.body,
        ...(id === "nvfp4" && device && !device.blackwell ? { disabled: "NVFP4 needs a Blackwell GPU" } : {}),
      });
    }
  } else {
    if (nat === "bf16" || nat === "fp16") opts.push({ id: "bf16", label: "BF16", bits: 16 });
    for (const [id, b] of Object.entries(MLX_FORMATS) as [keyof typeof MLX_FORMATS, number][]) {
      if (b + 0.5 <= ceiling) opts.push({ id, label: `MLX ${b}-bit`, bits: b + 0.5 });
    }
  }
  return opts;
}

export function nativeLabel(f: NativeFormat): string {
  return { bf16: "BF16", fp16: "FP16", f32: "F32", fp8: "FP8", int4: "INT4", mxfp4: "MXFP4", fp4: "FP4 experts", gguf: "GGUF" }[f];
}

export function defaultFormat(m: VramModel, engine: Engine, device: Device | null): FormatId {
  const opts = formatOptions(m, engine, device).filter((o) => !o.disabled);
  if (m.ggufFiles?.length) return "file";
  const want: FormatId = engine === "vllm" ? "native" : engine === "mlx" ? "mlx4" : m.native.format === "mxfp4" ? "mxfp4" : "q4_k_m";
  const exact = opts.find((o) => o.id === want);
  if (exact) return exact.id;
  // The wanted format was filtered out (an upcast): take the richest one at or below its bits.
  const wantBits = want === "mlx4" ? 4.5 : want === "q4_k_m" ? GGUF.q4_k_m.dense : want === "mxfp4" ? 4.25 : nativeBits(m);
  const below = opts.filter((o) => o.bits <= wantBits + 0.05).sort((a, b) => b.bits - a.bits)[0];
  return below?.id ?? opts[0]?.id ?? "native";
}

// ---------------------------------------------------------------- weights

export interface WeightSplit {
  /** Bytes the GPUs hold in total (before splitting across GPUs). */
  gpu: Range;
  /** Bytes in system RAM. */
  host: Range;
  /** The part of `gpu` that's the output head (layer split puts it on the last GPU). */
  head: number;
  /** Encoder (vision/audio) bytes on the GPU. */
  encoders: number;
  /** One-line arithmetic. */
  formula: string;
}

const B = (params: number, bits: number) => (params * bits) / 8;
const fmtB = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;

/** Parameters in ffn_down (dense layers and routed experts), for GGUF's row-length fallback. */
function downParams(m: VramModel): { dense: number; experts: number } {
  const moeLayers = m.moe?.layers ?? 0;
  const dense = (m.dims.layers - moeLayers) * m.dims.hidden * m.dims.ffn;
  const experts = m.moe ? m.groups.experts / m.moe.mats : 0;
  return { dense: Math.max(0, dense), experts };
}

/** Bits per weight for each tensor group under one format (null = not sized per group). */
interface GroupBits {
  body: number;
  experts: number;
  lookup: number;
  embed: number;
  out: number;
  /** Extra bytes (GGUF ffn_down row-length fallback). */
  extra: number;
  /** Relative range of the weights figure. */
  low: number;
  high: number;
  formula: string;
}

export function weightBytes(m: VramModel, s: VramSettings): WeightSplit {
  const g = m.groups;
  const loadMtp = s.mtp ? g.mtp : 0;
  const loadVision = s.vision ? g.vision : 0;
  const llama = s.engine === "llamacpp";
  const unified = s.device.cls === "unified";
  // Body: every parameter that isn't embedding, head, MTP, vision or lookup; routed experts are part of it.
  const bodyAll = Math.max(0, m.params - g.embed - g.head - g.mtp - g.vision - g.lookup) + loadMtp;
  const experts = Math.min(g.experts, bodyAll);
  const dense = bodyAll - experts;
  const outParams = g.head || (m.dims.tied ? g.embed : 0);
  const groupsSlack = g.source === "config" ? 0.02 : 0;

  let bits: GroupBits | null = null;
  let ckBytes: number | null = null; // whole-checkpoint formats ("native", files)
  let formula = "";

  if (s.format === "file" || (m.ggufFiles?.length && s.fileBytes)) {
    ckBytes = s.fileBytes ?? m.ggufFiles?.[0]?.bytes ?? m.checkpointBytes ?? 0;
    const named = m.ggufFiles?.find((f) => f.bytes === ckBytes);
    formula = named ? `${named.name}, ${(ckBytes / 1e9).toFixed(2)} GB` : `your file, ${(ckBytes / 1e9).toFixed(2)} GB`;
  } else if (llama && s.format in GGUF) {
    const t = GGUF[s.format as GgufType];
    let bodyBits = m.moe && experts > bodyAll * 0.5 ? t.moe : t.dense;
    // Hidden size not a multiple of 256: most tensors fall back to a larger block type.
    const hiddenFallback = m.dims.hidden % 256 !== 0 && t.fallback > bodyBits;
    if (hiddenFallback) bodyBits = t.fallback;
    // gpt-oss: with a hidden size that isn't a multiple of 256, every K-quant falls back to a
    // 4.5-bit-or-larger block, so converters keep the published MXFP4 experts and requantize
    // only the rest. Elsewhere (Kimi K3) the experts are requantized like any other tensor.
    const keepMx = m.native.format === "mxfp4" && m.dims.hidden % 256 !== 0;
    let extra = 0;
    if (!hiddenFallback && t.downFallback) {
      const d = downParams(m);
      if (m.dims.ffn && m.dims.ffn % 256 !== 0) extra += B(d.dense, t.downFallback);
      if (m.moe && m.moe.ffn % 256 !== 0 && !keepMx) extra += B(d.experts, t.downFallback);
    }
    const slack = hiddenFallback ? 0.03 : 0;
    bits = {
      body: bodyBits,
      experts: keepMx ? 4.25 : bodyBits,
      lookup: bodyBits,
      embed: m.dims.tied ? t.out : t.embed,
      out: t.out,
      extra,
      low: 0.985 - slack - groupsSlack,
      high: 1.02 + slack + groupsSlack,
      formula: `${fmtB(bodyAll)} body × ${bodyBits.toFixed(2)} bits (${t.label}${hiddenFallback ? ", hidden size not a multiple of 256" : ""})${keepMx ? `, ${fmtB(experts)} experts kept at MXFP4 (4.25 bits)` : ""} + ${fmtB(outParams)} output × ${t.out} bits${extra ? " + ffn_down fallback" : ""}`,
    };
  } else if (s.format === "mxfp4") {
    bits = {
      body: 8.5,
      experts: 4.25,
      lookup: 8.5,
      embed: 8.5,
      out: 8.5,
      extra: 0,
      low: 0.99,
      high: 1.02,
      formula: `${fmtB(experts)} experts × 4.25 bits (MXFP4) + ${fmtB(dense + outParams)} × 8.5 bits (Q8_0)`,
    };
  } else if (s.format in MLX_FORMATS) {
    const b = MLX_FORMATS[s.format as keyof typeof MLX_FORMATS] + 0.5;
    bits = { body: b, experts: b, lookup: b, embed: b, out: b, extra: 0, low: 0.99 - groupsSlack, high: 1.02 + groupsSlack, formula: `${fmtB(bodyAll + g.embed + g.head + g.lookup)} × ${b} bits (group 64, embedding and head included)` };
  } else if (s.format === "native" && m.checkpointBytes && !llama) {
    // The published checkpoint less what isn't loaded; F32 checkpoints are served at 16 bits.
    const ck = m.native.bits > 20 ? m.checkpointBytes / 2 : m.checkpointBytes;
    const avgBits = (8 * ck) / m.params;
    const skipped = B(g.mtp - loadMtp, avgBits) + B(g.vision, 16);
    ckBytes = Math.max(0, ck - skipped);
    const notLoaded = [g.mtp - loadMtp ? "MTP" : "", g.vision ? "vision" : ""].filter(Boolean).join(" and ");
    formula = `published checkpoint ${(ck / 1e9).toFixed(1)} GB${skipped > 1e8 ? `, less ${(skipped / 1e9).toFixed(1)} GB of ${notLoaded} layers` : ""}`;
  } else if (s.format === "bf16" || s.format === "native") {
    bits = { body: 16, experts: 16, lookup: 16, embed: 16, out: 16, extra: 0, low: 0.995 - groupsSlack, high: 1.005 + groupsSlack, formula: `${fmtB(bodyAll + g.embed + g.head + g.lookup)} × 16 bits` };
  } else if (s.format in ST_FORMATS || s.format === "custom") {
    const b = s.format === "custom" ? (s.bpw ?? 4) : ST_FORMATS[s.format as keyof typeof ST_FORMATS].body;
    const custom = s.format === "custom";
    bits = {
      body: b,
      experts: b,
      lookup: b,
      embed: 16,
      out: 16,
      extra: 0,
      low: custom ? 0.97 : 0.98 - groupsSlack,
      high: custom ? 1.03 : 1.02 + groupsSlack,
      formula: `${fmtB(bodyAll + g.lookup)} × ${b} bits + ${fmtB(g.embed + g.head)} embedding and head × 16 bits`,
    };
  } else {
    throw new Error(`format ${s.format} isn't available on ${s.engine}`);
  }

  // Bytes per group. Whole-checkpoint formats are split by parameter share.
  let sz: { dense: number; experts: number; lookup: number; embed: number; out: number };
  let low = 0.985;
  let high = 1.03;
  if (bits) {
    sz = {
      dense: B(dense, bits.body) + bits.extra,
      experts: B(experts, bits.experts),
      lookup: B(g.lookup, bits.lookup),
      embed: B(g.embed, bits.embed),
      // Tied embeddings are stored once (at the output type); the GPU holds that tensor as the output.
      out: m.dims.tied ? 0 : B(g.head, bits.out),
    };
    low = bits.low;
    high = bits.high;
    formula = bits.formula;
  } else {
    const total = Math.max(1, dense + experts + g.lookup + g.embed + g.head);
    const share = (p: number) => ((ckBytes ?? 0) * p) / total;
    sz = { dense: share(dense), experts: share(experts), lookup: share(g.lookup), embed: share(g.embed), out: m.dims.tied ? 0 : share(g.head) };
    if (s.format === "file" || m.ggufFiles?.length) {
      low = 1;
      high = 1;
    }
  }

  // Placement. vLLM and MLX hold everything on the GPU. llama.cpp keeps the input embedding
  // table in system RAM on a discrete GPU (a tied model's GPU keeps its output copy), and can
  // move routed experts (--cpu-moe) and lookup tables there too. Unified memory is one pool:
  // count each tensor once.
  let onGpu = sz.dense + sz.experts + sz.lookup + sz.out + sz.embed;
  let onHost = 0;
  if (llama) {
    if (!unified) {
      // The embedding table goes to RAM; a tied model's GPU still holds that tensor as its output.
      onHost += sz.embed;
      if (!m.dims.tied) onGpu -= sz.embed;
    }
    if (s.expertsOnHost && sz.experts) {
      onGpu -= sz.experts;
      onHost += sz.experts;
    }
    if (s.lookupOnHost && sz.lookup) {
      onGpu -= sz.lookup;
      onHost += sz.lookup;
    }
  }
  const head = m.dims.tied ? sz.embed : sz.out;
  let gpu = R(onGpu * low, onGpu, onGpu * high);
  // The vision/audio encoder: llama.cpp loads its mmproj at F16; others at the published precision (≈16-bit).
  const encoders = loadVision ? B(loadVision, 16) : 0;
  if (encoders) gpu = add(gpu, fixed(encoders));
  return { gpu, host: fixed(onHost), head, encoders, formula };
}

// ---------------------------------------------------------------- KV cache and state

/** vLLM's default max_num_batched_tokens by GPU memory (engine args, 2026). */
export function vllmBatchTokens(d: Device): number {
  if (d.usableGiB >= 160) return 16384;
  if (d.usableGiB >= 70 && !/A100/.test(d.name)) return 8192;
  return 2048;
}

export interface KvResult {
  /** Bytes per GPU rank (tensor parallel) or in total (layer split): the cache for all sequences. */
  perRank: number;
  total: number;
  state: number;
  /** Marginal bytes per extra token of context, all sequences, for display. */
  perToken: number;
  /** Per sequence (for vLLM concurrency). */
  perSeq: number;
  formula: string;
  notes: string[];
}

/** KV cache and recurrent state at a context, with the engine's own allocation rules. */
export function kvBytes(m: VramModel, s: VramSettings, ctx = s.ctx): KvResult {
  const plan = m.kv;
  const notes: string[] = [];
  let b = KV_BYTES[s.kv];
  if (s.engine === "llamacpp" && !s.flashAttn && s.kv !== "f16") {
    b = (b + 2) / 2; // V stays F16 without flash attention
    notes.push("Without flash attention llama.cpp keeps the V cache at F16.");
  }
  const tp = s.engine === "vllm" ? s.count : 1;
  const seqs = Math.max(1, s.seqs);
  const T = s.engine === "vllm" ? (s.mbt ?? vllmBatchTokens(s.device)) : 0;

  // Tokens held per kind, for all sequences together.
  const fullTokens =
    s.engine === "llamacpp" ? pad(ctx * seqs, 256) : s.engine === "vllm" ? seqs * pad(ctx, 16) : seqs * pad(ctx, 256);
  const windowTokens = (w: number, chunked: boolean) => {
    if (s.engine === "llamacpp") return s.swaFull ? fullTokens : Math.min(fullTokens, pad(w * seqs + s.ub, 256));
    if (s.engine === "vllm") {
      // vLLM's hybrid manager disables windows for chunked attention by default.
      if (chunked) return fullTokens;
      const blocks = Math.ceil((w - 1 + 2 * T) / 16) + 1;
      return seqs * Math.min(pad(ctx, 16), blocks * 16);
    }
    return seqs * Math.min(pad(ctx, 256), w + 2048);
  };

  let perRank = 0;
  let total = 0;
  let perToken = 0;
  // vLLM's sparse-MLA kernels (DeepSeek-V3.2-style indexer models) cache the latent as fp8_ds_mla
  // whatever the KV setting: 1 byte per latent dim, 2 per RoPE dim, plus 16 bytes of scales.
  const dsMla = s.engine === "vllm" && plan.indexers.length > 0 && plan.groups.some((g) => g.kind === "latent" && (g.rope ?? 0) > 0);
  const dsBytes = (g: { headElems: number; rope?: number }) => g.headElems - (g.rope ?? 0) + 2 * (g.rope ?? 0) + 16;
  if (dsMla) {
    const latent = plan.groups.find((g) => g.kind === "latent" && (g.rope ?? 0) > 0)!;
    notes.push(`vLLM stores this model's latent cache as fp8_ds_mla (${dsBytes(latent)} bytes per token per layer) whatever the KV setting.`);
  }
  for (const g of plan.groups) {
    // Gemma 4's K=V global layers cache one tensor, but vLLM stores K and V separately.
    const headElems = g.kEqV && s.engine === "vllm" ? g.headElems * 2 : g.headElems;
    const elems = g.heads * headElems;
    const rankElems = g.kind === "latent" ? elems : Math.ceil(g.heads / tp) * headElems;
    const tokens = g.kind === "window" ? windowTokens(g.window ?? 0, Boolean(g.chunked)) : fullTokens;
    const perElem = (e: number) => (g.kind === "latent" && dsMla && (g.rope ?? 0) > 0 ? dsBytes(g) * (e / g.headElems) : e * b);
    total += g.layers * perElem(elems) * tokens;
    perRank += g.layers * perElem(rankElems) * tokens;
    if (g.kind !== "window" || tokens === fullTokens) perToken += g.layers * perElem(elems) * seqs;
  }
  for (const c of plan.compressed) {
    const bytes = c.layers * c.elems * b * seqs * Math.ceil(ctx / c.ratio);
    total += bytes;
    perRank += bytes; // latent-style: every rank holds it
    perToken += (c.layers * c.elems * b * seqs) / c.ratio;
  }
  for (const i of plan.indexers) {
    const perTok = (i.layers * (i.fp8 ? i.elems + 4 : i.elems * b)) / i.ratio;
    const bytes = perTok * fullTokens;
    total += bytes;
    perRank += bytes;
    perToken += perTok * seqs;
  }

  // Recurrent state: llama.cpp keeps it in F32; vLLM keeps conv in the model dtype and,
  // with prefix caching on (the default), two copies per sequence.
  let state = 0;
  if (plan.state) {
    const st = plan.state;
    if (s.engine === "llamacpp") state = (st.convElems + st.ssmElems) * 4 * seqs;
    else {
      const one = st.convElems * 2 + st.ssmElems * (st.ssmFp32 ? 4 : 2);
      state = one * seqs * (s.engine === "vllm" ? 2 : 1);
    }
  }
  const stateRank = state / tp;
  const perSeq = (perRank + stateRank) / seqs;

  // The arithmetic for the first group, with the same per-element bytes used above.
  const g0 = plan.groups[0];
  const bStr = b.toFixed(b % 1 ? 3 : 0);
  const more = (n: number) => (n > 1 || plan.compressed.length || plan.indexers.length ? " + other layers" : "");
  let formula = "no attention cache";
  if (g0?.kind === "latent") {
    const per = dsMla && (g0.rope ?? 0) > 0 ? `${dsBytes(g0)} B (fp8_ds_mla)` : `${g0.headElems} latent dims × ${bStr} B`;
    formula = `${g0.layers} layers × ${per} × ${fmtTok(fullTokens)} tokens${more(plan.groups.length)}`;
  } else if (g0) {
    const kv2 = g0.kEqV && s.engine === "vllm";
    const tokens = g0.kind === "window" ? windowTokens(g0.window ?? 0, Boolean(g0.chunked)) : fullTokens;
    formula = `${g0.layers} layers × ${g0.heads} KV heads × ${kv2 ? `${g0.headElems * 2} (K and V stored separately)` : `${g0.headElems} (K+V)`} × ${bStr} B × ${fmtTok(tokens)} tokens${more(plan.groups.length)}`;
  }
  return { perRank: perRank + stateRank, total: total + state, state, perToken, perSeq, formula, notes };
}

const fmtTok = (t: number) => t.toLocaleString("en-US");

// ---------------------------------------------------------------- overhead

/** Active FFN width per token: the dense FFN, or top-k experts plus shared. */
function ffnActive(m: VramModel): number {
  if (!m.moe) return m.dims.ffn;
  return m.moe.topK * m.moe.ffn + m.moe.shared * m.moe.ffn;
}

export interface Overhead {
  /** Per GPU. */
  runtime: Range[];
  compute: Range[];
  /** System RAM (llama.cpp host compute buffer). */
  host: Range;
  /** vLLM: memory for activations, CUDA graphs and non-torch allocations, per GPU (inside the budget). */
  formulaRuntime: string;
  formulaCompute: string;
}

export function overheadBytes(m: VramModel, s: VramSettings, kvTokensFull: number): Overhead {
  const n = s.count;
  const apple = s.device.vendor === "apple";
  const E = m.dims.hidden;
  const V = m.dims.vocab;
  if (s.engine === "llamacpp") {
    const ctxR = apple ? R(0.1 * GiB, 0.2 * GiB, 0.3 * GiB) : R(0.25 * GiB, 0.4 * GiB, 0.6 * GiB);
    const ub = s.ub;
    const fa = s.flashAttn;
    const mask = kvTokensFull * ub * (fa ? 2 : 4);
    const ffn = ub * (3 * ffnActive(m) + 3 * E) * 4;
    const logits = Math.max(1, s.seqs) * V * 4 + ub * E * 8;
    const kq = fa ? 0 : kvTokensFull * ub * m.dims.heads * 4;
    const last = spread(mask + Math.max(ffn, logits, kq) + 16 * MiB, 0.85, 1.5);
    const other = spread(mask + ffn + 16 * MiB, 0.85, 1.5);
    const compute = Array.from({ length: n }, (_, i) => (i === n - 1 ? last : other));
    const hostBytes = kvTokensFull * ub * 2 + 12 * MiB;
    return {
      runtime: Array.from({ length: n }, () => ctxR),
      compute,
      host: spread(hostBytes, 0.8, 1.3),
      formulaRuntime: apple ? "Metal process baseline" : "CUDA/ROCm/Vulkan context per GPU",
      formulaCompute: `mask ${fmtTok(kvTokensFull)} cells × ${ub} × ${fa ? 2 : 4} B + max(FFN, logits ${Math.max(1, s.seqs)} × ${fmtTok(V)} vocab × 4 B${fa ? "" : ", attention scores"})`,
    };
  }
  if (s.engine === "vllm") {
    const T = s.mbt ?? vllmBatchTokens(s.device);
    const S = Math.max(1, s.seqs);
    const sampler = 2 * S * V * 4;
    const tokens = m.moe
      ? T * 2 * (10 * E + (6 * m.moe.topK * (m.moe.ffn + E)) / n + (2 * m.moe.shared * m.moe.ffn) / n)
      : T * 2 * (10 * E + (2 * m.dims.ffn) / n);
    const act = spread(sampler + tokens, 0.8, 1.25);
    const nonTorch = n > 1 ? R(0.4 * GiB, 0.5 * GiB, 0.9 * GiB) : R(0.2 * GiB, 0.25 * GiB, 0.6 * GiB);
    const graphs = R(0.1 * GiB, 0.4 * GiB, 0.8 * GiB);
    const encoder = s.vision && m.groups.vision ? R(1 * GiB, 1.5 * GiB, 4 * GiB) : ZERO;
    return {
      runtime: Array.from({ length: n }, () => add(nonTorch, graphs)),
      compute: Array.from({ length: n }, () => add(act, encoder)),
      host: ZERO,
      formulaRuntime: "non-torch allocations + CUDA graphs, per GPU",
      formulaCompute: `activation peak at ${fmtTok(T)} batched tokens + sampler (${S} × ${fmtTok(V)} vocab × 8 B)${s.vision && m.groups.vision ? " + encoder profiling" : ""}`,
    };
  }
  // MLX: a transient prefill peak (2,048-token chunk) plus the process baseline.
  return {
    runtime: [R(0.2 * GiB, 0.3 * GiB, 0.4 * GiB)],
    compute: [R(0.4 * GiB, 0.75 * GiB, 1.1 * GiB)],
    host: ZERO,
    formulaRuntime: "Python + Metal process baseline",
    formulaCompute: "transient peak while prefilling 2,048-token chunks",
  };
}

// ---------------------------------------------------------------- budget

/** What the engine can use on one device. */
export function budgetBytes(d: Device, s: Pick<VramSettings, "engine" | "util" | "macRaised">): number {
  let cap = d.usableGiB * GiB;
  if (d.vendor === "apple" && s.macRaised && d.ramGiB) cap = (d.ramGiB - 8) * GiB;
  return s.engine === "vllm" ? cap * s.util : cap;
}

// ---------------------------------------------------------------- the estimate

export type Verdict = "fits" | "tight" | "just-over" | "wont-fit";

export const VERDICT_LABEL: Record<Verdict, string> = {
  fits: "Fits",
  tight: "Tight",
  "just-over": "Just over",
  "wont-fit": "Won't fit",
};

export function verdictOf(need: Range, budget: number): Verdict {
  if (need.high <= budget) return "fits";
  if (need.mid <= budget) return "tight";
  if (need.low <= budget) return "just-over";
  return "wont-fit";
}

export type LineId = "weights" | "encoders" | "kv" | "state" | "compute" | "runtime" | "display";

export interface VramLine {
  id: LineId;
  label: string;
  /** Per GPU. */
  perGpu: Range[];
  formula: string;
}

export interface VramEstimate {
  lines: VramLine[];
  /** Need per GPU. */
  perGpu: Range[];
  /** Budget per GPU. */
  budget: number;
  /** The most-loaded GPU's need and verdict. */
  need: Range;
  verdict: Verdict;
  /** System RAM: embedding table, offloaded experts, lookup tables, llama.cpp host buffer. */
  host: Range;
  hostItems: { label: string; bytes: Range }[];
  kv: KvResult;
  /** vLLM: the KV pool after weights and activations, and how many sequences of this context it holds. */
  pool: { bytes: number; seqsAtCtx: number } | null;
  /** Weights alone exceed the budget. */
  weightsAlone: boolean;
  notes: string[];
  invalid: string | null;
}

const FORMAT_ENGINES: Partial<Record<FormatId, Engine[]>> = {
  native: ["vllm"],
  fp8: ["vllm"],
  int8: ["vllm"],
  int4: ["vllm"],
  nvfp4: ["vllm"],
  mxfp4: ["llamacpp"],
  mlx8: ["mlx"],
  mlx6: ["mlx"],
  mlx4: ["mlx"],
  mlx3: ["mlx"],
  ...Object.fromEntries(GGUF_TYPES.map((t) => [t, ["llamacpp"]])),
};

/** Why these settings can't run, or null. */
export function invalidReason(m: VramModel, s: VramSettings): string | null {
  if (s.engine === "mlx" && s.device.vendor !== "apple") return "MLX runs only on Apple silicon.";
  if (s.engine === "vllm" && s.device.vendor === "apple") return "vLLM doesn't run on Macs.";
  const engines = FORMAT_ENGINES[s.format];
  if (engines && !engines.includes(s.engine)) return `${formatLabel(s.format)} weights don't run on ${ENGINE_LABEL[s.engine]}.`;
  if (s.device.cls === "unified" && s.count > 1) return "Unified-memory machines count as one device.";
  if (s.engine === "vllm" && s.count > 1 && m.dims.heads % s.count !== 0) {
    return `${s.count} GPUs can't split ${m.dims.heads} attention heads evenly under tensor parallelism.`;
  }
  return null;
}

export function estimate(m: VramModel, s: VramSettings): VramEstimate {
  const invalid = invalidReason(m, s);
  // An impossible format can't be sized: estimate the engine's usual one and mark it invalid.
  if (invalid && FORMAT_ENGINES[s.format] && !FORMAT_ENGINES[s.format]!.includes(s.engine)) {
    return { ...estimate(m, { ...s, format: defaultFormat(m, s.engine, s.device) }), verdict: "wont-fit", invalid };
  }
  const n = s.count;
  const w = weightBytes(m, s);
  const kv = kvBytes(m, s);
  const budget = budgetBytes(s.device, s);
  const notes = [...kv.notes];

  // Full-attention cells for llama.cpp's compute buffer (the mask spans all of them).
  const kvTokensFull = s.engine === "llamacpp" ? pad(s.ctx * Math.max(1, s.seqs), 256) : s.ctx;
  const oh = overheadBytes(m, s, kvTokensFull);

  // Split across GPUs: tensor parallel (vLLM) divides weights and shards KV heads;
  // layer split (llama.cpp) gives each GPU its layers, with the output head on the last.
  const weightsPer: Range[] = [];
  const kvPer: number[] = [];
  const statePer: number[] = [];
  for (let i = 0; i < n; i++) {
    if (s.engine === "vllm") {
      weightsPer.push(scale(w.gpu, 1 / n));
      kvPer.push(kv.perRank - kv.state / n);
      statePer.push(kv.state / n);
    } else {
      const bodyShare = scale(add(w.gpu, fixed(-w.head - w.encoders)), 1 / n);
      weightsPer.push(i === n - 1 ? add(bodyShare, fixed(w.head + w.encoders)) : bodyShare);
      kvPer.push((kv.total - kv.state) / n);
      statePer.push(kv.state / n);
    }
  }
  const kvRange = (bytes: number) => (m.kv.confidence === "high" ? spread(bytes, 0.99, 1.01) : m.kv.confidence === "medium" ? spread(bytes, 1, 1.2) : spread(bytes, 0.5, 1.5));
  const display = s.display && s.device.cls !== "unified" ? R(0.3 * GiB, 0.6 * GiB, 1.5 * GiB) : ZERO;

  // The encoder is part of the weights ranges above; report it on its own line.
  const encoderOn = (i: number) => (s.engine === "vllm" ? w.encoders / n : i === n - 1 ? w.encoders : 0);
  const lines: VramLine[] = [{ id: "weights", label: "Weights", perGpu: weightsPer.map((r, i) => add(r, fixed(-encoderOn(i)))), formula: w.formula }];
  if (w.encoders) {
    lines.push({
      id: "encoders",
      label: "Vision/audio encoder",
      perGpu: Array.from({ length: n }, (_, i) => fixed(encoderOn(i))),
      formula: `${fmtB(m.groups.vision)} encoder parameters × 16 bits`,
    });
  }
  lines.push({ id: "kv", label: "KV cache", perGpu: kvPer.map(kvRange), formula: kv.formula });
  if (kv.state) {
    lines.push({
      id: "state",
      label: "Recurrent state",
      perGpu: statePer.map((x) => spread(x, 1, m.kv.confidence === "high" ? 1.01 : 1.2)),
      formula: `${m.kv.state!.layers} linear-attention/SSM layers × ${Math.max(1, s.seqs)} sequence${s.seqs > 1 ? "s" : ""}${s.engine === "vllm" ? " × 2 copies (prefix caching)" : ""}, ${s.engine === "llamacpp" ? "F32" : "conv in BF16, state in FP32"}`,
    });
  }
  lines.push({ id: "compute", label: s.engine === "vllm" ? "Activations" : "Compute buffer", perGpu: oh.compute, formula: oh.formulaCompute });
  lines.push({ id: "runtime", label: "Runtime", perGpu: oh.runtime, formula: oh.formulaRuntime });
  if (display.mid) lines.push({ id: "display", label: "Display", perGpu: [display, ...Array.from({ length: n - 1 }, () => ZERO)], formula: "this GPU also drives a desktop" });

  const perGpu = Array.from({ length: n }, (_, i) => add(...lines.map((l) => l.perGpu[i] ?? ZERO)));
  const worst = perGpu.reduce((a, b) => (b.mid > a.mid ? b : a));

  const hostItems: { label: string; bytes: Range }[] = [];
  if (w.host.mid) {
    const parts = [
      s.device.cls === "unified" ? "" : m.dims.tied ? "embedding table (a copy)" : "embedding table",
      s.engine === "llamacpp" && s.expertsOnHost && m.groups.experts ? "routed experts" : "",
      s.engine === "llamacpp" && s.lookupOnHost && m.groups.lookup ? "lookup tables" : "",
    ].filter(Boolean);
    const label = parts.join(" + ") || "weights";
    hostItems.push({ label: label[0].toUpperCase() + label.slice(1), bytes: w.host });
  }
  if (s.engine === "llamacpp") hostItems.push({ label: "Host compute buffer", bytes: oh.host });
  const host = add(...hostItems.map((h) => h.bytes));

  // On unified memory the host side is the same pool.
  const need = s.device.cls === "unified" ? add(worst, host) : worst;

  let pool: VramEstimate["pool"] = null;
  if (s.engine === "vllm") {
    const fixedNeed = add(weightsPer[0], oh.compute[0], oh.runtime[0], display);
    const bytes = budget - fixedNeed.mid;
    const perSeqCtx = kv.perSeq;
    pool = { bytes, seqsAtCtx: perSeqCtx > 0 ? Math.max(0, Math.floor(bytes / perSeqCtx)) : 0 };
    notes.push(`vLLM claims ${Math.round(s.util * 100)}% of each GPU up front and fills what's left after weights and activations with KV cache.`);
  }
  const weightsOnly = add(...weightsPer.slice(0, 1));
  return {
    lines,
    perGpu,
    budget,
    need,
    verdict: invalid ? "wont-fit" : verdictOf(need, budget),
    host,
    hostItems,
    kv,
    pool,
    weightsAlone: weightsOnly.low > budget,
    notes,
    invalid,
  };
}

// ---------------------------------------------------------------- max context, setups

export function modelMaxContext(m: VramModel, orContext: number | null): number {
  return Math.max(m.maxPositions ?? 0, orContext ?? 0, 1024);
}

/** Longest context (tokens) whose need stays within budget at the mid ("expected") or high ("safe") estimate. */
export function maxContext(m: VramModel, s: VramSettings, limit: number, bound: "mid" | "high"): { tokens: number; limitedBy: "memory" | "model" | "weights" } {
  const step = s.engine === "llamacpp" ? 256 : 16;
  const ok = (ctx: number) => {
    const e = estimate(m, { ...s, ctx });
    return !e.invalid && e.need[bound] <= e.budget;
  };
  if (!ok(step)) return { tokens: 0, limitedBy: "weights" };
  if (ok(limit)) return { tokens: limit, limitedBy: "model" };
  let lo = 1;
  let hi = Math.floor(limit / step);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid * step)) lo = mid;
    else hi = mid;
  }
  return { tokens: lo * step, limitedBy: "memory" };
}

/** Fewest units of a device (1, 2, 4 or 8) that fit, or null. */
export function minUnits(m: VramModel, s: VramSettings, device: Device): 1 | 2 | 4 | 8 | null {
  const counts: (1 | 2 | 4 | 8)[] = device.cls === "unified" ? [1] : [1, 2, 4, 8];
  for (const count of counts) {
    const e = estimate(m, { ...s, device, count });
    if (!e.invalid && e.verdict === "fits") return count;
  }
  return null;
}

/** llama.cpp partial offload: how many of the layers fit on the GPU when the whole model doesn't. */
export function partialOffloadLayers(m: VramModel, s: VramSettings): number | null {
  // On unified memory "system RAM" is the same pool the GPU already draws from.
  if (s.engine !== "llamacpp" || s.device.cls === "unified") return null;
  const e = estimate(m, s);
  if (e.verdict === "fits" || e.verdict === "tight") return null;
  const fixedMid = e.lines.filter((l) => l.id === "compute" || l.id === "runtime" || l.id === "display").reduce((a, l) => a + l.perGpu.reduce((x, r) => x + r.mid, 0), 0);
  const w = weightBytes(m, s);
  const kv = e.kv.total;
  const perLayer = (w.gpu.mid - w.head - w.encoders + kv) / m.dims.layers;
  const room = e.budget * s.count - fixedMid - w.head - w.encoders;
  const k = Math.floor(room / perLayer);
  return Math.max(0, Math.min(m.dims.layers, k));
}

export const fmtGiB = (bytes: number, digits = 1) =>
  bytes < GiB && bytes > 0 ? `${Math.round(bytes / MiB)} MiB` : `${(bytes / GiB).toFixed(digits)} GiB`;

/** "32k" → 32768, "1m" → 1048576, "32000" → 32000. */
export function parseContext(raw: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1024 : m[2]?.toLowerCase() === "m" ? 1024 * 1024 : 1);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** 32768 → "32K", 18700 → "18.3K", 1048576 → "1M". */
export function fmtCtx(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${+(tokens / (1024 * 1024)).toFixed(1)}M`;
  if (tokens >= 1024) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : +(Math.floor(k * 10) / 10).toFixed(1)}K`;
  }
  return String(tokens);
}
