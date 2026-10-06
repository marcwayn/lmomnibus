# LMOmnibus

A workbench of instruments for pricing, comparing, and choosing language models — built with [React](https://react.dev) and [Vite](https://vite.dev), deployed as a static site on Cloudflare Pages.

Live at **https://lmomnibus.pages.dev**.

**Tool 01, live: Cost Calculator.** Search the catalog by vendor, model name, or release year, add models to a bench, and compare monthly cost for a given workload — including long-context pricing tiers (priced on the whole request, not marginally) and live promotional rates shown alongside list price.

**Speed Simulator.** Pick a throughput and an output length and watch a response stream at that pace.

The build rationale, visual design system, and roadmap for the tools beyond the calculator are in [`SCHEMATIC.html`](./SCHEMATIC.html) (written for the original Rust/Leptos version; the architecture sections predate the move to React).

## How it's built

```
src/
  core/        domain types, cost engine, search, formatting — plain
               TypeScript with no React or DOM dependency, unit-tested
               with Vitest. Money is big.js decimals end to end, never
               JS floats.
  pages/       the three routes: home, Cost Calculator, Speed Simulator.
  App.tsx      router + top nav (react-router).
  styles.css   the whole stylesheet.
scripts/
  ingest.ts    fetches the OpenRouter model catalog, normalizes it (folds
               :batch/-fast variants into rate modes, converts pricing to
               USD/MTok, derives release dates, drops unusable router /
               zero-priced rows), applies data/overrides.json, writes
               data/catalog.json.
data/
  catalog.json    the committed, normalized snapshot — bundled into the app
                  at build time, so the running site makes no network calls
                  to have data to show.
  overrides.json  curated corrections that win over the aggregate feed
                  (e.g. distinguishing a promotional rate from list price).
public/
  _headers        Cloudflare Pages cache rules.
```

Search runs entirely in the browser: the catalog (~310 priced models) ships
inside the JS bundle (about 100KB gzipped in total), so filtering is instant
with no server round-trip.

Promotional rates carry an `until` date and are applied only while live
(checked against today's date in UTC) and only below any long-context tier.

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

This overwrites `data/catalog.json`. Review the diff, then commit it and
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

Routing: there is no top-level `404.html`, so Pages treats the project as a
single-page app and serves `index.html` for any path; react-router then
renders the right page (or "Page not found").

Caching: Vite content-hashes every file under `/assets`, so `_headers` marks
them `immutable` for a year. HTML keeps Pages' default of revalidating on
every request, so a new deploy is picked up immediately.

## What's deliberately not here yet

- **No mode toggle in the bench** (batch/fast pricing) — the data model and
  cost engine already support it (`RateMode` is `Standard | Batch | Fast`);
  the UI compares each model at Standard, or at its only mode for the few
  models listed batch- or fast-only.
- **Cache writes aren't priced** — the cached-input share is billed at the
  cache-read rate, but the cost of writing the cache isn't modeled yet.
- **No database, no live-refresh background task** — the catalog is a file,
  refreshed by re-running ingest and redeploying.
- **Tools 02–08** from the roadmap in `SCHEMATIC.html` — none are built yet.
