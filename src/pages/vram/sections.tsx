import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { trackEvent } from "../../analytics.ts";
import { CopyButton, Mark } from "../../components.tsx";
import { DEVICES_CHECKED } from "../../core/devices.ts";
import { encodeKey } from "../../core/share.ts";
import {
  ENGINE_CHECKED,
  nativeLabel,
  VERDICT_LABEL,
  type Range,
  type VramEstimate,
} from "../../core/vram.ts";
import { licenceHref } from "../../core/weights.ts";
import { WEIGHTS_AS_OF } from "../../weightsData.ts";
import { hostKind, Swatch, type SegKind } from "./LoadSheet.tsx";
import type { Move } from "./moves.ts";
import type { Resolved } from "./state.ts";
import { g1, g2, kvFamilyLabel, licenceText, paramsText, rangeText, tokens } from "./text.ts";

const INTERNAL = { internal: true };

/** The ESTIMATE stamp that rides with every memory figure. */
export function Stamp() {
  return <span className="vr-stamp">Estimate</span>;
}

export function Badge({ verdict, small = false }: { verdict: VramEstimate["verdict"]; small?: boolean }) {
  return <span className={`vr-badge ${verdict}${small ? " sm" : ""}`}>{VERDICT_LABEL[verdict]}</span>;
}

/** The headline figure: "≈ 27.4 GiB (26.7–29.0)". */
export function Figure({ need }: { need: Range }) {
  return (
    <span className="vr-figure-line">
      <span className="figure-big">≈ {g1(need.mid)}</span>
      <span className="figure-unit">GiB</span>
      <span className="vr-range mono">({rangeText(need)})</span>
    </span>
  );
}

// ---------------------------------------------------------------- the working

export function Working({
  e,
  r,
  worst,
  flags,
  markdown,
  shareUrl,
}: {
  e: VramEstimate;
  r: Resolved;
  worst: number;
  flags: string | null;
  markdown: () => string;
  shareUrl: () => string;
}) {
  const [math, setMath] = useState(false);
  const unified = r.device.cls === "unified";
  const n = e.perGpu.length;
  const rec = r.record;
  const plan = r.vm!.kv;
  const source = rec?.source ?? "";
  const repo = rec ? `${rec.resolvedId}${rec.sha ? ` @ ${rec.sha.slice(0, 7)}` : ""}` : null;
  const provenance: ReactNode = !rec ? (
    r.custom?.fromPaste ? (
      <>Architecture: your pasted config.json, read in your browser.</>
    ) : (
      <>Architecture: the numbers you entered; tensor groups worked out from them.</>
    )
  ) : (
    <>
      Architecture:{" "}
      {source.startsWith("mirror:") ? (
        <>
          config from the public copy <span className="mono">{source.slice(7)}</span> (
          {rec.gated ? "the original repo is gated" : "the original repo is gone"}; same parameter total), read {rec.checkedOn}
        </>
      ) : source.startsWith("donor:") ? (
        <>
          config from <span className="mono">{source.slice(6)}</span>, which has the same architecture ({repo}, read {rec.checkedOn})
        </>
      ) : (
        <>
          config.json (<span className="mono">{repo}</span>, read {rec.checkedOn})
        </>
      )}{" "}
      · tensor groups: {rec.groups.source === "headers" ? "safetensors headers" : "config arithmetic (range widened ±2%)"} · KV plan:{" "}
      {kvFamilyLabel(plan.family)} ({plan.confidence} confidence)
    </>
  );
  return (
    <section className={`section vr-working${math ? " math" : ""}`} aria-labelledby="working-h">
      <div className="section-title">
        <h2 id="working-h">The working</h2>
        <button
          type="button"
          className="text-btn vr-math-toggle"
          aria-pressed={math}
          onClick={() => {
            if (!math) trackEvent("VRAM", "Working opened");
            setMath((v) => !v);
          }}
        >
          {math ? "Hide arithmetic" : "Show arithmetic"}
        </button>
      </div>
      <div className="table-frame">
        <table className="market">
          <caption className="sr-only">
            What the estimate is made of{n > 1 ? `, for GPU ${worst + 1} of ${n}, the most loaded` : ""}, with the arithmetic and the range
            of each item
          </caption>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="col-math">
                How it's computed
              </th>
              <th scope="col" className="n">
                ≈ GiB{n > 1 ? ` · GPU ${worst + 1}` : ""}
              </th>
              <th scope="col" className="n">
                Range
              </th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l) => {
              const v = l.perGpu[worst];
              if (v.mid <= 0 && l.id !== "kv") return null;
              return (
                <tr key={l.id}>
                  <td>
                    <span className="vr-item">
                      <Swatch kind={l.id as SegKind} /> {l.label}
                    </span>
                  </td>
                  <td className="col-math vr-formula">{l.formula}</td>
                  <td className="n">{g2(v.mid)}</td>
                  <td className="n vr-muted">{rangeText(v, g2)}</td>
                </tr>
              );
            })}
            {e.hostItems
              .filter((h) => h.bytes.mid > 0)
              .map((h) => (
                <tr key={h.label} className="sub-row">
                  <td>
                    <span className="vr-item">
                      <Swatch kind={hostKind(h.label)} /> {h.label}
                    </span>
                  </td>
                  <td className="col-math vr-formula">
                    {unified ? "same memory as the GPU" : "system RAM, not GPU memory"}
                    {/token|embed/i.test(h.label) && r.engine === "llamacpp" ? "; llama.cpp keeps the token embeddings on the host" : ""}
                  </td>
                  <td className="n">
                    {g2(h.bytes.mid)}
                    {!unified && <span className="vd">RAM</span>}
                  </td>
                  <td className="n vr-muted">{rangeText(h.bytes, g2)}</td>
                </tr>
              ))}
            <tr className="vr-total">
              <td>
                <strong>Total{n > 1 ? `, GPU ${worst + 1}` : unified ? "" : " on the GPU"}</strong>
              </td>
              <td className="col-math vr-formula">estimate; range {rangeText(e.need)}</td>
              <td className="n">
                <strong>{g2(e.need.mid)}</strong>
              </td>
              <td className="n vr-muted">{rangeText(e.need, g2)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {!unified && e.host.mid > 0 && (
        <p className="fine">
          System RAM, besides: ≈ {g2(e.host.mid)} GiB ({rangeText(e.host, g2)}), plus whatever the engine's prompt cache keeps there.
        </p>
      )}
      <p className="fine vr-prov">
        {provenance}
        {plan.confidence !== "high" && (
          <>
            {" "}
            <span className="vr-chip">approximate KV layout{plan.notes[0] ? ` — ${plan.notes[0]}` : ""}</span>
          </>
        )}
      </p>
      {flags && (
        <div className="vr-flags">
          <span className="il">Flags matching this estimate (check against your engine version; defaults checked {ENGINE_CHECKED})</span>
          <code className="vr-code">{flags}</code>
          <CopyButton label="Copy flags" getText={() => flags} onCopied={() => trackEvent("VRAM", "Copy flags")} />
        </div>
      )}
      <div className="bench-actions vr-actions">
        <CopyButton label="Copy as Markdown" getText={markdown} onCopied={() => trackEvent("Share", "Copy markdown")} />
        <CopyButton
          label="Copy link"
          getText={shareUrl}
          share={{ title: "LMOmnibus VRAM estimate", url: shareUrl }}
          onCopied={(how) => trackEvent("Share", how === "share" ? "Native share" : "Copy link")}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- what moves it

export function MovesTable({ moves, onApply }: { moves: Move[]; onApply: (m: Move) => void }) {
  return (
    <section className="section" aria-labelledby="moves-h">
      <div className="section-title">
        <h2 id="moves-h">What moves this estimate?</h2>
        <span className="count">one change at a time, largest first</span>
      </div>
      {moves.length > 0 ? (
        <div className="table-frame">
          <table className="market vr-moves">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col" className="n">
                  Δ GiB
                </th>
                <th scope="col">New verdict</th>
                <th scope="col">
                  <span className="sr-only">Apply</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.factor}>
                  <td>{m.label}</td>
                  <td className="n vr-delta">
                    <Mark kind={m.delta > 0 ? "up" : "down"} />
                    <span className="sr-only">{m.delta > 0 ? "adds " : "saves "}</span>
                    {g2(Math.abs(m.delta))}
                  </td>
                  <td>
                    <Badge verdict={m.verdict} small />
                  </td>
                  <td>
                    <button type="button" className="text-btn" onClick={() => onApply(m)} aria-label={`Apply: ${m.label}`}>
                      Apply
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-note">No single change moves this estimate by more than a mebibyte.</div>
      )}
      <ol className="vr-list fine">
        <li>Context × sequences: the KV cache grows with both.</li>
        <li>KV cache precision: 8-bit halves it, 4-bit quarters it.</li>
        <li>
          Weight format: the standard GGUF mixes come within about 2% for most files, but uploader-specific and dynamic mixes (unsloth
          UD, imatrix variants) can differ by up to 10% at low bits. Pick the actual file, or enter its size, when you know it.
        </li>
        <li>
          Whether the engine honours sliding windows: Gemma 3 27B at 128K needs about 10.6 GiB of KV cache with windows and about 62.0
          GiB without.
        </li>
        <li>What the engine reserves (vLLM takes its share of the GPU up front).</li>
        <li>Runtime overhead, the least certain part.</li>
        <li>A display attached, and Windows.</li>
        <li>Vision encoders and MTP layers, when loaded.</li>
        <li>Prefix sharing between sequences, which lowers real use below this estimate.</li>
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- model facts

export function ModelFacts({ r, closedKey }: { r: Resolved; closedKey: string | null }) {
  const vm = r.vm!;
  const rec = r.record;
  const m = r.model;
  const d = vm.dims;
  const moe = vm.moe;
  const lic = rec ? licenceText(m, rec) : null;
  const kvh = d.kvHeads && d.kvHeads !== d.heads ? `GQA ${d.heads}/${d.kvHeads}` : d.heads ? `MHA ${d.heads} heads` : null;
  const arch = [
    moe ? `MoE · ${moe.experts} experts, ${moe.topK} active${moe.shared ? ` + ${moe.shared} shared` : ""}` : "Dense",
    vm.kv.family === "gqa" ? kvh : kvFamilyLabel(vm.kv.family),
    `${d.layers} layers`,
  ]
    .filter(Boolean)
    .join(" · ");
  const active = rec?.active ?? (m?.weights?.active ? { params: m.weights.active, source: "card" as const } : null);
  const PARAM_SRC: Record<string, string> = {
    safetensors: "Hugging Face safetensors total",
    headers: "safetensors headers",
    gguf: "GGUF header",
    pickle: "checkpoint index",
    mirror: "public mirror",
    override: "set by hand",
  };
  const ACT_SRC = { card: "model card", name: "model name", headers: "tensor split" };
  return (
    <section className="section" aria-labelledby="facts-h">
      <div className="section-title">
        <h2 id="facts-h">Model facts</h2>
        {m && (
          <Link className="text-btn" to={`/models/${m.key}`} state={INTERNAL}>
            Model page
            <Mark kind="to" />
          </Link>
        )}
      </div>
      <dl className="spec-grid six">
        <div>
          <dt>Parameters</dt>
          <dd>
            {paramsText(vm.params)} total
            <span className="rank"> · {rec ? PARAM_SRC[rec.paramsSource] : "your figure"}</span>
            {active && (
              <>
                <br />
                {paramsText(active.params)} active<span className="rank"> · {ACT_SRC[active.source]}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Architecture</dt>
          <dd>{arch}</dd>
        </div>
        <div>
          <dt>Published as</dt>
          <dd>
            {nativeLabel(vm.native.format)}
            {vm.checkpointBytes && rec ? <span className="rank"> · {(vm.checkpointBytes / 1e9).toFixed(1)} GB checkpoint</span> : null}
            {vm.ggufFiles?.length ? <span className="rank"> · {vm.ggufFiles.length} GGUF files</span> : null}
          </dd>
        </div>
        <div>
          <dt>Licence</dt>
          <dd>
            {lic ? (
              <>
                {rec ? (
                  <a href={licenceHref(rec)} rel="noopener noreferrer">
                    {lic.name}
                  </a>
                ) : (
                  lic.name
                )}
                <span className="rank"> · {lic.cls}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>Max context</dt>
          <dd>
            config {vm.maxPositions ? tokens(vm.maxPositions) : "—"}
            {r.orCtx ? <span className="rank"> · OpenRouter {tokens(r.orCtx)}</span> : null}
          </dd>
        </div>
        <div>
          <dt>KV cache layout</dt>
          <dd>
            {kvFamilyLabel(vm.kv.family)}
            <span className="rank"> · {vm.kv.confidence} confidence</span>
          </dd>
        </div>
      </dl>
      {moe && (
        <p className="fine">
          All {moe.experts} experts must sit in memory even though {moe.topK} run per token: memory follows total parameters, speed follows
          active ones. Vendors count active parameters differently.
        </p>
      )}
      {rec?.gated && <p className="fine">Gated on Hugging Face: accept the terms there before you can download the weights.</p>}
      {rec?.notes.filter((n) => !/gated|public copy/i.test(n)).map((n) => (
        <p key={n} className="fine">
          {n}
        </p>
      ))}
      {m && (
        <p className="vr-links">
          <Link
            className="text-btn"
            state={INTERNAL}
            to={closedKey ? `/tools/open?vs=${encodeKey(closedKey)}` : "/tools/open"}
            onClick={() => trackEvent("VRAM", "To open-vs-closed")}
          >
            Compare with closed models
            <Mark kind="to" />
          </Link>
          <Link className="text-btn" state={INTERNAL} to={`/tools/cost?m=${encodeKey(m.key)}&p=agent`} onClick={() => trackEvent("VRAM", "To bench")}>
            Price it
            <Mark kind="to" />
          </Link>
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- method

export function Method() {
  return (
    <section className="section vr-method" aria-labelledby="method-h">
      <div className="section-title">
        <h2 id="method-h">Method</h2>
        <span className="count">checked {ENGINE_CHECKED}</span>
      </div>
      <div className="vr-method-cols">
        <p>
          <strong>This is an estimate.</strong> Memory = weights + KV cache + what the engine keeps for itself. Each part comes from
          published facts: tensor sizes from the model's safetensors on Hugging Face, layer geometry from its config.json, the block size
          of each format (GGUF mixes calibrated on real files), and engine behaviour read from llama.cpp, vLLM and mlx-lm as of{" "}
          {ENGINE_CHECKED}.
        </p>
        <p>
          <strong>What it leaves out:</strong> memory fragmentation; speculative-decoding draft models; LoRA adapters; prefix caches
          beyond your context; images and audio (they use context tokens); other programs on the GPU; engine versions newer than those
          checked.
        </p>
        <p>
          <strong>Fitting isn't speed.</strong> A model that fits may still be slow, and fitting doesn't mean your engine supports this
          architecture yet.
        </p>
        <p>
          <strong>Quality isn't memory.</strong> Lower-bit formats usually cost some quality; Artificial Analysis scores describe the
          published weights.
        </p>
      </div>
      <p className="fine">
        How close it gets: in the tests that ship with this tool, the KV cache matches llama.cpp's own logs to the MiB and the weights
        come within about 1.5% of three real GGUF loads. In the research behind the method, the standard GGUF mixes came within about
        2% for 9 files in 10, and uploader-specific mixes differed by up to 10%. Runtime buffers are the least certain part: within
        about 15% at default batch sizes, off by up to 40% at large micro-batches. The ranges themselves aren't yet checked against a
        set of measured runs. Engine defaults as of {ENGINE_CHECKED}.
      </p>
      <p className="fine">
        1 GiB = 1,073,741,824 bytes. Device sizes are what the driver reports: an RTX 4090 shows 24,564 MiB (23.99 GiB), and a B200
        sold as "192 GB" shows 179.06 GiB. Hugging Face file sizes are decimal GB (1 GB = 0.931 GiB). 32K = 32,768 tokens.
      </p>
      <p className="fine">
        Devices: capacities as the driver reports them (or a sibling model's driver output), from vendor pages and published
        nvidia-smi output; checked {DEVICES_CHECKED}. Rows marked unconfirmed aren't confirmed by driver output: their capacity is the
        vendor's claim or our estimate. A Mac's figure is the GPU share macOS allows by default, not its RAM.
      </p>
      <p className="fine">
        Architecture from Hugging Face, read {WEIGHTS_AS_OF}. Gated repos are read from a public copy with the same parameter total, or
        entered by hand.
      </p>
      <p className="fine">
        Open-weight means the trained weights are downloadable from a Hugging Face repository we could open on {WEIGHTS_AS_OF}. That's
        narrower than open source: training data and code are rarely published, and the licence decides what you may do with the
        weights.
      </p>
      <p className="fine">No prices here: we don't estimate what self-hosting costs.</p>
    </section>
  );
}

