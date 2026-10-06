import Big from "big.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { trackEvent } from "../analytics.ts";
import { Meter, SourceTag } from "../components.tsx";
import { breakEvenReads, DEFAULT_SESSION, inputTokensAt, sessionCost, type Session } from "../core/agent.ts";
import { allModels, CATALOG_META, modelByKey } from "../core/catalog.ts";
import { NOTE_TEXT } from "../core/cost.ts";
import { todayIso } from "../core/date.ts";
import { fmtCompact, fmtMoney, fmtUsd } from "../core/fmt.ts";
import { search } from "../core/query.ts";
import { decodeKey, encodeKey } from "../core/share.ts";
import { NumberField } from "../NumberField.tsx";
import { titleFor } from "../routes.ts";

const MODELS = allModels();
const MAX_MODELS = 4;
const DEFAULT_MODELS = ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-sol", "z-ai/glm-5.3"].filter(
  (k) => modelByKey(k),
);
const FIELDS: [keyof Session, string, number][] = [
  ["turns", "t", 500],
  ["prefixTokens", "pf", 2_000_000],
  ["userTokens", "u", 2_000_000],
  ["toolTokens", "tr", 2_000_000],
  ["outputTokens", "o", 2_000_000],
  ["sessionsPerMonth", "s", 100_000_000],
];
/** Line styles for up to four models: shades of ink and dash patterns, never pine or brick. */
const LINES = ["l1", "l2", "l3", "l4"];

function decode(params: URLSearchParams): { models: string[]; session: Session } {
  const session: Session = { ...DEFAULT_SESSION };
  for (const [field, param, max] of FIELDS) {
    const raw = params.get(param);
    if (raw && /^\d+$/.test(raw)) (session[field] as number) = Math.min(Math.max(Number(raw), field === "turns" ? 1 : 0), max);
  }
  const cache = params.get("cache");
  if (cache === "off" || cache === "5m" || cache === "1h") session.cache = cache;
  const m = (params.get("m") ?? "")
    .split(",")
    .map((x) => decodeKey(x.trim()))
    .filter((k) => k && modelByKey(k));
  // Defaults only when m= is absent; an empty m= means "no models", not "the defaults".
  return { models: params.has("m") ? [...new Set(m)].slice(0, MAX_MODELS) : DEFAULT_MODELS, session };
}

function encode(models: string[], s: Session): string {
  const parts = [`m=${models.map(encodeKey).join(",")}`];
  for (const [field, param] of FIELDS) {
    if (s[field] !== DEFAULT_SESSION[field]) parts.push(`${param}=${s[field]}`);
  }
  if (s.cache !== DEFAULT_SESSION.cache) parts.push(`cache=${s.cache}`);
  return parts.join("&");
}

export function AgentTool() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const today = todayIso();
  const [init] = useState(() => decode(params));
  const [models, setModels] = useState<string[]>(init.models);
  const [session, setSession] = useState<Session>(init.session);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const chipsRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const encoded = encode(models, session);
  const synced = useRef(params.toString() ? "" : encoded);
  useEffect(() => {
    if (encoded === synced.current) return;
    const t = setTimeout(() => {
      synced.current = encoded;
      navigate({ pathname, search: `?${encoded}` }, { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [encoded, navigate, pathname]);

  const results = useMemo(
    () => models.map((k) => sessionCost(modelByKey(k)!, session, today)).sort((a, b) => a.perSession.cmp(b.perSession)),
    [models, session, today],
  );
  const picks = useMemo(
    () => (query.trim() ? search(MODELS, { text: query, vendors: [], releasedYear: null, limit: 6 }).hits : []),
    [query],
  );
  const set = (field: keyof Session) => (v: number) => setSession((s) => ({ ...s, [field]: v }));
  const lastInput = inputTokensAt(session, session.turns);
  const ttl = session.cache === "1h" ? "1h" : "5m";

  return (
    <>
      <title>{titleFor("/tools/agent")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 06</span>
        <h1>Agent Loop</h1>
        <p className="sub">
          An agent re-sends its whole history every turn, so a session's cost grows with the square of its length.
          Shape a session and see what it costs per model — and how much prompt caching saves.
        </p>
      </div>

      <section className="section" aria-labelledby="session-h">
        <div className="section-title">
          <h2 id="session-h">Session</h2>
          <span className="count">
            last turn sends {fmtCompact(lastInput)} tokens
          </span>
        </div>
        <div className="inputs-row">
          <NumberField label="Turns" value={session.turns} onChange={set("turns")} min={1} max={500} step={1} />
          <NumberField label="System + tools tokens" value={session.prefixTokens} onChange={set("prefixTokens")} min={0} max={2_000_000} step={1000} />
          <NumberField label="User tokens / turn" value={session.userTokens} onChange={set("userTokens")} min={0} max={2_000_000} step={100} />
          <NumberField label="Tool-result tokens / turn" value={session.toolTokens} onChange={set("toolTokens")} min={0} max={2_000_000} step={500} />
          <NumberField label="Output tokens / turn" value={session.outputTokens} onChange={set("outputTokens")} min={0} max={2_000_000} step={100} />
          <NumberField label="Sessions / month" value={session.sessionsPerMonth} onChange={set("sessionsPerMonth")} min={0} max={100_000_000} step={100} />
          <div className="inp rate-field wide">
            <span className="il" id="cache-label">
              Prompt caching
            </span>
            <div className="seg" role="group" aria-labelledby="cache-label">
              {(["off", "5m", "1h"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={session.cache === c}
                  className={session.cache === c ? "on" : ""}
                  onClick={() => {
                    trackEvent("Agent", "Cache", c);
                    setSession((s) => ({ ...s, cache: c }));
                  }}
                >
                  {c === "off" ? "Off" : c === "5m" ? "5 min" : "1 hour"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="fine">
          Each turn sends the prefix, every earlier turn (user message, tool results, model output) and this turn's
          user message and tool results. With caching, each turn reads what was sent before and writes what's new;
          the 1-hour cache costs more to write but survives longer pauses between turns.
        </p>
      </section>

      <section className="section" aria-labelledby="models-h">
        <div className="section-title">
          <h2 id="models-h">Models ({models.length})</h2>
        </div>
        <p className="sr-only" role="status">
          {status}
        </p>
        <div className="chips" ref={chipsRef}>
          {models.map((k, i) => (
            <button
              key={k}
              type="button"
              className="chip on"
              aria-label={`Remove ${modelByKey(k)!.displayName}`}
              onClick={() => {
                setModels((ms) => ms.filter((x) => x !== k));
                setStatus(`Removed ${modelByKey(k)!.displayName}`);
                // Keep focus near: the next chip, else the add field.
                requestAnimationFrame(() => {
                  const chips = chipsRef.current?.querySelectorAll<HTMLButtonElement>("button");
                  (chips?.[Math.min(i, (chips?.length ?? 1) - 1)] ?? addRef.current)?.focus();
                });
              }}
            >
              {modelByKey(k)!.displayName} ×
            </button>
          ))}
        </div>
        {models.length < MAX_MODELS && (
          <div className="searchfield" style={{ marginTop: 10 }}>
            <input
              ref={addRef}
              type="search"
              aria-label="Add a model"
              placeholder={`Add a model (up to ${MAX_MODELS}) — try "sonnet" or "deepseek"`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {picks.length > 0 && (
          <ul className="pick-list">
            {picks.map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  className="row-btn"
                  disabled={models.includes(m.key)}
                  onClick={() => {
                    setModels((ms) => (ms.includes(m.key) || ms.length >= MAX_MODELS ? ms : [...ms, m.key]));
                    setQuery("");
                    setStatus(`Added ${m.displayName}`);
                    requestAnimationFrame(() => addRef.current?.focus());
                  }}
                >
                  {m.displayName}
                </button>
                <span className="vd">{m.vendorName}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Meter className="section-break" />

      <section className="section" aria-labelledby="results-h">
        <div className="section-title">
          <h2 id="results-h">Cost per session</h2>
        </div>
        <div className="table-frame">
          <table className="market">
            <thead>
              <tr>
                <th>Model</th>
                <th className="n">$ / session</th>
                <th className="n">$ / month</th>
                <th className="n">Caching saves</th>
                <th className="n">Cache reads</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => {
                const saving = r.uncachedPerSession.gt(0)
                  ? 1 - Number(r.perSession) / Number(r.uncachedPerSession)
                  : 0;
                const be = breakEvenReads(r.model, ttl);
                return (
                  <tr key={r.model.key}>
                    <td>
                      <span className="nm">{r.model.displayName}</span>
                      <span className="vd">
                        {r.model.vendorName} · {fmtCompact(r.model.contextTokens)} ctx <SourceTag model={r.model} mode={r.mode} />
                      </span>
                    </td>
                    <td className="n col-cost">{fmtUsd(r.perSession)}</td>
                    <td className="n">{fmtMoney(r.monthly)}</td>
                    <td className="n">
                      {session.cache === "off"
                        ? "—"
                        : saving >= 0
                          ? `${Math.round(saving * 100)}%`
                          : `costs +${Math.round(-saving * 100)}% more`}
                    </td>
                    <td className="n">{session.cache === "off" ? "—" : `${Math.round(r.readShare * 100)}% of bill`}</td>
                    <td className="breaks">
                      {[
                        r.contextExceededAt !== null &&
                          `stops at turn ${r.contextExceededAt - 1}: turn ${r.contextExceededAt} exceeds the ${fmtCompact(r.model.contextTokens)} context`,
                        session.cache !== "off" &&
                          (be === null
                            ? "no cache discount published"
                            : be === 0
                              ? "a cached token pays off on any reuse"
                              : `a write pays off after ${Math.max(1, Math.ceil(be))} read${Math.ceil(be) > 1 ? "s" : ""}`),
                        ...r.notes.filter((n) => n !== "tier-crossed").map((n) => NOTE_TEXT[n]),
                        r.notes.includes("tier-crossed") && "long-context tier on later turns",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {results.length === 0 && <div className="empty-note">Add a model above to price a session.</div>}
        <SessionChart results={results} />
        <p className="fine">
          List-price cost at prices as of {CATALOG_META.asOf}, not cost per task. A write "pays off" once the reads it
          enables have saved more than its premium over plain input: (write − input) ÷ (input − read). Compare models
          on the <Link to="/tools/cost">Cost Calculator</Link> for single requests.
        </p>
      </section>
    </>
  );
}

const W = 880;
const H = 300;
const M = { top: 22, right: 170, bottom: 36, left: 64 };

function SessionChart({ results }: { results: ReturnType<typeof sessionCost>[] }) {
  if (!results.length) return null;
  const turns = results[0].turns.length;
  const max = Math.max(...results.map((r) => Number(r.perSession)), 1e-9);
  const x = (t: number) => M.left + ((t - 1) / Math.max(turns - 1, 1)) * (W - M.left - M.right);
  const y = (v: number) => M.top + (1 - v / max) * (H - M.top - M.bottom);
  const yTicks = niceTicks(max);
  const xTicks = niceTicks(turns)
    .map((t) => Math.max(1, t))
    .filter((t, i, a) => t <= turns && a.indexOf(t) === i);
  // End labels: in order of height, each at least 13 units below the one above.
  const labelY = new Map<string, number>();
  [...results]
    .map((r) => ({ key: r.model.key, y: y(Number(r.turns.at(-1)?.cumulative ?? 0)) + 4 }))
    .sort((a, b) => a.y - b.y)
    .reduce((prev, l) => {
      const at = Math.max(l.y, prev + 13);
      labelY.set(l.key, at);
      return at;
    }, -Infinity);
  return (
    <div className="chart-frame" style={{ marginTop: 14 }}>
      <svg
        className="frontier-chart session-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cumulative cost per session by turn for ${results.map((r) => r.model.displayName).join(", ")}; the table above has the totals.`}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
            <text className="axis-label" x={M.left - 8} y={y(v) + 4} textAnchor="end">
              {fmtUsd(new Big(v))}
            </text>
          </g>
        ))}
        <line className="axis" x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} />
        {[...new Set(xTicks)].map((t) => (
          <g key={t}>
            <line className="axis" x1={x(t)} x2={x(t)} y1={H - M.bottom} y2={H - M.bottom + 5} />
            <text className="axis-label" x={x(t)} y={H - M.bottom + 18} textAnchor="middle">
              {t}
            </text>
          </g>
        ))}
        <text className="axis-title" x={W - M.right} y={H - 4} textAnchor="end">
          turn
        </text>
        <text className="axis-title" x={M.left} y={M.top - 2}>
          $ per session, cumulative
        </text>
        {results.map((r, i) => {
          const d = r.turns.map((t, j) => `${j ? "L" : "M"}${x(t.turn)},${y(Number(t.cumulative))}`).join(" ");
          const last = r.turns[r.turns.length - 1];
          if (!last) return null;
          const name = r.model.displayName;
          const short = name.length > 20 ? `${name.slice(0, 19)}…` : name;
          return (
            <g key={r.model.key} className={`session-line ${LINES[i]}`}>
              <path d={d} />
              <line className="swatch-line" x1={x(last.turn) + 6} x2={x(last.turn) + 20} y1={labelY.get(r.model.key)! - 4} y2={labelY.get(r.model.key)! - 4} />
              <text x={x(last.turn) + 24} y={labelY.get(r.model.key)}>
                <title>{name}</title>
                {short}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const step = 10 ** Math.floor(Math.log10(max / 4));
  const mult = [1, 2, 5, 10].find((m) => max / (m * step) <= 5) ?? 10;
  const s = mult * step;
  const out: number[] = [];
  for (let v = 0; v <= max * 1.0001; v += s) out.push(Number(v.toPrecision(6)));
  return out;
}

