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

const nativeBits = (m: VramModel) => (m.native.format === "gguf" ? 16 : m.native.bits || 16);

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
      if (f.body > ceiling || (id === "bf16" && nat !== "bf16" && nat !== "fp16")) continue;
      if (Math.abs(f.body - nativeBits(m)) < 0.3 && id !== "bf16") continue; // same as native
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
  return opts.find((o) => o.id === want)?.id ?? opts[opts.length - 1]?.id ?? "native";
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

export function weightBytes(m: VramModel, s: VramSettings): WeightSplit {
  const g = m.groups;
  const loadMtp = s.mtp ? g.mtp : 0;
  const loadVision = s.vision ? g.vision : 0;
  const lookupHost = s.engine === "llamacpp" && s.lookupOnHost;
  const body = Math.max(0, m.params - g.embed - g.head - g.mtp - g.vision - g.lookup) + loadMtp;
  const experts = s.engine === "llamacpp" && s.expertsOnHost ? g.experts : 0;
  const unified = s.device.cls === "unified";
  const headParams = g.head || (m.dims.tied ? g.embed : 0);

  // Ranges: ±0.5% for exact formats, the calibration spread for GGUF mixes, ±2% when groups come from config.
  const groupsSlack = g.source === "config" ? 0.02 : 0;
  let gpu: Range;
  let host: Range = ZERO;
  let head = 0;
  let encoders = 0;
  let formula: string;

  if (s.format === "file" || (m.ggufFiles?.length && s.fileBytes)) {
    const bytes = s.fileBytes ?? m.checkpointBytes ?? 0;
    // Split the file by shares: the token embedding stays on the host in llama.cpp.
    const share = m.params ? g.embed / m.params : 0;
    const embedBytes = s.engine === "llamacpp" && !unified && !m.dims.tied ? bytes * share : 0;
    gpu = fixed(bytes - embedBytes);
    host = fixed(embedBytes);
    formula = `your file, ${(bytes / 1e9).toFixed(2)} GB`;
  } else if (s.engine === "llamacpp" && s.format in GGUF) {
    const t = GGUF[s.format as GgufType];
    const big = m.moe && g.experts > body * 0.5;
    let bodyBits = big ? t.moe : t.dense;
    // Hidden size not a multiple of 256: most tensors fall back to a larger block type.
    const hiddenFallback = m.dims.hidden % 256 !== 0 && t.fallback > bodyBits;
    if (hiddenFallback) bodyBits = t.fallback;
    let extra = 0;
    if (!hiddenFallback && t.downFallback) {
      const d = downParams(m);
      if (m.dims.ffn && m.dims.ffn % 256 !== 0) extra += B(d.dense, t.downFallback);
      if (m.moe && m.moe.ffn % 256 !== 0) extra += B(d.experts, t.downFallback);
    }
    const bodyBytes = B(body - experts, bodyBits) + extra;
    const expertBytes = B(experts, bodyBits);
    const outBytes = B(headParams, t.out);
    const embedBytes = m.dims.tied ? outBytes : B(g.embed, t.embed);
    head = outBytes;
    const onGpu = bodyBytes + outBytes;
    const slack = hiddenFallback ? 0.03 : 0;
    gpu = R(onGpu * (0.985 - slack - groupsSlack), onGpu, onGpu * (1.02 + slack + groupsSlack));
    // Unified memory maps the file once; on a discrete GPU the embedding table stays in RAM.
    const hostBytes = (unified ? 0 : embedBytes) + expertBytes + (lookupHost ? B(g.lookup, bodyBits) : 0);
    if (!lookupHost) gpu = add(gpu, fixed(B(g.lookup, bodyBits)));
    host = fixed(hostBytes);
    formula = `${fmtB(body)} body × ${bodyBits.toFixed(2)} bits (${t.label}${hiddenFallback ? ", hidden size not a multiple of 256" : ""}) + ${fmtB(headParams)} output × ${t.out} bits`;
    if (extra) formula += " + ffn_down fallback";
  } else if (s.format === "mxfp4") {
    const nonExpert = body - g.experts;
    const bytes = B(g.experts, 4.25) + B(nonExpert, 8.5) + B(headParams, 8.5);
    head = B(headParams, 8.5);
    gpu = spread(bytes, 0.99, 1.02);
    host = fixed(unified || m.dims.tied ? 0 : B(g.embed, 8.5));
    formula = `${fmtB(g.experts)} experts × 4.25 bits (MXFP4) + ${fmtB(nonExpert + headParams)} × 8.5 bits (Q8_0)`;
  } else if (s.format in MLX_FORMATS) {
    const bits = MLX_FORMATS[s.format as keyof typeof MLX_FORMATS] + 0.5;
    const bytes = B(body + g.embed + g.head + g.lookup, bits);
    head = B(g.head, bits);
    gpu = spread(bytes, 0.99 - groupsSlack, 1.02 + groupsSlack);
    formula = `${fmtB(body + g.embed + g.head + g.lookup)} × ${bits} bits (group 64, embedding and head included)`;
  } else if (s.format === "native" || (s.format === "bf16" && (m.native.format === "bf16" || m.native.format === "fp16"))) {
    if (s.format === "native" && m.checkpointBytes) {
      // The published checkpoint, minus what isn't loaded. Body bits ≈ the checkpoint's average.
      const ck = m.native.format === "bf16" && m.native.bits > 20 ? m.checkpointBytes / 2 : m.checkpointBytes;
      const avgBits = (8 * ck) / m.params;
      const skipped = B(g.mtp - loadMtp, avgBits) + B(g.vision - loadVision, 16);
      const bytes = Math.max(0, ck - skipped);
      head = B(g.head, 16);
      gpu = spread(bytes, 0.985, 1.03);
      formula = `published checkpoint ${(ck / 1e9).toFixed(1)} GB${skipped > 1e8 ? `, less ${(skipped / 1e9).toFixed(1)} GB of ${[g.mtp - loadMtp ? "MTP" : "", g.vision - loadVision ? "vision" : ""].filter(Boolean).join(" and ")} layers` : ""}`;
    } else {
      const bytes = B(body + g.embed + g.head + g.lookup, 16);
      head = B(g.head, 16);
      gpu = spread(bytes, 0.995 - groupsSlack, 1.005 + groupsSlack);
      formula = `${fmtB(body + g.embed + g.head + g.lookup)} × 16 bits`;
    }
  } else if (s.format in ST_FORMATS || s.format === "custom") {
    const bodyBits = s.format === "custom" ? (s.bpw ?? 4) : ST_FORMATS[s.format as keyof typeof ST_FORMATS].body;
    const bytes = B(body + g.lookup, bodyBits) + B(g.embed + g.head, 16);
    head = B(g.head, 16);
    gpu = spread(bytes, s.format === "custom" ? 0.97 : 0.98 - groupsSlack, s.format === "custom" ? 1.03 : 1.02 + groupsSlack);
    formula = `${fmtB(body + g.lookup)} × ${bodyBits} bits + ${fmtB(g.embed + g.head)} embedding and head × 16 bits`;
  } else {
    throw new Error(`format ${s.format} isn't available on ${s.engine}`);
  }

  // The vision/audio encoder: llama.cpp loads its mmproj at F16; others at the published precision.
  if (loadVision) {
    encoders = B(loadVision, 16);
    gpu = add(gpu, fixed(encoders));
  }
  return { gpu, host, head, encoders, formula };
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
  for (const g of plan.groups) {
    const elems = g.heads * g.headElems;
    const rankElems = g.kind === "latent" ? elems : Math.ceil(g.heads / tp) * g.headElems;
    const tokens = g.kind === "window" ? windowTokens(g.window ?? 0, Boolean(g.chunked)) : fullTokens;
    total += g.layers * elems * tokens * b;
    perRank += g.layers * rankElems * tokens * b;
    if (g.kind !== "window" || tokens === fullTokens) perToken += g.layers * elems * b * seqs;
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

  const g0 = plan.groups[0];
  const formula = g0
    ? g0.kind === "latent"
      ? `${g0.layers} layers × ${g0.headElems} latent dims × ${b.toFixed(b % 1 ? 3 : 0)} B × ${fmtTok(fullTokens)} tokens${plan.groups.length > 1 || plan.indexers.length ? " (+ other layers)" : ""}`
      : `${g0.layers} layers × ${g0.heads} KV heads × ${g0.headElems} (K+V) × ${b.toFixed(b % 1 ? 3 : 0)} B × ${fmtTok(g0.kind === "window" ? windowTokens(g0.window ?? 0, Boolean(g0.chunked)) : fullTokens)} tokens${plan.groups.length > 1 || plan.compressed.length || plan.indexers.length ? " + other layers" : ""}`
    : "no attention cache";
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
  if (w.host.mid) hostItems.push({ label: s.expertsOnHost ? "Embedding table + routed experts" : "Embedding table", bytes: w.host });
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
  if (s.engine !== "llamacpp") return null;
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
