import { useId, useMemo, useState } from "react";
import type { Model } from "../../core/model.ts";
import { search } from "../../core/query.ts";
import { recordFor } from "../../weightsData.ts";
import { MODELS } from "./state.ts";
import { modelLine } from "./text.ts";

const byScore = (a: Model, b: Model) => (b.scores?.intelligence ?? -1) - (a.scores?.intelligence ?? -1);

type Option = { kind: "model"; m: Model } | { kind: "custom" };

/**
 * An ARIA combobox over open-weight models: type to search, arrows to move,
 * Enter to pick. The last option is always "Custom model…".
 */
export function ModelPicker({
  onPick,
  onCustom,
  isCustom,
}: {
  onPick: (m: Model) => void;
  onCustom: () => void;
  isCustom: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const options: Option[] = useMemo(() => {
    if (!open) return [];
    const text = query.trim();
    const hits = search(MODELS, {
      text,
      vendors: [],
      releasedYear: null,
      limit: 8,
      filter: (m) => m.openWeights,
      compare: text ? undefined : byScore,
    }).hits;
    return [...hits.map((m) => ({ kind: "model" as const, m })), { kind: "custom" as const }];
  }, [query, open]);

  const choose = (o: Option) => {
    setOpen(false);
    setQuery("");
    if (o.kind === "custom") onCustom();
    else onPick(o.m);
  };

  return (
    <div className="vr-combo">
      <input
        type="text"
        role="combobox"
        aria-label={isCustom ? "Pick a listed model instead" : "Change model"}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && options.length ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={isCustom ? "Pick a listed model…" : "Change model — try “qwen 32b”"}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            if (!open) setOpen(true);
            else setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Home" && open) {
            setActive(0);
          } else if (e.key === "End" && open) {
            setActive(options.length - 1);
          } else if (e.key === "Enter") {
            if (open && options[active]) choose(options[active]);
          } else if (e.key === "Escape") {
            if (open) setOpen(false);
            else setQuery("");
          } else return;
          e.preventDefault();
        }}
      />
      {open && (
        <ul className="pick-list vr-options" role="listbox" id={`${id}-list`} aria-label="Open-weight models">
          {options.map((o, i) => (
            <li
              key={o.kind === "model" ? o.m.key : "custom"}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              // Keep focus in the field so the list doesn't close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(o)}
            >
              {o.kind === "model" ? (
                <>
                  <span className="vr-opt-name">{o.m.displayName}</span>
                  <span className="vd">{modelLine(o.m, recordFor(o.m))}</span>
                </>
              ) : (
                <>
                  <span className="vr-opt-name">Custom model…</span>
                  <span className="vd">type its dimensions or paste its config.json</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
