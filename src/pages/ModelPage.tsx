import Big from "big.js";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { FallbackMark, Mark, Meter, NotRated, RetireTag, SourceTag, WEIGHTS_READ_ON } from "../components.tsx";
import { allModels, CATALOG_META, modelByKey } from "../core/catalog.ts";
import type { Change } from "../core/changes.ts";
import { NOTE_TEXT, type CostNote } from "../core/cost.ts";
import { todayIso } from "../core/date.ts";
import { fmtCompact, fmtInt, fmtMoney, fmtRate, fmtUsd } from "../core/fmt.ts";
import { alternatives, dominatedBy, fits, frontier, INDEX_LABEL, priceAll, scoreOf, type Index } from "../core/frontier.ts";
import { inputModalities, yearMonth, type Model, type RateCard } from "../core/model.ts";
import { openMatch, sideOf, type OpenMatch } from "../core/openclosed.ts";
import { PRESETS } from "../core/presets.ts";
import { encodeKey } from "../core/share.ts";
import { LICENCE_CLASS_LABEL, licenceHref, type NativeFormat, type WeightsRecord } from "../core/weights.ts";

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
  // Keyed, so the lazily loaded weights data starts over on each model.
  if (model) return <SpecSheet key={model.key} model={model} />;
  return key ? <Tombstone modelKey={key} /> : <NoSuchModel modelKey="" />;
}

function NoSuchModel({ modelKey }: { modelKey: string }) {
  return (
    <div className="not-found">
      <title>Model not found — LMOmnibus</title>
      <span className="eyebrow">404</span>
      <h1>{modelKey ? `No model with the key ${modelKey}.` : "Which model?"}</h1>
      <p>
        <Link to="/tools/cost">Search the Cost Calculator</Link>
      </p>
    </div>
  );
}

/** Short cell marks for engine notes, with the full text on hover. */
const NOTE_MARK: Record<CostNote, string> = {
  "no-cache-price": "no cache rate",
  "storage-fee-not-modelled": "storage fee",
  "batch-unavailable": "no batch",
  "tier-crossed": "tier",
  "no-1h-write-price": "no 1h write",
};

function SpecSheet({ model }: { model: Model }) {
  const today = todayIso();
  const inputs = inputModalities(model);
  const outputs = model.modality.split("->")[1]?.split("+") ?? [];
  const atPresets = useMemo(
    () =>
      PRESETS.map((p) => {
        const priced = priceAll(MODELS, p.workload, p.rate, today);
        const me = priced.find((x) => x.model.key === model.key)!;
        // Rank only among models that can take this workload at all.
        const able = priced.filter((x) => fits(x.model, p.workload));
        const rank = able.filter((x) => x.cost < me.cost).length + 1;
        const onFront = frontier(able, "intelligence").some((x) => x.model.key === model.key);
        const beatenBy = dominatedBy(me, able, "intelligence");
        return { preset: p, me, rank, of: able.length, onFront, beatenBy, fitsIt: fits(model, p.workload), priced: able };
      }),
    [model, today],
  );
  const agent = atPresets.find((a) => a.preset.id === "agent")!;
  const alts = alternatives(agent.me, agent.priced, "intelligence", agent.preset.workload, 3);
  const benchHref = `/tools/cost?m=${encodeKey(model.key)}&p=agent`;
  // A closed model's cheapest open-weight match as a coding agent (same score or higher, same capabilities).
  const match = useMemo(
    () =>
      sideOf(model) === "closed" && agent.fitsIt && scoreOf(model, "intelligence") !== null
        ? openMatch(agent.me, agent.priced, "intelligence", agent.preset.workload, today, 0, "any")
        : null,
    [model, agent, today],
  );
  const weights = useWeightsView(model);

  return (
    <>
      <title>{`${model.displayName} pricing and specs — LMOmnibus`}</title>
      <div className="tool-head">
        <span className="eyebrow">Model · {model.vendorName}</span>
        <h1>{model.displayName}</h1>
        <p className="model-byline mono">
          {model.key} <SourceTag model={model} /> · listed {model.listedOn ?? yearMonth(model.released)}
          {model.knowledgeCutoff ? ` · cutoff ${model.knowledgeCutoff}` : ""}
          {model.openWeights && model.weights ? ` · open-weight · ${model.weights.licenceLabel}` : ""}{" "}
          <RetireTag model={model} today={today} />
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
        <dl className="spec-grid six">
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
            <dd>
              <WeightsCell model={model} />
            </dd>
          </div>
        </dl>
        <p className="fine">Capabilities are unions across OpenRouter's providers; a specific provider may lack one.</p>
      </section>

      {model.weightsStatus !== "closed" && <WeightsSection model={model} view={weights} />}

      <section className="section" aria-labelledby="scores-h">
        <div className="section-title">
          <h2 id="scores-h">Capability scores</h2>
        </div>
        <dl className="spec-grid three">
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
        {model.rates.some(([, card]) => card.checked) && (
          <p className="fine">
            On a “list” price list, input and output are checked by hand against the vendor; cache prices are
            OpenRouter's.
          </p>
        )}
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
                  {a.fitsIt ? (
                    <>
                      <td className="n col-cost">
                        {fmtUsd(a.me.per1k)}
                        <FallbackMark breakdown={a.me.breakdown} />
                        {a.me.breakdown.notes
                          .filter((n) => n !== "batch-unavailable")
                          .map((n) => (
                            <span key={n} className="cell-mark" title={NOTE_TEXT[n]}>
                              {NOTE_MARK[n]}
                            </span>
                          ))}
                      </td>
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
                        ) : a.beatenBy ? (
                          <>
                            <Link to={modelPath(a.beatenBy.model.key)}>{a.beatenBy.model.displayName}</Link>{" "}
                            {a.beatenBy.cost < a.me.cost ? "costs less" : "costs the same"} and scores at least as high
                          </>
                        ) : (
                          "tied on the frontier"
                        )}
                      </td>
                    </>
                  ) : (
                    <td className="n na" colSpan={4}>
                      doesn't fit — needs {fmtCompact(a.preset.workload.inputTokens + a.preset.workload.outputTokens)} tokens
                    </td>
                  )}
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
                <Link to={modelPath(a.model.key)}>{a.model.displayName}</Link>{" "}
                <span className="mono">{fmtUsd(a.per1k)} / 1K</span> <SourceTag model={a.model} mode={a.breakdown.mode} />
              </span>
            ))}
            .
          </p>
        )}
        {match && <OpenMatchLine model={model} match={match} />}
        <p className="fine">
          List-price cost at each preset's workload, not cost per task; prices as of {CATALOG_META.asOf}. Rank 1 is the
          cheapest of all {MODELS.length} models.
        </p>
      </section>

      {model.weightsStatus === "open" && <SelfHostSection model={model} view={weights} />}
    </>
  );
}

// ---------------------------------------------------------------- weights and self-hosting

const hfUrl = (id: string) => `https://huggingface.co/${id}`;

/** "open · permissive" linking the repo, "closed (API only)", or "unverified" with the reason. */
function WeightsCell({ model }: { model: Model }) {
  if (model.weightsStatus === "unverified") {
    return (
      <>
        unverified <span className="rank">· {model.weights ? "repo couldn't be opened" : "repo not read yet"}</span>
      </>
    );
  }
  if (!model.openWeights) {
    return (
      <>
        closed <span className="rank">(API only)</span>
      </>
    );
  }
  const cls = model.weights ? LICENCE_CLASS_LABEL[model.weights.licence].toLowerCase() : null;
  const text = cls ? `open · ${cls}` : "open";
  return model.hfId ? (
    <a href={hfUrl(model.hfId)} rel="noopener">
      {text}
    </a>
  ) : (
    text
  );
}

const NATIVE_LABEL: Record<NativeFormat, string> = {
  bf16: "BF16",
  fp16: "FP16",
  f32: "F32",
  fp8: "FP8",
  int4: "INT4",
  mxfp4: "MXFP4",
  fp4: "FP4 experts",
  gguf: "GGUF",
};

const PARAMS_SOURCE: Record<WeightsRecord["paramsSource"], string> = {
  safetensors: "Hugging Face safetensors metadata",
  headers: "safetensors headers",
  gguf: "GGUF header",
  pickle: "PyTorch checkpoint index",
  mirror: "a public copy's safetensors metadata",
  override: "set by hand from the model card",
};

const ACTIVE_SOURCE: Record<NonNullable<WeightsRecord["active"]>["source"], string> = {
  card: "model card",
  name: "model name",
  headers: "expert split in the checkpoint",
};

/** 32.8B, 1.60T, 600M. */
function fmtParams(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)}B`;
  return `${Math.round(n / 1e6)}M`;
}

/** A licence link from the record: absolute, a file in the repo, or the repo itself. */
interface SelfHostView {
  columns: string[];
  rows: { label: string; cells: { need: string; range: string; setup: string }[] }[];
  mac: string | null;
  /** Set when the longest column is past the config's own maximum. */
  rope: string | null;
  settings: string;
  ladder: string;
}

interface WeightsView {
  record: WeightsRecord | null;
  arch: string | null;
  kv: string | null;
  selfHost: SelfHostView | null;
}

const KV_CONFIDENCE = {
  high: "KV-cache layout known with high confidence.",
  medium: "KV-cache layout approximate (medium confidence): the memory range is wider.",
  low: "KV-cache layout uncertain (low confidence): the memory range is much wider.",
} as const;

type WeightsLib = typeof import("../weightsData.ts");
type SelfHostLib = typeof import("../core/selfhost.ts");

function buildView(model: Model, w: WeightsLib, sh: SelfHostLib): WeightsView {
  const record = w.recordFor(model);
  const a = record?.arch ?? null;
  const vm = w.vramModelFor(model);
  let selfHost: SelfHostView | null = null;
  if (vm) {
    const t = sh.selfHostTable(vm, model.contextTokens);
    const ctxLabel = sh.fmtCtx;
    selfHost = {
      columns: t.contexts.map((c) => (c === t.max ? `${ctxLabel(c)} (max)` : ctxLabel(c))),
      rows: t.rows.map((r) => ({
        label: r.label,
        cells: r.cells.map((c) => ({
          need: `≈ ${sh.fmtNeed(c.need.mid)}`,
          range: `${sh.fmtNeed(c.need.low).replace(/ (GiB|MiB)$/, "")}–${sh.fmtNeed(c.need.high)}`,
          setup: sh.setupLabel(c.setup),
        })),
      })),
      mac: t.mac
        ? t.mac.ramGb
          ? `On a Mac at the default GPU cap, ${t.mac.format} at ${ctxLabel(t.mac.ctx)} needs a ${t.mac.ramGb} GB machine.`
          : `On a Mac at the default GPU cap, ${t.mac.format} at ${ctxLabel(t.mac.ctx)} needs more than any Mac we list.`
        : null,
      rope:
        a?.maxPositions && t.max > a.maxPositions
          ? `Past ${fmtInt(a.maxPositions)} tokens (the config's maximum) the model needs RoPE scaling${a.rope ? ` (${a.rope.type} ×${a.rope.factor})` : ""}; OpenRouter's providers serve up to ${fmtInt(model.contextTokens)}.`
          : null,
      settings: sh.PAGE_SETTINGS_TEXT,
      ladder: sh.LADDER_TEXT,
    };
  }
  return {
    record,
    arch: a ? sh.archSummary(a) : null,
    kv: a ? [KV_CONFIDENCE[a.kv.confidence], ...a.kv.notes].join(" ") : null,
    selfHost,
  };
}

/**
 * The Hugging Face record and the memory table, loaded on demand: the
 * architecture data is too big for every page's bundle. undefined while
 * loading; null if the chunk couldn't load.
 */
function useWeightsView(model: Model): WeightsView | null | undefined {
  const [view, setView] = useState<WeightsView | null | undefined>(undefined);
  useEffect(() => {
    if (model.weightsStatus === "closed") return;
    let live = true;
    Promise.all([import("../weightsData.ts"), import("../core/selfhost.ts")])
      .then(([w, sh]) => {
        if (live) setView(buildView(model, w, sh));
      })
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [model]);
  return view;
}

function WeightsSection({ model, view }: { model: Model; view: WeightsView | null | undefined }) {
  const w = model.weights;
  const r = view?.record ?? null;
  const pending = view === undefined ? "…" : "—";
  if (model.weightsStatus === "unverified" || !w) {
    const who = model.opennessSource ? "Our hand-checked list links" : "OpenRouter links";
    const repo = model.hfId ? <> (<span className="mono">{model.hfId}</span>)</> : null;
    return (
      <section className="section" aria-labelledby="weights-h">
        <div className="section-title">
          <h2 id="weights-h">Weights</h2>
        </div>
        <p className="fine">
          {model.weights
            ? <>{who} a Hugging Face repo{repo} we couldn't open on {r?.checkedOn ?? WEIGHTS_READ_ON}</>
            : <>{who} a Hugging Face repo{repo} we haven't read yet</>}
          , so this page doesn't size its weights, and the open-weight vs closed comparison leaves it out of both
          sides.
          {r?.notes.length ? ` ${r.notes.join(" ")}` : ""}
        </p>
      </section>
    );
  }
  const a = r?.arch ?? null;
  // Notes already name the public copy a gated repo was read from; say it here only when they don't.
  const [via, viaId] = r ? (r.source.split(/:(.*)/) as [string, string?]) : ["repo"];
  const viaNoted = viaId ? r!.notes.some((n) => n.includes(viaId)) : true;
  return (
    <section className="section" aria-labelledby="weights-h">
      <div className="section-title">
        <h2 id="weights-h">Weights</h2>
        {model.hfId && (
          <a className="count repo-link" href={hfUrl(r?.resolvedId ?? model.hfId)} rel="noopener">
            {r?.resolvedId ?? model.hfId} on Hugging Face
          </a>
        )}
      </div>
      <dl className="spec-grid six" aria-busy={view === undefined}>
        <div>
          <dt>Parameters</dt>
          <dd>
            {fmtParams(w.total)}
            {r && <span className="rank"> · {PARAMS_SOURCE[r.paramsSource]}</span>}
          </dd>
        </div>
        <div>
          <dt>Active per token</dt>
          <dd>
            {w.moe ? (
              w.active ? (
                <>
                  {fmtParams(w.active)}
                  {r?.active && <span className="rank"> · from the {ACTIVE_SOURCE[r.active.source]}</span>}
                </>
              ) : (
                <span className="na">not published</span>
              )
            ) : (
              <>
                all <span className="rank">(dense)</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd className="spec-long">{view?.arch ?? pending}</dd>
        </div>
        <div>
          <dt>Published as</dt>
          <dd>
            {NATIVE_LABEL[w.native]}
            {r?.checkpointBytes ? <span className="rank"> · {(r.checkpointBytes / 1e9).toFixed(1)} GB checkpoint</span> : null}
            {r?.ggufFiles?.length ? <span className="rank"> · {r.ggufFiles.length} GGUF files</span> : null}
          </dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>
            {r ? (
              <a href={licenceHref(r)} rel="noopener">
                {w.licenceLabel}
              </a>
            ) : (
              w.licenceLabel
            )}
            <span className="rank"> · {LICENCE_CLASS_LABEL[w.licence].toLowerCase()}</span>
            {w.gated && <span className="rank"> · gated: accept the terms on Hugging Face</span>}
          </dd>
        </div>
        <div>
          <dt>Max context</dt>
          <dd>
            config {a?.maxPositions ? fmtInt(a.maxPositions) : pending}
            <span className="rank"> · OpenRouter {fmtInt(model.contextTokens)}</span>
          </dd>
        </div>
      </dl>
      <p className="fine">
        Open-weight: the trained weights can be downloaded — OpenRouter, or our hand-checked list, links a Hugging Face
        repo we could open on {r?.checkedOn ?? WEIGHTS_READ_ON}. That's narrower than open source: training data and code
        are rarely published, and the licence decides what you may do with the weights.
      </p>
      {r && (
        <p className="fine">
          Architecture from Hugging Face:{" "}
          <span className="mono">
            {r.resolvedId}
            {r.sha ? `@${r.sha.slice(0, 7)}` : ""}
          </span>
          , read {r.checkedOn}
          {via === "mirror" && !viaNoted ? `, config from the public copy ${viaId} (same parameter total)` : ""}
          {via === "donor" && !viaNoted ? `, layout from ${viaId} (the same weights in another format)` : ""}. Vision, MTP
          and lookup sizes {r.groups.source === "headers" ? "from the safetensors headers" : "estimated from config.json"};
          embedding, head and expert sizes from config.json.
          {view?.kv ? ` ${view.kv}` : ""}
          {r.notes.length ? ` ${r.notes.join(" ")}` : ""}
          {w.moe && " Vendors count active parameters differently."}
        </p>
      )}
      {model.opennessSource && <p className="fine">Openness set by hand · {model.opennessSource}</p>}
      <p className="fine">
        Licences are grouped by the licence named on Hugging Face, as we read it on {r?.checkedOn ?? WEIGHTS_READ_ON}.
        This is not legal advice: custom terms can add usage policies, user caps or attribution requirements. Read the
        licence.
      </p>
    </section>
  );
}

function SelfHostSection({ model, view }: { model: Model; view: WeightsView | null | undefined }) {
  const sh = view?.selfHost ?? null;
  const vramHref = `/tools/vram?m=${encodeKey(model.key)}`;
  return (
    <section className="section" aria-labelledby="selfhost-h">
      <div className="section-title">
        <h2 id="selfhost-h">Run it yourself</h2>
        <span className="est-stamp">Estimate</span>
      </div>
      {view === undefined ? (
        <p className="fine">Loading the memory estimates…</p>
      ) : view === null ? (
        <div className="empty-bench">Memory data unavailable in this build.</div>
      ) : !sh ? (
        <div className="empty-bench">No architecture data for this repo yet, so there's no memory estimate.</div>
      ) : (
        <>
          <div className="table-frame">
            <table className="market selfhost">
              <caption className="sr-only">
                Estimated GPU memory for {model.displayName} by weight format and engine at each context, with the
                smallest common GPU setup that holds it
              </caption>
              <thead>
                <tr>
                  <th scope="col">Weights · engine</th>
                  {sh.columns.map((c) => (
                    <th key={c} scope="col" className="n">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sh.rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    {r.cells.map((c, i) => (
                      <td key={sh.columns[i]} className="n">
                        <span className="need">{c.need}</span>
                        <span className="vd range">{c.range}</span>
                        <span className="vd">
                          <span className="sr-only">smallest setup: </span>
                          {c.setup}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sh.mac && <p className="fine">{sh.mac}</p>}
          {sh.rope && <p className="fine">{sh.rope}</p>}
          <p className="fine">
            {sh.settings}. The setup is the first of {sh.ladder} that holds the top of the estimate's range; llama.cpp
            keeps the token embeddings in system RAM. 1 GiB = 2<sup>30</sup> bytes; GPU sizes are what the driver
            reports, checkpoint and file sizes are decimal GB.{" "}
            <Link to={vramHref} state={INTERNAL} onClick={() => trackEvent("Model", "To VRAM", model.key)}>
              Estimates — open the VRAM Estimator for your setup
              <Mark kind="to" />
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

/** "+1.1", "−2.0", "±0.0". */
const fmtDelta = (d: number) => (d === 0 ? "±0.0" : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`);
const fmtRatio = (r: number) => (r >= 10 ? r.toFixed(0) : r >= 1 ? r.toFixed(1) : r.toFixed(2));

/** "(▼ 0.03×)" — pine and ▼ when the open-weight model is cheaper, brick and ▲ when it costs more. */
function CostRatio({ ratio }: { ratio: number }) {
  const dir = ratio < 1 ? "down" : ratio > 1 ? "up" : null;
  return (
    <span className={dir ?? undefined}>
      ({dir && <Mark kind={dir} />}
      <span className="sr-only">{dir === "down" ? "cheaper: " : dir === "up" ? "pricier: " : ""}</span>
      <span className="mono">{fmtRatio(ratio)}×</span>)
    </span>
  );
}

/** For a closed model: the cheapest open-weight model that scores as high with the same capabilities. */
function OpenMatchLine({ model, match }: { model: Model; match: OpenMatch }) {
  const pick = match.match ?? match.nearest;
  const score = scoreOf(model, "intelligence")!;
  const lead = match.match
    ? "Open-weight match as a coding agent: "
    : `No open-weight model with its tools, reasoning and image input scores ${score.toFixed(1)} yet; nearest `;
  return (
    <p className="fine open-match">
      {pick ? (
        <>
          {lead}
          <Link to={modelPath(pick.model.key)}>{pick.model.displayName}</Link> (AA{" "}
          <span className="mono">
            {scoreOf(pick.model, "intelligence")!.toFixed(1)}, {fmtDelta(match.scoreDelta ?? 0)}
          </span>
          ) at <span className="mono">{fmtUsd(pick.per1k)}</span> per 1K{" "}
          <SourceTag model={pick.model} mode={pick.breakdown.mode} />
          {match.costRatio !== null && (
            <>
              {" "}
              <CostRatio ratio={match.costRatio} />
            </>
          )}
          .
        </>
      ) : (
        "No open-weight model keeps its tools, reasoning and image input at this workload."
      )}{" "}
      <Link
        to={`/tools/open?vs=${encodeKey(model.key)}&p=agent`}
        state={INTERNAL}
        onClick={() => trackEvent("Model", "To open vs closed", model.key)}
      >
        Open weights vs closed
        <Mark kind="to" />
      </Link>{" "}
      Open-weight prices are mostly OpenRouter's listing, often the cheapest of several providers; others can charge
      more.
    </p>
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
    import("../tape.ts")
      .then(({ TAPE }) => {
        if (live) setEntry(TAPE.filter((c) => c.key === modelKey && c.kind === "removed").at(-1) ?? null);
      })
      .catch(() => live && setEntry(null));
    return () => {
      live = false;
    };
  }, [modelKey]);
  // The heading arrives after the tape loads; move focus there like any page change.
  useEffect(() => {
    if (entry === undefined) return;
    const h = document.querySelector<HTMLElement>("main h1");
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }, [entry]);

  if (entry === undefined)
    return (
      <>
        <title>{`${modelKey} — LMOmnibus`}</title>
        <h1 className="sr-only">{modelKey}</h1>
        <p className="loading">Loading…</p>
      </>
    );
  if (entry === null) return <NoSuchModel modelKey={modelKey} />;
  return (
    <>
      <title>{`${entry.name} (no longer listed) — LMOmnibus`}</title>
      <div className="tool-head">
        <span className="eyebrow">Model · {entry.vendor} · no longer listed</span>
        <h1>{entry.name}</h1>
        <p className="model-byline mono">
          {entry.key} · delisted in the {entry.date} snapshot
          {entry.last && (
            <>
              {` · last seen at ${fmtRate(new Big(entry.last.input))} in / ${fmtRate(new Big(entry.last.output))} out per 1M tokens${entry.last.mode ? ` (${entry.last.mode})` : ""} `}
              <span className={`src-tag ${entry.last.provenance === "FirstParty" ? "list" : "agg"}`}>
                {entry.last.provenance === "FirstParty" ? "list" : "via OR"}
              </span>
            </>
          )}
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

