/**
 * The one route table. App.tsx renders these routes and vite.config.ts writes
 * an HTML shell (title, description, link-preview tags) for each, so a route
 * can't exist in one place and be missing from the other. Kept free of heavy
 * imports so the build config can load it.
 */
export interface CatalogFacts {
  as_of: string;
  models: number;
}

export interface RouteInfo {
  path: string;
  /** Short nav label and tool number, for tools. */
  nav?: { num: string; label: string };
  title: string;
  description: (facts: CatalogFacts) => string;
  /** Link-preview image, relative to the site root. */
  ogImage: string;
}

export const ROUTES: readonly RouteInfo[] = [
  {
    path: "/",
    title: "LMOmnibus — what language models cost at your workload",
    description: (f) =>
      `Price ${f.models} language models at your own workload: cache reads and writes, Batch, long-context tiers. Prices as of ${f.as_of}.`,
    ogImage: "/og/home.png",
  },
  {
    path: "/tools/cost",
    nav: { num: "01", label: "Cost" },
    title: "Cost Calculator — LMOmnibus",
    description: (f) =>
      `Rank ${f.models} models by what your workload would cost: presets for chat, RAG, coding agents and batch jobs, cache-aware. Prices as of ${f.as_of}.`,
    ogImage: "/og/cost.png",
  },
  {
    path: "/tools/frontier",
    nav: { num: "02", label: "Frontier" },
    title: "Price–Capability Frontier — LMOmnibus",
    description: (f) =>
      `The cheapest model that clears your capability bar, priced at your workload. Artificial Analysis indices, prices as of ${f.as_of}.`,
    ogImage: "/og/frontier.png",
  },
  {
    path: "/tools/speed",
    nav: { num: "03", label: "Speed" },
    title: "Token Speed Simulator — LMOmnibus",
    description: () => "Feel what a token throughput means: pick a rate and an output length, then watch a response stream at that pace.",
    ogImage: "/og/speed.png",
  },
  {
    path: "/changes",
    nav: { num: "04", label: "Ledger" },
    title: "Price Ledger — LMOmnibus",
    description: (f) =>
      `What changed in language-model prices: vendor list-price moves, new listings, delistings and retirements, snapshot by snapshot. Latest ${f.as_of}.`,
    ogImage: "/og/ledger.png",
  },
  {
    path: "/tools/switch",
    nav: { num: "05", label: "Switch" },
    title: "Switch Planner — LMOmnibus",
    description: () =>
      "Leaving a language model? Ranked replacements at your workload: the saving, the score change, and what you'd give up.",
    ogImage: "/og/switch.png",
  },
  {
    path: "/tools/agent",
    nav: { num: "06", label: "Agent" },
    title: "Agent Loop — LMOmnibus",
    description: () =>
      "What an agent session costs as its context grows turn by turn, per model, and how much prompt caching saves.",
    ogImage: "/og/agent.png",
  },
  {
    path: "/tools/open",
    nav: { num: "07", label: "Open" },
    title: "Open Weights vs Closed — LMOmnibus",
    description: (f) =>
      `Open-weight (often called open-source) language models against closed ones: price at your workload, Artificial Analysis scores, how far the best open model trails, what you can run yourself, and licences. Prices as of ${f.as_of}.`,
    ogImage: "/og/open.png",
  },
  {
    path: "/tools/vram",
    nav: { num: "08", label: "VRAM" },
    title: "VRAM Estimator — LMOmnibus",
    description: () =>
      "Estimate the GPU memory an open-weight model needs at your context: weights at your format, KV cache, engine overhead, and which GPUs and Macs hold it. An estimate, with the arithmetic shown.",
    ogImage: "/og/vram.png",
  },
];

export const SITE_ORIGIN = "https://lmomnibus.pages.dev";

/** The document title for a route path, so pages and build-time shells agree. */
export function titleFor(path: string): string {
  return ROUTES.find((r) => r.path === path)?.title ?? "LMOmnibus";
}
