import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { CopyButton, FallbackMark, Mark, Meter, SourceTag, WorkloadPanel, workloadLine } from "../components.tsx";
import { allModels, CATALOG_META } from "../core/catalog.ts";
import type { Rate, Workload } from "../core/cost.ts";
import { todayIso } from "../core/date.ts";
import { fmtCompact, fmtMoney, fmtUsd } from "../core/fmt.ts";
import {
  cheapestAbove,
  dominatedBy,
  FILTER_LABEL,
  frontier,
  INDEX_LABEL,
  ladder,
  logTicks,
  passesFilters,
  percentileScore,
  priceAll,
  scoreOf,
  type Filter,
  type Index,
  type Priced,
} from "../core/frontier.ts";
import { inputModalities, type Model } from "../core/model.ts";
import { DEFAULT_PRESET, matchingPreset, presetById, type PresetId } from "../core/presets.ts";
import { decodeFrontier, encodeFrontier, encodeScenario, hasScenario, MAX_BENCH } from "../core/share.ts";
import { NumberField } from "../NumberField.tsx";
import { titleFor } from "../routes.ts";

const MODELS = allModels();
/** "Fits my request" is always applied here: a model that can't take the request isn't an answer. */
const SHOWN_FILTERS: Filter[] = ["img", "aud", "tools", "reasoning"];
/** The bar a first visit starts from: the 75th-percentile score on this index, rounded down. */
const defaultMinFor = (index: Index) => Math.floor(percentileScore(MODELS, index, 75) ?? 0);
const clampScore = (v: number) => Math.round(Math.min(Math.max(v, 0), 100));
/** Links into the Cost Calculator from here are internal, not shared-link arrivals. */
const INTERNAL = { internal: true };

function costUrl(models: string[], workload: Workload, rate: Rate, preset: PresetId | null, index: Index) {
  return `/tools/cost?${encodeScenario({ models, workload, rate, preset, modes: new Map(), index })}`;
}

export function FrontierTool() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [init] = useState(() => decodeFrontier(params));
  const today = todayIso();

  const [workload, setWorkload] = useState<Workload>(init.workload);
  const [rate, setRate] = useState<Rate>(init.rate);
  const [preset, setPreset] = useState<PresetId | null>(
    () => init.preset ?? matchingPreset(init.workload, init.rate)?.id ?? DEFAULT_PRESET.id,
  );
  const [index, setIndex] = useState<Index>(init.index);
  const [filters, setFilters] = useState<Set<Filter>>(init.filters);
  // null = untouched: the bar then follows the current index's default, so
  // what you see and what a link without min= reproduces always agree.
  const [minSet, setMinSet] = useState<number | null>(init.minScore);
  const minScore = minSet ?? defaultMinFor(index);
  const indexRef = useRef(index);
  indexRef.current = index;
  // Hover and keyboard focus preview a point; click or Enter pins it. The
  // readout shows the pin over any preview, so moving the pointer to its
  // "+ Bench" link can never pick up a different model on the way.
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const readoutRef = useRef<HTMLElement>(null);
  const minTracked = useRef(false);

  const encoded = encodeFrontier({ preset, workload, rate, index, minScore: minSet, filters });
  const hasState = hasScenario(params) || ["y", "min", "f"].some((k) => params.has(k));
  const synced = useRef(hasState ? "" : encoded);
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      // Navigate with the raw string: URLSearchParams would percent-encode ":" and ",".
      navigate({ pathname, search: encoded ? `?${encoded}` : "" }, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, navigate, pathname]);

  const priced = useMemo(() => priceAll(MODELS, workload, rate, today), [workload, rate, today]);
  const pool = useMemo(() => {
    const f = new Set<Filter>([...filters, "fits"]);
    return priced.filter((p) => passesFilters(p.model, f, workload, index));
  }, [priced, filters, workload, index]);
  const scored = useMemo(() => pool.filter((p) => scoreOf(p.model, index) !== null && p.cost > 0), [pool, index]);
  const front = useMemo(() => frontier(scored, index), [scored, index]);
  const steps = useMemo(() => ladder(front, index), [front, index]);
  const answer = cheapestAbove(scored, index, minScore);

  // Membership change vs the Chat preset, shown only when it differs.
  const vsChat = useMemo(() => {
    const chat = presetById("chat")!;
    if (preset === "chat") return null;
    const chatPool = priceAll(MODELS, chat.workload, chat.rate, today).filter((p) =>
      passesFilters(p.model, new Set<Filter>([...filters, "fits"]), chat.workload, index),
    );
    const chatKeys = new Set(frontier(chatPool, index).map((p) => p.model.key));
    const here = new Set(front.map((p) => p.model.key));
    const joined = [...here].filter((k) => !chatKeys.has(k)).length; // models now on the frontier
    const left = [...chatKeys].filter((k) => !here.has(k)).length;
    return joined || left ? { joined, left } : null;
  }, [preset, filters, index, front, today]);

  const label = INDEX_LABEL[index];
  const toggleFilter = (f: Filter) => {
    trackEvent("Table", "Filter", f);
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const trackMin = () => {
    if (minTracked.current) return;
    minTracked.current = true;
    trackEvent("Frontier", "Min score set");
  };
  const setMin = (v: number) => {
    trackMin();
    setMinSet(clampScore(v));
  };
  // Functional update from the latest value, so fast key-repeat never drops a step.
  const stepMin = (delta: number) => {
    trackMin();
    setMinSet((prev) => clampScore((prev ?? defaultMinFor(indexRef.current)) + delta));
  };

  const shareUrl = () => `${window.location.origin}/tools/frontier?${encoded}`;
  const ladderMarkdown = () =>
    [
      `| Model | AA ${label} | $/1K req | step | price source |`,
      "|---|---:|---:|---|---|",
      ...steps.map(
        (s) =>
          `| ${s.point.model.displayName}${s.point.breakdown.notes.includes("batch-unavailable") ? " (no batch rate)" : ""} | ${scoreOf(s.point.model, index)!.toFixed(1)} | ${fmtUsd(s.point.per1k)} | ${
            s.costMultiple === null ? "cheapest" : `×${s.costMultiple.toFixed(1)} for +${s.scoreGain!.toFixed(1)}`
          } | ${s.point.model.provenance === "FirstParty" ? "vendor list" : "via OpenRouter"} |`,
      ),
      "",
      `Workload: ${workloadLine(workload, rate, true)}`,
      `Prices as of ${CATALOG_META.asOf} · AA ${label} via OpenRouter · list-price cost, not cost per task · LMOmnibus`,
      shareUrl(),
    ].join("\n");

  const shown = pinned ?? hovered;
  const selectedPoint = shown ? (scored.find((p) => p.model.key === shown) ?? null) : null;
  const togglePin = (key: string) => setPinned((p) => (p === key ? null : key));

  // Announce the answer once input settles, not on every keystroke or drag.
  const answerText = answer
    ? `Cheapest at or above ${minScore}: ${answer.model.displayName}, ${fmtUsd(answer.per1k)} per 1,000 requests`
    : `No model scores at least ${minScore} and fits this workload`;
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAnnounced(answerText), 700);
    return () => clearTimeout(t);
  }, [answerText]);
  const filterText = [...filters].map((f) => FILTER_LABEL[f].toLowerCase()).join(", ");

  return (
    <>
      <title>{titleFor("/tools/frontier")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 02</span>
        <h1>Price–Capability Frontier</h1>
        <p className="sub">
          Every scored model, priced at your workload. The stepped line is the frontier: nothing cheaper scores
          higher. Set a bar and read off the cheapest model that clears it.
        </p>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announced}
      </p>
      <p className="readout">
        {answer ? (
          <>
            Cheapest model scoring at least <span className="mono">{minScore}</span> on AA {label}
            {filterText ? ` with ${filterText}` : ""}, fitting{" "}
            <span className="mono">
              {fmtCompact(workload.inputTokens)} + {fmtCompact(workload.outputTokens)}
            </span>{" "}
            tokens: <strong>{answer.model.displayName}</strong> ·{" "}
            <span className="mono">{fmtUsd(answer.per1k)}</span> per 1K requests (
            <span className="mono">{fmtMoney(answer.breakdown.monthlyCost)}</span>/mo at{" "}
            <span className="mono">{fmtCompact(workload.requestsPerMonth)}</span> req){" "}
            <SourceTag model={answer.model} /> <FallbackMark breakdown={answer.breakdown} />
          </>
        ) : (
          <>
            No model scoring at least <span className="mono">{minScore}</span> on AA {label} fits this workload
            {filterText ? ` with ${filterText}` : ""}.
          </>
        )}
      </p>

      <section className="section" aria-labelledby="fw-h">
        <div className="section-title">
          <h2 id="fw-h">Workload</h2>
        </div>
        <WorkloadPanel
          workload={workload}
          rate={rate}
          onChange={(w, r, p) => {
            setWorkload(w);
            setRate(r);
            // A custom workload keeps its last preset as the URL's base (p=chat&r=50000).
            setPreset((prev) => p ?? prev);
          }}
        />
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="chart-h">
        <div className="section-title">
          <h2 id="chart-h">Frontier</h2>
          <span className="count">
            {front.length} on the frontier · {scored.length} plotted
          </span>
        </div>

        <div className="frontier-controls">
          <div className="seg" role="group" aria-label="Capability index">
            {(Object.keys(INDEX_LABEL) as Index[]).map((i) => (
              <button
                key={i}
                type="button"
                aria-pressed={index === i}
                className={index === i ? "on" : ""}
                onClick={() => {
                  trackEvent("Frontier", "Index switch", i);
                  setIndex(i);
                  setPinned(null);
                  setHovered(null);
                }}
              >
                {INDEX_LABEL[i]}
              </button>
            ))}
          </div>
          <div className="min-field">
            <NumberField label={`Minimum AA ${label}`} value={minScore} onChange={setMin} min={0} max={100} step={1} />
          </div>
          <div className="chips" role="group" aria-label="Capability filters">
            {SHOWN_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={`chip${filters.has(f) ? " on" : ""}`}
                aria-pressed={filters.has(f)}
                onClick={() => toggleFilter(f)}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>

        <div className="frontier-layout">
          <FrontierChart
            scored={scored}
            front={front}
            index={index}
            minScore={minScore}
            onMin={setMin}
            onStep={stepMin}
            pinned={pinned}
            onPin={togglePin}
            onUnpin={() => setPinned(null)}
            onPreview={setHovered}
            answer={answer}
          />
          <PointReadout
            ref={readoutRef}
            point={selectedPoint ?? answer ?? front[front.length - 1] ?? null}
            state={pinned && selectedPoint ? "pinned" : selectedPoint ? "preview" : "answer"}
            scored={scored}
            index={index}
            costHref={(k) => costUrl([k], workload, rate, preset, index)}
          />
        </div>

        {vsChat && (
          <p className="fine">
            Against the Chat preset, this workload's frontier gains {vsChat.joined}{" "}
            {vsChat.joined === 1 ? "model" : "models"} and loses {vsChat.left}.
          </p>
        )}

        <AllPlotted
          scored={scored}
          front={front}
          index={index}
          onSelect={(key) => {
            setPinned(key);
            // The readout is above the table; take the user to what changed.
            requestAnimationFrame(() => {
              readoutRef.current?.scrollIntoView({ block: "nearest" });
              readoutRef.current?.focus({ preventScroll: true });
            });
          }}
        />
      </section>

      <section className="section" aria-labelledby="ladder-h">
        <div className="section-title bench-head">
          <h2 id="ladder-h">The ladder</h2>
          <div className="bench-actions">
            <CopyButton label="Copy ladder as Markdown" getText={ladderMarkdown} onCopied={() => trackEvent("Share", "Copy ladder")} />
            <CopyButton
              label="Copy link"
              getText={shareUrl}
              share={{ title: "LMOmnibus frontier", url: shareUrl }}
              onCopied={(how) => trackEvent("Share", how === "share" ? "Native share" : "Copy link")}
            />
            {front.length > 0 && (
              <Link
                className="text-btn"
                state={INTERNAL}
                to={costUrl(front.slice(-MAX_BENCH).map((p) => p.model.key), workload, rate, preset, index)}
                onClick={() => trackEvent("Frontier", "Open on bench")}
              >
                Open {Math.min(front.length, MAX_BENCH)} on the bench
                <Mark kind="to" />
              </Link>
            )}
          </div>
        </div>
        <div className="table-frame">
          <table className="market ladder">
            <caption className="sr-only">
              Frontier models on AA {label}, cheapest first, with the cost multiple and score gain of each step up
            </caption>
            <thead>
              <tr>
                <th>Model</th>
                <th className="n">AA {label}</th>
                <th className="n">$ / 1K req</th>
                <th className="n">$ / mo</th>
                <th>Step up</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => {
                const clears = scoreOf(s.point.model, index)! >= minScore;
                return (
                  <tr key={s.point.model.key} className={answer?.model.key === s.point.model.key ? "benched" : undefined}>
                    <td>
                      <span className="nm">{s.point.model.displayName}</span>
                      <span className="vd">
                        {s.point.model.vendorName} <SourceTag model={s.point.model} />
                      </span>
                    </td>
                    <td className={`n${clears ? "" : " na"}`}>{scoreOf(s.point.model, index)!.toFixed(1)}</td>
                    <td className="n col-cost">
                      {fmtUsd(s.point.per1k)}
                      <FallbackMark breakdown={s.point.breakdown} />
                    </td>
                    <td className="n">{fmtMoney(s.point.breakdown.monthlyCost)}</td>
                    <td className="mono step">
                      {s.costMultiple === null
                        ? "cheapest scored"
                        : `×${s.costMultiple.toFixed(1)} for +${s.scoreGain!.toFixed(1)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {steps.length === 0 && <div className="empty-note">No scored model fits this workload with these filters.</div>}
        </div>
        <p className="fine">
          {scored.length} of {pool.length} models that fit this workload carry an AA {label} score; unscored models are
          not plotted. Indices: Artificial Analysis, via OpenRouter, snapshot {CATALOG_META.asOf} — AA rescales between
          versions, so don't compare scores across snapshots. List-price cost at your workload, not cost per task:
          reasoning models may emit more output than this workload assumes.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const W = 880;
const H = 440;
const M = { top: 16, right: 24, bottom: 44, left: 52 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;
const CHAR_W = 6.4;

interface ChartProps {
  scored: Priced[];
  front: Priced[];
  index: Index;
  minScore: number;
  onMin: (v: number) => void;
  onStep: (delta: number) => void;
  pinned: string | null;
  onPin: (key: string) => void;
  onUnpin: () => void;
  onPreview: (key: string | null) => void;
  answer: Priced | null;
}

function FrontierChart({ scored, front, index, minScore, onMin, onStep, pinned, onPin, onUnpin, onPreview, answer }: ChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const ruleRef = useRef<SVGGElement>(null);
  // Chromium ignores touch-action on SVG <g>, and React's touch listeners are
  // passive, so stop page panning on the rule with a native listener.
  useEffect(() => {
    const el = ruleRef.current;
    if (!el) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    el.addEventListener("touchstart", stop, { passive: false });
    return () => el.removeEventListener("touchstart", stop);
  }, []);
  const dragging = useRef(false);

  const costs = scored.map((p) => p.cost);
  const scores = scored.map((p) => scoreOf(p.model, index)!);
  const xMin = costs.length ? Math.min(...costs) / 1.4 : 0.01;
  const xMax = costs.length ? Math.max(...costs) * 1.4 : 100;
  const yMin = scores.length ? Math.max(0, Math.floor((Math.min(...scores) - 2) / 5) * 5) : 0;
  const yMax = scores.length ? Math.min(100, Math.ceil((Math.max(...scores) + 2) / 5) * 5) : 100;

  const x = (c: number) => M.left + ((Math.log10(c) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * PW;
  const y = (s: number) => M.top + (1 - (s - yMin) / (yMax - yMin)) * PH;
  const yInv = (py: number) => yMin + (1 - (py - M.top) / PH) * (yMax - yMin);

  const frontKeys = new Set(front.map((p) => p.model.key));
  const xTicks = logTicks(xMin, xMax);
  const yStep = yMax - yMin > 40 ? 10 : 5;
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax; v += yStep) yTicks.push(v);

  // Stepped frontier path: across at the old score, then up to the new one.
  const path = front
    .map((p, i) => {
      const px = x(p.cost);
      const py = y(scoreOf(p.model, index)!);
      if (i === 0) return `M${px},${py}`;
      const prevY = y(scoreOf(front[i - 1].model, index)!);
      return `L${px},${prevY} L${px},${py}`;
    })
    .join(" ");

  // Label frontier points only, avoiding collisions; unlabelled ones still focus.
  const labels = useMemo(() => {
    const placed: { x: number; y: number; w: number }[] = [];
    const out = new Map<string, { x: number; y: number; anchor: "start" | "end" }>();
    for (const p of front) {
      const px = x(p.cost);
      const py = y(scoreOf(p.model, index)!);
      const text = p.model.displayName;
      const w = text.length * CHAR_W;
      const right = px + 8 + w < W - 4;
      const candidates = [
        { x: right ? px + 8 : px - 8, y: py - 7 },
        { x: right ? px + 8 : px - 8, y: py + 15 },
        { x: right ? px - 8 : px + 8, y: py - 7, flip: true },
      ];
      for (const c of candidates) {
        const anchor: "start" | "end" = (c.flip ? !right : right) ? "start" : "end";
        const left = anchor === "start" ? c.x : c.x - w;
        const hit = placed.some((b) => left < b.x + b.w + 4 && left + w + 4 > b.x && Math.abs(c.y - b.y) < 13);
        if (!hit && left > 0 && left + w < W) {
          placed.push({ x: left, y: c.y, w });
          out.set(p.model.key, { x: c.x, y: c.y, anchor });
          break;
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [front, index, xMin, xMax, yMin, yMax]);

  const setFromPointer = (clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const py = ((clientY - rect.top) / rect.height) * H;
    onMin(yInv(Math.min(Math.max(py, M.top), M.top + PH)));
  };

  const minY = y(Math.min(Math.max(minScore, yMin), yMax));
  const [preview, setPreview] = useState<string | null>(null);
  const shownKey = pinned ?? preview;
  const selectedPoint = shownKey ? scored.find((p) => p.model.key === shownKey) : null;
  const enter = (key: string) => () => {
    setPreview(key);
    onPreview(key);
  };
  const leave = () => {
    setPreview(null);
    onPreview(null);
  };

  return (
    <div className="chart-frame">
      <svg
        ref={svgRef}
        className="frontier-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`Scatter of ${scored.length} models: cost per 1,000 requests against AA ${INDEX_LABEL[index]}. ${front.length} are on the frontier; the ladder and the full list below have the same data.`}
        onPointerMove={(e) => dragging.current && setFromPointer(e.clientY)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onUnpin();
        }}
      >
        {/* y grid and labels */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={M.left - 8} y={y(v) + 4} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {/* x axis as a meter rule */}
        <line className="axis" x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH} />
        {xTicks.map((t) => (
          <g key={`x${t.value}`}>
            <line
              className="axis"
              x1={x(t.value)}
              x2={x(t.value)}
              y1={M.top + PH}
              y2={M.top + PH + (t.major ? 8 : 4)}
            />
            {t.major && <line className="grid" x1={x(t.value)} x2={x(t.value)} y1={M.top} y2={M.top + PH} />}
            {(t.major || xTicks.length < 8) && (
              <text className="axis-label" x={x(t.value)} y={M.top + PH + 22} textAnchor="middle">
                {fmtTick(t.value)}
              </text>
            )}
          </g>
        ))}
        <text className="axis-title" x={W - M.right} y={H - 4} textAnchor="end">
          $ per 1,000 requests at your workload, log scale
        </text>
        <text className="axis-title" x={M.left} y={M.top - 4}>
          ↑ AA {INDEX_LABEL[index]}
        </text>

        {/* minimum-score rule: drag it, or focus it and use arrow keys */}
        <g
          ref={ruleRef}
          className="min-rule"
          role="slider"
          tabIndex={0}
          aria-label={`Minimum AA ${INDEX_LABEL[index]}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={minScore}
          aria-orientation="vertical"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowRight") onStep(1);
            else if (e.key === "ArrowDown" || e.key === "ArrowLeft") onStep(-1);
            else if (e.key === "PageUp") onStep(5);
            else if (e.key === "PageDown") onStep(-5);
            else if (e.key === "Home") onMin(0);
            else if (e.key === "End") onMin(100);
            else return;
            e.preventDefault();
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = true;
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setFromPointer(e.clientY);
          }}
        >
          <rect x={M.left} width={PW} y={minY - 8} height={16} fill="transparent" />
          <line x1={M.left} x2={W - M.right} y1={minY} y2={minY} />
          <text x={M.left + 6} y={minY - 5}>
            min {minScore}
          </text>
        </g>

        <path className="frontier-line" d={path} />

        {scored
          .filter((p) => !frontKeys.has(p.model.key))
          .map((p) => (
            <rect
              key={p.model.key}
              className={`pt-dom${shownKey === p.model.key ? " focused" : ""}`}
              x={x(p.cost) - 2.5}
              y={y(scoreOf(p.model, index)!) - 2.5}
              width={5}
              height={5}
              onPointerEnter={enter(p.model.key)}
              onPointerLeave={leave}
              onClick={() => onPin(p.model.key)}
            >
              <title>{p.model.displayName}</title>
            </rect>
          ))}

        {front.map((p) => {
          const lab = labels.get(p.model.key);
          const isAnswer = answer?.model.key === p.model.key;
          return (
            <g
              key={p.model.key}
              className={`pt-front${shownKey === p.model.key ? " focused" : ""}${isAnswer ? " answer" : ""}`}
              tabIndex={0}
              role="button"
              aria-pressed={pinned === p.model.key}
              aria-label={`${p.model.displayName}: AA ${scoreOf(p.model, index)!.toFixed(1)}, ${fmtUsd(p.per1k)} per 1,000 requests`}
              onFocus={enter(p.model.key)}
              onBlur={leave}
              onPointerEnter={enter(p.model.key)}
              onPointerLeave={leave}
              onClick={() => onPin(p.model.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPin(p.model.key);
                }
              }}
            >
              <rect x={x(p.cost) - 3.5} y={y(scoreOf(p.model, index)!) - 3.5} width={7} height={7} />
              {lab && (
                <text x={lab.x} y={lab.y} textAnchor={lab.anchor}>
                  {p.model.displayName}
                </text>
              )}
            </g>
          );
        })}

        {selectedPoint && !frontKeys.has(selectedPoint.model.key) && (
          <text
            className="focus-label"
            x={x(selectedPoint.cost) + 8}
            y={y(scoreOf(selectedPoint.model, index)!) - 6}
            textAnchor={x(selectedPoint.cost) > W - 160 ? "end" : "start"}
          >
            {selectedPoint.model.displayName}
          </text>
        )}
      </svg>
    </div>
  );
}

function fmtTick(v: number): string {
  if (v >= 1) return `$${v.toLocaleString("en-US")}`;
  return `$${v}`;
}

function flagText(m: Model): string {
  const inputs = inputModalities(m);
  return (
    [
      m.capabilities.tools && "tools",
      m.capabilities.reasoning && "reasoning",
      inputs.includes("image") && "image in",
      inputs.includes("audio") && "audio in",
    ]
      .filter(Boolean)
      .join(" · ") || "text only"
  );
}

const KICKER = { pinned: "Pinned — Escape to clear", preview: "Preview", answer: "Answer to your bar" };

const PointReadout = forwardRef<
  HTMLElement,
  { point: Priced | null; state: keyof typeof KICKER; scored: Priced[]; index: Index; costHref: (key: string) => string }
>(function PointReadout({ point, state, scored, index, costHref }, ref) {
  if (!point)
    return (
      <aside className="point-readout empty" ref={ref} tabIndex={-1}>
        Hover, focus or tap a point.
      </aside>
    );
  const m = point.model;
  const dom = dominatedBy(point, scored, index);
  return (
    <aside className="point-readout" aria-label={`${m.displayName}, ${KICKER[state].toLowerCase()}`} ref={ref} tabIndex={-1}>
      <div className="readout-kicker">{KICKER[state]}</div>
      <div className="bn">{m.displayName}</div>
      <div className="bv">
        {m.vendorName} <SourceTag model={m} />
      </div>
      <dl className="spec">
        <dt>AA {INDEX_LABEL[index]}</dt>
        <dd>{scoreOf(m, index)?.toFixed(1) ?? "—"}</dd>
        <dt>$ / 1K req</dt>
        <dd>
          {fmtUsd(point.per1k)}
          <FallbackMark breakdown={point.breakdown} />
        </dd>
        <dt>$ / mo</dt>
        <dd>{fmtMoney(point.breakdown.monthlyCost)}</dd>
        <dt>Context</dt>
        <dd>{fmtCompact(m.contextTokens)}</dd>
        <dt>Supports</dt>
        <dd>{flagText(m)}</dd>
      </dl>
      {dom ? (
        <p className="verdict-line">
          Dominated by <strong>{dom.model.displayName}</strong>:{" "}
          {scoreOf(dom.model, index)! > scoreOf(m, index)! ? "higher score" : "same score"},{" "}
          <span className="mono">{fmtUsd(point.per1k.minus(dom.per1k))}</span> less per 1K
        </p>
      ) : (
        <p className="verdict-line down">
          <Mark kind="best" /> On the frontier
        </p>
      )}
      <Link
        className="text-btn"
        state={INTERNAL}
        to={costHref(m.key)}
        onClick={() => trackEvent("Frontier", "Point to bench", m.key)}
      >
        + Bench in the Cost Calculator
      </Link>
    </aside>
  );
});

/**
 * Every plotted model as a table: the keyboard- and screen-reader route to
 * the ~200 dominated points the chart only shows on hover.
 */
function AllPlotted({
  scored,
  front,
  index,
  onSelect,
}: {
  scored: Priced[];
  front: Priced[];
  index: Index;
  onSelect: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => {
    if (!open) return [];
    const onFront = new Set(front.map((p) => p.model.key));
    return [...scored]
      .sort((a, b) => a.cost - b.cost)
      .map((p) => ({ p, dom: onFront.has(p.model.key) ? null : dominatedBy(p, scored, index) }));
  }, [open, scored, front, index]);
  return (
    <details className="all-plotted" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>All {scored.length} plotted models, cheapest first</summary>
      {open && (
        <div className="table-frame">
          <table className="market">
            <thead>
              <tr>
                <th>Model</th>
                <th className="n">AA {INDEX_LABEL[index]}</th>
                <th className="n">$ / 1K req</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, dom }) => (
                <tr key={p.model.key}>
                  <td>
                    <button type="button" className="row-btn" onClick={() => onSelect(p.model.key)}>
                      {p.model.displayName}
                    </button>
                    <span className="vd">
                      {p.model.vendorName} <SourceTag model={p.model} />
                    </span>
                  </td>
                  <td className="n">{scoreOf(p.model, index)!.toFixed(1)}</td>
                  <td className="n">
                    {fmtUsd(p.per1k)}
                    <FallbackMark breakdown={p.breakdown} />
                  </td>
                  <td className="verdict-cell">{dom ? `dominated by ${dom.model.displayName}` : "on the frontier"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
