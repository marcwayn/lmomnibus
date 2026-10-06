import type { Rate, Workload } from "./cost.ts";

export type PresetId = "chat" | "rag" | "agent" | "batch";

export interface Preset {
  id: PresetId;
  label: string;
  workload: Workload;
  rate: Rate;
  /** Shown under the preset so its assumptions are never hidden. */
  note?: string;
}

/**
 * Named workloads. They are opinions, so every number is printed next to the
 * chip and any edit switches the label to Custom.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "agent",
    label: "Coding agent",
    workload: { inputTokens: 60_000, outputTokens: 1_500, requestsPerMonth: 20_000, cachedPct: 90, cacheWritePct: 10 },
    rate: "Standard",
    note: "Agent traffic measures 85–97% cache reads; assumes each new token is written once, then read.",
  },
  {
    id: "chat",
    label: "Chat",
    workload: { inputTokens: 2_000, outputTokens: 500, requestsPerMonth: 30_000, cachedPct: 0, cacheWritePct: 0 },
    rate: "Standard",
  },
  {
    id: "rag",
    label: "RAG answer",
    workload: { inputTokens: 12_000, outputTokens: 600, requestsPerMonth: 20_000, cachedPct: 0, cacheWritePct: 0 },
    rate: "Standard",
  },
  {
    id: "batch",
    label: "Batch extraction",
    workload: { inputTokens: 4_000, outputTokens: 400, requestsPerMonth: 200_000, cachedPct: 0, cacheWritePct: 0 },
    rate: "Batch",
  },
];

export const DEFAULT_PRESET: Preset = PRESETS[0];

export function presetById(id: string | null | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The preset whose numbers this workload and rate exactly match, if any. */
export function matchingPreset(w: Workload, rate: Rate): Preset | undefined {
  return PRESETS.find(
    (p) =>
      p.rate === rate &&
      p.workload.inputTokens === w.inputTokens &&
      p.workload.outputTokens === w.outputTokens &&
      p.workload.requestsPerMonth === w.requestsPerMonth &&
      p.workload.cachedPct === w.cachedPct &&
      p.workload.cacheWritePct === w.cacheWritePct,
  );
}
