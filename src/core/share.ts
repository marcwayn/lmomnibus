import type { Rate, Workload } from "./cost.ts";
import { FILTER_LABEL, type Filter, type Index } from "./frontier.ts";
import type { RateMode } from "./model.ts";
import { DEFAULT_PRESET, presetById, type PresetId } from "./presets.ts";

/**
 * Readable, hand-editable URL state (see "URL as state" in SCHEMATIC.html):
 *
 *   /tools/cost?m=anthropic:claude-opus-5,openai:gpt-6-sol&p=agent&r=50000
 *
 * - m      benched models; a key's first "/" is written ":" (only the first,
 *          so keys like "qwen/qwen-plus:thinking" round-trip)
 * - p      preset id; i/o/r/c/w (input, output, requests, cache read %,
 *          cache write %) and rate=batch|standard appear only where they
 *          differ from it
 * - fast/batch/std   per-model mode pins, comma-separated keys
 * - idx    index for verdicts (intelligence is the default)
 *
 * No base64 and no hash state: a person pasting this into a chat should be
 * able to read it, and fix a number by editing it.
 */
export const MAX_BENCH = 12;
const U32_MAX = 4_294_967_295;

export interface Scenario {
  models: string[];
  /** The preset the numbers start from; null when every number is custom. */
  preset: PresetId | null;
  workload: Workload;
  rate: Rate;
  modes: Map<string, RateMode>;
  index: Index;
}

export function encodeKey(key: string): string {
  return key.replace("/", ":");
}

export function decodeKey(s: string): string {
  return s.replace(":", "/");
}

const INDEXES: Index[] = ["intelligence", "coding", "agentic"];
const MODE_PARAMS: [string, RateMode][] = [
  ["fast", "Fast"],
  ["batch", "Batch"],
  ["std", "Standard"],
];

/** Percent-encode a value but leave the characters that keep it readable. */
function readable(v: string): string {
  return encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%2F/gi, "/");
}

function toQuery(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${k}=${readable(v)}`).join("&");
}

function parseCount(raw: string | null, fallback: number, max: number): number {
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback;
  return Math.min(Number(raw), max);
}

export function encodeScenario(s: Scenario): string {
  const base = (s.preset && presetById(s.preset)) || null;
  const ref = base ?? DEFAULT_PRESET;
  const pairs: [string, string][] = [];
  if (s.models.length) pairs.push(["m", s.models.map(encodeKey).join(",")]);
  if (base) pairs.push(["p", base.id]);
  const fields: [keyof Workload, string][] = [
    ["inputTokens", "i"],
    ["outputTokens", "o"],
    ["requestsPerMonth", "r"],
    ["cachedPct", "c"],
    ["cacheWritePct", "w"],
  ];
  for (const [field, param] of fields) {
    if (!base || s.workload[field] !== ref.workload[field]) pairs.push([param, String(s.workload[field])]);
  }
  if (!base || s.rate !== ref.rate) pairs.push(["rate", s.rate.toLowerCase()]);
  for (const [param, mode] of MODE_PARAMS) {
    const pinned = [...s.modes].filter(([, m]) => m === mode).map(([k]) => encodeKey(k));
    if (pinned.length) pairs.push([param, pinned.join(",")]);
  }
  if (s.index !== "intelligence") pairs.push(["idx", s.index]);
  return toQuery(pairs);
}

export function decodeScenario(params: URLSearchParams): Scenario {
  const preset = presetById(params.get("p"));
  const ref = preset ?? DEFAULT_PRESET;
  const models = [
    ...new Set(
      (params.get("m") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(decodeKey),
    ),
  ].slice(0, MAX_BENCH);
  const workload: Workload = {
    inputTokens: parseCount(params.get("i"), ref.workload.inputTokens, U32_MAX),
    outputTokens: parseCount(params.get("o"), ref.workload.outputTokens, U32_MAX),
    requestsPerMonth: parseCount(params.get("r"), ref.workload.requestsPerMonth, U32_MAX),
    cachedPct: parseCount(params.get("c"), ref.workload.cachedPct, 100),
    cacheWritePct: parseCount(params.get("w"), ref.workload.cacheWritePct, 100),
  };
  // Read + write share one 100% of input; clamp so the workload shown is the one priced.
  workload.cacheWritePct = Math.min(workload.cacheWritePct, 100 - workload.cachedPct);
  const rateParam = params.get("rate")?.toLowerCase();
  const rate: Rate = rateParam === "batch" ? "Batch" : rateParam === "standard" ? "Standard" : ref.rate;
  const modes = new Map<string, RateMode>();
  for (const [param, mode] of MODE_PARAMS) {
    for (const k of (params.get(param) ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      modes.set(decodeKey(k), mode);
    }
  }
  const idx = params.get("idx") as Index | null;
  return {
    models,
    preset: preset ? preset.id : null,
    workload,
    rate,
    modes,
    index: idx && INDEXES.includes(idx) ? idx : "intelligence",
  };
}

/** True when the URL carries any scenario state worth restoring. */
export function hasScenario(params: URLSearchParams): boolean {
  return ["m", "p", "i", "o", "r", "c", "w", "rate"].some((k) => params.has(k));
}

// ---- Frontier: ?p=agent&y=coding&min=45&f=tools,img ----

export interface FrontierScenario {
  preset: PresetId | null;
  workload: Workload;
  rate: Rate;
  index: Index;
  minScore: number | null;
  filters: Set<Filter>;
}

const FILTERS = Object.keys(FILTER_LABEL) as Filter[];

export function encodeFrontier(s: FrontierScenario): string {
  const pairs = new URLSearchParams(encodeScenario({ ...s, models: [], modes: new Map(), index: "intelligence" }));
  const out: [string, string][] = [...pairs.entries()];
  if (s.index !== "intelligence") out.push(["y", s.index]);
  if (s.minScore !== null) out.push(["min", String(s.minScore)]);
  if (s.filters.size) out.push(["f", [...s.filters].join(",")]);
  return toQuery(out);
}

export function decodeFrontier(params: URLSearchParams): FrontierScenario {
  const base = decodeScenario(params);
  const y = params.get("y") as Index | null;
  const min = params.get("min");
  return {
    preset: base.preset,
    workload: base.workload,
    rate: base.rate,
    index: y && INDEXES.includes(y) ? y : "intelligence",
    minScore: min !== null && /^\d+(\.\d+)?$/.test(min) ? Math.min(Number(min), 100) : null,
    filters: new Set(
      (params.get("f") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((f): f is Filter => FILTERS.includes(f as Filter)),
    ),
  };
}
