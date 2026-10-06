import type { Model } from "./model.ts";
import { frontier, percentileScore, priceAll, scoreOf, type Priced } from "./frontier.ts";
import { presetById, type Preset } from "./presets.ts";

/** The home board shows only frontier models in the top quartile of scored models. */
export const BOARD_PERCENTILE = 75;

export interface Board {
  preset: Preset;
  /** Score floor actually applied — computed, so it survives AA rescaling. */
  floor: number;
  scoredCount: number;
  rows: Priced[];
  /** The full Intelligence frontier at this preset, for "show all". */
  fullFrontier: Priced[];
}

export function buildBoard(models: readonly Model[], preset: Preset, today: string): Board {
  const priced = priceAll(models, preset.workload, preset.rate, today);
  const full = frontier(priced, "intelligence");
  const floor = percentileScore(models, "intelligence", BOARD_PERCENTILE) ?? 0;
  return {
    preset,
    floor,
    scoredCount: models.filter((m) => scoreOf(m, "intelligence") !== null).length,
    rows: full.filter((p) => scoreOf(p.model, "intelligence")! >= floor),
    fullFrontier: full,
  };
}

export interface Reading {
  id: "near-top" | "under-a-dollar" | "long-context";
  /** Lead-in, e.g. "Most capable under $1 per 1K chat requests". */
  label: string;
  point: Priced | null;
  /** Extra figure shown after the model, e.g. "47 models". */
  detail?: string;
  /** Where the reading came from. */
  href: string;
}

const NEAR_TOP = 0.9;

/**
 * Three computed one-liners for the home page. Every number is derived from
 * the catalog at render time; nothing is hand-written.
 */
export function readings(models: readonly Model[], today: string): Reading[] {
  const agent = presetById("agent")!;
  const chat = presetById("chat")!;
  const atAgent = priceAll(models, agent.workload, agent.rate, today);
  const atChat = priceAll(models, chat.workload, chat.rate, today);

  const top = Math.max(...models.map((m) => scoreOf(m, "intelligence") ?? -Infinity));
  // Round *up* to one decimal, so a model just under 90% of the top score
  // can't sneak in (the inner rounding absorbs float noise like 45.00000001).
  const threshold = Math.ceil(Math.round(top * NEAR_TOP * 1000) / 100) / 10;
  const nearTop = cheapest(atAgent.filter((p) => (scoreOf(p.model, "intelligence") ?? -1) >= threshold));

  const underDollar = atChat
    .filter((p) => p.cost < 1 && scoreOf(p.model, "intelligence") !== null)
    .sort((a, b) => scoreOf(b.model, "intelligence")! - scoreOf(a.model, "intelligence")! || a.cost - b.cost)[0] ?? null;

  const longContext = atChat.filter((p) => p.model.contextTokens >= 1_000_000);
  const cheapestLong = cheapest(longContext);

  return [
    {
      id: "near-top",
      label: `Cheapest within 10% of the top Intelligence score (at least ${threshold}) as a coding agent`,
      point: nearTop,
      href: `/tools/frontier?p=agent&min=${threshold}`,
    },
    {
      id: "under-a-dollar",
      label: "Most capable under $1 per 1K chat requests",
      point: underDollar,
      href: "/tools/frontier?p=chat",
    },
    {
      id: "long-context",
      label: "Cheapest with a 1M+ context, at Chat",
      point: cheapestLong,
      detail: `${longContext.length} models have 1M+`,
      href: cheapestLong ? `/tools/cost?m=${cheapestLong.model.key.replace("/", ":")}&p=chat` : "/tools/cost?p=chat",
    },
  ];
}

function cheapest(points: Priced[]): Priced | null {
  return points.reduce<Priced | null>((best, p) => (!best || p.cost < best.cost ? p : best), null);
}
