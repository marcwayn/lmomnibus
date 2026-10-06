// Reads every open-weight model's Hugging Face repo and writes what the VRAM
// Estimator and the open-vs-closed tool need:
//
//   node scripts/hf.ts            # refresh data/weights.json + data/weights-index.json
//   node scripts/hf.ts --all      # re-read every repo, even when its sha hasn't changed
//
// Per repo: the model API (sha, gating, licence, parameter count), the file
// tree (checkpoint size), config.json (architecture), and the safetensors
// index (which shard holds which tensor). Only the shards holding vision,
// MTP or lookup tensors have their headers read, to size those groups
// exactly; embedding, head and experts follow from config.json. A repo whose
// sha hasn't changed since the last run is reused as-is, so a daily run
// costs about one request per model. Reads are throttled and cached on disk
// (node_modules/.cache/lmo-hf, keyed by repo sha), because Hugging Face
// rate-limits anonymous clients hard.
//
// Gated repos (Llama, Gemma, Command A) are read through a public copy with
// the same parameter total and model type, never with a token. HF_TOKEN, if
// set, only raises rate limits. If more than 20% of repos fail, the previous
// files are kept: a Hugging Face outage must not wipe the data.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { classifyTensor, logicalElems, paramsFromName, parseConfig, type Cfg } from "../src/core/arch.ts";
import {
  activeFromGroups,
  classifyLicence,
  groupsFromConfig,
  licenceLabel,
  type Licence,
  type NativeFormat,
  type TensorGroups,
  type WeightsFile,
  type WeightsIndexFile,
  type WeightsRecord,
} from "../src/core/weights.ts";

const OUT = "data/weights.json";
const INDEX = "data/weights-index.json";
const OVERRIDES = "data/arch-overrides.json";
const HF = "https://huggingface.co";
const UA = "lmo-build/1 (+https://lmomnibus.pages.dev)";
const TODAY = new Date().toISOString().slice(0, 10);
const CACHE = "node_modules/.cache/lmo-hf";

const { values: args } = parseArgs({ options: { all: { type: "boolean", default: false }, minutes: { type: "string", default: "20" } } });

/** Past this, requests fail fast: the run keeps the previous files rather than stall the price refresh. */
const DEADLINE = Date.now() + Number(args.minutes) * 60_000;

/**
 * Bump when arch.ts or this script's derivation changes, so unchanged repos are
 * re-derived on the next run (records are otherwise reused while their sha holds).
 */
const PARSER_VERSION = 2;

/** HTTP statuses that mean the repo is gone or private, not that Hugging Face is having a bad day. */
const GONE = new Set([401, 403, 404, 410]);

interface Override {
  active_b?: number;
  card_total_b?: number;
  mirror?: string;
  donor?: string;
  status?: "unverified";
  note?: string;
  kv_note?: string;
  source: string;
  verified_on: string;
}

const overrides: Record<string, Override> = existsSync(OVERRIDES) ? JSON.parse(readFileSync(OVERRIDES, "utf8")) : {};
const catalog: { key: string; display_name: string; hf_id?: string | null }[] = JSON.parse(readFileSync("data/catalog.json", "utf8"));
const previous: WeightsFile | null = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

// ---------------------------------------------------------------- HTTP

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One shared throttle for every request to huggingface.co: a few in flight,
// spaced out, and a pause for everyone when the server says to slow down.
const MAX_IN_FLIGHT = 2;
const SPACING_MS = 120;
let inFlight = 0;
let nextAt = 0;
let pausedUntil = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<() => void> {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  const now = Date.now();
  const at = Math.max(now, nextAt, pausedUntil);
  nextAt = at + SPACING_MS;
  if (at > now) await sleep(at - now);
  return () => {
    inFlight--;
    waiting.shift()?.();
  };
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": UA, ...(init.headers as Record<string, string>) };
  // The token only raises API rate limits; it is never sent on file reads, so a gated
  // repo's files are always read through a public copy, as documented.
  if (process.env.HF_TOKEN && url.startsWith(`${HF}/api/`)) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  for (let attempt = 0; ; attempt++) {
    if (Date.now() > DEADLINE) throw new Error("out of time");
    const release = await slot();
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      // A hung or dropped connection: retry like a 5xx, a few times.
      if (attempt < 4) continue;
      throw e;
    } finally {
      release();
    }
    // Hugging Face reports the window: `ratelimit: "api";r=498;t=291` (remaining, seconds to reset).
    const rl = /;r=(\d+);t=(\d+)/.exec(res.headers.get("ratelimit") ?? "");
    if (rl && Number(rl[1]) < 15) {
      pausedUntil = Math.max(pausedUntil, Date.now() + (Number(rl[2]) + 2) * 1000);
      console.error(`  near the rate limit; pausing ${Number(rl[2]) + 2}s`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 300_000) : Math.min(120_000, 15_000 * 2 ** attempt);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      if (res.status === 429) console.error(`  rate-limited; pausing ${Math.round(wait / 1000)}s`);
      continue;
    }
    return res;
  }
}

/** Disk cache for things that never change at a given repo sha. */
function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const path = `${CACHE}/${key}.json`;
  if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as T);
  return load().then((v) => {
    if (v !== null) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(v));
    }
    return v;
  });
}

async function getJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await get(url);
  if (!res.ok) {
    await res.body?.cancel();
    return { status: res.status, body: null };
  }
  return { status: res.status, body: (await res.json()) as T };
}

/** Run `fn` over items with at most `n` in flight. */
async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------- repo reads

interface ApiInfo {
  id: string;
  sha?: string;
  gated?: false | "auto" | "manual";
  cardData?: { license?: string | string[]; license_name?: string; license_link?: string };
  tags?: string[];
  safetensors?: { parameters?: Record<string, number>; total?: number };
  gguf?: { total?: number; architecture?: string; context_length?: number };
  config?: { model_type?: string; quantization_config?: Cfg };
}

const API_FIELDS = ["sha", "gated", "cardData", "tags", "safetensors", "gguf", "config"].map((f) => `expand[]=${f}`).join("&");

const api = (id: string) => getJson<ApiInfo>(`${HF}/api/models/${id}?${API_FIELDS}`);

interface TreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: { size: number };
}

async function tree(id: string): Promise<TreeEntry[]> {
  const r = await getJson<TreeEntry[]>(`${HF}/api/models/${id}/tree/main`);
  // A failed listing must fail the job (keeping the last good record), not read as "no files".
  if (!r.body) throw new Error(`file tree ${r.status}`);
  return r.body;
}

const fileSize = (e: TreeEntry) => e.lfs?.size ?? e.size;

/** Root safetensors shards; Mistral's consolidated* copies only when nothing else ships. */
function shards(files: readonly TreeEntry[]): TreeEntry[] {
  const st = files.filter((f) => f.type === "file" && f.path.endsWith(".safetensors") && !f.path.includes("/"));
  const hf = st.filter((f) => !f.path.startsWith("consolidated"));
  return hf.length ? hf : st;
}

async function config(id: string, sha?: string | null): Promise<{ status: number; body: Cfg | null }> {
  let status = 200;
  const body = await (sha ? (load: () => Promise<Cfg | null>) => cached<Cfg>(`${id}@${sha}/config`, load) : (load: () => Promise<Cfg | null>) => load())(async () => {
    const r = await getJson<Cfg>(`${HF}/${id}/resolve/main/config.json`);
    status = r.status;
    return r.body;
  });
  return { status: body ? 200 : status, body };
}

type Header = Record<string, { dtype: string; shape: number[] } | Record<string, string>>;

/** A safetensors shard's JSON header, read with range requests (first 8 bytes = header length). */
async function header(id: string, file: string): Promise<Header> {
  const url = `${HF}/${id}/resolve/main/${file}`;
  const first = await get(url, { headers: { range: "bytes=0-262143" } });
  if (first.status !== 206 && first.status !== 200) throw new Error(`${id}/${file}: ${first.status}`);
  let buf = Buffer.from(await first.arrayBuffer());
  const n = Number(buf.readBigUInt64LE(0));
  if (8 + n > buf.length) {
    const rest = await get(url, { headers: { range: `bytes=${buf.length}-${8 + n - 1}` } });
    if (rest.status !== 206) throw new Error(`${id}/${file}: header range ${rest.status}`);
    buf = Buffer.concat([buf, Buffer.from(await rest.arrayBuffer())]);
  }
  return JSON.parse(buf.subarray(8, 8 + n).toString("utf8"));
}

/**
 * Vision, MTP and lookup-table parameters, counted exactly from the headers
 * of only the shards that hold them (found through the safetensors index).
 * Embedding, head and experts come from config.json.
 */
async function census(
  id: string,
  sha: string | null,
  files: readonly TreeEntry[],
  total: number,
  arch: ReturnType<typeof parseConfig>,
  bits: number,
): Promise<TensorGroups> {
  const base = groupsFromConfig(total, arch.dims, arch.moe);
  const key = (f: string) => `${id}@${sha ?? "nosha"}/${f}`;
  let weightMap: Record<string, string> | null = null;
  if (files.length === 1) weightMap = null;
  else {
    const idxName = files.some((f) => f.path.startsWith("consolidated")) && !files.some((f) => !f.path.startsWith("consolidated")) ? "consolidated.safetensors.index.json" : "model.safetensors.index.json";
    const idx = await cached<{ weight_map: Record<string, string> }>(key(idxName), async () => (await getJson<{ weight_map: Record<string, string> }>(`${HF}/${id}/resolve/main/${idxName}`)).body);
    if (!idx) throw new Error("no safetensors index");
    weightMap = idx.weight_map;
  }
  const experts = arch.moe?.experts ?? 0;
  const layers = arch.dims.layers;
  const wanted = new Set<string>();
  if (weightMap) {
    for (const [name, shard] of Object.entries(weightMap)) {
      const g = classifyTensor(name, [], layers, experts);
      if (g === "mtp" || g === "vision" || g === "lookup") wanted.add(shard);
    }
  } else wanted.add(files[0].path);
  const headers = await pool([...wanted], 2, (f) => cached<Header>(key(`hdr/${f}`), () => header(id, f)));
  const dtypes = new Map<string, string>();
  for (const h of headers) for (const [name, t] of Object.entries(h ?? {})) if (name !== "__metadata__") dtypes.set(name, (t as { dtype: string }).dtype);
  const g = { mtp: 0, vision: 0, lookup: 0 };
  for (const h of headers) {
    for (const [name, raw] of Object.entries(h ?? {})) {
      if (name === "__metadata__") continue;
      const t = raw as { dtype: string; shape: number[] };
      const group = classifyTensor(name, t.shape, layers, experts);
      if (group === "mtp" || group === "vision" || group === "lookup") g[group] += logicalElems(name, t.dtype, t.shape, dtypes, bits);
    }
  }
  return { ...base, mtp: g.mtp, vision: g.vision, lookup: g.lookup, source: "headers" };
}

function licenceOf(info: ApiInfo): Licence {
  const cd = info.cardData ?? {};
  const raw = Array.isArray(cd.license) ? cd.license[0] : cd.license;
  const tag = info.tags?.find((t) => t.startsWith("license:"))?.slice("license:".length);
  return { id: raw ?? tag ?? null, name: cd.license_name ?? null, link: cd.license_link ?? null };
}

function nativeFormat(info: ApiInfo, cfg: Cfg | null): NativeFormat {
  const q = (cfg?.quantization_config ?? (cfg?.text_config as Cfg | undefined)?.quantization_config ?? info.config?.quantization_config) as Cfg | undefined;
  const method = String(q?.quant_method ?? "").toLowerCase();
  const fmt = String(q?.format ?? (q?.config_groups ? JSON.stringify(q.config_groups) : "")).toLowerCase();
  const dt = Object.keys(info.safetensors?.parameters ?? {});
  if (method === "mxfp4" || fmt.includes("mxfp4")) return "mxfp4";
  if (dt.includes("I8") && dt.some((d) => d.startsWith("F8"))) return "fp4";
  if (method === "compressed-tensors" && (fmt.includes("pack-quantized") || fmt.includes('"num_bits": 4'))) return "int4";
  if (dt.includes("U8") && method !== "") return "fp4";
  if (method === "fp8" || fmt.includes("float-quantized") || method === "modelopt" || dt.some((d) => d.startsWith("F8"))) return "fp8";
  if (dt.length === 1 && dt[0] === "F32") return "f32";
  if (dt.includes("F16") && !dt.includes("BF16")) return "fp16";
  return "bf16";
}

// ---------------------------------------------------------------- one model

interface Job {
  hfId: string;
  name: string;
}

interface Result {
  record: WeightsRecord | null;
  reused: boolean;
  error?: string;
}

/** Public copies of a gated repo with the same parameter total and model type. */
async function resolveMirror(names: readonly string[], info: ApiInfo): Promise<{ id: string; cfg: Cfg; info: ApiInfo } | null> {
  const total = info.safetensors?.total;
  const type = info.config?.model_type;
  const candidates = new Set<string>();
  for (const name of names) for (const org of ["unsloth", "RedHatAI", "NousResearch"]) candidates.add(`${org}/${name}`);
  const skip = /gguf|awq|gptq|fp8|bnb|mlx|4bit|8bit|exl|abliterat|nvfp4|int4|w4a16|w8a8/i;
  for (const name of names) {
    const hits = await getJson<{ id: string }[]>(`${HF}/api/models?search=${encodeURIComponent(name)}&limit=30`);
    for (const h of hits.body ?? []) {
      const own = h.id.split("/")[1]?.toLowerCase();
      if (own === name.toLowerCase() && !skip.test(h.id)) candidates.add(h.id);
    }
  }
  for (const mid of candidates) {
    const m = await api(mid);
    if (!m.body || m.body.gated) continue;
    if (total && m.body.safetensors?.total !== total) continue;
    if (type && m.body.config?.model_type !== type) continue;
    const c = await config(mid, m.body.sha);
    if (c.body) return { id: mid, cfg: c.body, info: m.body };
  }
  return null;
}

async function readModel(job: Job): Promise<Result> {
  const ov = overrides[job.hfId];
  const prev = previous?.models[job.hfId];
  const info = await api(job.hfId);
  // Only "gone or private" may turn a repo unverified; anything else is Hugging Face having a bad day.
  if (!info.body && !GONE.has(info.status)) throw new Error(`model API ${info.status}`);

  // Repo gone or private: a hand-checked mirror with the same weights, else unverified.
  let src = info.body;
  let source = "repo";
  let readFrom = info.body?.id ?? job.hfId;
  if (!src && ov?.mirror) {
    const m = await api(ov.mirror);
    if (!m.body && !GONE.has(m.status)) throw new Error(`mirror API ${m.status}`);
    if (m.body) {
      src = m.body;
      source = `mirror:${ov.mirror}`;
      readFrom = ov.mirror;
    }
  }
  if (!src || ov?.status === "unverified") {
    return { record: unverified(job, ov, info.status), reused: false };
  }
  // Unchanged repo, overrides and parser: reuse the record, unless the last read fell back to config arithmetic.
  const print = fingerprint(ov);
  if (!args.all && prev && prev.sha === src.sha && prev.status === "open" && prev.fingerprint === print && (prev.groups.source === "headers" || prev.paramsSource !== "safetensors")) {
    return { record: { ...prev, checkedOn: TODAY }, reused: true };
  }

  const files = await tree(readFrom);
  let cfgRes = await config(readFrom, src.sha);
  if (!cfgRes.body && !GONE.has(cfgRes.status)) throw new Error(`config.json ${cfgRes.status}`);
  let cfg = cfgRes.body;
  let headerFrom = readFrom;
  let headerSha = src.sha ?? null;
  let mirrorTotal: number | undefined;
  if (!cfg && src.gated) {
    const names = [...new Set([job.hfId.split("/")[1], readFrom.split("/")[1]])];
    const mirror = await resolveMirror(names, src);
    if (mirror) {
      cfg = mirror.cfg;
      source = `mirror:${mirror.id}`;
      headerFrom = mirror.id;
      headerSha = mirror.info.sha ?? null;
    }
  }
  if (!cfg && ov?.donor) {
    const d = await api(ov.donor);
    cfgRes = await config(ov.donor, d.body?.sha);
    cfg = cfgRes.body;
    if (cfg) {
      source = `donor:${ov.donor}`;
      mirrorTotal = d.body?.safetensors?.total;
    }
  }
  if (!cfg) throw new Error(`no usable config.json (${cfgRes.status})`);
  const arch = parseConfig(cfg);

  // Parameter count and checkpoint.
  const st = shards(files);
  const gguf = files.filter((f) => f.type === "file" && f.path.endsWith(".gguf") && !/mmproj/i.test(f.path));
  const bins = files.filter((f) => f.type === "file" && /\.bin$/.test(f.path) && /pytorch_model/.test(f.path));
  const qbits = Number((cfg.quantization_config as Cfg | undefined)?.bits ?? 4);
  let params = src.safetensors?.total ?? 0;
  let paramsSource: WeightsRecord["paramsSource"] = source.startsWith("mirror") && !info.body ? "mirror" : "safetensors";
  let groups: TensorGroups;
  let checkpointBytes: number | null = st.length ? st.reduce((s, f) => s + fileSize(f), 0) : null;
  // A gated repo's index and headers are gated too: read the mirror's (same weights).
  const headerShards = headerFrom === readFrom ? st : shards(await tree(headerFrom));
  if (!checkpointBytes && headerShards.length) checkpointBytes = headerShards.reduce((s, f) => s + fileSize(f), 0);

  if (!params && gguf.length && !st.length) {
    params = src.gguf?.total ?? 0;
    paramsSource = "gguf";
  } else if (!params && bins.length && !st.length) {
    const dtype = String(cfg.torch_dtype ?? "float16");
    const bytes = bins.reduce((s, f) => s + fileSize(f), 0);
    checkpointBytes = bytes;
    params = Math.round(bytes / (dtype === "float32" ? 4 : 2));
    paramsSource = "pickle";
  } else if (!params && mirrorTotal) {
    params = mirrorTotal;
    paramsSource = "mirror";
  }
  if (!params) throw new Error("no parameter count");

  if (headerShards.length) {
    try {
      groups = await census(headerFrom, headerSha, headerShards, params, arch, qbits);
    } catch (e) {
      console.error(`  ${job.hfId}: headers unreadable (${(e as Error).message}); groups from config`);
      groups = groupsFromConfig(params, arch.dims, arch.moe);
    }
  } else {
    groups = groupsFromConfig(params, arch.dims, arch.moe);
  }

  const bits = checkpointBytes ? (8 * checkpointBytes) / params : 0;
  let format: NativeFormat = gguf.length && !st.length ? "gguf" : nativeFormat(src, cfg);
  // A donor's config can't say how the original ships; the checkpoint size can.
  if (format === "bf16" && bits && bits < 12) format = bits >= 7 ? "fp8" : "int4";

  // Active parameters, for display only: the card's figure, then the name, then the split.
  let active: WeightsRecord["active"] = null;
  if (arch.moe) {
    const named = paramsFromName(`${job.hfId} ${job.name}`)?.active;
    const split = activeFromGroups(params, groups, arch.moe);
    if (ov?.active_b) active = { params: ov.active_b * 1e9, source: "card" };
    else if (named) active = { params: named, source: "name" };
    else if (split) active = { params: split, source: "headers" };
  }

  const notes: string[] = [];
  if (ov?.note) notes.push(ov.note);
  if (ov?.kv_note) notes.push(ov.kv_note);
  if (source.startsWith("mirror:") && src.gated) notes.push(`The repo is gated; its architecture was read from the public copy ${source.slice(7)}, which has the same parameter total.`);
  if (source.startsWith("donor:")) notes.push(`Architecture from ${source.slice(6)}.`);
  if (format === "f32" && !ov?.note) notes.push("The checkpoint is stored in F32, twice what anyone serves; it is sized as BF16.");
  if (format !== "gguf" && !(bits > 0)) throw new Error("checkpoint size unknown");

  return {
    reused: false,
    record: {
      hfId: job.hfId,
      resolvedId: src.id ?? job.hfId,
      sha: src.sha ?? null,
      checkedOn: TODAY,
      status: "open",
      source,
      gated: Boolean(src.gated),
      licence: licenceOf(info.body ?? src),
      params,
      paramsSource,
      groups,
      active,
      checkpointBytes,
      // F32 checkpoints keep their 32 bits so the estimator halves them, as vLLM serves them at 16.
      native: { format: format === "f32" ? "bf16" : format, bits: Math.round(bits * 1000) / 1000 },
      ...(gguf.length && !st.length ? { ggufFiles: gguf.map((f) => ({ name: f.path, bytes: fileSize(f) })).sort((a, b) => a.bytes - b.bytes) } : {}),
      arch,
      notes,
      fingerprint: print,
    },
  };
}

/** What a record was derived with besides the repo: its override entry and the parser version. */
function fingerprint(ov: Override | undefined): string {
  return createHash("sha1").update(`${PARSER_VERSION}:${JSON.stringify(ov ?? null)}`).digest("hex").slice(0, 12);
}

function unverified(job: Job, ov: Override | undefined, status: number): WeightsRecord {
  return {
    hfId: job.hfId,
    resolvedId: job.hfId,
    sha: null,
    checkedOn: TODAY,
    status: "unverified",
    source: "none",
    gated: false,
    licence: { id: null, name: null, link: null },
    params: 0,
    paramsSource: "override",
    groups: { embed: 0, head: 0, experts: 0, mtp: 0, vision: 0, lookup: 0, source: "config" },
    active: null,
    checkpointBytes: null,
    native: { format: "bf16", bits: 16 },
    arch: null,
    notes: [ov?.note ?? `OpenRouter links a Hugging Face repo we couldn't open (HTTP ${status}).`],
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const jobs = new Map<string, Job>();
  for (const m of catalog) if (m.hf_id && !jobs.has(m.hf_id)) jobs.set(m.hf_id, { hfId: m.hf_id, name: m.display_name });
  const list = [...jobs.values()];
  console.error(`reading ${list.length} Hugging Face repos${args.all ? " (all)" : ""}`);

  let failed = 0;
  const results = await pool(list, 3, async (job) => {
    try {
      const r = await readModel(job);
      if (!r.reused) console.error(`  ${job.hfId}: ${r.record?.status} · ${r.record?.arch?.kv.family ?? "-"} · ${r.record?.groups.source ?? "-"}`);
      return r;
    } catch (e) {
      failed++;
      const prev = previous?.models[job.hfId];
      console.error(`  ${job.hfId}: FAILED (${(e as Error).message})${prev ? "; keeping the last good record" : ""}`);
      return { record: prev ?? null, reused: true, error: (e as Error).message } satisfies Result;
    }
  });

  if (failed > list.length * 0.2) {
    console.error(`${failed} of ${list.length} repos failed; keeping the previous ${OUT}`);
    process.exitCode = 1;
    return;
  }

  const models: WeightsFile["models"] = {};
  for (const r of results.filter((x) => x.record).sort((a, b) => a.record!.hfId.localeCompare(b.record!.hfId))) models[r.record!.hfId] = r.record!;
  const file: WeightsFile = { asOf: TODAY, models };
  writeFileSync(OUT, `{"asOf":${JSON.stringify(TODAY)},"models":{\n${Object.entries(models).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n")}\n}}\n`);

  const index: WeightsIndexFile = { asOf: file.asOf, models: {} };
  for (const m of catalog) {
    const r = m.hf_id ? models[m.hf_id] : undefined;
    if (!r) continue;
    index.models[m.key] = {
      status: r.status,
      licence: classifyLicence(r.licence),
      licenceLabel: licenceLabel(r.licence),
      total: r.params,
      active: r.active?.params ?? null,
      moe: Boolean(r.arch?.moe),
      gated: r.gated,
      native: r.native.format,
    };
  }
  writeFileSync(INDEX, `{"asOf":${JSON.stringify(index.asOf)},"models":{\n${Object.entries(index.models).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n")}\n}}\n`);

  const recs = Object.values(models);
  const conf = (c: string) => recs.filter((r) => r.arch?.kv.confidence === c).length;
  console.error(
    `weights: ${recs.filter((r) => r.status === "open").length} open, ${recs.filter((r) => r.status === "unverified").length} unverified · ` +
      `KV plans high ${conf("high")} / medium ${conf("medium")} / low ${conf("low")} · groups from headers ${recs.filter((r) => r.groups.source === "headers").length} · ` +
      `${results.filter((r) => r.reused).length} reused, ${failed} failed`,
  );
}

await main();
