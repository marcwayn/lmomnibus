/**
 * "Run it yourself" for model pages and the build's meta descriptions: a few
 * standard ways to serve an open-weight model, the memory each needs at a few
 * contexts, and the smallest common GPU setup that holds it.
 *
 * Every figure is an estimate from src/core/vram.ts under fixed, stated
 * settings: a headless GPU, one sequence, an F16 KV cache (BF16 on vLLM),
 * vLLM at its default utilisation, no vision encoder or MTP layers loaded.
 * The VRAM Estimator is where people change any of that.
 */
import { KV_FAMILY_LABEL, type ParsedConfig } from "./arch.ts";
import { DEVICE_BY_ID, DEVICES, SETUP_LADDER, type Device } from "./devices.ts";
import {
  defaultFormat,
  estimate,
  fmtCtx,
  fmtGiB,
  formatLabel,
  formatOptions,
  GiB,
  modelMaxContext,
  nativeLabel,
  vllmBatchTokens,
  VLLM_UTIL,
  type Engine,
  type FormatId,
  type Range,
  type VramModel,
  type VramSettings,
} from "./vram.ts";

/** Re-exported for the model page, which loads this module on demand. */
export { fmtCtx };

/** The fixed settings in words, for footnotes. */
export const PAGE_SETTINGS_TEXT = `Headless GPU, one sequence, F16 KV cache (BF16 on vLLM), vLLM at ${Math.round(VLLM_UTIL * 100)}% of each GPU, no vision encoder or MTP layers loaded`;

/** "1× RTX 4090, 1× RTX 5090, 2× RTX 4090 … 8× B200": the ladder, for footnotes. */
export const LADDER_TEXT = (() => {
  const name = ([id, n]: readonly [string, number]) => `${n}× ${DEVICE_BY_ID.get(id)?.short ?? id}`;
  return `${SETUP_LADDER.slice(0, 5).map(name).join(", ")} … ${name(SETUP_LADDER[SETUP_LADDER.length - 1])}`;
})();

export const SELF_HOST_CONTEXTS = [8 * 1024, 32 * 1024, 128 * 1024] as const;

/** The figure in each cell is sized on one of these: the ladder's first rung. */
const REFERENCE = DEVICE_BY_ID.get(SETUP_LADDER[0][0])!;

export interface Setup {
  device: Device;
  count: 1 | 2 | 4 | 8;
}

export interface SelfHostCell {
  ctx: number;
  /** Need on one GPU holding everything (GPU side; llama.cpp keeps the embedding table in RAM). */
  need: Range;
  /** Smallest rung of SETUP_LADDER that fits at the top of the range; null when not even 8 × B200 does. */
  setup: Setup | null;
}

export interface SelfHostRow {
  id: string;
  label: string;
  engine: Engine;
  format: FormatId;
  fileBytes: number | null;
  cells: SelfHostCell[];
}

export interface SelfHostTable {
  /** Column contexts, ending at the model's maximum. */
  contexts: number[];
  max: number;
  rows: SelfHostRow[];
  /** Smallest Mac (marketed RAM) whose default GPU cap holds the headline format at 32K. */
  mac: { format: string; ctx: number; ramGb: number | null } | null;
}

/** The fixed settings every figure on a model page uses. */
export function pageSettings(engine: Engine, format: FormatId, ctx: number, device: Device = REFERENCE, fileBytes: number | null = null): VramSettings {
  return {
    engine,
    format,
    fileBytes,
    bpw: null,
    ctx,
    seqs: 1,
    kv: "f16",
    device,
    count: 1,
    util: VLLM_UTIL,
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
  };
}

/** The smallest setup on the ladder that fits these settings (verdict "fits": the whole range is within budget). */
export function smallestSetup(m: VramModel, s: VramSettings, ladder: readonly (readonly [string, 1 | 2 | 4 | 8])[] = SETUP_LADDER): Setup | null {
  for (const [id, count] of ladder) {
    const device = DEVICE_BY_ID.get(id);
    if (!device) continue;
    const e = estimate(m, { ...s, device, count, display: false });
    if (!e.invalid && e.verdict === "fits") return { device, count };
  }
  return null;
}

/** "1× RTX 4090", or "> 8× B200" past the end of the ladder. */
export function setupLabel(setup: Setup | null): string {
  if (setup) return `${setup.count}× ${setup.device.short}`;
  const [id, count] = SETUP_LADDER[SETUP_LADDER.length - 1];
  return `> ${count}× ${DEVICE_BY_ID.get(id)?.short ?? id}`;
}

/** "18.1 GiB", "1,459 GiB" or "620 MiB": whole GiB once the figure is in the hundreds. */
export function fmtNeed(bytes: number): string {
  const gib = bytes / GiB;
  return gib >= 100 ? `${Math.round(gib).toLocaleString("en-US")} GiB` : fmtGiB(bytes);
}

/** Context columns: 8K, 32K and 128K below the model's maximum, then the maximum itself. */
export function selfHostContexts(max: number): number[] {
  return [...SELF_HOST_CONTEXTS.filter((c) => c < max), max];
}

/** "PTQ1_0 GGUF (5.95 GB)" from "Ternary-Bonsai-2-27B-PTQ1_0.gguf". */
const ggufLabel = (f: { name: string; bytes: number }) => {
  const tag = /-([^-]+)\.gguf$/i.exec(f.name)?.[1] ?? f.name.replace(/\.gguf$/i, "");
  return `${tag} GGUF (${(f.bytes / 1e9).toFixed(2)} GB)`;
};

type RowSpec = Omit<SelfHostRow, "cells">;

/**
 * Which ways of serving the model to show: as published and FP8 on vLLM, then
 * Q8_0 and Q4_K_M on llama.cpp, plus llama.cpp's own default when it's
 * something else (MXFP4 for models published in it). Formats the engine
 * wouldn't offer (upcasts) are left out.
 */
export function selfHostRows(m: VramModel): RowSpec[] {
  if (m.ggufFiles?.length) {
    return [...m.ggufFiles]
      .sort((a, b) => a.bytes - b.bytes)
      .map((f) => ({ id: `file:${f.name}`, label: `${ggufLabel(f)} · llama.cpp`, engine: "llamacpp" as const, format: "file" as const, fileBytes: f.bytes }));
  }
  const vllm = formatOptions(m, "vllm", REFERENCE).filter((o) => !o.disabled);
  const cpp = formatOptions(m, "llamacpp", REFERENCE).filter((o) => !o.disabled);
  const has = (opts: typeof vllm, id: FormatId) => opts.some((o) => o.id === id);
  const nat = m.native.format;
  const rows: RowSpec[] = [];
  const add = (engine: Engine, format: FormatId, label: string) => rows.push({ id: `${engine}:${format}`, label, engine, format, fileBytes: null });
  if (has(vllm, "native")) add("vllm", "native", `As published (${nativeLabel(nat)}) · vLLM`);
  if ((nat === "bf16" || nat === "fp16") && has(vllm, "fp8")) add("vllm", "fp8", "FP8 · vLLM");
  const own = defaultFormat(m, "llamacpp", REFERENCE);
  for (const o of cpp) {
    if (o.id === "q8_0" || o.id === "q4_k_m" || o.id === own) add("llamacpp", o.id, `${formatLabel(o.id)} · llama.cpp`);
  }
  return rows;
}

/** The headline row for one-line summaries: llama.cpp's default format (usually Q4_K_M), else the first row. */
function headlineRow(m: VramModel, rows: readonly RowSpec[]): RowSpec | null {
  const own = m.ggufFiles?.length ? "file" : defaultFormat(m, "llamacpp", REFERENCE);
  return rows.find((r) => r.engine === "llamacpp" && r.format === own) ?? rows[0] ?? null;
}

const MACS = DEVICES.filter((d) => d.vendor === "apple").sort((a, b) => a.memoryGb - b.memoryGb || b.usableGiB - a.usableGiB);

/** The smallest Mac (by marketed RAM) that holds the settings at macOS's default GPU cap. */
export function smallestMac(m: VramModel, s: VramSettings): Device | null {
  for (const d of MACS) {
    const e = estimate(m, { ...s, device: d, count: 1, engine: "llamacpp", display: false, macRaised: false });
    if (!e.invalid && e.verdict === "fits") return d;
  }
  return null;
}

export function selfHostTable(m: VramModel, orContext: number | null): SelfHostTable {
  const max = modelMaxContext(m, orContext);
  const contexts = selfHostContexts(max);
  const specs = selfHostRows(m);
  const rows = specs.map((r) => ({
    ...r,
    cells: contexts.map((ctx) => {
      const s = pageSettings(r.engine, r.format, ctx, REFERENCE, r.fileBytes);
      const setup = smallestSetup(m, s);
      // vLLM's activation peak follows the GPU's batch-token default: size the cell on the setup named.
      const at = r.engine === "vllm" ? { ...s, mbt: vllmBatchTokens(setup?.device ?? DEVICE_BY_ID.get("h100-sxm")!) } : s;
      return { ctx, need: estimate(m, at).need, setup };
    }),
  }));
  const head = headlineRow(m, specs);
  let mac: SelfHostTable["mac"] = null;
  if (head && head.engine === "llamacpp") {
    const ctx = Math.min(32 * 1024, max);
    const d = smallestMac(m, pageSettings("llamacpp", head.format, ctx, REFERENCE, head.fileBytes));
    mac = { format: head.label.replace(" · llama.cpp", ""), ctx, ramGb: d?.memoryGb ?? null };
  }
  return { contexts, max, rows, mac };
}

/** "about 18 GiB at Q4_K_M with 32K context", for meta descriptions; null when nothing can be sized. */
export function selfHostSummary(m: VramModel, orContext: number | null): string | null {
  const head = headlineRow(m, selfHostRows(m));
  if (!head) return null;
  const ctx = Math.min(32 * 1024, modelMaxContext(m, orContext));
  const e = estimate(m, pageSettings(head.engine, head.format, ctx, REFERENCE, head.fileBytes));
  if (e.invalid) return null;
  const gib = e.need.mid / GiB;
  const size = gib >= 10 ? String(Math.round(gib)) : gib.toFixed(1);
  const fmt = head.label.replace(/ · (llama\.cpp|vLLM)$/, "");
  return `about ${size} GiB at ${fmt} with ${fmtCtx(ctx)} context`;
}

/** The architecture in one line: "64 layers · standard attention (GQA/MHA) · 64 query / 8 KV heads × 128 · dense". */
export function archSummary(a: ParsedConfig): string {
  const d = a.dims;
  const latent = a.kv.groups.find((g) => g.kind === "latent");
  const attn = latent ? `latent KV cache, ${latent.headElems} values per token per layer` : `${d.heads} query / ${d.kvHeads} KV heads × ${d.headDim}`;
  const moe = a.moe ? `${a.moe.experts} experts, ${a.moe.topK} active per token${a.moe.shared ? ` + ${a.moe.shared} shared` : ""}` : "dense";
  return `${d.layers} layers · ${KV_FAMILY_LABEL[a.kv.family]} · ${attn} · ${moe}`;
}
