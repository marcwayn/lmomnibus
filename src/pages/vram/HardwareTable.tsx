import { useMemo, useState } from "react";
import { DEVICES, drivesDisplay, enginesFor, type Device } from "../../core/devices.ts";
import {
  budgetBytes,
  defaultFormat,
  estimate,
  fmtCtx,
  formatLabel,
  formatOptions,
  maxContext,
  minUnits,
  VERDICT_LABEL,
  type Engine,
  type Range,
  type Verdict,
  type VramModel,
  type VramSettings,
} from "../../core/vram.ts";
import { COUNTS, type Count } from "./state.ts";
import { capText, g1, g2, rangeText, unconfirmed } from "./text.ts";

type Vendor = "nvidia" | "amd" | "apple" | "other";
const VENDORS: [Vendor, string][] = [
  ["nvidia", "NVIDIA"],
  ["amd", "AMD"],
  ["apple", "Apple"],
  ["other", "Other"],
];
const vendorOf = (d: Device): Vendor => (d.vendor === "intel" ? "other" : d.vendor);

/**
 * The same settings on another device: its own display default (unless the
 * person set one), and the engine's usual format when this one can't run there.
 */
function settingsOn(base: VramSettings, vm: VramModel, d: Device, disp: boolean | null): VramSettings | null {
  if (!enginesFor(d).includes(base.engine)) return null;
  let format = base.format;
  if (format !== "file" && format !== "custom" && !formatOptions(vm, base.engine, d).some((o) => o.id === format && !o.disabled)) {
    format = defaultFormat(vm, base.engine, d);
  }
  return {
    ...base,
    format,
    device: d,
    count: 1,
    display: d.cls !== "unified" && (disp ?? drivesDisplay(d)),
    macRaised: base.macRaised && d.vendor === "apple",
  };
}

/** The most GPUs this setup can use: 1 on unified memory; under tensor parallelism, the largest count that splits the heads. */
function maxCount(vm: VramModel, s: VramSettings): Count {
  if (s.device.cls === "unified") return 1;
  return COUNTS.filter((n) => s.engine !== "vllm" || vm.dims.heads % n === 0).pop() ?? 1;
}

interface HwRow {
  d: Device;
  units: Count | null;
  need: Range;
  verdict: Verdict;
  budget: number;
  max: { tokens: number; limitedBy: string };
  swapped: string | null;
}

export function HardwareTable({
  vm,
  s,
  disp,
  limit,
  selected,
  onSelect,
}: {
  vm: VramModel;
  s: VramSettings;
  disp: boolean | null;
  limit: number;
  selected: string;
  onSelect: (d: Device, count: Count) => void;
}) {
  const [vendors, setVendors] = useState<Set<Vendor>>(() => new Set(VENDORS.map(([v]) => v)));
  const [all, setAll] = useState(false);
  const engine: Engine = s.engine;
  const pool = DEVICES.filter((d) => (all || d.isDefault || d.id === selected) && vendors.has(vendorOf(d)));
  const rows = useMemo(() => {
    const out: HwRow[] = [];
    let hidden = 0;
    for (const d of pool) {
      const s1 = settingsOn(s, vm, d, disp);
      if (!s1) {
        hidden++;
        continue;
      }
      const units = minUnits(vm, s1, d);
      const at = { ...s1, count: units ?? maxCount(vm, s1) };
      const e = estimate(vm, at);
      out.push({
        d,
        units,
        need: e.need,
        verdict: e.verdict,
        budget: budgetBytes(d, s1),
        max: maxContext(vm, at, limit, "mid"),
        swapped: s1.format !== s.format ? formatLabel(s1.format) : null,
      });
    }
    out.sort((a, b) => (a.units ?? 99) - (b.units ?? 99) || a.d.usableGiB - b.d.usableGiB);
    return { out, hidden };
    // pool is derived from the filters below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm, s, disp, limit, all, vendors, selected]);

  const toggle = (v: Vendor) =>
    setVendors((prev) => {
      const next = new Set(prev);
      if (next.has(v) && next.size > 1) next.delete(v);
      else next.add(v);
      return next;
    });
  const fmtNote = s.format === "fp8" ? "FP8 compute needs Ada or newer (Ampere runs FP8 weight-only)." : s.format === "nvfp4" ? "NVFP4 needs Blackwell." : null;

  return (
    <>
      <div className="chips" role="group" aria-label="Device filters">
        {VENDORS.map(([v, label]) => (
          <button key={v} type="button" className={`chip${vendors.has(v) ? " on" : ""}`} aria-pressed={vendors.has(v)} onClick={() => toggle(v)}>
            {label}
          </button>
        ))}
        <button type="button" className={`chip${all ? " on" : ""}`} aria-pressed={all} onClick={() => setAll((x) => !x)}>
          Show all devices
        </button>
      </div>
      <div className="table-frame">
        <table className="market vr-hw">
          <caption className="sr-only">
            Devices that can run this setup, by how many units it needs, with the need per unit, the verdict and the longest context at that
            count
          </caption>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col" className="n vr-opt">
                Reported
              </th>
              <th scope="col" className="n vr-opt">
                Budget here
              </th>
              <th scope="col" className="n">
                Units
              </th>
              <th scope="col" className="n vr-opt">
                ≈ GiB per unit
              </th>
              <th scope="col">Verdict</th>
              <th scope="col" className="n">
                Max context
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.out.map((r) => {
              const on = r.d.id === selected;
              return (
                <tr key={r.d.id} className={on ? "vr-selected" : undefined}>
                  <td>
                    <button
                      type="button"
                      className="row-btn"
                      aria-pressed={on}
                      onClick={() => onSelect(r.d, r.units ?? 1)}
                      aria-label={`Use ${r.d.short}${r.units && r.units > 1 ? `, ${r.units} units` : ""}`}
                    >
                      {r.d.short}
                    </button>
                    <span className="vd">
                      {r.d.cls === "unified" ? `${r.d.memoryGb} GB unified` : `${r.d.memoryGb} GB ${r.d.cls}`}
                      {r.swapped && ` · at ${r.swapped}`}
                    </span>
                    {unconfirmed(r.d) && <span className="vd vr-compact">{capText(r.d.usableGiB)}, unconfirmed</span>}
                  </td>
                  <td className="n vr-opt">
                    {capText(r.d.usableGiB)}
                    {(r.d.cls === "unified" || unconfirmed(r.d)) && (
                      <span className="vd">
                        {[r.d.cls === "unified" ? (r.d.vendor === "apple" ? "GPU cap" : "usable") : "", unconfirmed(r.d) ? "unconfirmed" : ""]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="n vr-opt">{g2(r.budget)}</td>
                  <td className="n">{r.units ? `${r.units}×` : "—"}</td>
                  <td className="n vr-opt">
                    ≈ {g1(r.need.mid)}
                    <span className="vd">{rangeText(r.need)}</span>
                  </td>
                  <td>
                    <span className={`vr-badge sm ${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
                    {!r.units && <span className="vd"> at {maxCount(vm, { ...s, device: r.d })}×</span>}
                  </td>
                  <td className="n">
                    {r.max.limitedBy === "weights" ? "—" : r.max.limitedBy === "model" ? "model max" : `≈ ${fmtCtx(r.max.tokens)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.out.length === 0 && <div className="empty-note">No listed device in these groups runs {engine === "mlx" ? "MLX" : "this engine"}.</div>}
      </div>
      <p className="fine">
        {rows.hidden > 0 && (
          <>
            {rows.hidden} device{rows.hidden === 1 ? "" : "s"} hidden: MLX runs only on Apple silicon; vLLM doesn't run on Macs.{" "}
          </>
        )}
        Units are 1, 2, 4 or 8 of the same device in one machine (unified-memory machines count as one); mixed devices and
        several machines aren't estimated. {fmtNote}
      </p>
    </>
  );
}
