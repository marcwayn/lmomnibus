/**
 * The VRAM Estimator's state: what the URL carries, how it's read and
 * written (readable, defaults omitted), how impossible combinations are
 * corrected, and how state becomes the settings `estimate()` takes. No
 * memory arithmetic here — that all lives in src/core/vram.ts.
 */
import { parseConfig, type Dims, type KvPlan, type MoeLayout, type ParsedConfig } from "../../core/arch.ts";
import { allModels, modelByKey } from "../../core/catalog.ts";
import { DEFAULT_DEVICE_ID, DEVICE_BY_ID, defaultEngine, drivesDisplay, enginesFor, type Device } from "../../core/devices.ts";
import { INDEX_LABEL, type Index } from "../../core/frontier.ts";
import { inputModalities, type Model } from "../../core/model.ts";
import { decodeKey, encodeKey } from "../../core/share.ts";
import {
  defaultFormat,
  ENGINE_LABEL,
  estimate,
  formatLabel,
  formatOptions,
  KV_OPTIONS,
  modelMaxContext,
  VLLM_UTIL,
  type Engine,
  type FormatId,
  type FormatOption,
  type KvDtype,
  type VramModel,
  type VramSettings,
} from "../../core/vram.ts";
import { groupsFromConfig, type NativeFormat, type WeightsRecord } from "../../core/weights.ts";
import { recordFor, vramModelFor, WEIGHTS_AS_OF } from "../../weightsData.ts";
import { formatName } from "./text.ts";

export const MODELS = allModels();
export const OPEN_MODELS = MODELS.filter((m) => m.openWeights);
const RIG_KEY = "lmo:vram-rig:v1";

export type View = "will" | "fit";
export type Count = 1 | 2 | 4 | 8;
export const COUNTS: Count[] = [1, 2, 4, 8];
export type Attn = "gqa" | "swa" | "mla";
export type CustomNative = "bf16" | "fp8" | "mxfp4";

/** A model typed in by hand (or filled from a pasted config.json). Null = not entered yet. */
export interface CustomSpec {
  /** Total parameters, billions. */
  b: number | null;
  layers: number | null;
  hidden: number | null;
  heads: number | null;
  kvh: number | null;
  /** Head dim; null = hidden ÷ heads. */
  hd: number | null;
  vocab: number | null;
  tied: boolean;
  attn: Attn;
  /** Sliding window (tokens) and how many layers keep full attention. */
  win: number | null;
  full: number | null;
  /** MLA latent dims per token: kv_lora_rank + qk_rope_head_dim. */
  lat: number | null;
  ctxmax: number | null;
  nat: CustomNative;
}

export const EMPTY_CUSTOM: CustomSpec = {
  b: null,
  layers: null,
  hidden: null,
  heads: null,
  kvh: null,
  hd: null,
  vocab: null,
  tied: false,
  attn: "gqa",
  win: null,
  full: null,
  lat: null,
  ctxmax: null,
  nat: "bf16",
};

export interface VramState {
  view: View;
  /** Catalog key, or "custom". */
  model: string;
  custom: CustomSpec;
  /** A pasted config.json, parsed in the browser; never in the URL. Used while the fields still match it. */
  pasted: { parsed: ParsedConfig; filled: CustomSpec } | null;
  /** null = the device's usual engine. */
  engine: Engine | null;
  /** null = the engine's default for this model. */
  format: FormatId | null;
  /** "Know the file size?" in decimal GB (or the GGUF-only repo's file). */
  fileGB: number | null;
  bpw: number | null;
  /** Tokens per sequence; null = min(32K, the model's maximum). */
  ctx: number | null;
  seqs: number;
  kv: KvDtype;
  /** Device id, or "custom" with `mem` GiB. */
  device: string;
  mem: number | null;
  count: Count;
  util: number;
  mbt: number | null;
  ub: number;
  fa: boolean;
  swaFull: boolean;
  /** llama.cpp --cpu-moe. */
  cpu: boolean;
  /** null = the engine's default (vLLM loads the encoder of an image model; llama.cpp doesn't). */
  vis: boolean | null;
  mtp: boolean;
  /** Lookup tables in system RAM (llama.cpp). */
  lut: boolean;
  /** null = consumer and workstation cards drive a display. */
  disp: boolean | null;
  macRaised: boolean;
  /** "What fits my hardware?" ranks by this index. */
  index: Index;
}

export const DEFAULT_CTX = 32 * 1024;
const DEFAULT_UB = 512;

/** "What fits my hardware?": the formats it offers per engine, as one list for every model, and the one it starts on. */
export const FIT_FORMATS: Record<Engine, FormatId[]> = {
  llamacpp: ["q8_0", "q6_k", "q5_k_m", "q4_k_m", "iq4_xs", "q3_k_m", "q2_k"],
  vllm: ["native", "fp8", "int8", "int4", "nvfp4"],
  mlx: ["mlx8", "mlx6", "mlx4", "mlx3"],
};
export const FIT_DEFAULT_FORMAT: Record<Engine, FormatId> = { llamacpp: "q4_k_m", vllm: "native", mlx: "mlx4" };

/** The format "What fits my hardware?" ranks with: the one picked, when the engine's list has it. */
export const fitFormat = (s: Pick<VramState, "format">, engine: Engine): FormatId =>
  s.format && FIT_FORMATS[engine].includes(s.format) ? s.format : FIT_DEFAULT_FORMAT[engine];

function initialState(model: string): VramState {
  return {
    view: "will",
    model,
    custom: EMPTY_CUSTOM,
    pasted: null,
    engine: null,
    format: null,
    fileGB: null,
    bpw: null,
    ctx: null,
    seqs: 1,
    kv: "f16",
    device: DEFAULT_DEVICE_ID,
    mem: null,
    count: 1,
    util: VLLM_UTIL,
    mbt: null,
    ub: DEFAULT_UB,
    fa: true,
    swaFull: false,
    cpu: false,
    vis: null,
    mtp: false,
    lut: true,
    disp: null,
    macRaised: false,
    index: "intelligence",
  };
}

// ---------------------------------------------------------------- devices

/** A GPU of a size you type in: treated as a consumer card (drives a display, no NVFP4). */
function customDevice(gib: number): Device {
  return {
    id: "custom",
    name: `Custom GPU (${gib} GiB)`,
    short: `${gib} GiB GPU`,
    vendor: "nvidia",
    cls: "consumer",
    memoryGb: gib,
    usableGiB: gib,
    basis: "custom",
    bandwidthGBs: 0,
    year: 0,
    status: "custom",
    verified: "custom",
    source: "",
  };
}

/** A custom GPU's size until one is typed in. */
const CUSTOM_MEM = 24;

function deviceOf(s: Pick<VramState, "device" | "mem">): Device {
  if (s.device === "custom") return customDevice(s.mem ?? CUSTOM_MEM);
  return DEVICE_BY_ID.get(s.device) ?? DEVICE_BY_ID.get(DEFAULT_DEVICE_ID)!;
}

// ---------------------------------------------------------------- custom models

const NATIVE_BITS: Record<CustomNative, number> = { bf16: 16, fp8: 8.05, mxfp4: 4.6 };
const CUSTOM_CTX = 128 * 1024;

type CustomField = keyof Omit<CustomSpec, "tied" | "attn" | "nat">;

export interface CustomResult {
  model: VramModel | null;
  errors: Partial<Record<CustomField, string>>;
  /** Plausibility warning ("check your numbers"); doesn't block the estimate. */
  warning: string | null;
  /** The pasted config's own layout is in use (and a link can only approximate it). */
  fromPaste: boolean;
}

const sameSpec = (a: CustomSpec, b: CustomSpec) => (Object.keys(a) as (keyof CustomSpec)[]).every((k) => a[k] === b[k]);

/** Parameters the dimensions imply: embeddings, attention, and the FFN (a typical 3.5 × hidden when it isn't known). */
function impliedParams(d: Dims, moe: MoeLayout | null): number {
  const embed = d.vocab * d.hidden * (d.tied ? 1 : 2);
  const attn = d.layers * d.hidden * d.headDim * (2 * d.heads + 2 * d.kvHeads);
  const ffn = d.ffn || 3.5 * d.hidden;
  const moeLayers = moe?.layers ?? 0;
  const dense = (d.layers - moeLayers) * 3 * d.hidden * ffn;
  const experts = moe ? moeLayers * (moe.experts + moe.shared) * moe.mats * moe.inDim * moe.ffn : 0;
  return embed + attn + dense + experts;
}

/** The KV plan the hand-entered fields describe. */
function planFromSpec(c: CustomSpec, layers: number, kvh: number, hd: number): KvPlan {
  const plan: KvPlan = { family: "gqa", confidence: "high", groups: [], compressed: [], indexers: [], state: null, notes: [] };
  if (c.attn === "mla") {
    plan.family = "mla";
    plan.groups.push({ kind: "latent", layers, heads: 1, headElems: c.lat ?? 0 });
  } else if (c.attn === "swa") {
    plan.family = "swa";
    const full = Math.min(layers, c.full ?? 0);
    if (full) plan.groups.push({ kind: "full", layers: full, heads: kvh, headElems: 2 * hd });
    if (layers - full) plan.groups.push({ kind: "window", layers: layers - full, heads: kvh, headElems: 2 * hd, window: c.win ?? 0 });
  } else {
    plan.groups.push({ kind: "full", layers, heads: kvh, headElems: 2 * hd });
  }
  return plan;
}

export function customModel(c: CustomSpec, pasted: VramState["pasted"]): CustomResult {
  const errors: CustomResult["errors"] = {};
  const need = (k: CustomField, label: string) => {
    if (!c[k] || c[k]! <= 0) errors[k] = `Enter ${label}`;
  };
  need("b", "the total parameters (from the model card)");
  need("layers", "the layer count");
  need("hidden", "the hidden size");
  need("heads", "the attention heads");
  need("kvh", "the KV heads");
  need("vocab", "the vocabulary size");
  if (c.attn === "swa") need("win", "the window");
  if (c.attn === "mla") need("lat", "the latent dims");
  if (c.heads && c.kvh && c.heads % c.kvh !== 0) errors.kvh = `${c.heads} attention heads must divide evenly by the KV heads`;
  if (c.attn === "swa" && c.layers && c.full !== null && c.full > c.layers) errors.full = `At most ${c.layers} layers`;
  if (Object.keys(errors).length) return { model: null, errors, warning: null, fromPaste: false };

  const fromPaste = Boolean(pasted && sameSpec(pasted.filled, c));
  const p = fromPaste ? pasted!.parsed : null;
  const params = c.b! * 1e9;
  const layers = c.layers!;
  const hidden = c.hidden!;
  const heads = c.heads!;
  const kvh = c.kvh!;
  const hd = c.hd || Math.floor(hidden / heads);
  const moe = p?.moe ?? null;
  // A hand-entered dense model: the FFN width that makes the parameter total add up.
  const attnPerLayer = hidden * hd * (2 * heads + 2 * kvh);
  const derivedFfn = Math.max(0, (params - c.vocab! * hidden * (c.tied ? 1 : 2)) / layers - attnPerLayer) / (3 * hidden);
  const dims: Dims = p
    ? { ...p.dims, tied: c.tied }
    : { layers, hidden, heads, kvHeads: kvh, headDim: hd, vocab: c.vocab!, tied: c.tied, ffn: Math.round(derivedFfn), mtpLayers: 0 };
  const implied = impliedParams(p ? p.dims : { ...dims, ffn: 0 }, moe);
  const warning =
    Math.abs(implied - params) / params > 0.3
      ? `Check your numbers: these dimensions imply about ${(implied / 1e9).toFixed(1)}B parameters${p ? "" : " with a typical feed-forward width"}, not ${c.b}B.`
      : null;
  const bits = NATIVE_BITS[c.nat];
  const model: VramModel = {
    name: "Custom model",
    params,
    groups: groupsFromConfig(params, dims, moe),
    dims,
    moe,
    kv: p ? p.kv : planFromSpec(c, layers, kvh, hd),
    native: { format: c.nat as NativeFormat, bits },
    checkpointBytes: (params * bits) / 8,
    maxPositions: c.ctxmax ?? p?.maxPositions ?? CUSTOM_CTX,
  };
  return { model, errors: {}, warning, fromPaste };
}

type PasteResult =
  | { ok: true; parsed: ParsedConfig; spec: CustomSpec; report: string }
  | { ok: false; kind: "invalid" | "unrecognized"; report: string };

/** Reads a pasted config.json with the same parser the build uses. Runs in the browser only. */
export function readPastedConfig(text: string, prev: CustomSpec): PasteResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, kind: "invalid", report: `That isn't valid JSON: ${(e as Error).message}` };
  }
  let parsed: ParsedConfig;
  try {
    parsed = parseConfig(json);
  } catch (e) {
    return { ok: false, kind: "unrecognized", report: `Couldn't read this as a model config: ${(e as Error).message}.` };
  }
  const d = parsed.dims;
  const kv = parsed.kv;
  const win = kv.groups.find((g) => g.kind === "window");
  const latent = kv.groups.find((g) => g.kind === "latent");
  const full = kv.groups.filter((g) => g.kind === "full").reduce((a, g) => a + g.layers, 0);
  const attn: Attn = latent ? "mla" : win ? "swa" : "gqa";
  const spec: CustomSpec = {
    ...prev,
    // Keep a parameter total already typed in; otherwise start from what the config implies.
    b: prev.b ?? Math.round(impliedParams(d, parsed.moe) / 1e8) / 10,
    layers: d.layers,
    hidden: d.hidden,
    heads: d.heads || null,
    kvh: d.kvHeads || null,
    hd: d.headDim || null,
    vocab: d.vocab || null,
    tied: d.tied,
    attn,
    win: win?.window ?? null,
    full: attn === "swa" ? full : null,
    lat: latent?.headElems ?? null,
    ctxmax: parsed.maxPositions,
  };
  const parts = [
    `Read ${d.layers} layers`,
    d.heads ? `${d.kvHeads === d.heads ? "MHA" : "GQA"} ${d.heads}/${d.kvHeads}` : null,
    d.headDim ? `head_dim ${d.headDim}` : null,
    latent ? `MLA latent ${latent.headElems}` : null,
    win ? `sliding window ${(win.window ?? 0).toLocaleString("en-US")} on ${win.layers} layers` : latent ? null : "no sliding window",
    parsed.moe ? `MoE, ${parsed.moe.experts} experts, ${parsed.moe.topK} active` : "dense",
    kv.state ? `${kv.state.layers} linear-attention or SSM layers` : null,
    parsed.maxPositions ? `max ${parsed.maxPositions.toLocaleString("en-US")} tokens` : null,
  ].filter(Boolean);
  return { ok: true, parsed, spec, report: parts.join(" · ") };
}

// ---------------------------------------------------------------- the default model

let defaultKey: string | undefined;

/** The best-rated open-weight model that fits one RTX 4090 at Q4_K_M, 32K, F16 KV, llama.cpp, display on. */
export function defaultModelKey(): string {
  if (defaultKey) return defaultKey;
  const device = DEVICE_BY_ID.get(DEFAULT_DEVICE_ID)!;
  const rated = OPEN_MODELS.filter((m) => m.scores?.intelligence != null).sort(
    (a, b) => b.scores!.intelligence! - a.scores!.intelligence!,
  );
  for (const m of rated) {
    const vm = vramModelFor(m);
    if (!vm) continue;
    const opts = formatOptions(vm, "llamacpp", device);
    const format = opts.some((o) => o.id === "q4_k_m") ? "q4_k_m" : defaultFormat(vm, "llamacpp", device);
    const ctx = Math.min(DEFAULT_CTX, modelMaxContext(vm, m.contextTokens));
    const s = baseSettings(device, "llamacpp", format, ctx);
    if (estimate(vm, { ...s, display: true }).verdict === "fits") return (defaultKey = m.key);
  }
  return (defaultKey = OPEN_MODELS.find((m) => vramModelFor(m))?.key ?? OPEN_MODELS[0].key);
}

/** Plain settings for one device (one sequence, F16 KV, engine defaults, headless). */
function baseSettings(device: Device, engine: Engine, format: FormatId, ctx: number): VramSettings {
  return {
    engine,
    format,
    fileBytes: null,
    bpw: null,
    ctx,
    seqs: 1,
    kv: "f16",
    device,
    count: 1,
    util: VLLM_UTIL,
    mbt: null,
    ub: DEFAULT_UB,
    flashAttn: true,
    swaFull: false,
    expertsOnHost: false,
    vision: false,
    mtp: false,
    lookupOnHost: true,
    display: false,
    macRaised: false,
  };
}

// ---------------------------------------------------------------- resolving state

export interface Resolved {
  /** The catalog model (null for a custom one). */
  model: Model | null;
  record: WeightsRecord | null;
  vm: VramModel | null;
  custom: CustomResult | null;
  /** Why there's nothing to estimate. */
  problem: string | null;
  device: Device;
  engine: Engine;
  engines: Engine[];
  formats: FormatOption[];
  /** The format the picker shows. */
  format: FormatId;
  /** The format and file bytes estimate() gets (a file size pins the weights). */
  estFormat: FormatId;
  fileBytes: number | null;
  /** The model's longest context (config or OpenRouter, whichever is larger). */
  maxCtx: number;
  orCtx: number | null;
  ctx: number;
  /** Feature switches that apply to this model and engine. */
  has: { vision: boolean; mtp: boolean; lookup: boolean; moe: boolean; window: boolean };
  settings: VramSettings | null;
}

const isImageModel = (m: Model | null) => Boolean(m && inputModalities(m).includes("image"));

export function resolve(s: VramState): Resolved {
  const device = deviceOf(s);
  const engines = enginesFor(device);
  const engine = s.engine && engines.includes(s.engine) ? s.engine : defaultEngine(device);
  let model: Model | null = null;
  let record: WeightsRecord | null = null;
  let vm: VramModel | null = null;
  let custom: CustomResult | null = null;
  let problem: string | null = null;
  if (s.model === "custom") {
    custom = customModel(s.custom, s.pasted);
    vm = custom.model;
    if (!vm) {
      const started = CUSTOM_NUMS.some((k) => s.custom[k] !== null);
      problem = started
        ? "Check the model's fields: the estimate waits until they're complete and consistent."
        : "Fill in the model's dimensions, or paste its config.json, to see an estimate.";
    }
  } else {
    model = modelByKey(s.model) ?? null;
    record = model ? recordFor(model) : null;
    vm = model ? vramModelFor(model) : null;
    if (model?.weightsStatus === "unverified" || record?.status === "unverified") {
      const by = model?.opennessSource ? "Our hand-checked list" : "OpenRouter";
      // No index entry: the repo hasn't been read yet (a new listing, or a day the Hugging Face read failed).
      problem = model && !model.weights
        ? `${by} links a Hugging Face repo we haven't read yet, so there are no weights to size.`
        : `${by} links a Hugging Face repo we couldn't open on ${record?.checkedOn ?? WEIGHTS_AS_OF}, so there are no weights to size.`;
    } else if (!vm) {
      problem = "We have no architecture record for this model yet, so there's nothing to size.";
    }
  }
  const orCtx = model ? model.contextTokens : null;
  const maxCtx = vm ? modelMaxContext(vm, orCtx) : DEFAULT_CTX;
  const ctx = Math.min(s.ctx ?? DEFAULT_CTX, maxCtx);
  // On vLLM a BF16-native model's "As published" and "BF16" are the same weights: offer one.
  const formats = vm
    ? formatOptions(vm, engine, device).filter((o) => !(engine === "vllm" && o.id === "bf16" && (vm!.native.format === "bf16" || vm!.native.format === "fp16")))
    : [];
  const gguf = Boolean(vm?.ggufFiles?.length);
  const format: FormatId = !vm
    ? "q4_k_m"
    : gguf
      ? "file"
      : s.format === "custom" || formats.some((o) => o.id === s.format && !o.disabled)
        ? s.format!
        : defaultFormat(vm, engine, device);
  let fileBytes = s.fileGB ? Math.round(s.fileGB * 1e9) : null;
  if (gguf && vm) fileBytes = nearestFile(vm, fileBytes).bytes;
  const has = {
    vision: Boolean(vm?.groups.vision),
    mtp: Boolean(vm?.groups.mtp),
    lookup: Boolean(vm?.groups.lookup) && engine === "llamacpp",
    moe: Boolean(vm?.moe) && engine === "llamacpp",
    window: Boolean(vm?.kv.groups.some((g) => g.kind === "window")) && engine === "llamacpp",
  };
  const estFormat: FormatId = fileBytes && format !== "custom" ? "file" : format;
  const settings: VramSettings | null = vm
    ? {
        engine,
        format: estFormat,
        fileBytes,
        bpw: format === "custom" ? (s.bpw ?? 4.5) : null,
        ctx,
        seqs: s.seqs,
        kv: s.kv,
        device,
        count: device.cls === "unified" ? 1 : s.count,
        util: s.util,
        mbt: engine === "vllm" ? s.mbt : null,
        ub: s.ub,
        flashAttn: s.fa,
        swaFull: s.swaFull && has.window,
        expertsOnHost: s.cpu && has.moe,
        vision: has.vision && (s.vis ?? (engine === "vllm" && isImageModel(model))),
        mtp: has.mtp && s.mtp,
        lookupOnHost: s.lut,
        display: device.cls !== "unified" && (s.disp ?? drivesDisplay(device)),
        macRaised: s.macRaised && device.vendor === "apple",
      }
    : null;
  return { model, record, vm, custom, problem, device, engine, engines, formats, format, estFormat, fileBytes, maxCtx, orCtx, ctx, has, settings };
}

/** A GGUF-only repo's file closest to `bytes` (or its first file). */
export function nearestFile(vm: VramModel, bytes: number | null): { name: string; bytes: number } {
  const files = vm.ggufFiles!;
  if (!bytes) return files[0];
  return files.reduce((a, f) => (Math.abs(f.bytes - bytes) < Math.abs(a.bytes - bytes) ? f : a));
}

// ---------------------------------------------------------------- correcting state

/**
 * Corrects a state to the nearest valid one, with a one-line notice for
 * each change a person would want to know about.
 */
export function normalize(input: VramState): { state: VramState; notices: string[] } {
  const s = { ...input };
  const notices: string[] = [];
  if (s.device !== "custom" && !DEVICE_BY_ID.has(s.device)) {
    notices.push(`We don't list a device "${s.device}"; showing the ${DEVICE_BY_ID.get(DEFAULT_DEVICE_ID)!.short}.`);
    s.device = DEFAULT_DEVICE_ID;
  }
  // An empty or invalid custom size stays empty (deviceOf() sizes it at 24 GiB), so a cleared field isn't refilled.
  if (s.device === "custom" && s.mem !== null && !(s.mem > 0)) s.mem = null;
  const device = deviceOf(s);
  if (s.engine && !enginesFor(device).includes(s.engine)) {
    const why = s.engine === "mlx" ? "MLX runs only on Apple silicon" : "vLLM doesn't run on Macs";
    notices.push(`${why}: switched to ${ENGINE_LABEL[defaultEngine(device)]}.`);
    s.engine = null;
  }
  const engine = s.engine ?? defaultEngine(device);
  if (!KV_OPTIONS[engine].some((o) => o.id === s.kv)) {
    notices.push(`${s.kv.toUpperCase()} isn't a KV cache option on ${ENGINE_LABEL[engine]}: using ${KV_OPTIONS[engine][0].label}.`);
    s.kv = "f16";
  }
  if (device.cls === "unified" && s.count !== 1) {
    notices.push("Unified-memory machines count as one device.");
    s.count = 1;
  }
  if (s.model !== "custom") {
    const m = modelByKey(s.model);
    if (!m) {
      const key = defaultModelKey();
      notices.push(`We don't list a model "${s.model}"; showing ${modelByKey(key)!.displayName}.`);
      s.model = key;
    } else if (m.weightsStatus === "closed") {
      const key = defaultModelKey();
      notices.push(`${m.displayName} is API-only (no downloadable weights); showing ${modelByKey(key)!.displayName}.`);
      s.model = key;
    }
  }
  // "What fits my hardware?" fits each listed model on its own terms (FitsView's stateFor): the model
  // behind "Will it fit?" mustn't limit its context, format or GPU count. Back in "Will it fit?" these run.
  if (s.view !== "will") return { state: s, notices };
  const r = resolve(s);
  const vm = r.vm;
  if (vm && engine === "vllm" && s.count > 1 && vm.dims.heads % s.count !== 0) {
    const ok = COUNTS.filter((n) => n <= s.count && vm.dims.heads % n === 0).pop() ?? 1;
    notices.push(`${s.count} GPUs can't split ${vm.dims.heads} attention heads evenly under tensor parallelism: using ${ok}.`);
    s.count = ok;
  }
  if (vm && s.format && s.format !== "custom" && s.format !== "file") {
    const opt = r.formats.find((o) => o.id === s.format);
    if (!opt || opt.disabled) {
      const why = opt?.disabled ?? `${formatLabel(s.format)} isn't offered for this model on ${ENGINE_LABEL[engine]}`;
      notices.push(`${why}: using ${formatName(r.format, vm, r.fileBytes)}.`);
      s.format = null;
    }
  }
  if (s.format === "file" && !vm?.ggufFiles?.length) s.format = null;
  if (vm && s.ctx !== null && s.ctx > r.maxCtx) {
    notices.push(`${r.model?.displayName ?? "This model"} stops at ${r.maxCtx.toLocaleString("en-US")} tokens: context set to that.`);
    s.ctx = r.maxCtx;
  }
  return { state: s, notices };
}

// ---------------------------------------------------------------- the URL

const ENGINES: Engine[] = ["llamacpp", "vllm", "mlx"];
const FORMAT_IDS: FormatId[] = [
  "native", "bf16", "fp8", "int8", "int4", "nvfp4", "mxfp4", "q8_0", "q6_k", "q5_k_m", "q4_k_m", "iq4_xs", "q3_k_m", "q2_k", "iq2_xxs",
  "mlx8", "mlx6", "mlx4", "mlx3", "file", "custom",
];
const KVS: KvDtype[] = ["f16", "q8_0", "q4_0", "fp8", "kv8", "kv4"];
const KV_ALIAS: Record<string, KvDtype> = { auto: "f16", bf16: "f16" };
const INDEXES = Object.keys(INDEX_LABEL) as Index[];
const CUSTOM_NUMS: CustomField[] = ["b", "layers", "hidden", "heads", "kvh", "hd", "vocab", "win", "full", "lat", "ctxmax"];

/** "32k" for whole multiples of 1,024, "1m" for whole multiples of 1,048,576, otherwise the number. */
export function ctxParam(n: number): string {
  if (n > 0 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}m`;
  if (n > 0 && n % 1024 === 0) return `${n / 1024}k`;
  return String(n);
}

const num = (raw: string | null, min: number, max: number, int = true): number | null => {
  if (raw === null || !(int ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw.trim())) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
};
const decimal = (v: number) => String(Math.round(v * 1000) / 1000);

interface Rig {
  dev: string;
  eng: Engine | null;
  mem?: number | null;
}

/** State from the URL; the remembered rig fills in the device and engine only when the URL names no device. */
export function decodeVram(p: URLSearchParams, rig: Rig | null): { state: VramState; notices: string[] } {
  const notices: string[] = [];
  const m = p.get("m");
  const s = initialState(m ? (m === "custom" ? "custom" : decodeKey(m.trim())) : defaultModelKey());
  if (p.get("view") === "fit") s.view = "fit";
  const dev = p.get("dev");
  if (dev) {
    s.device = dev.trim();
    s.mem = num(p.get("mem"), 1, 4096, false);
  } else if (rig && (rig.dev === "custom" || DEVICE_BY_ID.has(rig.dev))) {
    s.device = rig.dev;
    s.mem = rig.mem ?? null;
    if (!p.has("eng") && rig.eng) s.engine = rig.eng;
  }
  const eng = p.get("eng") as Engine | null;
  if (eng) {
    if (ENGINES.includes(eng)) s.engine = eng;
    else notices.push(`Unknown engine "${eng}": using the device's usual one.`);
  }
  const q = p.get("q") as FormatId | null;
  if (q) {
    if (FORMAT_IDS.includes(q)) s.format = q;
    else notices.push(`Unknown weight format "${q}": using the default.`);
  }
  s.fileGB = num(p.get("fsize"), 0.01, 100000, false);
  s.bpw = num(p.get("bpw"), 1, 32, false);
  const ctx = p.get("ctx");
  if (ctx !== null) {
    const m2 = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(ctx);
    if (m2) s.ctx = Math.round(Number(m2[1]) * (m2[2]?.toLowerCase() === "k" ? 1024 : m2[2]?.toLowerCase() === "m" ? 1024 * 1024 : 1));
    else notices.push(`Couldn't read context "${ctx}": using the default.`);
  }
  const seq = num(p.get("seq"), 0, 1e9);
  if (seq !== null) {
    s.seqs = Math.min(Math.max(seq, 1), 256);
    if (seq !== s.seqs) notices.push(`Sequences run from 1 to 256: set to ${s.seqs}.`);
  }
  const kv = p.get("kv");
  if (kv) {
    const k = (KV_ALIAS[kv] ?? kv) as KvDtype;
    if (KVS.includes(k)) s.kv = k;
    else notices.push(`Unknown KV cache type "${kv}": using F16.`);
  }
  const n = num(p.get("n"), 1, 1e9);
  if (n !== null) {
    const c = COUNTS.filter((x) => x <= n).pop() ?? 1;
    if (c !== n) notices.push(`GPU counts are 1, 2, 4 or 8: using ${c}.`);
    s.count = c;
  }
  const util = num(p.get("util"), 0, 1, false);
  if (util !== null) s.util = Math.min(Math.max(util, 0.5), 0.98);
  s.mbt = num(p.get("mbt"), 16, 1 << 20);
  s.ub = num(p.get("ub"), 1, 65536) ?? DEFAULT_UB;
  s.fa = p.get("fa") !== "0";
  s.swaFull = p.get("swafull") === "1";
  s.cpu = p.get("cpu") === "1";
  s.vis = p.get("vis") === "1" ? true : p.get("vis") === "0" ? false : null;
  s.mtp = p.get("mtp") === "1";
  s.lut = p.get("lut") !== "0";
  s.disp = p.get("disp") === "1" ? true : p.get("disp") === "0" ? false : null;
  s.macRaised = p.get("mac") === "raised";
  const y = p.get("y") as Index | null;
  if (y && INDEXES.includes(y)) s.index = y;
  if (s.model === "custom") {
    const c: CustomSpec = { ...EMPTY_CUSTOM };
    for (const k of CUSTOM_NUMS) c[k] = num(p.get(k), 0, 1e12, k !== "b");
    c.tied = p.get("tied") === "1";
    const attn = p.get("attn");
    c.attn = attn === "mla" || attn === "swa" ? attn : "gqa";
    const nat = p.get("nat");
    c.nat = nat === "fp8" || nat === "mxfp4" ? nat : "bf16";
    s.custom = c;
  }
  const out = normalize(s);
  return { state: out.state, notices: [...notices, ...out.notices] };
}

/**
 * The readable URL for a state, defaults omitted. Never URLSearchParams.toString(): it escapes ":" and ",".
 * `share` keeps the model and device even when they're the defaults, so a copied link doesn't follow the
 * recipient's remembered rig or a later snapshot's default model.
 */
export function encodeVram(s: VramState, r: Resolved, share = false): string {
  const parts: string[] = [];
  const put = (k: string, v: string | number) => parts.push(`${k}=${encodeURIComponent(String(v)).replace(/%3A/gi, ":").replace(/%2C/gi, ",")}`);
  const fit = s.view === "fit";
  if (fit) put("view", "fit");
  if (share || s.model !== defaultModelKey()) put("m", s.model === "custom" ? "custom" : encodeKey(s.model));
  if (s.model === "custom") {
    const c = s.custom;
    for (const k of CUSTOM_NUMS) if (c[k] !== null) put(k, decimal(c[k]!));
    if (c.tied) put("tied", 1);
    if (c.attn !== "gqa") put("attn", c.attn);
    if (c.nat !== "bf16") put("nat", c.nat);
  }
  if (s.engine && s.engine !== defaultEngine(r.device)) put("eng", s.engine);
  if (fit) {
    // The fit view's own format list and default, whatever the model behind "Will it fit?" offers.
    if (fitFormat(s, r.engine) !== FIT_DEFAULT_FORMAT[r.engine]) put("q", fitFormat(s, r.engine));
  } else {
    const defFormat = r.vm && !r.vm.ggufFiles?.length ? defaultFormat(r.vm, r.engine, r.device) : null;
    if (s.format && s.format !== defFormat && !(r.vm?.ggufFiles?.length)) put("q", s.format);
  }
  if (r.vm?.ggufFiles?.length && r.fileBytes && r.fileBytes !== r.vm.ggufFiles[0].bytes) put("fsize", decimal(r.fileBytes / 1e9));
  else if (s.fileGB && !r.vm?.ggufFiles?.length) put("fsize", decimal(s.fileGB));
  if (s.format === "custom" && s.bpw !== null) put("bpw", decimal(s.bpw));
  if (s.ctx !== null && s.ctx !== (fit ? DEFAULT_CTX : Math.min(DEFAULT_CTX, r.maxCtx))) put("ctx", ctxParam(s.ctx));
  if (s.seqs !== 1) put("seq", s.seqs);
  if (s.kv !== "f16") put("kv", s.kv);
  if (share || s.device !== DEFAULT_DEVICE_ID) put("dev", s.device);
  if (s.device === "custom" && (s.mem || share)) put("mem", decimal(s.mem ?? CUSTOM_MEM));
  if (s.count !== 1) put("n", s.count);
  if (s.util !== VLLM_UTIL) put("util", decimal(s.util));
  if (s.mbt !== null) put("mbt", s.mbt);
  if (s.ub !== DEFAULT_UB) put("ub", s.ub);
  if (!s.fa) put("fa", 0);
  if (s.swaFull) put("swafull", 1);
  if (s.cpu) put("cpu", 1);
  if (s.vis !== null) put("vis", s.vis ? 1 : 0);
  if (s.mtp) put("mtp", 1);
  if (!s.lut) put("lut", 0);
  if (s.disp !== null) put("disp", s.disp ? 1 : 0);
  if (s.macRaised) put("mac", "raised");
  if (s.index !== "intelligence") put("y", s.index);
  return parts.join("&");
}

export function readRig(): Rig | null {
  try {
    const raw = localStorage.getItem(RIG_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Rig;
    return typeof v?.dev === "string" ? v : null;
  } catch {
    return null;
  }
}

export function writeRig(rig: Rig) {
  try {
    localStorage.setItem(RIG_KEY, JSON.stringify(rig));
  } catch {
    // Private mode or storage blocked: the URL still carries the rig.
  }
}
