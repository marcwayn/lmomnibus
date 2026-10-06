import type Big from "big.js";

/** Rust's `rust_decimal::round_dp` default, kept so figures match the old app. */
const ROUND_HALF_EVEN = 2;

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A dollar amount for display, grouped with commas: `$4,200.00`. */
export function fmtMoney(d: Big): string {
  const rounded = d.round(2, ROUND_HALF_EVEN);
  const [intPart, decPart] = rounded.abs().toFixed(2).split(".");
  return `${rounded.lt(0) ? "-" : ""}$${groupThousands(intPart)}.${decPart}`;
}

/**
 * A per-MTok rate for display: trimmed to the shortest representation that
 * keeps at least 2 decimals, so `$0.30` stays `$0.30` but a rate as fine as
 * `$0.022` isn't rounded away to `$0.02`.
 */
export function fmtRate(d: Big): string {
  const rounded = d.round(4, ROUND_HALF_EVEN);
  const [intPart, decPart] = rounded.abs().toFixed(4).split(".");
  const trimmed = decPart.replace(/0+$/, "").padEnd(2, "0");
  return `${rounded.lt(0) ? "-" : ""}$${intPart}.${trimmed}`;
}

/** A plain integer for display, grouped with commas: `40,000`. */
export function fmtInt(n: number): string {
  return groupThousands(String(n));
}

/**
 * A dollar figure that may be tiny: two decimals at $1 and above (grouped),
 * three significant figures below $1, so $0.000412 isn't shown as $0.00.
 */
export function fmtUsd(d: Big): string {
  if (d.abs().gte(1) || d.eq(0)) return fmtMoney(d);
  const s = d.abs().prec(3, ROUND_HALF_EVEN).toFixed();
  const [intPart, decPart = ""] = s.split(".");
  return `${d.lt(0) ? "-" : ""}$${intPart}.${decPart.padEnd(2, "0")}`;
}

/** Token counts for display: 2K, 1.5K, 200K, 1M, 2.1M. */
export function fmtCompact(n: number): string {
  const r = (x: number) => Math.round(x * 10) / 10;
  // Promote across a unit boundary after rounding: 999,950 is "1M", not "1000K".
  if (n >= 1e9 || r(n / 1e6) >= 1000) return `${r(n / 1e9)}B`;
  if (n >= 1e6 || r(n / 1e3) >= 1000) return `${r(n / 1e6)}M`;
  if (n >= 1e3) return `${r(n / 1e3)}K`;
  return String(n);
}
