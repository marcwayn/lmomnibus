import { useState } from "react";

interface Props {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
  step: number;
  /** Largest value the field accepts at all; anything above is ignored, like a failed parse. */
  limit: number;
  disabled?: boolean;
}

/**
 * A labelled whole-number input. It keeps its own text so the field can be
 * cleared or mid-edit without snapping back, and only reports a value when
 * the text parses as a whole number within `limit`.
 */
export function NumberField({ label, value, onChange, min, max, step, limit, disabled }: Props) {
  const [text, setText] = useState(String(value));

  return (
    <label className="inp">
      <span className="il">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (/^\+?\d+$/.test(raw)) {
            const n = Number(raw);
            if (n <= limit) onChange(n);
          }
        }}
      />
    </label>
  );
}

export const U32_MAX = 4_294_967_295;
