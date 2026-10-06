import { useDeferredValue, useMemo, useState, type RefObject } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.ts";
import { Mark, NotRated, SourceTag } from "../../components.tsx";
import { todayIso } from "../../core/date.ts";
import { fmtUsd } from "../../core/fmt.ts";
import { INDEX_LABEL, priceAll, scoreOf, type Index, type Priced } from "../../core/frontier.ts";
import type { Model } from "../../core/model.ts";
import { presetById } from "../../core/presets.ts";
import { encodeScenario } from "../../core/share.ts";
import {
  estimate,
  fmtCtx,
  formatLabel,
  maxContext,
  VERDICT_LABEL,
  type FormatId,
  type VramEstimate,
} from "../../core/vram.ts";
import { WEIGHTS_AS_OF } from "../../weightsData.ts";
import { ContextControl } from "./Context.tsx";
import { EngineSeg, HardwarePicker, KvSeg } from "./controls.tsx";
import { cheapestFix, type Fix } from "./moves.ts";
import { COUNTS, DEFAULT_CTX, FIT_FORMATS, fitFormat, MODELS, resolve, type Count, type Resolved, type VramState } from "./state.ts";
import { capText, g1, ggufTag, rangeText, rigText, unconfirmed } from "./text.ts";
import { NumberField } from "../../NumberField.tsx";

const INTERNAL = { internal: true };
const AGENT = presetById("agent")!;
/** The longest context offered here: 1M tokens. */
const FIT_MAX = 1024 * 1024;

/** Approximate bits, to pick a model's nearest smaller format when it doesn't offer the chosen one. */
const BITS: Partial<Record<FormatId, number>> = {
  q8_0: 8.5, q6_k: 6.57, q5_k_m: 5.67, q4_k_m: 4.81, iq4_xs: 4.26, q3_k_m: 3.84, q2_k: 2.93,
  native: 99, fp8: 8, int8: 8, int4: 4.16, nvfp4: 4.5, mlx8: 8.5, mlx6: 6.5, mlx4: 4.5, mlx3: 3.5,
};

interface FitRow {
  m: Model;
  r: Resolved;
  e: VramEstimate;
  score: number | null;
  /** The format used, when it isn't the one chosen. */
  swapped: string | null;
  state: VramState;
}

/**
 * This model's state for the chosen generic format: the same, or the nearest
 * smaller one it's offered in; under tensor parallelism, the most GPUs that
 * split its heads. `swapped` says what changed, for the row.
 */
function stateFor(st: VramState, m: Model, wanted: FormatId): { state: VramState; swapped: string | null } {
  let state: VramState = { ...st, view: "will", model: m.key, format: null, fileGB: null, bpw: null, vis: null, mtp: false, cpu: false, swaFull: false, lut: true };
  const probe = resolve(state);
  if (!probe.vm) return { state, swapped: null };
  const notes: string[] = [];
  if (probe.engine === "vllm" && probe.device.cls !== "unified") {
    const ok = COUNTS.filter((n) => n <= st.count && probe.vm!.dims.heads % n === 0).pop() ?? 1;
    if (ok !== st.count) {
      state = { ...state, count: ok };
      notes.push(`on ${ok} GPU${ok === 1 ? "" : "s"} (its heads don't split ${st.count} ways)`);
    }
  }
  const opts = probe.formats.filter((o) => !o.disabled);
  const want = BITS[wanted] ?? 4.8;
  const sorted = [...opts].sort((a, b) => b.bits - a.bits);
  const pick = opts.find((o) => o.id === wanted && !o.file) ?? sorted.find((o) => o.bits <= want + 0.3) ?? sorted[sorted.length - 1];
  if (pick?.file) {
    state = { ...state, format: "file", fileGB: pick.file.bytes / 1e9 };
    notes.unshift(`at ${ggufTag(pick.file.name)}`);
  } else if (pick) {
    state = { ...state, format: pick.id };
    if (pick.id !== wanted) notes.unshift(`at ${pick.label}`);
  }
  return { state, swapped: notes.length ? notes.join(" · ") : null };
}

export function FitsView({
  st,
  r,
  update,
  remember,
  onOpen,
  headingRef,
}: {
  st: VramState;
  r: Resolved;
  update: (patch: Partial<VramState>) => void;
  /** An update that also remembers the device and engine for next time. */
  remember: (patch: Partial<VramState>) => void;
  /** Opens a row in "Will it fit?" with the state it was estimated with. */
  onOpen: (row: VramState) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const today = todayIso();
  const engine = r.engine;
  const wanted = fitFormat(st, engine);
  const ctx = Math.min(st.ctx ?? DEFAULT_CTX, FIT_MAX);
  const index = st.index;
  const label = INDEX_LABEL[index];
  const [showUnrated, setShowUnrated] = useState(false);
  // Typing in the context or sequence field shouldn't wait on 160 estimates.
  const deferred = useDeferredValue(st);

  const prices = useMemo(() => {
    const map = new Map<string, Priced>();
    for (const p of priceAll(MODELS.filter((m) => m.weightsStatus !== "closed"), AGENT.workload, AGENT.rate, today)) map.set(p.model.key, p);
    return map;
  }, [today]);

  const data = useMemo(() => {
    const dWanted = fitFormat(deferred, resolve(deferred).engine);
    const dCtx = Math.min(deferred.ctx ?? DEFAULT_CTX, FIT_MAX);
    const rows: FitRow[] = [];
    const cant: { m: Model; reason: string }[] = [];
    for (const m of MODELS) {
      if (m.weightsStatus === "closed") continue;
      // An unset context stays unset, so a row opened in "Will it fit?" gets min(32K, its maximum) as it did here.
      const { state, swapped } = stateFor({ ...deferred, ctx: deferred.ctx === null ? null : dCtx }, m, dWanted);
      const rr = resolve(state);
      if (!rr.vm || !rr.settings) {
        cant.push({ m, reason: rr.problem ?? "No architecture record." });
        continue;
      }
      const e = estimate(rr.vm, rr.settings);
      rows.push({ m, r: rr, e, score: scoreOf(m, index), swapped, state });
    }
    const byScore = (a: FitRow, b: FitRow) => (b.score ?? -1) - (a.score ?? -1) || a.e.need.mid - b.e.need.mid;
    const fits = rows.filter((x) => x.e.verdict === "fits" && x.score !== null).sort(byScore);
    const tight = rows.filter((x) => x.e.verdict === "tight").sort(byScore);
    const over = rows.filter((x) => x.e.verdict === "just-over").sort(byScore);
    const unrated = rows.filter((x) => x.e.verdict === "fits" && x.score === null).sort((a, b) => a.m.displayName.localeCompare(b.m.displayName));
    const wont = rows.filter((x) => x.e.verdict === "wont-fit" && x.score !== null).length;
    const rated = rows.filter((x) => x.score !== null).length;
    const best = fits[0] ?? null;
    // The step up: of the rated models that score higher than the best that fits, the one closest to fitting.
    const next =
      rows
        .filter((x) => x.e.verdict !== "fits" && x.score !== null && (!best || x.score > best.score!))
        .sort((a, b) => a.e.need.mid - b.e.need.mid || b.score! - a.score!)[0] ?? null;
    return { rows, fits, tight, over, unrated, wont, rated, cant, best, next, ctx: dCtx };
  }, [deferred, index]);

  const fixes = useMemo(() => {
    const map = new Map<string, Fix | null>();
    for (const x of [...data.over, ...(data.next ? [data.next] : [])]) map.set(x.m.key, cheapestFix(x.state, x.r, x.e));
    return map;
  }, [data]);

  const maxes = useMemo(() => {
    const map = new Map<string, ReturnType<typeof maxContext>>();
    for (const x of [...data.fits, ...data.tight, ...data.over, ...(showUnrated ? data.unrated : [])]) {
      map.set(x.m.key, maxContext(x.r.vm!, x.r.settings!, x.r.maxCtx, "mid"));
    }
    return map;
  }, [data, showUnrated]);

  const device = r.device;
  const count = device.cls === "unified" ? 1 : st.count;
  const rig = rigText(device, count);
  const benchKeys = data.fits.slice(0, 12).map((x) => x.m.key);
  const benchHref = `/tools/cost?${encodeScenario({ models: benchKeys, preset: "agent", workload: AGENT.workload, rate: AGENT.rate, modes: new Map(), index })}`;
  const nextFix = data.next ? fixes.get(data.next.m.key) : null;

  const table = (rows: FitRow[], showFix = false) => (
    <div className="table-frame">
      <table className="market vr-fits">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col" className="n">
              AA {label}
            </th>
            <th scope="col" className="n">
              ≈ GiB
            </th>
            <th scope="col" className="vr-opt">
              Verdict
            </th>
            <th scope="col" className="n vr-opt">
              Max context
            </th>
            <th scope="col" className="vr-opt">
              Licence
            </th>
            <th scope="col" className="n vr-opt">
              $ / 1K req
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const mx = maxes.get(x.m.key);
            const maxText = !mx ? "" : mx.limitedBy === "model" ? `model max ${fmtCtx(mx.tokens)}` : mx.limitedBy === "weights" ? "—" : `≈ ${fmtCtx(mx.tokens)}`;
            const maxShort = !mx || mx.limitedBy === "weights" ? "" : ` · max ${fmtCtx(mx.tokens)}`;
            const p = prices.get(x.m.key);
            const fix = showFix ? fixes.get(x.m.key) : null;
            return (
              <tr key={x.m.key}>
                <td>
                  <button
                    type="button"
                    className="row-btn"
                    onClick={() => {
                      trackEvent("VRAM", "Fit row", x.m.key);
                      onOpen(x.state);
                    }}
                    aria-label={`${x.m.displayName}: open in Will it fit?`}
                  >
                    {x.m.displayName}
                  </button>
                  <span className="vd">
                    {x.m.vendorName}
                    {x.swapped && ` · ${x.swapped}`}
                    {x.r.ctx < data.ctx && ` · at its max ${fmtCtx(x.r.ctx)}`}
                  </span>
                  <span className="vd vr-compact">
                    AA {x.score === null ? "not rated" : x.score.toFixed(1)} · ≈ {g1(x.e.need.mid)} GiB · {VERDICT_LABEL[x.e.verdict].toUpperCase()}
                    {maxShort}
                  </span>
                  {fix && <span className="vd vr-fix">fits {fix.text}</span>}
                </td>
                <td className="n">{x.score === null ? <NotRated /> : x.score.toFixed(1)}</td>
                <td className="n">
                  {g1(x.e.need.mid)}
                  <span className="vd">{rangeText(x.e.need)}</span>
                </td>
                <td className="vr-opt">
                  <span className={`vr-badge sm ${x.e.verdict}`}>{VERDICT_LABEL[x.e.verdict]}</span>
                </td>
                <td className="n vr-opt">{maxText}</td>
                <td className="vr-opt vr-lic">
                  {x.m.weights?.licenceLabel ?? "—"}
                  <span className="vd">{x.m.weights ? licenceClassShort(x.m.weights.licence) : ""}</span>
                </td>
                <td className="n vr-opt">
                  {p ? (
                    <>
                      {fmtUsd(p.per1k)} <SourceTag model={x.m} mode={p.breakdown.mode} />
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="vr-fit-view">
      <div className="vr-fit-controls">
        <HardwarePicker
          device={device}
          mem={st.mem}
          count={count as Count}
          engine={engine}
          vm={null}
          onDevice={(id) => {
            trackEvent("VRAM", "Device", id);
            remember({ device: id });
          }}
          onMem={(g) => remember({ mem: g })}
          onCount={(n) => {
            if (n > 1) trackEvent("VRAM", "GPU count", String(n));
            update({ count: n });
          }}
        />
        <div className="vr-fit-col">
          <EngineSeg
            engines={r.engines}
            engine={engine}
            onChange={(e) => {
              trackEvent("VRAM", "Engine", e);
              remember({ engine: e, format: null, kv: "f16" });
            }}
          />
          <div className="vr-field">
            <label className="il" htmlFor="vr-fit-fmt">
              Weights
            </label>
            <select
              id="vr-fit-fmt"
              className="vr-select"
              value={wanted}
              onChange={(e) => {
                trackEvent("VRAM", "Format", e.target.value);
                update({ format: e.target.value as FormatId });
              }}
            >
              {FIT_FORMATS[engine].map((f) => (
                <option key={f} value={f}>
                  {f === "native" ? "As published" : formatLabel(f)}
                </option>
              ))}
            </select>
            <span className="vr-hint">A model not published at this precision uses its nearest smaller format (shown on its row).</span>
          </div>
          <KvSeg
            engine={engine}
            kv={st.kv}
            onChange={(k) => {
              trackEvent("VRAM", "KV", k);
              update({ kv: k });
            }}
          />
        </div>
        <div className="vr-fit-col">
          <ContextControl value={ctx} max={FIT_MAX} native={null} rope={null} fitMax={null} slider={false} onChange={(c) => update({ ctx: c })} />
          <NumberField label="Concurrent sequences" value={st.seqs} onChange={(n) => update({ seqs: n })} min={1} max={256} step={1} />
          <div className="vr-field">
            <span className="il" id="vr-fit-idx">
              Rank by
            </span>
            <div className="seg" role="group" aria-labelledby="vr-fit-idx">
              {(Object.keys(INDEX_LABEL) as Index[]).map((i) => (
                <button key={i} type="button" aria-pressed={index === i} className={index === i ? "on" : ""} onClick={() => update({ index: i })}>
                  {INDEX_LABEL[i]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <section className="section" aria-labelledby="fit-h">
        <div className="section-title">
          <h2 id="fit-h" ref={headingRef} tabIndex={-1}>
            What fits {rig}?
          </h2>
          <span className="vr-stamp">Estimate</span>
        </div>
        <p className="readout">
          On {rig} ({capText(device.usableGiB)}
          {count > 1 ? " each" : ""}
          {unconfirmed(device) ? ", unconfirmed" : ""}) at <span className="mono">{fmtCtx(ctx)}</span> context with {wanted === "native" ? "the published" : formatLabel(wanted)}{" "}
          weights, <strong className="mono">{data.fits.length}</strong> of <span className="mono">{data.rated}</span> rated open-weight models fit.{" "}
          {data.best ? (
            <>
              Highest on AA {label}: <strong>{data.best.m.displayName}</strong> (<span className="mono">{data.best.score!.toFixed(1)}</span>), ≈{" "}
              <span className="mono">{g1(data.best.e.need.mid)}</span> GiB.
            </>
          ) : (
            <>None that's rated on AA {label} fits.</>
          )}{" "}
          {data.next && (
            <>
              Next up, <strong>{data.next.m.displayName}</strong> (<span className="mono">{data.next.score!.toFixed(1)}</span>), needs ≈{" "}
              <span className="mono">{g1(data.next.e.need.mid)}</span> GiB
              {nextFix ? <>: it fits {nextFix.text}.</> : <>, more than {count > 1 ? "these GPUs hold" : "this holds"}.</>}
            </>
          )}
        </p>
        <p className="fine">
          {st.seqs} sequence{st.seqs === 1 ? "" : "s"}, {st.kv === "f16" ? "16-bit" : st.kv.toUpperCase()} KV cache,{" "}
          {r.settings?.display ?? (device.cls === "consumer" || device.cls === "workstation") ? "a display attached" : "headless"}, the
          engine's own defaults; encoders and MTP layers not loaded.{" "}
          {data.wont === 1 ? "One of the rated ones doesn't" : `${data.wont} of the rated ones don't`} fit at all. Change any of it in
          "Will it fit?" for one model.
        </p>

        <div className="section-title vr-group-title">
          <h3>
            Fits <span className="count">{data.fits.length}, by AA {label}</span>
          </h3>
          {benchKeys.length > 0 && (
            <Link className="text-btn" state={INTERNAL} to={benchHref} onClick={() => trackEvent("VRAM", "To bench")}>
              Price {benchKeys.length === 12 ? "the top 12" : "these"} on the bench
              <Mark kind="to" />
            </Link>
          )}
        </div>
        {data.fits.length ? table(data.fits) : <div className="empty-note">No rated open-weight model fits this setup.</div>}

        {data.tight.length > 0 && (
          <>
            <h3 className="vr-group-title">
              Tight <span className="count">{data.tight.length}: the estimate fits, the top of its range doesn't</span>
            </h3>
            {table(data.tight)}
          </>
        )}
        {data.over.length > 0 && (
          <>
            <h3 className="vr-group-title">
              Just over <span className="count">{data.over.length}: only the bottom of the range fits</span>
            </h3>
            {table(data.over, true)}
          </>
        )}
        {data.unrated.length > 0 && (
          <details className="all-plotted" onToggle={(e) => setShowUnrated((e.target as HTMLDetailsElement).open)}>
            <summary>Fits, not rated on AA {label}: {data.unrated.length}</summary>
            {showUnrated && table(data.unrated)}
          </details>
        )}
        {data.cant.length > 0 && (
          <details className="all-plotted">
            <summary>Can't estimate: {data.cant.length}</summary>
            <ul className="vr-cant">
              {data.cant.map((c) => (
                <li key={c.m.key}>
                  <strong>{c.m.displayName}</strong> — {c.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="fine">
          $ / 1K requests is the list-price cost at the Coding agent preset, not cost per task, so a self-hosted model can be weighed
          against renting it. Most open-weight prices here are OpenRouter's listing, which is often the cheapest of several providers;
          other providers can charge several times more, and some serve lower-precision builds. AA scores describe each model's
          reference deployment, usually at the published precision; a 4-bit build on your machine may score lower. Scores are from
          one Artificial Analysis snapshot; model data from Hugging Face as of {WEIGHTS_AS_OF}.
        </p>
      </section>
    </div>
  );
}

function licenceClassShort(c: string): string {
  return { permissive: "permissive", custom: "custom terms", noncommercial: "non-commercial", unclassified: "unclassified" }[c] ?? c;
}
