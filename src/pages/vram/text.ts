/**
 * Words and figures for the VRAM Estimator: GiB with the right precision,
 * device phrases, the engine flags line and the Markdown copy. Every memory
 * figure leaves here as an estimate ("≈" or a range is added by the caller).
 */
import { KV_FAMILY_LABEL, type KvFamily, type KvPlan } from "../../core/arch.ts";
import type { Device } from "../../core/devices.ts";
import type { Model } from "../../core/model.ts";
import {
  formatLabel,
  GiB,
  KV_OPTIONS,
  VERDICT_LABEL,
  type Engine,
  type FormatId,
  type KvDtype,
  type Range,
  type VramEstimate,
  type VramModel,
  type VramSettings,
} from "../../core/vram.ts";
import { classifyLicence, licenceLabel, LICENCE_CLASS_LABEL, type WeightsRecord } from "../../core/weights.ts";

const group = (n: number) => n.toLocaleString("en-US");

/** GiB for prose: one decimal, whole numbers (grouped) from 100 up. */
export function g1(bytes: number): string {
  const v = bytes / GiB;
  if (Math.abs(v) >= 100) return group(Math.round(v));
  return v.toFixed(1);
}

/** GiB for tables: two decimals under 10, one under 100, whole numbers above. */
export function g2(bytes: number): string {
  const v = bytes / GiB;
  if (Math.abs(v) >= 100) return group(Math.round(v));
  return v.toFixed(Math.abs(v) >= 10 ? 1 : 2);
}

export const rangeText = (r: Range, f = g1) => `${f(r.low)}–${f(r.high)}`;

/** Driver-reported capacity, as the spec sheet prints it: "23.99 GiB". */
export const capText = (gib: number) => `${gib >= 100 ? String(Number(gib.toFixed(2))) : gib.toFixed(2)} GiB`;

/** A capacity that's a vendor's claim or our estimate, not driver output: shown with an "unconfirmed" tag. */
export const unconfirmed = (d: Device) => d.basis === "estimate" || d.basis === "vendor-claimed";

export const tokens = (n: number) => group(n);

/** "one RTX 4090", "4 × H100 SXM", "one M5 Max 128GB". */
export function rigText(d: Device, count: number): string {
  return count === 1 ? `one ${d.short}` : `${count} × ${d.short}`;
}

export function sequencesText(n: number) {
  return `${n} sequence${n === 1 ? "" : "s"}`;
}

/** Short engine names for tight places. */
export const ENGINE_SHORT: Record<Engine, string> = { llamacpp: "llama.cpp", vllm: "vLLM", mlx: "MLX" };
export const ENGINE_ALSO: Record<Engine, string> = { llamacpp: "Ollama · LM Studio", vllm: "SGLang", mlx: "Apple" };

export const kvLabel = (engine: Engine, kv: KvDtype) => KV_OPTIONS[engine].find((o) => o.id === kv)?.label ?? kv.toUpperCase();

/** The format a person would recognise: "Q4_K_M", "As published (FP8)", "Your file". */
export function formatName(f: FormatId, vm: VramModel | null, fileBytes: number | null): string {
  if (f === "file" && vm?.ggufFiles?.length) {
    const file = vm.ggufFiles.find((x) => x.bytes === fileBytes) ?? vm.ggufFiles[0];
    return ggufTag(file.name);
  }
  return formatLabel(f);
}

/** "PTQ1_0" from "Ternary-Bonsai-2-27B-PTQ1_0.gguf". */
export const ggufTag = (name: string) => /-([^-]+)\.gguf$/i.exec(name)?.[1] ?? name.replace(/\.gguf$/i, "");

// ---------------------------------------------------------------- the model, in a line

const KV_SHORT: Record<KvFamily, string> = {
  gqa: "GQA",
  swa: "sliding window + full",
  "swa-hetero": "sliding window + full",
  chunked: "chunked + global",
  mla: "MLA",
  "mla-indexer": "MLA + indexer",
  longcat: "MLA + indexer",
  dsv4: "compressed sparse attention",
  dsv41: "compressed sparse attention",
  deltanet: "DeltaNet hybrid",
  "kda-mla": "KDA + MLA hybrid",
  "kda-mla-indexer": "KDA + MLA hybrid",
  lightning: "lightning-attention hybrid",
  mamba2: "Mamba-2 hybrid",
  shortconv: "short-conv hybrid",
  "gqa-sparse-index": "sparse attention",
};

/** "GQA 8 KV heads", "MHA", "MLA", "sliding window + full". */
function kvShort(plan: KvPlan, heads: number, kvHeads: number): string {
  if (plan.family === "gqa") return kvHeads && kvHeads === heads ? "MHA" : `GQA ${kvHeads} KV heads`;
  return KV_SHORT[plan.family];
}

export const kvFamilyLabel = (f: KvFamily) => KV_FAMILY_LABEL[f];

/** "32.8B", "1.6T". */
export function paramsText(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2).replace(/0$/, "")}T`;
  if (n >= 1e11) return `${Math.round(n / 1e9)}B`;
  return `${(n / 1e9).toFixed(1)}B`;
}

/** "32.8B dense" or "30.5B MoE, 3.3B active". */
function sizeText(total: number, active: number | null, moe: boolean): string {
  if (!moe) return `${paramsText(total)} dense`;
  return `${paramsText(total)} MoE${active ? `, ${paramsText(active)} active` : ""}`;
}

/** The picker's description: "Qwen · 32.8B dense · GQA 8 KV heads · Apache-2.0". */
export function modelLine(m: Model, r: WeightsRecord | null): string {
  const w = m.weights;
  const parts = [m.vendorName];
  if (m.weightsStatus === "unverified") return `${m.vendorName} · weights couldn't be verified`;
  if (w?.total) parts.push(sizeText(w.total, w.active, w.moe));
  if (r?.arch) parts.push(kvShort(r.arch.kv, r.arch.dims.heads, r.arch.dims.kvHeads));
  const lic = w?.licenceLabel ?? (r ? licenceLabel(r.licence) : null);
  if (lic) parts.push(lic);
  return parts.join(" · ");
}

/** "Permissive · Apache-2.0": the class from the weights index, else classified from the record. */
export function licenceText(m: Model | null, r: WeightsRecord): { cls: string; name: string } {
  const cls = m?.weights?.licence ?? classifyLicence(r.licence);
  return { cls: LICENCE_CLASS_LABEL[cls], name: m?.weights?.licenceLabel ?? licenceLabel(r.licence) };
}

// ---------------------------------------------------------------- engine flags

const GGUF_NAME: Partial<Record<FormatId, string>> = {
  bf16: "BF16",
  mxfp4: "MXFP4",
  q8_0: "Q8_0",
  q6_k: "Q6_K",
  q5_k_m: "Q5_K_M",
  q4_k_m: "Q4_K_M",
  iq4_xs: "IQ4_XS",
  q3_k_m: "Q3_K_M",
  q2_k: "Q2_K",
  iq2_xxs: "IQ2_XXS",
};

const repoName = (hfId: string | null) => hfId?.split("/").pop() ?? "model";

/**
 * Command-line flags that match the estimate. llama.cpp: -c is the whole
 * pool, split across -np slots; an explicit -c and -ngl stop --fit from
 * shrinking either. vLLM: the startup budget, length and concurrency.
 */
export function engineFlags(
  s: VramSettings,
  shown: FormatId,
  vm: VramModel,
  hfId: string | null,
  partialLayers: number | null,
): string | null {
  if (s.engine === "mlx") return null;
  if (s.engine === "llamacpp") {
    const file =
      s.format === "file" && vm.ggufFiles?.length
        ? (vm.ggufFiles.find((f) => f.bytes === s.fileBytes) ?? vm.ggufFiles[0]).name
        : s.format === "file"
          ? "<your-file>.gguf"
          : `${repoName(hfId)}-${GGUF_NAME[shown] ?? shown.toUpperCase()}.gguf`;
    // -c 0 means the model's trained context to llama.cpp, not the weights-only estimate a context of 0 gives here.
    const c = s.ctx > 0 ? String(s.ctx * s.seqs) : s.seqs > 1 ? `<your context × ${s.seqs}>` : "<your context>";
    const parts = ["llama-server", "-m", file, "-c", c, "-np", String(s.seqs), "-ngl", String(partialLayers ?? 99)];
    parts.push("-fa", s.flashAttn ? "on" : "off");
    if (s.kv !== "f16") parts.push("-ctk", s.kv, "-ctv", s.kv);
    if (s.ub !== 512) parts.push("-ub", String(s.ub));
    if (s.expertsOnHost) parts.push("--cpu-moe");
    if (s.swaFull) parts.push("--swa-full");
    if (s.vision) parts.push("--mmproj", `mmproj-${repoName(hfId)}-F16.gguf`);
    return parts.join(" ");
  }
  const id = hfId ?? "<model>";
  const repo =
    shown === "native" || shown === "bf16" || shown === "fp8" || s.format === "file"
      ? id
      : `<${formatLabel(shown)} build of ${id}>`;
  const parts = ["vllm serve", repo];
  if (shown === "fp8" && vm.native.format !== "fp8") parts.push("--quantization fp8");
  parts.push(`--max-model-len ${s.ctx > 0 ? s.ctx : "<your context>"}`, `--max-num-seqs ${s.seqs}`, `--tensor-parallel-size ${s.count}`);
  if (s.kv === "fp8") parts.push("--kv-cache-dtype fp8");
  parts.push(`--gpu-memory-utilization ${s.util}`);
  if (s.mbt !== null) parts.push(`--max-num-batched-tokens ${s.mbt}`);
  if (vm.groups.vision && !s.vision) parts.push("--language-model-only");
  return parts.join(" ");
}

// ---------------------------------------------------------------- Markdown

export function estimateMarkdown(o: {
  name: string;
  settingsLine: string;
  e: VramEstimate;
  rig: string;
  worst: number;
  asOf: string;
  url: string;
}): string {
  const { e } = o;
  const rows = e.lines.map((l) => {
    const r = l.perGpu[o.worst];
    return `| ${l.label} | ${l.formula} | ${g2(r.mid)} | ${rangeText(r, g2)} |`;
  });
  const host = e.hostItems.map((h) => `| ${h.label} (system RAM) | | ${g2(h.bytes.mid)} | ${rangeText(h.bytes, g2)} |`);
  return [
    `**${o.name}** · ${o.settingsLine}`,
    "",
    `Estimate: ≈ ${g1(e.need.mid)} GiB (${rangeText(e.need)}) · **${VERDICT_LABEL[e.verdict]}** on ${o.rig}`,
    "",
    "| Item | How it's computed | ≈ GiB | Range |",
    "|---|---|---:|---:|",
    ...rows,
    ...host,
    `| **Total** | estimate | **${g2(e.need.mid)}** | ${rangeText(e.need, g2)} |`,
    "",
    `An estimate, not a measurement. Model data from Hugging Face as of ${o.asOf} · LMOmnibus VRAM Estimator`,
    o.url,
  ].join("\n");
}

