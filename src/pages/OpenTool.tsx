import "./open.css";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { CopyButton, FallbackMark, Mark, Meter, SourceTag, WorkloadPanel, workloadLine } from "../components.tsx";
import { allModels, CATALOG_META, modelByKey } from "../core/catalog.ts";
import type { Rate, Workload } from "../core/cost.ts";
import { todayIso } from "../core/date.ts";
import { fmtUsd } from "../core/fmt.ts";
import { FILTER_LABEL, INDEX_LABEL, passesFilters, priceAll, scoreOf, type Index, type Priced } from "../core/frontier.ts";
import { rateCard } from "../core/model.ts";
import {
  catchUpLag,
  defaultTarget,
  frontiers,
  gapReading,
  LICENCE_FILTER_LABEL,
  medianLagDays,
  oneSideZone,
  parityRow,
  parityThresholds,
  passesLicence,
  runningBest,
  SIDE_LABEL,
  sideOf,
  split,
  type LicenceFilter,
  type ParityRow,
  type Side,
} from "../core/openclosed.ts";
import { matchingPreset, type PresetId } from "../core/presets.ts";
import { encodeKey, encodeScenario } from "../core/share.ts";
import { titleFor } from "../routes.ts";
import { recordFor, WEIGHTS_AS_OF } from "../weightsData.ts";
import { MatchSection } from "./open/Match.tsx";
import { coverageOf, CoverageTable, LicenceTable, OfferLine } from "./open/Offer.tsx";
import { PointReadout, PriceScoreChart, PriceScoreLegend } from "./open/PriceScoreChart.tsx";
import { headlineLag, RunningBestChart, type HeadlineLag } from "./open/RunningBestChart.tsx";
import { SelfHostSection } from "./open/SelfHost.tsx";
import { Cheaper, fmtRatio, fmtScore, fmtTarget, INTERNAL, isoMinusDays, Pricier, useEscape, useNarrow, useSettled } from "./open/shared.tsx";
import {
  decodeOpen,
  encodeOpen,
  hasOpenState,
  OPEN_FILTERS,
  roundTarget,
  type OpenFilter,
  type SelfCtx,
  type SelfFormat,
  type Span,
  type Tol,
} from "./open/state.ts";

const MODELS = allModels();
const SNAPSHOT = CATALOG_META.asOf;
const SIDE_COUNT: Record<Side, number> = {
  open: MODELS.filter((m) => sideOf(m) === "open").length,
  closed: MODELS.filter((m) => sideOf(m) === "closed").length,
};
const HAND_SET = MODELS.filter((m) => m.opennessSource && m.weightsStatus === "open");

/**
 * Models marked open-weight that sit on neither side, grouped by why: a repo we
 * haven't read yet (no weights record: a new listing, or a day the Hugging Face
 * read failed), or one we tried and couldn't open on a given day.
 */
const UNVERIFIED: { names: string[]; why: string }[] = (() => {
  const groups = new Map<string, string[]>();
  for (const m of MODELS) {
    if (m.weightsStatus !== "unverified") continue;
    const who = m.opennessSource ? "our hand-checked list links" : "OpenRouter links";
    const why = m.weights
      ? `${who} a Hugging Face repo we couldn't open on ${recordFor(m)?.checkedOn ?? WEIGHTS_AS_OF}`
      : `${who} a Hugging Face repo we haven't read yet`;
    groups.set(why, [...(groups.get(why) ?? []), m.displayName]);
  }
  return [...groups].map(([why, names]) => ({ names, why }));
})();
const LICS: LicenceFilter[] = ["any", "permissive", "no-nc"];
const LIC_OPTION: Record<LicenceFilter, string> = { any: "Any licence", permissive: "Permissive only", "no-nc": "Permissive or custom terms" };
const OR_CAVEAT =
  "Most open-weight prices here are OpenRouter's listing, which is often the cheapest of several providers. Other providers can charge several times more, and some serve lower-precision builds. Prices tagged 'list' were checked against the vendor's own price list.";

/** Why a `vs` key from a link can't be focused, or null. */
function checkVs(key: string): string | null {
  const m = modelByKey(key);
  if (!m) return "not in this snapshot";
  const side = sideOf(m);
  if (side === "open") return "an open-weight model";
  if (side === null) return "its weights couldn't be verified";
  return null;
}

export function OpenTool() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();
  const today = todayIso();
  const [init] = useState(() => decodeOpen(params, checkVs));
  const s0 = init.scenario;

  const [workload, setWorkload] = useState<Workload>(s0.workload);
  const [rate, setRate] = useState<Rate>(s0.rate);
  const [preset, setPreset] = useState<PresetId | null>(s0.preset);
  const [index, setIndex] = useState<Index>(s0.index);
  const [filters, setFilters] = useState<Set<OpenFilter>>(s0.filters);
  // null = untouched: the target follows the default, so a link without min= reproduces what you see.
  const [minSet, setMinSet] = useState<number | null>(s0.minScore);
  const [lic, setLic] = useState<LicenceFilter>(s0.lic);
  const [vs, setVs] = useState<string | null>(s0.vs);
  const [tol, setTol] = useState<Tol>(s0.tol);
  const [span, setSpan] = useState<Span>(s0.span);
  const [all, setAll] = useState(s0.all);
  const [cov, setCov] = useState(s0.cov);
  const [sq, setSq] = useState<SelfFormat>(s0.sq);
  const [sctx, setSctx] = useState<SelfCtx>(s0.sctx);
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  // Escape clears a pin wherever focus is: a click on a hollow point or a label pins it without focusing anything.
  const unpin = useCallback(() => setPinned(null), []);
  useEscape(pinned !== null, unpin);
  const targetTracked = useRef(false);
  const readoutRef = useRef<HTMLElement>(null);
  const chartARef = useRef<HTMLElement>(null);
  const chartBRef = useRef<HTMLElement>(null);
  const narrowA = useNarrow(chartARef);
  const narrowB = useNarrow(chartBRef);

  const encoded = encodeOpen({ preset, workload, rate, index, minScore: minSet, filters, lic, vs, tol, span, all, cov, sq, sctx });
  // null until written: a link that carried anything is rewritten once in normal form, even when that's empty.
  const synced = useRef<string | null>(hasOpenState(params) ? null : encoded);
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      // Navigate with the raw string: URLSearchParams would percent-encode ":" and ",". Any #anchor stays.
      navigate({ pathname, search: encoded ? `?${encoded}` : "", hash }, { replace: true, state: INTERNAL });
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, navigate, pathname, hash]);

  // ---- the numbers
  const priced = useMemo(() => priceAll(MODELS, workload, rate, today), [workload, rate, today]);
  // Both sides pass the capability filters; the licence filter only ever removes open-weight models.
  const pool = useMemo(
    () => priced.filter((p) => sideOf(p.model) !== null && passesFilters(p.model, filters, workload, index) && passesLicence(p.model, lic)),
    [priced, filters, workload, index, lic],
  );
  const plotted = useMemo(() => split(pool.filter((p) => scoreOf(p.model, index) !== null && p.cost > 0)), [pool, index]);
  const fronts = useMemo(() => frontiers([...plotted.open, ...plotted.closed], index), [plotted, index]);
  const gap = useMemo(() => gapReading(pool, index), [pool, index]);
  const defaultT = useMemo(() => {
    const t = defaultTarget(pool, index);
    if (t !== null) return t;
    const only = gap.best.open ?? gap.best.closed;
    return only ? Math.floor(scoreOf(only.model, index)! / 5) * 5 : 0;
  }, [pool, index, gap]);
  const target = minSet ?? defaultT;
  const answers = useMemo(() => parityRow(pool, index, target), [pool, index, target]);
  const zone = useMemo(() => oneSideZone(pool, index), [pool, index]);
  const models = useMemo(() => pool.map((p) => p.model), [pool]);
  const records = useMemo(() => ({ open: runningBest(models, index, "open"), closed: runningBest(models, index, "closed") }), [models, index]);
  const lags = useMemo(() => records.open.map((r) => catchUpLag(r, records.closed)), [records]);
  const lag = useMemo(() => headlineLag(records, catchUpLag), [records]);
  const yearAgo = isoMinusDays(SNAPSHOT, 365);
  const medianLag = useMemo(() => medianLagDays(lags, yearAgo), [lags, yearAgo]);
  const thresholds = useMemo(() => parityThresholds(pool, index, target), [pool, index, target]);
  const parity = useMemo(() => thresholds.map((t) => parityRow(pool, index, t)), [pool, index, thresholds]);
  const coverageModels = useMemo(() => MODELS.filter((m) => passesLicence(m, lic)), [lic]);
  const covered = useMemo(() => coverageOf(coverageModels, index, today, cov ? target : undefined), [coverageModels, index, today, cov, target]);
  const openPool = useMemo(() => pool.filter((p) => sideOf(p.model) === "open"), [pool]);
  const bestClosed = useMemo(
    () => (gap.best.closed ? { score: scoreOf(gap.best.closed.model, index)!, name: gap.best.closed.model.displayName } : null),
    [gap, index],
  );
  const bestClosedYearAgo = useMemo(() => {
    const old = plotted.closed.filter((p) => p.model.listedOn && p.model.listedOn <= yearAgo);
    return old.length ? { score: Math.max(...old.map((p) => scoreOf(p.model, index)!)), by: yearAgo } : null;
  }, [plotted, index, yearAgo]);

  const label = INDEX_LABEL[index];
  const sideTotal = { open: pool.filter((p) => sideOf(p.model) === "open").length, closed: pool.filter((p) => sideOf(p.model) === "closed").length };
  const empty: Record<Side, boolean> = { open: plotted.open.length === 0, closed: plotted.closed.length === 0 };
  const cantCompare = empty.open || empty.closed ? `Can't compare: no rated ${empty.open ? "open-weight" : "closed"} model passes these filters.` : null;
  const noCachePrice = pool.filter((p) => sideOf(p.model) === "open" && !rateCard(p.model, p.breakdown.mode)?.cacheRead).length;

  // ---- links
  // Stable between renders, so hovering Chart A doesn't re-render the sections below it.
  const costHref = useCallback(
    (keys: string[]) => `/tools/cost?${encodeScenario({ models: keys, preset, workload, rate, modes: new Map(), index })}`,
    [preset, workload, rate, index],
  );
  const switchHref = useCallback(
    (key: string) => `/tools/switch?from=${encodeKey(key)}&ow=1&${encodeScenario({ models: [], preset, workload, rate, modes: new Map(), index })}`,
    [preset, workload, rate, index],
  );
  const shareUrl = useCallback(() => `${window.location.origin}/tools/open${encoded ? `?${encoded}` : ""}`, [encoded]);

  // ---- control handlers
  const trackTarget = () => {
    if (targetTracked.current) return;
    targetTracked.current = true;
    trackEvent("Open vs Closed", "Target set");
  };
  const setTarget = (v: number) => {
    trackTarget();
    setMinSet(roundTarget(v));
  };
  // Functional update from the latest value, so fast key-repeat never drops a step.
  const stepTarget = (delta: number) => {
    trackTarget();
    setMinSet((prev) => roundTarget((prev ?? defaultT) + delta));
  };
  const toggleFilter = (f: OpenFilter) => {
    trackEvent("Open vs Closed", "Filter", f);
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const togglePin = (key: string) => {
    if (pinned !== key) trackEvent("Open vs Closed", "Point pinned", key);
    setPinned((p) => (p === key ? null : key));
  };

  // ---- readings
  const r1 = readGap(gap, index, cantCompare);
  const r2 = readPrice(answers, target, cantCompare);
  const r3 = readZone(zone, plotted, index, cantCompare);
  const r4 = readLag(lag, cantCompare);
  const summary = useSettled([r1.text, r2.text].join(" "));

  const cheaperAnswer = answers.pricier === "closed" ? answers.open : answers.pricier === "open" ? answers.closed : (answers.open ?? answers.closed);
  const allPlotted = [...plotted.open, ...plotted.closed];
  const shownKey = pinned ?? hovered;
  const selected = shownKey ? (allPlotted.find((p) => p.model.key === shownKey) ?? null) : null;

  const parityMarkdown = () =>
    [
      `| AA ${label} ≥ | Cheapest open-weight | AA | $/1K req | Cheapest closed | AA | $/1K req | Pricier side |`,
      "|---:|---|---:|---:|---|---:|---:|---|",
      ...parity.map((r) => {
        const cell = (p: Priced | null) =>
          p ? `${p.model.displayName} | ${fmtScore(scoreOf(p.model, index)!)} | ${fmtUsd(p.per1k)} (${rateCard(p.model, p.breakdown.mode)?.checked ? "list" : "via OR"})` : "— | | ";
        return `| ${fmtTarget(r.threshold)}${r.threshold === target ? " (target)" : ""} | ${cell(r.open)} | ${cell(r.closed)} | ${pricierText(r)} |`;
      }),
      "",
      `Workload: ${workloadLine(workload, rate, true)}`,
      `Prices as of ${SNAPSHOT} · AA ${label} via OpenRouter · list-price cost, not cost per task · LMOmnibus`,
      OR_CAVEAT,
      shareUrl(),
    ].join("\n");

  const recordsMarkdown = () =>
    [
      `| Open-weight record | Listed | AA ${label} | First closed at or above | Listed | Lag (days) |`,
      "|---|---|---:|---|---|---:|",
      ...lags.map(
        (l) =>
          `| ${l.open.model.displayName} | ${l.open.listedOn} | ${fmtScore(l.open.score)} | ${l.closedFirst?.model.displayName ?? "none yet"} | ${l.closedFirst?.listedOn ?? ""} | ${l.days ?? ""} |`,
      ),
      "",
      `OpenRouter listing dates, not release dates · today's AA scores (snapshot ${SNAPSHOT}) placed at each listing date · LMOmnibus`,
      shareUrl(),
    ].join("\n");

  return (
    <>
      <title>{titleFor("/tools/open")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 07</span>
        <h1>Open weights vs closed</h1>
        <p className="sub">
          Priced at your workload and scored on Artificial Analysis's indices from one snapshot: what open-weight models cost, how far
          behind the best one runs, which closed models already have an open-weight match, and what you could run yourself.
        </p>
        <p className="snapshot-line oc-data-line">
          Prices as of {SNAPSHOT} · Weights data as of {WEIGHTS_AS_OF} · AA snapshot {SNAPSHOT}
        </p>
      </div>

      {init.dropped.length > 0 && (
        <p className="oc-notice" role="note">
          Ignored from the link: {init.dropped.join(" · ")}.
        </p>
      )}

      <dl className="spec-grid three oc-defs">
        <div>
          <dt>Open-weight</dt>
          <dd>
            <span className="mono">{SIDE_COUNT.open}</span> models · downloadable from Hugging Face
          </dd>
        </div>
        <div>
          <dt>Closed</dt>
          <dd>
            <span className="mono">{SIDE_COUNT.closed}</span> models · API only
          </dd>
        </div>
        <div>
          <dt>Weights, not the recipe</dt>
          <dd>
            data and code rarely released; licences vary ·{" "}
            <a
              href="#oc-lic-h"
              onClick={(e) => {
                // Jump without touching the URL: the page keeps its address in sync, and a hash would read as a new page.
                e.preventDefault();
                const h = document.getElementById("oc-lic-h");
                h?.scrollIntoView({ block: "start" });
                h?.focus({ preventScroll: true });
              }}
            >
              Licences
            </a>
          </dd>
        </div>
      </dl>
      <p className="oc-definition">
        <strong>Open-weight</strong> means you can download the trained weights: OpenRouter, or our hand-checked list, links a Hugging
        Face repository we could open on {WEIGHTS_AS_OF}. That is narrower than open in the full sense: training data and code are
        rarely published, and the licence decides what you may do with the weights. <strong>Closed</strong> means available only
        through an API.
      </p>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="oc-readings-h">
        <h2 id="oc-readings-h" className="sr-only">
          Readings
        </h2>
        <p className="sr-only" role="status" aria-live="polite">
          {summary}
        </p>
        <ol className="oc-readings">
          <Reading tag="R1 · Gap" r={r1} />
          <Reading tag="R2 · Price at your bar" r={r2} />
          <Reading tag="R3 · Only one side" r={r3} />
          <Reading tag="R4 · Listing lag" r={r4} />
        </ol>
        <p className="fine">
          At the {matchingPreset(workload, rate)?.label ?? "custom"} workload (<span className="mono">{workloadLine(workload, rate)}</span>) on
          AA {label}; every reading recomputes as you change the controls below.
        </p>
      </section>

      <section className="section" aria-labelledby="oc-controls-h">
        <div className="section-title bench-head">
          <h2 id="oc-controls-h">Workload and filters</h2>
          <div className="bench-actions">
            <CopyButton
              label="Copy link"
              getText={shareUrl}
              share={{ title: "LMOmnibus: open weights vs closed", url: shareUrl }}
              onCopied={(how) => trackEvent("Share", how === "share" ? "Native share" : "Copy link")}
            />
          </div>
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
        <div className="frontier-controls oc-controls">
          <div className="inp rate-field oc-field">
            <span className="il" id="oc-index-label">
              AA index
            </span>
            <div className="seg" role="group" aria-labelledby="oc-index-label">
              {(Object.keys(INDEX_LABEL) as Index[]).map((i) => (
                <button
                  key={i}
                  type="button"
                  aria-pressed={index === i}
                  className={index === i ? "on" : ""}
                  onClick={() => {
                    trackEvent("Open vs Closed", "Index switch", i);
                    setIndex(i);
                    setPinned(null);
                    setHovered(null);
                  }}
                >
                  {INDEX_LABEL[i]}
                </button>
              ))}
            </div>
          </div>
          <TargetField label={label} value={target} onChange={setTarget} onStep={stepTarget} />
          <div className="inp rate-field oc-field">
            <label className="il" htmlFor="oc-lic">
              Licence
            </label>
            <select
              id="oc-lic"
              className="oc-select"
              value={lic}
              aria-describedby="oc-lic-hint"
              onChange={(e) => {
                const l = e.target.value as LicenceFilter;
                trackEvent("Open vs Closed", "Licence filter", l);
                setLic(l);
              }}
            >
              {LICS.map((l) => (
                <option key={l} value={l} title={LICENCE_FILTER_LABEL[l]}>
                  {LIC_OPTION[l]}
                </option>
              ))}
            </select>
            <span className="oc-hint" id="oc-lic-hint">
              applies to open-weight models
            </span>
          </div>
          <div className="chips" role="group" aria-label="Capability filters, applied to both sides">
            {OPEN_FILTERS.map((f) => (
              <button key={f} type="button" className={`chip${filters.has(f) ? " on" : ""}`} aria-pressed={filters.has(f)} onClick={() => toggleFilter(f)}>
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
        <p className="fine oc-coverage-line">
          AA {label} rates <span className="mono">{plotted.open.length}</span> open-weight and{" "}
          <span className="mono">{plotted.closed.length}</span> closed models
          {filters.size || lic !== "any" ? " that pass these filters" : ""};{" "}
          <span className="mono">{sideTotal.open - plotted.open.length}</span> and{" "}
          <span className="mono">{sideTotal.closed - plotted.closed.length}</span> aren't rated and aren't plotted.
        </p>
      </section>

      <Meter className="section-break" />

      {/* §A */}
      <section className="section" aria-labelledby="oc-a-h">
        <div className="section-title">
          <h2 id="oc-a-h">
            <span className="sec-num">A</span> Where do open-weight models sit on price and score?
          </h2>
          <span className="count">
            {fronts.open.length + fronts.closed.length} on a frontier · {allPlotted.length} plotted
          </span>
        </div>
        <figure className="oc-figure" ref={chartARef}>
          <figcaption className="readout" id="oc-a-cap">
            {r2.node}
          </figcaption>
          <p className="sr-only" id="oc-a-sum">
            Scatter of {allPlotted.length} rated models: cost per 1,000 requests at your workload (log scale) against AA {label}.
            Closed models are squares and open-weight models circles; each side has its own stepped frontier. The table “Cheapest at
            each score” below has the same answers.
          </p>
          <div className="frontier-layout">
            <PriceScoreChart
              plotted={plotted}
              fronts={fronts}
              index={index}
              target={target}
              onTarget={setTarget}
              onStep={stepTarget}
              answers={answers}
              zone={zone}
              pinned={pinned}
              shown={shownKey}
              onPin={togglePin}
              onPreview={setHovered}
              narrow={narrowA}
              labelledBy="oc-a-cap"
              describedBy="oc-a-sum"
            />
            <PointReadout
              ref={readoutRef}
              point={selected ?? cheaperAnswer ?? gap.best.open ?? null}
              state={pinned && selected ? "pinned" : selected ? "preview" : "answer"}
              points={pool}
              index={index}
              costHref={(k) => costHref([k])}
            />
          </div>
          <PriceScoreLegend empty={empty} />
        </figure>
        <p className="fine">
          {plotted.open.length} open-weight and {plotted.closed.length} closed models are rated on AA {label} and plotted;{" "}
          {sideTotal.open - plotted.open.length + sideTotal.closed - plotted.closed.length} unrated ones aren't.{" "}
          {noCachePrice > 0 && (
            <>
              {noCachePrice} open-weight {noCachePrice === 1 ? "model publishes" : "models publish"} no cache-read price, so at
              cache-heavy workloads their cached share is billed as fresh input (marked “no cache price”).{" "}
            </>
          )}
          {OR_CAVEAT}
        </p>

        <div className="section-title bench-head oc-subhead">
          <h3 id="oc-parity-h">Cheapest at each score</h3>
          <div className="bench-actions">
            <CopyButton label="Copy as Markdown" getText={parityMarkdown} onCopied={() => trackEvent("Share", "Copy parity table")} />
            {answers.open && answers.closed && (
              <Link
                className="text-btn"
                state={INTERNAL}
                to={costHref([answers.open.model.key, answers.closed.model.key])}
                onClick={() => trackEvent("Open vs Closed", "To bench")}
              >
                Open both answers on the bench
                <Mark kind="to" />
              </Link>
            )}
          </div>
        </div>
        <div className="table-frame">
          <table className="market oc-parity">
            <caption className="sr-only">
              The cheapest open-weight and closed model scoring at least each AA {label} threshold, at your workload: the data
              behind the chart. {OR_CAVEAT}
            </caption>
            <thead>
              <tr>
                <th className="n">AA ≥</th>
                <th>
                  <span className="oc-d-only">Cheapest open-weight</span>
                  <span className="oc-m-only">Open-weight</span>
                </th>
                <th className="n oc-col-cost">$ / 1K</th>
                <th>
                  <span className="oc-d-only">Cheapest closed</span>
                  <span className="oc-m-only">Closed</span>
                </th>
                <th className="n oc-col-cost">$ / 1K</th>
                <th className="oc-col-ratio">Pricier side</th>
              </tr>
            </thead>
            <tbody>
              {parity.map((r) => (
                <ParityTr key={r.threshold} r={r} index={index} isTarget={r.threshold === target} cachedPct={workload.cachedPct} />
              ))}
            </tbody>
          </table>
          {parity.length === 0 && <div className="empty-note">No rated model passes these filters.</div>}
        </div>
      </section>

      <Meter className="section-break" />

      {/* §B */}
      <section className="section" aria-labelledby="match-h">
        <div className="section-title">
          <h2 id="match-h" tabIndex={-1}>
            <span className="sec-num">B</span> Is there an open-weight match for my closed model?
          </h2>
        </div>
        <MatchSection
          models={MODELS}
          priced={priced}
          pool={pool}
          index={index}
          workload={workload}
          rate={rate}
          today={today}
          lic={lic}
          vs={vs}
          onVs={setVs}
          tol={tol}
          onTol={setTol}
          sq={sq}
          sctx={sctx}
          bestOpenScore={gap.best.open ? scoreOf(gap.best.open.model, index) : null}
          costHref={costHref}
          switchHref={switchHref}
          shareUrl={shareUrl}
        />
      </section>

      <Meter className="section-break" />

      {/* §C */}
      <section className="section" aria-labelledby="oc-c-h">
        <div className="section-title">
          <h2 id="oc-c-h">
            <span className="sec-num">C</span> How far behind, and since when?
          </h2>
        </div>
        <figure className="oc-figure" ref={chartBRef}>
          <figcaption className="readout" id="oc-b-cap">
            {r4.node}
            {medianLag !== null && !cantCompare && (
              <>
                {" "}
                Median over the last 12 months of open-weight records:{" "}
                <span className="mono">{medianLag >= 0 ? `${medianLag} days` : `open first by ${-medianLag} days`}</span>.
              </>
            )}
          </figcaption>
          <div className="oc-chart-head">
            <h3 className="oc-chart-title">Running best by OpenRouter listing date</h3>
            <div className="oc-chart-controls">
              <div className="seg seg-small" role="group" aria-label="Date span">
                {(["2y", "all"] as Span[]).map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    aria-pressed={span === sp}
                    className={span === sp ? "on" : ""}
                    onClick={() => {
                      trackEvent("Open vs Closed", "Span", sp);
                      setSpan(sp);
                    }}
                  >
                    {sp === "2y" ? "2 years" : "All listings"}
                  </button>
                ))}
              </div>
              <label className="oc-check">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => {
                    trackEvent("Open vs Closed", "Every model toggle");
                    setAll(e.target.checked);
                  }}
                />{" "}
                Every rated model
              </label>
            </div>
          </div>
          <p className="sr-only" id="oc-b-sum">
            Each side's best AA {label} score so far by OpenRouter listing date, as step lines extended to the snapshot: closed
            solid with square record points, open-weight dashed with circles. The records table below has the same data.
          </p>
          <RunningBestChart
            models={models}
            index={index}
            span={span}
            all={all}
            snapshot={SNAPSHOT}
            records={records}
            lag={lag}
            narrow={narrowB}
            labelledBy="oc-b-cap"
            describedBy="oc-b-sum"
          />
          <ul className="oc-legend" aria-label="Legend">
            <li>
              <svg viewBox="0 0 30 12" aria-hidden="true">
                <line className="oc-sw-line" x1="1" x2="29" y1="6" y2="6" />
                <rect className="oc-sw-fill" x="11.5" y="2.5" width="7" height="7" />
              </svg>
              closed best so far
            </li>
            <li>
              <svg viewBox="0 0 30 12" aria-hidden="true">
                <line className="oc-sw-line open" x1="1" x2="29" y1="6" y2="6" />
                <circle className="oc-sw-fill" cx="15" cy="6" r="3.5" />
              </svg>
              open-weight best so far
            </li>
            <li>
              <svg viewBox="0 0 30 12" aria-hidden="true">
                <line className="oc-sw-dotted" x1="1" x2="29" y1="6" y2="6" />
              </svg>
              listing lag at the trailing side's best
            </li>
            {all && (
              <li>
                <svg viewBox="0 0 24 12" aria-hidden="true">
                  <rect className="oc-sw-hollow" x="3.5" y="3.5" width="5" height="5" />
                  <circle className="oc-sw-hollow" cx="17" cy="6" r="2.5" />
                </svg>
                every rated model
              </li>
            )}
          </ul>
        </figure>
        <p className="fine">
          Today's AA scores (snapshot {SNAPSHOT}) placed at each model's OpenRouter listing date. This is not how the race looked at
          the time: AA rescales between versions, and we never compare snapshots. Listing can trail a vendor's release, often by more
          for open-weight models, which makes the lag look longer. Delisted models are missing, which makes early history thin. A
          model counts as open-weight if its weights are downloadable today.
        </p>
        <details
          className="all-plotted"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open) trackEvent("Open vs Closed", "Records table");
          }}
        >
          <summary>All {lags.length} open-weight records and when closed models first matched them</summary>
          <div className="bench-actions oc-details-actions">
            <CopyButton label="Copy as Markdown" getText={recordsMarkdown} onCopied={() => trackEvent("Share", "Copy markdown")} />
          </div>
          <div className="table-frame">
            <table className="market">
              <caption className="sr-only">
                Each open-weight record on AA {label}, by listing date, and the first closed model listed at or above its score
              </caption>
              <thead>
                <tr>
                  <th>Open-weight record</th>
                  <th>Listed</th>
                  <th className="n">AA {label}</th>
                  <th>First closed at or above</th>
                  <th>Listed</th>
                  <th className="n">Lag (days)</th>
                </tr>
              </thead>
              <tbody>
                {[...lags].reverse().map((l) => (
                  <tr key={l.open.model.key}>
                    <td>
                      <span className="nm">{l.open.model.displayName}</span>
                    </td>
                    <td className="mono oc-small">{l.open.listedOn}</td>
                    <td className="n">{fmtScore(l.open.score)}</td>
                    <td>{l.closedFirst ? l.closedFirst.model.displayName : <span className="na">none yet</span>}</td>
                    <td className="mono oc-small">{l.closedFirst?.listedOn ?? ""}</td>
                    <td className="n">{l.days === null ? "—" : l.days >= 0 ? l.days : `open first by ${-l.days}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lags.length === 0 && <div className="empty-note">No rated open-weight model with a listing date passes these filters.</div>}
          </div>
        </details>
      </section>

      <Meter className="section-break" />

      {/* §D */}
      <section className="section" aria-labelledby="oc-d-h">
        <div className="section-title">
          <h2 id="oc-d-h">
            <span className="sec-num">D</span> What can I run myself?
          </h2>
        </div>
        <SelfHostSection
          open={openPool}
          index={index}
          sq={sq}
          sctx={sctx}
          onSq={setSq}
          onSctx={setSctx}
          bestClosed={bestClosed}
          bestClosedYearAgo={bestClosedYearAgo}
        />
      </section>

      <Meter className="section-break" />

      {/* §E */}
      <section className="section" aria-labelledby="oc-e-h">
        <div className="section-title">
          <h2 id="oc-e-h">
            <span className="sec-num">E</span> What does each side offer?
          </h2>
        </div>
        <p className="readout">
          <OfferLine cov={covered} />.
        </p>
        <h3 className="oc-h3">Capabilities</h3>
        <CoverageTable
          cov={covered}
          index={index}
          onlyAbove={cov}
          target={target}
          onToggle={setCov}
        />
        <h3 className="oc-h3" id="oc-lic-h" tabIndex={-1}>
          Licences
        </h3>
        <LicenceTable models={MODELS} index={index} asOf={WEIGHTS_AS_OF} />
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="oc-method-h">
        <div className="section-title">
          <h2 id="oc-method-h">Method and footnotes</h2>
          <span className="count">as of {SNAPSHOT}</span>
        </div>
        <ul className="oc-method fine">
          <li>
            Prices are “list” (input and output checked by hand against the vendor's price list) or “via OR” (OpenRouter's aggregate),
            fetched {SNAPSHOT}. Cost is list-price cost at your workload, not cost per task: how many requests a task takes depends on
            the model.
          </li>
          <li>
            Scores are Artificial Analysis indices from one snapshot ({SNAPSHOT}), via OpenRouter. AA rescales between versions, so
            scores are only compared within this snapshot. Unrated models aren't plotted and never count as zero.
          </li>
          <li>{OR_CAVEAT}</li>
          <li>
            API prices only: running weights yourself costs hardware and power, which this page doesn't estimate. Memory figures in §D
            are estimates; the <Link state={INTERNAL} to="/tools/vram">VRAM Estimator</Link> shows the arithmetic.
          </li>
          <li>
            A model is open-weight when OpenRouter, or our hand-checked list, links a Hugging Face repository we could open; weights
            data as of {WEIGHTS_AS_OF}.
          </li>
          {UNVERIFIED.map((u) => (
            <li key={u.why}>
              {u.names.join(", ")}: {u.why}; left out of both sides until we can.
            </li>
          ))}
          {HAND_SET.length > 0 && (
            <li>
              Openness set by hand (OpenRouter lists no repository; we checked the weights ourselves):{" "}
              {HAND_SET.map((m, i) => (
                <span key={m.key}>
                  {i > 0 && "; "}
                  <Link state={INTERNAL} to={`/models/${m.key}`}>
                    {m.displayName}
                  </Link>{" "}
                  ({m.opennessSource})
                </span>
              ))}
              .
            </li>
          )}
        </ul>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- readings

interface ReadingOut {
  figure: string | null;
  unit: string;
  node: ReactNode;
  text: string;
}

function Reading({ tag, r }: { tag: string; r: ReadingOut }) {
  return (
    <li className="oc-reading">
      <span className="il">{tag}</span>
      <span className="oc-reading-fig">
        {r.figure === null ? (
          <span className="figure-big oc-none" aria-hidden="true">
            —
          </span>
        ) : (
          <>
            <span className="figure-big">{r.figure}</span>
            <span className="figure-unit">{r.unit}</span>
          </>
        )}
      </span>
      <p>{r.node}</p>
    </li>
  );
}

const plain = (text: string): ReadingOut => ({ figure: null, unit: "", node: text, text });

function readGap(g: ReturnType<typeof gapReading>, index: Index, cant: string | null): ReadingOut {
  if (cant || !g.best.open || !g.best.closed || g.gap === null) return plain(cant ?? "Can't compare with these filters.");
  const label = INDEX_LABEL[index];
  const so = scoreOf(g.best.open.model, index)!;
  const sc = scoreOf(g.best.closed.model, index)!;
  const openLeads = g.gap < 0;
  const lead = openLeads ? "Open-weight leads: the best open-weight model" : "The best open-weight model";
  return {
    figure: openLeads ? `+${fmtScore(-g.gap)}` : fmtScore(g.gap),
    unit: openLeads ? "pts, open-weight leads" : "pts",
    text: `${lead}, ${g.best.open.model.displayName}, scores ${fmtScore(so)} on AA ${label} (#${g.openRank} of ${g.rated} rated). The best closed model, ${g.best.closed.model.displayName}, scores ${fmtScore(sc)}.`,
    node: (
      <>
        {lead}, <strong>{g.best.open.model.displayName}</strong>, scores <strong className="mono">{fmtScore(so)}</strong> on AA {label} (
        <span className="mono">
          #{g.openRank} of {g.rated}
        </span>{" "}
        rated). The best closed model, <strong>{g.best.closed.model.displayName}</strong>, scores{" "}
        <strong className="mono">{fmtScore(sc)}</strong>.
      </>
    ),
  };
}

function readPrice(a: ParityRow, target: number, cant: string | null): ReadingOut {
  if (cant) return plain(cant);
  const t = fmtTarget(target);
  if (!a.open && !a.closed) return plain(`Nothing scores ${t} or more with these filters.`);
  if (!a.open || !a.closed) {
    const has = (a.open ?? a.closed)!;
    const side: Side = a.open ? "open" : "closed";
    const other: Side = side === "open" ? "closed" : "open";
    const text = `Cheapest scoring at least ${t}: ${SIDE_LABEL[side]} ${has.model.displayName} at ${fmtUsd(has.per1k)} per 1K requests; no ${SIDE_LABEL[other]} model scores ${t} or more.`;
    return {
      figure: null,
      unit: "",
      text,
      node: (
        <>
          Cheapest scoring at least <strong className="mono">{t}</strong>: {SIDE_LABEL[side]} <strong>{has.model.displayName}</strong> at{" "}
          <strong className="mono">{fmtUsd(has.per1k)}</strong> per 1K requests <SourceTag model={has.model} mode={has.breakdown.mode} />; no{" "}
          {SIDE_LABEL[other]} model scores {t} or more.
        </>
      ),
    };
  }
  const mark = (s: Side) => (a.pricier === null ? null : a.pricier === s ? <Pricier /> : <Cheaper />);
  const ratio = a.ratio!;
  const verdict =
    a.pricier === null ? "Both cost the same." : `The ${SIDE_LABEL[a.pricier]} answer costs ${fmtRatio(ratio)}× as much.`;
  const text = `Cheapest scoring at least ${t}: open-weight ${a.open.model.displayName} at ${fmtUsd(a.open.per1k)} per 1K requests; closed ${a.closed.model.displayName} at ${fmtUsd(a.closed.per1k)}. ${verdict}`;
  return {
    figure: a.pricier === null ? "×1.0" : `×${fmtRatio(ratio)}`,
    unit: a.pricier === null ? "same cost" : a.pricier === "open" ? "open-weight" : "closed",
    text,
    node: (
      <>
        Cheapest scoring at least <strong className="mono">{t}</strong>: open-weight {mark("open")}
        <strong>{a.open.model.displayName}</strong> at <strong className="mono">{fmtUsd(a.open.per1k)}</strong> per 1K requests{" "}
        <SourceTag model={a.open.model} mode={a.open.breakdown.mode} />
        <FallbackMark breakdown={a.open.breakdown} />; closed {mark("closed")}
        <strong>{a.closed.model.displayName}</strong> at <strong className="mono">{fmtUsd(a.closed.per1k)}</strong>{" "}
        <SourceTag model={a.closed.model} mode={a.closed.breakdown.mode} />
        <FallbackMark breakdown={a.closed.breakdown} />. {verdict}
      </>
    ),
  };
}

function readZone(zone: ReturnType<typeof oneSideZone>, plotted: Record<Side, Priced[]>, index: Index, cant: string | null): ReadingOut {
  if (cant) return plain(cant);
  if (!zone) {
    const text = "Both sides' best models score the same: no score is reached by one side only.";
    return { figure: "0", unit: "models", node: text, text };
  }
  const above = plotted[zone.side].filter((p) => scoreOf(p.model, index)! > zone.from).sort((a, b) => a.cost - b.cost);
  const lo = above[0];
  const hi = above[above.length - 1];
  const who = zone.side === "closed" ? "closed" : "open-weight";
  const same = lo.per1k.eq(hi.per1k);
  const range = same ? `at ${fmtUsd(lo.per1k)}` : `from ${fmtUsd(lo.per1k)} to ${fmtUsd(hi.per1k)}`;
  const text = `Above ${fmtScore(zone.from)} every model is ${who}: ${zone.count} of them, ${range} per 1K requests.`;
  return {
    figure: String(zone.count),
    unit: zone.count === 1 ? "model" : "models",
    text,
    node: (
      <>
        Above <strong className="mono">{fmtScore(zone.from)}</strong> every model is {who}: <span className="mono">{zone.count}</span> of them,{" "}
        {same ? (
          <>
            at <span className="mono">{fmtUsd(lo.per1k)}</span>
          </>
        ) : (
          <>
            from <span className="mono">{fmtUsd(lo.per1k)}</span> to <span className="mono">{fmtUsd(hi.per1k)}</span>
          </>
        )}{" "}
        per 1K requests.
      </>
    ),
  };
}

function readLag(lag: HeadlineLag | null, cant: string | null): ReadingOut {
  if (cant) return plain(cant);
  if (!lag) return plain("Listing dates are missing for the models that would answer this.");
  const s = fmtScore(lag.score);
  const days = `${lag.days} ${lag.days === 1 ? "day" : "days"}`;
  const tail = " These are listing dates, not release dates (see §C).";
  if (lag.openFirst) {
    const text = `Open-weight models reached ${s} first, with ${lag.from.model.displayName}, listed on OpenRouter ${days} before any closed model (${lag.to.model.displayName}).${tail}`;
    return {
      figure: String(lag.days),
      unit: `${lag.days === 1 ? "day" : "days"}, open first`,
      text,
      node: (
        <>
          Open-weight models reached <strong className="mono">{s}</strong> first, with <strong>{lag.from.model.displayName}</strong>, listed on
          OpenRouter <span className="mono">{days}</span> before any closed model ({lag.to.model.displayName}).{tail}
        </>
      ),
    };
  }
  const text = `Closed models first reached ${s} with ${lag.from.model.displayName}, listed on OpenRouter ${days} before ${lag.to.model.displayName}.${tail}`;
  return {
    figure: String(lag.days),
    unit: lag.days === 1 ? "day" : "days",
    text,
    node: (
      <>
        Closed models first reached <strong className="mono">{s}</strong> with <strong>{lag.from.model.displayName}</strong>, listed on
        OpenRouter <span className="mono">{days}</span> before <strong>{lag.to.model.displayName}</strong>.{tail}
      </>
    ),
  };
}

// ---------------------------------------------------------------- parity table

function pricierText(r: ParityRow): string {
  if (!r.open && !r.closed) return "—";
  if (!r.open) return "closed only";
  if (!r.closed) return "open only";
  if (r.pricier === null) return "same cost";
  return `${r.pricier === "open" ? "open" : "closed"} ×${fmtRatio(r.ratio!)}`;
}

function ParityTr({ r, index, isTarget, cachedPct }: { r: ParityRow; index: Index; isTarget: boolean; cachedPct: number }) {
  const cheaper: Side | null = r.pricier === "closed" ? "open" : r.pricier === "open" ? "closed" : null;
  const name = (p: Priced | null) =>
    p ? (
      <>
        <span className="nm">{p.model.displayName}</span>
        <span className="vd">
          AA {fmtScore(scoreOf(p.model, index)!)} <SourceTag model={p.model} mode={p.breakdown.mode} />
        </span>
      </>
    ) : (
      <span className="na">—</span>
    );
  const cost = (p: Priced | null, side: Side) =>
    p ? (
      <>
        {cheaper === side && <Cheaper />}
        {fmtUsd(p.per1k)}
        {cachedPct > 0 && p.breakdown.notes.includes("no-cache-price") && (
          <span className="cell-mark" title="No cache-read price published: cached share billed as input">
            no cache price
          </span>
        )}
        <FallbackMark breakdown={p.breakdown} />
      </>
    ) : (
      <span className="na">—</span>
    );
  return (
    <tr className={isTarget ? "oc-target-row" : undefined}>
      <td className="n">
        {fmtTarget(r.threshold)}
        {isTarget && <span className="oc-tag">target</span>}
        <span className="oc-m-only oc-m-ratio">{pricierText(r)}</span>
      </td>
      <td>
        {name(r.open)}
        {r.open && <span className="oc-m-only oc-m-cost mono">{cost(r.open, "open")}</span>}
      </td>
      <td className="n oc-col-cost">{cost(r.open, "open")}</td>
      <td>
        {name(r.closed)}
        {r.closed && <span className="oc-m-only oc-m-cost mono">{cost(r.closed, "closed")}</span>}
      </td>
      <td className="n oc-col-cost">{cost(r.closed, "closed")}</td>
      <td className="mono oc-col-ratio oc-small">{pricierText(r)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------- target field

/**
 * "AA ≥" in half points: NumberField takes whole numbers only, so this keeps
 * its own text, accepts one decimal, and steps by 0.5 with the buttons or ↑/↓.
 */
function TargetField({ label, value, onChange, onStep }: { label: string; value: number; onChange: (v: number) => void; onStep: (d: number) => void }) {
  const [text, setText] = useState(value.toFixed(1));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(value.toFixed(1));
  }
  return (
    <div className="inp oc-target">
      <label className="il" htmlFor="oc-target">
        Target · AA {label} ≥
      </label>
      <span className="inp-row">
        <button type="button" className="oc-step" aria-label="Lower the target by half a point" onClick={() => onStep(-0.5)}>
          −
        </button>
        <input
          id="oc-target"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            if (/^\d+(\.\d+)?$/.test(raw.trim())) {
              const n = roundTarget(Number(raw));
              setShown(n);
              onChange(n);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") onStep(0.5);
            else if (e.key === "ArrowDown") onStep(-0.5);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setText(value.toFixed(1))}
        />
        <button type="button" className="oc-step" aria-label="Raise the target by half a point" onClick={() => onStep(0.5)}>
          +
        </button>
      </span>
    </div>
  );
}
