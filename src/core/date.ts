/** A Unix timestamp (seconds) as an ISO `YYYY-MM-DD` date, in UTC. */
export function isoDateFromUnixSecs(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (ISO dates); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Today's date in UTC as `YYYY-MM-DD`, for deciding whether a promo is live. */
export function todayIso(): string {
  return isoDateFromUnixSecs(Date.now() / 1000);
}
