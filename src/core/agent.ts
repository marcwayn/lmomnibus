import Big from "big.js";
import { priceRequest, type CostNote } from "./cost.ts";
import { primaryMode, rateCard, type Model, type RateMode } from "./model.ts";

/**
 * One agent session: a fixed prefix (system prompt + tool definitions), then
 * `turns` round trips. Each turn sends everything so far — prefix, every
 * earlier user message, tool result and model output — plus this turn's user
 * message and tool results, and gets `outputTokens` back. Context, and so
 * cost per turn, grows linearly; the session's total grows quadratically.
 */
export interface Session {
  turns: number;
  prefixTokens: number;
  userTokens: number;
  toolTokens: number;
  outputTokens: number;
  sessionsPerMonth: number;
  /**
   * off: every input token is fresh. 5m / 1h: prompt caching, where each turn
   * reads everything sent before and writes what's new; 1h uses the 1-hour
   * write price where a vendor sells one (the cache survives longer pauses).
   */
  cache: "off" | "5m" | "1h";
}

export const DEFAULT_SESSION: Session = {
  turns: 20,
  prefixTokens: 12_000,
  userTokens: 300,
  toolTokens: 3_000,
  outputTokens: 800,
  sessionsPerMonth: 1_000,
  cache: "5m",
};

export interface TurnCost {
  turn: number;
  inputTokens: number;
  read: number;
  write: number;
  cost: Big;
  cumulative: Big;
}

export interface SessionCost {
  model: Model;
  mode: RateMode;
  turns: TurnCost[];
  perSession: Big;
  monthly: Big;
  /** The same session with caching off, for the saving. */
  uncachedPerSession: Big;
  /** Share of the session's cost spent on cache reads (0-1). */
  readShare: number;
  /** First turn whose request (input + output) exceeds the context window, if any. */
  contextExceededAt: number | null;
  notes: CostNote[];
}

/** Input tokens on turn t (1-based): prefix, all earlier turns, and this turn's user + tool tokens. */
export function inputTokensAt(s: Session, t: number): number {
  return s.prefixTokens + (t - 1) * (s.userTokens + s.toolTokens + s.outputTokens) + s.userTokens + s.toolTokens;
}

export function sessionCost(model: Model, s: Session, today: string, mode: RateMode = primaryMode(model)): SessionCost {
  const card = rateCard(model, mode)!;
  const run = (cache: Session["cache"]) => {
    const turns: TurnCost[] = [];
    const notes = new Set<CostNote>();
    let cumulative = new Big(0);
    let readCost = new Big(0);
    let exceeded: number | null = null;
    for (let t = 1; t <= s.turns; t++) {
      const input = inputTokensAt(s, t);
      // The first turn writes its whole prompt; later turns read what was
      // sent before and write only what's new (last output + this turn).
      const fresh = t === 1 ? input : s.outputTokens + s.userTokens + s.toolTokens;
      const read = cache === "off" ? 0 : input - fresh;
      const write = cache === "off" ? 0 : fresh;
      const price = priceRequest(
        card,
        today,
        { input: new Big(input), output: new Big(s.outputTokens), read: new Big(read), write: new Big(write) },
        cache === "1h" ? "1h" : "5m",
      );
      price.notes.forEach((n) => notes.add(n));
      cumulative = cumulative.plus(price.perRequest);
      readCost = readCost.plus(price.perRead);
      if (exceeded === null && input + s.outputTokens > model.contextTokens) exceeded = t;
      turns.push({ turn: t, inputTokens: input, read, write, cost: price.perRequest, cumulative });
    }
    return { turns, total: cumulative, readCost, notes: [...notes], exceeded };
  };

  const cached = run(s.cache);
  const uncached = s.cache === "off" ? cached : run("off");
  return {
    model,
    mode,
    turns: cached.turns,
    perSession: cached.total,
    monthly: cached.total.times(s.sessionsPerMonth),
    uncachedPerSession: uncached.total,
    readShare: cached.total.gt(0) ? Number(cached.readCost.div(cached.total)) : 0,
    contextExceededAt: cached.exceeded,
    notes: cached.notes,
  };
}

/**
 * How many reads of a cached token it takes to earn back the write premium:
 * (write − input) / (input − read), on the base card. 0 when writing costs
 * no more than input; null when reads aren't cheaper than input (caching
 * never pays).
 */
export function breakEvenReads(model: Model, ttl: "5m" | "1h", mode: RateMode = primaryMode(model)): number | null {
  const card = rateCard(model, mode)!;
  const input = card.input;
  const read = card.cacheRead ?? input;
  if (!input.gt(read)) return null;
  const published = ttl === "1h" ? (card.cacheWrite1h ?? card.cacheWrite) : card.cacheWrite;
  const write = published && published.gt(input) ? published : input;
  return Number(write.minus(input).div(input.minus(read)));
}
