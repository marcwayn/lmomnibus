# LMOmnibus

A workbench of instruments for pricing, comparing, and choosing language models — built in Rust with [Leptos](https://leptos.dev).

**Tool 01, live: Cost Calculator.** Search the catalog by vendor, model name, or release year, add models to a bench, and compare monthly cost for a given workload — including long-context pricing tiers (priced on the whole request, not marginally) and live promotional rates shown alongside list price.

The build rationale, visual design system, and roadmap for the tools beyond the calculator are in [`SCHEMATIC.html`](./SCHEMATIC.html).

## How it's built

```
crates/
  lmo-core/    domain types, cost engine, search — no I/O, compiles to both
               native and wasm32, so the browser and the server share one
               implementation of the math.
  lmo-ingest/  fetches the OpenRouter model catalog, normalizes it (folds
               :batch/-fast variants into rate modes, converts pricing to
               USD/MTok, derives release dates), applies data/overrides.json,
               writes data/catalog.json.
  lmo-web/     the Leptos app (SSR via Axum + hydration).
data/
  catalog.json    the committed, normalized snapshot — embedded into the
                  binary and the WASM bundle at compile time via include_str!.
                  The running app makes no network calls to have data to show.
  overrides.json  curated corrections that win over the aggregate feed
                  (e.g. distinguishing a promotional rate from list price).
```

Search runs entirely in the browser: the catalog (currently ~320 priced
models, well under 300KB as JSON) ships inside the WASM bundle, so filtering
is instant with no server round-trip. This is a deliberate simplification —
see the "Where the data goes" section of the schematic for the
network-crosses-only-for-search design this can grow into once the catalog
is large enough that shipping all of it stops making sense.

## Refreshing the catalog

The app never fetches live pricing at runtime — it boots from
`data/catalog.json`. To pull current prices from OpenRouter and rebuild the
snapshot:

```bash
cargo run -p lmo-ingest --release
```

This overwrites `data/catalog.json`. Review the diff, then commit it and
redeploy. Curated corrections live in `data/overrides.json` — add an entry
there (matched by model key) for anything the aggregate feed gets wrong,
such as a temporary promotional rate.

## Local development

Requires a Rust toolchain via [rustup](https://rustup.rs) (not just a
system/Homebrew `rustc` — the WASM target needs rustup-managed component
installs) and [`cargo-leptos`](https://github.com/leptos-rs/cargo-leptos):

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-leptos --locked
```

Then, from the repo root:

```bash
cargo leptos watch
```

This serves the app at `http://127.0.0.1:3000` with hot reload. Run
`cargo test -p lmo-core` to run the cost-engine tests (tiered pricing,
promo detection, cache-read math).

## Deploying

### Docker (any host: Fly.io, Render, Railway, a plain VM, etc.)

```bash
docker build -t lmomnibus .
docker run -p 8080:8080 lmomnibus
```

The image is a multi-stage build: it compiles the server binary and the WASM
bundle in a `rust:bookworm` stage, then copies just the binary and
`target/site` into a slim `debian:bookworm-slim` runtime image. No database,
no external services, no environment variables required beyond the ones the
image already sets — this container is the entire deployment.

- **Fly.io**: `fly launch` (it will detect the Dockerfile) then `fly deploy`.
- **Render**: New → Web Service → connect the repo → Render detects the
  Dockerfile automatically. Set the port to `8080`.
- **Railway**: New Project → Deploy from GitHub repo → Railway builds the
  Dockerfile automatically.

### Bare metal / a VM without Docker

Build with `cargo leptos build --release`, then copy `target/release/lmo-web`
and `target/site` to the host and run the binary with:

```bash
LEPTOS_SITE_ROOT=/path/to/site LEPTOS_SITE_ADDR=0.0.0.0:8080 ./lmo-web
```

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Initial commit: LMOmnibus Cost Calculator"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

`.github/workflows/ci.yml` runs the cost-engine tests, the full
`cargo leptos build --release`, and a Docker build on every push and pull
request against `main`.

## A note on asset caching

The server sends `Cache-Control: no-cache` on every response. The WASM/JS
bundle filenames carry no content hash (`lmo-web.wasm`, not
`lmo-web.<hash>.wasm`), so without this a browser can serve a cached bundle
from an older build against freshly rendered HTML — hydration then fails
silently and the page renders but goes inert, with no console error.
`no-cache` means "revalidate before reuse", not "don't store", so requests
still 304 off `Last-Modified` and cost little.

If you later want long-lived caching, `cargo-leptos` supports content-hashed
filenames via `hash-files = true` in `[package.metadata.leptos]`; switch to
that plus `immutable` rather than simply dropping the header.

## What's deliberately not here yet

- **No mode toggle in the bench** (batch/fast pricing) — the data model and
  cost engine already support it (`RateMode::{Standard,Batch,Fast}`); the UI
  always compares at `Standard` for now.
- **No database, no live-refresh background task** — the catalog is a file,
  refreshed by re-running ingest and redeploying. Revisit once there's a
  reason (user accounts, live price alerts) to want otherwise.
- **Tools 02–08** from the roadmap in `SCHEMATIC.html` — the catalog and cost
  engine are already shaped to support them without new ingest work; none
  are built yet.
