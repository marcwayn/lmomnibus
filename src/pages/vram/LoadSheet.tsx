import { useId } from "react";
import type { Device } from "../../core/devices.ts";
import { GiB, VERDICT_LABEL, type Engine, type Range, type VramEstimate } from "../../core/vram.ts";
import { useWidth } from "./fields.tsx";
import { capText, g1, g2, rigText, unconfirmed } from "./text.ts";

/** Segment styles: told apart by pattern and shade only, never pine or brick. */
export type SegKind = "weights" | "encoders" | "kv" | "state" | "compute" | "runtime" | "display";

/** A legend swatch drawn with the same pattern as its load-sheet segment. */
export function Swatch({ kind }: { kind: SegKind }) {
  return <span className={`vr-sw vr-sw-${kind}`} aria-hidden="true" />;
}

/** Host items are weights (embedding table, experts, lookup tables) or the host compute buffer. */
export const hostKind = (label: string): SegKind => (/buffer/i.test(label) ? "compute" : "weights");

interface Seg {
  kind: SegKind;
  label: string;
  r: Range;
}
interface Row {
  label: string;
  segs: Seg[];
  total: Range;
  /** Checked against the GPU budget (System RAM isn't). */
  budgeted: boolean;
}

const sum = (rs: Range[]): Range => rs.reduce((a, b) => ({ low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high }), { low: 0, mid: 0, high: 0 });

/** Rows to draw: one per GPU when their loads differ, otherwise one; System RAM when anything sits on the host. */
function loadRows(e: VramEstimate, count: number, unified: boolean): Row[] {
  const n = e.perGpu.length;
  const mids = e.perGpu.map((r) => r.mid);
  const differ = n > 1 && Math.max(...mids) - Math.min(...mids) > 2 ** 20;
  const rows: Row[] = [];
  for (let i = 0; i < (differ ? n : 1); i++) {
    const segs: Seg[] = e.lines.map((l) => ({ kind: l.id as SegKind, label: l.label, r: l.perGpu[i] })).filter((s) => s.r.mid > 0);
    if (unified) for (const h of e.hostItems) if (h.bytes.mid > 0) segs.push({ kind: hostKind(h.label), label: h.label, r: h.bytes });
    const label = unified ? "Unified memory" : differ ? `GPU ${i + 1}` : count > 1 ? `Each of ${count}` : "GPU";
    rows.push({ label, segs, total: sum(segs.map((s) => s.r)), budgeted: true });
  }
  if (!unified && e.host.mid > 0) {
    const segs = e.hostItems.filter((h) => h.bytes.mid > 0).map((h) => ({ kind: hostKind(h.label), label: h.label, r: h.bytes }));
    rows.push({ label: "System RAM", segs, total: sum(segs.map((s) => s.r)), budgeted: false });
  }
  return rows;
}

function niceStep(max: number): number {
  const raw = max / 7;
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 5, 10].map((m) => m * p).find((s) => max / s <= 10) ?? 10 * p) || 1;
}

const ROW = 46;
const TOP = 30;
const CHAR = 6.1;
/** Character width of the bold 10.5px "over by" label. */
const OVER_CHAR = 6.6;

const overText = (row: Row, budget: number) => `over by ${g1(row.total.mid - budget)}`;

interface SegLabel {
  text: string;
  w: number;
  /** Inside the segment, or above it on a leader from cx to lx. */
  inside: boolean;
  cx: number;
  lx: number;
}

/**
 * Direct labels for one row's segments: inside a segment when they fit,
 * otherwise above it on a leader. Outside spots go to the largest segments
 * first, so a 1 GiB encoder never crowds out the KV cache; a label that would
 * sit far from its segment is left to the working table.
 */
function segLabels(segs: { label: string; r: Range; x0: number; x1: number }[], left: number, right: number): Map<string, SegLabel> {
  const out = new Map<string, SegLabel>();
  const placed: { x: number; w: number }[] = [];
  const free = (lx: number, w: number) => !placed.some((p) => lx < p.x + p.w + 4 && lx + w + 4 > p.x);
  for (const s of [...segs].sort((a, b) => b.r.mid - a.r.mid)) {
    const text = `${s.label} ${g2(s.r.mid)}`;
    const w = text.length * CHAR + 6;
    const cx = (s.x0 + s.x1) / 2;
    if (s.x1 - s.x0 >= w + 4) {
      out.set(s.label, { text, w, inside: true, cx, lx: s.x0 + 3 });
      continue;
    }
    // Where it would like to start, then just past or before each label already placed.
    const want = cx - 2;
    const spots = [want, ...placed.flatMap((p) => [p.x + p.w + 8, p.x - w - 8])]
      .map((lx) => Math.min(Math.max(lx, left), right - w))
      .filter((lx) => lx - cx <= 90 && cx - lx <= 40 && free(lx, w))
      .sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
    if (!spots.length) continue;
    placed.push({ x: spots[0], w });
    out.set(s.label, { text, w, inside: false, cx, lx: spots[0] });
  }
  return out;
}

/**
 * The load sheet: what fills each GPU, segment by segment, against the
 * device's capacity and the engine's budget, with the estimate's range as a
 * whisker and anything past the budget faded.
 */
export function LoadSheet({
  e,
  device,
  count,
  engine,
}: {
  e: VramEstimate;
  device: Device;
  count: number;
  engine: Engine;
}) {
  const uid = useId().replace(/:/g, "");
  const [frame, width] = useWidth<HTMLDivElement>(880);
  const unified = device.cls === "unified";
  const rows = loadRows(e, count, unified);
  const W = Math.max(320, Math.min(880, width - 2));
  // Narrow: labels move out of the bars into a legend list under the chart.
  const narrow = W < 560;
  // Room for the longest row label.
  const L = Math.max(narrow ? 56 : 64, Math.max(...rows.map((r) => r.label.length)) * 6.4 + 14);
  const R = 18;
  const H = TOP + ROW * rows.length + 26;
  const budget = e.budget;
  // The solid line is what the device has: RAM on a unified machine, the driver's figure on a GPU.
  const capBytes = unified && device.ramGiB ? device.ramGiB * GiB : device.usableGiB * GiB;
  const showBudget = Math.abs(capBytes - budget) > 2 ** 24;
  // An over-budget row's "over by" label sits just past its bar: leave room for it on the right.
  const plotW = W - L - R;
  const roomFor = (row: Row) => (row.total.mid * plotW) / Math.max(plotW / 2, W - 10 - overText(row, budget).length * OVER_CHAR - L);
  const overRows = rows.filter((r) => r.budgeted && r.total.mid > budget);
  const xMax = Math.max(capBytes, budget, ...rows.map((r) => r.total.high), ...overRows.map(roomFor)) * 1.05;
  const x = (b: number) => L + (Math.max(0, b) / xMax) * plotW;
  const stepGiB = niceStep(xMax / GiB);
  const step = stepGiB * GiB;
  const tick = (b: number) => (b / GiB).toFixed(stepGiB < 1 ? 1 : 0);
  const ticks: number[] = [];
  for (let t = 0; t <= xMax; t += step) ticks.push(t);
  const gpuRows = rows.filter((r) => r.budgeted).length;
  // A capacity that isn't driver output says so wherever it's printed.
  const unsure = unconfirmed(device) ? " (unconfirmed)" : "";
  const capLabel = unified && device.ramGiB ? `${device.short} · ${device.ramGiB} GiB RAM` : `${device.short} · ${capText(device.usableGiB)}${unsure}`;
  const budgetLabel =
    engine === "vllm"
      ? `vLLM budget ${Math.round((budget / capBytes) * 100)}% · ${g2(budget)}`
      : device.vendor === "apple"
        ? `macOS GPU cap · ${g1(budget)} GiB`
        : `GPU usable · ${g1(budget)} GiB${unified ? unsure : ""}`;
  const top3 = [...rows[0].segs].sort((a, b) => b.r.mid - a.r.mid).slice(0, 3);
  const aria = `Load sheet: ${VERDICT_LABEL[e.verdict]}. ${top3.map((s) => `${s.label} about ${g1(s.r.mid)} GiB`).join(", ")}${rows[0].segs.length > 3 ? " and smaller items" : ""}, on ${rigText(device, count)} (${capText(budget / GiB)} usable${unsure}). The working table below lists every item.`;

  return (
    <figure className="vr-figure">
      <div className="chart-frame" ref={frame}>
        <svg className="vr-sheet" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria}>
          <defs>
            <pattern id={`${uid}-kv`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="vr-p2" x1="0" y1="0" x2="0" y2="5" />
            </pattern>
            <pattern id={`${uid}-state`} width="4" height="4" patternUnits="userSpaceOnUse">
              <circle className="vr-p2f" cx="2" cy="2" r="0.9" />
            </pattern>
            <pattern id={`${uid}-compute`} width="4" height="4" patternUnits="userSpaceOnUse">
              <line className="vr-p3" x1="0" y1="2" x2="4" y2="2" />
            </pattern>
            <pattern id={`${uid}-encoders`} width="4" height="4" patternUnits="userSpaceOnUse">
              <line className="vr-p3" x1="2" y1="0" x2="2" y2="4" />
            </pattern>
            <clipPath id={`${uid}-in`}>
              <rect x={0} y={0} width={x(budget)} height={H} />
            </clipPath>
            <clipPath id={`${uid}-out`}>
              <rect x={x(budget)} y={0} width={W} height={H} />
            </clipPath>
          </defs>

          {/* x axis: a meter rule in GiB */}
          <line className="axis" x1={L} x2={W - R} y1={H - 22} y2={H - 22} />
          {ticks.map((t) => (
            <g key={t}>
              <line className="axis" x1={x(t)} x2={x(t)} y1={H - 22} y2={H - 17} />
              <line className="grid" x1={x(t)} x2={x(t)} y1={TOP} y2={H - 22} />
              <text className="axis-label" x={x(t)} y={H - 6} textAnchor="middle">
                {tick(t)}
              </text>
            </g>
          ))}
          <text className="axis-title" x={L - 12} y={H - 6} textAnchor="end">
            GiB
          </text>

          {rows.map((row, ri) => {
            const y0 = TOP + ri * ROW;
            const barY = y0 + 14;
            let acc = 0;
            const segs = row.segs.map((s) => {
              const x0 = x(acc);
              acc += s.r.mid;
              return { ...s, x0, x1: x(acc) };
            });
            const labels = narrow ? null : segLabels(segs, L, W - 4);
            const bar = (faded: boolean) =>
              segs.map((s) => {
                const w = Math.max(0.5, s.x1 - s.x0 - 1);
                const fill = s.kind === "weights" ? undefined : s.kind === "runtime" || s.kind === "display" ? undefined : `url(#${uid}-${s.kind})`;
                return (
                  <rect
                    key={`${s.label}${faded ? "-o" : ""}`}
                    className={`vr-seg vr-seg-${s.kind}`}
                    x={s.x0}
                    y={barY}
                    width={w}
                    height={16}
                    style={fill ? { fill } : undefined}
                  />
                );
              });
            return (
              <g key={row.label}>
                <text className="vr-row-label" x={L - 8} y={barY + 12} textAnchor="end">
                  {row.label}
                </text>
                {row.budgeted ? (
                  <>
                    <g clipPath={`url(#${uid}-in)`}>{bar(false)}</g>
                    <g clipPath={`url(#${uid}-out)`} className="vr-over">
                      {bar(true)}
                    </g>
                  </>
                ) : (
                  bar(false)
                )}
                {/* direct labels: inside the segment when they fit, else above it on a leader */}
                {labels &&
                  segs.map((s) => {
                    const l = labels.get(s.label);
                    if (!l) return null;
                    return l.inside ? (
                      <g key={`l-${s.label}`} className="vr-seg-label">
                        <rect x={l.lx} y={barY + 2.5} width={l.w} height={11} className="vr-label-bg" />
                        <text x={l.lx + 3} y={barY + 11.5}>
                          {l.text}
                        </text>
                      </g>
                    ) : (
                      <g key={`l-${s.label}`} className="vr-seg-label out">
                        <line className="vr-leader" x1={l.cx} x2={l.cx} y1={barY} y2={y0 + 8} />
                        <line className="vr-leader" x1={l.cx} x2={l.lx} y1={y0 + 8} y2={y0 + 8} />
                        <text x={l.lx + 2} y={y0 + 5}>
                          {l.text}
                        </text>
                      </g>
                    );
                  })}

                {/* the estimate's range */}
                <g className="vr-whisker">
                  <line x1={x(row.total.low)} x2={x(row.total.high)} y1={barY + 24} y2={barY + 24} />
                  <line x1={x(row.total.low)} x2={x(row.total.low)} y1={barY + 21} y2={barY + 27} />
                  <line x1={x(row.total.high)} x2={x(row.total.high)} y1={barY + 21} y2={barY + 27} />
                  <line x1={x(row.total.mid)} x2={x(row.total.mid)} y1={barY + 20} y2={barY + 28} className="mid" />
                </g>
              </g>
            );
          })}

          {/* capacity and budget lines, across the GPU rows */}
          <line className="vr-cap" x1={x(capBytes)} x2={x(capBytes)} y1={TOP - 6} y2={TOP + gpuRows * ROW - 6} />
          <text className="vr-cap-label" x={x(capBytes)} y={10} textAnchor={x(capBytes) > W - 170 ? "end" : "start"} dx={x(capBytes) > W - 170 ? -4 : 4}>
            {capLabel}
          </text>
          {showBudget && (
            <>
              <line className="vr-budget" x1={x(budget)} x2={x(budget)} y1={TOP - 6} y2={TOP + gpuRows * ROW - 6} />
              <text className="vr-cap-label" x={x(budget)} y={22} textAnchor={x(budget) > W - 170 ? "end" : "start"} dx={x(budget) > W - 170 ? -4 : 4}>
                {budgetLabel}
              </text>
            </>
          )}

          {/* "over by": just past each over-budget bar, drawn last on a background so no line runs through it */}
          {rows.map((row, ri) => {
            if (!overRows.includes(row)) return null;
            const barY = TOP + ri * ROW + 14;
            const text = overText(row, budget);
            const w = text.length * OVER_CHAR;
            const lx = Math.min(x(row.total.mid) + 6, W - 4 - w);
            return (
              <g key={`over-${row.label}`}>
                <rect className="vr-label-bg" x={lx - 2} y={barY + 2.5} width={w + 4} height={12} />
                <text className="vr-over-label" x={lx} y={barY + 12}>
                  {text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {narrow && (
        <dl className="vr-legend-list">
          {rows.map((row) =>
            row.segs.map((s) => (
              <div key={`${row.label}-${s.label}`}>
                <dt>
                  <Swatch kind={s.kind} /> {s.label}
                  {rows.length > 1 && <span className="vd"> · {row.label}</span>}
                </dt>
                <dd>≈ {g2(s.r.mid)}</dd>
              </div>
            )),
          )}
        </dl>
      )}
    </figure>
  );
}
