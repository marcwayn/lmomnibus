// Draws the 1200×630 link-preview cards and the apple-touch-icon after
// `vite build`, into dist/. Typeset in code with the site's own fonts (satori
// lays out, resvg rasterises), so every figure on a card is exact — numbers
// come from the same catalog and cost engine the site uses.
//
//   node scripts/og.ts            # after vite build
//
// Runs directly on Node 23.6+ (native TypeScript).

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import { buildBoard } from "../src/core/board.ts";
import { allModels, CATALOG_META } from "../src/core/catalog.ts";
import { todayIso } from "../src/core/date.ts";
import { fmtCompact, fmtInt, fmtUsd } from "../src/core/fmt.ts";
import { presetById } from "../src/core/presets.ts";
import { ROUTES, type RouteInfo } from "../src/routes.ts";

const OUT = "dist";
const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFileSync(require.resolve(`${pkg}/files/${file}`));

const FONTS = [
  { name: "Archivo", data: font("@fontsource/archivo", "archivo-latin-800-normal.woff"), weight: 800 as const, style: "normal" as const },
  { name: "Plex", data: font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff"), weight: 400 as const, style: "normal" as const },
  { name: "Plex", data: font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-600-normal.woff"), weight: 600 as const, style: "normal" as const },
  { name: "Public", data: font("@fontsource/public-sans", "public-sans-latin-400-normal.woff"), weight: 400 as const, style: "normal" as const },
  { name: "Public", data: font("@fontsource/public-sans", "public-sans-latin-600-normal.woff"), weight: 600 as const, style: "normal" as const },
];

const C = {
  ground: "#E7EAE4",
  surface: "#F2F4EE",
  ink: "#10150F",
  ink2: "#545B4E",
  ink3: "#5F675A",
  rule: "#C6CCBD",
  accent: "#0B5D4A",
  accentInk: "#F2F4EE",
};

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type,
  props: { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children },
});

/** The meter rule as on the site: a hairline baseline with evenly spaced, equal ticks. */
function meter(width: number): Node {
  const ticks: Node[] = [];
  for (let x = 0; x <= width; x += 18) {
    ticks.push(h("div", { position: "absolute", left: x, bottom: 0, width: 2, height: 12, background: C.rule }));
  }
  return h("div", { position: "relative", width, height: 14, borderBottom: `2px solid ${C.rule}` }, ...ticks);
}

function plate(size: number): Node {
  const s = size / 32;
  const bar = (x: number, y: number, w: number, hh: number) =>
    h("div", { position: "absolute", left: x * s, top: y * s, width: w * s, height: hh * s, background: C.accentInk });
  return h(
    "div",
    { position: "relative", width: size, height: size, background: C.accent, borderRadius: 3 },
    bar(5, 22, 22, 2),
    bar(5, 9, 2, 13),
    bar(10, 16, 2, 6),
    bar(15, 12, 2, 10),
    bar(20, 16, 2, 6),
    bar(25, 9, 2, 13),
  );
}

function card(eyebrow: string, title: string, body: Node | null, foot: string): Node {
  return h(
    "div",
    {
      width: 1200,
      height: 630,
      flexDirection: "column",
      justifyContent: "space-between",
      background: C.ground,
      padding: "56px 64px 48px",
      fontFamily: "Plex",
      color: C.ink,
    },
    h(
      "div",
      { flexDirection: "column", gap: 0 },
      h(
        "div",
        { alignItems: "center", gap: 18 },
        plate(52),
        h(
          "div",
          { fontFamily: "Archivo", fontSize: 40, letterSpacing: -1 },
          h("span", { color: C.accent }, "LM"),
          h("span", {}, "Omnibus"),
        ),
      ),
      h("div", { marginTop: 22 }, meter(1072)),
      h("div", { marginTop: 34, fontSize: 20, fontWeight: 600, color: C.accent, letterSpacing: 3 }, eyebrow.toUpperCase()),
      h("div", { marginTop: 10, fontFamily: "Archivo", fontSize: 60, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 1060 }, title),
    ),
    body ?? h("div", {}),
    h("div", { fontSize: 22, color: C.ink2, borderTop: `2px solid ${C.rule}`, paddingTop: 14 }, foot),
  );
}

function boardRows(): Node {
  const agent = presetById("agent")!;
  const w = agent.workload;
  const board = buildBoard(allModels(), agent, todayIso());
  const rows = [...board.rows].sort((a, b) => a.cost - b.cost).slice(0, 3);
  return h(
    "div",
    { flexDirection: "column", gap: 10, marginTop: 8 },
    h(
      "div",
      { fontSize: 17, color: C.ink3, letterSpacing: 1 },
      `VALUE FRONTIER, TOP QUARTILE OF AA INTELLIGENCE · CODING AGENT: ${fmtCompact(w.inputTokens)} IN, ${fmtCompact(w.outputTokens)} OUT, ${w.cachedPct}% READ, ${w.cacheWritePct}% WRITE`,
    ),
    ...rows.map((p, i) =>
      h(
        "div",
        {
          justifyContent: "space-between",
          alignItems: "baseline",
          paddingBottom: 8,
          borderBottom: i < rows.length - 1 ? `1px solid ${C.rule}` : "none",
        },
        h("span", { fontFamily: "Public", fontWeight: 600, fontSize: 28 }, p.model.displayName),
        h(
          "span",
          { fontSize: 26, fontWeight: 600, color: i === 0 ? C.accent : C.ink, alignItems: "baseline" },
          `${fmtUsd(p.per1k)} / 1K requests`,
          h("span", { fontSize: 18, fontWeight: 400, color: C.ink3, marginLeft: 12 }, p.model.provenance === "FirstParty" ? "list" : "via OR"),
        ),
      ),
    ),
  );
}

async function png(node: Node, width: number, height: number): Promise<Buffer> {
  const svg = await satori(node as Parameters<typeof satori>[0], { width, height, fonts: FONTS });
  return new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
}

const body = (text: string) => h("div", { fontFamily: "Public", fontSize: 30, lineHeight: 1.4, color: C.ink2, maxWidth: 1000, marginTop: 8 }, text);
const eyebrow = (path: string) => {
  const r = ROUTES.find((x: RouteInfo) => x.path === path)!;
  return `Tool ${r.nav!.num} · ${r.nav!.label}`;
};
const live = `${fmtInt(CATALOG_META.models)} models · prices as of ${CATALOG_META.asOf} · lmomnibus.pages.dev`;
const CARDS: Record<string, () => Node> = {
  "/": () =>
    card(
      "Instruments for language models",
      "What language models cost at your workload",
      boardRows(),
      `List-price cost, not cost per task · as of ${CATALOG_META.asOf} · lmomnibus.pages.dev`,
    ),
  "/tools/cost": () =>
    card(
      eyebrow("/tools/cost"),
      "Rank every model by what your workload costs",
      body("Presets for chat, RAG, coding agents and batch jobs. Cache reads and writes, Batch and long-context tiers priced in."),
      live,
    ),
  "/tools/frontier": () =>
    card(
      eyebrow("/tools/frontier"),
      "The cheapest model that clears your bar",
      body("Cost per 1,000 requests at your workload against AA Intelligence, Coding or Agentic, with the step-up ladder."),
      live,
    ),
  "/changes": () =>
    card(
      eyebrow("/changes"),
      "What changed in model prices",
      body("Vendor list-price moves, new listings, delistings and retirements — kept apart from OpenRouter's aggregate drift."),
      live,
    ),
  "/tools/switch": () =>
    card(
      eyebrow("/tools/switch"),
      "What replaces the model you're leaving",
      body("Ranked at your workload: the saving, the score change, and what the switch gives up — context, cutoff, cache pricing."),
      live,
    ),
  "/tools/speed": () =>
    card(
      eyebrow("/tools/speed"),
      "Feel what N tokens per second means",
      body("Pick a rate and an output length, then watch a response stream at that pace."),
      "Illustrative streaming at the rate you choose · lmomnibus.pages.dev",
    ),
};

mkdirSync(`${OUT}/og`, { recursive: true });
for (const route of ROUTES) {
  const make = CARDS[route.path];
  if (!make) throw new Error(`no preview card for ${route.path}`);
  writeFileSync(`${OUT}${route.ogImage}`, await png(make(), 1200, 630));
  console.error(`wrote ${OUT}${route.ogImage}`);
}

const icon = new Resvg(readFileSync("public/favicon.svg", "utf8"), { fitTo: { mode: "width", value: 180 } }).render().asPng();
writeFileSync(`${OUT}/apple-touch-icon.png`, icon);
console.error(`wrote ${OUT}/apple-touch-icon.png`);
