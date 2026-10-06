/**
 * What we know about an open-weight model's published weights: the record
 * scripts/hf.ts writes to data/weights.json from Hugging Face (repo,
 * licence, parameter count, tensor groups, checkpoint size, architecture),
 * and the small per-catalog-key index the always-loaded pages read.
 */
import type { Dims, KvPlan, MoeLayout, ParsedConfig } from "./arch.ts";

/** The format the weights ship in. */
export type NativeFormat = "bf16" | "fp16" | "f32" | "fp8" | "int4" | "mxfp4" | "fp4" | "gguf";

/** Parameters by where they can live: vision towers, MTP layers and lookup tables can stay off the GPU. */
export interface TensorGroups {
  embed: number;
  /** 0 when the output head shares the embedding (tied). */
  head: number;
  /** Routed experts (part of the body). */
  experts: number;
  mtp: number;
  vision: number;
  lookup: number;
  /** "headers": counted from the safetensors headers; "config": worked out from config.json. */
  source: "headers" | "config";
}

export interface Licence {
  id: string | null;
  name: string | null;
  link: string | null;
}

export type LicenceClass = "permissive" | "custom" | "noncommercial" | "unclassified";

export interface WeightsRecord {
  /** The repo OpenRouter (or our openness list) links. */
  hfId: string;
  /** Where it lives now, after Hugging Face renames. */
  resolvedId: string;
  sha: string | null;
  /** Last day the repo was read. */
  checkedOn: string;
  /** "unverified": the linked repo can't be opened and no copy with the same weights exists. */
  status: "open" | "unverified";
  /** Where the architecture came from: the repo itself, a public mirror of a gated repo, or a donor. */
  source: string;
  gated: boolean;
  licence: Licence;
  /** Logical parameter count (packed 4-bit dtypes unpacked). */
  params: number;
  paramsSource: "safetensors" | "headers" | "gguf" | "pickle" | "mirror" | "override";
  groups: TensorGroups;
  active: { params: number; source: "card" | "name" | "headers" } | null;
  /** Bytes of the published safetensors (or pickle) checkpoint; null for GGUF-only repos. */
  checkpointBytes: number | null;
  native: { format: NativeFormat; bits: number };
  /** GGUF-only repos: the files people actually download. */
  ggufFiles?: { name: string; bytes: number }[];
  /** null only for unverified repos. */
  arch: ParsedConfig | null;
  notes: string[];
}

export interface WeightsFile {
  asOf: string;
  models: Record<string, WeightsRecord>;
}

/** What the always-loaded pages need, keyed by catalog key. */
export interface WeightsIndexEntry {
  status: "open" | "unverified";
  licence: LicenceClass;
  licenceLabel: string;
  total: number;
  active: number | null;
  moe: boolean;
  gated: boolean;
  native: NativeFormat;
}

export interface WeightsIndexFile {
  asOf: string;
  models: Record<string, WeightsIndexEntry>;
}

// ---------------------------------------------------------------- licences

const PERMISSIVE = /^(apache-2\.0|mit|bsd(-[0-9a-z-]+)?|isc|cc0-1\.0|cc-by-4\.0|openmdw(-[0-9.]+)?|openmdw-license-agreement|unlicense|zlib|bsl-1\.0|mpl-2\.0)$/i;
const NONCOMMERCIAL = /^(cc-by-nc(-[a-z0-9.-]+)?|mrl|mistral-research-license|research-only|non-commercial)$/i;

/**
 * Licences we have read and know to be custom terms: usage policies, user
 * caps or attribution on top of the grant. Named model licences we haven't
 * read (kimi-k3, qwen3.8-max, glm-5.3, reka-edge…) stay unclassified.
 */
const CUSTOM = /^(llama[0-9.]*|gemma|modified-mit|nvidia-nemotron-open-model-license|nvidia-open-model-license|qwen|qwen-community-1\.0|tongyi-qianwen|minimax-community|tencent-hunyuan-a13b|tencent-hunyuan-community)$/i;

export function licenceKey(l: Licence): string | null {
  const id = l.id?.trim().toLowerCase() || null;
  if (id && id !== "other") return id;
  return l.name?.trim().toLowerCase() || null;
}

/** Sorts a licence into a class. Anything we haven't read is unclassified — never assumed permissive. */
export function classifyLicence(l: Licence): LicenceClass {
  const key = licenceKey(l);
  if (!key) return "unclassified";
  if (PERMISSIVE.test(key)) return "permissive";
  if (NONCOMMERCIAL.test(key)) return "noncommercial";
  if (CUSTOM.test(key)) return "custom";
  return "unclassified";
}

export const LICENCE_CLASS_LABEL: Record<LicenceClass, string> = {
  permissive: "Permissive",
  custom: "Custom terms",
  noncommercial: "Non-commercial",
  unclassified: "Unclassified — read the licence",
};

/** "Apache-2.0", "Llama 3.3 licence", "modified MIT", or the raw name. */
export function licenceLabel(l: Licence): string {
  const key = licenceKey(l);
  if (!key) return "no licence named";
  const known: Record<string, string> = {
    "apache-2.0": "Apache-2.0",
    mit: "MIT",
    "modified-mit": "modified MIT",
    gemma: "Gemma terms",
    openmdw: "OpenMDW",
    "cc-by-nc-4.0": "CC BY-NC 4.0",
    "cc-by-4.0": "CC BY 4.0",
    mrl: "Mistral Research Licence",
  };
  if (known[key]) return known[key];
  const llama = /^llama-?([0-9.]+)/.exec(key);
  if (llama) return `Llama ${llama[1]} licence`;
  return key;
}

// ---------------------------------------------------------------- tensor groups from config

/** Tensor groups worked out from config.json when the safetensors headers can't be read. */
export function groupsFromConfig(total: number, dims: Dims, moe: MoeLayout | null, cfgLookup = 0): TensorGroups {
  const embed = dims.vocab * dims.hidden;
  const head = dims.tied ? 0 : dims.vocab * dims.hidden;
  const experts = moe ? moe.layers * moe.experts * moe.mats * moe.inDim * moe.ffn : 0;
  // An MTP layer is about one trunk layer.
  const perLayer = dims.layers ? Math.max(0, total - embed - head - cfgLookup) / (dims.layers + dims.mtpLayers) : 0;
  return {
    embed,
    head,
    experts: Math.min(experts, Math.max(0, total - embed - head)),
    mtp: Math.round(perLayer * dims.mtpLayers),
    vision: 0,
    lookup: cfgLookup,
    source: "config",
  };
}

/** Body = everything that isn't embedding, head, MTP, vision or lookup tables (routed experts included). */
export function bodyParams(r: Pick<WeightsRecord, "params" | "groups">): number {
  const g = r.groups;
  return Math.max(0, r.params - g.embed - g.head - g.mtp - g.vision - g.lookup);
}

export function isMoe(r: { arch: { moe: MoeLayout | null } | null }): boolean {
  return Boolean(r.arch?.moe);
}

/** Active parameters per token for display, from the header split: always-on params plus top-k of the experts. */
export function activeFromGroups(params: number, g: TensorGroups, moe: MoeLayout | null): number | null {
  if (!moe || g.source !== "headers" || !g.experts) return null;
  const always = params - g.experts - g.mtp - g.vision - g.lookup;
  return Math.round(always + (g.experts * moe.topK) / moe.experts);
}

export type { KvPlan };
