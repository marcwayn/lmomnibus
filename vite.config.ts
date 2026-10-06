import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { ROUTES, SITE_ORIGIN, type CatalogFacts, type RouteInfo } from "./src/routes.ts";

const HEAD_MARKER = /<!-- route-head:[\s\S]*?<!-- \/route-head -->/;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function headFor(route: RouteInfo | null, facts: CatalogFacts, preloads: string[]): string {
  const title = route?.title ?? "Page not found — LMOmnibus";
  const description = route ? route.description(facts) : "This page doesn't exist.";
  const url = route ? `${SITE_ORIGIN}${route.path}` : SITE_ORIGIN;
  const image = `${SITE_ORIGIN}${route?.ogImage ?? "/og/home.png"}`;
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}" />`,
    route ? `<link rel="canonical" href="${url}" />` : `<meta name="robots" content="noindex" />`,
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

      const render = (route: RouteInfo | null) => template.replace(HEAD_MARKER, headFor(route, facts, preloads));
      for (const route of ROUTES) {
        const file = route.path === "/" ? join(outDir, "index.html") : join(outDir, `${route.path.slice(1)}.html`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, render(route));
      }
      writeFileSync(join(outDir, "404.html"), render(null));

      writeOpenData(outDir, facts);

      writeFileSync(join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
      const urls = ROUTES.map(
        (r) => `  <url><loc>${SITE_ORIGIN}${r.path}</loc><lastmod>${facts.as_of}</lastmod></url>`,
      ).join("\n");
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
      source: "OpenRouter /api/v1/models (aggregate prices) + vendor list prices checked by hand (provenance: FirstParty)",
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

## Data

- [catalog.json](${SITE_ORIGIN}/catalog.json): every model with its rate cards (USD per 1M tokens as exact decimal strings), context, modalities, capabilities and provenance.
- Prices are OpenRouter aggregates unless provenance is FirstParty (checked against the vendor). Capability scores are Artificial Analysis indices via OpenRouter and are not included in catalog.json.
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
