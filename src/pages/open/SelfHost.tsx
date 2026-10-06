import { memo, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { trackEvent } from "../../analytics.ts";
import { Mark } from "../../components.tsx";
import { DEFAULT_DEVICE_ID, DEVICE_BY_ID, DEVICES, drivesDisplay, type Device } from "../../core/devices.ts";
import { INDEX_LABEL, scoreOf, type Index, type Priced } from "../../core/frontier.ts";
import type { Model } from "../../core/model.ts";
import { selfHostFrontier } from "../../core/openclosed.ts";
import { pageSettings, smallestSetup, type Setup } from "../../core/selfhost.ts";
import { encodeKey } from "../../core/share.ts";
import {
  estimate,
  fmtCtx,
  formatLabel,
  formatOptions,
  GiB,
  MiB,
  modelMaxContext,
  VERDICT_LABEL,
  VLLM_UTIL,
  type FormatOption,
  type Range,
  type VramModel,
  type VramSettings,
  type Verdict,
} from "../../core/vram.ts";
import { vramModelFor, WEIGHTS } from "../../weightsData.ts";
import { SELF_CONTEXTS, SELF_FORMATS, type SelfCtx, type SelfFormat } from "./state.ts";
import { fmtScore, INTERNAL, markBox, placeText, Stamp, useNarrow, useSettled, type Box, type TextSpot } from "./shared.tsx";

/**
 * §D, "What can I run myself?": every rated open-weight model's estimated
 * memory at one llama.cpp setup (log2 GiB) against its AA score, with the
 * best score reachable within each size, the usable memory of common GPUs
 * and Macs, and where the best closed models sit.
 */
const ANSWER_DEVICE: Device = DEVICE_BY_ID.get(DEFAULT_DEVICE_ID)!;
const GGUF_ORDER = ["q8_0", "q6_k", "q5_k_m", "q4_k_m", "iq4_xs", "q3_k_m", "q2_k", "iq2_xxs"];

export const memoryDataAvailable = Object.keys(WEIGHTS.models).length > 0;

/**
 * The format a self-hoster would run for `sq`: the published format when the
 * weights already ship at or below that size (MXFP4), else that GGUF type,
 * else the next GGUF type down when llama.cpp can't run the published one.
 * GGUF-only repos use the file named for the type, else their smallest file.
 */
export function pickFormat(vm: VramModel, sq: SelfFormat): FormatOption | null {
  const opts = formatOptions(vm, "llamacpp", ANSWER_DEVICE).filter((o) => !o.disabled);
  if (!opts.length) return null;
  if (vm.ggufFiles?.length) return opts.find((o) => o.file?.name.toLowerCase().includes(sq)) ?? [...opts].sort((a, b) => a.bits - b.bits)[0];
  const exact = opts.find((o) => o.id === sq);
  // A type that isn't offered would be an upcast of the published weights, so it's bigger still.
  const published = opts.find((o) => o.id === "mxfp4");
  if (published && (!exact || published.bits <= exact.bits)) return published;
  if (exact) return exact;
  for (const id of GGUF_ORDER.slice(GGUF_ORDER.indexOf(sq) + 1)) {
    const o = opts.find((x) => x.id === id);
    if (o) return o;
  }
  return opts[opts.length - 1];
}

/** §D's one setup: llama.cpp, F16 KV, one sequence, flash attention, on one RTX 4090 that also drives a display. */
export function selfSettings(format: FormatOption, ctx: number): VramSettings {
  return {
    engine: "llamacpp",
    format: format.id,
    fileBytes: format.file?.bytes ?? null,
    bpw: null,
    ctx,
    seqs: 1,
    kv: "f16",
    device: ANSWER_DEVICE,
    count: 1,
    util: VLLM_UTIL,
    mbt: null,
    ub: 512,
    flashAttn: true,
    swaFull: false,
    expertsOnHost: false,
    vision: false,
    mtp: false,
    lookupOnHost: true,
    display: drivesDisplay(ANSWER_DEVICE),
    macRaised: false,
  };
}

export interface SelfPoint {
  model: Model;
  score: number | null;
  /** GPU memory needed on one device, GiB. */
  gib: number;
  low: number;
  high: number;
  moe: boolean;
  format: FormatOption;
  ctx: number;
  /** On one RTX 4090. */
  verdict: Verdict;
  vm: VramModel;
}

/** One model at the page's setup, or null when there's no architecture record to estimate from. */
export function selfEstimate(m: Model, index: Index, sq: SelfFormat, ctxWanted: number): SelfPoint | null {
  const vm = vramModelFor(m);
  if (!vm) return null;
  const format = pickFormat(vm, sq);
  if (!format) return null;
  const ctx = Math.min(ctxWanted, modelMaxContext(vm, m.contextTokens));
  const e = estimate(vm, selfSettings(format, ctx));
  if (e.invalid) return null;
  return {
    model: m,
    score: scoreOf(m, index),
    gib: e.need.mid / GiB,
    low: e.need.low / GiB,
    high: e.need.high / GiB,
    moe: Boolean(vm.moe),
    format,
    ctx,
    verdict: e.verdict,
    vm,
  };
}

export interface PageFigure {
  model: Model;
  format: FormatOption;
  ctx: number;
  /** GPU memory on one headless RTX 4090 (the model page's reference GPU), bytes. */
  need: Range;
  /** The smallest setup on the model pages' ladder that holds the top of the range; null past its end. */
  setup: Setup | null;
}

/**
 * One model at §D's format and context, sized exactly as its model page sizes
 * it (core/selfhost.ts: a headless GPU, F16 KV, one sequence), so §B's "Run it
 * yourself" names the same figure and the same smallest setup as the model
 * page. §D's own answer adds the display a single RTX 4090 usually drives.
 */
export function pageFigure(m: Model, sq: SelfFormat, ctxWanted: number): PageFigure | null {
  const vm = vramModelFor(m);
  if (!vm) return null;
  const format = pickFormat(vm, sq);
  if (!format) return null;
  const ctx = Math.min(ctxWanted, modelMaxContext(vm, m.contextTokens));
  const s = pageSettings("llamacpp", format.id, ctx, undefined, format.file?.bytes ?? null);
  const e = estimate(vm, s);
  if (e.invalid) return null;
  return { model: m, format, ctx, need: e.need, setup: smallestSetup(vm, s) };
}

/** The VRAM Estimator at the same model, format and context; `headless` for the model pages' figure (§D's has a display). */
export function vramHref(p: Pick<SelfPoint, "model" | "format" | "ctx">, sctx: SelfCtx, headless = false): string {
  const q = p.format.id === "file" ? "" : `&q=${p.format.id}`;
  return `/tools/vram?m=${encodeKey(p.model.key)}${q}&ctx=${p.ctx === SELF_CONTEXTS[sctx] ? sctx : fmtCtx(p.ctx).toLowerCase()}${headless ? "&disp=0" : ""}`;
}

const fmtG = (g: number) => (g >= 100 ? g.toFixed(0) : g.toFixed(1));

/** "45.2–47.2": a need's range in the unit fmtNeed gives its middle (GiB, whole from 100; MiB below 1 GiB). */
export function needRange(r: Range): string {
  const f = (b: number) =>
    r.mid < GiB ? String(Math.round(b / MiB)) : b / GiB >= 100 ? Math.round(b / GiB).toLocaleString("en-US") : (b / GiB).toFixed(1);
  return `${f(r.low)}–${f(r.high)}`;
}

// ---------------------------------------------------------------- device rules

interface DeviceRule {
  gib: number;
  label: string;
  short: string;
  mac: boolean;
  names: string[];
}

function shortName(d: Device): string {
  if (d.vendor === "apple") return /M\d+(?: (?:Pro|Max|Ultra))?/.exec(d.name)?.[0] ?? d.short;
  return d.short.replace(/\s*\(.*?\)/g, "").replace(/\s*\d+GB\b/, "").trim();
}

/** The default device list's usable capacities, with near-identical ones (within 3%) merged into one rule. */
const RULES: DeviceRule[] = (() => {
  const ds = DEVICES.filter((d) => d.isDefault).sort((a, b) => a.usableGiB - b.usableGiB);
  const groups: Device[][] = [];
  for (const d of ds) {
    const last = groups.at(-1);
    if (last && d.usableGiB / last[0].usableGiB < 1.03) last.push(d);
    else groups.push([d]);
  }
  return groups.map((g) => {
    const lead = g.find((d) => d.id === DEFAULT_DEVICE_ID) ?? g.find((d) => d.cls === "consumer") ?? g[0];
    const mac = g.some((d) => d.vendor === "apple");
    const gib = lead.usableGiB;
    return {
      gib,
      label: `${lead.memoryGb}${lead.vendor === "apple" ? "*" : ""} · ${shortName(lead)}${g.length > 1 ? ` +${g.length - 1}` : ""}`,
      short: `${Math.round(gib)}${mac ? "*" : ""}`,
      mac,
      names: g.map((d) => `${d.name}: ${d.usableGiB} GiB usable${d.vendor === "apple" ? " (default GPU cap)" : ""}`),
    };
  });
})();

// ---------------------------------------------------------------- the section

export interface SelfHostProps {
  open: readonly Priced[];
  index: Index;
  sq: SelfFormat;
  sctx: SelfCtx;
  onSq: (q: SelfFormat) => void;
  onSctx: (c: SelfCtx) => void;
  bestClosed: { score: number; name: string } | null;
  bestClosedYearAgo: { score: number; by: string } | null;
}

export const SelfHostSection = memo(function SelfHostSection({ open, index, sq, sctx, onSq, onSctx, bestClosed, bestClosedYearAgo }: SelfHostProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(frameRef);
  const label = INDEX_LABEL[index];
  const ctxWanted = SELF_CONTEXTS[sctx];

  const { points, unrated, unestimated } = useMemo(() => {
    const pts: SelfPoint[] = [];
    let unratedN = 0;
    let none = 0;
    for (const p of open) {
      if (scoreOf(p.model, index) === null) {
        unratedN++;
        continue;
      }
      const e = selfEstimate(p.model, index, sq, ctxWanted);
      if (e) pts.push(e);
      else none++;
    }
    return { points: pts, unrated: unratedN, unestimated: none };
  }, [open, index, sq, ctxWanted]);

  const best = points.filter((p) => p.verdict === "fits").reduce<SelfPoint | null>((a, p) => (!a || p.score! > a.score! || (p.score === a.score && p.gib < a.gib) ? p : a), null);
  const fmtName = formatLabel(sq);
  const answerText = best
    ? `On one ${ANSWER_DEVICE.short} (${ANSWER_DEVICE.usableGiB} GiB, display attached) at ${fmtName} and ${fmtCtx(ctxWanted)} context, the best open-weight model that fits scores ${fmtScore(best.score!)} on AA ${label} (${best.model.displayName}, about ${fmtG(best.gib)} GiB, range ${fmtG(best.low)} to ${fmtG(best.high)}).`
    : `No rated open-weight model fits one ${ANSWER_DEVICE.short} (display attached) at ${fmtName} and ${fmtCtx(ctxWanted)} context.`;
  const settled = useSettled(answerText);

  if (!memoryDataAvailable) {
    return <div className="empty-bench">Memory data unavailable in this build.</div>;
  }

  return (
    <div ref={frameRef}>
      <p className="sr-only" role="status" aria-live="polite">
        {settled}
      </p>
      <figure className="oc-figure">
        <figcaption className="readout" id="oc-c-cap">
          {best ? (
            <>
              On one {ANSWER_DEVICE.short} (<span className="mono">{ANSWER_DEVICE.usableGiB} GiB</span>, display attached) at {fmtName} and{" "}
              <span className="mono">{fmtCtx(ctxWanted)}</span> context, the best open-weight model that fits scores{" "}
              <strong className="mono">{fmtScore(best.score!)}</strong> on AA {label} ({best.model.displayName}
              {best.format.id !== sq ? `, at ${best.format.label}` : ""}, <span className="mono">≈ {fmtG(best.gib)} GiB</span>, range{" "}
              <span className="mono">
                {fmtG(best.low)}–{fmtG(best.high)}
              </span>
              ).
            </>
          ) : (
            <>
              No rated open-weight model fits one {ANSWER_DEVICE.short} (display attached) at {fmtName} and{" "}
              <span className="mono">{fmtCtx(ctxWanted)}</span> context.
            </>
          )}{" "}
          {bestClosed && (
            <>
              The best closed model today scores <span className="mono">{fmtScore(bestClosed.score)}</span>.
            </>
          )}
        </figcaption>

        <p className="oc-assume">
          <Stamp /> Memory at{" "}
          <select
            className="oc-inline-select"
            aria-label="Weight format"
            value={sq}
            onChange={(e) => {
              const q = e.target.value as SelfFormat;
              trackEvent("Open vs Closed", "Self-host format", q);
              onSq(q);
            }}
          >
            {SELF_FORMATS.map((q) => (
              <option key={q} value={q}>
                {formatLabel(q)}
              </option>
            ))}
          </select>{" "}
          weights (or the published format when it’s no bigger),{" "}
          <span className="seg seg-small oc-inline-seg" role="group" aria-label="Context">
            {(Object.keys(SELF_CONTEXTS) as SelfCtx[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={sctx === c}
                className={sctx === c ? "on" : ""}
                onClick={() => {
                  trackEvent("Open vs Closed", "Self-host context", c);
                  onSctx(c);
                }}
              >
                {c.toUpperCase()}
              </button>
            ))}
          </span>{" "}
          context, F16 KV cache, 1 sequence, llama.cpp, display attached.{" "}
          <Link className="text-btn" state={INTERNAL} to="/tools/vram">
            Change the rest in the VRAM Estimator
            <Mark kind="to" />
          </Link>
        </p>

        {points.length < 5 ? (
          <div className="empty-bench">
            Only {points.length} rated open-weight {points.length === 1 ? "model has" : "models have"} a memory estimate with these filters, too
            few to chart.{" "}
            <Link state={INTERNAL} to="/tools/vram">
              Estimate one in the VRAM Estimator
            </Link>
            .
          </div>
        ) : (
          <>
            <p id="oc-c-sum" className="sr-only">
              {points.length} rated open-weight models by estimated memory (log scale) against AA {label}, with the best score reachable within
              each size, the usable memory of common GPUs and Macs, and the best closed scores. The table below has the same data.
            </p>
            <SelfHostChart
              points={points}
              index={index}
              sctx={sctx}
              narrow={narrow}
              bestClosed={bestClosed}
              bestClosedYearAgo={bestClosedYearAgo}
            />
            <ul className="oc-legend" aria-label="Legend">
              <li>
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <circle className="oc-sw-fill" cx="6" cy="6" r="4" />
                </svg>
                dense
              </li>
              <li>
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path className="oc-sw-fill" d="M6 1.5 10.5 10H1.5Z" />
                </svg>
                mixture of experts (all experts held in memory)
              </li>
              <li>
                <svg viewBox="0 0 24 12" aria-hidden="true">
                  <line className="oc-sw-whisker" x1="2" x2="22" y1="6" y2="6" />
                  <line className="oc-sw-whisker" x1="2" x2="2" y1="3" y2="9" />
                  <line className="oc-sw-whisker" x1="22" x2="22" y1="3" y2="9" />
                </svg>
                estimate range
              </li>
              <li>
                <svg viewBox="0 0 24 12" aria-hidden="true">
                  <line className="oc-sw-line open" x1="1" x2="23" y1="6" y2="6" />
                </svg>
                best score within each size
              </li>
              <li>
                <svg viewBox="0 0 12 14" aria-hidden="true">
                  <line className="oc-sw-device" x1="6" x2="6" y1="1" y2="13" />
                </svg>
                usable memory of one device
              </li>
            </ul>
          </>
        )}
      </figure>

      <p className="fine">
        *macOS default GPU cap (75% of RAM above 32 GiB). Each device line is what its driver reports as usable on one unit;
        hover a line for the devices it stands for. Clicking a model opens it in the VRAM Estimator.
      </p>
      <p className="fine">
        AA scored each model's reference deployment, usually the vendor's own at the published precision. A 4-bit quant on your
        machine may score lower; we have no measured penalty, so none is applied. Memory figures are estimates, with ranges shown
        as whiskers. Every figure in this section includes the display a single RTX 4090 usually drives (about 0.6 GiB, 0.3–1.5);
        the model pages and the pair sheet in §B size a headless GPU, so theirs run that much lower.{" "}
        {points.length} rated open-weight models are estimated
        {unrated || unestimated
          ? `; ${[unrated ? `${unrated} unrated` : "", unestimated ? `${unestimated} without an architecture we can read` : ""].filter(Boolean).join(" and ")} aren't plotted`
          : ""}
        . Models with a shorter maximum context are estimated at their maximum.
      </p>
      <p className="fine">
        1 GiB = 1,073,741,824 bytes. Device sizes are what the driver reports: an RTX 4090 shows 24,564 MiB (23.99 GiB), and a B200
        sold as "192 GB" shows 179.06 GiB. Hugging Face file sizes are decimal GB (1 GB = 0.931 GiB). 32K = 32,768 tokens.
      </p>

      {points.length > 0 && <SelfHostTable points={points} index={index} sctx={sctx} />}
    </div>
  );
});

// ---------------------------------------------------------------- Chart C

const WIDE = { W: 880, H: 400, M: { top: 58, right: 24, bottom: 40, left: 44 } };
const NARROW = { W: 360, H: 340, M: { top: 40, right: 12, bottom: 36, left: 32 } };

function SelfHostChart({
  points,
  index,
  sctx,
  narrow,
  bestClosed,
  bestClosedYearAgo,
}: {
  points: SelfPoint[];
  index: Index;
  sctx: SelfCtx;
  narrow: boolean;
  bestClosed: SelfHostProps["bestClosed"];
  bestClosedYearAgo: SelfHostProps["bestClosedYearAgo"];
}) {
  const navigate = useNavigate();
  const { W, H, M } = narrow ? NARROW : WIDE;
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const [shown, setShown] = useState<string | null>(null);

  const lo = 2 ** Math.floor(Math.log2(Math.min(4, ...points.map((p) => p.low))));
  const hi = 2 ** Math.ceil(Math.log2(Math.max(1024, ...points.map((p) => p.high))));
  const refs = [bestClosed?.score, bestClosedYearAgo?.score].filter((s): s is number => s != null);
  const scores = [...points.map((p) => p.score!), ...refs];
  const yMin = Math.max(0, Math.floor((Math.min(...scores) - 2) / 5) * 5);
  const yMax = Math.min(100, Math.ceil((Math.max(...scores) + 2) / 5) * 5);

  const x = (g: number) => M.left + ((Math.log2(Math.max(g, lo)) - Math.log2(lo)) / (Math.log2(hi) - Math.log2(lo))) * PW;
  const y = (s: number) => M.top + (1 - (s - yMin) / (yMax - yMin)) * PH;

  const xTicks: number[] = [];
  for (let g = lo; g <= hi; g *= 2) xTicks.push(g);
  const yStep = yMax - yMin > 40 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yTicks.push(v);

  const front = selfHostFrontier(points.map((p) => ({ ...p, score: p.score! })));
  const frontKeys = new Set(front.map((p) => p.model.key));
  const frontPath = front.length
    ? `${front.map((p, i) => (i === 0 ? `M${x(p.gib)},${y(p.score)}` : `H${x(p.gib)} V${y(p.score)}`)).join(" ")} H${x(hi)}`
    : "";

  // Device labels in up to four rows above the plot; a label with no room is left to the line's tooltip.
  const rules = RULES.filter((r) => r.gib >= lo && r.gib <= hi);
  const ruleLabels = useMemo(() => {
    const rows: { x0: number; x1: number }[][] = [[], [], [], []];
    const charW = 5.8;
    return rules.map((r) => {
      const text = narrow ? r.short : r.label;
      const w = text.length * charW;
      const rx = x(r.gib);
      const anchorEnd = rx + w > W - 2;
      const x0 = anchorEnd ? rx - w - 2 : rx + 2;
      for (let row = 0; row < (narrow ? 2 : 4); row++) {
        if (rows[row].every((b) => x0 > b.x1 + 6 || x0 + w < b.x0 - 6)) {
          rows[row].push({ x0, x1: x0 + w });
          return { text, x: anchorEnd ? rx - 2 : rx + 2, y: M.top - 8 - row * 11, anchor: anchorEnd ? ("end" as const) : ("start" as const) };
        }
      }
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow, lo, hi]);

  // The reference lines' labels: at the left end above the line, then below it, then further along,
  // clear of every point, its whisker and each other.
  const refLabels = useMemo(() => {
    const area: Box = { x0: M.left, y0: M.top, x1: W - M.right, y1: M.top + PH };
    const taken: Box[] = points.flatMap((p) => {
      const py = y(p.score!);
      // Whiskers are soft: a label covers one only when nothing else will do.
      return [markBox(x(p.gib), py, 5.5, p.model.key), { x0: x(p.low), x1: x(p.high), y0: py - 1, y1: py + 1, key: p.model.key, soft: true }];
    });
    const refs = [
      bestClosed && { cls: "today", score: bestClosed.score, text: `best closed today · ${fmtScore(bestClosed.score)}` },
      bestClosedYearAgo && {
        cls: "year",
        score: bestClosedYearAgo.score,
        text: `${narrow ? "best closed a year ago" : `best closed listed by ${bestClosedYearAgo.by}`} · ${fmtScore(bestClosedYearAgo.score)}`,
      },
    ].filter((r): r is { cls: string; score: number; text: string } => Boolean(r));
    return refs.map((r) => {
      const ly = y(r.score);
      const spots: TextSpot[] = [0, 1, 2, 3, 4, 5, 6, 7, 8].flatMap((i): TextSpot[] => [
        { x: M.left + 4 + (i / 8) * (PW - 8), y: ly - 4, anchor: i < 8 ? "start" : "end" },
        { x: M.left + 4 + (i / 8) * (PW - 8), y: ly + 12, anchor: i < 8 ? "start" : "end" },
      ]);
      return { ...r, ...placeText(spots, r.text.length, 10, area, taken) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, narrow, lo, hi, yMin, yMax, bestClosed, bestClosedYearAgo]);

  const go = (p: SelfPoint) => {
    trackEvent("Open vs Closed", "To VRAM", p.model.key);
    navigate(vramHref(p, sctx), { state: INTERNAL });
  };
  const sel = shown ? points.find((p) => p.model.key === shown) : null;
  const tri = (cx: number, cy: number) => `M${cx},${cy - 4.5} L${cx + 4.5},${cy + 3.5} L${cx - 4.5},${cy + 3.5}Z`;

  return (
    <div className="chart-frame">
      <svg
        className={`frontier-chart oc-chart oc-self${narrow ? " narrow" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-labelledby="oc-c-cap"
        aria-describedby="oc-c-sum"
      >
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={M.left - 8} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <line className="axis" x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH} />
        {xTicks.map((g) => (
          <g key={`x${g}`}>
            <line className="axis" x1={x(g)} x2={x(g)} y1={M.top + PH} y2={M.top + PH + (narrow && Math.log2(g) % 2 ? 3 : 6)} />
            {/* Phones label every other power of two: 4, 16, 64, 256, 1024. */}
            {(!narrow || Math.log2(g) % 2 === 0) && (
              <text className="axis-label" x={Math.min(x(g), W - 2 - String(g).length * 3.3)} y={M.top + PH + 20} textAnchor="middle">
                {g}
              </text>
            )}
          </g>
        ))}
        <text className="axis-title" x={W - M.right} y={H - 3} textAnchor="end">
          {narrow ? "GiB, log2 · estimate, display on" : `estimated GiB at ${sctx.toUpperCase()} context, display attached, log2 scale`}
        </text>
        <text className="axis-title" x={M.left - (narrow ? 28 : 40)} y={narrow ? M.top - 30 : 12}>
          ↑ AA {INDEX_LABEL[index]}
        </text>

        {rules.map((r, i) => {
          const lab = ruleLabels[i];
          return (
            <g key={r.gib} className="oc-device">
              <title>{r.names.join("\n")}</title>
              <line x1={x(r.gib)} x2={x(r.gib)} y1={M.top - 4} y2={M.top + PH} />
              {lab && (
                <text x={lab.x} y={lab.y} textAnchor={lab.anchor}>
                  {lab.text}
                </text>
              )}
            </g>
          );
        })}

        {refLabels.map((r) => (
          <line key={r.cls} className={`oc-ref ${r.cls}`} x1={M.left} x2={W - M.right} y1={y(r.score)} y2={y(r.score)} />
        ))}

        {frontPath && <path className="oc-front-line open" d={frontPath} />}

        {points.map((p) => {
          const px = x(p.gib);
          const py = y(p.score!);
          const on = frontKeys.has(p.model.key);
          const name = `${p.model.displayName}, AA ${fmtScore(p.score!)}, about ${fmtG(p.gib)} GiB at ${p.format.label}${on ? ", best within its size" : ""}. Open in the VRAM Estimator`;
          return (
            <g
              key={p.model.key}
              className={`oc-sh-pt${on ? " on" : ""}${shown === p.model.key ? " focused" : ""}`}
              {...(on ? { tabIndex: 0, role: "link", "aria-label": name } : {})}
              onPointerEnter={() => setShown(p.model.key)}
              onPointerLeave={() => setShown(null)}
              onFocus={() => setShown(p.model.key)}
              onBlur={() => setShown(null)}
              onClick={() => go(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  go(p);
                }
              }}
            >
              {!on && <title>{name}</title>}
              <line className="oc-whisker" x1={x(p.low)} x2={x(p.high)} y1={py} y2={py} />
              {p.moe ? <path className="oc-mark" d={tri(px, py)} /> : <circle className="oc-mark" cx={px} cy={py} r={3.5} />}
            </g>
          );
        })}

        {/* All text last, so its halo masks the lines and marks beneath it rather than the other way round. */}
        {refLabels.map((r) => (
          <text key={r.cls} className={`oc-ref-text ${r.cls}`} x={r.x} y={r.y} textAnchor={r.anchor}>
            {r.text}
          </text>
        ))}
        {sel && (
          <text
            className="focus-label"
            x={x(sel.gib) + (x(sel.gib) > W - 220 ? -8 : 8)}
            y={y(sel.score!) - 7}
            textAnchor={x(sel.gib) > W - 220 ? "end" : "start"}
          >
            {sel.model.displayName} · ≈ {fmtG(sel.gib)} GiB · {fmtScore(sel.score!)}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Chart C's data, as a table. */
function SelfHostTable({ points, index, sctx }: { points: SelfPoint[]; index: Index; sctx: SelfCtx }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => [...points].sort((a, b) => b.score! - a.score! || a.gib - b.gib), [points]);
  return (
    <details className="all-plotted" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>All {points.length} estimates, display attached, highest score first</summary>
      {open && (
        <div className="table-frame">
          <table className="market">
            <caption className="sr-only">
              Estimated GPU memory for each rated open-weight model at the settings above, with a display attached
            </caption>
            <thead>
              <tr>
                <th>Model</th>
                <th className="n">AA {INDEX_LABEL[index]}</th>
                <th>Format</th>
                <th className="n">Context</th>
                <th className="n">≈ GiB (range)</th>
                <th>One {ANSWER_DEVICE.short}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.model.key}>
                  <td>
                    <Link className="nm row-link" state={INTERNAL} to={vramHref(p, sctx)} onClick={() => trackEvent("Open vs Closed", "To VRAM", p.model.key)}>
                      {p.model.displayName}
                    </Link>
                    <span className="vd">{p.moe ? "MoE" : "dense"}</span>
                  </td>
                  <td className="n">{fmtScore(p.score!)}</td>
                  <td className="mono oc-small">{p.format.label}</td>
                  <td className="n">{fmtCtx(p.ctx)}</td>
                  <td className="n">
                    ≈ {fmtG(p.gib)} <span className="vd">({fmtG(p.low)}–{fmtG(p.high)})</span>
                  </td>
                  <td className="mono oc-small">{VERDICT_LABEL[p.verdict]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
