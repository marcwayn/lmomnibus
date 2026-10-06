import { Link } from "react-router";
import { Mark, Meter } from "../components.tsx";
import { allModels, CATALOG_META } from "../core/catalog.ts";
import { relChange, type Change, type ChangeKind } from "../core/changes.ts";
import { daysBetween, daysLabel, todayIso } from "../core/date.ts";
import { fmtRate } from "../core/fmt.ts";
import { encodeKey } from "../core/share.ts";
import { titleFor } from "../routes.ts";
import { TAPE } from "../tape.ts";
import Big from "big.js";

const INTERNAL = { internal: true };
const SECTIONS: { kinds: ChangeKind[]; title: string; note?: string }[] = [
  {
    kinds: ["list_price", "list_correction", "promo_permanent"],
    title: "Vendor list prices",
    note: "Price lists checked by hand against the vendor (“list”).",
  },
  { kinds: ["added"], title: "Newly listed" },
  { kinds: ["removed"], title: "Delisted", note: "With the last price seen." },
  { kinds: ["promo_start", "promo_end", "promo_change"], title: "Promotions" },
  { kinds: ["mode_added", "mode_removed", "tier_change"], title: "Price-list structure" },
  { kinds: ["retirement_scheduled"], title: "Retirements announced" },
];

const pctText = (rel: number) => `${rel < 0 ? "−" : "+"}${Math.abs(Math.round(rel * 100))}%`;

/** old → new; ▲▼ and pine/brick only for real price moves, never for aggregate drift. */
function Move({ pair, neutral }: { pair: [string, string]; neutral?: boolean }) {
  const rel = relChange(pair);
  const fmt = (v: string) => (v === "" ? "none" : fmtRate(new Big(v)));
  const cls = neutral || rel === null || rel === 0 ? "" : rel < 0 ? "down" : "up";
  return (
    <span className={`move ${cls}`}>
      {fmt(pair[0])}
      <Mark kind="to" />
      <span className="sr-only"> to </span>
      {fmt(pair[1])}
      {rel !== null && rel !== 0 && (
        <span className="move-pct">
          {" "}
          {!neutral && <Mark kind={rel < 0 ? "down" : "up"} />}
          {pctText(rel)}
        </span>
      )}
    </span>
  );
}

const FIELDS: [keyof Change, string][] = [
  ["input", "in"],
  ["output", "out"],
  ["cache_read", "cache read"],
  ["cache_write", "cache write"],
];

function Moves({ c, neutral }: { c: Change; neutral?: boolean }) {
  const parts = FIELDS.filter(([f]) => c[f]).map(([f, label]) => (
    <span key={f}>
      {label} <Move pair={c[f] as [string, string]} neutral={neutral} />
    </span>
  ));
  return (
    <span className="ledger-moves">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </span>
  );
}

function Line({ c }: { c: Change }) {
  const name = (
    <Link to={`/models/${c.key}`} state={INTERNAL} className="row-link inline">
      {c.name}
    </Link>
  );
  const head = (
    <>
      {name} <span className="vd">{c.vendor}{c.mode ? ` · ${c.mode}` : ""}</span>
    </>
  );
  switch (c.kind) {
    case "list_price":
    case "list_correction":
      return (
        <>
          {head}
          {c.kind === "list_correction" && <span className="ledger-moves">now a hand-checked list price (was OpenRouter's aggregate)</span>}
          <Moves c={c} />
        </>
      );
    case "aggregate_move":
      return (
        <>
          {head}
          <Moves c={c} neutral />
        </>
      );
    case "promo_permanent":
      return (
        <>
          {head}
          <span className="ledger-moves">launch promo made permanent — the price in force didn't change; list price now matches it</span>
          <Moves c={c} neutral />
        </>
      );
    case "removed":
      return (
        <>
          {head}
          {c.last && (
            <span className="ledger-moves">
              last {fmtRate(new Big(c.last.input))} in / {fmtRate(new Big(c.last.output))} out
              {c.last.mode ? ` (${c.last.mode})` : ""}{" "}
              <ProvenanceTag provenance={c.last.provenance} />
            </span>
          )}
        </>
      );
    case "promo_start":
      return (
        <>
          {head} <span className="ledger-moves">promo started, until {c.until}</span>
        </>
      );
    case "promo_end":
      return (
        <>
          {head} <span className="ledger-moves">promo ended (was until {c.until})</span>
        </>
      );
    case "promo_change":
      return (
        <>
          {head} <span className="ledger-moves">promo terms changed, now until {c.until}</span>
        </>
      );
    case "mode_added":
    case "mode_removed":
      return (
        <>
          {head} <span className="ledger-moves">{c.mode} price list {c.kind === "mode_added" ? "added" : "removed"}</span>
        </>
      );
    case "tier_change":
      return (
        <>
          {head} <span className="ledger-moves">long-context tier prices changed</span>
        </>
      );
    case "retirement_scheduled":
      return (
        <>
          {head} <span className="ledger-moves">retires {c.retires_on}</span>
        </>
      );
    default:
      return head;
  }
}

/** The list / via OR tag for a recorded price whose model may no longer exist. */
function ProvenanceTag({ provenance }: { provenance?: "FirstParty" | "Aggregate" }) {
  return provenance === "FirstParty" ? (
    <span className="src-tag list" title="Vendor list price, checked by hand">
      list
    </span>
  ) : (
    <span className="src-tag agg" title="OpenRouter's aggregate price">
      via OR
    </span>
  );
}

export function LedgerPage() {
  const today = todayIso();
  const dates = [...new Set(TAPE.map((c) => c.date))].sort().reverse();
  const retiring = allModels()
    .filter((m) => m.retiresOn && m.retiresOn >= today)
    .sort((a, b) => (a.retiresOn! < b.retiresOn! ? -1 : 1));

  return (
    <>
      <title>{titleFor("/changes")}</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 04</span>
        <h1>Price Ledger</h1>
        <p className="sub">
          What changed between catalog snapshots. Vendor list prices are kept apart from OpenRouter's aggregate
          prices, which move with the provider mix rather than vendor decisions.
        </p>
        <p className="fine">
          Follow it: <a href="/changes.xml">Atom feed</a> · <a href="/changes.json">JSON</a> · current snapshot{" "}
          {CATALOG_META.asOf}
        </p>
      </div>

      {retiring.length > 0 && (
        <section className="section" aria-labelledby="retiring-h">
          <div className="section-title">
            <h2 id="retiring-h">Retiring soon</h2>
            <span className="count">{retiring.length} scheduled</span>
          </div>
          <ul className="ledger-list">
            {retiring.map((m) => (
              <li key={m.key}>
                <Link to={`/models/${m.key}`} state={INTERNAL} className="row-link inline">
                  {m.displayName}
                </Link>{" "}
                <span className="vd">{m.vendorName}</span>
                <span className="ledger-moves">
                  {m.retiresOn} ({daysLabel(daysBetween(today, m.retiresOn!))}) ·{" "}
                  <Link to={`/tools/switch?from=${encodeKey(m.key)}`} state={INTERNAL}>
                    plan a switch
                    <Mark kind="to" />
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {dates.map((date) => {
        const day = TAPE.filter((c) => c.date === date);
        const aggregate = day.filter((c) => c.kind === "aggregate_move");
        return (
          <section key={date} className="section ledger-day" id={date} aria-labelledby={`h-${date}`}>
            <Meter className="section-break" />
            <div className="section-title">
              <h2 id={`h-${date}`}>
                {date} <span className="since">compared with {day[0].since}</span>
              </h2>
              <span className="count">{day.length} changes</span>
            </div>
            {SECTIONS.map((s) => {
              const items = day.filter((c) => s.kinds.includes(c.kind));
              if (!items.length) return null;
              return (
                <div key={s.title} className="ledger-group">
                  <h3>
                    {s.title} <span className="count">{items.length}</span>
                  </h3>
                  {s.note && <p className="fine">{s.note}</p>}
                  <ul className="ledger-list">
                    {items.map((c, i) => (
                      <li key={`${c.key}-${c.kind}-${c.mode ?? ""}-${i}`}>
                        <Line c={c} />
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {aggregate.length > 0 && (
              <details className="all-plotted">
                <summary>OpenRouter aggregate price moves ({aggregate.length}) — provider mix, not vendor decisions</summary>
                <ul className="ledger-list">
                  {aggregate.map((c, i) => (
                    <li key={`${c.key}-${c.mode}-${i}`}>
                      <Line c={c} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
      {dates.length === 0 && <p className="empty-bench">No changes recorded yet.</p>}
    </>
  );
}
