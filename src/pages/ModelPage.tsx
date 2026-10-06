import Big from "big.js";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Mark, Meter, NotRated, RetireTag, SourceTag } from "../components.tsx";
import { allModels, CATALOG_META, modelByKey } from "../core/catalog.ts";
import type { Change } from "../core/changes.ts";
import { todayIso } from "../core/date.ts";
import { fmtCompact, fmtMoney, fmtRate, fmtUsd } from "../core/fmt.ts";
import { alternatives, frontier, INDEX_LABEL, priceAll, scoreOf, type Index } from "../core/frontier.ts";
import { inputModalities, yearMonth, type Model, type RateCard } from "../core/model.ts";
import { PRESETS } from "../core/presets.ts";
import { encodeKey } from "../core/share.ts";

const MODELS = allModels();
const INTERNAL = { internal: true };
const INDEXES: Index[] = ["intelligence", "coding", "agentic"];

/** Rank of `model` on an index among scored models (1 = highest), with the count. */
function rankOf(model: Model, index: Index): { rank: number; of: number } | null {
  const s = scoreOf(model, index);
  if (s === null) return null;
  const scores = MODELS.map((m) => scoreOf(m, index)).filter((x): x is number => x !== null);
  return { rank: scores.filter((x) => x > s).length + 1, of: scores.length };
}

const rate = (b: Big | null) => (b === null ? "—" : fmtRate(b));

export function modelPath(key: string): string {
  return `/models/${key}`;
}

export function ModelPage() {
  const key = useParams()["*"] ?? "";
  const model = modelByKey(key);
  return model ? <SpecSheet model={model} /> : <Tombstone modelKey={key} />;
}

function SpecSheet({ model }: { model: Model }) {
  const today = todayIso();
  const inputs = inputModalities(model);
  const outputs = model.modality.split("->")[1]?.split("+") ?? [];
  const atPresets = useMemo(
    () =>
      PRESETS.map((p) => {
        const priced = priceAll(MODELS, p.workload, p.rate, today);
        const me = priced.find((x) => x.model.key === model.key)!;
        const rank = priced.filter((x) => x.cost < me.cost).length + 1;
        const onFront = frontier(priced, "intelligence").some((x) => x.model.key === model.key);
        return { preset: p, me, rank, of: priced.length, onFront, priced };
      }),
    [model, today],
  );
  const agent = atPresets.find((a) => a.preset.id === "agent")!;
  const alts = alternatives(agent.me, agent.priced, "intelligence", agent.preset.workload, 3);
  const benchHref = `/tools/cost?m=${encodeKey(model.key)}&p=agent`;

  return (
    <>
      <title>{`${model.displayName} pricing and specs — LMOmnibus`}</title>
      <div className="tool-head">
        <span className="eyebrow">Model · {model.vendorName}</span>
        <h1>{model.displayName}</h1>
        <p className="model-byline mono">
          {model.key} <SourceTag model={model} /> · listed {model.listedOn ?? yearMonth(model.released)}
          {model.knowledgeCutoff ? ` · cutoff ${model.knowledgeCutoff}` : ""} <RetireTag model={model} today={today} />
        </p>
        <p className="model-actions">
          <Link className="btn btn-primary" to={benchHref} state={INTERNAL}>
            Put it on the bench
          </Link>
          <Link className="btn btn-ghost" to={`/tools/switch?from=${encodeKey(model.key)}`} state={INTERNAL}>
            Plan a switch
          </Link>
        </p>
      </div>

      <section className="section" aria-labelledby="spec-h">
        <div className="section-title">
          <h2 id="spec-h">Spec</h2>
        </div>
        <dl className="spec-grid">
          <div>
            <dt>Context</dt>
            <dd>{fmtCompact(model.contextTokens)} tokens</dd>
          </div>
          <div>
            <dt>Max output</dt>
            <dd>{model.maxOutputTokens ? `${fmtCompact(model.maxOutputTokens)} tokens` : "—"}</dd>
          </div>
          <div>
            <dt>Input</dt>
            <dd>{inputs.join(", ")}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{outputs.join(", ") || "—"}</dd>
          </div>
          <div>
            <dt>Supports</dt>
            <dd>
              {[
                model.capabilities.tools && "tools",
                model.capabilities.reasoning && (model.reasoningMandatory ? "reasoning (always on)" : "reasoning"),
                model.capabilities.structuredOutput && "structured output",
              ]
                .filter(Boolean)
                .join(", ") || "—"}
            </dd>
          </div>
          <div>
            <dt>Weights</dt>
            <dd>{model.openWeights ? "open" : "closed"}</dd>
          </div>
        </dl>
        <p className="fine">Capabilities are unions across OpenRouter's providers; a specific provider may lack one.</p>
      </section>

      <section className="section" aria-labelledby="scores-h">
        <div className="section-title">
          <h2 id="scores-h">Capability scores</h2>
        </div>
        <dl className="spec-grid">
          {INDEXES.map((i) => {
            const s = scoreOf(model, i);
            const r = rankOf(model, i);
            return (
              <div key={i}>
                <dt>AA {INDEX_LABEL[i]}</dt>
                <dd>
                  {s === null ? <NotRated /> : s.toFixed(1)}
                  {r && <span className="rank"> · #{r.rank} of {r.of}</span>}
                </dd>
              </div>
            );
          })}
        </dl>
        <p className="fine">
          Artificial Analysis indices via OpenRouter, snapshot {CATALOG_META.asOf}. AA rescales between versions; don't
          compare scores across snapshots.
        </p>
      </section>

      <section className="section" aria-labelledby="prices-h">
        <div className="section-title">
          <h2 id="prices-h">Price lists</h2>
          <span className="count">USD per 1M tokens</span>
        </div>
        <div className="table-frame">
          <table className="market">
            <thead>
              <tr>
                <th>Mode</th>
                <th className="n">Input</th>
                <th className="n">Output</th>
                <th className="n">Cache read</th>
                <th className="n">Cache write</th>
                <th className="n">1-hour write</th>
              </tr>
            </thead>
            <tbody>
              {model.rates.map(([mode, card]) => (
                <PriceRows key={mode} mode={mode} card={card} today={today} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="cost-h">
        <div className="section-title">
          <h2 id="cost-h">Cost at common workloads</h2>
        </div>
        <div className="table-frame">
          <table className="market">
            <thead>
              <tr>
                <th>Workload</th>
                <th className="n">$ / 1K requests</th>
                <th className="n">$ / month</th>
                <th className="n">Cost rank</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {atPresets.map((a) => (
                <tr key={a.preset.id}>
                  <td>
                    <Link className="row-link" to={`/tools/cost?m=${encodeKey(model.key)}&p=${a.preset.id}`} state={INTERNAL}>
                      {a.preset.label}
                    </Link>
                  </td>
                  <td className="n col-cost">{fmtUsd(a.me.per1k)}</td>
                  <td className="n">{fmtMoney(a.me.breakdown.monthlyCost)}</td>
                  <td className="n">
                    #{a.rank} of {a.of}
                  </td>
                  <td className="breaks">
                    {a.onFront ? (
                      <span className="down">
                        <Mark kind="best" /> on the AA Intelligence frontier
                      </span>
                    ) : scoreOf(model, "intelligence") === null ? (
                      "not rated"
                    ) : (
                      "something cheaper scores at least as high"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {alts.length > 0 && (
          <p className="fine">
            As a coding agent, cheaper with the same capabilities and at least its AA Intelligence:{" "}
            {alts.map((a, i) => (
              <span key={a.model.key}>
                {i > 0 && ", "}
                <Link to={modelPath(a.model.key)}>{a.model.displayName}</Link> ({fmtUsd(a.per1k)} / 1K)
              </span>
            ))}
            .
          </p>
        )}
        <p className="fine">
          List-price cost at each preset's workload, not cost per task; prices as of {CATALOG_META.asOf}. Rank 1 is the
          cheapest of all {MODELS.length} models.
        </p>
      </section>
    </>
  );
}

function PriceRows({ mode, card, today }: { mode: string; card: RateCard; today: string }) {
  const promoLive = card.promo && card.promo.until >= today;
  return (
    <>
      <tr>
        <td>{mode}</td>
        <td className="n">{rate(card.input)}</td>
        <td className="n">{rate(card.output)}</td>
        <td className="n">{rate(card.cacheRead)}</td>
        <td className="n">{rate(card.cacheWrite)}</td>
        <td className="n">{rate(card.cacheWrite1h)}</td>
      </tr>
      {card.tiers.map((t) => (
        <tr key={t.aboveInputTokens} className="sub-row">
          <td>above {fmtCompact(t.aboveInputTokens)} input</td>
          <td className="n">{rate(t.input)}</td>
          <td className="n">{rate(t.output)}</td>
          <td className="n">{rate(t.cacheRead)}</td>
          <td className="n" colSpan={2}>
            whole request at this tier
          </td>
        </tr>
      ))}
      {promoLive && card.promo && (
        <tr className="sub-row">
          <td>promo until {card.promo.until}</td>
          <td className="n">{rate(card.promo.input)}</td>
          <td className="n">{rate(card.promo.output)}</td>
          <td colSpan={3} />
        </tr>
      )}
    </>
  );
}

/** A delisted model keeps its URL: what it was, its last price, and where to go next. */
function Tombstone({ modelKey }: { modelKey: string }) {
  const [entry, setEntry] = useState<Change | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    import("../tape.ts").then(({ TAPE }) => {
      if (live) setEntry(TAPE.filter((c) => c.key === modelKey && c.kind === "removed").at(-1) ?? null);
    });
    return () => {
      live = false;
    };
  }, [modelKey]);

  if (entry === undefined) return <p className="loading">Loading…</p>;
  if (entry === null)
    return (
      <div className="not-found">
        <title>Model not found — LMOmnibus</title>
        <span className="eyebrow">404</span>
        <h1>No model with the key {modelKey}.</h1>
        <p>
          <Link to="/tools/cost">Search the Cost Calculator</Link>
        </p>
      </div>
    );
  return (
    <>
      <title>{`${entry.name} (no longer listed) — LMOmnibus`}</title>
      <div className="tool-head">
        <span className="eyebrow">Model · {entry.vendor} · no longer listed</span>
        <h1>{entry.name}</h1>
        <p className="model-byline mono">
          {entry.key} · delisted in the {entry.date} snapshot
          {entry.last && ` · last seen at ${fmtRate(new Big(entry.last.input))} in / ${fmtRate(new Big(entry.last.output))} out per 1M tokens`}
        </p>
        <p className="sub">This model is no longer in the catalog. Find a replacement at your workload:</p>
        <p className="model-actions">
          <Link className="btn btn-primary" to="/tools/frontier">
            Open the Frontier
          </Link>
          <Link className="btn btn-ghost" to="/changes">
            See the ledger
          </Link>
        </p>
      </div>
    </>
  );
}

