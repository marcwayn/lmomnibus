// Fetches the OpenRouter model catalog, normalizes it, applies curated
// corrections from data/overrides.json, and writes data/catalog.json — the
// file the app bundles at build time.
//
//   npm run ingest                          # fetch live, write data/catalog.json
//   npm run ingest -- --feed saved.json     # normalize a saved feed instead
//   npm run ingest -- --out other.json      # write somewhere else
//
// Runs directly on Node 23.6+ (native TypeScript), no build step. Prices stay
// decimal strings end to end — never parsed into JS numbers.

import Big from "big.js";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const FEED_URL = "https://openrouter.ai/api/v1/models";
const OVERRIDES_PATH = "data/overrides.json";

type RateMode = "Standard" | "Batch" | "Fast";

interface OrTierOverride {
  /**
   * Absent on time-of-day discount tiers (`utc_start`/`utc_end`) rather than
   * context-length tiers — those aren't modeled, so entries without this
   * field are skipped rather than misread as a token tier.
   */
  min_prompt_tokens?: number | null;
  prompt?: string | null;
  completion?: string | null;
  input_cache_read?: string | null;
}

interface OrModel {
  id: string;
  name: string;
  created: number;
  context_length?: number | null;
  architecture?: { modality?: string };
  pricing: {
    prompt?: string | null;
    completion?: string | null;
    input_cache_read?: string | null;
    input_cache_write?: string | null;
    overrides?: OrTierOverride[] | null;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  /** Present when this id is a pointer/alias to another model; alias rows are skipped. */
  alias_target?: unknown;
  benchmarks?: {
    artificial_analysis?: {
      intelligence_index?: number | null;
      coding_index?: number | null;
      agentic_index?: number | null;
    } | null;
  } | null;
}

interface OverrideEntry {
  key: string;
  mode: string;
  input?: string;
  output?: string;
  promo?: { input: string; output: string; until: string };
}

// Field order matches what the app has always read; keep it stable so a
// re-ingest diffs cleanly.
interface CatalogRateCard {
  input: string;
  output: string;
  cache_read: string | null;
  cache_write: string | null;
  tiers: { above_input_tokens: number; input: string; output: string; cache_read: string | null }[];
  promo: { input: string; output: string; until: string } | null;
}

interface CatalogModel {
  key: string;
  display_name: string;
  vendor_key: string;
  vendor_name: string;
  released: { year: number; month: number };
  knowledge_cutoff: string | null;
  context_tokens: number;
  max_output_tokens: number | null;
  modality: string;
  capabilities: { tools: boolean; reasoning: boolean; structured_output: boolean };
  scores: { intelligence: number | null; coding: number | null; agentic: number | null } | null;
  rates: [RateMode, CatalogRateCard][];
  provenance: "FirstParty" | "Aggregate";
}

const { values: args } = parseArgs({
  options: { feed: { type: "string" }, out: { type: "string", default: "data/catalog.json" } },
});

async function main() {
  const raw = await loadFeed(args.feed);
  console.error(`fetched ${raw.length} raw entries from ${args.feed ?? FEED_URL}`);

  const models = normalize(raw);
  console.error(`normalized to ${models.length} priced models`);

  applyOverrides(models);

  writeFileSync(args.out!, JSON.stringify(models, null, 2));
  console.error(`wrote ${args.out} (${models.length} models)`);
}

async function loadFeed(path: string | undefined): Promise<OrModel[]> {
  if (path) return JSON.parse(readFileSync(path, "utf8")).data;
  const resp = await fetch(FEED_URL, { headers: { "user-agent": "lmo-ingest/0.1" } });
  if (!resp.ok) throw new Error(`OpenRouter models feed returned ${resp.status}`);
  return (await resp.json()).data;
}

/** Vendor display names for known prefixes; anything else is title-cased from its slug. */
const KNOWN_VENDORS: Record<string, string> = {
  anthropic: "Anthropic",
  "~anthropic": "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistralai: "Mistral AI",
  "meta-llama": "Meta",
  "x-ai": "xAI",
  "z-ai": "Z.ai",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "Moonshot AI",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  cohere: "Cohere",
  amazon: "Amazon",
  perplexity: "Perplexity",
  inclusionai: "InclusionAI",
  poolside: "Poolside",
  "aion-labs": "AionLabs",
  "bytedance-seed": "ByteDance Seed",
  openrouter: "OpenRouter",
  thedrummer: "TheDrummer",
};

function vendorName(vendorKey: string): string {
  return (
    KNOWN_VENDORS[vendorKey] ??
    vendorKey
      .split(/[-_]/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ")
  );
}

function stripVendorPrefix(name: string): string {
  const idx = name.indexOf(": ");
  return idx === -1 ? name : name.slice(idx + 2);
}

/**
 * Dollars-per-token string -> USD/MTok string, exactly. Keeps the input's
 * decimal places ("0.000000625" -> "0.625000000") so the committed catalog
 * doesn't churn formatting between ingest runs.
 */
function perTokenToPerMTok(s: string | null | undefined): string | null {
  if (s == null) return null;
  try {
    const scale = (s.split(".")[1] ?? "").length;
    return new Big(s).times(1_000_000).toFixed(scale);
  } catch {
    return null;
  }
}

function detectSuffix(id: string): [string, RateMode] {
  if (id.endsWith(":batch")) return [id.slice(0, -":batch".length), "Batch"];
  if (id.endsWith("-fast")) return [id.slice(0, -"-fast".length), "Fast"];
  return [id, "Standard"];
}

function normalize(raw: OrModel[]): CatalogModel[] {
  // Pass 1: drop alias pointers and marketing ":free" duplicates, group the
  // rest by base id so batch/fast variants fold into one model instead of
  // appearing as separate catalog rows.
  const groups = new Map<string, [RateMode, OrModel][]>();
  for (const m of raw) {
    if (m.alias_target != null || m.id.endsWith(":free")) continue;
    const [baseId, mode] = detectSuffix(m.id);
    if (!groups.has(baseId)) groups.set(baseId, []);
    groups.get(baseId)!.push([mode, m]);
  }

  const models: CatalogModel[] = [];
  for (const baseId of [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const entries = groups.get(baseId)!;
    // Prefer the Standard entry as the metadata source; else the most recently created.
    entries.sort(
      ([ma, a], [mb, b]) => (ma === "Standard" ? 0 : 1) - (mb === "Standard" ? 0 : 1) || b.created - a.created,
    );
    const primary = entries[0][1];
    const vendorKey = baseId.split("/")[0].replace(/^~+/, "");

    const capabilities = { tools: false, reasoning: false, structured_output: false };
    for (const [, e] of entries) {
      for (const p of e.supported_parameters ?? []) {
        if (p === "tools") capabilities.tools = true;
        if (p === "reasoning" || p === "reasoning_effort") capabilities.reasoning = true;
        if (p === "response_format" || p === "structured_outputs") capabilities.structured_output = true;
      }
    }

    const aa = primary.benchmarks?.artificial_analysis;
    const scores =
      aa && (aa.intelligence_index != null || aa.coding_index != null || aa.agentic_index != null)
        ? {
            intelligence: aa.intelligence_index ?? null,
            coding: aa.coding_index ?? null,
            agentic: aa.agentic_index ?? null,
          }
        : null;

    const rates: [RateMode, CatalogRateCard][] = [];
    for (const [mode, e] of entries) {
      const input = perTokenToPerMTok(e.pricing.prompt);
      const output = perTokenToPerMTok(e.pricing.completion);
      if (input === null || output === null) continue;
      // Routers publish -1 as "price varies by the model routed to", and a few
      // non-text models list $0/$0 while billing some other way. Neither is a
      // rate a cost calculator can use.
      const bi = new Big(input);
      const bo = new Big(output);
      if (bi.lt(0) || bo.lt(0) || (bi.eq(0) && bo.eq(0))) continue;

      const tiers = (e.pricing.overrides ?? [])
        .flatMap((t) => {
          const tin = perTokenToPerMTok(t.prompt);
          const tout = perTokenToPerMTok(t.completion);
          if (t.min_prompt_tokens == null || tin === null || tout === null) return [];
          return [
            {
              above_input_tokens: t.min_prompt_tokens,
              input: tin,
              output: tout,
              cache_read: perTokenToPerMTok(t.input_cache_read),
            },
          ];
        })
        .sort((a, b) => a.above_input_tokens - b.above_input_tokens);

      rates.push([
        mode,
        {
          input,
          output,
          cache_read: perTokenToPerMTok(e.pricing.input_cache_read),
          cache_write: perTokenToPerMTok(e.pricing.input_cache_write),
          tiers,
          promo: null,
        },
      ]);
    }

    // Can't price it — nothing for a cost calculator to say.
    if (rates.length === 0) continue;

    const created = new Date(primary.created * 1000);
    models.push({
      key: baseId,
      display_name: stripVendorPrefix(primary.name),
      vendor_key: vendorKey,
      vendor_name: vendorName(vendorKey),
      released: { year: created.getUTCFullYear(), month: created.getUTCMonth() + 1 },
      knowledge_cutoff: null,
      context_tokens: primary.context_length ?? 0,
      max_output_tokens: primary.top_provider?.max_completion_tokens ?? null,
      modality: primary.architecture?.modality ?? "",
      capabilities,
      scores,
      rates,
      provenance: "Aggregate",
    });
  }
  return models;
}

const MODE_NAMES: Record<string, RateMode> = { standard: "Standard", batch: "Batch", fast: "Fast" };

function isDecimal(s: string | undefined): s is string {
  if (s === undefined) return false;
  try {
    new Big(s);
    return true;
  } catch {
    return false;
  }
}

function applyOverrides(models: CatalogModel[]) {
  const overrides: OverrideEntry[] = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8"));
  for (const o of overrides) {
    const model = models.find((m) => m.key === o.key);
    if (!model) {
      console.error(`warning: override key "${o.key}" not found in feed, skipping`);
      continue;
    }
    const mode = MODE_NAMES[o.mode];
    if (!mode) {
      console.error(`warning: unknown override mode "${o.mode}" for ${o.key}`);
      continue;
    }
    const card = model.rates.find(([m]) => m === mode)?.[1];
    if (!card) {
      console.error(`warning: override for ${o.key} has no matching rate mode ${mode} from feed`);
      continue;
    }
    if (isDecimal(o.input)) card.input = o.input;
    if (isDecimal(o.output)) card.output = o.output;
    if (o.promo && isDecimal(o.promo.input) && isDecimal(o.promo.output)) {
      card.promo = { input: o.promo.input, output: o.promo.output, until: o.promo.until };
    }
    model.provenance = "FirstParty";
  }
}

await main();
