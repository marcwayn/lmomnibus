import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import Big from "big.js";
import { fmtRate } from "./src/core/fmt.ts";
import { ROUTES, SITE_ORIGIN, type CatalogFacts, type RouteInfo } from "./src/routes.ts";

const HEAD_MARKER = /<!-- route-head:[\s\S]*?<!-- \/route-head -->/;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface PageMeta {
  title: string;
  description: string;
  /** Site path for og:url and the canonical link; null only for the 404 page. */
  path: string | null;
  image: string;
  /** Keep out of search results (404, tombstones), but still point og:url at the page. */
  noindex?: boolean;
}

const routeMeta = (route: RouteInfo | null, facts: CatalogFacts): PageMeta =>
  route
    ? { title: route.title, description: route.description(facts), path: route.path, image: route.ogImage }
    : { title: "Page not found — LMOmnibus", description: "This page doesn't exist.", path: null, image: "/og/home.png" };

function headFor(page: PageMeta, preloads: string[]): string {
  const { title, description } = page;
  const url = page.path ? `${SITE_ORIGIN}${page.path}` : SITE_ORIGIN;
  const image = `${SITE_ORIGIN}${page.image}`;
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}" />`,
    page.path && !page.noindex ? `<link rel="canonical" href="${url}" />` : `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="LMOmnibus" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="theme-color" content="#E7EAE4" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#0C110E" media="(prefers-color-scheme: dark)" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<link rel="alternate" type="application/atom+xml" title="LMOmnibus price ledger" href="/changes.xml" />`,
    ...preloads.map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`),
  ].join("\n    ");
}

/**
 * Writes an HTML shell per route with its own title, description and
 * link-preview tags, plus 404.html, robots.txt and sitemap.xml.
 *
 * Every route needs a real file anyway: Pages' edge cache only refreshes the
 * cached copy of paths that exist as files in a deploy, so a route served only
 * by fallback can keep a stale page for days. Adding 404.html turns off Pages'
 * SPA fallback, so unknown paths now get a real 404 — which is why the route
 * list comes from src/routes.ts, the same table App.tsx renders.
 */
function routeShells(): Plugin {
  let outDir = "dist";
  return {
    name: "route-shells",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      const facts: CatalogFacts = JSON.parse(readFileSync("data/catalog-meta.json", "utf8"));
      const template = readFileSync(join(outDir, "index.html"), "utf8");
      const assets = readdirSync(join(outDir, "assets"));
      // Preload the two faces every page paints first.
      const preloads = [/^archivo-latin-wdth-normal-.*\.woff2$/, /^ibm-plex-mono-latin-400-normal-.*\.woff2$/]
        .map((re) => assets.find((f) => re.test(f)))
        .filter((f): f is string => Boolean(f))
        .map((f) => `/assets/${f}`);

      const render = (page: PageMeta) => template.replace(HEAD_MARKER, headFor(page, preloads));
      const write = (path: string, page: PageMeta) => {
        const file = path === "/" ? join(outDir, "index.html") : join(outDir, `${path.slice(1)}.html`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, render(page));
      };
      for (const route of ROUTES) write(route.path, routeMeta(route, facts));
      writeFileSync(join(outDir, "404.html"), render(routeMeta(null, facts)));

      // A spec page per model, and a tombstone for each delisted one so old
      // links land somewhere useful instead of a 404.
      const catalog: CatalogRow[] = JSON.parse(readFileSync("data/catalog.json", "utf8"));
      for (const m of catalog) write(`/models/${m.key}`, modelMeta(m, facts));
      const listed = new Set(catalog.map((m) => m.key));
      const removed = readTape().filter((c) => c.kind === "removed" && !listed.has(c.key));
      for (const c of removed) {
        write(`/models/${c.key}`, {
          title: `${c.name} (no longer listed) — LMOmnibus`,
          description: `${c.name} is no longer in the LMOmnibus catalog (delisted in the ${c.date} snapshot). Find a replacement at your workload.`,
          path: `/models/${c.key}`,
          image: "/og/home.png",
          noindex: true,
        });
      }

      writeOpenData(outDir, facts);
      writeChangeFeeds(outDir, facts);

      writeFileSync(join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
      const urls = [...ROUTES.map((r) => r.path), ...catalog.map((m) => `/models/${m.key}`)]
        .map((p) => `  <url><loc>${SITE_ORIGIN}${p}</loc><lastmod>${facts.as_of}</lastmod></url>`)
        .join("\n");
      writeFileSync(
        join(outDir, "sitemap.xml"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      );
    },
  };
}

/**
 * /catalog.json: the normalized catalog for anyone to build on, and
 * /llms.txt: how the instruments and their URLs work, for coding assistants.
 * Artificial Analysis scores are left out of the bulk file until their
 * redistribution terms are confirmed; everything else is OpenRouter's public
 * feed plus hand-checked list prices.
 */
function writeOpenData(outDir: string, facts: CatalogFacts) {
  const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8")) as Record<string, unknown>[];
  const models = catalog.map(({ scores: _scores, ...rest }) => rest);
  writeFileSync(
    join(outDir, "catalog.json"),
    JSON.stringify({
      schema_version: 1,
      as_of: facts.as_of,
      source: "OpenRouter /api/v1/models (aggregate prices), with price lists marked checked: true verified by hand against the vendor",
      attribution: `LMOmnibus, ${SITE_ORIGIN} — MIT. Prices are USD per 1M tokens, exact decimal strings.`,
      notes: [
        "rates: [mode, card] pairs; mode is Standard, Batch or Fast.",
        "tiers: long-context tiers price the whole request at the tier the prompt clears.",
        "Artificial Analysis capability indices are omitted from this file.",
      ],
      models,
    }),
  );
  writeFileSync(join(outDir, "llms.txt"), llmsTxt(facts));
}

interface CatalogRow {
  key: string;
  display_name: string;
  vendor_name: string;
  context_tokens: number;
  provenance: "FirstParty" | "Aggregate";
  rates: [string, { input: string; output: string; checked?: boolean }][];
}

const usd = (s: string) => fmtRate(new Big(s));

function modelMeta(m: CatalogRow, facts: CatalogFacts): PageMeta {
  const card = (m.rates.find(([mode]) => mode === "Standard") ?? m.rates[0])[1];
  const source = card.checked ? "vendor list price" : "OpenRouter aggregate";
  const ctx = m.context_tokens >= 1_000_000 ? `${Math.round(m.context_tokens / 100_000) / 10}M` : `${Math.round(m.context_tokens / 1000)}K`;
  return {
    title: `${m.display_name.trim()} pricing and specs — LMOmnibus`,
    description: `${m.display_name.trim()} by ${m.vendor_name}: ${usd(card.input)} in / ${usd(card.output)} out per 1M tokens (${source}), ${ctx} context. Cost at chat, RAG and coding-agent workloads; prices as of ${facts.as_of}.`,
    path: `/models/${m.key}`,
    image: `/og/models/${m.key}.png`,
  };
}

function readTape(): TapeEntry[] {
  return existsSync("data/changes.jsonl")
    ? readFileSync("data/changes.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

interface TapeEntry {
  date: string;
  vendor?: string;
  since: string;
  kind: string;
  key: string;
  name: string;
  mode?: string;
  input?: [string, string];
  output?: [string, string];
}

/** /changes.json (the tape) and /changes.xml (Atom, one entry per snapshot). */
function writeChangeFeeds(outDir: string, facts: CatalogFacts) {
  const tape = readTape();
  writeFileSync(join(outDir, "changes.json"), JSON.stringify({ as_of: facts.as_of, changes: tape }));

  const dates = [...new Set(tape.map((c) => c.date))].sort().reverse();
  const count = (day: TapeEntry[], kind: string) => day.filter((c) => c.kind === kind).length;
  const entries = dates.map((date) => {
    const day = tape.filter((c) => c.date === date);
    const list = day.filter((c) => c.kind === "list_price");
    const added = day.filter((c) => c.kind === "added");
    const summary = [
      `${list.length} vendor list-price change${list.length === 1 ? "" : "s"}, ${added.length} new, ${count(day, "removed")} delisted, ${count(day, "aggregate_move")} aggregate moves (compared with ${day[0].since}).`,
      ...list.map((c) => `${c.name} (${c.mode}): input ${c.input![0]} → ${c.input![1]}, output ${c.output![0]} → ${c.output![1]} USD/MTok`),
      ...(added.length ? [`New: ${added.map((c) => c.name).join(", ")}`] : []),
    ];
    return [
      "  <entry>",
      `    <id>tag:lmomnibus.pages.dev,${date}:changes</id>`,
      `    <title>Snapshot ${date}: ${list.length} list-price change${list.length === 1 ? "" : "s"}, ${added.length} new, ${count(day, "removed")} delisted</title>`,
      `    <updated>${date}T06:00:00Z</updated>`,
      `    <link href="${SITE_ORIGIN}/changes#${date}" />`,
      `    <content type="text">${escape(summary.join("\n"))}</content>`,
      "  </entry>",
    ].join("\n");
  });
  writeFileSync(
    join(outDir, "changes.xml"),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<feed xmlns="http://www.w3.org/2005/Atom">',
      "  <title>LMOmnibus price ledger</title>",
      `  <id>${SITE_ORIGIN}/changes</id>`,
      `  <link href="${SITE_ORIGIN}/changes" />`,
      `  <link rel="self" href="${SITE_ORIGIN}/changes.xml" />`,
      `  <updated>${(dates[0] ?? facts.as_of)}T06:00:00Z</updated>`,
      "  <author><name>LMOmnibus</name></author>",
      ...entries,
      "</feed>",
      "",
    ].join("\n"),
  );
}

function llmsTxt(facts: CatalogFacts): string {
  return `# LMOmnibus

> Instruments for pricing, comparing and choosing language models. Every figure is
> list-price cost at a workload (input and output tokens per request, requests per
> month, cache reads and writes, Standard or Batch) — not cost per task.
> ${facts.models} models; prices as of ${facts.as_of}.

## Instruments

- [Cost Calculator](${SITE_ORIGIN}/tools/cost): rank every model by $ per 1,000 requests at a workload; bench up to 12 for side-by-side cost cards.
- [Price–Capability Frontier](${SITE_ORIGIN}/tools/frontier): cost at a workload against Artificial Analysis Intelligence, Coding or Agentic; the cheapest model clearing a minimum score.
- [Token Speed Simulator](${SITE_ORIGIN}/tools/speed): illustrative streaming at a chosen tokens/second.

## Building links

Model keys are OpenRouter ids with the first "/" written ":" (anthropic/claude-opus-5.5 → anthropic:claude-opus-5.5).

Cost Calculator — ${SITE_ORIGIN}/tools/cost?m=anthropic:claude-opus-5.5,openai:gpt-6-sol&p=agent
- m: comma-separated model keys (max 12)
- p: preset — agent (60K in, 1.5K out, 20K req/mo, 90% cache read, 10% write), chat (2K/500/30K), rag (12K/600/20K), batch (4K/400/200K, Batch prices)
- i, o, r, c, w: input tokens, output tokens, requests/month, cache-read %, cache-write % (override the preset)
- rate: standard | batch
- fast, batch, std: comma-separated model keys pinned to that price list
- idx: intelligence | coding | agentic (index used for "cheaper at the same score" verdicts)

Frontier — ${SITE_ORIGIN}/tools/frontier?p=agent&y=coding&min=60&f=tools,img
- p, i, o, r, c, w, rate: as above
- y: intelligence | coding | agentic
- min: minimum score (0-100)
- f: filters — img, aud, tools, reasoning, open

Price Ledger — ${SITE_ORIGIN}/changes
- What changed between catalog snapshots: vendor list-price changes (hand-checked), OpenRouter aggregate moves, listings, delistings, promos, retirements.
- Feeds: ${SITE_ORIGIN}/changes.xml (Atom, one entry per snapshot) and ${SITE_ORIGIN}/changes.json (every change as JSON).

Switch Planner — ${SITE_ORIGIN}/tools/switch?from=google:gemini-2.5-pro&p=agent
- from: the model being replaced (vendor:slug)
- p, i, o, r, c, w, rate, idx: as for the Cost Calculator
- Replacements keep tools / reasoning / image input, fit the workload, and score within 5 points on the chosen index.

Agent Loop — ${SITE_ORIGIN}/tools/agent?m=anthropic:claude-opus-5.5,openai:gpt-6-sol&t=20&cache=5m
- m: up to 4 model keys
- t: turns per session · pf: system + tool-definition tokens · u: user tokens per turn · tr: tool-result tokens per turn · o: output tokens per turn · s: sessions per month
- cache: off | 5m | 1h (1h uses the 1-hour cache-write price where sold)

Model pages — ${SITE_ORIGIN}/models/anthropic/claude-opus-5.5
- The path is the OpenRouter id with its "/" kept as-is (not ":").
- Spec, price lists per mode, AA scores with rank, cost at each preset. Delisted models keep a "no longer listed" page.

## Data

- [catalog.json](${SITE_ORIGIN}/catalog.json): every model with its rate cards (USD per 1M tokens as exact decimal strings), context, modalities, capabilities and provenance.
- Prices are OpenRouter aggregates unless a price list has "checked": true (verified by hand against the vendor; usually only a model's Standard list). Capability scores are Artificial Analysis indices via OpenRouter and are not included in catalog.json.
`;
}

export default defineConfig({
  plugins: [react(), routeShells()],
  server: { port: 5173, strictPort: true },
  build: {
    // The model catalog is bundled on purpose (no runtime fetch); ~120 KB gzipped in total.
    chunkSizeWarningLimit: 700,
  },
});
