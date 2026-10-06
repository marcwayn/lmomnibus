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

export default defineConfig({
  plugins: [react(), routeShells()],
  server: { port: 5173, strictPort: true },
  build: {
    // The model catalog is bundled on purpose (no runtime fetch); ~120 KB gzipped in total.
    chunkSizeWarningLimit: 700,
  },
});
