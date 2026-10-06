import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { FallbackMark, Meter, SourceTag, workloadLine } from "../components.tsx";
import { BOARD_PERCENTILE, buildBoard, readings } from "../core/board.ts";
import { allModels, CATALOG_META } from "../core/catalog.ts";
import { todayIso } from "../core/date.ts";
import { fmtInt, fmtRate, fmtUsd } from "../core/fmt.ts";
import { scoreOf, type Priced } from "../core/frontier.ts";
import { rateCard } from "../core/model.ts";
import { presetById, type PresetId } from "../core/presets.ts";
import { encodeKey } from "../core/share.ts";
import { ROUTES } from "../routes.ts";
import { titleFor } from "../routes.ts";

const MODELS = allModels();
const STORAGE_KEY = "lmo:home-preset:v1";
const ORDER: PresetId[] = ["chat", "rag", "agent", "batch"];
/** Links into the tools from here are internal, not shared-link arrivals. */
const INTERNAL = { internal: true };

const QUESTIONS: Record<string, string> = {
  "/tools/cost": "What will my workload cost on each model?",
  "/tools/frontier": "What's the cheapest model that clears my bar?",
  "/tools/speed": "What does N tokens per second feel like?",
  "/changes": "What changed in model prices since I last looked?",
  "/tools/switch": "My model is retiring or too pricey — what replaces it?",
  "/tools/agent": "What does a whole agent session cost, and what does caching save?",
};

function rememberedPreset(): PresetId | null {
  try {
    return presetById(localStorage.getItem(STORAGE_KEY))?.id ?? null;
  } catch {
    return null;
  }
}

type BoardSort = "cost" | "score";

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const today = todayIso();
  const [presetId, setPresetId] = useState<PresetId>(
    () => presetById(params.get("w"))?.id ?? rememberedPreset() ?? "chat",
  );
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<BoardSort>("cost");
  const preset = presetById(presetId)!;

  const board = useMemo(() => buildBoard(MODELS, preset, today), [preset, today]);
  const lines = useMemo(() => readings(MODELS, today), [today]);

  const rows = useMemo(() => {
    const list = [...(showAll ? board.fullFrontier : board.rows)];
    return sort === "cost"
      ? list.sort((a, b) => a.cost - b.cost)
      : list.sort((a, b) => scoreOf(b.model, "intelligence")! - scoreOf(a.model, "intelligence")!);
  }, [board, showAll, sort]);

  const pick = (id: PresetId) => {
    trackEvent("Home", "Preset", id);
    setPresetId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // The board works the same without remembering.
    }
    if (params.has("w")) setParams({}, { replace: true });
  };

  // Shared log scale for the cost bars, across every row that could show.
  const costs = board.fullFrontier.map((p) => p.cost).filter((c) => c > 0);
  const lo = Math.log10(Math.min(...costs) / 1.5);
  const hi = Math.log10(Math.max(...costs) * 1.2);
  const barPct = (c: number) => Math.max(2, ((Math.log10(c) - lo) / (hi - lo)) * 100);
  const cheapestKey = rows.reduce<Priced | null>((b, p) => (!b || p.cost < b.cost ? p : b), null)?.model.key;

  return (
    <>
      <title>{titleFor("/")}</title>
      <header className="masthead">
        <h1 className="wordmark-big">
          <span className="lm">LM</span>Omnibus
        </h1>
        <p className="thesis">
          What language models cost at your workload: {fmtInt(CATALOG_META.models)} models, exact decimal math, cache
          reads and writes, Batch and long-context tiers included.
        </p>
        <p className="snapshot-line">
          Catalog snapshot {CATALOG_META.asOf} · {fmtInt(CATALOG_META.models)} models · {CATALOG_META.vendors} vendors
        </p>
      </header>

      <section className="section board" aria-labelledby="board-h">
        <div className="section-title">
          <h2 id="board-h">
            <span className="sec-num">01</span> Value board
          </h2>
        </div>

        <div
          className="seg board-tabs"
          role="tablist"
          aria-label="Workload"
          onKeyDown={(e) => {
            const i = ORDER.indexOf(presetId);
            const next =
              e.key === "ArrowRight" ? ORDER[(i + 1) % ORDER.length]
              : e.key === "ArrowLeft" ? ORDER[(i - 1 + ORDER.length) % ORDER.length]
              : e.key === "Home" ? ORDER[0]
              : e.key === "End" ? ORDER[ORDER.length - 1]
              : null;
            if (!next) return;
            e.preventDefault();
            pick(next);
            document.getElementById(`board-tab-${next}`)?.focus();
          }}
        >
          {ORDER.map((id) => {
            const p = presetById(id)!;
            return (
              <button
                key={id}
                id={`board-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={presetId === id}
                aria-controls="board-panel"
                tabIndex={presetId === id ? 0 : -1}
                className={presetId === id ? "on" : ""}
                onClick={() => pick(id)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="board-workload mono">{workloadLine(preset.workload, preset.rate, true)}</p>

        <div id="board-panel" role="tabpanel" aria-labelledby={`board-tab-${presetId}`} className="table-frame">
          <table className="market board-table">
            <caption className="sr-only">
              Cheapest models at each level of AA Intelligence for the {preset.label} workload
            </caption>
            <thead>
              <tr>
                <th>Model</th>
                <th className="n" aria-sort={sort === "score" ? "descending" : "none"}>
                  <button type="button" className={`th-sort${sort === "score" ? " on" : ""}`} onClick={() => setSort("score")}>
                    AA Intel<span aria-hidden="true">{sort === "score" ? " ↓" : ""}</span>
                  </button>
                </th>
                <th className="col-bar" aria-sort={sort === "cost" ? "ascending" : "none"}>
                  <button type="button" className={`th-sort${sort === "cost" ? " on" : ""}`} onClick={() => setSort("cost")}>
                    $ / 1K requests<span aria-hidden="true">{sort === "cost" ? " ↑" : ""}</span>
                  </button>
                </th>
                <th className="n col-rate">In / Out per MTok</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const card = rateCard(p.model, p.breakdown.mode)!;
                return (
                  <tr key={p.model.key}>
                    <td>
                      <Link
                        className="row-link"
                        state={INTERNAL}
                        to={`/tools/cost?m=${encodeKey(p.model.key)}&p=${preset.id}`}
                        onClick={() => trackEvent("Home", "Board row", p.model.key)}
                      >
                        {p.model.displayName}
                      </Link>
                      <span className="vd">
                        {p.model.vendorName} <SourceTag model={p.model} />
                      </span>
                    </td>
                    <td className="n">{scoreOf(p.model, "intelligence")!.toFixed(1)}</td>
                    <td className="col-bar">
                      <span className="cost-cell">
                        <span className="mono cost-fig">
                          {fmtUsd(p.per1k)}
                          <FallbackMark breakdown={p.breakdown} />
                        </span>
                        <span className="range-bar" aria-hidden="true">
                          <span
                            className={p.model.key === cheapestKey ? "fill best" : "fill"}
                            style={{ width: `${barPct(p.cost)}%` }}
                          />
                        </span>
                      </span>
                    </td>
                    <td className="n col-rate">
                      {fmtRate(card.input)} / {fmtRate(card.output)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="fine">
          {showAll ? (
            <>
              The full AA Intelligence frontier at this workload: {board.fullFrontier.length} models, each scoring
              higher than everything cheaper.
            </>
          ) : (
            <>
              Showing models scoring at least {board.floor} on AA Intelligence — the top quartile (p{BOARD_PERCENTILE}) of{" "}
              {board.scoredCount} scored — where nothing cheaper on this workload scores higher.
            </>
          )}{" "}
          <button type="button" className="text-btn" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show top quartile only" : `Show full frontier (${board.fullFrontier.length})`}
          </button>
        </p>
      </section>

      <section className="section" aria-labelledby="readings-h">
        <h2 id="readings-h" className="sr-only">
          Readings
        </h2>
        <ul className="readings">
          {lines.map((r, i) => (
            <li key={r.id}>
              <span className="reading-label">{r.label}</span>
              {r.point ? (
                <span className="reading-value-wrap">
                  <Link
                    className="reading-value"
                    state={INTERNAL}
                    to={r.href}
                    onClick={() => trackEvent("Home", "Reading", String(i + 1))}
                  >
                    {r.point.model.displayName} · <span className="mono">{fmtUsd(r.point.per1k)}</span> / 1K
                  </Link>{" "}
                  <SourceTag model={r.point.model} />
                  {r.detail ? <span className="reading-detail"> · {r.detail}</span> : null}
                </span>
              ) : (
                <span className="reading-value na">none in this snapshot</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="tools-h">
        <div className="section-title">
          <h2 id="tools-h">
            <span className="sec-num">02</span> Instruments
          </h2>
        </div>
        <ol className="tool-index">
          {ROUTES.filter((r) => r.nav).map((r) => (
            <li key={r.path}>
              <span className="tool-idx">{r.nav!.num}</span>
              <Link to={r.path} className="tool-link" state={INTERNAL}>
                {r.title.split(" — ")[0]}
              </Link>
              <span className="tool-q">{QUESTIONS[r.path]}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}


