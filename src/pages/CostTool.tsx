import type Big from "big.js";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import {
  CopyButton,
  FallbackMark,
  Mark,
  Meter,
  NotRated,
  RetireTag,
  SourceTag,
  WorkloadPanel,
  workloadLine,
} from "../components.tsx";
import { allModels, CATALOG_META, modelByKey } from "../core/catalog.ts";
import { costFor, NOTE_TEXT, type Rate, type Workload } from "../core/cost.ts";
import { changesFor, relChange, type Change } from "../core/changes.ts";
import { daysBetween, daysLabel, todayIso } from "../core/date.ts";
import { fmtCompact, fmtMoney, fmtRate, fmtUsd } from "../core/fmt.ts";
import {
  alternatives,
  dominatedBy,
  FILTER_LABEL,
  INDEX_LABEL,
  passesFilters,
  priceAll,
  scoreOf,
  type Filter,
  type Index,
  type Priced,
} from "../core/frontier.ts";
import { compareReleased, inputModalities, rateCard, yearMonth, type Model, type RateMode } from "../core/model.ts";
import { DEFAULT_PRESET, matchingPreset, type PresetId } from "../core/presets.ts";
import { availableYears, search } from "../core/query.ts";
import {
  decodeScenario,
  encodeFrontier,
  encodeKey,
  encodeScenario,
  hasScenario,
  MAX_BENCH,
  type Scenario,
} from "../core/share.ts";
import { titleFor } from "../routes.ts";

const MODELS = allModels();
const YEARS = availableYears(MODELS);
const STORAGE_KEY = "lmo:bench:v1";
/** The snapshot date the remembered bench was last priced at, for "since you last looked". */
const ASOF_KEY = "lmo:bench-asof:v1";

function readAsOf(): string | null {
  try {
    return localStorage.getItem(ASOF_KEY);
  } catch {
    return null;
  }
}
const VENDOR_CHIPS = 10;

type SortKey = "relevance" | "newest" | "cost" | "score" | "context";
const SORT_LABEL: Record<SortKey, string> = {
  relevance: "Relevance",
  newest: "Newest listings",
  cost: "Your cost",
  score: "Score",
  context: "Context",
};

const FILTER_TITLE: Partial<Record<Filter, string>> = {
  fits: "Context window fits input + output, and max output fits output",
  open: "Open-weight: OpenRouter (or our hand-checked list) links a Hugging Face repo we could open; repos we couldn't open are left out",
};

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(ASOF_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, value);
      localStorage.setItem(ASOF_KEY, CATALOG_META.asOf);
    }
  } catch {
    // Storage blocked or full: the page works the same without it.
  }
}

interface Initial {
  scenario: Scenario;
  source: "url" | "storage" | "default";
}

/** The URL wins; otherwise the remembered bench; otherwise the default preset. */
function initialScenario(params: URLSearchParams): Initial {
  if (hasScenario(params)) return { scenario: decodeScenario(params), source: "url" };
  const stored = readStorage();
  if (stored) {
    const s = decodeScenario(new URLSearchParams(stored));
    if (s.models.length) return { scenario: s, source: "storage" };
  }
  return { scenario: decodeScenario(new URLSearchParams(`p=${DEFAULT_PRESET.id}`)), source: "default" };
}

export function CostTool() {
  const [params] = useSearchParams();
  const location = useLocation();
  // Links inside the site pass { internal: true }, so only real shared links count.
  const [internalArrival] = useState(() => Boolean((location.state as { internal?: boolean } | null)?.internal));
  const navigate = useNavigate();
  const { pathname } = location;
  const [init] = useState(() => initialScenario(params));
  const today = todayIso();

  const [missing, setMissing] = useState(() => init.scenario.models.filter((k) => !modelByKey(k)));
  const [bench, setBench] = useState<string[]>(() => init.scenario.models.filter((k) => modelByKey(k)));
  const [restored, setRestored] = useState(init.source === "storage");
  const [workload, setWorkload] = useState<Workload>(init.scenario.workload);
  const [rate, setRate] = useState<Rate>(init.scenario.rate);
  const [preset, setPreset] = useState<PresetId | null>(
    () => init.scenario.preset ?? matchingPreset(init.scenario.workload, init.scenario.rate)?.id ?? DEFAULT_PRESET.id,
  );
  const [modes, setModes] = useState<Map<string, RateMode>>(init.scenario.modes);
  const [index, setIndex] = useState<Index>(init.scenario.index);

  const [queryText, setQueryText] = useState("");
  const [vendors, setVendors] = useState<string[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey | null>(null);
  const [filters, setFilters] = useState<Set<Filter>>(new Set());
  const [hideDominated, setHideDominated] = useState(false);
  const [allVendors, setAllVendors] = useState(false);

  // "Since you last looked": a remembered bench priced at an older snapshot
  // gets a strip of what changed for its models. The tape loads on demand.
  const [lastAsOf] = useState(() => (init.source === "storage" ? readAsOf() : null));
  const [since, setSince] = useState<Change[] | null>(null);
  // Models still on the bench, plus delisted ones from the link (they left the
  // bench at load, but their delisting is exactly what changed).
  const sinceOnBench = (since ?? []).filter((c) => bench.includes(c.key) || missing.includes(c.key));
  useEffect(() => {
    if (!lastAsOf || lastAsOf >= CATALOG_META.asOf) return;
    let live = true;
    import("../tape.ts").then(({ TAPE }) => {
      if (!live) return;
      const found = changesFor(TAPE, new Set(init.scenario.models), lastAsOf);
      setSince(found);
      if (found.length) trackEvent("Bench", "Repriced strip shown");
    });
    return () => {
      live = false;
    };
  }, [lastAsOf, init]);
  // Pricing the bench at today's snapshot counts as having looked.
  useEffect(() => {
    if (lastAsOf && lastAsOf < CATALOG_META.asOf && init.source === "storage") {
      try {
        localStorage.setItem(ASOF_KEY, CATALOG_META.asOf);
      } catch {
        // Not remembered; the strip shows again next time.
      }
    }
  }, [lastAsOf, init]);

  useEffect(() => {
    if (init.source === "url" && init.scenario.models.length && !internalArrival) trackEvent("Share", "Opened shared link");
    if (init.source === "storage") trackEvent("Bench", "Restored");
  }, [init, internalArrival]);

  const encoded = encodeScenario({ models: bench, preset, workload, rate, modes, index });

  // Keep the URL and the remembered bench in step, debounced. A first visit
  // that hasn't changed anything keeps its clean URL.
  const synced = useRef(init.source === "default" ? encoded : "");
  // A bench opened from a link (shared, or "+ Bench" elsewhere on the site)
  // isn't "yours" until you edit the bench itself — adding, removing,
  // pinning a price list or clearing. Until then, tweaking the workload on it
  // must not replace or delete the bench remembered from your last visit.
  const benchEdited = useRef(init.source !== "url");
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      // Navigate with the raw string (URLSearchParams would percent-encode ":"
      // and ","), carrying the internal-arrival marker so Back/Forward to this
      // entry still isn't counted as a shared link.
      navigate(
        { pathname, search: encoded ? `?${encoded}` : "" },
        // Any arrival was counted once on mount; the calculator's own URL
        // updates are never a new shared-link arrival (Back to them included).
        { replace: true, state: { internal: true } },
      );
      if (benchEdited.current) writeStorage(bench.length ? encoded : null);
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, bench.length, navigate, pathname]);

  const shareUrl = () => `${window.location.origin}/tools/cost?${encoded}`;

  // ---- pricing ----
  const priced = useMemo(() => priceAll(MODELS, workload, rate, today, modes), [workload, rate, today, modes]);
  const byKey = useMemo(() => new Map(priced.map((p) => [p.model.key, p])), [priced]);

  const pool = useMemo(() => {
    const f = new Set(filters);
    if (hideDominated) f.add("scored");
    return priced.filter((p) => passesFilters(p.model, f, workload, index));
  }, [priced, filters, hideDominated, workload, index]);
  const allowed = useMemo(() => {
    const keep = hideDominated ? pool.filter((p) => !dominatedBy(p, pool, index)) : pool;
    return new Set(keep.map((p) => p.model.key));
  }, [pool, hideDominated, index]);

  const activeSort: SortKey = sort ?? (queryText.trim() ? "relevance" : "newest");
  const compare = useMemo((): ((a: Model, b: Model) => number) | undefined => {
    const cost = (m: Model) => byKey.get(m.key)!.cost;
    switch (activeSort) {
      case "cost":
        return (a, b) => cost(a) - cost(b);
      case "score":
        return (a, b) => (scoreOf(b, index) ?? -1) - (scoreOf(a, index) ?? -1);
      case "context":
        return (a, b) => b.contextTokens - a.contextTokens;
      case "newest":
        return (a, b) => compareReleased(b.released, a.released);
      default:
        return undefined;
    }
  }, [activeSort, byKey, index]);

  const results = useMemo(
    () =>
      search(MODELS, {
        text: queryText,
        vendors,
        releasedYear: year,
        limit: 25,
        filter: (m) => allowed.has(m.key),
        compare,
      }),
    [queryText, vendors, year, allowed, compare],
  );

  const benchRows = useMemo(
    () =>
      bench
        .map((k) => byKey.get(k))
        .filter((p): p is Priced => p !== undefined)
        .sort((a, b) => a.per1k.cmp(b.per1k)),
    [bench, byKey],
  );
  const cheapest = benchRows[0]?.breakdown.monthlyCost ?? null;

  // ---- actions ----
  const benchHeading = useRef<HTMLHeadingElement>(null);
  const toggleBench = (key: string, action = "Add") => {
    benchEdited.current = true;
    if (bench.includes(key)) {
      const next = bench.filter((k) => k !== key);
      setBench(next);
      // A pin on a model that's no longer benched would still re-price it in the market.
      setModes((prev) => {
        if (!prev.has(key)) return prev;
        const n = new Map(prev);
        n.delete(key);
        return n;
      });
      return next;
    }
    if (bench.length >= MAX_BENCH) return bench;
    trackEvent("Bench", action, key);
    setBench([...bench, key]);
    return [...bench, key];
  };
  /** Remove from a bench card, then keep keyboard focus somewhere sensible. */
  const removeCard = (key: string) => {
    const order = benchRows.map((p) => p.model.key);
    const i = order.indexOf(key);
    const next = toggleBench(key);
    const target = order.filter((k) => k !== key)[Math.min(i, next.length - 1)];
    requestAnimationFrame(() => {
      const el = target
        ? document.querySelector<HTMLElement>(`[data-card="${CSS.escape(target)}"] .rm`)
        : benchHeading.current;
      el?.focus();
    });
  };
  const setMode = (key: string, mode: RateMode | null) => {
    benchEdited.current = true;
    if (mode === "Fast") trackEvent("Mode", "Fast", key);
    setModes((prev) => {
      const next = new Map(prev);
      if (mode) next.set(key, mode);
      else next.delete(key);
      return next;
    });
  };
  const toggleFilter = (f: Filter) => {
    trackEvent("Table", "Filter", f);
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };
  const sortBy = (s: SortKey) => {
    trackEvent("Table", "Sort", s);
    setSort(s);
  };
  const clearBench = () => {
    benchEdited.current = true;
    setSince(null);
    setBench([]);
    setModes(new Map());
    setRestored(false);
    setMissing([]);
    requestAnimationFrame(() => benchHeading.current?.focus());
  };

  const markdown = () => {
    const rows = benchRows.map((p) => {
      const d =
        cheapest !== null && !p.breakdown.monthlyCost.eq(cheapest)
          ? `+${fmtMoney(p.breakdown.monthlyCost.minus(cheapest))}`
          : "cheapest";
      const mode = p.breakdown.mode === "Standard" ? "" : ` (${p.breakdown.mode})`;
      const src = rateCard(p.model, p.breakdown.mode)?.checked ? "vendor list" : "via OpenRouter";
      return `| ${p.model.displayName}${mode} | ${fmtMoney(p.breakdown.monthlyCost)} | ${fmtUsd(p.per1k)} | ${d} | ${src} |`;
    });
    return [
      "| Model | $/mo | $/1K req | vs cheapest | price source |",
      "|---|---:|---:|---:|---|",
      ...rows,
      "",
      `Workload: ${workloadLine(workload, rate, true)}`,
      `Prices as of ${CATALOG_META.asOf} · list-price cost at this workload, not cost per task · LMOmnibus`,
      shareUrl(),
    ].join("\n");
  };

  const visibleVendors = allVendors ? results.vendorCounts : results.vendorCounts.slice(0, VENDOR_CHIPS);
  const scoreLabel = INDEX_LABEL[index];
  // This workload, index and capability filters on the open-vs-closed tool, which takes neither "open" nor "scored".
  const openHref = `/tools/open?${encodeFrontier({
    preset,
    workload,
    rate,
    index,
    minScore: null,
    filters: new Set([...filters].filter((f) => f !== "open" && f !== "scored")),
  })}`;

  return (
    <>
      <title>{titleFor("/tools/cost")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 01</span>
        <h1>Cost Calculator</h1>
        <p className="sub">
          Pick a workload, then rank every model by what it would actually cost you — cache reads and writes, Batch
          and long-context tiers included.
        </p>
      </div>

      <section className="section" aria-labelledby="workload-h">
        <div className="section-title">
          <h2 id="workload-h">Workload</h2>
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

      <section className="section" aria-labelledby="market-h">
        <div className="section-title">
          <h2 id="market-h">Market, priced at your workload</h2>
          <span className="count" role="status" aria-live="polite">
            {results.totalMatching} match{results.totalMatching === 1 ? "" : "es"}
            {results.totalMatching > results.hits.length ? ` · top ${results.hits.length} shown` : ""}
          </span>
        </div>

        <div className="searchfield">
          <input
            type="search"
            aria-label="Search models"
            placeholder={'Search by model or vendor — try "opus", "gemini flash" or "qwen coder"'}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
          />
        </div>

        <div className="filters-row">
          <div className="filter-group">
            <label className="filter-label" htmlFor="listed-year" title="Year the model appeared on OpenRouter">
              Listed
            </label>
            <select
              id="listed-year"
              value={year ?? ""}
              onChange={(e) => setYear(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">Any year</option>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-group">
            <label className="filter-label" htmlFor="sort-by">
              Sort
            </label>
            <select id="sort-by" value={activeSort} onChange={(e) => sortBy(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((s) => (
                <option key={s} value={s}>
                  {s === "score" ? `AA ${scoreLabel}` : SORT_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-group">
            <label className="filter-label" htmlFor="score-index">
              Score
            </label>
            <select id="score-index" value={index} onChange={(e) => setIndex(e.target.value as Index)}>
              {(Object.keys(INDEX_LABEL) as Index[]).map((i) => (
                <option key={i} value={i}>
                  AA {INDEX_LABEL[i]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="chips" role="group" aria-label="Capability filters">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <Fragment key={f}>
              <button
                type="button"
                className={`chip${filters.has(f) ? " on" : ""}`}
                aria-pressed={filters.has(f)}
                onClick={() => toggleFilter(f)}
                title={FILTER_TITLE[f]}
              >
                {FILTER_LABEL[f]}
              </button>
              {f === "open" && (
                <Link
                  className="text-btn chip-link"
                  to={openHref}
                  state={{ internal: true }}
                  onClick={() => trackEvent("Table", "To open vs closed")}
                >
                  Open vs closed
                  <Mark kind="to" />
                </Link>
              )}
            </Fragment>
          ))}
          <button
            type="button"
            className={`chip${hideDominated ? " on" : ""}`}
            aria-pressed={hideDominated}
            onClick={() => {
              trackEvent("Table", "Filter", "hide-dominated");
              setHideDominated((v) => !v);
            }}
            title={`Hide models another model beats on AA ${scoreLabel} for no more money at this workload (scored models only)`}
          >
            Hide dominated
          </button>
        </div>

        <div className="chips vendor-chips" role="group" aria-label="Vendors">
          {visibleVendors.map(({ vendorKey, vendorName, count }) => {
            const on = vendors.includes(vendorKey);
            return (
              <button
                key={`${vendorKey}/${vendorName}`}
                type="button"
                className={on ? "chip on" : "chip"}
                aria-pressed={on}
                onClick={() =>
                  setVendors((v) => (v.includes(vendorKey) ? v.filter((x) => x !== vendorKey) : [...v, vendorKey]))
                }
              >
                {`${vendorName} ${count}`}
              </button>
            );
          })}
          {results.vendorCounts.length > VENDOR_CHIPS && (
            <button type="button" className="text-btn" aria-expanded={allVendors} onClick={() => setAllVendors((v) => !v)}>
              {allVendors ? "Fewer vendors" : `All vendors (${results.vendorCounts.length})`}
            </button>
          )}
        </div>

        <MarketTable
          today={today}
          hits={results.hits}
          byKey={byKey}
          bench={bench}
          index={index}
          workload={workload}
          sort={activeSort}
          onSort={sortBy}
          onToggle={(k) => toggleBench(k)}
          benchFull={bench.length >= MAX_BENCH}
        />
        {bench.length >= MAX_BENCH && (
          <p className="quiet-note" id="bench-full-note">
            Bench full ({MAX_BENCH} max) — remove a model to add another.
          </p>
        )}
        <p className="fine">
          Flags are unions across providers: T tools · R reasoning (R+ always reasons, so expect extra output) · S
          structured output · img / aud image / audio input · open open-weight: a Hugging Face repo we could open (hover
          for its licence). “via OR” prices are OpenRouter aggregates; “list” prices are checked against the vendor.
          Open-weight prices are mostly OpenRouter's listing, often the cheapest of several providers; others can charge
          more.
        </p>
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="bench-h">
        <div className="section-title bench-head">
          <h2 id="bench-h" ref={benchHeading} tabIndex={-1}>
            Bench ({bench.length})
          </h2>
          {bench.length > 0 && (
            <div className="bench-actions">
              <CopyButton
                label="Copy link"
                getText={shareUrl}
                share={{ title: "LMOmnibus cost comparison", url: shareUrl }}
                onCopied={(how) => trackEvent("Share", how === "share" ? "Native share" : "Copy link")}
              />
              <CopyButton label="Copy as Markdown" getText={markdown} onCopied={() => trackEvent("Share", "Copy markdown")} />
              <button type="button" className="text-btn danger" onClick={clearBench}>
                Clear bench
              </button>
            </div>
          )}
        </div>

        {sinceOnBench.length > 0 && (
          <div className="since-strip" role="status">
            <strong>Since you last looked</strong> ({lastAsOf} to {CATALOG_META.asOf}):
            <ul>
              {sinceOnBench.map((c, i) => (
                <li key={`${c.key}-${c.kind}-${i}`}>{describeChange(c)}</li>
              ))}
            </ul>
          </div>
        )}
        {restored && bench.length > 0 && (
          <p className="quiet-note">
            Restored your last bench ·{" "}
            <button type="button" className="text-btn" onClick={clearBench}>
              Clear
            </button>
          </p>
        )}
        {missing.length > 0 && (
          <p className="quiet-note">
            {missing.length} model{missing.length === 1 ? " in this link is" : "s in this link are"} no longer listed:{" "}
            <span className="mono">{missing.join(", ")}</span>
          </p>
        )}

        {bench.length === 0 ? (
          <div className="empty-bench">Add models from the market above (+) to compare them side by side.</div>
        ) : (
          <>
            <p className="stamp-strip">
              {workloadLine(workload, rate, true)} · prices as of {CATALOG_META.asOf} · lmomnibus.pages.dev
            </p>
            <div className="bench-grid">
              {benchRows.map((p) => (
                <BenchCard
                  key={p.model.key}
                  point={p}
                  cheapest={cheapest}
                  pool={pool}
                  index={index}
                  workload={workload}
                  rate={rate}
                  onMode={(m) => setMode(p.model.key, m)}
                  onRemove={() => removeCard(p.model.key)}
                  onAdd={(k) => toggleBench(k, "Alternative added")}
                  benched={bench}
                  benchFull={bench.length >= MAX_BENCH}
                  today={today}
                  scenarioQuery={encodeScenario({ models: [], preset, workload, rate, modes: new Map(), index })}
                />
              ))}
            </div>
            <p className="fine">
              Verdicts compare list-price cost at this workload on one Artificial Analysis index, among models with the
              same tools, image-input and reasoning support that fit the request — not cost per task.
            </p>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

interface MarketTableProps {
  today: string;
  hits: Model[];
  byKey: Map<string, Priced>;
  bench: string[];
  index: Index;
  workload: Workload;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  onToggle: (key: string) => void;
  benchFull: boolean;
}

const SHORT_INDEX: Record<Index, string> = { intelligence: "Intel", coding: "Coding", agentic: "Agentic" };

function flags(m: Model): string {
  const inputs = inputModalities(m);
  return [
    m.capabilities.tools && "T",
    m.capabilities.reasoning && (m.reasoningMandatory ? "R+" : "R"),
    m.capabilities.structuredOutput && "S",
    inputs.includes("image") && "img",
    inputs.includes("audio") && "aud",
  ]
    .filter(Boolean)
    .join(" ");
}

function MarketTable({ today, hits, byKey, bench, index, workload, sort, onSort, onToggle, benchFull }: MarketTableProps) {
  const th = (s: SortKey | null, label: string, className: string) => {
    if (!s) return <th className={className}>{label}</th>;
    const active = sort === s;
    const dir = s === "cost" ? "ascending" : "descending";
    return (
      <th className={className} aria-sort={active ? dir : "none"}>
        <button type="button" className={`th-sort${active ? " on" : ""}`} onClick={() => onSort(s)}>
          {label}
          <span aria-hidden="true">{active ? (dir === "ascending" ? " ↑" : " ↓") : ""}</span>
        </button>
      </th>
    );
  };

  return (
    <div className="table-frame">
      <table className="market">
        <thead>
          <tr>
            {th(null, "Model", "col-model")}
            {th("context", "Ctx", "n col-ctx")}
            {th(null, "Flags", "col-flags")}
            {th("score", `AA ${SHORT_INDEX[index]}`, "n col-score")}
            {th("cost", "$ / 1K req", "n col-cost")}
            {th(null, "In /MTok", "n col-rate")}
            {th(null, "Out /MTok", "n col-rate")}
            <th className="col-add">
              <span className="sr-only">Bench</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {hits.map((model) => {
            const p = byKey.get(model.key)!;
            const b = p.breakdown;
            const card = rateCard(model, b.mode)!;
            const benched = bench.includes(model.key);
            const score = scoreOf(model, index);
            const fl = flags(model);
            return (
              <tr key={model.key} className={benched ? "benched" : undefined}>
                <td className="col-model">
                  <Link className="nm row-link" to={`/models/${model.key}`} state={{ internal: true }}>
                    {model.displayName}
                  </Link>
                  <span className="vd">
                    {model.vendorName} · {yearMonth(model.released)} <SourceTag model={model} mode={b.mode} />
                    {b.mode !== "Standard" && <span className="mode-tag">{b.mode.toLowerCase()}</span>}
                    <RetireTag model={model} today={today} />
                  </span>
                </td>
                <td className="n col-ctx">{fmtCompact(model.contextTokens)}</td>
                <td className="col-flags" title="Flags are unions across providers">
                  {fl}
                  {model.openWeights && (
                    <>
                      {fl ? " " : ""}
                      <span title={`open · ${model.weights?.licenceLabel ?? "licence not read"}`}>open</span>
                    </>
                  )}
                </td>
                <td className="n col-score">{score === null ? <NotRated /> : score.toFixed(1)}</td>
                <td className={`n col-cost${b.tierCrossed ? " up" : ""}`}>
                  {fmtUsd(p.per1k)}
                  {b.tierCrossed && (
                    <span className="cell-mark" title={NOTE_TEXT["tier-crossed"]}>
                      tier
                    </span>
                  )}
                  <FallbackMark breakdown={b} />
                  {b.notes.includes("no-cache-price") && (
                    <span className="cell-mark" title={NOTE_TEXT["no-cache-price"]}>
                      no cache rate
                    </span>
                  )}
                </td>
                <td className="n col-rate">{fmtRate(card.input)}</td>
                <td className="n col-rate">{fmtRate(card.output)}</td>
                <td className="col-add">
                  <button
                    type="button"
                    className={`add${benched ? " on" : ""}`}
                    aria-label={`${benched ? "Remove" : "Add"} ${model.displayName} ${benched ? "from" : "to"} bench`}
                    disabled={!benched && benchFull}
                    title={!benched && benchFull ? "Bench full: remove a model to add another" : undefined}
                    aria-describedby={!benched && benchFull ? "bench-full-note" : undefined}
                    onClick={() => onToggle(model.key)}
                  >
                    {benched ? <Mark kind="check" /> : "+"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {hits.length === 0 && (
        <div className="empty-note">
          No models match. Try a different name or vendor, or clear a filter
          {workload.inputTokens + workload.outputTokens > 1_000_000 ? " — few models fit more than 1M tokens" : ""}.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BenchCardProps {
  point: Priced;
  cheapest: Big | null;
  pool: Priced[];
  index: Index;
  workload: Workload;
  rate: Rate;
  onMode: (mode: RateMode | null) => void;
  onRemove: () => void;
  onAdd: (key: string) => void;
  benched: string[];
  benchFull: boolean;
  today: string;
  /** The bench's workload as URL params, so "Plan a switch" keeps it. */
  scenarioQuery: string;
}

const BREAKDOWN: { name: string; cls: string; pick: (p: Priced) => Big }[] = [
  { name: "fresh input", cls: "seg-input", pick: (p) => p.breakdown.inputCost },
  { name: "cache write", cls: "seg-write", pick: (p) => p.breakdown.cacheWriteCost },
  { name: "cache read", cls: "seg-read", pick: (p) => p.breakdown.cacheReadCost },
  { name: "output", cls: "seg-output", pick: (p) => p.breakdown.outputCost },
];

function BenchCard(props: BenchCardProps) {
  const { point, cheapest, pool, index, workload, rate, onMode, onRemove, onAdd, benched, benchFull, today, scenarioQuery } = props;
  const { model, breakdown: b } = point;
  const isCheapest = cheapest !== null && b.monthlyCost.eq(cheapest);
  const card = rateCard(model, b.mode)!;
  const modes = model.rates.map(([m]) => m);
  const defaultMode: RateMode =
    rate === "Batch" && modes.includes("Batch") ? "Batch" : modes.includes("Standard") ? "Standard" : modes[0];
  const std = rateCard(model, "Standard");
  const total = Number(b.monthlyCost);
  const parts = BREAKDOWN.map((s) => ({ ...s, value: s.pick(point) })).filter((s) => !s.value.eq(0));
  const alts = alternatives(point, pool, index, workload);
  const score = scoreOf(model, index);
  const label = INDEX_LABEL[index];

  return (
    <article className={`bench-card${isCheapest ? " best" : ""}`} aria-label={model.displayName} data-card={model.key}>
      <button className="rm" aria-label={`Remove ${model.displayName} from bench`} onClick={onRemove}>
        ×
      </button>
      <div className="bn">
        <Link className="row-link inline" to={`/models/${model.key}`} state={{ internal: true }}>
          {model.displayName}
        </Link>
      </div>
      <div className="bv">
        {model.vendorName} · listed {yearMonth(model.released)}
        {model.knowledgeCutoff ? ` · cutoff ${model.knowledgeCutoff.slice(0, 7)}` : ""} <SourceTag model={model} mode={b.mode} />
      </div>
      {model.retiresOn && daysBetween(today, model.retiresOn) >= 0 && (
        <div className="retire-line">
          Retires {model.retiresOn} ({daysLabel(daysBetween(today, model.retiresOn))}) ·{" "}
          <Link to={`/tools/switch?from=${encodeKey(model.key)}&${scenarioQuery}`} state={{ internal: true }}>
            Plan a switch
            <Mark kind="to" />
          </Link>
        </div>
      )}

      {modes.length > 1 && (
        <div className="seg seg-small" role="group" aria-label={`Price list for ${model.displayName}`}>
          {modes.map((m) => {
            // Relative to Standard at this workload, not by input price alone:
            // aggregate cards can skew input and output in opposite directions.
            const here = m === "Standard" || !std ? null : costFor(model, workload, m, today);
            const base = std ? costFor(model, workload, "Standard", today) : null;
            const rel = here && base && base.per1k.gt(0) ? Math.round((Number(here.per1k) / Number(base.per1k) - 1) * 100) : 0;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={b.mode === m}
                className={b.mode === m ? "on" : ""}
                onClick={() => onMode(m === defaultMode ? null : m)}
              >
                {m}
                {rel !== 0 && <span className="rel">{rel > 0 ? ` +${rel}%` : ` −${-rel}%`}</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="figure-big">
        {fmtMoney(b.monthlyCost)}
        <span className="figure-unit">/mo</span>
      </div>
      <div className="delta muted">
        {fmtUsd(b.perRequest)} / request · {fmtUsd(b.per1k)} / 1K
      </div>
      {isCheapest ? (
        <div className="delta down">
          <Mark kind="best" /> cheapest on bench
        </div>
      ) : cheapest !== null ? (
        <div className="delta up">
          <Mark kind="up" /> {fmtMoney(b.monthlyCost.minus(cheapest))} vs cheapest
        </div>
      ) : null}

      {total > 0 && (
        <div className="breakdown">
          <div className="breakdown-bar" aria-hidden="true">
            {parts.map((s) => (
              <span key={s.name} className={s.cls} style={{ width: `${(Number(s.value) / total) * 100}%` }} />
            ))}
          </div>
          <dl className="breakdown-legend">
            {parts.map((s) => (
              <div key={s.name}>
                <dt>
                  <span className={`swatch ${s.cls}`} aria-hidden="true" />
                  {s.name}
                </dt>
                <dd>{fmtUsd(s.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="verdict">
        {score === null ? (
          <p className="verdict-line muted">Not rated on AA {label}: no verdict.</p>
        ) : alts.length === 0 ? (
          <p className="verdict-line down">
            <Mark kind="best" /> Nothing cheaper scores as high on AA {label} with the same capabilities.
          </p>
        ) : (
          <>
            <p className="verdict-line">Cheaper, scoring at least as high on AA {label}:</p>
            <ul className="alt-list">
              {alts.map((a) => {
                const save = b.monthlyCost.minus(a.breakdown.monthlyCost);
                const pct = total > 0 ? Math.round((Number(save) / total) * 100) : 0;
                return (
                  <li key={a.model.key}>
                    <span className="alt-name">{a.model.displayName}</span> saves{" "}
                    <span className="mono">
                      {fmtMoney(save)}/mo (−{pct}%)
                    </span>{" "}
                    <SourceTag model={a.model} mode={a.breakdown.mode} />
                    {!benched.includes(a.model.key) && !benchFull && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="text-btn"
                          aria-label={`Add ${a.model.displayName} to bench`}
                          onClick={() => onAdd(a.model.key)}
                        >
                          + bench
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {(b.notes.length > 0 || b.usesPromo) && (
        <div className="card-notes">
          {b.tierCrossed && (
            <div className="card-note">{`Long-context tier: ${fmtRate(b.effectiveInputRate)} in / ${fmtRate(b.effectiveOutputRate)} out`}</div>
          )}
          {b.notes
            .filter((n) => n !== "tier-crossed")
            .map((n) => (
              <div key={n} className="card-note quiet">
                {n === "batch-unavailable" ? `No batch rate: priced at its ${b.mode} rate` : NOTE_TEXT[n]}
              </div>
            ))}
          {b.usesPromo && card.promo && (
            <div className="card-note quiet">{`Promo rate until ${card.promo.until} · list ${fmtRate(card.input)} / ${fmtRate(card.output)}`}</div>
          )}
        </div>
      )}
    </article>
  );
}

function pct(pair: [string, string] | undefined): string {
  const r = pair ? relChange(pair) : null;
  if (r === null || r === 0) return "";
  return `${r < 0 ? "−" : "+"}${Math.abs(Math.round(r * 100))}%`;
}

/** One line per change for the "since you last looked" strip. */
function describeChange(c: Change): string {
  switch (c.kind) {
    case "list_price":
      return `${c.name}: list price ${c.mode} in ${pct(c.input) || "same"}, out ${pct(c.output) || "same"}`;
    case "list_correction":
      return `${c.name}: now a hand-checked list price (in ${pct(c.input) || "same"}, out ${pct(c.output) || "same"})`;
    case "promo_permanent":
      return `${c.name}: promo price made permanent (price in force unchanged)`;
    case "promo_change":
      return `${c.name}: promo terms changed, until ${c.until}`;
    case "tier_change":
      return `${c.name}: long-context tier prices changed`;
    case "aggregate_move":
      return `${c.name}: OpenRouter aggregate price moved (in ${pct(c.input) || "same"}, out ${pct(c.output) || "same"}${c.cache_read ? `, cache read ${pct(c.cache_read)}` : ""})`;
    case "removed":
      return `${c.name}: no longer listed`;
    case "retirement_scheduled":
      return `${c.name}: retires ${c.retires_on}`;
    case "promo_start":
      return `${c.name}: promo started, until ${c.until}`;
    case "promo_end":
      return `${c.name}: promo ended`;
    case "mode_added":
      return `${c.name}: ${c.mode} price list added`;
    case "mode_removed":
      return `${c.name}: ${c.mode} price list removed`;
    default:
      return c.name;
  }
}
