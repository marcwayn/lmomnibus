/** A Unix timestamp (seconds) as an ISO `YYYY-MM-DD` date, in UTC. */
export function isoDateFromUnixSecs(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}

/** Today's date in UTC as `YYYY-MM-DD`, for deciding whether a promo is live. */
export function todayIso(): string {
  return isoDateFromUnixSecs(Date.now() / 1000);
}
