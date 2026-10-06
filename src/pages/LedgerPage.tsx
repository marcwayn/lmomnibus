import { Link } from "react-router";
import { Mark, Meter } from "../components.tsx";
import { allModels, CATALOG_META } from "../core/catalog.ts";
import { relChange, type Change, type ChangeKind } from "../core/changes.ts";
import { daysBetween, todayIso } from "../core/date.ts";
import { fmtRate } from "../core/fmt.ts";
import { encodeKey } from "../core/share.ts";
import { titleFor } from "../routes.ts";
import { TAPE } from "../tape.ts";
import Big from "big.js";

const INTERNAL = { internal: true };
const SECTIONS: { kinds: ChangeKind[]; title: string; note?: string }[] = [
  { kinds: ["list_price"], title: "Vendor list-price changes", note: "Hand-checked vendor prices (“list”)." },
  { kinds: ["added"], title: "Newly listed" },
  { kinds: ["removed"], title: "Delisted", note: "With the last price seen." },
  { kinds: ["promo_start", "promo_end"], title: "Promotions" },
  { kinds: ["mode_added", "mode_removed"], title: "Batch and Fast price lists" },
  { kinds: ["retirement_scheduled"], title: "Retirements announced" },
];

function costLink(key: string) {
  return `/tools/cost?m=${encodeKey(key)}&p=chat`;
}

function Move({ pair }: { pair: [string, string] }) {
  const rel = relChange(pair);
  const cls = rel === null || rel === 0 ? "" : rel < 0 ? "down" : "up";
  return (
    <span className={`move ${cls}`}>
      {fmtRate(new Big(pair[0]))} → {fmtRate(new Big(pair[1]))}
      {rel !== null && rel !== 0 && (
        <span className="move-pct">
          {" "}
          <Mark kind={rel < 0 ? "down" : "up"} />
          {Math.abs(Math.round(rel * 100))}%
        </span>
      )}
    </span>
  );
}

function Line({ c }: { c: Change }) {
  const name = (
    <Link to={costLink(c.key)} state={INTERNAL} className="row-link inline">
      {c.name}
    </Link>
  );
  switch (c.kind) {
    case "list_price":
    case "aggregate_move":
      return (
        <>
          {name} <span className="vd">{c.vendor} · {c.mode}</span>
          <span className="ledger-moves">
            in <Move pair={c.input!} /> · out <Move pair={c.output!} />
          </span>
        </>
      );
    case "removed":
      return (
        <>
          <span className="nm">{c.name}</span> <span className="vd">{c.vendor} · {c.key}</span>
          {c.last && (
            <span className="ledger-moves">
              last {fmtRate(new Big(c.last.input))} / {fmtRate(new Big(c.last.output))}
            </span>
          )}
        </>
      );
    case "promo_start":
      return (
        <>
          {name} <span className="vd">{c.vendor}</span> <span className="ledger-moves">promo started, until {c.until}</span>
        </>
      );
    case "promo_end":
      return (
        <>
          {name} <span className="vd">{c.vendor}</span> <span className="ledger-moves">promo ended (was until {c.until})</span>
        </>
      );
    case "mode_added":
    case "mode_removed":
      return (
        <>
          {name} <span className="vd">{c.vendor}</span>{" "}
          <span className="ledger-moves">
            {c.mode} price list {c.kind === "mode_added" ? "added" : "removed"}
          </span>
        </>
      );
    case "retirement_scheduled":
      return (
        <>
          {name} <span className="vd">{c.vendor}</span> <span className="ledger-moves">retires {c.retires_on}</span>
        </>
      );
    default:
      return (
        <>
          {name} <span className="vd">{c.vendor}</span>
        </>
      );
  }
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
                <span className="nm">{m.displayName}</span> <span className="vd">{m.vendorName}</span>
                <span className="ledger-moves">
                  {m.retiresOn} ({daysBetween(today, m.retiresOn!)} days) ·{" "}
                  <Link to={`/tools/switch?from=${encodeKey(m.key)}`} state={INTERNAL}>
                    plan a switch →
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
