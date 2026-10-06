# LMOmnibus

A workbench of instruments for pricing, comparing, and choosing language models — built with [React](https://react.dev) and [Vite](https://vite.dev), deployed as a static site on Cloudflare Pages.

Live at **https://lmomnibus.pages.dev**.

Everything is priced at **your** workload — input and output per request, requests per month, cache reads and writes, Standard or Batch — rather than per token or on a fixed blend.

- **Home: the value board.** For a preset workload (chat, RAG, coding agent, batch), the models where nothing cheaper scores higher on Artificial Analysis Intelligence, plus three computed readings.
- **Tool 01: Cost Calculator.** Workload presets; the whole market ranked by $ per 1,000 requests with capability filters and "hide dominated"; a bench of cost cards with a cost breakdown, per-model Batch/Fast pricing, and "cheaper at the same score" verdicts. The bench lives in a readable URL (`?m=anthropic:claude-opus-5.5,openai:gpt-6-sol&p=agent`), is remembered locally, and copies as a link or a Markdown table.
- **Tool 02: Price–Capability Frontier.** Every scored model on cost (log) × AA Intelligence / Coding / Agentic, the stepped frontier, a draggable minimum-score bar with a one-line answer ("cheapest model scoring ≥ 45…"), and the step-up ladder.
- **Tool 03: Token Speed Simulator.** Watch a response stream at a chosen rate (illustrative; ~0.75 words per token).
- **Tool 04: Price Ledger** (`/changes`). What changed between snapshots — vendor list-price moves kept apart from OpenRouter aggregate drift, new listings, delistings, promos, retirements — with an Atom feed (`/changes.xml`) and JSON (`/changes.json`). A remembered bench shows "since you last looked".
- **Tool 05: Switch Planner** (`/tools/switch?from=…`). Replacements for a model you're leaving, at your workload: the saving, the score change, and what the switch gives up.
- **Tool 06: Agent Loop** (`/tools/agent`). What a whole agent session costs as context grows each turn, with prompt caching off, 5-minute or 1-hour, and how many reads earn back a cache write.
- **Tool 07: Open Weights vs Closed** (`/tools/open`). Open-weight models (downloadable weights on Hugging Face) against closed ones at your workload: how far the best open-weight model trails on one Artificial Analysis snapshot, the cheapest model on each side at each score, an open-weight match for any closed model, the running best by OpenRouter listing date, what fits on common GPUs, and licences.
- **Tool 08: VRAM Estimator** (`/tools/vram`). The GPU memory an open-weight model needs — weights at a format, KV cache at a context, engine overhead — for llama.cpp, vLLM or MLX, and which GPUs and Macs hold it. Every figure is an estimate with a low–high range and its arithmetic shown.
- **Model pages** (`/models/<vendor>/<slug>`). A spec sheet per model — price lists, tiers, scores with ranks, cost at each preset — and a "no longer listed" page for delisted ones. Open-weight models add their weights (parameters, architecture, licence, Hugging Face provenance) and "Run it yourself" (estimated memory by format and context, and the smallest common GPU setup); closed models name their cheapest open-weight match.
- **Open data.** `/catalog.json` (rate cards as exact decimal strings, plus each model's weights status, licence class and parameter counts), `/weights.json` (the open-weight models' architecture records) and `/llms.txt` (the instruments and the URL grammar, for coding assistants).

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
    changes.ts   the change tape: diffing snapshots, vendor vs aggregate
    switch.ts    replacement candidates for the Switch Planner
    agent.ts     multi-turn session cost and cache break-even
    weights.ts   the Hugging Face weights record, licence classes
    arch.ts      config.json parser: dimensions, MoE layout, KV-cache plan
                 per attention family (shared by scripts/hf.ts and the
                 estimator's "paste a config" box)
    vram.ts      the memory estimator: weights by format, KV cache, engine
                 overhead, verdicts, max context (estimates with ranges)
    devices.ts   GPUs and unified-memory machines, as the driver reports them
    openclosed.ts  open-weight vs closed: gap, parity, listing lag, matches
    selfhost.ts  "Run it yourself" on model pages: memory by format and
                 context, and the smallest common GPU setup
  pages/       Home, the eight tools, model pages
  weightsData.ts  the architecture records, loaded only by the open-weight
               tools and model pages (a separate chunk)
  components.tsx  workload panel, price-source tags, copy buttons, footer
  routes.ts    the one route table (pages, titles, descriptions, preview cards)
  styles.css   the whole stylesheet (the price-board design system)
scripts/
  ingest.ts    fetches the OpenRouter model catalog, normalizes it, applies
               data/overrides.json, writes data/catalog.json and
               data/catalog-meta.json (with the fetch date).
  changes.ts   appends what changed since the previous snapshot to
               data/changes.jsonl (append-only).
  hf.ts        `npm run weights`: reads each open-weight model's Hugging Face
               repo (model API, file tree, config.json, safetensors index)
               and writes data/weights.json and data/weights-index.json.
               Unchanged repos (same sha) are reused; if more than 20% of
               repos fail it keeps the previous files.
  refresh.ts   `npm run refresh`: ingest, then hf, then changes, in one step.
  og.ts        draws the link-preview cards (site and per model) and the
               touch icon after the build.
data/
  catalog.json       the committed, normalized snapshot — bundled into the
                     app, so the site makes no network calls for data.
  catalog-meta.json  when the feed was fetched, and coverage counts.
  overrides.json     hand-checked vendor list prices (input and output) that
                     win over the feed, each with verified_on and source.
  changes.jsonl      the change tape, one JSON line per change.
  openness.json      hand-checked Hugging Face repos for open-weight models
                     OpenRouter lists without one, plus "pending" candidates
                     we couldn't confirm (not applied).
  weights.json       per Hugging Face repo: parameters, tensor groups,
                     checkpoint size, published format, licence, architecture
                     and KV-cache plan (~175 KB; loaded on demand).
  weights-index.json per catalog key: status, licence class, parameter counts,
                     native format (small; bundled with every page).
  arch-overrides.json  hand-kept architecture fixes: public mirrors of gated
                     repos, donors, curated active parameters, notes.
public/
  _headers     Cloudflare Pages cache rules.
  favicon.svg  the meter-rule mark.
```

Search runs entirely in the browser: the catalog (~350 priced models) ships
inside the main JS bundle (about 145KB gzipped in total), so filtering and
re-pricing are instant with no server round-trip.

Open-weight means a Hugging Face repo we could open (linked by OpenRouter or
`data/openness.json`); a linked repo we couldn't open is "unverified" and left
out of both sides of every open-vs-closed comparison. The site never says
"open source" for these models: training data and code are rarely published,
and licences vary.

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
- GPU memory is always an estimate (≈, a low–high range, an ESTIMATE stamp):
  weights from the published tensor sizes at the chosen format (GGUF mixes
  calibrated on real files), the KV cache from each model's config.json, and
  engine overhead fitted on public llama.cpp and vLLM logs. Sizes are GiB
  (2^30 bytes); device capacities are what the driver reports.

## Local development

Requires Node 23.6 or newer (the ingest script runs as TypeScript directly).

```bash
npm install
npm run dev        # http://localhost:5173 with hot reload
npm test           # cost engine, formatting, search, catalog sanity
npm run build      # typecheck + production build into dist/
```

## Daily refresh

`.github/workflows/refresh.yml` runs every day at 06:00 UTC (and on demand):
ingest, re-read the open-weight models' Hugging Face repos (`scripts/hf.ts`),
append what changed to `data/changes.jsonl` (`scripts/changes.ts`), run the
tests and the build, and commit the snapshot — git history is the archive of
daily snapshots. The Hugging Face step is best effort: if it fails, the
previous weights data stays and the prices still refresh. An optional
`HF_TOKEN` secret only raises Hugging Face's rate limits (gated repos are read
through public copies with the same parameter total, never with a token). It deploys too when the repository has a `CLOUDFLARE_API_TOKEN`
secret (a Cloudflare API token with Pages edit permission); without one, the
snapshot still lands and the next `npm run deploy` publishes it. Scheduled
workflows only run from the default branch.

## Refreshing the catalog by hand

The app never fetches live pricing at runtime — it's built from
`data/catalog.json`. To pull current prices from OpenRouter, record what
changed, and rebuild the snapshot:

```bash
npm run refresh
```

This runs `scripts/ingest.ts` (overwrites `data/catalog.json` and
`data/catalog-meta.json`; refuses a feed that shrinks the catalog by more
than 20% unless you pass `-- --allow-shrink`), then `scripts/hf.ts`
(refreshes `data/weights.json` and `data/weights-index.json`; a repo is
re-read when its commit, its `data/arch-overrides.json` entry or the
parser version in `scripts/hf.ts` changes — bump `PARSER_VERSION` after
changing `src/core/arch.ts`; `npm run weights -- --all` re-reads every
repo; it stops after 20 minutes and keeps the previous files if more than
a fifth of repos fail), then `scripts/changes.ts` (appends
the diff to `data/changes.jsonl`, which feeds the Ledger, the feeds and the
delisted-model pages). Review the diff, run `npm test`, then commit
and redeploy. Hand-checked list prices live in `data/overrides.json` — add
an entry there (matched by model key and price list) for anything the
aggregate feed gets wrong; ingest marks that price list `checked: true`.

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
every request, so a new deploy is picked up within seconds (a freshly
deployed route can serve the previous page for about 20 seconds).

## What's deliberately not here yet

- **No database and no runtime fetches** — the catalog and the change tape
  are files, refreshed daily by the workflow (or `npm run refresh`) and
  shipped with each deploy.
- **No score history** — Artificial Analysis rescales its indices between
  versions, so the tape records prices, listings and promos, never scores.
- **No cost per task** — every figure is list-price cost at a workload;
  how many requests a task takes depends on the model and isn't modelled.
- **Cache prices aren't hand-checked** — overrides cover input and output
  only; cache-read and cache-write prices are always OpenRouter's.
- **No self-hosting dollar costs** — the VRAM Estimator and model pages say
  what hardware holds a model, never what running it costs (no rental prices,
  throughput or power data).
- **No decode-speed estimate** — fitting in memory isn't speed; tokens per
  second from memory bandwidth needs per-device checking first.
- **No per-provider price spreads** — open-weight prices are mostly
  OpenRouter's aggregate listing, which can understate what a given provider
  charges; the pages say so wherever they compare prices.
