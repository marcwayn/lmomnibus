import { useMemo, useState, type ReactNode } from "react";
import { Mark } from "../../components.tsx";
import { estimate, fmtCtx, VERDICT_LABEL, type FormatId, type Verdict, type VramModel, type VramSettings } from "../../core/vram.ts";
import { g1 } from "./text.ts";

export interface MatrixRow {
  id: string;
  label: string;
  bits: number;
  format: FormatId;
  fileBytes: number | null;
}

const POWERS = [4, 8, 16, 32, 64, 128, 256, 512, 1024].map((k) => k * 1024);
const NARROW_COLS = [8 * 1024, 32 * 1024, 128 * 1024];

const SIGN: Record<Verdict, string> = { fits: "", tight: "~ ", "just-over": "? ", "wont-fit": "" };

/** Columns: 4K…1M cut at the model's maximum, plus "max" when that isn't a power of two. */
function matrixContexts(limit: number): number[] {
  const cols = POWERS.filter((c) => c <= limit);
  if (!cols.includes(limit)) cols.push(limit);
  return cols;
}

/**
 * Which format and context fit: every cell is the same estimate as the
 * answer above, for that row's format at that column's context. Cells are
 * buttons that set both.
 */
export function FitMatrix({
  vm,
  s,
  rows,
  current,
  limit,
  narrow,
  onPick,
  caption,
}: {
  vm: VramModel;
  s: VramSettings;
  rows: MatrixRow[];
  /** The row id of the current format. */
  current: string;
  limit: number;
  narrow: boolean;
  onPick: (row: MatrixRow, ctx: number) => void;
  caption: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const every = useMemo(() => matrixContexts(limit), [limit]);
  const few = every.filter((c) => NARROW_COLS.includes(c) || c === limit);
  const cols = narrow && !all ? few : every;
  const cells = useMemo(
    () =>
      rows.map((r) =>
        every.map((ctx) => {
          const e = estimate(vm, { ...s, format: r.format, fileBytes: r.fileBytes, ctx });
          return { ctx, need: e.need, verdict: e.verdict };
        }),
      ),
    [vm, s, rows, every],
  );
  return (
    <>
      <div className="table-frame vr-matrix-frame">
        <table className="market vr-matrix">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Weights</th>
              {cols.map((c) => (
                <th key={c} scope="col" className="n">
                  {c === limit && !POWERS.includes(c) ? `max ${fmtCtx(c)}` : fmtCtx(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={r.id}>
                <th scope="row">
                  <span className="vr-fmt">{r.label}</span>
                  <span className="vd">≈ {r.bits.toFixed(r.bits >= 10 ? 0 : 1)} bits</span>
                </th>
                {cols.map((c) => {
                  const cell = cells[ri][every.indexOf(c)];
                  const on = r.id === current && c === s.ctx;
                  return (
                    <td key={c} className={`vr-cell ${cell.verdict}${on ? " on" : ""}`}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`${r.label}, ${fmtCtx(c)}: about ${g1(cell.need.mid)} GiB, ${VERDICT_LABEL[cell.verdict].toLowerCase()}`}
                        onClick={() => onPick(r, c)}
                      >
                        {cell.verdict === "fits" && <Mark kind="check" />}
                        {SIGN[cell.verdict]}
                        {g1(cell.need.mid)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {narrow && every.length > few.length && (
        <button type="button" className="text-btn" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer contexts" : "Show all contexts"}
        </button>
      )}
      <p className="vr-key vr-matrix-key">
        <span>
          <span className="vr-cell-key fits">
            <Mark kind="check" />
          </span>{" "}
          fits, whole range
        </span>
        <span>
          <span className="vr-cell-key tight">~</span> tight: the estimate fits, its top doesn't
        </span>
        <span>
          <span className="vr-cell-key just-over">?</span> just over: only the bottom of the range fits
        </span>
        <span>
          <span className="vr-cell-key wont-fit" /> won't fit
        </span>
      </p>
    </>
  );
}
