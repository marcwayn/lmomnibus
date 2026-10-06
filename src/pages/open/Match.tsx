import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.ts";
import { CopyButton, FallbackMark, Mark, NotRated, SourceTag, workloadLine } from "../../components.tsx";
import { CATALOG_META } from "../../core/catalog.ts";
import type { Rate, Workload } from "../../core/cost.ts";
import { fmtCompact, fmtMoney, fmtRate, fmtUsd } from "../../core/fmt.ts";
import { INDEX_LABEL, scoreOf, type Index, type Priced } from "../../core/frontier.ts";
import { inputModalities, rateCard, type Model } from "../../core/model.ts";
import { matchTable, openMatch, sideOf, type LicenceFilter, type OpenMatch } from "../../core/openclosed.ts";
import { search } from "../../core/query.ts";
import { fmtNeed, setupLabel } from "../../core/selfhost.ts";
import { fmtCtx } from "../../core/vram.ts";
import { LICENCE_CLASS_LABEL } from "../../core/weights.ts";
import { needRange, pageFigure, vramHref } from "./SelfHost.tsx";
import { fmtDelta, fmtRatio, fmtScore, INTERNAL, paramsText, Cheaper, Pricier, sideRank, Stamp, useSettled } from "./shared.tsx";
import { SELF_CONTEXTS, TOLS, type SelfCtx, type SelfFormat, type Tol } from "./state.ts";

/**
 * §B, "Is there an open-weight match for my closed model?": for every rated
 * closed model, the cheapest open-weight model that keeps its tools,
 * reasoning and image input and scores at least as high (or within the
 * tolerance), with a side-by-side sheet for one closed model in focus.
 */
const SHOWN = 25;
const TOL_LABEL: Record<Tol, string> = { 0: "At least as high", 2: "Within 2 points", 5: "Within 5 points" };
const INDEXES: Index[] = ["intelligence", "coding", "agentic"];

/** The chart's shapes in text: a square for closed, a circle for open-weight. */
export function ShapeMark({ open }: { open: boolean }) {
  return (
    <svg className="oc-shape" viewBox="0 0 10 10" aria-hidden="true">
      {open ? <circle cx="5" cy="5" r="4" /> : <rect x="1" y="1" width="8" height="8" />}
    </svg>
  );
}

/** "tools, reasoning and image input", for what a closed model relies on. */
function keepsText(m: Model): string {
  const parts = [m.capabilities.tools && "tools", m.capabilities.reasoning && "reasoning", inputModalities(m).includes("image") && "image input"].filter(
    Boolean,
  ) as string[];
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface MatchProps {
  models: readonly Model[];
  priced: readonly Priced[];
  pool: readonly Priced[];
  index: Index;
  workload: Workload;
  rate: Rate;
  today: string;
  lic: LicenceFilter;
  vs: string | null;
  onVs: (key: string | null) => void;
  tol: Tol;
  onTol: (t: Tol) => void;
  sq: SelfFormat;
  sctx: SelfCtx;
  bestOpenScore: number | null;
  costHref: (keys: string[]) => string;
  switchHref: (key: string) => string;
  shareUrl: () => string;
}

export const MatchSection = memo(function MatchSection(props: MatchProps) {
  const { models, priced, pool, index, workload, rate, today, lic, vs, onVs, tol, onTol, bestOpenScore, costHref, switchHref } = props;
  const label = INDEX_LABEL[index];
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const answerHeading = useRef<HTMLHeadingElement>(null);

  const rows = useMemo(() => matchTable(pool, index, workload, today, tol, lic), [pool, index, workload, today, tol, lic]);
  const picks = useMemo(
    () => (query.trim() ? search(models, { text: query, vendors: [], releasedYear: null, limit: 8, filter: (m) => sideOf(m) === "closed" }).hits : []),
    [models, query],
  );
  const focused = vs ? (priced.find((p) => p.model.key === vs) ?? null) : null;
  const focus = useMemo(
    () => (focused ? openMatch(focused, pool, index, workload, today, tol, lic) : null),
    [focused, pool, index, workload, today, tol, lic],
  );

  const matched = rows.filter((r) => r.match);
  const cheaper = matched.filter((r) => r.costRatio !== null && r.costRatio < 1).length;
  const unmatched = rows.filter((r) => !r.match);
  const above = bestOpenScore === null ? 0 : unmatched.filter((r) => scoreOf(r.closed.model, index)! > bestOpenScore).length;
  const rule = tol === 0 ? `scores at least as high on AA ${label}` : `scores at most ${tol} points below them on AA ${label}`;

  const overviewText = rows.length
    ? `${matched.length} of ${rows.length} rated closed models have an open-weight model that ${rule} and keeps their tools, reasoning and image input; at this workload ${cheaper} of those matches cost less.`
    : `No rated closed model passes these filters.`;
  const sentence = focused ? focusSentence(focused, focus, index, tol) : null;
  const settled = useSettled(sentence ? sentence.text : overviewText);

  const pick = (key: string) => {
    trackEvent("Open vs Closed", "Focus closed", key);
    onVs(key);
    setQuery("");
    // The picked button disappears with the list; land on the answer.
    requestAnimationFrame(() => answerHeading.current?.focus());
  };

  const markdown = () =>
    [
      `| Closed model | AA ${label} | $/1K req | Open-weight match | AA ${label} | Δ | $/1K req | Cost × | Gives up | Licence |`,
      "|---|---:|---:|---|---:|---:|---:|---:|---|---|",
      ...rows.map((r) => {
        const c = r.closed;
        const o = r.match ?? r.nearest;
        const head = `| ${c.model.displayName} | ${fmtScore(scoreOf(c.model, index)!)} | ${fmtUsd(c.per1k)} (${srcWord(c)}) |`;
        if (!o) return `${head} none | | | | | | |`;
        const tag = r.match ? "" : "nearest: ";
        return `${head} ${tag}${o.model.displayName} | ${fmtScore(scoreOf(o.model, index)!)} | ${fmtDelta(r.scoreDelta!)} | ${fmtUsd(o.per1k)} (${srcWord(o)}) | ${
          r.match ? `${fmtRatio(r.costRatio!)}×` : ""
        } | ${r.breaks.join(", ") || "—"} | ${o.model.weights ? LICENCE_CLASS_LABEL[o.model.weights.licence] : "—"} |`;
      }),
      "",
      `Match rule: ${TOL_LABEL[tol].toLowerCase()}; keeps tools, reasoning and image input; fits the workload.`,
      `Workload: ${workloadLine(workload, rate, true)}`,
      `Prices as of ${CATALOG_META.asOf} · AA ${label} via OpenRouter · list-price cost, not cost per task · open-weight prices are mostly OpenRouter aggregates · LMOmnibus`,
      props.shareUrl(),
    ].join("\n");

  const shownRows = showAll ? rows : rows.slice(0, SHOWN);

  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {settled}
      </p>
      {!focused && (
        <p className="readout">
          {rows.length ? (
            <>
              <strong className="mono">
                {matched.length} of {rows.length}
              </strong>{" "}
              rated closed models have an open-weight model that {rule} and keeps their tools, reasoning and image input; at this
              workload <strong className="mono">{cheaper}</strong> of those matches cost less.{" "}
              {unmatched.length === 0
                ? "Every one has a match."
                : above === unmatched.length && bestOpenScore !== null
                  ? `The ${above} closed ${above === 1 ? "model" : "models"} above ${fmtScore(bestOpenScore)} ${above === 1 ? "has" : "have"} none yet.`
                  : `${unmatched.length} ${unmatched.length === 1 ? "has" : "have"} none yet${above && bestOpenScore !== null ? `, ${above} of them scoring above ${fmtScore(bestOpenScore)}, the best open-weight score` : ""}.`}
            </>
          ) : (
            "No rated closed model passes these filters."
          )}
        </p>
      )}

      <div className="oc-match-controls">
        <div className="searchfield">
          <input
            type="search"
            aria-label="Check a closed model"
            placeholder="Check a closed model… try “sonnet”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="seg oc-tol" role="group" aria-label="Match rule">
          {TOLS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tol === t}
              className={tol === t ? "on" : ""}
              onClick={() => {
                trackEvent("Open vs Closed", "Match rule", String(t));
                onTol(t);
              }}
            >
              {TOL_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      {picks.length > 0 && (
        <ul className="pick-list">
          {picks.map((m) => (
            <li key={m.key}>
              <button type="button" className="row-btn" onClick={() => pick(m.key)}>
                {m.displayName}
              </button>
              <span className="vd">
                {m.vendorName} · AA {label} {scoreOf(m, index) === null ? "not rated" : fmtScore(scoreOf(m, index)!)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {query.trim() && picks.length === 0 && <p className="fine">No closed model matches “{query}”.</p>}

      {focused && (
        <div className="oc-focus">
          <div className="oc-focus-head">
            <h3 ref={answerHeading} tabIndex={-1}>
              {focused.model.displayName} against open-weight
            </h3>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                onVs(null);
                requestAnimationFrame(() => document.getElementById("match-h")?.focus());
              }}
            >
              Clear
            </button>
          </div>
          <p className="readout">{sentence!.node}</p>
          {focus && scoreOf(focused.model, index) !== null && (focus.match ?? focus.nearest) && (
            <PairSheet closed={focused} open={(focus.match ?? focus.nearest)!} isMatch={Boolean(focus.match)} {...props} />
          )}
          <p className="oc-links">
            {(focus?.match ?? focus?.nearest) && (
              <Link
                className="text-btn"
                state={INTERNAL}
                to={costHref([focused.model.key, (focus!.match ?? focus!.nearest)!.model.key])}
                onClick={() => trackEvent("Open vs Closed", "To bench")}
              >
                Open both on the Cost bench
                <Mark kind="to" />
              </Link>
            )}
            <Link className="text-btn" state={INTERNAL} to={switchHref(focused.model.key)} onClick={() => trackEvent("Open vs Closed", "To switch")}>
              Open-weight replacements in Switch Planner
              <Mark kind="to" />
            </Link>
          </p>
        </div>
      )}

      <div className="section-title bench-head oc-subhead">
        <h3>Every rated closed model</h3>
        <div className="bench-actions">
          <CopyButton label="Copy as Markdown" getText={markdown} onCopied={() => trackEvent("Share", "Copy markdown")} />
        </div>
      </div>
      <div className="table-frame oc-match-frame">
        <table className="market oc-match">
          <caption className="sr-only">
            Each rated closed model that passes the filters, highest AA {label} first, with its cheapest open-weight match
          </caption>
          <thead>
            <tr>
              <th>Closed model · AA · $/1K</th>
              <th>Open-weight match · AA · $/1K</th>
              <th className="n">Cost ×</th>
              <th>Gives up</th>
              <th>Licence</th>
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r) => (
              <MatchRow key={r.closed.model.key} r={r} index={index} tol={tol} onPick={pick} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty-note">No rated closed model passes these filters.</div>}
      </div>
      <ul className="oc-match-cards" aria-label={`Each rated closed model, highest AA ${label} first, with its cheapest open-weight match`}>
        {shownRows.map((r) => (
          <MatchCard key={r.closed.model.key} r={r} index={index} tol={tol} onPick={pick} />
        ))}
      </ul>
      {rows.length > SHOWN && (
        <button
          type="button"
          className="text-btn"
          onClick={() => {
            if (!showAll) trackEvent("Open vs Closed", "Show all matches");
            setShowAll((v) => !v);
          }}
        >
          {showAll ? `Show the top ${SHOWN}` : `Show all ${rows.length}`}
        </button>
      )}
      <p className="fine">
        A match on one AA index isn't a drop-in replacement. Open-weight prices are mostly OpenRouter aggregates: one provider may
        serve a quantized build that scores lower than AA measured, and others may charge more. Reasoning models can emit more
        output than this workload assumes. Matches keep the closed model's tools, reasoning and image input, fit this workload,
        aren't retiring sooner, and pass the licence filter.
      </p>
    </>
  );
});

const srcWord = (p: Priced) => (rateCard(p.model, p.breakdown.mode)?.checked ? "list" : "via OR");

/** The focused closed model's answer, as page text and as a plain sentence for the live region. */
function focusSentence(closed: Priced, f: OpenMatch | null, index: Index, tol: Tol): { node: ReactNode; text: string } {
  const c = closed.model;
  const cs = scoreOf(c, index);
  const label = INDEX_LABEL[index];
  if (cs === null) {
    const text = `${c.displayName} isn't rated on AA ${label}; pick another index or model.`;
    return { node: text, text };
  }
  const head = (
    <>
      <strong>{c.displayName}</strong> (AA <span className="mono">{fmtScore(cs)}</span>, <span className="mono">{fmtUsd(closed.per1k)}</span> per 1K,{" "}
      {srcWord(closed)})
    </>
  );
  const keeps = keepsText(c);
  const m = f?.match;
  if (m) {
    const r = f!.costRatio!;
    const ms = scoreOf(m.model, index)!;
    const text = `${c.displayName} (AA ${fmtScore(cs)}, ${fmtUsd(closed.per1k)} per 1K) has an open-weight match: ${m.model.displayName}, AA ${fmtScore(ms)} (${fmtDelta(f!.scoreDelta!)}), ${fmtUsd(m.per1k)} per 1K, ${fmtRatio(r)} times the cost.`;
    return {
      text,
      node: (
        <>
          {head} has an open-weight match{tol ? ` at most ${tol} points below it` : ""}: {r < 1 ? <Cheaper /> : r > 1 ? <Pricier /> : null}
          <strong>{m.model.displayName}</strong>, AA <span className="mono">{fmtScore(ms)}</span> (<span className="mono">{fmtDelta(f!.scoreDelta!)}</span>),{" "}
          <span className="mono">{fmtUsd(m.per1k)}</span> per 1K {srcWord(m)}: <span className="mono">{fmtRatio(r)}×</span> the closed model's cost.
        </>
      ),
    };
  }
  const n = f?.nearest;
  const nothing = tol ? `nothing open-weight scores ${fmtScore(cs - tol)} or more` : `nothing open-weight scores ${fmtScore(cs)}`;
  if (!n) {
    const text = `${c.displayName} has no open-weight match: ${nothing}${keeps ? ` and keeps its ${keeps}` : ""} at this workload.`;
    return { text, node: <>{head} has <strong>no open-weight match</strong>: {nothing}{keeps ? ` and keeps its ${keeps}` : ""} at this workload.</> };
  }
  const d = Math.abs(f!.scoreDelta!);
  const r = f!.costRatio!;
  const text = `${c.displayName} has no open-weight match: ${nothing}. Nearest${keeps ? ` that keeps its ${keeps}` : ""}: ${n.model.displayName}, ${fmtScore(d)} points lower, ${fmtUsd(n.per1k)} per 1K (${fmtRatio(r)} times).`;
  return {
    text,
    node: (
      <>
        {head} has <strong>no open-weight match</strong>: {nothing}. Nearest{keeps ? ` that keeps its ${keeps}` : ""}: {n.model.displayName},{" "}
        <strong className="mono">{fmtScore(d)} points lower</strong>, <span className="mono">{fmtUsd(n.per1k)}</span> per 1K {srcWord(n)} (
        <span className="mono">{fmtRatio(r)}×</span>).
      </>
    ),
  };
}

function MatchRow({ r, index, tol, onPick }: { r: OpenMatch; index: Index; tol: Tol; onPick: (key: string) => void }) {
  const c = r.closed;
  const cs = scoreOf(c.model, index)!;
  const o = r.match;
  return (
    <tr>
      <td>
        <button type="button" className="row-btn" onClick={() => onPick(c.model.key)} aria-label={`Check ${c.model.displayName}`}>
          {c.model.displayName}
        </button>
        <span className="vd">
          AA {fmtScore(cs)} · {fmtUsd(c.per1k)} <SourceTag model={c.model} mode={c.breakdown.mode} />
        </span>
      </td>
      {o ? (
        <>
          <td>
            <span className="nm">{o.model.displayName}</span>
            <span className="vd">
              AA {fmtScore(scoreOf(o.model, index)!)} ({fmtDelta(r.scoreDelta!)}) · {fmtUsd(o.per1k)} <SourceTag model={o.model} mode={o.breakdown.mode} />
              <FallbackMark breakdown={o.breakdown} />
            </span>
          </td>
          <td className="n">
            <RatioCell ratio={r.costRatio!} />
          </td>
          <td className="breaks">{r.breaks.length ? r.breaks.join(" · ") : "—"}</td>
          <td className="oc-small">{o.model.weights ? LICENCE_CLASS_LABEL[o.model.weights.licence] : "—"}</td>
        </>
      ) : (
        <td colSpan={4} className="oc-none">
          none ≥ {fmtScore(cs - tol)}
          {r.nearest ? ` · nearest ${r.nearest.model.displayName} (${fmtDelta(r.scoreDelta!)})` : " · nothing keeps its capabilities"}
        </td>
      )}
    </tr>
  );
}

function RatioCell({ ratio }: { ratio: number }) {
  return (
    <>
      {ratio < 1 ? <Cheaper /> : ratio > 1 ? <Pricier /> : null}
      {fmtRatio(ratio)}×
    </>
  );
}

function MatchCard({ r, index, tol, onPick }: { r: OpenMatch; index: Index; tol: Tol; onPick: (key: string) => void }) {
  const c = r.closed;
  const o = r.match;
  return (
    <li>
      <div className="oc-card-line">
        <ShapeMark open={false} />
        <button type="button" className="row-btn" onClick={() => onPick(c.model.key)}>
          {c.model.displayName}
        </button>
        <span className="mono">
          {" "}
          · {fmtScore(scoreOf(c.model, index)!)} · {fmtUsd(c.per1k)}
        </span>
      </div>
      {o ? (
        <>
          <div className="oc-card-line">
            <ShapeMark open />
            <span className="oc-card-name">{o.model.displayName}</span>
            <span className="mono">
              {" "}
              · {fmtScore(scoreOf(o.model, index)!)} · {fmtUsd(o.per1k)} · <RatioCell ratio={r.costRatio!} />
            </span>
          </div>
          <div className="oc-card-line breaks">{r.breaks.length ? r.breaks.join(" · ") : "gives up nothing listed"}</div>
        </>
      ) : (
        <div className="oc-card-line oc-none">
          none ≥ {fmtScore(scoreOf(c.model, index)! - tol)}
          {r.nearest ? ` · nearest ${r.nearest.model.displayName} (${fmtDelta(r.scoreDelta!)})` : ""}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- the pair sheet

function PairSheet({
  closed,
  open,
  isMatch,
  pool,
  sq,
  sctx,
}: MatchProps & { closed: Priced; open: Priced; isMatch: boolean }) {
  // Sized as the model page sizes it (headless), so both name the same figure and setup.
  const self = useMemo(() => pageFigure(open.model, sq, SELF_CONTEXTS[sctx]), [open, sq, sctx]);
  const cheaper = open.cost < closed.cost ? "open" : closed.cost < open.cost ? "closed" : null;

  const row = (label: string, cv: ReactNode, ov: ReactNode) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{cv}</td>
      <td>{ov}</td>
    </tr>
  );
  const score = (p: Priced, other: Priced, idx: Index) => {
    const s = scoreOf(p.model, idx);
    if (s === null) return <NotRated />;
    const os = scoreOf(other.model, idx);
    const rank = sideRank(pool, p.model, idx);
    return (
      <>
        <span className={os !== null && s > os ? "oc-hi" : undefined}>{fmtScore(s)}</span>
        {rank && <span className="oc-rank">#{rank.rank} of {rank.of}</span>}
      </>
    );
  };
  const cost = (p: Priced, side: "open" | "closed") => (
    <>
      {cheaper === side && <Cheaper />}
      {fmtUsd(p.per1k)} <SourceTag model={p.model} mode={p.breakdown.mode} />
      <FallbackMark breakdown={p.breakdown} />
    </>
  );
  const yes = (b: boolean) => (b ? "yes" : "no");
  const reasoning = (m: Model) => (m.reasoningMandatory ? "always on" : yes(m.capabilities.reasoning));
  const cacheRead = (p: Priced) => {
    const cr = rateCard(p.model, p.breakdown.mode)?.cacheRead;
    return cr ? `${fmtRate(cr)} / MTok` : "none published";
  };
  const batch = (m: Model) => {
    const b = rateCard(m, "Batch");
    return b ? `${fmtRate(b.input)} / ${fmtRate(b.output)}` : "none";
  };
  const weights = (m: Model) => {
    if (sideOf(m) !== "open" || !m.weights) return "API only";
    const w = m.weights;
    return [LICENCE_CLASS_LABEL[w.licence], w.licenceLabel, w.gated ? "gated on Hugging Face" : null, paramsText(w)].filter(Boolean).join(" · ");
  };

  return (
    <div className="table-frame oc-pair-frame">
      <table className="market oc-pair">
        <caption className="sr-only">
          {closed.model.displayName} and {isMatch ? "its open-weight match" : "the nearest open-weight model"}, {open.model.displayName}, side by side
        </caption>
        <thead>
          <tr>
            <th>
              <span className="sr-only">Spec</span>
            </th>
            <th>
              <ShapeMark open={false} /> {closed.model.displayName}
            </th>
            <th>
              <ShapeMark open /> {open.model.displayName}
              {isMatch ? "" : " (nearest)"}
            </th>
          </tr>
        </thead>
        <tbody>
          {INDEXES.map((i) => row(`AA ${INDEX_LABEL[i]}`, score(closed, open, i), score(open, closed, i)))}
          {row("$ / 1K req", cost(closed, "closed"), cost(open, "open"))}
          {row(
            "$ / month",
            <>
              {fmtMoney(closed.breakdown.monthlyCost)} <SourceTag model={closed.model} mode={closed.breakdown.mode} />
            </>,
            <>
              {fmtMoney(open.breakdown.monthlyCost)} <SourceTag model={open.model} mode={open.breakdown.mode} />
            </>,
          )}
          {row("Context", fmtCompact(closed.model.contextTokens), fmtCompact(open.model.contextTokens))}
          {row(
            "Max output",
            closed.model.maxOutputTokens === null ? "—" : fmtCompact(closed.model.maxOutputTokens),
            open.model.maxOutputTokens === null ? "—" : fmtCompact(open.model.maxOutputTokens),
          )}
          {row("Tools", yes(closed.model.capabilities.tools), yes(open.model.capabilities.tools))}
          {row("Reasoning", reasoning(closed.model), reasoning(open.model))}
          {row("Image in", yes(inputModalities(closed.model).includes("image")), yes(inputModalities(open.model).includes("image")))}
          {row("Cache-read price", cacheRead(closed), cacheRead(open))}
          {row("Batch price / MTok", batch(closed.model), batch(open.model))}
          {row("Listed on OpenRouter", closed.model.listedOn ?? "—", open.model.listedOn ?? "—")}
          {row("Knowledge cutoff", closed.model.knowledgeCutoff ?? "—", open.model.knowledgeCutoff ?? "—")}
          {row("Weights", weights(closed.model), weights(open.model))}
          {row(
            "Run it yourself",
            "—",
            self ? (
              <>
                <Stamp /> ≈ {fmtNeed(self.need.mid)} <span className="oc-range">({needRange(self.need)})</span> at {self.format.label} +{" "}
                {fmtCtx(self.ctx)}, headless → {setupLabel(self.setup)}{" "}
                <Link
                  className="text-btn"
                  state={INTERNAL}
                  to={vramHref(self, sctx, true)}
                  onClick={() => trackEvent("Open vs Closed", "To VRAM", open.model.key)}
                >
                  Estimate VRAM
                  <Mark kind="to" />
                </Link>
              </>
            ) : (
              "no architecture we can read"
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
