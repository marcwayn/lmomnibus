import { memo, useCallback, useMemo, useState } from "react";
import { INDEX_LABEL, scoreOf, type Index } from "../../core/frontier.ts";
import type { Model } from "../../core/model.ts";
import { SIDE_LABEL, sideOf, type Lag, type ScoreRecord, type Side } from "../../core/openclosed.ts";
import { fmtScore, markBox, placeLabels, placeText, textBox, useEscape, type Box, type LabelRequest, type TextSpot } from "./shared.tsx";

/**
 * Chart B: each side's running best by OpenRouter listing date, as step
 * lines (closed solid, open dashed) extended flat to the snapshot, with the
 * listing lag behind the best open-weight score and the gap at the snapshot.
 * Today's scores placed at listing dates: never a history of the race.
 */
const WIDE = { W: 880, H: 340, M: { top: 24, right: 78, bottom: 40, left: 40 } };
const NARROW = { W: 360, H: 280, M: { top: 24, right: 46, bottom: 34, left: 30 } };
const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface RunningBestChartProps {
  models: readonly Model[];
  index: Index;
  span: "2y" | "all";
  all: boolean;
  snapshot: string;
  records: Record<Side, ScoreRecord[]>;
  /** The lag bracket: at the trailing side's best score, from whoever listed a model reaching it first to the other side. */
  lag: HeadlineLag | null;
  narrow: boolean;
  labelledBy: string;
  describedBy: string;
}

const SIDES: Side[] = ["closed", "open"];

export const RunningBestChart = memo(function RunningBestChart({ models, index, span, all, snapshot, records, lag, narrow, labelledBy, describedBy }: RunningBestChartProps) {
  const { W, H, M } = narrow ? NARROW : WIDE;
  const PW = W - M.left - M.right;
  const PH = H - M.top - M.bottom;
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Escape clears a pin wherever focus is: clicking a label pins its point without focusing it.
  const unpin = useCallback(() => setPinned(null), []);
  useEscape(pinned !== null, unpin);

  const rated = useMemo(
    () => models.filter((m) => sideOf(m) && m.listedOn && scoreOf(m, index) !== null),
    [models, index],
  );
  const t1 = Date.parse(snapshot);
  const firstListed = rated.reduce((a, m) => (m.listedOn! < a ? m.listedOn! : a), snapshot);
  const t0 = span === "2y" ? t1 - 730 * DAY : Math.min(Date.parse(firstListed), t1 - 30 * DAY);
  const recScores = [...records.open, ...records.closed].map((r) => r.score);
  const allScores = all ? rated.map((m) => scoreOf(m, index)!) : [];
  const yMax = Math.min(100, Math.ceil((Math.max(10, ...recScores, ...allScores) + 2) / 5) * 5);

  const xt = (t: number) => M.left + ((Math.max(t, t0) - t0) / (t1 - t0)) * PW;
  const x = (iso: string) => xt(Date.parse(iso));
  const y = (s: number) => M.top + (1 - s / yMax) * PH;
  const inside = (iso: string) => Date.parse(iso) >= t0;

  // Step after each record; a record from before the window starts the line at its left edge.
  const runPath = (recs: ScoreRecord[]) => {
    let d = "";
    let started = false;
    const before = recs.filter((r) => !inside(r.listedOn)).at(-1);
    if (before) {
      d = `M${M.left},${y(before.score)}`;
      started = true;
    }
    for (const r of recs.filter((rec) => inside(rec.listedOn))) {
      d += started ? ` H${x(r.listedOn)} V${y(r.score)}` : `M${x(r.listedOn)},${y(r.score)}`;
      started = true;
    }
    return started ? `${d} H${xt(t1)}` : "";
  };

  // Year ticks are major; quarter ticks minor (wide only).
  const ticks: { t: number; label: string; major: boolean }[] = [];
  const start = new Date(t0);
  for (let yr = start.getUTCFullYear(); yr <= new Date(t1).getUTCFullYear(); yr++) {
    for (const mo of [0, 3, 6, 9]) {
      const t = Date.UTC(yr, mo, 1);
      if (t <= t0 || t > t1) continue;
      if (mo === 0) ticks.push({ t, label: String(yr), major: true });
      else if (!narrow) ticks.push({ t, label: MONTHS[mo], major: false });
    }
  }

  const yTicks: { v: number; major: boolean }[] = [];
  for (let v = 0; v <= yMax; v += 5) yTicks.push({ v, major: v % 10 === 0 });

  const best: Record<Side, ScoreRecord | null> = { open: records.open.at(-1) ?? null, closed: records.closed.at(-1) ?? null };

  // Where the text goes, clear of every record point (and, with "every rated model", every hollow point):
  // the lag label first, beside its bracket, then each side's current best, then older records.
  const layout = useMemo(() => {
    const area: Box = { x0: 0, y0: 0, x1: xt(t1), y1: M.top + PH };
    const taken: Box[] = [
      ...yTicks.filter((t) => t.major).map((t) => textBox(M.left - 9, y(t.v) + 4, String(t.v).length, 11, "end")),
      textBox(M.left - (narrow ? 26 : 0), M.top - 10, (`↑ AA ${INDEX_LABEL[index]}` + (narrow ? "" : ", best so far")).length, 11),
      textBox(xt(t1), M.top - 10, (narrow ? snapshot : `snapshot ${snapshot}`).length, 11, "end"),
    ];
    for (const s of SIDES) for (const r of records[s]) if (inside(r.listedOn)) taken.push(markBox(x(r.listedOn), y(r.score), 6, r.model.key));
    // "Every rated model"'s hollow points are soft: text covers one only when nothing else will do.
    if (all) for (const m of rated) if (inside(m.listedOn!)) taken.push(markBox(x(m.listedOn!), y(scoreOf(m, index)!), 3.5, m.key, true));

    // Below the bracket, centred, then slid along it; then level with it, off either end; then above it.
    let lagSpot: TextSpot | null = null;
    if (lag && inside(lag.to.listedOn)) {
      const [x0, x1] = [x(lag.from.listedOn), x(lag.to.listedOn)].sort((a, b) => a - b);
      const ly = y(lag.score);
      taken.push({ x0, x1, y0: ly - 5, y1: ly + 5 });
      const along: Omit<TextSpot, "y">[] = [
        ...[0.5, 0.3, 0.7, 0.1, 0.9].map((f) => ({ x: x0 + f * (x1 - x0), anchor: "middle" as const })),
        { x: x0, anchor: "start" },
        { x: x1, anchor: "end" },
      ];
      lagSpot = placeText(
        [
          ...along.map((a) => ({ ...a, y: ly + 17 })),
          { x: x0 - 6, y: ly + 4, anchor: "end" },
          { x: x1 + 6, y: ly + 4, anchor: "start" },
          ...[ly - 9, ly + 30].flatMap((yy) => along.map((a) => ({ ...a, y: yy }))),
        ],
        lagText(lag).length,
        10.5,
        area,
        taken,
      );
    }

    const reqs: LabelRequest[] = [];
    for (const s of SIDES) {
      const recs = records[s].filter((r) => inside(r.listedOn));
      const pick = narrow ? recs.slice(-1) : recs.slice(-4).reverse();
      for (const r of pick) reqs.push({ key: r.model.key, x: x(r.listedOn), y: y(r.score), text: r.model.displayName });
    }
    // Each side's current best is placed before older records.
    const isBest = (k: string) => Number(k === best.open?.model.key || k === best.closed?.model.key);
    reqs.sort((a, b) => isBest(b.key) - isBest(a.key));
    return { lag: lagSpot, labels: placeLabels(reqs, area, narrow ? 10 : 11, taken) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, rated, all, lag, narrow, t0, yMax, index, snapshot]);
  const { labels } = layout;

  const shownKey = pinned ?? hover;
  const shown = shownKey ? [...records.open, ...records.closed].find((r) => r.model.key === shownKey) : null;
  const gap = best.open && best.closed ? Math.round((best.closed.score - best.open.score) * 10) / 10 : null;

  return (
    <div className="chart-frame">
      <svg
        className={`frontier-chart oc-chart oc-run${narrow ? " narrow" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {yTicks.map((t) => (
          <g key={t.v}>
            {t.major && <line className="grid" x1={M.left} x2={xt(t1)} y1={y(t.v)} y2={y(t.v)} />}
            <line className="axis" x1={M.left - (t.major ? 6 : 3)} x2={M.left} y1={y(t.v)} y2={y(t.v)} />
            {t.major && (
              <text className="axis-label" x={M.left - 9} y={y(t.v) + 4} textAnchor="end">
                {t.v}
              </text>
            )}
          </g>
        ))}
        <text className="axis-title" x={M.left - (narrow ? 26 : 0)} y={M.top - 10}>
          ↑ AA {INDEX_LABEL[index]}{narrow ? "" : ", best so far"}
        </text>

        <line className="axis" x1={M.left} x2={xt(t1)} y1={M.top + PH} y2={M.top + PH} />
        {ticks.map((t) => (
          <g key={t.t}>
            <line className="axis" x1={xt(t.t)} x2={xt(t.t)} y1={M.top + PH} y2={M.top + PH + (t.major ? 8 : 4)} />
            {t.major && <line className="grid" x1={xt(t.t)} x2={xt(t.t)} y1={M.top} y2={M.top + PH} />}
            {xt(t1) - xt(t.t) > (t.major ? 18 : 24) && (
              <text className={`axis-label${t.major ? "" : " oc-minor"}`} x={xt(t.t)} y={M.top + PH + 21} textAnchor="middle">
                {t.label}
              </text>
            )}
          </g>
        ))}
        <line className="axis" x1={xt(t1)} x2={xt(t1)} y1={M.top + PH} y2={M.top + PH + 8} />
        <text className="axis-title" x={xt(t1)} y={M.top - 10} textAnchor="end">
          {narrow ? snapshot : `snapshot ${snapshot}`}
        </text>
        <line className="oc-snapshot" x1={xt(t1)} x2={xt(t1)} y1={M.top} y2={M.top + PH} />

        {all &&
          rated
            .filter((m) => inside(m.listedOn!))
            .map((m) => {
              const px = x(m.listedOn!);
              const py = y(scoreOf(m, index)!);
              return sideOf(m) === "open" ? (
                <circle key={m.key} className="oc-pt-dom" cx={px} cy={py} r={2.5}>
                  <title>{`${m.displayName} · ${fmtScore(scoreOf(m, index)!)} · listed ${m.listedOn}`}</title>
                </circle>
              ) : (
                <rect key={m.key} className="oc-pt-dom" x={px - 2.5} y={py - 2.5} width={5} height={5}>
                  <title>{`${m.displayName} · ${fmtScore(scoreOf(m, index)!)} · listed ${m.listedOn}`}</title>
                </rect>
              );
            })}

        {SIDES.map((s) => {
          const d = runPath(records[s]);
          return d && <path key={s} className={`oc-front-line ${s}`} d={d} />;
        })}

        {/* How long one side had held a score before the other listed a model reaching it. */}
        {lag && inside(lag.to.listedOn) && (
          <g className="oc-lag" aria-hidden="true">
            <path
              d={`M${x(lag.from.listedOn)},${y(lag.score) - 5} V${y(lag.score) + 5} M${x(lag.from.listedOn)},${y(lag.score)} H${x(lag.to.listedOn)} M${x(lag.to.listedOn)},${y(lag.score) - 5} V${y(lag.score) + 5}`}
            />
          </g>
        )}

        {/* The gap at the snapshot. */}
        {best.open && best.closed && gap !== null && gap !== 0 && (
          <g className="oc-bracket" aria-hidden="true">
            <path
              d={`M${xt(t1) + 4},${y(best.closed.score)} H${xt(t1) + 9} V${y(best.open.score)} H${xt(t1) + 4}`}
            />
            <text x={xt(t1) + 13} y={(y(best.closed.score) + y(best.open.score)) / 2 + 4}>
              {narrow ? fmtScore(Math.abs(gap)) : gap > 0 ? `gap ${fmtScore(gap)}` : `open +${fmtScore(-gap)}`}
            </text>
          </g>
        )}

        {SIDES.flatMap((s) =>
          records[s]
            .filter((r) => inside(r.listedOn))
            .map((r) => {
              const px = x(r.listedOn);
              const py = y(r.score);
              const key = r.model.key;
              return (
                <g
                  key={key}
                  className={`oc-pt${shownKey === key ? " focused" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-pressed={pinned === key}
                  aria-label={`${r.model.displayName}, ${SIDE_LABEL[s]} record, AA ${fmtScore(r.score)}, listed ${r.listedOn}`}
                  onFocus={() => setHover(key)}
                  onBlur={() => setHover(null)}
                  onPointerEnter={() => setHover(key)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => setPinned((p) => (p === key ? null : key))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPinned((p) => (p === key ? null : key));
                    }
                  }}
                >
                  {s === "open" ? (
                    <circle className="oc-mark" cx={px} cy={py} r={3.5} />
                  ) : (
                    <rect className="oc-mark" x={px - 3.5} y={py - 3.5} width={7} height={7} />
                  )}
                </g>
              );
            }),
        )}

        {/* All text last, so its halo masks the lines and marks beneath it rather than the other way round. */}
        {layout.lag && lag && (
          <text className="oc-lag-text" x={layout.lag.x} y={layout.lag.y} textAnchor={layout.lag.anchor} aria-hidden="true">
            {lagText(lag)}
          </text>
        )}
        {SIDES.flatMap((s) =>
          records[s].map((r) => {
            const lab = labels.get(r.model.key);
            const key = r.model.key;
            return (
              lab && (
                <text
                  key={key}
                  className="oc-label"
                  x={lab.x}
                  y={lab.y}
                  textAnchor={lab.anchor}
                  aria-hidden="true"
                  onPointerEnter={() => setHover(key)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => setPinned((p) => (p === key ? null : key))}
                >
                  {r.model.displayName}
                </text>
              )
            );
          }),
        )}
        {shown && (
          <text
            className="focus-label oc-focus-label"
            x={x(shown.listedOn) + (x(shown.listedOn) > W - 220 ? -8 : 8)}
            y={y(shown.score) + 18}
            textAnchor={x(shown.listedOn) > W - 220 ? "end" : "start"}
          >
            {shown.model.displayName} · {fmtScore(shown.score)} · listed {shown.listedOn}
          </text>
        )}
      </svg>
    </div>
  );
});

const lagText = (l: HeadlineLag) => (l.openFirst ? `open first by ${l.days} days` : `${l.days} days`);

export interface HeadlineLag {
  /** The trailing side's best score. */
  score: number;
  /** The record that reached it first, and the other side's record that followed. */
  from: ScoreRecord;
  to: ScoreRecord;
  days: number;
  openFirst: boolean;
}

/**
 * The listing lag behind the trailing side's best score (for Chart B's
 * bracket and the R4 reading): who listed a model reaching it first, and how
 * many days before the other side did.
 */
export function headlineLag(records: Record<Side, ScoreRecord[]>, lagOf: (rec: ScoreRecord, against: readonly ScoreRecord[]) => Lag): HeadlineLag | null {
  const bo = records.open.at(-1);
  const bc = records.closed.at(-1);
  if (!bo || !bc) return null;
  // The trailing side's best, and the leading side's first record at or above it.
  const [trail, lead] = bc.score >= bo.score ? [bo, records.closed] : [bc, records.open];
  const l = lagOf(trail, lead);
  if (!l.closedFirst || l.days === null) return null;
  const leaderFirst = l.days >= 0;
  const [from, to] = leaderFirst ? [l.closedFirst, trail] : [trail, l.closedFirst];
  return { score: trail.score, from, to, days: Math.abs(l.days), openFirst: from.side === "open" };
}
