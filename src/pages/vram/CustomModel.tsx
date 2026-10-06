import { useId, useState } from "react";
import { trackEvent } from "../../analytics.ts";
import { DecimalField } from "./fields.tsx";
import { readPastedConfig, type Attn, type CustomNative, type CustomResult, type CustomSpec, type VramState } from "./state.ts";
import { kvFamilyLabel } from "./text.ts";

const ATTN: [Attn, string][] = [
  ["gqa", "Full (GQA)"],
  ["swa", "Sliding window"],
  ["mla", "MLA"],
];
const NATIVE: [CustomNative, string][] = [
  ["bf16", "BF16"],
  ["fp8", "FP8"],
  ["mxfp4", "MXFP4"],
];

/**
 * A model that isn't listed: its dimensions by hand, or read from a pasted
 * config.json by the same parser the build uses. The text never leaves the
 * browser.
 */
export function CustomModel({
  spec,
  result,
  pasted,
  onChange,
}: {
  spec: CustomSpec;
  result: CustomResult | null;
  pasted: VramState["pasted"];
  onChange: (spec: CustomSpec, pasted?: VramState["pasted"]) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [report, setReport] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof CustomSpec>(k: K) => (v: CustomSpec[K]) => onChange({ ...spec, [k]: v });
  const err = (k: keyof CustomResult["errors"]) => result?.errors[k] ?? null;
  // Only show "enter …" errors once something has been typed: a blank form isn't wrong yet.
  const touched = Object.entries(spec).some(([k, v]) => k !== "tied" && k !== "attn" && k !== "nat" && v !== null);
  const e = (k: keyof CustomResult["errors"]) => (touched ? err(k) : null);

  const read = () => {
    const r = readPastedConfig(text, spec);
    if (r.ok) {
      trackEvent("VRAM", "Config pasted", "ok");
      onChange(r.spec, { parsed: r.parsed, filled: r.spec });
      setReport({ ok: true, text: r.report });
    } else {
      trackEvent("VRAM", "Config pasted", r.kind);
      setReport({ ok: false, text: r.report });
    }
  };

  return (
    <div className="vr-custom">
      <div className="vr-custom-grid">
        <DecimalField label="Total parameters" suffix="B" value={spec.b} onChange={set("b")} max={100000} error={e("b")} placeholder="e.g. 32.8" />
        <DecimalField label="Max context" integer value={spec.ctxmax} onChange={set("ctxmax")} min={1} max={16_777_216} placeholder="131072" />
        <DecimalField label="Layers" integer value={spec.layers} onChange={set("layers")} min={1} max={10000} error={e("layers")} />
        <DecimalField label="Hidden size" integer value={spec.hidden} onChange={set("hidden")} min={1} max={1_000_000} error={e("hidden")} />
        <DecimalField label="Attention heads" integer value={spec.heads} onChange={set("heads")} min={1} max={10000} error={e("heads")} />
        <DecimalField label="KV heads" integer value={spec.kvh} onChange={set("kvh")} min={1} max={10000} error={e("kvh")} />
        <DecimalField
          label="Head dim"
          integer
          value={spec.hd}
          onChange={set("hd")}
          min={1}
          max={10000}
          placeholder={spec.hidden && spec.heads ? String(Math.floor(spec.hidden / spec.heads)) : "hidden ÷ heads"}
        />
        <DecimalField label="Vocabulary" integer value={spec.vocab} onChange={set("vocab")} min={1} max={10_000_000} error={e("vocab")} />
      </div>
      <label className="vr-check">
        <input type="checkbox" checked={spec.tied} onChange={(ev) => set("tied")(ev.target.checked)} />
        <span>Tied embeddings (the output head reuses the embedding table)</span>
      </label>
      <div className="vr-field">
        <span className="il" id={`${id}-attn`}>
          Attention
        </span>
        <div className="seg vr-seg-full" role="group" aria-labelledby={`${id}-attn`}>
          {ATTN.map(([a, label]) => (
            <button key={a} type="button" aria-pressed={spec.attn === a} className={spec.attn === a ? "on" : ""} onClick={() => set("attn")(a)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {spec.attn === "swa" && (
        <div className="vr-custom-grid">
          <DecimalField label="Window" suffix="tokens" integer value={spec.win} onChange={set("win")} min={1} max={16_777_216} error={e("win")} />
          <DecimalField label="Full-attention layers" integer value={spec.full} onChange={set("full")} min={0} max={10000} error={e("full")} placeholder="0" />
        </div>
      )}
      {spec.attn === "mla" && (
        <DecimalField
          label="Latent dims per token"
          integer
          value={spec.lat}
          onChange={set("lat")}
          min={1}
          max={100000}
          error={e("lat")}
          hint="kv_lora_rank + qk_rope_head_dim, e.g. 512 + 64 = 576"
        />
      )}
      <div className="vr-field">
        <span className="il" id={`${id}-nat`}>
          Published as
        </span>
        <div className="seg" role="group" aria-labelledby={`${id}-nat`}>
          {NATIVE.map(([n, label]) => (
            <button key={n} type="button" aria-pressed={spec.nat === n} className={spec.nat === n ? "on" : ""} onClick={() => set("nat")(n)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {result?.warning && <p className="vr-warn">{result.warning}</p>}
      {result?.fromPaste && pasted && (
        <p className="vr-hint">
          Using the pasted config's own layout ({kvFamilyLabel(pasted.parsed.kv.family)}
          {pasted.parsed.moe ? `, MoE with ${pasted.parsed.moe.experts} experts` : ""}). A shared link carries only the fields
          above, so it may approximate this layout.
        </p>
      )}

      <details className="vr-paste">
        <summary>Paste config.json</summary>
        <label className="sr-only" htmlFor={`${id}-cfg`}>
          config.json contents
        </label>
        <textarea
          id={`${id}-cfg`}
          className="vr-textarea"
          rows={6}
          spellCheck={false}
          placeholder='{ "num_hidden_layers": 64, "hidden_size": 5120, … }'
          value={text}
          onChange={(ev) => setText(ev.target.value)}
        />
        <div className="vr-paste-row">
          <button type="button" className="btn btn-ghost vr-btn-small" onClick={read} disabled={!text.trim()}>
            Read config
          </button>
          <span className="vr-hint">Read in your browser; nothing is sent anywhere.</span>
        </div>
        <p className={report?.ok === false ? "vr-err" : "vr-report"} role="status">
          {report?.text ?? ""}
        </p>
      </details>
    </div>
  );
}
