import { useEffect, useId, useRef, useState } from "react";
import { fmtCtx, parseContext } from "../../core/vram.ts";
import { ctxParam } from "./state.ts";

const LO = 1024;
const log2 = Math.log2;

/** What the context field shows: "32K", "1M", or the exact number. */
const ctxShown = (n: number) => ctxParam(n).toUpperCase();

/**
 * Context length: a log₂ slider drawn as the meter rule (pine thumb, the part
 * beyond the longest context that fits hatched, and the stretch past the
 * config's own maximum marked as needing RoPE scaling), a field that takes
 * "32k", and chips for the usual lengths.
 */
export function ContextControl({
  value,
  max,
  native,
  rope,
  fitMax,
  onChange,
  slider = true,
}: {
  value: number;
  /** Longest context the model takes (config or OpenRouter). */
  max: number;
  /** The config's max_position_embeddings, when shorter than `max`. */
  native: number | null;
  rope: string | null;
  /** Longest context that fits (mid estimate); null = don't shade. */
  fitMax: number | null;
  onChange: (tokens: number) => void;
  slider?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(ctxShown(value));
  const [shown, setShown] = useState(value);
  const [note, setNote] = useState<string | null>(null);
  if (value !== shown) {
    setShown(value);
    setText(ctxShown(value));
  }
  const chips = [8 * 1024, 32 * 1024, 128 * 1024].filter((c) => c < max);
  return (
    <div className="vr-field">
      <div className="vr-ctx-row">
        <label className="inp vr-inp vr-ctx-inp">
          <span className="il">Context per sequence</span>
          <span className="inp-row">
            <input
              type="text"
              inputMode="text"
              value={text}
              aria-describedby={`${id}-n`}
              onChange={(e) => {
                setText(e.target.value);
                const n = parseContext(e.target.value);
                if (n === null) {
                  setNote('Try "32k", "128k" or "1m"');
                  return;
                }
                if (n > max) {
                  setNote(`This model stops at ${max.toLocaleString("en-US")} tokens`);
                  setShown(max);
                  onChange(max);
                  return;
                }
                setNote(null);
                setShown(n);
                onChange(n);
              }}
              onBlur={() => {
                setText(ctxShown(value));
                setNote(null);
              }}
            />
            <span className="inp-suffix">tokens</span>
          </span>
          <span id={`${id}-n`} className={note ? "vr-err" : "vr-hint"}>
            {note ?? `${value.toLocaleString("en-US")} tokens`}
          </span>
        </label>
      </div>
      <div className="chips vr-chips" role="group" aria-label="Context presets">
        {chips.map((c) => (
          <button key={c} type="button" className={`chip${value === c ? " on" : ""}`} aria-pressed={value === c} onClick={() => onChange(c)}>
            {fmtCtx(c)}
          </button>
        ))}
        <button type="button" className={`chip${value === max ? " on" : ""}`} aria-pressed={value === max} onClick={() => onChange(max)}>
          Max ({fmtCtx(max)})
        </button>
      </div>
      {slider && max > LO && <ContextSlider value={value} max={max} native={native} rope={rope} fitMax={fitMax} onChange={onChange} />}
    </div>
  );
}

function ContextSlider({
  value,
  max,
  native,
  rope,
  fitMax,
  onChange,
}: {
  value: number;
  max: number;
  native: number | null;
  rope: string | null;
  fitMax: number | null;
  onChange: (tokens: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const span = log2(max) - log2(LO);
  const pct = (t: number) => Math.min(100, Math.max(0, ((log2(Math.max(t, LO)) - log2(LO)) / span) * 100));
  const notches: number[] = [];
  for (let t = LO; t < max; t *= 2) notches.push(t);
  notches.push(max);
  // Label every other octave so labels never collide in a 320px column.
  const labelled = new Set(notches.filter((t, i) => (i % 2 === 0 && t !== max && pct(max) - pct(t) > 12) || t === max));

  // Chromium ignores touch-action on some targets; stop page panning while dragging.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: TouchEvent) => {
      if (dragging.current) e.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);

  const fromPointer = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    let t = 2 ** (log2(LO) + f * span);
    if (f > 0.985) t = max;
    else t = t >= 4096 ? Math.round(t / 1024) * 1024 : Math.round(t / 256) * 256;
    onChange(Math.min(max, Math.max(LO, t)));
  };
  const step = (dir: 1 | -1, n = 1) => {
    let t = value;
    for (let i = 0; i < n; i++) {
      if (dir > 0) t = notches.find((x) => x > t) ?? max;
      // Below the first notch (context under 1K), decreasing never raises the value.
      else t = [...notches].reverse().find((x) => x < t) ?? Math.min(t, LO);
    }
    onChange(t);
  };

  const fitText = fitMax === null ? "" : fitMax >= max ? "; fits up to the model's maximum" : fitMax > 0 ? `; fits up to about ${fitMax.toLocaleString("en-US")}` : "; the weights alone don't fit";
  return (
    <div className="vr-slider-wrap">
      <div
        ref={ref}
        className="vr-slider"
        role="slider"
        tabIndex={0}
        aria-label="Context length, log scale"
        aria-valuemin={Math.min(LO, value)}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${value.toLocaleString("en-US")} tokens${fitText}`}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowUp") step(1);
          else if (e.key === "ArrowLeft" || e.key === "ArrowDown") step(-1);
          else if (e.key === "PageUp") step(1, 2);
          else if (e.key === "PageDown") step(-1, 2);
          else if (e.key === "Home") onChange(Math.min(value, LO));
          else if (e.key === "End") onChange(max);
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && fromPointer(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <div className="vr-track">
          {native !== null && native < max && (
            <div className="vr-track-rope" style={{ left: `${pct(native)}%` }} title={`Past ${native.toLocaleString("en-US")} tokens the model needs RoPE scaling`} />
          )}
          {fitMax !== null && fitMax < max && (
            <div className="vr-track-over" style={{ left: `${pct(Math.max(fitMax, LO))}%` }} />
          )}
          {notches.map((t) => (
            <span key={t} className={`vr-notch${labelled.has(t) ? " major" : ""}`} style={{ left: `${pct(t)}%` }} />
          ))}
          <span className="vr-thumb" style={{ left: `${pct(value)}%` }} />
        </div>
      </div>
      <div className="vr-slider-labels" aria-hidden="true">
        {notches
          .filter((t) => labelled.has(t))
          .map((t) => (
            <span key={t} style={{ left: `${pct(t)}%` }} className={t === max ? "end" : t === LO ? "start" : undefined}>
              {fmtCtx(t)}
            </span>
          ))}
      </div>
      <p className="vr-slider-key">
        {fitMax !== null && fitMax < max && (
          <span>
            <span className="vr-key-over" aria-hidden="true" /> {fitMax > 0 ? `past ≈ ${fmtCtx(fitMax)} doesn't fit` : "doesn't fit at any context"}
          </span>
        )}
        {native !== null && native < max && (
          <span>
            <span className="vr-key-rope" aria-hidden="true" /> past {fmtCtx(native)} needs RoPE scaling{rope ? ` (${rope})` : ""}
          </span>
        )}
      </p>
    </div>
  );
}
