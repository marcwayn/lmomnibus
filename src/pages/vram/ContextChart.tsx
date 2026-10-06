import { useId, useMemo } from "react";
import type { Device } from "../../core/devices.ts";
import { estimate, fmtCtx, GiB, KV_OPTIONS, maxContext, type VramModel, type VramSettings } from "../../core/vram.ts";
import { useWidth } from "./fields.tsx";
import { capText, g1, g2, kvLabel, rigText, tokens, unconfirmed } from "./text.ts";

const LO = 1024;
/** Line styles per KV precision, in the engine's order: solid, dashed, dotted ink. */
const STYLE = ["k1", "k2", "k3"];

/**
 * Total need against context for each KV precision the engine offers, on a
 * log₂ context axis, with the budget line, where each line crosses it, the
 * current context and the config's own limit.
 */
export function ContextChart({
  vm,
  s,
  limit,
  native,
  device,
}: {
  vm: VramModel;
  s: VramSettings;
  limit: number;
  native: number | null;
  device: Device;
}) {
  const uid = useId().replace(/:/g, "");
  const [frame, width] = useWidth<HTMLDivElement>(880);
  const W = Math.max(320, Math.min(880, width - 2));
  const narrow = W < 560;
  const H = narrow ? 260 : 320;
  const M = narrow ? { top: 30, right: 14, bottom: 34, left: 40 } : { top: 30, right: 24, bottom: 36, left: 52 };
  const opts = KV_OPTIONS[s.engine];
  const span = Math.max(1, Math.log2(limit) - Math.log2(LO));

  const data = useMemo(() => {
    const samples: number[] = [];
    for (let i = 0; i <= span * 4; i++) samples.push(Math.round(LO * 2 ** (i / 4)));
    if (samples[samples.length - 1] !== limit) samples.push(limit);
    const lines = opts.map((o) => {
      const pts = samples.map((ctx) => {
        const e = estimate(vm, { ...s, kv: o.id, ctx });
        return { ctx, need: e.need };
      });
      const mx = maxContext(vm, { ...s, kv: o.id }, limit, "mid");
      return { kv: o.id, pts, max: mx };
    });
    const e0 = estimate(vm, { ...s, ctx: LO });
    const worst = e0.perGpu.indexOf(e0.perGpu.reduce((a, b) => (b.mid > a.mid ? b : a)));
    const floor = e0.lines.filter((l) => l.id === "weights" || l.id === "encoders").reduce((a, l) => a + l.perGpu[worst].mid, 0);
    return { lines, floor, budget: e0.budget };
  }, [vm, s, limit, opts, span]);

  const budget = data.budget;
  const peak = Math.max(...data.lines.flatMap((l) => l.pts.map((p) => p.need.mid)));
  // Keep the budget line readable: past 4× the budget the lines run off the top.
  const yMax = Math.max(budget * 1.15, Math.min(peak * 1.08, budget * 4), data.floor * 1.2);
  const x = (ctx: number) => M.left + ((Math.log2(Math.max(ctx, LO)) - Math.log2(LO)) / span) * (W - M.left - M.right);
  const y = (b: number) => M.top + (1 - b / yMax) * (H - M.top - M.bottom);
  const yStep = (() => {
    const raw = yMax / GiB / 5;
    const p = 10 ** Math.floor(Math.log10(raw));
    return ([1, 2, 5, 10].map((m) => m * p).find((v) => yMax / GiB / v <= 6) ?? 10 * p) * GiB;
  })();
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax; v += yStep) yTicks.push(v);
  const octaves: number[] = [];
  for (let t = LO; t <= limit; t *= 2) octaves.push(t);
  const labelled = narrow
    ? new Set([LO, 32 * 1024, limit].filter((t) => t <= limit))
    : new Set(octaves.filter((_, i) => i % 3 === 0 || octaves.length <= 6));
  if (!narrow) labelled.add(limit);

  const sel = data.lines.find((l) => l.kv === s.kv) ?? data.lines[0];
  const band = [
    ...sel.pts.map((p, i) => `${i ? "L" : "M"}${x(p.ctx)},${y(Math.min(p.need.high, yMax * 1.2))}`),
    ...[...sel.pts].reverse().map((p) => `L${x(p.ctx)},${y(Math.min(p.need.low, yMax * 1.2))}`),
    "Z",
  ].join(" ");
  const first = sel.pts[0].need.mid;
  const at128 = sel.pts.find((p) => p.ctx >= Math.min(limit, 128 * 1024)) ?? sel.pts[sel.pts.length - 1];
  // The budget as the load sheet and the answer print it (23.99 GiB, not a rounded-up 24.0).
  const budgetText = capText(budget / GiB);
  const crosses = sel.max.limitedBy === "memory" ? `; crosses ${budgetText} at about ${fmtCtx(sel.max.tokens)}` : sel.max.limitedBy === "weights" ? "; above the budget at every context" : "; stays under the budget up to the model's maximum";
  const summary = `Need rises from ${g1(first)} GiB at 1K to ${g1(at128.need.mid)} GiB at ${fmtCtx(at128.ctx)} with ${kvLabel(s.engine, sel.kv)} KV cache${crosses}.`;

  // Crossing markers, their labels stacked under the budget line so none overlap.
  const placed: { x0: number; x1: number; row: number }[] = [];
  const marks = data.lines
    .filter((l) => l.max.limitedBy === "memory" && l.max.tokens >= LO)
    .map((l) => {
      const cx = x(l.max.tokens);
      const text = `${opts.length > 1 ? `${kvLabel(s.engine, l.kv)} ` : ""}max ≈ ${fmtCtx(l.max.tokens)}`;
      const w = text.length * 6.8;
      const anchor: "start" | "end" = cx + 6 + w > W - M.right ? "end" : "start";
      const x0 = anchor === "start" ? cx + 6 : cx - 6 - w;
      let row = 0;
      while (placed.some((p) => p.row === row && x0 < p.x1 + 12 && x0 + w > p.x0 - 12)) row++;
      placed.push({ x0, x1: x0 + w, row });
      return { kv: l.kv, cx, text, anchor, row };
    });
  const capLabel = `${s.count > 1 ? `${s.count} × ` : ""}${device.short} · ${s.engine === "vllm" ? "vLLM budget " : ""}${budgetText}${device.vendor === "apple" ? " GPU cap" : ""}${s.count > 1 ? " each" : ""}${unconfirmed(device) ? " (unconfirmed)" : ""}`;
  // The config's own limit, labelled to its right unless that runs past the edge.
  const nativeText = native !== null ? `native ${narrow ? fmtCtx(native) : tokens(native)}` : "";
  const flips = (text: string) => native !== null && x(native) + 4 + text.length * 6.2 > W - M.right;
  const nativeFlip = flips(nativeText);
  const ropeFlip = flips("RoPE scaling →");

  return (
    <figure className="vr-figure">
      <div className="chart-frame" ref={frame}>
        <svg className="frontier-chart vr-ctx-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
          <defs>
            <pattern id={`${uid}-band`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line className="vr-p3" x1="0" y1="0" x2="0" y2="5" />
            </pattern>
            <clipPath id={`${uid}-plot`}>
              <rect x={M.left} y={M.top - 2} width={W - M.left - M.right} height={H - M.top - M.bottom + 2} />
            </clipPath>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
              <text className="axis-label" x={M.left - 6} y={y(v) + 4} textAnchor="end">
                {(v / GiB).toFixed(yStep < GiB ? 1 : 0)}
              </text>
            </g>
          ))}
          <line className="axis" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
          {octaves.map((t) => (
            <g key={t}>
              <line className="axis" x1={x(t)} x2={x(t)} y1={H - M.bottom} y2={H - M.bottom + (labelled.has(t) ? 8 : 4)} />
              {labelled.has(t) && (
                <text className="axis-label" x={x(t)} y={H - M.bottom + 21} textAnchor={t === LO ? "start" : "middle"}>
                  {fmtCtx(t)}
                </text>
              )}
            </g>
          ))}
          {limit !== octaves[octaves.length - 1] && labelled.has(limit) && (
            <text className="axis-label" x={x(limit)} y={H - M.bottom + 21} textAnchor="end">
              {fmtCtx(limit)}
            </text>
          )}
          <text className="axis-title" x={M.left} y={M.top - 16}>
            ↑ GiB per GPU (≈)
          </text>
          {!narrow && (
            <text className="axis-title" x={W - M.right} y={H - 2} textAnchor="end">
              context per sequence, log scale
            </text>
          )}

          <g clipPath={`url(#${uid}-plot)`}>
            <path className="vr-band" d={band} style={{ fill: `url(#${uid}-band)` }} />
            <line className="vr-floor" x1={M.left} x2={W - M.right} y1={y(data.floor)} y2={y(data.floor)} />
            {data.lines.map((l, i) => (
              <path
                key={l.kv}
                className={`vr-kv-line ${STYLE[i]}`}
                d={l.pts.map((p, j) => `${j ? "L" : "M"}${x(p.ctx)},${y(p.need.mid)}`).join(" ")}
              />
            ))}
          </g>
          {!narrow && Math.abs(y(data.floor) - y(budget)) > 16 && (
            <text className="vr-chart-note" x={M.left + 4} y={y(data.floor) + 13}>
              weights only
            </text>
          )}

          {/* budget: a meter-ticked rule */}
          <line className="vr-cap" x1={M.left} x2={W - M.right} y1={y(budget)} y2={y(budget)} />
          {Array.from({ length: Math.floor((W - M.left - M.right) / 13) + 1 }, (_, i) => (
            <line key={i} className="vr-cap-tick" x1={M.left + i * 13} x2={M.left + i * 13} y1={y(budget)} y2={y(budget) + 4} />
          ))}
          <text className="vr-cap-label" x={M.left + 4} y={y(budget) - 6}>
            {capLabel}
          </text>

          {native !== null && native < limit && (
            <g className="vr-native">
              <line x1={x(native)} x2={x(native)} y1={M.top} y2={H - M.bottom} />
              <text x={x(native) + (nativeFlip ? -4 : 4)} y={M.top + 10} textAnchor={nativeFlip ? "end" : "start"}>
                {nativeText}
              </text>
              {!narrow && (
                <text x={x(native) + (ropeFlip ? -4 : 4)} y={H - M.bottom - 6} textAnchor={ropeFlip ? "end" : "start"}>
                  RoPE scaling →
                </text>
              )}
            </g>
          )}
          {s.ctx >= LO && <line className="vr-now" x1={x(s.ctx)} x2={x(s.ctx)} y1={M.top - 4} y2={H - M.bottom} />}
          {/* Crossings in two passes: every marker and leader first, then the labels on their backgrounds, so a later
              crossing's leader never runs through an earlier one's figure. */}
          {marks.map((m) => (
            <g key={m.kv} className="vr-cross">
              <circle cx={m.cx} cy={y(budget)} r={3.5} />
              {m.row > 0 && <line className="vr-leader" x1={m.cx} x2={m.cx} y1={y(budget) + 4} y2={y(budget) + 6 + 13 * m.row} />}
            </g>
          ))}
          {marks.map((m) => (
            <g key={`${m.kv}-label`} className="vr-cross">
              <rect
                className="vr-label-bg"
                x={m.anchor === "end" ? m.cx - 8 - m.text.length * 6.8 : m.cx + 4}
                y={y(budget) + 5 + 13 * m.row}
                width={m.text.length * 6.8 + 4}
                height={13}
              />
              <text x={m.cx + (m.anchor === "end" ? -6 : 6)} y={y(budget) + 15 + 13 * m.row} textAnchor={m.anchor}>
                {m.text}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="vr-key">
        {opts.map((o, i) => (
          <span key={o.id}>
            <svg className={`vr-key-line vr-kv-line ${STYLE[i]}`} viewBox="0 0 22 6" aria-hidden="true">
              <path d="M0 3H22" />
            </svg>
            {o.label} KV{o.id === s.kv ? " (selected; hatched band = its range)" : ""}
          </span>
        ))}
        <span>
          <svg className="vr-key-line vr-floor" viewBox="0 0 22 6" aria-hidden="true">
            <path d="M0 3H22" />
          </svg>
          weights only
        </span>
        <span>
          <svg className="vr-key-line vr-now" viewBox="0 0 6 10" aria-hidden="true">
            <path d="M3 0V10" />
          </svg>
          your context
        </span>
      </figcaption>
      <details className="all-plotted">
        <summary>Show as table</summary>
        <div className="table-frame">
          <table className="market">
            <caption className="sr-only">Estimated GiB per GPU at each context, for each KV cache precision</caption>
            <thead>
              <tr>
                <th scope="col">Context</th>
                {data.lines.map((l) => (
                  <th key={l.kv} scope="col" className="n">
                    ≈ GiB, {kvLabel(s.engine, l.kv)} KV
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.lines[0].pts
                .map((p, i) => ({ p, i }))
                .filter(({ p }) => Number.isInteger(Math.log2(p.ctx)) || p.ctx === limit)
                .map(({ p, i }) => (
                  <tr key={p.ctx}>
                    <th scope="row" className="mono">
                      {fmtCtx(p.ctx)}
                    </th>
                    {data.lines.map((l) => (
                      <td key={l.kv} className="n">
                        {g2(l.pts[i].need.mid)}
                        <span className="vd">{l.pts[i].need.mid <= budget ? "under budget" : "over budget"}</span>
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="fine">Budget: {budgetText} per GPU on {rigText(device, s.count)}.</p>
      </details>
    </figure>
  );
}
