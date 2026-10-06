import type { Rate, Workload } from "../../core/cost.ts";
import type { Filter, Index } from "../../core/frontier.ts";
import type { LicenceFilter } from "../../core/openclosed.ts";
import { DEFAULT_PRESET, matchingPreset, type PresetId } from "../../core/presets.ts";
import { decodeFrontier, decodeKey, encodeKey, encodeScenario } from "../../core/share.ts";

/**
 * Tool 07's readable URL:
 *
 *   /tools/open?p=agent&y=coding&min=45&f=tools,img&lic=no-nc&vs=anthropic:claude-sonnet-5.5&tol=2&span=all&sq=q4_k_m&sctx=32k
 *
 * The workload (p, i, o, r, c, w, rate) and y/min/f use the Frontier's names
 * and parsing; everything at its default is left out.
 */

/** "open" and "scored" make no sense on a page that splits by weights and plots only rated models. */
export type OpenFilter = Exclude<Filter, "open" | "scored">;
export const OPEN_FILTERS: OpenFilter[] = ["tools", "img", "aud", "reasoning", "fits"];

export const TOLS = [0, 2, 5] as const;
export type Tol = (typeof TOLS)[number];

export type Span = "2y" | "all";

/** Weight formats offered for the self-host chart (llama.cpp GGUF), largest first. */
export const SELF_FORMATS = ["q8_0", "q6_k", "q5_k_m", "q4_k_m", "iq4_xs", "q3_k_m"] as const;
export type SelfFormat = (typeof SELF_FORMATS)[number];

export const SELF_CONTEXTS = { "8k": 8192, "32k": 32768, "128k": 131072 } as const;
export type SelfCtx = keyof typeof SELF_CONTEXTS;

const LICS: LicenceFilter[] = ["any", "permissive", "no-nc"];
const INDEXES: Index[] = ["intelligence", "coding", "agentic"];
const KNOWN = new Set(["p", "i", "o", "r", "c", "w", "rate", "y", "min", "f", "lic", "vs", "tol", "span", "all", "cov", "sq", "sctx"]);

export interface OpenScenario {
  preset: PresetId | null;
  workload: Workload;
  rate: Rate;
  index: Index;
  /** null = untouched: the target follows the default for the current index and filters. */
  minScore: number | null;
  filters: Set<OpenFilter>;
  lic: LicenceFilter;
  /** A closed catalog key to find an open-weight match for. */
  vs: string | null;
  tol: Tol;
  span: Span;
  all: boolean;
  cov: boolean;
  sq: SelfFormat;
  sctx: SelfCtx;
}

/** Targets move in half points. */
export const roundTarget = (v: number) => Math.min(100, Math.max(0, Math.round(v * 2) / 2));

/**
 * Reads the URL. `checkVs` says why a `vs` key can't be used (unknown,
 * open-weight, unverified), or null when it can. Anything dropped is listed
 * so the page can say so in one line.
 */
export function decodeOpen(params: URLSearchParams, checkVs: (key: string) => string | null): { scenario: OpenScenario; dropped: string[] } {
  const base = decodeFrontier(params);
  const dropped: string[] = [];
  for (const k of new Set(params.keys())) if (!KNOWN.has(k)) dropped.push(`${k}= (not used here)`);

  const filters = new Set<OpenFilter>();
  for (const raw of (params.get("f") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((OPEN_FILTERS as string[]).includes(raw)) filters.add(raw as OpenFilter);
    else dropped.push(raw === "open" || raw === "scored" ? `f=${raw} (this page splits by weights and plots rated models only)` : `f=${raw}`);
  }

  const y = params.get("y");
  if (y !== null && !INDEXES.includes(y as Index)) dropped.push(`y=${y}`);
  const minRaw = params.get("min");
  if (minRaw !== null && base.minScore === null) dropped.push(`min=${minRaw}`);

  const pick = <T extends string | number>(key: string, allowed: readonly T[], fallback: T, parse: (s: string) => T = (s) => s as T): T => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const v = parse(raw.trim());
    if (allowed.includes(v)) return v;
    dropped.push(`${key}=${raw}`);
    return fallback;
  };

  let vs: string | null = null;
  const vsRaw = params.get("vs");
  if (vsRaw) {
    const key = decodeKey(vsRaw.trim());
    const why = checkVs(key);
    if (why) dropped.push(`vs=${vsRaw} (${why})`);
    else vs = key;
  }

  return {
    scenario: {
      // Without p=, numbers are read against the default preset, so that's their base when written back.
      preset: base.preset ?? matchingPreset(base.workload, base.rate)?.id ?? DEFAULT_PRESET.id,
      workload: base.workload,
      rate: base.rate,
      index: base.index,
      minScore: base.minScore === null ? null : roundTarget(base.minScore),
      filters,
      lic: pick("lic", LICS, "any"),
      vs,
      tol: pick<Tol>("tol", TOLS, 0, (s) => Number(s) as Tol),
      span: pick<Span>("span", ["2y", "all"], "2y"),
      all: pick("all", ["1", "0"], "0") === "1",
      cov: pick("cov", ["t", "0"], "0") === "t",
      sq: pick<SelfFormat>("sq", SELF_FORMATS, "q4_k_m", (s) => s.toLowerCase() as SelfFormat),
      sctx: pick<SelfCtx>("sctx", Object.keys(SELF_CONTEXTS) as SelfCtx[], "32k", (s) => s.toLowerCase() as SelfCtx),
    },
    dropped,
  };
}

/** True when the URL carries anything: the page then rewrites it once in its normal form, without what it ignored. */
export function hasOpenState(params: URLSearchParams): boolean {
  return [...params.keys()].length > 0;
}

/** Writes the URL, leaving every default out (including a plain p=agent). */
export function encodeOpen(s: OpenScenario): string {
  const scenario = encodeScenario({ models: [], preset: s.preset, workload: s.workload, rate: s.rate, modes: new Map(), index: "intelligence" });
  const parts: string[] = scenario === `p=${DEFAULT_PRESET.id}` ? [] : [scenario];
  if (s.index !== "intelligence") parts.push(`y=${s.index}`);
  if (s.minScore !== null) parts.push(`min=${s.minScore}`);
  if (s.filters.size) parts.push(`f=${OPEN_FILTERS.filter((f) => s.filters.has(f)).join(",")}`);
  if (s.lic !== "any") parts.push(`lic=${s.lic}`);
  // Keep ":" readable in the key, as the bench URLs do.
  if (s.vs) parts.push(`vs=${encodeURIComponent(encodeKey(s.vs)).replace(/%3A/gi, ":")}`);
  if (s.tol) parts.push(`tol=${s.tol}`);
  if (s.span !== "2y") parts.push(`span=${s.span}`);
  if (s.all) parts.push("all=1");
  if (s.cov) parts.push("cov=t");
  if (s.sq !== "q4_k_m") parts.push(`sq=${s.sq}`);
  if (s.sctx !== "32k") parts.push(`sctx=${s.sctx}`);
  return parts.filter(Boolean).join("&");
}
