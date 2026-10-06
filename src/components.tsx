import { useEffect, useRef, useState } from "react";
import weightsIndex from "../data/weights-index.json" with { type: "json" };
import { trackEvent } from "./analytics.ts";
import { CATALOG_META, snapshotAgeDays } from "./core/catalog.ts";
import { NOTE_TEXT, type CostBreakdown, type Rate, type Workload } from "./core/cost.ts";
import { daysBetween, daysLabel, todayIso } from "./core/date.ts";
import { fmtCompact, fmtInt } from "./core/fmt.ts";
import { primaryMode, rateCard, type Model, type RateMode } from "./core/model.ts";
import { matchingPreset, PRESETS, type Preset, type PresetId } from "./core/presets.ts";
import { NumberField, U32_MAX } from "./NumberField.tsx";

const MARKS = {
  best: <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" />,
  up: <path d="M5 1 9.5 9H0.5Z" />,
  down: <path d="M5 9 9.5 1H0.5Z" />,
  to: <path d="M1 4.25h6.2L4.9 1.95 5.95.9 10 5 5.95 9.1 4.9 8.05 7.2 5.75H1Z" />,
  check: <path d="M0.8 5.3 1.9 4.2 3.9 6.2 8.1 2 9.2 3.1 3.9 8.4Z" />,
};

/**
 * The price-board marks, drawn rather than typed: ◆ "cheapest / best value",
 * ▲ pricier, ▼ cheaper, plus → and ✓. The fonts' loaded subsets don't carry
 * these glyphs, so as SVG they render identically everywhere.
 */
export function Mark({ kind }: { kind: keyof typeof MARKS }) {
  return (
    <svg className={`mark mark-${kind}`} viewBox="0 0 10 10" aria-hidden="true">
      {MARKS[kind]}
    </svg>
  );
}

/** Shown wherever a price fell back from Batch to the model's regular rate. */
export function FallbackMark({ breakdown }: { breakdown: CostBreakdown }) {
  if (!breakdown.notes.includes("batch-unavailable")) return null;
  return (
    <span className="cell-mark" title={NOTE_TEXT["batch-unavailable"]}>
      no batch
    </span>
  );
}

/** A missing Artificial Analysis score: shown as a dash, read out as "not rated". */
export function NotRated() {
  return (
    <span className="na" title="Not rated by Artificial Analysis">
      <span aria-hidden="true">—</span>
      <span className="sr-only">not rated</span>
    </span>
  );
}

export function Meter({ className = "" }: { className?: string }) {
  return <div className={`meter ${className}`.trim()} aria-hidden="true" />;
}

/**
 * Where a price comes from: a price list checked by hand against the vendor
 * ("list"), or OpenRouter's aggregate. Decided per price list, since an
 * override usually covers only a model's Standard prices.
 */
export function SourceTag({ model, mode }: { model: Model; mode?: RateMode }) {
  return rateCard(model, mode ?? primaryMode(model))?.checked ? (
    <span className="src-tag list" title="Vendor list price: input and output checked by hand against the vendor's pricing. Cache prices are OpenRouter's.">
      list
    </span>
  ) : (
    <span
      className="src-tag agg"
      title="OpenRouter's aggregate price for this model. It can differ from the vendor's list price and between providers."
    >
      via OR
    </span>
  );
}

/** One line describing a workload, e.g. "60K in · 1.5K out · 20K req/mo · 90% read · 10% write". */
export function workloadLine(w: Workload, rate?: Rate, exact = false): string {
  const n = exact ? fmtInt : fmtCompact;
  const parts = [`${n(w.inputTokens)} in`, `${n(w.outputTokens)} out`, `${n(w.requestsPerMonth)} req/mo`];
  if (w.cachedPct) parts.push(`${w.cachedPct}% read`);
  if (w.cacheWritePct) parts.push(`${w.cacheWritePct}% write`);
  if (rate) parts.push(rate);
  return parts.join(" · ");
}

interface WorkloadPanelProps {
  workload: Workload;
  rate: Rate;
  onChange: (w: Workload, rate: Rate, preset: PresetId | null) => void;
}

/**
 * Preset chips that print their numbers, the five workload fields, and the
 * Standard / Batch switch. Editing any field turns the chip row to Custom.
 */
export function WorkloadPanel({ workload, rate, onChange }: WorkloadPanelProps) {
  const active = matchingPreset(workload, rate);
  const pick = (p: Preset) => {
    trackEvent("Preset", p.id);
    onChange({ ...p.workload }, p.rate, p.id);
  };
  const set = (field: keyof Workload) => (v: number) => {
    const next = { ...workload, [field]: v };
    // Read + write can't exceed 100% of input; keep the shown value the priced one.
    if (field === "cachedPct") next.cacheWritePct = Math.min(next.cacheWritePct, 100 - v);
    onChange(next, rate, matchingPreset(next, rate)?.id ?? null);
  };

  return (
    <div className="workload-panel">
      <div className="preset-row" role="group" aria-label="Workload presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`preset${active?.id === p.id ? " on" : ""}`}
            aria-pressed={active?.id === p.id}
            onClick={() => pick(p)}
          >
            <span className="preset-name">{p.label}</span>
            <span className="preset-nums">{workloadLine(p.workload, p.rate === "Batch" ? "Batch" : undefined)}</span>
          </button>
        ))}
        <span className={`preset custom${active ? "" : " on"}`} aria-hidden={!!active}>
          <span className="preset-name">Custom</span>
          <span className="preset-nums">{active ? "edit any field" : "your numbers"}</span>
        </span>
      </div>
      {active?.note && <p className="preset-note">{active.note}</p>}

      <div className="inputs-row">
        <NumberField label="Input tokens / request" value={workload.inputTokens} onChange={set("inputTokens")} min={0} max={U32_MAX} step={1000} />
        <NumberField label="Output tokens / request" value={workload.outputTokens} onChange={set("outputTokens")} min={0} max={U32_MAX} step={100} />
        <NumberField label="Requests / month" value={workload.requestsPerMonth} onChange={set("requestsPerMonth")} min={0} max={U32_MAX} step={1000} />
        <NumberField label="Cache read" value={workload.cachedPct} onChange={set("cachedPct")} min={0} max={100} step={5} suffix="%" />
        <NumberField label="Cache write" value={workload.cacheWritePct} onChange={set("cacheWritePct")} min={0} max={100 - workload.cachedPct} step={5} suffix="%" />
        <div className="inp rate-field">
          <span className="il" id="rate-label">
            Price list
          </span>
          <div className="seg" role="group" aria-labelledby="rate-label">
            {(["Standard", "Batch"] as Rate[]).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={rate === r}
                className={rate === r ? "on" : ""}
                onClick={() => {
                  if (r === "Batch") trackEvent("Rate", "Batch");
                  onChange(workload, r, matchingPreset(workload, r)?.id ?? null);
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="fine">
        Cache read/write are shares of input tokens per request; writes bill at the cache-write price or input,
        whichever is higher. A simplification, not a cache-lifetime simulation.
      </p>
    </div>
  );
}

/** A button that copies text and announces "Copied" to screen readers. */
export function CopyButton({
  label,
  getText,
  onCopied,
  share,
}: {
  label: string;
  getText: () => string;
  onCopied?: (how: "copy" | "share") => void;
  /** Offer the native share sheet on touch devices when available. */
  share?: { title: string; url: () => string };
}) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = (msg: string) => {
    // Clear first so a repeat of the same message is announced again.
    setStatus("");
    setTimeout(() => setStatus(msg), 30);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2000);
  };

  const run = async () => {
    const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    if (share && touch && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: share.title, url: share.url() });
        onCopied?.("share");
        return;
      } catch (e) {
        // A cancelled share sheet is a decision, not a failure: don't copy instead.
        if ((e as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(getText());
      flash("Copied");
      onCopied?.("copy");
    } catch {
      flash("Couldn't copy");
    }
  };

  return (
    <>
      {/* The name stays the action; the visible text briefly shows the result,
          which the status region also announces. */}
      <button type="button" className="text-btn copy-btn" aria-label={label} onClick={run}>
        {/* Both texts share one grid cell, so the button keeps the width of the
            longer one and nothing beside it moves while "Copied" shows. */}
        <span className={status ? "copy-text hide" : "copy-text"}>{label}</span>
        <span className={status ? "copy-text" : "copy-text hide"}>{status || "Copied"}</span>
      </button>
      <span className="sr-status" role="status" aria-live="polite">
        {status}
      </span>
    </>
  );
}

/** When scripts/hf.ts last read the Hugging Face repos (the small index every page already bundles). */
export const WEIGHTS_READ_ON: string = weightsIndex.asOf;

/** Every page: the snapshot date, its age, provenance and attribution. */
export function SiteFooter() {
  const age = snapshotAgeDays(todayIso());
  const stale = age > 14;
  return (
    <footer className="site-foot">
      <div className="site-foot-inner">
        <Meter />
        <p className="site-foot-line">
          <span className={stale ? "stale" : undefined} title={stale ? "Older than two weeks" : undefined}>
            Prices as of {CATALOG_META.asOf} ({age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`})
          </span>
          <span>
            {fmtInt(CATALOG_META.models)} models · {CATALOG_META.vendors} vendors
          </span>
          <span>
            Hand-checked list prices on {CATALOG_META.firstParty} models; the rest are OpenRouter aggregates
          </span>
          <span>Capability scores: Artificial Analysis indices via OpenRouter, snapshot {CATALOG_META.asOf}</span>
          <span>Model architectures: Hugging Face, read {WEIGHTS_READ_ON}</span>
        </p>
        <p className="site-foot-line">
          <span>List-price cost at your workload, not cost per task.</span>
          <span>
            <a href="https://github.com/marcwayn/lmomnibus">Source</a> · MIT
          </span>
        </p>
      </div>
    </footer>
  );
}

/** "retires 10-20" in the market; the full date and countdown on hover. */
export function RetireTag({ model, today }: { model: Model; today: string }) {
  if (!model.retiresOn) return null;
  const days = daysBetween(today, model.retiresOn);
  if (days < 0) return null;
  return (
    <span className="retire-tag" title={`Scheduled to retire on ${model.retiresOn} (${daysLabel(days)})`}>
      retires {model.retiresOn.slice(5)}
    </span>
  );
}
