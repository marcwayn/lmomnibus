# syntax=docker/dockerfile:1

FROM rust:1-bookworm AS builder
WORKDIR /app

RUN rustup target add wasm32-unknown-unknown \
    && cargo install cargo-leptos --locked

COPY . .
RUN cargo leptos build --release

# ---- runtime ----
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/lmo-web /app/lmo-web
COPY --from=builder /app/target/site /app/site

ENV LEPTOS_SITE_ROOT=/app/site
ENV LEPTOS_SITE_ADDR=0.0.0.0:8080
ENV LEPTOS_SITE_PKG_DIR=pkg
EXPOSE 8080

CMD ["/app/lmo-web"]
