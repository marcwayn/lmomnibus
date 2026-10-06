import rawWeights from "../data/weights.json" with { type: "json" };
import type { Model } from "./core/model.ts";
import { modelFromRecord, type VramModel } from "./core/vram.ts";
import type { WeightsFile, WeightsRecord } from "./core/weights.ts";

/**
 * The Hugging Face architecture records (data/weights.json, written by
 * scripts/hf.ts), in their own chunk: only the open-weights tools and the
 * model pages' self-host sections load it, via dynamic import or a lazy page.
 */
export const WEIGHTS = rawWeights as unknown as WeightsFile;

export const WEIGHTS_AS_OF = WEIGHTS.asOf;

export function recordFor(m: Model): WeightsRecord | null {
  return m.hfId ? (WEIGHTS.models[m.hfId] ?? null) : null;
}

export function vramModelFor(m: Model): VramModel | null {
  const r = recordFor(m);
  return r ? modelFromRecord(r, m.displayName) : null;
}
