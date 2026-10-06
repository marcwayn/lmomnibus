import "./vram.css";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { Meter } from "../components.tsx";
import { allModels } from "../core/catalog.ts";
import { todayIso } from "../core/date.ts";
import { DEVICES_CHECKED } from "../core/devices.ts";
import { cheapestAbove, priceAll } from "../core/frontier.ts";
import { presetById } from "../core/presets.ts";
import {
  ENGINE_CHECKED,
  estimate,
  fmtCtx,
  maxContext,
  partialOffloadLayers,
  VERDICT_LABEL,
  vllmBatchTokens,
  type FormatId,
  type VramEstimate,
} from "../core/vram.ts";
import { NumberField } from "../NumberField.tsx";
import { titleFor } from "../routes.ts";
import { WEIGHTS_AS_OF } from "../weightsData.ts";
import { ContextControl } from "./vram/Context.tsx";
import { ContextChart } from "./vram/ContextChart.tsx";
import { EngineSeg, HardwarePicker, KvSeg } from "./vram/controls.tsx";
import { CustomModel } from "./vram/CustomModel.tsx";
import { Check, DecimalField, useNarrow } from "./vram/fields.tsx";
import { FitMatrix, type MatrixRow } from "./vram/FitMatrix.tsx";
import { FitsView } from "./vram/FitsView.tsx";
import { HardwareTable } from "./vram/HardwareTable.tsx";
import { LoadSheet } from "./vram/LoadSheet.tsx";
import { ModelPicker } from "./vram/ModelPicker.tsx";
import { cheapestFix, moves, smallestSetup, type Fix } from "./vram/moves.ts";
import { Badge, Figure, Method, ModelFacts, MovesTable, Stamp, Working } from "./vram/sections.tsx";
import {
  decodeVram,
  encodeVram,
  nearestFile,
  normalize,
  readRig,
  resolve,
  writeRig,
  type Resolved,
  type VramState,
} from "./vram/state.ts";
import {
  capText,
  engineFlags,
  ENGINE_SHORT,
  estimateMarkdown,
  formatName,
  g1,
  g2,
  ggufTag,
  kvLabel,
  modelLine,
  rangeText,
  rigText,
  sequencesText,
  tokens,
  unconfirmed,
} from "./vram/text.ts";

const AGENT = presetById("agent")!;
const PATH = "/tools/vram";

export function VramTool() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The URL wins; the remembered rig fills in only when the link names no device.
  const [init] = useState(() => decodeVram(params, params.has("dev") ? null : readRig()));
  const [st, setSt] = useState<VramState>(init.state);
  const [notices, setNotices] = useState<string[]>(init.notices);
  const answerRef = useRef<HTMLHeadingElement>(null);
  const fitRef = useRef<HTMLHeadingElement>(null);

  const update = (patch: Partial<VramState>) => {
    const out = normalize({ ...st, ...patch });
    setSt(out.state);
    setNotices(out.notices);
  };
  const remember = (patch: Partial<VramState>) => {
    const next = normalize({ ...st, ...patch }).state;
    writeRig({ dev: next.device, eng: next.engine, mem: next.mem });
    update(patch);
  };

  const r = useMemo(() => resolve(st), [st]);
  const encoded = encodeVram(st, r);
  // A link that carried anything is rewritten once in its canonical form, even when that's empty (a corrected
  // or redundant link); a bare one only when a remembered rig adds to it.
  const synced = useRef<string | null>(params.toString() ? null : "");
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      // The raw string: URLSearchParams would percent-encode ":" and ",".
      navigate({ pathname, search: encoded ? `?${encoded}` : "" }, { replace: true, state: { internal: true } });
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, navigate, pathname]);

  const setView = (view: VramState["view"]) => {
    if (view === st.view) return;
    trackEvent("VRAM", "View", view === "fit" ? "fit" : "will");
    update({ view });
    requestAnimationFrame(() => (view === "fit" ? fitRef : answerRef).current?.focus());
  };
  // A "What fits" row opens with the state it was estimated with: its format, GPU count and engine defaults.
  const openRow = (row: VramState) => {
    update({ ...row, view: "will" });
    requestAnimationFrame(() => {
      answerRef.current?.focus({ preventScroll: true });
      answerRef.current?.scrollIntoView({ block: "start" });
    });
  };

  return (
    <>
      <title>{titleFor(PATH)}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 08</span>
        <h1>VRAM Estimator</h1>
        <p className="sub">
          How much GPU memory an open-weight model needs at the context you want, worked out from its published architecture: the weights
          at the format you pick, the KV cache your context fills, and what the engine keeps for itself. It's an estimate. Every line shows
          its arithmetic, and the range is wider where the method is less certain.
        </p>
        <p className="vr-dataline">
          Model data from Hugging Face as of {WEIGHTS_AS_OF} · devices checked {DEVICES_CHECKED} · engine defaults checked {ENGINE_CHECKED}
        </p>
      </div>

      <div className="seg vr-mode" role="group" aria-label="Question">
        <button type="button" aria-pressed={st.view === "will"} className={st.view === "will" ? "on" : ""} onClick={() => setView("will")}>
          Will it fit?
        </button>
        <button type="button" aria-pressed={st.view === "fit"} className={st.view === "fit" ? "on" : ""} onClick={() => setView("fit")}>
          What fits my hardware?
        </button>
      </div>

      {notices.length > 0 && (
        <div className="vr-notices" role="status">
          {notices.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}

      {st.view === "fit" ? (
        <FitsView st={st} r={r} update={update} remember={remember} onOpen={openRow} headingRef={fitRef} />
      ) : (
        <WillView st={st} r={r} update={update} remember={remember} answerRef={answerRef} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- "Will it fit?"

function WillView({
  st,
  r,
  update,
  remember,
  answerRef,
}: {
  st: VramState;
  r: Resolved;
  update: (patch: Partial<VramState>) => void;
  remember: (patch: Partial<VramState>) => void;
  answerRef: RefObject<HTMLHeadingElement | null>;
}) {
  const narrow = useNarrow();
  const pickerWrap = useRef<HTMLDivElement>(null);
  const vm = r.vm;
  const s = r.settings;
  const e = useMemo(() => (vm && s ? estimate(vm, s) : null), [vm, s]);
  const maxMid = useMemo(() => (vm && s ? maxContext(vm, s, r.maxCtx, "mid") : null), [vm, s, r.maxCtx]);
  const maxHigh = useMemo(() => (vm && s ? maxContext(vm, s, r.maxCtx, "high") : null), [vm, s, r.maxCtx]);
  const worst = e ? e.perGpu.indexOf(e.perGpu.reduce((a, b) => (b.mid > a.mid ? b : a))) : 0;
  // For a setup that's over, the least disruptive change that gets it to Tight or better; for a tight one, to Fits.
  const fix = useMemo(() => (e && e.verdict !== "fits" ? cheapestFix(st, r, e, e.verdict === "tight" ? "fits" : "tight") : null), [st, r, e]);
  const setup = useMemo(() => (e && (e.weightsAlone || (e.verdict === "wont-fit" && !fix)) ? smallestSetup(st, r) : null), [st, r, e, fix]);
  // The heavier sections follow the inputs a beat behind, so typing stays responsive.
  const lagSt = useDeferredValue(st);
  const lagR = useMemo(() => (lagSt === st ? r : resolve(lagSt)), [lagSt, st, r]);
  const lagS = lagR.vm === vm ? (lagR.settings ?? s) : s;
  const moveList = useMemo(() => {
    if (!lagR.vm || !lagR.settings) return [];
    return moves(lagSt, lagR, estimate(lagR.vm, lagR.settings));
  }, [lagSt, lagR]);
  const partial = useMemo(
    () => (vm && s && e && s.engine === "llamacpp" && (e.verdict === "wont-fit" || e.verdict === "just-over") ? partialOffloadLayers(vm, s) : null),
    [vm, s, e],
  );

  // The best closed match for the link out: the cheapest closed model, as a coding agent, scoring at least this one.
  const closedKey = useMemo(() => {
    const score = r.model?.scores?.intelligence;
    if (score == null) return null;
    const closed = priceAll(allModels().filter((m) => m.weightsStatus === "closed"), AGENT.workload, AGENT.rate, todayIso());
    return cheapestAbove(closed, "intelligence", score)?.model.key ?? null;
  }, [r.model]);

  // Announce only verdict changes, once input settles.
  const [announced, setAnnounced] = useState("");
  const lastVerdict = useRef<string | null>(null);
  const verdictText = e && s ? `${e.verdict}|${r.model?.key ?? "custom"}` : null;
  useEffect(() => {
    if (!verdictText || !e || !s) return;
    const t = setTimeout(() => {
      if (verdictText === lastVerdict.current) return;
      lastVerdict.current = verdictText;
      setAnnounced(`${VERDICT_WORD[e.verdict]}: about ${g1(e.need.mid)} GiB on ${rigText(s.device, s.count)}.`);
    }, 500);
    return () => clearTimeout(t);
    // Only the verdict (and model) should trigger an announcement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdictText]);

  const openModelInline = (key: string) => {
    update({ model: key, format: null, fileGB: null, bpw: null });
    requestAnimationFrame(() => answerRef.current?.focus({ preventScroll: true }));
  };

  const name = r.model?.displayName ?? "Custom model";
  const fmtName = vm ? formatName(r.format, vm, r.fileBytes) + (r.fileBytes && !vm.ggufFiles?.length && r.format !== "custom" ? " (your file)" : "") : "";
  const hfId = r.record?.resolvedId ?? r.model?.hfId ?? null;
  const flags = vm && s && e ? engineFlags(s, r.format, vm, hfId, partial) : null;
  // Self-contained: the model and device go in even when they're the defaults.
  const shareUrl = () => `${window.location.origin}${PATH}?${encodeVram(st, r, true)}`;
  const settingsLine = s ? `${fmtName} · ${fmtCtx(s.ctx)} context · ${sequencesText(s.seqs)} · ${kvLabel(s.engine, s.kv)} KV · ${ENGINE_SHORT[s.engine]}` : "";
  const markdown = () =>
    e && s ? estimateMarkdown({ name, settingsLine, e, rig: rigText(s.device, s.count), worst, asOf: WEIGHTS_AS_OF, url: shareUrl() }) : "";

  // Fit-matrix rows: the engine's formats by bits, plus your file or custom bits when those are in use.
  const matrixRows = useMemo((): MatrixRow[] => {
    if (!vm) return [];
    if (vm.ggufFiles?.length) {
      return [...vm.ggufFiles]
        .sort((a, b) => b.bytes - a.bytes)
        .map((f) => ({ id: `file:${f.name}`, label: `${ggufTag(f.name)} · ${(f.bytes / 1e9).toFixed(2)} GB`, bits: (8 * f.bytes) / vm.params, format: "file" as FormatId, fileBytes: f.bytes }));
    }
    const rows: MatrixRow[] = r.formats
      .filter((o) => !o.disabled)
      .sort((a, b) => b.bits - a.bits)
      .map((o) => ({ id: o.id, label: o.label, bits: o.bits, format: o.id, fileBytes: null }));
    if (r.format === "custom" && s?.bpw) rows.unshift({ id: "custom", label: `Custom · ${s.bpw} bits`, bits: s.bpw, format: "custom", fileBytes: null });
    else if (r.fileBytes) rows.unshift({ id: "file", label: `Your file · ${(r.fileBytes / 1e9).toFixed(2)} GB`, bits: (8 * r.fileBytes) / vm.params, format: "file", fileBytes: r.fileBytes });
    return rows;
  }, [vm, r.formats, r.format, r.fileBytes, s?.bpw]);
  const currentRow = vm?.ggufFiles?.length
    ? `file:${nearestFile(vm, r.fileBytes).name}`
    : r.format === "custom"
      ? "custom"
      : r.fileBytes
        ? "file"
        : r.format;

  const device = r.device;
  const count = s?.count ?? 1;
  const rope = r.record?.arch?.rope ?? (r.custom?.fromPaste ? (st.pasted?.parsed.rope ?? null) : null);
  const ropeText = rope ? `${rope.type} ×${rope.factor}` : null;
  const native = vm?.maxPositions && vm.maxPositions < r.maxCtx ? vm.maxPositions : null;

  return (
    <div className="vr-layout">
      <div className="vr-inputs">
        <div className="vr-field" ref={pickerWrap}>
          <span className="il">Model</span>
          <div className="vr-model-card">
            <span className="vr-model-name">{name}</span>
            <span className="vd">
              {r.model ? modelLine(r.model, r.record) : r.custom?.fromPaste ? "from your pasted config.json" : "your numbers"}
            </span>
          </div>
          <ModelPicker
            isCustom={st.model === "custom"}
            onPick={(m) => {
              trackEvent("VRAM", "Model", m.key);
              openModelInline(m.key);
            }}
            onCustom={() => {
              trackEvent("VRAM", "Custom model");
              update({ model: "custom", format: null, fileGB: null });
            }}
          />
          {st.model === "custom" && (
            <CustomModel
              spec={st.custom}
              result={r.custom}
              pasted={st.pasted}
              onChange={(custom, pasted) => update(pasted !== undefined ? { custom, pasted } : { custom })}
            />
          )}
        </div>

        <EngineSeg
          engines={r.engines}
          engine={r.engine}
          onChange={(eng) => {
            trackEvent("VRAM", "Engine", eng);
            remember({ engine: eng, format: null, kv: "f16" });
          }}
        />

        {vm && (
          <div className="vr-field">
            <label className="il" htmlFor="vr-fmt">
              Weights
            </label>
            <select
              id="vr-fmt"
              className="vr-select"
              value={vm.ggufFiles?.length ? `file:${nearestFile(vm, r.fileBytes).name}` : r.format}
              onChange={(ev) => {
                const v = ev.target.value;
                if (v.startsWith("file:")) {
                  const f = vm.ggufFiles!.find((x) => `file:${x.name}` === v)!;
                  trackEvent("VRAM", "Format", "file");
                  update({ format: "file", fileGB: f.bytes / 1e9 });
                } else {
                  trackEvent("VRAM", "Format", v);
                  update({ format: v as FormatId, bpw: v === "custom" ? (st.bpw ?? 4.5) : st.bpw });
                }
              }}
            >
              {r.formats.map((o) =>
                o.file ? (
                  <option key={o.file.name} value={`file:${o.file.name}`}>
                    File: {ggufTag(o.file.name)} · {(o.file.bytes / 1e9).toFixed(2)} GB
                  </option>
                ) : (
                  <option key={o.id} value={o.id} disabled={Boolean(o.disabled)}>
                    {o.label} · ≈{o.bits.toFixed(o.bits >= 10 ? 0 : 1)} bits{o.disabled ? ` — ${o.disabled}` : ""}
                  </option>
                ),
              )}
              {!vm.ggufFiles?.length && <option value="custom">Custom bits per weight…</option>}
            </select>
            {r.format === "custom" && (
              <DecimalField label="Bits per weight" value={st.bpw} onChange={(v) => update({ bpw: v })} min={1} max={32} hint="Body weights; embedding and head stay 16-bit." />
            )}
            {!vm.ggufFiles?.length && r.format !== "custom" && (
              <DecimalField
                label="Know the file size?"
                suffix="GB"
                value={st.fileGB}
                onChange={(v) => {
                  if (v !== null && st.fileGB === null) trackEvent("VRAM", "File size entered");
                  update({ fileGB: v });
                }}
                min={0.01}
                max={100000}
                placeholder="optional"
                hint={st.fileGB ? "Weights pinned to your file's size (decimal GB)." : null}
              />
            )}
            {r.engine === "llamacpp" && !vm.ggufFiles?.length && (
              <span className="vr-hint">Standard llama-quantize mixes. Dynamic quants (UD-…, _L, _XL) differ: enter the file size.</span>
            )}
          </div>
        )}

        {vm && (
          <ContextControl
            value={r.ctx}
            max={r.maxCtx}
            native={native}
            rope={ropeText}
            fitMax={maxMid ? maxMid.tokens : null}
            onChange={(c) => update({ ctx: c })}
          />
        )}

        <div className="vr-field">
          <NumberField label="Concurrent sequences" value={st.seqs} onChange={(n) => update({ seqs: n })} min={1} max={256} step={1} />
          <span className="vr-hint">Parallel chats or agent workers, each holding its own full context; assumes no shared prefix.</span>
        </div>

        <KvSeg
          engine={r.engine}
          kv={st.kv}
          onChange={(k) => {
            trackEvent("VRAM", "KV", k);
            update({ kv: k });
          }}
        />

        <HardwarePicker
          device={device}
          mem={st.mem}
          count={count}
          engine={r.engine}
          vm={vm}
          onDevice={(id) => {
            trackEvent("VRAM", "Device", id);
            remember({ device: id, count: 1 });
          }}
          onMem={(g) => remember({ mem: g })}
          onCount={(n) => {
            if (n > 1) trackEvent("VRAM", "GPU count", String(n));
            update({ count: n });
          }}
        />

        <details className="vr-adv">
          <summary>Advanced</summary>
          <div className="vr-adv-body">
            {r.engine === "vllm" && (
              <>
                <DecimalField
                  label="GPU memory utilization"
                  value={st.util}
                  onChange={(v) => v !== null && update({ util: v })}
                  min={0.5}
                  max={0.98}
                  hint="vLLM's --gpu-memory-utilization; 0.92 by default since v0.21."
                />
                <DecimalField
                  label="Max batched tokens"
                  integer
                  value={st.mbt}
                  onChange={(v) => update({ mbt: v })}
                  min={16}
                  max={1 << 20}
                  placeholder={String(vllmBatchTokens(device))}
                  hint="vLLM's default depends on the GPU's memory."
                />
              </>
            )}
            {r.engine === "llamacpp" && (
              <>
                <DecimalField label="Micro-batch (-ub)" integer value={st.ub} onChange={(v) => v !== null && update({ ub: v })} min={1} max={65536} />
                <Check label="Flash attention" checked={st.fa} onChange={(v) => update({ fa: v })} hint="Off adds an attention-score buffer that grows with context." />
                {r.has.window && (
                  <Check
                    label="--swa-full"
                    checked={st.swaFull}
                    onChange={(v) => update({ swaFull: v })}
                    hint="Keep the full context on sliding-window layers too."
                  />
                )}
                {r.has.moe && (
                  <Check
                    label="Routed experts in system RAM (--cpu-moe)"
                    checked={st.cpu}
                    onChange={(v) => {
                      if (v) trackEvent("VRAM", "Experts in RAM");
                      update({ cpu: v });
                    }}
                    hint="Frees GPU memory; generation then runs at RAM speed."
                  />
                )}
                {r.has.lookup && (
                  <Check label="Lookup tables in system RAM" checked={st.lut} onChange={(v) => update({ lut: v })} hint="N-gram/Engram tables are read, not multiplied." />
                )}
              </>
            )}
            {r.has.vision && (
              <Check label="Load the vision/audio encoder" checked={Boolean(s?.vision)} onChange={(v) => update({ vis: v })} />
            )}
            {r.has.mtp && <Check label="Load the MTP layers" checked={st.mtp} onChange={(v) => update({ mtp: v })} hint="For speculative decoding." />}
            {device.cls !== "unified" && (
              <Check
                label="This GPU drives a display"
                checked={Boolean(s?.display)}
                onChange={(v) => update({ disp: v })}
                hint="The desktop takes 0.3–1.5 GiB on GPU 1."
              />
            )}
            {device.vendor === "apple" && device.ramGiB && (
              <Check
                label="Raised macOS GPU cap (RAM − 8 GiB)"
                checked={st.macRaised}
                onChange={(v) => update({ macRaised: v })}
                hint={
                  <>
                    <code>sudo sysctl iogpu.wired_limit_mb={(device.ramGiB - 8) * 1024}</code>; resets at reboot; your call.
                  </>
                }
              />
            )}
          </div>
        </details>
      </div>

      <div className="vr-result">
        <section aria-labelledby="answer-h">
          <div className="section-title">
            <h2 id="answer-h" ref={answerRef} tabIndex={-1}>
              {name} on {rigText(device, count)}
            </h2>
            <Stamp />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {announced}
          </p>
          {r.problem || !vm || !s || !e ? (
            <Problem
              text={r.problem ?? "Nothing to estimate yet."}
              custom={st.model === "custom"}
              onPicker={() => pickerWrap.current?.querySelector<HTMLInputElement>("input[role=combobox]")?.focus()}
              onCustom={() => update({ model: "custom", format: null, fileGB: null })}
            />
          ) : (
            <Answer e={e} r={r} name={name} fmtName={fmtName} maxMid={maxMid!} maxHigh={maxHigh!} fix={fix} setup={setup} partial={partial} />
          )}
        </section>
        {vm && s && e && <LoadSheet e={e} device={device} count={count} engine={r.engine} />}
      </div>

      {vm && s && e && (
        <div className="vr-working-wrap">
          <Working e={e} r={r} worst={worst} flags={flags} markdown={markdown} shareUrl={shareUrl} />
        </div>
      )}

      {vm && s && e && (
        <div className="vr-wide">
          <Meter className="section-break" />
          <section className="section" aria-labelledby="matrix-h">
            <div className="section-title">
              <h2 id="matrix-h">Which format and context fit?</h2>
            </div>
            <FitMatrix
              vm={vm}
              s={lagS!}
              rows={matrixRows}
              current={currentRow}
              limit={r.maxCtx}
              narrow={narrow}
              caption={
                <>
                  On {rigText(device, count)} with {kvLabel(s.engine, s.kv)} KV cache, {sequencesText(s.seqs)}, {ENGINE_SHORT[s.engine]}:
                  ≈ GiB per GPU at each format and context <Stamp />
                </>
              }
              onPick={(row, ctx) => {
                trackEvent("VRAM", "Fit cell");
                const gguf = Boolean(vm.ggufFiles?.length);
                if (gguf) update({ format: "file", fileGB: row.fileBytes! / 1e9, ctx });
                else if (row.id === "file" || row.id === "custom") update({ ctx });
                else update({ format: row.format, fileGB: null, ctx });
              }}
            />
            <p className="fine">
              AA scores were measured on the published weights, not these quantizations. Loss is usually small at 4 bits and up for larger
              models, and grows below 4 bits.
            </p>
          </section>

          <section className="section" aria-labelledby="ctx-h">
            <div className="section-title">
              <h2 id="ctx-h">Memory against context</h2>
              <span className="count">
                {maxMid?.limitedBy === "memory" ? `fits up to ≈ ${fmtCtx(maxMid.tokens)}` : maxMid?.limitedBy === "model" ? "fits at every context" : "doesn't fit at any context"}
              </span>
            </div>
            <ContextChart vm={vm} s={lagS!} limit={r.maxCtx} native={native} device={device} />
            {native && (
              <p className="fine">
                The config's own maximum is {tokens(native)} tokens{ropeText ? ` (RoPE scaling ${ropeText} declared)` : ""}; past it the
                model needs RoPE scaling, which OpenRouter's providers use to serve up to {tokens(r.maxCtx)}.
              </p>
            )}
          </section>

          <section className="section" aria-labelledby="hw-h">
            <div className="section-title">
              <h2 id="hw-h">Which hardware runs it?</h2>
              <span className="count">at {fmtName}, {fmtCtx(s.ctx)}, {ENGINE_SHORT[s.engine]}</span>
            </div>
            <HardwareTable
              vm={vm}
              s={lagS!}
              disp={st.disp}
              limit={r.maxCtx}
              selected={device.id}
              onSelect={(d, n) => {
                trackEvent("VRAM", "Device row", d.id);
                remember({ device: d.id, count: n });
              }}
            />
          </section>

          <MovesTable
            moves={moveList}
            onApply={(m) => {
              trackEvent("VRAM", "Sensitivity applied", m.factor);
              update(m.patch);
            }}
          />

          {(r.model || r.custom) && <ModelFacts r={r} closedKey={closedKey} />}
        </div>
      )}

      <div className="vr-wide">
        <Method />
      </div>
    </div>
  );

}

const VERDICT_WORD = VERDICT_LABEL;

function Problem({ text, custom, onPicker, onCustom }: { text: string; custom: boolean; onPicker: () => void; onCustom: () => void }) {
  return (
    <div className="readout vr-problem">
      <p>{text}</p>
      {!custom && (
        <p className="vr-links">
          <button type="button" className="text-btn" onClick={onPicker}>
            Pick another model
          </button>
          <button type="button" className="text-btn" onClick={onCustom}>
            Enter its dimensions as a custom model
          </button>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the answer

function Answer({
  e,
  r,
  name,
  fmtName,
  maxMid,
  maxHigh,
  fix,
  setup,
  partial,
}: {
  e: VramEstimate;
  r: Resolved;
  name: string;
  fmtName: string;
  maxMid: ReturnType<typeof maxContext>;
  maxHigh: ReturnType<typeof maxContext>;
  fix: Fix | null;
  setup: { text: string } | null;
  partial: number | null;
}) {
  const s = r.settings!;
  const vm = r.vm!;
  const d = s.device;
  const rig = rigText(d, s.count);
  const each = s.count > 1 ? " each" : "";
  const cap =
    s.engine === "vllm"
      ? `${g2(e.budget)} GiB of ${capText(d.usableGiB)}${each}${unconfirmed(d) ? " (unconfirmed)" : ""} at ${Math.round(s.util * 100)}%`
      : d.cls === "unified"
        ? `${g1(e.budget)} GiB ${d.vendor === "apple" ? (s.macRaised ? "raised GPU cap" : "GPU cap") : "usable"}${unconfirmed(d) ? ", unconfirmed" : ""}`
        : `${capText(d.usableGiB)}${each}${unconfirmed(d) ? ", unconfirmed" : ""}`;
  const over = e.need.mid - e.budget;
  const spare = e.budget - e.need.mid;
  const lead = (
    <>
      <strong>{name}</strong> · {fmtName} · {fmtCtx(s.ctx)} · {sequencesText(s.seqs)} · {ENGINE_SHORT[s.engine]} needs about{" "}
      <strong className="mono">{g1(e.need.mid)} GiB</strong> (<span className="mono">{rangeText(e.need)}</span>).
    </>
  );
  const ctxClause =
    maxMid.limitedBy === "memory" ? (
      <>
        Fits up to about <strong className="mono">{fmtCtx(maxMid.tokens)}</strong> context (safe:{" "}
        <span className="mono">{maxHigh.limitedBy === "weights" ? "none" : fmtCtx(maxHigh.tokens)}</span>)
      </>
    ) : null;
  const where = fix?.factor === "count" ? " per GPU" : fix?.factor === "experts" ? " on the GPU" : "";
  const fixClause = fix ? (
    <>
      {ctxClause ? ", or" : "It fits"} at {fmtCtx(s.ctx)} {fix.text} (≈ <span className="mono">{g1(fix.e.need.mid)}</span> GiB{where},{" "}
      {VERDICT_WORD[fix.e.verdict].toLowerCase()})
    </>
  ) : null;
  const weightsOnly = e.lines.filter((l) => l.id === "weights" || l.id === "encoders").reduce((a, l) => a + l.perGpu[0].mid, 0);
  const pick = (id: string) => e.lines.find((l) => l.id === id)?.perGpu[0].mid ?? 0;
  const overhead = pick("compute") + pick("runtime") + pick("display");

  let body;
  if (e.invalid) {
    body = <p>{e.invalid}</p>;
  } else if (e.weightsAlone) {
    const alt = fix ? (
      <>
        {setup ? " Or, on this hardware," : " It fits"} {fix.text} (≈ <span className="mono">{g1(fix.e.need.mid)}</span> GiB
        {fix.factor === "count" ? " per GPU" : " on the GPU"}, {VERDICT_WORD[fix.e.verdict].toLowerCase()}).
      </>
    ) : null;
    body = setup || fix ? (
      <p>
        The weights alone (≈ <span className="mono">{g1(weightsOnly)}</span> GiB{s.count > 1 ? " per GPU" : ""} at {fmtName}) exceed {rig}.
        {setup && (
          <>
            {" "}
            Smallest listed setup that fits: <strong>{setup.text}</strong>.
          </>
        )}
        {alt}
      </p>
    ) : (
      <p>
        {name} at {fmtName} needs about <span className="mono">{g1(e.perGpu.reduce((a, g) => a + g.mid, 0))}</span> GiB
        {s.count > 1 ? ` across ${s.count} GPUs` : ""}, more than 8 of any device we list can hold (devices whose capacity is
        unconfirmed aren't counted). Try a smaller format; serving across machines isn't estimated.
      </p>
    );
  } else if (e.verdict === "wont-fit" || e.verdict === "just-over") {
    body = (
      <p>
        {lead}{" "}
        {e.verdict === "wont-fit" ? (
          <>
            <strong>Won't fit</strong> {rig} ({cap}): over by about <span className="mono">{g1(over)}</span> GiB.
          </>
        ) : (
          <>
            <strong>Just over</strong> {rig} ({cap}): over by about <span className="mono">{g1(over)}</span> GiB at the estimate; only
            the low end of the range fits.
          </>
        )}{" "}
        {ctxClause}
        {fixClause}
        {ctxClause || fixClause ? "." : null}
        {!ctxClause && !fixClause && setup && (
          <>
            {" "}
            Smallest listed setup that fits: <strong>{setup.text}</strong>.
          </>
        )}
      </p>
    );
  } else if (e.verdict === "tight") {
    body = (
      <p>
        {lead} <strong>Tight</strong> on {rig} ({cap}): the estimate fits with ≈ <span className="mono">{g1(spare)}</span> GiB to spare,
        but the top of the range (<span className="mono">{g1(e.need.high)}</span>) doesn't. Leave headroom
        {fix ? (
          <>
            , or run it {fix.text} (≈ <span className="mono">{g1(fix.e.need.mid)}</span> GiB{where}, {VERDICT_WORD[fix.e.verdict].toLowerCase()})
          </>
        ) : null}
        .
      </p>
    );
  } else {
    body = (
      <p>
        {lead} <strong>Fits</strong> {rig} ({cap}) with ≈ <span className="mono">{g1(spare)}</span> GiB to spare,{" "}
        {maxMid.limitedBy === "model" ? (
          <>up to the model's maximum ({fmtCtx(r.maxCtx)}).</>
        ) : (
          <>
            up to about <span className="mono">{fmtCtx(maxMid.tokens)}</span> context.
          </>
        )}
      </p>
    );
  }

  const notes: ReactNode[] = [];
  if (s.engine === "vllm" && e.pool) {
    const w = pick("weights") + pick("encoders");
    const k = e.pool.seqsAtCtx;
    notes.push(
      s.ctx < 1 ? (
        <>
          vLLM claims {Math.round(s.util * 100)}% of each GPU (≈ {g2(e.budget)} GiB) up front. At context 0 this is weights (≈ {g1(w)}{" "}
          GiB) and runtime only; set a context to size the KV pool.
        </>
      ) : e.pool.bytes > 0 && k >= 1 ? (
        <>
          vLLM claims {Math.round(s.util * 100)}% of each GPU (≈ {g2(e.budget)} GiB) up front. Weights ≈ {g1(w)} GiB, activations ≈{" "}
          {g2(pick("compute"))} and runtime ≈ {g2(pick("runtime"))} leave a KV pool of ≈ {g1(e.pool.bytes)} GiB:{" "}
          <strong>
            {k} sequence{k === 1 ? "" : "s"} at {fmtCtx(s.ctx)}
          </strong>{" "}
          fit (≈ {tokens(k * s.ctx)} tokens). vLLM won't start if one full-length request doesn't fit.
        </>
      ) : (
        <>
          vLLM claims {Math.round(s.util * 100)}% of each GPU (≈ {g2(e.budget)} GiB) up front; after weights and activations there's no
          room for one sequence at {fmtCtx(s.ctx)}, so vLLM won't start.
        </>
      ),
    );
    notes.push(<>nvidia-smi shows about {Math.round(s.util * 100)}% in use either way; what matters is the KV pool.</>);
  }
  if (s.expertsOnHost) {
    notes.push(
      <>
        With routed experts in system RAM: ≈ {g1(e.need.mid)} GiB on the GPU plus ≈ {g1(e.host.mid)} GiB of system RAM. Speed then
        depends on RAM bandwidth.
      </>,
    );
  } else if (d.cls !== "unified" && e.host.mid >= 0.1 * 2 ** 30) {
    notes.push(<>Also needs ≈ {g1(e.host.mid)} GiB of system RAM ({e.hostItems.map((h) => h.label.toLowerCase()).join(", ")}).</>);
  }
  if (partial && partial > 0 && !e.weightsAlone) {
    notes.push(
      <>
        About {partial} of {vm.dims.layers} layers fit (<code>-ngl {partial}</code>); the rest run from system RAM, much slower.
      </>,
    );
  } else if (partial && partial > 0) {
    notes.push(
      <>
        llama.cpp could keep about {partial} of {vm.dims.layers} layers on the GPU (<code>-ngl {partial}</code>) and run the rest from
        system RAM, much slower.
      </>,
    );
  }
  if (vm.moe) {
    notes.push(
      <>
        MoE: all {vm.moe.experts} experts sit in memory though {vm.moe.topK} run per token, so memory follows total parameters
        {s.engine === "llamacpp" && !s.expertsOnHost ? "; llama.cpp can keep them in system RAM (Advanced)" : ""}.
      </>,
    );
  }
  if (s.engine === "llamacpp" && s.seqs > 1 && s.ctx > 0) {
    notes.push(
      <>
        Set <code>-c {s.ctx * s.seqs} -np {s.seqs}</code>: llama.cpp splits one context across parallel slots.
      </>,
    );
  }
  if (s.engine === "llamacpp") {
    notes.push(
      <>
        Ollama's default context is smaller than the model's maximum unless you set num_ctx; a quantized KV cache needs
        OLLAMA_FLASH_ATTENTION=1; Ollama keeps extra headroom and may offload layers even when this says Fits.
      </>,
    );
  }
  if (overhead > e.need.mid / 2) notes.push(<>Runtime overhead is most of the total at this size.</>);
  if (vm.maxPositions && s.ctx > vm.maxPositions) {
    const rope = r.record?.arch?.rope;
    notes.push(<>Past {tokens(vm.maxPositions)} tokens this model needs RoPE scaling{rope ? ` (${rope.type} ×${rope.factor})` : ""}.</>);
  }
  if (r.orCtx && s.ctx > r.orCtx) notes.push(<>OpenRouter providers serve up to {tokens(r.orCtx)} tokens.</>);
  if (vm.kv.confidence !== "high") {
    notes.push(
      <>
        Approximate KV layout{vm.kv.notes[0] ? ` (${vm.kv.notes[0].replace(/\.$/, "")})` : ""}: the range is{" "}
        {vm.kv.confidence === "low" ? "±50%" : "up to 20% higher"} on the cache.
      </>,
    );
  }
  for (const n of e.notes) if (!/^vLLM claims/.test(n)) notes.push(<>{n}</>);

  return (
    <div className="readout vr-answer">
      <div className="vr-answer-head">
        <Figure need={e.need} />
        <Badge verdict={e.verdict} />
      </div>
      {body}
      {notes.length > 0 && (
        <ul className="vr-notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

