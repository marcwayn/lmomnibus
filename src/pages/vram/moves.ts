/**
 * One-change variations of the current setup: what each does to the
 * estimate (the "What moves this estimate?" table), and the least disruptive
 * single change that makes a setup fit. Each change is a state patch, run
 * back through resolve() and estimate(), so it's the same arithmetic as the
 * answer.
 */
import { DEVICES, enginesFor } from "../../core/devices.ts";
import { estimate, fmtCtx, formatLabel, KV_OPTIONS, nativeLabel, type Verdict, type VramEstimate } from "../../core/vram.ts";
import { COUNTS, resolve, type Resolved, type VramState } from "./state.ts";
import { ENGINE_SHORT, g1, rigText, unconfirmed } from "./text.ts";

export interface Move {
  factor: string;
  label: string;
  patch: Partial<VramState>;
  e: VramEstimate;
  delta: number;
  verdict: Verdict;
}

function run(st: VramState, factor: string, label: string, patch: Partial<VramState>, base: VramEstimate): Move | null {
  const r = resolve({ ...st, ...patch });
  if (!r.settings || !r.vm) return null;
  const e = estimate(r.vm, r.settings);
  if (e.invalid) return null;
  return { factor, label, patch, e, delta: e.need.mid - base.need.mid, verdict: e.verdict };
}

/** Weight formats the picker offers, highest bits first, and where the current one sits. */
function formatLadder(r: Resolved) {
  const fmts = r.formats.filter((o) => !o.disabled && o.id !== "file").sort((a, b) => b.bits - a.bits);
  return { fmts, i: fmts.findIndex((o) => o.id === r.format) };
}

/** Every one-step change worth showing, largest effect first, at most `limit`. */
export function moves(st: VramState, r: Resolved, base: VramEstimate, limit = 6): Move[] {
  const s = r.settings!;
  const out: (Move | null)[] = [];
  const add = (factor: string, label: string, patch: Partial<VramState>) => out.push(run(st, factor, label, patch, base));
  if (s.ctx * 2 <= r.maxCtx) add("ctx-x2", `Context ${fmtCtx(s.ctx)} → ${fmtCtx(s.ctx * 2)}`, { ctx: s.ctx * 2 });
  if (s.ctx >= 2048) add("ctx-half", `Context ${fmtCtx(s.ctx)} → ${fmtCtx(Math.floor(s.ctx / 2))}`, { ctx: Math.floor(s.ctx / 2) });
  if (s.seqs < 256) add("seq-up", `Sequences ${s.seqs} → ${s.seqs + 1}`, { seqs: s.seqs + 1 });
  if (s.seqs > 1) add("seq-down", `Sequences ${s.seqs} → ${s.seqs - 1}`, { seqs: s.seqs - 1 });
  const kvs = KV_OPTIONS[s.engine];
  const k = kvs.findIndex((o) => o.id === s.kv);
  if (k + 1 < kvs.length) add("kv-down", `KV cache ${kvs[k].label} → ${kvs[k + 1].label}`, { kv: kvs[k + 1].id });
  if (k > 0) add("kv-up", `KV cache ${kvs[k].label} → ${kvs[k - 1].label}`, { kv: kvs[k - 1].id });
  if (!r.fileBytes && r.format !== "custom") {
    const { fmts, i } = formatLadder(r);
    if (i >= 0 && i + 1 < fmts.length) add("format-down", `Weights ${fmts[i].label} → ${fmts[i + 1].label}`, { format: fmts[i + 1].id });
    if (i > 0) add("format-up", `Weights ${fmts[i].label} → ${fmts[i - 1].label}`, { format: fmts[i - 1].id });
  }
  for (const eng of r.engines) {
    if (eng === s.engine) continue;
    const to = resolve({ ...st, engine: eng, format: null, kv: "f16" });
    const fmt = to.format === "native" && to.vm ? `as published, ${nativeLabel(to.vm.native.format)}` : formatLabel(to.format);
    add(`engine-${eng}`, `Engine ${ENGINE_SHORT[s.engine]} → ${ENGINE_SHORT[eng]} (${fmt})`, { engine: eng, format: null, kv: "f16" });
  }
  if (r.has.moe) add("experts", s.expertsOnHost ? "Routed experts back on the GPU" : "Routed experts in system RAM", { cpu: !s.expertsOnHost });
  if (r.has.window) add("swa-full", s.swaFull ? "Sliding windows honoured (no --swa-full)" : "--swa-full (full-size sliding-window cache)", { swaFull: !s.swaFull });
  if (r.device.cls !== "unified") add("display", s.display ? "Headless GPU (no display)" : "GPU drives a display", { disp: !s.display });
  const next = COUNTS.find((n) => n > s.count && (s.engine !== "vllm" || r.vm!.dims.heads % n === 0));
  if (next && r.device.cls !== "unified") add("count", `${s.count} × ${r.device.short} → ${next} × ${r.device.short}`, { count: next });
  return out
    .filter((m): m is Move => m !== null && Math.abs(m.delta) >= 2 ** 20)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

export interface Fix {
  factor: string;
  /** "with a Q8_0 KV cache", "at Q3_K_M", "on 2 × RTX 4090". */
  text: string;
  e: VramEstimate;
}

/**
 * The least disruptive single change (context aside) that gets the setup to
 * `at` (Tight or better, or Fits): a smaller KV cache, then smaller weights,
 * then a headless GPU, experts in RAM, more GPUs.
 */
export function cheapestFix(st: VramState, r: Resolved, base: VramEstimate, at: "tight" | "fits" = "tight"): Fix | null {
  const s = r.settings!;
  const tries: { factor: string; text: string; patch: Partial<VramState> }[] = [];
  const kvs = KV_OPTIONS[s.engine];
  const k = kvs.findIndex((o) => o.id === s.kv);
  for (const o of kvs.slice(k + 1)) tries.push({ factor: "kv-down", text: `with a ${o.label} KV cache`, patch: { kv: o.id } });
  if (!r.fileBytes && r.format !== "custom") {
    const { fmts, i } = formatLadder(r);
    if (i >= 0) for (const o of fmts.slice(i + 1, i + 4)) tries.push({ factor: "format-down", text: `at ${o.label}`, patch: { format: o.id } });
  }
  if (s.display) tries.push({ factor: "display", text: "on a headless GPU", patch: { disp: false } });
  if (r.has.moe && !s.expertsOnHost) tries.push({ factor: "experts", text: "with the routed experts in system RAM", patch: { cpu: true } });
  if (r.device.cls !== "unified") {
    for (const n of COUNTS.filter((n) => n > s.count && (s.engine !== "vllm" || r.vm!.dims.heads % n === 0))) {
      tries.push({ factor: "count", text: `on ${n} × ${r.device.short}`, patch: { count: n } });
    }
  }
  for (const t of tries) {
    const m = run(st, t.factor, t.text, t.patch, base);
    if (!m || !(m.verdict === "fits" || (at === "tight" && m.verdict === "tight"))) continue;
    // Experts in RAM trade GPU memory for system RAM: say how much.
    const text = t.factor === "experts" ? `with the routed experts in ≈ ${g1(m.e.host.mid)} GiB of system RAM` : t.text;
    return { factor: t.factor, text, e: m.e };
  }
  return null;
}

/**
 * The smallest listed setup that fits, by total memory: every device we list
 * whose capacity is confirmed, 1 to 8 of each (unified-memory machines count
 * once). It keeps the engine where the device runs it, and otherwise uses
 * llama.cpp, which runs everywhere.
 */
export function smallestSetup(st: VramState, r: Resolved): { text: string } | null {
  const ladder = DEVICES.filter((d) => !unconfirmed(d))
    .flatMap((d) => (d.cls === "unified" ? [1 as const] : COUNTS).map((n) => ({ d, n })))
    .sort((a, b) => a.d.usableGiB * a.n - b.d.usableGiB * b.n || a.n - b.n || Number(!a.d.isDefault) - Number(!b.d.isDefault));
  for (const { d, n } of ladder) {
    const engine = enginesFor(d).includes(r.engine) ? r.engine : "llamacpp";
    const rr = resolve({ ...st, device: d.id, count: n, engine, mem: null, kv: engine === r.engine ? st.kv : "f16" });
    if (!rr.settings || !rr.vm) continue;
    if (rr.engine === "vllm" && rr.vm.dims.heads % n !== 0) continue;
    const e = estimate(rr.vm, rr.settings);
    if (!e.invalid && e.verdict === "fits") {
      const how = [engine !== r.engine ? ENGINE_SHORT[engine] : "", rr.format !== r.format ? formatLabel(rr.format) : ""].filter(Boolean).join(", ");
      return { text: `${rigText(d, n)}${how ? ` (${how})` : ""}` };
    }
  }
  return null;
}
