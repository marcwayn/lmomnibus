import { useEffect, useState, type RefObject } from "react";
import { Mark } from "../../components.tsx";
import { scoreOf, type Index, type Priced } from "../../core/frontier.ts";
import type { Model } from "../../core/model.ts";
import { sideOf, type Side } from "../../core/openclosed.ts";
import type { WeightsIndexEntry } from "../../core/weights.ts";

/** Links into other tools from here are internal, not shared-link arrivals. */
export const INTERNAL = { internal: true };

export const SIDE_NAME: Record<Side, string> = { open: "Open-weight", closed: "Closed" };

/** ▼ in pine before the cheaper side; read out as "cheaper". */
export function Cheaper() {
  return (
    <span className="oc-cheaper">
      <Mark kind="down" />
      <span className="sr-only">cheaper </span>
    </span>
  );
}

/** ▲ in brick before the pricier side; read out as "pricier". */
export function Pricier() {
  return (
    <span className="oc-pricier">
      <Mark kind="up" />
      <span className="sr-only">pricier </span>
    </span>
  );
}

/** Every memory figure carries this. */
export function Stamp() {
  return (
    <span className="oc-stamp" title="An estimate from the published architecture, not a measurement">
      Estimate
    </span>
  );
}

/** True while the element is narrower than `below` px: the charts then switch to their 360-wide layouts. */
export function useNarrow(ref: RefObject<HTMLElement | null>, below = 560): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth - 32 < below);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < below));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, below]);
  return narrow;
}

/**
 * While `active`, Escape anywhere but in a form field calls `onEscape` (pass a
 * stable function). For pins: a click on a hollow point or a label pins it
 * without focusing anything, so a handler on the chart would never hear it.
 */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const field = e.target instanceof Element && e.target.closest("input, select, textarea");
      if (e.key === "Escape" && !e.defaultPrevented && !field) onEscape();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, onEscape]);
}

/** The value once it has held still for `ms`: for live regions that shouldn't chatter while a rule is dragged. */
export function useSettled<T>(value: T, ms = 500): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** 30.5B, 235B, 1.0T. */
export function fmtParams(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `${n >= 1e11 ? Math.round(n / 1e9) : (n / 1e9).toFixed(1)}B`;
  return `${Math.round(n / 1e6)}M`;
}

/** "30.5B MoE (3.3B active)". */
export function paramsText(w: WeightsIndexEntry): string {
  return `${fmtParams(w.total)}${w.moe ? " MoE" : ""}${w.active ? ` (${fmtParams(w.active)} active)` : ""}`;
}

/** "Open-weight · Apache-2.0 · 30.5B MoE" or "Closed · API only". */
export function classLine(m: Model): string {
  if (sideOf(m) !== "open") return "Closed · API only";
  return ["Open-weight", m.weights?.licenceLabel ?? "licence unread", m.weights ? paramsText(m.weights) : null].filter(Boolean).join(" · ");
}

/** "46.3" with one decimal, as everywhere on the site. */
export const fmtScore = (s: number) => s.toFixed(1);

/** A target in half points: "45", "45.5". */
export const fmtTarget = (t: number) => (Number.isInteger(t) ? String(t) : t.toFixed(1));

/** "+1.1", "−2.0", "±0.0". */
export function fmtDelta(d: number): string {
  if (d === 0) return "±0.0";
  return `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`;
}

/** "5.3", "0.03", "1.2": two significant figures below 1. */
export function fmtRatio(r: number): string {
  return r >= 1 ? r.toFixed(1) : r >= 0.1 ? r.toFixed(2) : r.toPrecision(1);
}

/** Rank among rated models on the same side of `points`: "#3 of 116". */
export function sideRank(points: readonly Priced[], m: Model, index: Index): { rank: number; of: number } | null {
  const s = scoreOf(m, index);
  const side = sideOf(m);
  if (s === null || !side) return null;
  const same = points.filter((p) => sideOf(p.model) === side && scoreOf(p.model, index) !== null);
  return { rank: same.filter((p) => scoreOf(p.model, index)! > s).length + 1, of: same.length };
}

/** An ISO date `days` before `iso`. */
export function isoMinusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- chart labels

/**
 * Something on a chart that text must keep clear of, in viewBox units: a
 * line of text, a point's mark or ring, a bracket. `key` ties a mark to the
 * point a label belongs to, so a label never avoids its own point. `soft`
 * marks (hollow points, whiskers) are avoided when there's a choice, but
 * text may cover them when there isn't.
 */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  key?: string;
  soft?: boolean;
}

export type Anchor = "start" | "middle" | "end";

/**
 * The box a line of chart text covers, halo included: `chars` characters of
 * Plex Mono (0.6 em each) at `fontPx`, baseline `y`, anchored at `x`.
 */
export function textBox(x: number, y: number, chars: number, fontPx: number, anchor: Anchor = "start"): Box {
  const w = chars * fontPx * 0.6;
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return { x0, y0: y - 0.85 * fontPx, x1: x0 + w, y1: y + 0.22 * fontPx };
}

/** A point's mark: `r` out from its centre, stroke included; `key` names the point. */
export function markBox(cx: number, cy: number, r: number, key: string, soft = false): Box {
  return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, key, soft };
}

/** True when the boxes overlap, or sit closer than `pad` side by side. */
export function hits(a: Box, b: Box, pad = 4): boolean {
  return a.x0 < b.x1 + pad && a.x1 + pad > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * What a box would cover: 1,000 for leaving `area`, 300 for each piece of
 * text or bracket (no key), 100 for each mark, 1 for each soft one; its own
 * point is free.
 */
function coverCost(b: Box, area: Box, taken: readonly Box[], own?: string): number {
  let c = b.x0 >= area.x0 && b.x1 <= area.x1 && b.y0 >= area.y0 && b.y1 <= area.y1 ? 0 : 1000;
  for (const t of taken) if ((own === undefined || t.key !== own) && hits(b, t)) c += t.soft ? 1 : t.key ? 100 : 300;
  return c;
}

/** The first candidate that covers no more than `ok`, else the first that covers least. */
function cheapest<T>(cands: readonly T[], cost: (c: T) => number, ok = 0): { pick: T; cost: number } {
  let best = { pick: cands[0], cost: Infinity };
  for (const c of cands) {
    const k = cost(c);
    if (k < best.cost) best = { pick: c, cost: k };
    if (k <= ok) break;
  }
  return best;
}

export interface TextSpot {
  x: number;
  y: number;
  anchor: Anchor;
}

/**
 * Where a line of annotation text goes: the first of `spots` inside `area`
 * that covers at most one soft mark (staying close to what it annotates
 * matters more than a hollow point), else the one that covers least. Text
 * and hard marks cost far more than soft ones. Annotations are always drawn;
 * the chosen box joins `taken`, so text placed later keeps clear of it.
 */
export function placeText(spots: readonly TextSpot[], chars: number, fontPx: number, area: Box, taken: Box[]): TextSpot {
  const box = (s: TextSpot) => textBox(s.x, s.y, chars, fontPx, s.anchor);
  const { pick } = cheapest(spots, (s) => coverCost(box(s), area, taken), 1);
  taken.push(box(pick));
  return pick;
}

export interface LabelRequest {
  key: string;
  x: number;
  y: number;
  text: string;
  /** How far the point's mark (or ring) reaches from its centre. */
  r?: number;
}

export interface PlacedLabel {
  x: number;
  y: number;
  anchor: Anchor;
}

/**
 * Places labels beside their points, clear of each other and of `taken`
 * (other text, every plotted mark, brackets): above or below on the roomier
 * side, then the other side, then over or under the point, then a line
 * further out, always inside `area`. A label may cover soft marks only when
 * no spot is clear of them.
 * Requests are placed in order, so put the ones that matter most first; a
 * label with no free spot is left out (its point still focuses and shows its
 * name). Placed labels join `taken`.
 */
export function placeLabels(reqs: readonly LabelRequest[], area: Box, fontPx: number, taken: Box[]): Map<string, PlacedLabel> {
  const placed = taken;
  const out = new Map<string, PlacedLabel>();
  for (const r of reqs) {
    const w = r.text.length * fontPx * 0.6;
    const near: Anchor = r.x + 8 + w < area.x1 - 4 ? "start" : "end";
    const far: Anchor = near === "start" ? "end" : "start";
    const beside = (anchor: Anchor, dy: number): PlacedLabel => ({ x: anchor === "start" ? r.x + 8 : r.x - 8, y: r.y + dy, anchor });
    // Over and under the point: centred, then running off to the roomier side, then the other.
    const across = (y: number): PlacedLabel[] => {
      const rightward: PlacedLabel = { x: r.x - 4, y, anchor: "start" };
      const leftward: PlacedLabel = { x: r.x + 4, y, anchor: "end" };
      return [{ x: r.x, y, anchor: "middle" }, ...(near === "start" ? [rightward, leftward] : [leftward, rightward])];
    };
    const reach = r.r ?? 4;
    const candidates: PlacedLabel[] = [
      beside(near, -7),
      beside(far, -7),
      beside(near, 15),
      beside(far, 15),
      ...across(r.y - reach - 5),
      ...across(r.y + reach + 4 + 0.9 * fontPx),
      beside(near, -20),
      beside(far, -20),
      beside(near, 28),
      beside(far, 28),
    ];
    const box = (c: PlacedLabel) => textBox(c.x, c.y, r.text.length, fontPx, c.anchor);
    const { pick, cost } = cheapest(candidates, (c) => coverCost(box(c), area, placed, r.key));
    if (cost >= 100) continue;
    placed.push(box(pick));
    out.set(r.key, pick);
  }
  return out;
}

/** "$4.11" style tick labels for a log cost axis. */
export function fmtCostTick(v: number): string {
  return v >= 1 ? `$${v.toLocaleString("en-US")}` : `$${v}`;
}
