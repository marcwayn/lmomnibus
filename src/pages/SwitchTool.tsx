import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { Mark, Meter, NotRated, SourceTag, WorkloadPanel } from "../components.tsx";
import { allModels, modelByKey } from "../core/catalog.ts";
import type { Rate, Workload } from "../core/cost.ts";
import { daysBetween, todayIso } from "../core/date.ts";
import { fmtMoney, fmtUsd } from "../core/fmt.ts";
import { INDEX_LABEL, priceAll, scoreOf, type Index } from "../core/frontier.ts";
import { matchingPreset, type PresetId } from "../core/presets.ts";
import { search } from "../core/query.ts";
import { decodeKey, decodeScenario, encodeKey, encodeScenario, hasScenario } from "../core/share.ts";
import { SCORE_TOLERANCE, switchCandidates } from "../core/switch.ts";
import { titleFor } from "../routes.ts";

const MODELS = allModels();
const INTERNAL = { internal: true };
const SHOWN = 25;

export function SwitchTool() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const today = todayIso();
  const [init] = useState(() => {
    const s = decodeScenario(params);
    const from = params.get("from");
    return { ...s, from: from ? decodeKey(from) : null };
  });

  const [fromKey, setFromKey] = useState<string | null>(init.from && modelByKey(init.from) ? init.from : null);
  const [workload, setWorkload] = useState<Workload>(init.workload);
  const [rate, setRate] = useState<Rate>(init.rate);
  const [preset, setPreset] = useState<PresetId | null>(
    () => init.preset ?? matchingPreset(init.workload, init.rate)?.id ?? null,
  );
  const [index, setIndex] = useState<Index>(init.index);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const encoded = [
    fromKey ? `from=${encodeKey(fromKey)}` : "",
    encodeScenario({ models: [], preset, workload, rate, modes: new Map(), index }),
  ]
    .filter(Boolean)
    .join("&");
  const synced = useRef(hasScenario(params) || params.has("from") ? "" : encoded);
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      navigate({ pathname, search: `?${encoded}` }, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, navigate, pathname]);

  const priced = useMemo(() => priceAll(MODELS, workload, rate, today), [workload, rate, today]);
  const from = fromKey ? (priced.find((p) => p.model.key === fromKey) ?? null) : null;
  const candidates = useMemo(
    () => (from ? switchCandidates(from, priced, index, workload, today) : []),
    [from, priced, index, workload, today],
  );
  const picks = useMemo(
    () => (query.trim() ? search(MODELS, { text: query, vendors: [], releasedYear: null, limit: 8 }).hits : []),
    [query],
  );
  const fromScore = from ? scoreOf(from.model, index) : null;
  const label = INDEX_LABEL[index];
  const benchHref = (keys: string[]) =>
    `/tools/cost?${encodeScenario({ models: keys, preset, workload, rate, modes: new Map(), index })}`;

  return (
    <>
      <title>{titleFor("/tools/switch")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 05</span>
        <h1>Switch Planner</h1>
        <p className="sub">
          Leaving a model — because it retires, or costs too much? See what replaces it at your workload: what you'd
          save, how the score moves, and what you'd give up.
        </p>
      </div>

      <section className="section" aria-labelledby="from-h">
        <div className="section-title">
          <h2 id="from-h">Switching from</h2>
        </div>
        {from && (
          <div className="from-card">
            <div className="bn">{from.model.displayName}</div>
            <div className="bv">
              {from.model.vendorName} <SourceTag model={from.model} />
              {from.model.retiresOn && daysBetween(today, from.model.retiresOn) >= 0 && (
                <span className="retire-tag">
                  retires {from.model.retiresOn} ({daysBetween(today, from.model.retiresOn)} days)
                </span>
              )}
            </div>
            <div className="from-figures mono">
              {fmtMoney(from.breakdown.monthlyCost)}
              <span className="figure-unit">/mo</span> · {fmtUsd(from.per1k)} / 1K · AA {label}{" "}
              {fromScore === null ? <NotRated /> : fromScore.toFixed(1)}
            </div>
          </div>
        )}
        <div className="searchfield">
          <input
            type="search"
            aria-label={from ? "Pick a different model" : "Pick the model you're leaving"}
            placeholder={from ? "Pick a different model…" : "Which model are you leaving? Try “gemini 2.5 pro”"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {picks.length > 0 && (
          <ul className="pick-list">
            {picks.map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  className="row-btn"
                  onClick={() => {
                    trackEvent("Switch", "Pick", m.key);
                    setFromKey(m.key);
                    setQuery("");
                  }}
                >
                  {m.displayName}
                </button>
                <span className="vd">
                  {m.vendorName} · {m.key}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="sw-h">
        <div className="section-title">
          <h2 id="sw-h">Workload</h2>
        </div>
        <WorkloadPanel
          workload={workload}
          rate={rate}
          onChange={(w, r, p) => {
            setWorkload(w);
            setRate(r);
            setPreset(p);
          }}
        />
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="cand-h">
        <div className="section-title">
          <h2 id="cand-h">Replacements</h2>
          <div className="seg" role="group" aria-label="Capability index">
            {(Object.keys(INDEX_LABEL) as Index[]).map((i) => (
              <button key={i} type="button" aria-pressed={index === i} className={index === i ? "on" : ""} onClick={() => setIndex(i)}>
                {INDEX_LABEL[i]}
              </button>
            ))}
          </div>
        </div>
        {!from ? (
          <div className="empty-bench">Pick the model you're leaving to see its replacements.</div>
        ) : (
          <>
            <p className="fine">
              Models that keep its tools, reasoning and image input, fit this workload, aren't retiring sooner
              {fromScore !== null ? `, and score within ${SCORE_TOLERANCE} points of it on AA ${label}` : ""}. Cheapest
              first.
            </p>
            <div className="table-frame">
              <table className="market">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="n">Δ AA {label}</th>
                    <th className="n">$ / 1K req</th>
                    <th className="n">Saving / mo</th>
                    <th>You'd give up</th>
                    <th>
                      <span className="sr-only">Compare</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? candidates : candidates.slice(0, SHOWN)).map((c) => {
                    const saves = c.saving.gt(0);
                    return (
                      <tr key={c.point.model.key}>
                        <td>
                          <span className="nm">{c.point.model.displayName}</span>
                          <span className="vd">
                            {c.point.model.vendorName} <SourceTag model={c.point.model} />
                          </span>
                        </td>
                        <td className="n">
                          {c.scoreDelta === null ? <NotRated /> : `${c.scoreDelta > 0 ? "+" : ""}${c.scoreDelta.toFixed(1)}`}
                        </td>
                        <td className="n">{fmtUsd(c.point.per1k)}</td>
                        <td className={`n ${saves ? "down" : "up"}`}>
                          <Mark kind={saves ? "down" : "up"} />
                          {fmtMoney(c.saving.abs())} ({Math.abs(Math.round(c.savingPct * 100))}%)
                        </td>
                        <td className="breaks">{c.breaks.length ? c.breaks.join(" · ") : "—"}</td>
                        <td>
                          <Link
                            className="text-btn"
                            state={INTERNAL}
                            to={benchHref([from.model.key, c.point.model.key])}
                            onClick={() => trackEvent("Switch", "Compare", c.point.model.key)}
                            aria-label={`Compare ${from.model.displayName} and ${c.point.model.displayName} on the bench`}
                          >
                            compare →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {candidates.length === 0 && (
                <div className="empty-note">No replacement keeps these capabilities and fits this workload.</div>
              )}
            </div>
            {candidates.length > SHOWN && (
              <button type="button" className="text-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? `Show the cheapest ${SHOWN}` : `Show all ${candidates.length} replacements`}
              </button>
            )}
            <p className="fine">
              List-price cost at your workload, not cost per task. Capability flags are unions across providers; check
              the provider you'd actually use.
            </p>
          </>
        )}
      </section>
    </>
  );
}
