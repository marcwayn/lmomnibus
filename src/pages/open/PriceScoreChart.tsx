import { forwardRef, useEffect, useId, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.ts";
import { FallbackMark, Mark, SourceTag } from "../../components.tsx";
import { fmtCompact, fmtMoney, fmtUsd } from "../../core/fmt.ts";
import { INDEX_LABEL, logTicks, scoreOf, type Index, type Priced } from "../../core/frontier.ts";
import { inputModalities } from "../../core/model.ts";
import { SIDE_LABEL, sideOf, type OneSideZone, type ParityRow, type Side } from "../../core/openclosed.ts";
import { encodeKey } from "../../core/share.ts";
import {
  classLine,
  fmtCostTick,
  fmtRatio,
  fmtScore,
  fmtTarget,
  INTERNAL,
  markBox,
  placeLabels,
  placeText,
  SIDE_NAME,
  sideRank,
  textBox,
  type Box,
  type LabelRequest,
  type TextSpot,
} from "./shared.tsx";

/**
 * Chart A: every rated model on cost (log) × AA score, closed as squares and
 * open-weight as circles, each side with its own stepped frontier (closed
 * solid, open dashed). Filled = on its side's frontier. The draggable target
 * rule marks each side's cheapest answer; the cheaper of the two is the only
 * pine on the chart.
 */
const WIDE = { W: 880, H: 460, M: { top: 20, right: 24, bottom: 44, left: 52 } };
const NARROW = { W: 360, H: 380, M: { top: 20, right: 12, bottom: 40, left: 34 } };

export interface PriceScoreChartProps {
  plotted: Record<Side, Priced[]>;
  fronts: Record<Side, Priced[]>;
  index: Index;
  target: number;
  onTarget: (v: number) => void;
  onStep: (delta: number) => void;
  answers: ParityRow;
  zone: OneSideZone | null;
  pinned: string | null;
  shown: string | null;
  onPin: (key: string) => void;
  onPreview: (key: string | null) => void;
  narrow: boolean;
  labelledBy: string;
  describedBy: string;
}

const SIDES: Side[] = ["closed", "open"];

export function PriceScoreChart(props: PriceScoreChartProps) {
  const { plotted, fronts, index, target, onTarget, onStep, answers, zone, pinned, shown, onPin, onPreview, narrow } = props;
  const { W, H, M } = narrow ? NARROW : WIDE;
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const hatchId = `oc-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const svgRef = useRef<SVGSVGElement>(null);
  const ruleRef = useRef<SVGGElement>(null);
  const ruleLabelRef = useRef<SVGTextElement>(null);
  // Chromium ignores touch-action on SVG <g>, and React's touch listeners are
  // passive, so stop page panning on the rule (and its label) with a native listener.
  useEffect(() => {
    const els = [ruleRef.current, ruleLabelRef.current].filter((el): el is SVGGElement | SVGTextElement => el !== null);
    const stop = (e: Event) => e.preventDefault();
    for (const el of els) el.addEventListener("touchstart", stop, { passive: false });
    return () => els.forEach((el) => el.removeEventListener("touchstart", stop));
  }, []);
  const dragging = useRef(false);

  const all = [...plotted.closed, ...plotted.open];
  const costs = all.map((p) => p.cost);
  const scores = all.map((p) => scoreOf(p.model, index)!);
  const xMin = costs.length ? Math.min(...costs) / 1.4 : 0.01;
  const xMax = costs.length ? Math.max(...costs) * 1.4 : 100;
  const fitMin = scores.length ? Math.max(0, Math.floor((Math.min(...scores) - 2) / 5) * 5) : 0;
  const fitMax = scores.length ? Math.min(100, Math.ceil((Math.max(...scores) + 2) / 5) * 5) : 100;
  // A target outside the scores stretches the axis to it, so the rule sits at its true height.
  // (Dragging stops at the plot's edge, which is never beyond it, so a drag can't keep stretching it.)
  const yMin = target < fitMin ? Math.floor(target / 5) * 5 : fitMin;
  const yMax = target > fitMax ? Math.min(100, Math.ceil(target / 5) * 5) : fitMax;

  const x = (c: number) => M.left + ((Math.log10(c) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * PW;
  const y = (s: number) => M.top + (1 - (s - yMin) / (yMax - yMin)) * PH;
  const yInv = (py: number) => yMin + (1 - (py - M.top) / PH) * (yMax - yMin);

  const xTicks = logTicks(xMin, xMax);
  const yStep = yMax - yMin > 40 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yTicks.push(v);

  // Stepped frontier: across at the old score, then up to the new one, then on to the edge.
  const stepPath = (front: Priced[]) =>
    front
      .map((p, i) => {
        const px = x(p.cost);
        const py = y(scoreOf(p.model, index)!);
        if (i === 0) return `M${px},${py}`;
        return `L${px},${y(scoreOf(front[i - 1].model, index)!)} L${px},${py}`;
      })
      .join(" ");

  const frontKeys = new Set([...fronts.open, ...fronts.closed].map((p) => p.model.key));
  const answerKeys = new Set([answers.open?.model.key, answers.closed?.model.key].filter(Boolean) as string[]);
  const cheaper = answers.pricier === "closed" ? answers.open : answers.pricier === "open" ? answers.closed : null;

  const ruleY = y(Math.min(Math.max(target, yMin), yMax));
  // The bracket runs along the rule between the two answers, below it unless that leaves the plot.
  const bracketY = ruleY + 30 < M.top + PH ? ruleY + 12 : ruleY - 12;
  const tickDir = bracketY > ruleY ? -5 : 5;
  const missing = SIDES.filter((s) => !answers[s] && plotted[s].length > 0);
  const bracketText = answers.open && answers.closed
    ? answers.pricier
      ? `${answers.pricier === "open" ? "open" : "closed"} ×${fmtRatio(answers.ratio!)}`
      : "same cost"
    : null;
  // The band runs from the trailing side's best up to the leading side's: the scores only one side reaches
  // (not on to the top of the plot, which a high target can stretch past every score).
  const bandTop = zone ? Math.min(yMax, Math.max(zone.from, ...plotted[zone.side].map((p) => scoreOf(p.model, index)!))) : 0;
  const bandText = zone ? `${SIDE_NAME[zone.side]} only above ${fmtScore(zone.from)}${narrow ? "" : ` · ${zone.count} model${zone.count === 1 ? "" : "s"}`}` : null;
  const ruleText = `≥ ${fmtTarget(target)}`;

  // Where every piece of text goes. Each keeps clear of the text placed before it and of every plotted
  // mark, answer ring and the bracket: the two answers' names first (what the chart is read for), then
  // the rule's label, the "no … model" notes, the band label and the bracket's ratio, which always show,
  // then each side's top step and, on wide screens, every other frontier member.
  const layout = useMemo(() => {
    const noteFont = narrow ? 10 : 10.5;
    const labelFont = narrow ? 10 : 11;
    const area: Box = { x0: 0, y0: 0, x1: W, y1: M.top + PH };
    const taken: Box[] = [
      textBox(M.left, M.top - 6, `↑ AA ${INDEX_LABEL[index]}`.length, 11),
      ...yTicks.map((v) => textBox(M.left - 8, y(v) + 4, String(v).length, 11, "end")),
    ];
    for (const p of all) {
      const k = p.model.key;
      const px = x(p.cost);
      const py = y(scoreOf(p.model, index)!);
      // A little air around filled marks and rings, so no label sits snug against a point it doesn't name.
      // Hollow (dominated) points are soft: text covers one only when nothing else will do.
      taken.push(frontKeys.has(k) ? markBox(px, py, answerKeys.has(k) ? 9 : 5.5, k) : markBox(px, py, 3.5, k, true));
    }
    let bracket: { x0: number; x1: number } | null = null;
    if (answers.open && answers.closed) {
      const [xa, xb] = [x(answers.open.cost), x(answers.closed.cost)].sort((a, b) => a - b);
      bracket = { x0: xa, x1: xb };
      taken.push({ x0: xa, x1: xb, y0: Math.min(bracketY, bracketY + tickDir), y1: Math.max(bracketY, bracketY + tickDir) });
    }

    const seen = new Set<string>();
    const requests = (ps: readonly (Priced | null | undefined)[]): LabelRequest[] =>
      ps.flatMap((p) => {
        if (!p || seen.has(p.model.key)) return [];
        seen.add(p.model.key);
        return [{ key: p.model.key, x: x(p.cost), y: y(scoreOf(p.model, index)!), text: p.model.displayName, r: answerKeys.has(p.model.key) ? 8.5 : 5 }];
      });
    const answerLabels = placeLabels(requests([answers.open, answers.closed]), area, labelFont, taken);

    // Above the rule at its left end; below it when the axis title is in the way; then further along, or at its right end.
    const rule = placeText(
      [
        ...[0, 56, 112].flatMap((dx): TextSpot[] => [
          { x: M.left + 6 + dx, y: ruleY - 5, anchor: "start" },
          { x: M.left + 6 + dx, y: ruleY + 14, anchor: "start" },
        ]),
        { x: W - M.right - 6, y: ruleY - 5, anchor: "end" },
        { x: W - M.right - 6, y: ruleY + 14, anchor: "end" },
      ],
      ruleText.length,
      10.5,
      area,
      taken,
    );

    // At the rule's right end, stacked upwards, or downwards when there's no room above.
    const notes = missing.map((s) => {
      const text = `no ${SIDE_LABEL[s]} model ≥ ${fmtTarget(target)}`;
      const spots: TextSpot[] = [
        ...[0, 1, 2].map((i): TextSpot => ({ x: W - M.right - 6, y: ruleY - 5 - i * 13, anchor: "end" })),
        ...[0, 1, 2].map((i): TextSpot => ({ x: W - M.right - 6, y: ruleY + 14 + i * 13, anchor: "end" })),
      ];
      return { side: s, text, ...placeText(spots, text.length, noteFont, area, taken) };
    });

    // Inside the hatched band: along its top from the right, then just above its lower edge; else just over
    // the band, or failing all that in the top margin.
    const band = bandText && zone
      ? placeText(
          [
            ...[y(bandTop) + 13, Math.max(y(bandTop) + 13, y(zone.from) - 5), y(bandTop) - 5].flatMap((by): TextSpot[] => [
              { x: W - M.right - 6, y: by, anchor: "end" },
              { x: M.left + 6, y: by, anchor: "start" },
              ...[0.75, 0.5, 0.25].map((f): TextSpot => ({ x: M.left + f * PW, y: by, anchor: "middle" })),
            ]),
            { x: W - M.right - 6, y: M.top - 6, anchor: "end" },
          ],
          bandText.length,
          10.5,
          area,
          taken,
        )
      : null;

    // On the far side of the bracket from the rule: centred, then slid along it, then a line further out.
    let ratio: TextSpot | null = null;
    if (bracket && bracketText) {
      const { x0, x1 } = bracket;
      const along: Omit<TextSpot, "y">[] = [
        ...[0.5, 0.3, 0.7, 0.1, 0.9].map((f) => ({ x: x0 + f * (x1 - x0), anchor: "middle" as const })),
        { x: x0, anchor: "start" },
        { x: x1, anchor: "end" },
        { x: x0 - 4, anchor: "end" },
        { x: x1 + 4, anchor: "start" },
      ];
      const lines = tickDir < 0 ? [bracketY + 13, bracketY + 26, bracketY + 39] : [bracketY - 5, bracketY - 18, bracketY - 31];
      ratio = placeText(
        lines.flatMap((ly) => along.map((a) => ({ ...a, y: ly }))),
        bracketText.length,
        noteFont,
        area,
        taken,
      );
    }

    const steps = [...SIDES.map((s) => fronts[s].at(-1)), ...(narrow ? [] : SIDES.flatMap((s) => [...fronts[s]].reverse()))];
    const labels = new Map([...answerLabels, ...placeLabels(requests(steps), area, labelFont, taken)]);
    return { rule, notes, band, ratio, labels };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plotted, fronts, answers, index, narrow, target, zone]);
  const { labels } = layout;

  const setFromPointer = (clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const py = ((clientY - rect.top) / rect.height) * H;
    onTarget(yInv(Math.min(Math.max(py, M.top), M.top + PH)));
  };
  const startDrag = (e: ReactPointerEvent<SVGElement>) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setFromPointer(e.clientY);
  };

  const selected = shown ? (all.find((p) => p.model.key === shown) ?? null) : null;
  const enter = (key: string) => () => onPreview(key);
  const leave = () => onPreview(null);

  const ariaPoint = (p: Priced) =>
    `${p.model.displayName}, ${SIDE_LABEL[sideOf(p.model)!]}, AA ${fmtScore(scoreOf(p.model, index)!)}, ${fmtUsd(p.per1k)} per 1,000 requests`;

  return (
    <div className="chart-frame">
      <svg
        ref={svgRef}
        className={`frontier-chart oc-chart${narrow ? " narrow" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        onPointerMove={(e) => dragging.current && setFromPointer(e.clientY)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
      >
        <defs>
          <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="oc-hatch-line" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>

        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={M.left - 8} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        {/* Scores only one side reaches: hatched from the trailing side's best to the leading side's. */}
        {zone && zone.from < yMax && (
          <g className="oc-band">
            <rect x={M.left} y={y(bandTop)} width={PW} height={Math.max(0, y(zone.from) - y(bandTop))} fill={`url(#${hatchId})`} />
            <line className="oc-band-edge" x1={M.left} x2={W - M.right} y1={y(zone.from)} y2={y(zone.from)} />
          </g>
        )}

        {/* x axis as a meter rule */}
        <line className="axis" x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH} />
        {xTicks.map((t) => (
          <g key={`x${t.value}`}>
            <line className="axis" x1={x(t.value)} x2={x(t.value)} y1={M.top + PH} y2={M.top + PH + (t.major ? 8 : 4)} />
            {t.major && <line className="grid" x1={x(t.value)} x2={x(t.value)} y1={M.top} y2={M.top + PH} />}
            {(t.major || (!narrow && xTicks.length < 8)) && (
              <text
                className="axis-label"
                x={Math.min(x(t.value), W - 2 - (fmtCostTick(t.value).length * 6.6) / 2)}
                y={M.top + PH + 22}
                textAnchor="middle"
              >
                {fmtCostTick(t.value)}
              </text>
            )}
          </g>
        ))}
        <text className="axis-title" x={W - M.right} y={H - 4} textAnchor="end">
          {narrow ? "$ / 1K requests, log" : "$ per 1,000 requests at your workload, log scale"}
        </text>
        <text className="axis-title" x={M.left} y={M.top - 6}>
          ↑ AA {INDEX_LABEL[index]}
        </text>

        {/* The target rule: drag it, or focus it and use the arrow keys. Its label is drawn with the other text, on top. */}
        <g
          ref={ruleRef}
          className="min-rule"
          role="slider"
          tabIndex={0}
          aria-label={`Target AA ${INDEX_LABEL[index]} score`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={target}
          aria-valuetext={`${target.toFixed(1)} or above`}
          aria-orientation="vertical"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowRight") onStep(0.5);
            else if (e.key === "ArrowDown" || e.key === "ArrowLeft") onStep(-0.5);
            else if (e.key === "PageUp") onStep(5);
            else if (e.key === "PageDown") onStep(-5);
            else if (e.key === "Home") onTarget(0);
            else if (e.key === "End") onTarget(100);
            else return;
            e.preventDefault();
          }}
          onPointerDown={startDrag}
        >
          {/* A 44px hit area on touch screens, 16px otherwise. */}
          <rect x={M.left} width={PW} y={ruleY - (narrow ? 22 : 8)} height={narrow ? 44 : 16} fill="transparent" />
          <line x1={M.left} x2={W - M.right} y1={ruleY} y2={ruleY} />
        </g>

        {SIDES.map((s) => fronts[s].length > 0 && <path key={s} className={`oc-front-line ${s}`} d={stepPath(fronts[s])} />)}

        {answers.open && answers.closed && (
          <g className="oc-bracket" aria-hidden="true">
            <path
              d={`M${x(answers.open.cost)},${bracketY + tickDir} V${bracketY} H${x(answers.closed.cost)} V${bracketY + tickDir}`}
            />
          </g>
        )}

        {/* Dominated points: hover or tap; the parity table below carries the same data. */}
        {all
          .filter((p) => !frontKeys.has(p.model.key))
          .map((p) => {
            const px = x(p.cost);
            const py = y(scoreOf(p.model, index)!);
            const cls = `oc-pt-dom${shown === p.model.key ? " focused" : ""}`;
            const common = {
              className: cls,
              onPointerEnter: enter(p.model.key),
              onPointerLeave: leave,
              onClick: () => onPin(p.model.key),
            };
            return sideOf(p.model) === "open" ? (
              <circle key={p.model.key} cx={px} cy={py} r={2.5} {...common}>
                <title>{p.model.displayName}</title>
              </circle>
            ) : (
              <rect key={p.model.key} x={px - 2.5} y={py - 2.5} width={5} height={5} {...common}>
                <title>{p.model.displayName}</title>
              </rect>
            );
          })}

        {SIDES.flatMap((s) =>
          fronts[s].map((p) => {
            const px = x(p.cost);
            const py = y(scoreOf(p.model, index)!);
            const key = p.model.key;
            const isAnswer = answerKeys.has(key);
            const isCheaper = cheaper?.model.key === key;
            return (
              <g
                key={key}
                className={`oc-pt${shown === key ? " focused" : ""}${isCheaper ? " cheaper" : ""}`}
                tabIndex={0}
                role="button"
                aria-pressed={pinned === key}
                aria-label={`${ariaPoint(p)}${isAnswer ? `, cheapest ${SIDE_LABEL[s]} at ${fmtTarget(target)} or above` : ""}${isCheaper ? ", the cheaper answer" : ""}`}
                onFocus={enter(key)}
                onBlur={leave}
                onPointerEnter={enter(key)}
                onPointerLeave={leave}
                onClick={() => onPin(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPin(key);
                  }
                }}
              >
                {s === "open" ? (
                  <>
                    {isAnswer && <circle className="oc-ring" cx={px} cy={py} r={7.5} />}
                    <circle className="oc-mark" cx={px} cy={py} r={4} />
                  </>
                ) : (
                  <>
                    {isAnswer && <rect className="oc-ring" x={px - 6.5} y={py - 6.5} width={13} height={13} />}
                    <rect className="oc-mark" x={px - 3.5} y={py - 3.5} width={7} height={7} />
                  </>
                )}
              </g>
            );
          }),
        )}

        {/* All text last, so its halo masks the lines and marks beneath it rather than the other way round. */}
        <g className="oc-text">
          <text ref={ruleLabelRef} className="oc-rule-label" x={layout.rule.x} y={layout.rule.y} onPointerDown={startDrag} aria-hidden="true">
            {ruleText}
          </text>
          {layout.notes.map((n) => (
            <text key={n.side} className="oc-missing" x={n.x} y={n.y} textAnchor={n.anchor}>
              {n.text}
            </text>
          ))}
          {layout.band && zone && zone.from < yMax && (
            <text className="oc-band-label" x={layout.band.x} y={layout.band.y} textAnchor={layout.band.anchor}>
              {bandText}
            </text>
          )}
          {layout.ratio && (
            <text className="oc-bracket-text" x={layout.ratio.x} y={layout.ratio.y} textAnchor={layout.ratio.anchor} aria-hidden="true">
              {bracketText}
            </text>
          )}
          {SIDES.flatMap((s) =>
            fronts[s].map((p) => {
              const lab = labels.get(p.model.key);
              return (
                lab && (
                  <text
                    key={p.model.key}
                    className="oc-label"
                    x={lab.x}
                    y={lab.y}
                    textAnchor={lab.anchor}
                    aria-hidden="true"
                    onPointerEnter={enter(p.model.key)}
                    onPointerLeave={leave}
                    onClick={() => onPin(p.model.key)}
                  >
                    {p.model.displayName}
                  </text>
                )
              );
            }),
          )}
          {selected && !labels.has(selected.model.key) && (
            <text
              className="focus-label"
              x={x(selected.cost) + (x(selected.cost) > W - 160 ? -8 : 8)}
              y={y(scoreOf(selected.model, index)!) - 6}
              textAnchor={x(selected.cost) > W - 160 ? "end" : "start"}
            >
              {selected.model.displayName}
            </text>
          )}
        </g>
      </svg>
    </div>
  );
}

/** The chart's legend, in HTML so it wraps; the swatches are the chart's own marks. */
export function PriceScoreLegend({ empty }: { empty: Record<Side, boolean> }) {
  const none = (s: Side) => (empty[s] ? " (none pass these filters)" : "");
  return (
    <ul className="oc-legend" aria-label="Legend">
      <li>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect className="oc-sw-fill" x="2.5" y="2.5" width="7" height="7" />
        </svg>
        closed{none("closed")}
      </li>
      <li>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <circle className="oc-sw-fill" cx="6" cy="6" r="4" />
        </svg>
        open-weight{none("open")}
      </li>
      <li>
        <svg viewBox="0 0 24 12" aria-hidden="true">
          <rect className="oc-sw-fill" x="1.5" y="2.5" width="7" height="7" />
          <circle className="oc-sw-hollow" cx="18" cy="6" r="2.5" />
        </svg>
        filled = on its side's frontier; hollow = a cheaper model on its side scores as high
      </li>
      <li>
        <svg viewBox="0 0 24 12" aria-hidden="true">
          <line className="oc-sw-line" x1="1" x2="23" y1="6" y2="6" />
        </svg>
        closed frontier
      </li>
      <li>
        <svg viewBox="0 0 24 12" aria-hidden="true">
          <line className="oc-sw-line open" x1="1" x2="23" y1="6" y2="6" />
        </svg>
        open-weight frontier
      </li>
      <li>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <circle className="oc-sw-ring" cx="7" cy="7" r="6" />
          <circle className="oc-sw-cheaper" cx="7" cy="7" r="3.5" />
        </svg>
        ringed = each side's cheapest at your target; pine = the cheaper of the two
      </li>
      <li>
        <span className="oc-sw-hatchbox" aria-hidden="true" />
        hatched = scores only one side reaches
      </li>
    </ul>
  );
}

const KICKER = { pinned: "Pinned — Escape to clear", preview: "Preview", answer: "Cheaper answer at your target" };

/** Hover previews, click pins: the class line, score with its rank on its side, cost, and where to go next. */
export const PointReadout = forwardRef<
  HTMLElement,
  {
    point: Priced | null;
    state: keyof typeof KICKER;
    points: readonly Priced[];
    index: Index;
    costHref: (key: string) => string;
  }
>(function PointReadout({ point, state, points, index, costHref }, ref) {
  if (!point)
    return (
      <aside className="point-readout empty" ref={ref} tabIndex={-1} aria-live="polite">
        Hover, focus or tap a point.
      </aside>
    );
  const m = point.model;
  const s = scoreOf(m, index);
  const rank = sideRank(points, m, index);
  const inputs = inputModalities(m);
  const open = sideOf(m) === "open";
  return (
    <aside className="point-readout" aria-label={`${m.displayName}, ${KICKER[state].toLowerCase()}`} aria-live="polite" ref={ref} tabIndex={-1}>
      <div className="readout-kicker">{KICKER[state]}</div>
      <div className="bn">{m.displayName}</div>
      <div className="bv">
        {m.vendorName} <SourceTag model={m} mode={point.breakdown.mode} />
      </div>
      <p className="oc-class-line">{classLine(m)}</p>
      <dl className="spec">
        <dt>AA {INDEX_LABEL[index]}</dt>
        <dd>
          {s === null ? "—" : fmtScore(s)}
          {rank && (
            <span className="oc-rank">
              #{rank.rank} of {rank.of} {open ? "open-weight" : "closed"}
            </span>
          )}
        </dd>
        <dt>$ / 1K req</dt>
        <dd>
          {fmtUsd(point.per1k)}
          <FallbackMark breakdown={point.breakdown} />
        </dd>
        <dt>$ / mo</dt>
        <dd>{fmtMoney(point.breakdown.monthlyCost)}</dd>
        <dt>Context</dt>
        <dd>{fmtCompact(m.contextTokens)}</dd>
        <dt>Tools</dt>
        <dd>{m.capabilities.tools ? "yes" : "no"}</dd>
        <dt>Reasoning</dt>
        <dd>{m.reasoningMandatory ? "always on" : m.capabilities.reasoning ? "yes" : "no"}</dd>
        <dt>Image in</dt>
        <dd>{inputs.includes("image") ? "yes" : "no"}</dd>
      </dl>
      <ul className="oc-readout-links">
        <li>
          <Link className="text-btn" state={INTERNAL} to={`/models/${m.key}`}>
            Model page
            <Mark kind="to" />
          </Link>
        </li>
        {open && (
          <li>
            <Link className="text-btn" state={INTERNAL} to={`/tools/vram?m=${encodeKey(m.key)}`} onClick={() => trackEvent("Open vs Closed", "To VRAM", m.key)}>
              Estimate VRAM
              <Mark kind="to" />
            </Link>
          </li>
        )}
        <li>
          <Link className="text-btn" state={INTERNAL} to={costHref(m.key)} onClick={() => trackEvent("Open vs Closed", "To bench")}>
            Add to Cost bench
            <Mark kind="to" />
          </Link>
        </li>
      </ul>
    </aside>
  );
});
