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
