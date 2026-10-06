import { useId, useState } from "react";
import { DEVICES, type Device } from "../../core/devices.ts";
import { KV_OPTIONS, type Engine, type KvDtype, type VramModel } from "../../core/vram.ts";
import { DecimalField } from "./fields.tsx";
import { COUNTS, type Count } from "./state.ts";
import { capText, ENGINE_ALSO, ENGINE_SHORT, unconfirmed } from "./text.ts";

/** Engine: only the engines this device runs. */
export function EngineSeg({ engines, engine, onChange }: { engines: Engine[]; engine: Engine; onChange: (e: Engine) => void }) {
  const id = useId();
  const order: Engine[] = ["llamacpp", "vllm", "mlx"];
  return (
    <div className="vr-field">
      <span className="il" id={id}>
        Engine
      </span>
      <div className="seg vr-seg-full" role="group" aria-labelledby={id}>
        {order
          .filter((e) => engines.includes(e))
          .map((e) => (
            <button key={e} type="button" aria-pressed={engine === e} className={engine === e ? "on" : ""} onClick={() => onChange(e)}>
              {ENGINE_SHORT[e]}
              <span className="rel">{ENGINE_ALSO[e]}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

export function KvSeg({ engine, kv, onChange }: { engine: Engine; kv: KvDtype; onChange: (k: KvDtype) => void }) {
  const id = useId();
  return (
    <div className="vr-field">
      <span className="il" id={id}>
        KV cache
      </span>
      <div className="seg vr-seg-full" role="group" aria-labelledby={id}>
        {KV_OPTIONS[engine].map((o) => (
          <button key={o.id} type="button" aria-pressed={kv === o.id} className={kv === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {engine === "llamacpp" && <span className="vr-hint">A quantized V cache needs flash attention.</span>}
      {engine === "mlx" && <span className="vr-hint">mlx-lm's kv-bits, group size 64.</span>}
    </div>
  );
}

const CLASS_LABEL: Record<Device["cls"], string> = {
  consumer: "Consumer GPUs",
  workstation: "Workstation GPUs",
  datacenter: "Datacenter GPUs",
  unified: "Unified memory (Mac, DGX Spark, Strix Halo)",
};
const CLASSES: Device["cls"][] = ["consumer", "workstation", "datacenter", "unified"];

const optionLabel = (d: Device) =>
  (d.cls === "unified"
    ? `${d.short} · ${capText(d.usableGiB)} ${d.vendor === "apple" ? "GPU cap" : "usable"}`
    : `${d.short} · ${capText(d.usableGiB)}`) + (unconfirmed(d) ? " (unconfirmed)" : "");

/**
 * Hardware: the default devices grouped by class ("Show all devices" adds
 * the rest), a custom size, and 1×/2×/4×/8× for discrete GPUs. Under tensor
 * parallelism a count that doesn't split the attention heads is disabled.
 */
export function HardwarePicker({
  device,
  mem,
  count,
  engine,
  vm,
  onDevice,
  onMem,
  onCount,
}: {
  device: Device;
  mem: number | null;
  count: Count;
  engine: Engine;
  vm: VramModel | null;
  onDevice: (id: string) => void;
  onMem: (gib: number | null) => void;
  onCount: (n: Count) => void;
}) {
  const id = useId();
  const [all, setAll] = useState(() => device.id !== "custom" && !device.isDefault);
  const shown = DEVICES.filter((d) => all || d.isDefault || d.id === device.id);
  const heads = vm?.dims.heads ?? 0;
  const why = (n: Count) =>
    engine === "vllm" && heads && heads % n !== 0 ? `${n} GPUs can't split ${heads} attention heads evenly under tensor parallelism` : null;
  const blocked = COUNTS.map(why).filter(Boolean);
  return (
    <div className="vr-field">
      <label className="il" htmlFor={`${id}-dev`}>
        Hardware
      </label>
      <select id={`${id}-dev`} className="vr-select" value={device.id} onChange={(e) => onDevice(e.target.value)}>
        {CLASSES.map((c) => {
          const ds = shown.filter((d) => d.cls === c);
          return ds.length ? (
            <optgroup key={c} label={CLASS_LABEL[c]}>
              {ds.map((d) => (
                <option key={d.id} value={d.id}>
                  {optionLabel(d)}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
        <optgroup label="Other">
          <option value="custom">Custom size…</option>
        </optgroup>
      </select>
      <div className="vr-row-btns">
        <button type="button" className="text-btn" aria-pressed={all} onClick={() => setAll((v) => !v)}>
          {all ? `Show the ${DEVICES.filter((d) => d.isDefault).length} common devices` : `Show all ${DEVICES.length} devices`}
        </button>
      </div>
      {device.id === "custom" && (
        <DecimalField
          label="Custom GPU memory"
          suffix="GiB"
          value={mem}
          onChange={onMem}
          min={1}
          max={4096}
          placeholder={String(device.usableGiB)}
          hint="What the driver reports (nvidia-smi MiB ÷ 1,024)"
        />
      )}
      {device.cls !== "unified" && (
        <>
          <div className="chips vr-chips" role="group" aria-label="Number of GPUs">
            {COUNTS.map((n) => {
              const reason = why(n);
              return (
                <button
                  key={n}
                  type="button"
                  className={`chip${count === n ? " on" : ""}`}
                  aria-pressed={count === n}
                  disabled={Boolean(reason)}
                  title={reason ?? undefined}
                  onClick={() => onCount(n)}
                >
                  {n}×{reason && <span className="sr-only"> (unavailable: {reason})</span>}
                </button>
              );
            })}
          </div>
          {blocked.length > 0 && <span className="vr-hint">{blocked[blocked.length - 1]}.</span>}
        </>
      )}
      {deviceNote(device) && <span className="vr-hint">{deviceNote(device)}</span>}
    </div>
  );
}

/** The catalog's device notes are research shorthand; show only the ones a person can act on. */
function deviceNote(d: Device): string | null {
  if (d.vendor === "apple") return "macOS lets the GPU use about 3/4 of RAM above 32 GB (2/3 at 32 GB or less) by default.";
  if (d.id.startsWith("dgx-spark")) return "About 112 GiB is free at idle; the OS shares the same memory.";
  if (d.id.startsWith("ryzen-ai-max")) return "Up to 96 GB as dedicated graphics memory (BIOS/Adrenalin); Linux defaults to about half of RAM.";
  return null;
}
