import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * A labelled number field that may be empty and may take decimals (GiB, GB,
 * billions of parameters, bits per weight). Like NumberField it keeps its own
 * text while you type and reports a value only when the text parses; unlike
 * it, out-of-range text is shown as an inline error rather than clamped.
 */
export function DecimalField({
  label,
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  integer = false,
  suffix,
  placeholder,
  error,
  hint,
  className = "",
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  suffix?: string;
  placeholder?: string;
  /** Shown under the field and tied to it with aria-describedby. */
  error?: string | null;
  hint?: string | null;
  className?: string;
}) {
  const id = useId();
  const show = (v: number | null) => (v === null ? "" : String(v));
  const [text, setText] = useState(show(value));
  const [shown, setShown] = useState(value);
  const [local, setLocal] = useState<string | null>(null);
  if (value !== shown) {
    setShown(value);
    setText(show(value));
    setLocal(null);
  }
  const msg = local ?? error ?? null;
  return (
    <label className={`inp vr-inp ${className}`.trim()}>
      <span className="il">{label}</span>
      <span className="inp-row">
        <input
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          value={text}
          placeholder={placeholder}
          aria-invalid={msg ? true : undefined}
          aria-describedby={msg || hint ? `${id}-d` : undefined}
          onChange={(e) => {
            const raw = e.target.value.trim().replace(/,/g, "");
            setText(e.target.value);
            if (raw === "") {
              // `shown` keeps the last value: a parent that ignores null (or puts a default back) mustn't refill
              // the field mid-edit, so the next keystrokes start from empty. Blur restores the value.
              setLocal(null);
              onChange(null);
              return;
            }
            if (!(integer ? /^\d+$/ : /^\d*\.?\d+$/).test(raw)) {
              setLocal(integer ? "Whole numbers only" : "Numbers only");
              return;
            }
            const n = Number(raw);
            if (n < min || n > max) {
              setLocal(`Between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}`);
              return;
            }
            setLocal(null);
            setShown(n);
            onChange(n);
          }}
          onBlur={() => {
            setText(show(value));
            setLocal(null);
          }}
        />
        {suffix && <span className="inp-suffix">{suffix}</span>}
      </span>
      {(msg || hint) && (
        <span id={`${id}-d`} className={msg ? "vr-err" : "vr-hint"}>
          {msg ?? hint}
        </span>
      )}
    </label>
  );
}

/**
 * An element's rendered width. The charts draw at one SVG unit per pixel up
 * to 880, so their 10–11px text stays that size in a narrow column.
 */
export function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** True below a width: charts switch to their narrow layout. */
export function useNarrow(px = 560): boolean {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** A checkbox row in the Advanced panel. */
export function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
}) {
  return (
    <label className="vr-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="vr-hint">{hint}</span>}
      </span>
    </label>
  );
}
