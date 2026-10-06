/**
 * Model architecture from a Hugging Face config.json: the dimensions, the
 * MoE layout, and a KV plan — what each layer caches per token or per
 * sequence. Shared by scripts/hf.ts (build time) and the VRAM Estimator's
 * "paste a config" box, so one parser decides both.
 *
 * Ported from the 2026-10-06 architecture audit, which checked these rules
 * against every open-weight model's config and against engine memory logs.
 * Config traps it handles: nested text configs, per-layer lists longer than
 * the model (MTP entries), sliding-window fields that are switched off,
 * explicit head_dim that isn't hidden/heads, 1- vs 0-based layer lists.
 */

export type Cfg = Record<string, unknown>;

/** A run of layers that cache the same thing for every token they keep. */
export interface KvGroup {
  kind: "full" | "window" | "latent";
  layers: number;
  /** KV heads per layer (tensor parallelism shards these); 1 for a latent cache. */
  heads: number;
  /** Elements per head per token, K and V together (2 × head_dim, 192 + 128, or one K=V tensor). */
  headElems: number;
  /** Tokens a window layer keeps. */
  window?: number;
  /** Chunked local attention (Llama 4) rather than a sliding window. */
  chunked?: boolean;
  /** K doubles as V (Gemma 4 global layers): one tensor here, but vLLM stores both. */
  kEqV?: boolean;
  /** Latent groups: how many of `headElems` are the RoPE part (kept at 16 bits in vLLM's FP8 MLA layout). */
  rope?: number;
}

/** DeepSeek-V4-style compressed cache: ctx / ratio entries of `elems` per layer. */
export interface CompressedGroup {
  layers: number;
  ratio: number;
  elems: number;
}

/** Sparse-attention index keys per token: fp8 = one fp8 key plus a 4-byte scale, independent of the KV dtype. */
export interface IndexerGroup {
  layers: number;
  ratio: number;
  elems: number;
  fp8: boolean;
}

/** Recurrent state per sequence, summed over layers (Mamba, DeltaNet, KDA, lightning, short conv). */
export interface StatePlan {
  layers: number;
  convElems: number;
  ssmElems: number;
  /** The SSM state is kept in fp32 (most configs); otherwise in the model dtype. */
  ssmFp32: boolean;
}

export type KvFamily =
  | "gqa"
  | "swa"
  | "swa-hetero"
  | "chunked"
  | "mla"
  | "mla-indexer"
  | "longcat"
  | "dsv4"
  | "dsv41"
  | "deltanet"
  | "kda-mla"
  | "kda-mla-indexer"
  | "lightning"
  | "mamba2"
  | "shortconv"
  | "gqa-sparse-index";

export const KV_FAMILY_LABEL: Record<KvFamily, string> = {
  gqa: "standard attention (GQA/MHA)",
  swa: "sliding-window + full attention",
  "swa-hetero": "sliding-window + full attention (different head shapes)",
  chunked: "chunked local + global attention",
  mla: "multi-head latent attention (MLA)",
  "mla-indexer": "MLA + sparse-attention indexer",
  longcat: "MLA + indexer, two attention blocks per layer",
  dsv4: "compressed sparse attention (DeepSeek-V4)",
  dsv41: "shared compressed attention (DeepSeek-V4.1)",
  deltanet: "Gated DeltaNet linear attention + full attention",
  "kda-mla": "KDA linear attention + MLA",
  "kda-mla-indexer": "KDA linear attention + MLA with indexer",
  lightning: "lightning linear attention + full attention",
  mamba2: "Mamba-2 + attention hybrid",
  shortconv: "short convolution + attention hybrid",
  "gqa-sparse-index": "attention + block-sparse index",
};

export interface KvPlan {
  family: KvFamily;
  confidence: "high" | "medium" | "low";
  groups: KvGroup[];
  compressed: CompressedGroup[];
  indexers: IndexerGroup[];
  state: StatePlan | null;
  notes: string[];
}

export interface MoeLayout {
  /** Total routed-expert parameters when the config describes more than one expert group (ERNIE-VL). */
  expertParams?: number;
  experts: number;
  topK: number;
  shared: number;
  /** Layers with routed experts. */
  layers: number;
  /** Width of one expert's FFN. */
  ffn: number;
  /** Input width of an expert (Kimi K3 "latent MoE" uses a narrower one). */
  inDim: number;
  /** Weight matrices per expert: 3 (gate, up, down) or 2 (relu² experts). */
  mats: number;
}

export interface Dims {
  layers: number;
  hidden: number;
  heads: number;
  kvHeads: number;
  headDim: number;
  vocab: number;
  tied: boolean;
  /** Dense FFN width (0 when unknown). */
  ffn: number;
  mtpLayers: number;
}

export interface ParsedConfig {
  modelType: string | null;
  dims: Dims;
  moe: MoeLayout | null;
  kv: KvPlan;
  maxPositions: number | null;
  rope: { type: string; factor: number } | null;
}

// ---------------------------------------------------------------- helpers

const isObj = (v: unknown): v is Cfg => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** First present numeric field. */
function g(t: Cfg, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = num(t[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function req(t: Cfg, key: string): number {
  const v = num(t[key]);
  if (v === undefined) throw new Error(`config has no ${key}`);
  return v;
}

const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

const NEST = ["text_config", "llm_config", "language_config"] as const;

/** The language model's config: a nested text config laid over the top level's scalars. */
export function mergeTextConfig(cfg: Cfg): { t: Cfg; nested: boolean } {
  for (const k of NEST) {
    const inner = cfg[k];
    if (isObj(inner)) {
      const top = Object.fromEntries(Object.entries(cfg).filter(([, v]) => !isObj(v)));
      return { t: { ...top, ...inner }, nested: true };
    }
  }
  const thinker = cfg.thinker_config;
  if (isObj(thinker) && isObj(thinker.text_config)) return { t: { ...cfg, ...thinker.text_config }, nested: true };
  return { t: cfg, nested: false };
}

function layerCount(t: Cfg): number {
  const n = g(t, "num_hidden_layers", "num_layers", "n_layers", "n_layer");
  if (n !== undefined) return n;
  const lbt = list(t.layers_block_type);
  if (lbt) return lbt.length;
  if (typeof t.hybrid_override_pattern === "string") return t.hybrid_override_pattern.length;
  throw new Error("config has no layer count");
}

function headDimOf(t: Cfg): number {
  const hd = g(t, "head_dim", "attention_head_dim");
  if (hd) return hd;
  return Math.floor(req(t, "hidden_size") / req(t, "num_attention_heads"));
}

function kvHeadsOf(t: Cfg): number {
  return g(t, "num_key_value_heads", "num_query_groups", "num_attention_groups", "num_kv_heads", "multi_query_group_num") ?? req(t, "num_attention_heads");
}

/** The model type the KV rules dispatch on (the text config's own type wins, with a few family aliases). */
function dispatchType(cfg: Cfg, t: Cfg, nested: boolean): string | null {
  const base = typeof cfg.model_type === "string" ? cfg.model_type : null;
  let mt = nested ? (typeof t.model_type === "string" ? t.model_type : base) : base;
  if (mt === "mistral4") mt = "deepseek_v3";
  if (mt === "kimi_linear" || base === "kimi_k3") mt = "kimi_k3";
  for (const b of ["deepseek_v41", "glm5_next", "qwen4_exp", "mimo_v2", "minimax_m3_vl", "inkling_mm_model", "bailing_moe_v3_vl", "llama4"]) {
    if (base === b) mt = b;
  }
  if (base === "NemotronH_Nano_Omni_Reasoning_V3") mt = "nemotron_h";
  if (base === "gemma3" && (mt === "gemma3_text" || mt === null)) mt = "gemma3";
  return mt;
}

// ---------------------------------------------------------------- KV plan

class PlanBuilder {
  groups: KvGroup[] = [];
  compressed: CompressedGroup[] = [];
  indexers: IndexerGroup[] = [];
  state: StatePlan | null = null;
  notes: string[] = [];
  confidence: KvPlan["confidence"] = "high";
  full(layers: number, heads: number, headElems: number) {
    if (layers > 0) this.groups.push({ kind: "full", layers, heads, headElems });
  }
  latent(layers: number, elems: number, rope = 0) {
    if (layers > 0) this.groups.push({ kind: "latent", layers, heads: 1, headElems: elems, ...(rope ? { rope } : {}) });
  }
  window(layers: number, heads: number, headElems: number, window: number, chunked = false) {
    if (layers > 0) this.groups.push({ kind: "window", layers, heads, headElems, window, ...(chunked ? { chunked } : {}) });
  }
  addState(layers: number, convElems: number, ssmElems: number, ssmFp32: boolean) {
    if (layers <= 0) return;
    const s = this.state ?? { layers: 0, convElems: 0, ssmElems: 0, ssmFp32 };
    this.state = { layers: s.layers + layers, convElems: s.convElems + layers * convElems, ssmElems: s.ssmElems + layers * ssmElems, ssmFp32 };
  }
  build(family: KvFamily): KvPlan {
    return {
      family,
      confidence: this.confidence,
      groups: this.groups,
      compressed: this.compressed,
      indexers: this.indexers,
      state: this.state,
      notes: this.notes,
    };
  }
}

const mlaElems = (t: Cfg) => req(t, "kv_lora_rank") + (g(t, "qk_rope_head_dim") ?? 0);
const mlaRope = (t: Cfg) => g(t, "qk_rope_head_dim") ?? 0;

/** Gated DeltaNet per layer: conv over q, k, v (model dtype) and the recurrent state (fp32 unless stated). */
function gdn(t: Cfg): [conv: number, ssm: number, fp32: boolean] {
  const nk = req(t, "linear_num_key_heads");
  const nv = req(t, "linear_num_value_heads");
  const dk = req(t, "linear_key_head_dim");
  const dv = req(t, "linear_value_head_dim");
  const kc = g(t, "linear_conv_kernel_dim") ?? 4;
  const fp32 = String(t.mamba_ssm_dtype ?? "float32") === "float32";
  return [(kc - 1) * (2 * nk * dk + nv * dv), nv * dk * dv, fp32];
}

/** Kimi Delta Attention per layer: fp32 state heads × d × d, plus q/k/v short-conv state. */
const kda = (heads: number, d: number, kc = 4): [number, number] => [(kc - 1) * 3 * heads * d, heads * d * d];

function mamba2(heads: number, headDim: number, dState: number, dConv: number, groups: number): [number, number] {
  return [(dConv - 1) * (heads * headDim + 2 * groups * dState), heads * headDim * dState];
}

export function planKv(cfg: Cfg): KvPlan {
  const { t, nested } = mergeTextConfig(cfg);
  const mt = dispatchType(cfg, t, nested);
  const n = layerCount(t);
  const p = new PlanBuilder();
  const lt = list(t.layer_types)?.slice(0, n) as string[] | undefined;
  const count = (xs: readonly unknown[], v: unknown) => xs.filter((x) => x === v).length;

  // DeepSeek-V4: every layer keeps a raw window; compressed layers add ctx/ratio latents,
  // ratio-4 layers also keep ctx/4 indexer keys.
  if (mt === "deepseek_v4") {
    const hd = req(t, "head_dim");
    const w = g(t, "sliding_window") ?? 128;
    const ratios = (list(t.compress_ratios) ?? []).slice(0, n) as number[];
    p.window(ratios.length, 1, hd, w);
    const byRatio = new Map<number, number>();
    for (const r of ratios) if (r > 0) byRatio.set(r, (byRatio.get(r) ?? 0) + 1);
    for (const [r, k] of byRatio) {
      p.compressed.push({ layers: k, ratio: r, elems: hd });
      if (r === 4) p.indexers.push({ layers: k, ratio: 4, elems: req(t, "index_head_dim"), fp8: false });
    }
    p.notes.push("Compressed sparse attention: a 128-token window on every layer plus context ÷ ratio compressed entries; layout from DeepSeek's reference code.");
    p.confidence = "medium";
    return p.build("dsv4");
  }
  if (mt === "deepseek_v41" || mt === "deepseek_v41_text") {
    const hd = req(t, "head_dim");
    const w = g(t, "sliding_window") ?? 128;
    const ratios = (list(t.compress_ratios) ?? []).slice(0, n) as number[];
    p.window(n, 1, hd, w);
    const byRatio = new Map<number, number>();
    for (const i of (list(t.kv_source_layer_ids) ?? []) as number[]) byRatio.set(ratios[i], (byRatio.get(ratios[i]) ?? 0) + 1);
    for (const [r, k] of byRatio) {
      p.compressed.push({ layers: k, ratio: r, elems: hd });
      p.indexers.push({ layers: k, ratio: r, elems: req(t, "index_head_dim"), fp8: false });
    }
    p.notes.push("Only the kv_source layers own a compressed cache; the other layers read theirs. Engram lookup tables can sit in system RAM.");
    p.confidence = "medium";
    return p.build("dsv41");
  }

  // Hybrid linear attention.
  if (mt && ["qwen3_next", "qwen3_5", "qwen3_5_text", "qwen3_5_moe", "qwen3_5_moe_text", "qwen4_exp", "qwen4_exp_text"].includes(mt)) {
    let types = lt;
    if (!types) {
      const k = req(t, "full_attention_interval");
      types = Array.from({ length: n }, (_, i) => ((i + 1) % k === 0 ? "full_attention" : "linear_attention"));
    }
    const nf = count(types, "full_attention");
    const nl = count(types, "linear_attention");
    p.full(nf, kvHeadsOf(t), 2 * headDimOf(t));
    const [conv, ssm, fp32] = gdn(t);
    p.addState(nl, conv, ssm, fp32);
    if (mt.startsWith("qwen4_exp")) {
      p.indexers.push({ layers: nf, ratio: g(t, "indexer_compress_ratio") ?? 4, elems: (g(t, "indexer_kv_heads") ?? 1) * req(t, "indexer_head_dim"), fp8: false });
      p.notes.push("Full-attention layers also keep a compressed indexer cache; the n-gram tables are lookup-only.");
      p.confidence = "medium";
    }
    return p.build("deltanet");
  }
  if (mt === "minimax_text_01") {
    const atl = (list(t.attn_type_list) ?? []).slice(0, n);
    const hd = headDimOf(t);
    p.full(count(atl, 1), kvHeadsOf(t), 2 * hd);
    const heads = req(t, "num_attention_heads");
    p.addState(count(atl, 0), 0, heads * hd * hd, true);
    return p.build("lightning");
  }
  if (mt === "kimi_k3") {
    const lac = t.linear_attn_config as Cfg;
    const kdaLayers = new Set((list(lac.kda_layers) ?? []) as number[]);
    // Kimi lists are 1-based; a list whose largest entry is n can't be 0-based.
    const oneBased = Math.max(...kdaLayers, ...((list(lac.full_attn_layers) ?? []) as number[])) >= n;
    const isKda = (i: number) => kdaLayers.has(oneBased ? i + 1 : i);
    const nk = Array.from({ length: n }, (_, i) => i).filter(isKda).length;
    p.latent(n - nk, mlaElems(t));
    const [conv, ssm] = kda(req(lac, "num_heads"), req(lac, "head_dim"), g(lac, "short_conv_kernel_size") ?? 4);
    p.addState(nk, conv, ssm, true);
    return p.build("kda-mla");
  }
  if (mt === "glm5_next" || mt === "glm5_next_text") {
    const lac = t.linear_attn_config as Cfg;
    const kdaLayers = (list(lac.kda_layers) ?? []) as number[];
    const fullLayers = (list(lac.full_attn_layers) ?? []) as number[];
    p.latent(fullLayers.length, mlaElems(t), mlaRope(t));
    const types = (list(t.indexer_types) as string[] | null) ?? Array<string>(n).fill("full");
    const own = fullLayers.filter((i) => types[i] === "full").length;
    const kpool = t.index_kpool_compress ? (g(t, "index_kpool") ?? 1) : 1;
    p.indexers.push({ layers: own, ratio: kpool, elems: req(t, "index_head_dim"), fp8: true });
    const [conv, ssm] = kda(req(lac, "num_heads"), req(lac, "head_dim"), g(lac, "short_conv_kernel_size") ?? 4);
    p.addState(kdaLayers.length, conv, ssm, true);
    p.notes.push("Layer lists are 0-based here; indexer keys pooled by index_kpool. No engine has published its allocation for this layout yet.");
    p.confidence = "medium";
    return p.build("kda-mla-indexer");
  }
  if (mt === "bailing_hybrid" || mt === "bailing_moe_v3_vl" || mt === "bailing_moe_v3") {
    const gsz = req(t, "layer_group_size");
    const tail = Math.floor(n / gsz) * gsz;
    const att = Array.from({ length: n }, (_, i) => i).filter((i) => (i + 1) % gsz === 0 || i >= tail).length;
    p.latent(att, mlaElems(t));
    const [conv, ssm] = kda(req(t, "num_attention_heads"), req(t, "head_dim"), g(t, "short_conv_kernel_size") ?? 4);
    p.addState(n - att, conv, ssm, true);
    return p.build("kda-mla");
  }
  if (mt === "lfm2" && lt) {
    p.full(count(lt, "full_attention"), kvHeadsOf(t), 2 * headDimOf(t));
    p.addState(count(lt, "conv"), (g(t, "conv_L_cache") ?? 3) * req(t, "hidden_size"), 0, false);
    return p.build("shortconv");
  }

  // Mamba hybrids.
  if (mt === "nemotron_h" || typeof t.hybrid_override_pattern === "string") {
    const pat =
      typeof t.hybrid_override_pattern === "string"
        ? t.hybrid_override_pattern.slice(0, n)
        : ((list(t.layers_block_type) ?? []) as string[])
            .slice(0, n)
            .map((x) => ({ mamba: "M", attention: "*", moe: "E", mlp: "-" })[x] ?? "?")
            .join("");
    p.full([...pat].filter((c) => c === "*").length, kvHeadsOf(t), 2 * headDimOf(t));
    const fp32 = String(t.mamba_ssm_cache_dtype ?? "float32") === "float32";
    const [conv, ssm] = mamba2(req(t, "mamba_num_heads"), req(t, "mamba_head_dim"), req(t, "ssm_state_size"), req(t, "conv_kernel"), req(t, "n_groups"));
    p.addState([...pat].filter((c) => c === "M").length, conv, ssm, fp32);
    return p.build("mamba2");
  }
  if (mt === "granitemoehybrid" && lt) {
    p.full(count(lt, "attention"), kvHeadsOf(t), 2 * headDimOf(t));
    const [conv, ssm] = mamba2(req(t, "mamba_n_heads"), req(t, "mamba_d_head"), req(t, "mamba_d_state"), req(t, "mamba_d_conv"), req(t, "mamba_n_groups"));
    p.addState(count(lt, "mamba"), conv, ssm, false);
    p.notes.push("Mamba state assumed in the model dtype (vLLM's default for Granite).");
    return p.build("mamba2");
  }

  // Multi-head latent attention.
  if (mt === null && t.attention_method === "MLA") {
    // LongCat: two MLA blocks per layer; only the first has an indexer.
    p.latent(2 * n, mlaElems(t), mlaRope(t));
    p.indexers.push({ layers: n, ratio: 1, elems: req(t, "index_head_dim"), fp8: true });
    p.notes.push("Two attention blocks per layer (from the weight names); the config has no model_type.");
    p.confidence = "medium";
    return p.build("longcat");
  }
  if (num(t.kv_lora_rank) && t.use_mla !== false && mt !== "hunyuan_v1_moe") {
    p.latent(n, mlaElems(t), mlaRope(t));
    if (num(t.index_head_dim) && num(t.index_n_heads)) {
      const it = list(t.indexer_types) as string[] | null;
      const own = it ? count(it.slice(0, n), "full") : n;
      p.indexers.push({ layers: own, ratio: 1, elems: req(t, "index_head_dim"), fp8: true });
      if (mt === "hy_v4") p.confidence = "medium";
      return p.build("mla-indexer");
    }
    return p.build("mla");
  }

  // Full, sliding and chunked attention.
  const kvh = kvHeadsOf(t);
  const hd = headDimOf(t);
  if (mt === "llama4" || mt === "llama4_text") {
    const cs = g(t, "attention_chunk_size");
    const nr = list(t.no_rope_layers) as number[] | null;
    if (cs && nr) {
      const global = nr.slice(0, n).filter((x) => x === 0).length;
      p.full(global, kvh, 2 * hd);
      p.window(n - global, kvh, 2 * hd, cs, true);
      p.notes.push("RoPE layers attend within 8,192-token chunks; every fourth (NoPE) layer is global.");
      return p.build("chunked");
    }
    p.full(n, kvh, 2 * hd);
    return p.build("gqa");
  }
  if (mt === "gemma2") {
    p.window(Math.ceil(n / 2), kvh, 2 * hd, g(t, "sliding_window") ?? 4096);
    p.full(Math.floor(n / 2), kvh, 2 * hd);
    return p.build("swa");
  }
  if (mt === "cohere2" && !lt) {
    const k = g(t, "sliding_window_pattern") ?? 4;
    const nf = Math.floor(n / k);
    p.window(n - nf, kvh, 2 * hd, req(t, "sliding_window"));
    p.full(nf, kvh, 2 * hd);
    return p.build("swa");
  }
  if (mt === "mimo_v2") {
    const pat = ((list(t.hybrid_layer_pattern) ?? []) as number[]).slice(0, n);
    const w = g(t, "sliding_window_size", "sliding_window") ?? 0;
    p.full(count(pat, 0), req(t, "num_key_value_heads"), req(t, "head_dim") + req(t, "v_head_dim"));
    p.window(count(pat, 1), req(t, "swa_num_key_value_heads"), req(t, "swa_head_dim") + req(t, "swa_v_head_dim"), w);
    p.notes.push("K and V heads differ in size, and the sliding layers have their own head counts.");
    return p.build("swa-hetero");
  }
  if (mt === "inkling_mm_model") {
    const loc = new Set((list(t.local_layer_ids) ?? []) as number[]);
    const ns = Array.from({ length: n }, (_, i) => i).filter((i) => loc.has(i)).length;
    p.full(n - ns, kvh, 2 * hd);
    p.window(ns, req(t, "swa_num_key_value_heads"), 2 * req(t, "swa_head_dim"), req(t, "sliding_window_size"));
    p.notes.push("local_layer_ids lists the sliding-window layers; no public modeling code to confirm the layout.");
    p.confidence = "medium";
    return p.build("swa-hetero");
  }
  if (lt && lt.includes("sliding_attention")) {
    const nf = count(lt, "full_attention");
    const ns = count(lt, "sliding_attention");
    const w = req(t, "sliding_window");
    if (mt === "gemma4" || mt === "gemma4_text") {
      const kEqV = t.attention_k_eq_v === true;
      p.full(nf, req(t, "num_global_key_value_heads"), req(t, "global_head_dim") * (kEqV ? 1 : 2));
      if (kEqV) p.groups[p.groups.length - 1].kEqV = true;
      p.window(ns, kvh, 2 * hd, w);
      p.notes.push("Global layers reuse K as V (one tensor cached); an engine that stores V separately doubles the global cache.");
      if (num(t.num_kv_shared_layers)) p.notes.push("The last layers share KV with earlier ones.");
      p.confidence = "medium";
      return p.build("swa-hetero");
    }
    if (mt === "step3p5" || mt === "step3p7") {
      const o = isObj(t.attention_other_setting) ? t.attention_other_setting : {};
      p.full(nf, req(t, "num_attention_groups"), 2 * hd);
      p.window(ns, g(o, "num_attention_groups") ?? req(t, "num_attention_groups"), 2 * (g(o, "head_dim") ?? hd), w);
      return p.build("swa");
    }
    p.full(nf, kvh, 2 * hd);
    p.window(ns, kvh, 2 * hd, w);
    return p.build("swa");
  }
  if (mt === "gemma3" || mt === "gemma3_text") {
    const k = g(t, "sliding_window_pattern", "_sliding_window_pattern") ?? 6;
    const nf = Math.floor(n / k);
    p.window(n - nf, kvh, 2 * hd, req(t, "sliding_window"));
    p.full(nf, kvh, 2 * hd);
    return p.build("swa");
  }
  if (mt === "minimax_m3_vl") {
    const sac = isObj(t.sparse_attention_config) ? t.sparse_attention_config : {};
    p.full(n, kvh, 2 * hd);
    const sparse = ((list(sac.sparse_attention_freq) ?? []) as number[]).slice(0, n).reduce((a, b) => a + b, 0);
    p.indexers.push({ layers: sparse, ratio: 1, elems: (g(sac, "sparse_num_index_heads") ?? 0) * (g(sac, "sparse_index_dim") ?? 0), fp8: false });
    p.notes.push("Block-sparse attention keeps the full cache; the index-key cache size is assumed (no modeling code published).");
    p.confidence = "low";
    return p.build("gqa-sparse-index");
  }

  // Plain attention, all layers sliding when the config says so.
  const sw = g(t, "sliding_window");
  const usw = t.use_sliding_window;
  const maxPos = g(t, "max_position_embeddings") ?? 0;
  if (sw && (usw === true || (usw === undefined && mt !== null && ["mistral", "mixtral", "phi3"].includes(mt) && sw < maxPos))) {
    p.window(n, kvh, 2 * hd, sw);
    p.notes.push("Every layer uses a sliding window.");
    return p.build("swa");
  }
  p.full(n, kvh, 2 * hd);
  return p.build("gqa");
}

// ---------------------------------------------------------------- dims & MoE

export function moeOf(cfg: Cfg): MoeLayout | null {
  const { t, nested } = mergeTextConfig(cfg);
  const mt = dispatchType(cfg, t, nested);
  const pick = (v: unknown) => (Array.isArray(v) ? num(v[0]) : num(v));
  const E = pick(t.num_experts ?? t.n_routed_experts ?? t.num_local_experts ?? t.moe_num_experts);
  const k = pick(t.num_experts_per_tok ?? t.moe_top_k ?? t.moe_k ?? t.experts_per_token ?? t.num_experts_per_token ?? t.top_k_experts ?? t.moe_topk);
  if (!E || !k || E <= 1) return null;
  const n = layerCount(t);
  const d = req(t, "hidden_size");
  let ffn = pick(t.moe_intermediate_size ?? t.expert_ffn_hidden_size ?? t.expert_intermediate_size) ?? 0;
  if (mt && ["mixtral", "minimax_m2", "minimax_text_01", "gpt_oss", "llama4", "llama4_text", "granitemoehybrid", "minimax_m3_vl", "inkling_mm_model"].includes(mt)) {
    ffn = num(t.intermediate_size) ?? ffn;
  }
  let mats = 3;
  let inDim = d;
  if (mt === "nemotron_h") {
    mats = 2;
    inDim = g(t, "moe_latent_size") ?? d;
  }
  if (mt === "kimi_k3") inDim = g(t, "routed_expert_hidden_size") ?? d;
  let layers = n;
  const lbt = list(t.layers_block_type) as string[] | null;
  const mlt = list(t.mlp_layer_types) as string[] | null;
  if (typeof t.hybrid_override_pattern === "string") layers = [...t.hybrid_override_pattern.slice(0, n)].filter((c) => c === "E").length;
  else if (lbt && lbt.includes("moe")) layers = lbt.slice(0, n).filter((x) => x === "moe").length;
  else if (mlt) layers = mlt.slice(0, n).filter((x) => x === "sparse").length;
  else if (list(t.moe_layer_freq)) layers = ((t.moe_layer_freq as number[]).slice(0, n)).reduce((a, b) => a + b, 0);
  else if (typeof t.moe_layers_enum === "string") layers = t.moe_layers_enum.split(",").length;
  else if (mt === "llama4" || mt === "llama4_text") layers = Math.floor(n / (g(t, "interleave_moe_layer_step") ?? 1));
  else if (list(t.moe_layer_start_index) || num(t.moe_layer_start_index) !== undefined) {
    // ERNIE: experts on layers start..end every `interval` (lists hold one entry per expert group).
    const first = (v: unknown) => (Array.isArray(v) ? num(v[0]) : num(v));
    const start = first(t.moe_layer_start_index) ?? 0;
    const end = Math.min(first(t.moe_layer_end_index) ?? n - 1, n - 1);
    layers = Math.floor((end - start) / (first(t.moe_layer_interval) ?? 1)) + 1;
  } else if (mt === "afmoe") layers = n - (g(t, "num_dense_layers") ?? 0);
  else if (list(t.mlp_only_layers)) layers = n - (t.mlp_only_layers as unknown[]).length;
  else if (num(t.first_k_dense_replace) !== undefined) layers = n - (num(t.first_k_dense_replace) ?? 0);
  const shared = pick(t.n_shared_experts ?? t.num_shared_experts ?? t.shared_expert_count) ?? (num(t.shared_expert_intermediate_size) ? 1 : 0);
  // Several expert groups (ERNIE-VL: text and vision experts with their own widths).
  const Es = list(t.moe_num_experts) as number[] | null;
  const Fs = list(t.moe_intermediate_size) as number[] | null;
  const expertParams = Es && Fs && Es.length > 1 && Fs.length === Es.length ? layers * Es.reduce((a, e, i) => a + e * mats * inDim * Fs[i], 0) : undefined;
  return { experts: E, topK: k, shared, layers, ffn, inDim, mats, ...(expertParams ? { expertParams } : {}) };
}

export function parseConfig(cfg: unknown): ParsedConfig {
  if (!isObj(cfg)) throw new Error("config.json must be a JSON object");
  const { t } = mergeTextConfig(cfg);
  const layers = layerCount(t);
  const hidden = g(t, "hidden_size", "d_model", "n_embd");
  if (!hidden) throw new Error("config has no hidden_size");
  const heads = g(t, "num_attention_heads", "n_head") ?? 0;
  const ropeRaw = isObj(t.rope_scaling) ? t.rope_scaling : isObj(t.rope_parameters) ? t.rope_parameters : null;
  const ropeType = ropeRaw ? String(ropeRaw.rope_type ?? ropeRaw.type ?? "") : "";
  const ropeFactor = ropeRaw ? num(ropeRaw.factor) : undefined;
  const tiedRaw = t.tie_word_embeddings ?? cfg.tie_word_embeddings;
  const modelType = typeof t.model_type === "string" ? t.model_type : typeof cfg.model_type === "string" ? cfg.model_type : null;
  return {
    modelType,
    dims: {
      layers,
      hidden,
      heads,
      kvHeads: heads ? kvHeadsOf(t) : 0,
      headDim: heads ? headDimOf(t) : 0,
      vocab: g(t, "vocab_size", "padded_vocab_size") ?? 0,
      tied: typeof tiedRaw === "boolean" ? tiedRaw : (modelType ?? "").startsWith("gemma"),
      ffn: g(t, "intermediate_size", "ffn_hidden_size") ?? 0,
      mtpLayers: g(t, "num_nextn_predict_layers", "mtp_num_hidden_layers", "mtp_num_layers") ?? (t.use_mtp ? 1 : 0),
    },
    moe: moeOf(cfg),
    kv: planKv(cfg),
    maxPositions: g(t, "max_position_embeddings", "max_seq_len", "model_max_length") ?? null,
    rope: ropeType && ropeType !== "default" && ropeFactor && ropeFactor > 1 ? { type: ropeType, factor: ropeFactor } : null,
  };
}

// ---------------------------------------------------------------- safetensors census

/** Where a tensor's parameters go: vision towers, MTP layers and lookup tables can be left off the GPU. */
export type TensorGroup = "embed" | "head" | "experts" | "mtp" | "vision" | "lookup" | "body" | "aux";

const AUX = /(_scales|\.weight_scale(_inv|_2)?|\.scale|\.qzeros|\.g_idx|\.weight_shape|\.input_scale(_2)?|\.k_scale|\.v_scale|\.weight_zero_point|\.weight_global_scale)$/;
const VISION = /(^|\.)(visual|vision_tower|vision_model|vision_encoder|vit|audio_tower|audio_encoder|audio_model|multi_modal_projector|mm_projector|mlp_AR|merger|resampler|sound_encoder|perception|image_encoder|speech|vision)\./i;
const LOOKUP = /(engram|ngram|oe_embed|ple_|per_layer_embed|embed_tokens_per_layer|over_?encod)/i;
const MTP = /(^|\.)mtp[._]|nextn|\.mtp\.|^mtp|model_mtp|dspark/;
const EMBED = /(^|\.)(embed_tokens|wte|tok_embeddings|word_embeddings|embedding|embeddings\.word)\.weight$/;
const HEAD = /(^|\.)(lm_head|output|embed_out)\.weight$/;

export function classifyTensor(name: string, shape: readonly number[], nLayers: number, experts: number): TensorGroup {
  if (AUX.test(name)) return "aux";
  const layer = /layers\.(\d+)\./.exec(name);
  if (MTP.test(name) || (layer && Number(layer[1]) >= nLayers && !VISION.test(name))) return "mtp";
  if (VISION.test(name)) return "vision";
  if (LOOKUP.test(name)) return "lookup";
  if (EMBED.test(name)) return "embed";
  if (HEAD.test(name) && !/layers\./.test(name)) return "head";
  if (!name.includes("shared") && (/\.experts?\./.test(name) || (experts > 1 && shape.length === 3 && shape[0] === experts))) return "experts";
  return "body";
}

/** Logical parameters a stored tensor holds: packed int4/fp4 dtypes hold several per element. */
export function logicalElems(name: string, dtype: string, shape: readonly number[], dtypes: ReadonlyMap<string, string>, bits = 4): number {
  const n = shape.reduce((a, b) => a * b, 1);
  if (name.endsWith("_blocks") && dtype === "U8") return n * 2;
  if (name.endsWith(".weight_packed")) {
    if (dtype === "I32") return n * 8;
    if (dtype === "U8" || dtype === "I8") return n * 2;
  }
  if (name.endsWith(".qweight") && dtype === "I32") return n * Math.floor(32 / bits);
  if ((dtype === "I8" || dtype === "U8") && name.endsWith(".weight")) {
    const base = name.slice(0, -"weight".length);
    if (dtypes.has(`${base}scale`) || dtypes.has(`${base}weight_scale`)) return n * 2;
  }
  return n;
}

// ---------------------------------------------------------------- names

/** Parameter counts written in a model name: "Qwen3-30B-A3B" → total 30B, active 3B; "17B-16E" → active 17B. */
export function paramsFromName(s: string): { total?: number; active?: number } | null {
  const out: { total?: number; active?: number } = {};
  const act = /[-_ ]A(\d+(?:\.\d+)?)B\b/i.exec(s) ?? /\b(\d+(?:\.\d+)?)B-\d+E\b/.exec(s);
  if (act) out.active = Number(act[1]) * 1e9;
  const tot = /(?:^|[-_ /])(\d+(?:\.\d+)?)([BT])(?=[-_ ]|$)/i.exec(s.replace(/[-_ ]A\d+(?:\.\d+)?B\b/i, ""));
  if (tot) out.total = Number(tot[1]) * (tot[2].toUpperCase() === "T" ? 1e12 : 1e9);
  return out.total || out.active ? out : null;
}
