import { useState } from "react";

interface Props {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  /** Unit shown after the field, e.g. "%". */
  suffix?: string;
}

export const U32_MAX = 4_294_967_295;

/**
 * A labelled whole-number input. It keeps its own text so the field can be
 * cleared or mid-edit without snapping back; it reports a value only when the
 * text parses as a whole number, clamped to [min, max], and on blur the text
 * snaps to the value actually in use. It follows `value` when that changes
 * from outside (a preset, a shared link).
 */
export function NumberField({ label, value, onChange, min, max, step, disabled, suffix }: Props) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(String(value));
  }

  return (
    <label className="inp">
      <span className="il">{label}</span>
      <span className="inp-row">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={text}
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            if (/^\+?\d+$/.test(raw)) {
              const n = Math.min(Math.max(Number(raw), min), max);
              setShown(n);
              onChange(n);
            }
          }}
          onBlur={() => setText(String(value))}
        />
        {suffix && <span className="inp-suffix">{suffix}</span>}
      </span>
    </label>
  );
}
