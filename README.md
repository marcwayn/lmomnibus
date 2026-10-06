# LMOmnibus

A workbench of instruments for pricing, comparing, and choosing language models — built with [React](https://react.dev) and [Vite](https://vite.dev), deployed as a static site on Cloudflare Pages.

Live at **https://lmomnibus.pages.dev**.

Everything is priced at **your** workload — input and output per request, requests per month, cache reads and writes, Standard or Batch — rather than per token or on a fixed blend.

- **Home: the value board.** For a preset workload (chat, RAG, coding agent, batch), the models where nothing cheaper scores higher on Artificial Analysis Intelligence, plus three computed readings.
- **Tool 01: Cost Calculator.** Workload presets; the whole market ranked by $ per 1,000 requests with capability filters and "hide dominated"; a bench of cost cards with a cost breakdown, per-model Batch/Fast pricing, and "cheaper at the same score" verdicts. The bench lives in a readable URL (`?m=anthropic:claude-opus-5.5,openai:gpt-6-sol&p=agent`), is remembered locally, and copies as a link or a Markdown table.
- **Tool 02: Price–Capability Frontier.** Every scored model on cost (log) × AA Intelligence / Coding / Agentic, the stepped frontier, a draggable minimum-score bar with a one-line answer ("cheapest model scoring ≥ 45…"), and the step-up ladder.
- **Tool 03: Token Speed Simulator.** Watch a response stream at a chosen rate (illustrative; ~0.75 words per token).

Every price says where it comes from ("list" = checked against the vendor, "via OR" = OpenRouter's aggregate), and every page shows the date the prices were fetched.

The build rationale, visual design system, and roadmap are in [`SCHEMATIC.html`](./SCHEMATIC.html) (written for the original Rust/Leptos version; the architecture sections predate the move to React).

## How it's built

```
src/
  core/        domain logic — plain TypeScript, no React, unit-tested with
               Vitest. Money is big.js decimals end to end, never JS floats.
    cost.ts      cost engine: tiers, promos, cache reads/writes, notes
    presets.ts   named workloads (Coding agent, Chat, RAG answer, Batch)
    frontier.ts  pricing the catalog, value frontier, alternatives, filters
    board.ts     the home board and readings
    query.ts     tokenised search, filters and sorting
    share.ts     the readable URL format for scenarios
  pages/       Home, Cost Calculator, Frontier, Speed Simulator
  components.tsx  workload panel, price-source tags, copy buttons, footer
  routes.ts    the one route table (pages, titles, descriptions, preview cards)
  styles.css   the whole stylesheet (the price-board design system)
scripts/
  ingest.ts    fetches the OpenRouter model catalog, normalizes it, applies
               data/overrides.json, writes data/catalog.json and
               data/catalog-meta.json (with the fetch date).
  og.ts        draws the link-preview cards and touch icon after the build.
data/
  catalog.json       the committed, normalized snapshot — bundled into the
                     app, so the site makes no network calls for data.
  catalog-meta.json  when the feed was fetched, and coverage counts.
  overrides.json     hand-checked vendor list prices that win over the feed,
                     each with verified_on and source.
public/
  _headers     Cloudflare Pages cache rules.
  favicon.svg  the meter-rule mark.
```

Search runs entirely in the browser: the catalog (~350 priced models) ships
inside the JS bundle (about 120KB gzipped in total), so filtering and
re-pricing are instant with no server round-trip.

How the numbers are computed:
- Promotional rates carry an `until` date and apply only while live (UTC) and
  only below any long-context tier. A test fails if an override's promo has
  expired, so a person re-checks the vendor's price.
- Cache reads bill at the cache-read price (or as input when none is
  published). Cache writes bill at max(write price, input), so a 1.25× write
  premium counts and a storage-style fee never undercuts input.
- Capability scores are Artificial Analysis indices as carried in the
  OpenRouter feed. A missing score is "not rated", never zero; scores are not
  compared across snapshots (AA rescales between versions).
- Everything is list-price cost at a workload, not cost per task.

## Local development

Requires Node 23.6 or newer (the ingest script runs as TypeScript directly).

```bash
npm install
npm run dev        # http://localhost:5173 with hot reload
npm test           # cost engine, formatting, search, catalog sanity
npm run build      # typecheck + production build into dist/
```

## Refreshing the catalog

The app never fetches live pricing at runtime — it's built from
`data/catalog.json`. To pull current prices from OpenRouter and rebuild the
snapshot:

```bash
npm run ingest
```

This overwrites `data/catalog.json` and `data/catalog-meta.json`. Review
the diff (added, removed, re-priced models), run `npm test`, then commit and
redeploy. Curated corrections live in `data/overrides.json` — add an entry
there (matched by model key) for anything the aggregate feed gets wrong, such
as a temporary promotional rate.

## Deploying (Cloudflare Pages)

The site is fully static, so it deploys as plain files to the `lmomnibus`
Pages project:

```bash
npx wrangler login     # once
npm run deploy         # build + wrangler pages deploy dist
```

`npm run preview` serves `dist/` through wrangler's local Pages emulator, so
routing and headers behave as they will in production.

Routing: the build writes an HTML shell for every route in `src/routes.ts`
(own title, description, canonical URL and link-preview card), plus
`404.html`, `robots.txt` and `sitemap.xml`. Because `404.html` exists, Pages
serves real 404s for unknown paths instead of falling back to `index.html` —
so a new route must be added to `src/routes.ts` (a test keeps that table and
the pages in step). A route served only by fallback would also miss Pages'
edge-cache refresh on deploy.

Caching: Vite content-hashes every file under `/assets`, so `_headers` marks
them `immutable` for a year. HTML keeps Pages' default of revalidating on
every request, so a new deploy is picked up immediately.

## What's deliberately not here yet

- **No price history yet** — the catalog is one snapshot; a scheduled
  ingest that keeps dated snapshots is the next step (see the roadmap).
- **No database, no live-refresh background task** — the catalog is a file,
  refreshed by re-running ingest and redeploying.
- **Tools 02–08** from the roadmap in `SCHEMATIC.html` — none are built yet.
