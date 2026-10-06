import { Fragment, memo, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { fmtCompact } from "../../core/fmt.ts";
import { INDEX_LABEL, scoreOf, type Index } from "../../core/frontier.ts";
import type { Model } from "../../core/model.ts";
import { coverage, sideOf, type Coverage } from "../../core/openclosed.ts";
import { LICENCE_CLASS_LABEL, licenceHref, type LicenceClass } from "../../core/weights.ts";
import { recordFor } from "../../weightsData.ts";
import { fmtScore, fmtTarget, INTERNAL } from "./shared.tsx";

/**
 * §E, "What does each side offer?": capability coverage on each side as
 * paired bars (open-weight filled, closed hollow), and the licences the
 * open-weight models carry.
 */
type BarKey = "tools" | "reasoning" | "image" | "cachePrice" | "rated" | "longContext" | "recent";

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

export function coverageOf(models: readonly Model[], index: Index, today: string, minScore?: number): { open: Coverage; closed: Coverage } {
  return { open: coverage(models, "open", index, today, minScore), closed: coverage(models, "closed", index, today, minScore) };
}

/** §E's answer line: the biggest differences, in percent of each side, figures in mono. */
export function OfferLine({ cov: c }: { cov: { open: Coverage; closed: Coverage } }): ReactNode {
  const parts: [string, BarKey][] = [
    ["Tools", "tools"],
    ["image input", "image"],
    ["a cache-read price", "cachePrice"],
    ["1M+ context", "longContext"],
  ];
  return parts.map(([label, k], i) => (
    <Fragment key={k}>
      {i > 0 && " · "}
      {label}: <span className="mono">{pct(c.open[k], c.open.total)}%</span> of open-weight models,{" "}
      <span className="mono">{pct(c.closed[k], c.closed.total)}%</span> of closed
    </Fragment>
  ));
}

export const CoverageTable = memo(function CoverageTable({ cov, index, onlyAbove, target, onToggle }: {
  cov: { open: Coverage; closed: Coverage };
  index: Index;
  onlyAbove: boolean;
  target: number;
  onToggle: (on: boolean) => void;
}) {
  const rows: [string, BarKey][] = [
    ["Tools", "tools"],
    ["Reasoning", "reasoning"],
    ["Image input", "image"],
    ["Publishes a cache-read price", "cachePrice"],
    [`Rated on AA ${INDEX_LABEL[index]}`, "rated"],
    ["1M+ context", "longContext"],
    ["Listed in the last 90 days", "recent"],
  ];
  const cell = (c: Coverage, k: BarKey, side: "open" | "closed") => (
    <td className="oc-cov-cell">
      <span className="mono oc-cov-n">
        {c[k]}
        <span className="oc-d-only"> / {c.total}</span> · {pct(c[k], c.total)}%
      </span>
      <span className="oc-cov-track" aria-hidden="true">
        <span className={`oc-cov-bar ${side}`} style={{ width: `${pct(c[k], c.total)}%` }} />
      </span>
    </td>
  );
  return (
    <>
      <label className="oc-check">
        <input type="checkbox" checked={onlyAbove} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          Only models scoring ≥ the target (<span className="mono">{fmtTarget(target)}</span> on AA {INDEX_LABEL[index]})
        </span>
      </label>
      <div className="table-frame">
        <table className="market oc-cov">
          <caption className="sr-only">Share of open-weight and closed models with each capability</caption>
          <thead>
            <tr>
              <th>
                <span className="sr-only">Capability</span>
              </th>
              <th>
                <svg className="oc-shape" viewBox="0 0 10 10" aria-hidden="true">
                  <circle cx="5" cy="5" r="4" />
                </svg>{" "}
                Open-weight · {cov.open.total}
              </th>
              <th>
                <svg className="oc-shape" viewBox="0 0 10 10" aria-hidden="true">
                  <rect x="1" y="1" width="8" height="8" />
                </svg>{" "}
                Closed · {cov.closed.total}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, k]) => (
              <tr key={k}>
                <th scope="row">{label}</th>
                {cell(cov.open, k, "open")}
                {cell(cov.closed, k, "closed")}
              </tr>
            ))}
            <tr>
              <th scope="row">Median context</th>
              <td className="mono">{cov.open.total ? fmtCompact(cov.open.medianContext) : "—"}</td>
              <td className="mono">{cov.closed.total ? fmtCompact(cov.closed.medianContext) : "—"}</td>
            </tr>
            <tr>
              <th scope="row">Vendors</th>
              <td className="mono">{cov.open.vendors}</td>
              <td className="mono">{cov.closed.vendors}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="fine">
        Every catalog model on each side{onlyAbove ? " scoring at or above the target" : ""}, before the capability filters (they'd
        make their own rows 100%); the licence filter applies. Capabilities are unions across OpenRouter's providers; one provider
        may lack one.
      </p>
    </>
  );
});

const CLASSES: LicenceClass[] = ["permissive", "custom", "noncommercial", "unclassified"];

/** Where to read a model's licence: as its weights record links it, else the repo it names. */
function licenceLink(m: Model): string | null {
  const r = recordFor(m);
  if (r) return licenceHref(r);
  return m.hfId ? `https://huggingface.co/${m.hfId}` : null;
}

export const LicenceTable = memo(function LicenceTable({ models, index, asOf }: { models: readonly Model[]; index: Index; asOf: string }) {
  const rows = useMemo(() => {
    const open = models.filter((m) => sideOf(m) === "open");
    return CLASSES.map((cls) => {
      const ms = open.filter((m) => (m.weights?.licence ?? "unclassified") === cls);
      const seen = new Map<string, string | null>();
      for (const m of ms) {
        const name = m.weights?.licenceLabel ?? "not read";
        if (!seen.has(name)) seen.set(name, licenceLink(m));
      }
      const example = ms.reduce<Model | null>((a, m) => ((scoreOf(m, index) ?? -1) > (a ? (scoreOf(a, index) ?? -1) : -2) ? m : a), null);
      return {
        cls,
        seen: [...seen].sort((a, b) => a[0].localeCompare(b[0])),
        n: ms.length,
        rated: ms.filter((m) => scoreOf(m, index) !== null).length,
        gated: ms.filter((m) => m.weights?.gated).length,
        example,
      };
    }).filter((r) => r.n > 0);
  }, [models, index]);

  return (
    <>
      <div className="table-frame">
        <table className="market oc-lic">
          <caption className="sr-only">Open-weight models by licence class</caption>
          <thead>
            <tr>
              <th>Class</th>
              <th>Licences seen</th>
              <th className="n">Models</th>
              <th className="n">AA-rated</th>
              <th className="n">Gated</th>
              <th className="oc-lic-example">Best-rated example</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cls}>
                <td className="oc-lic-class">{LICENCE_CLASS_LABEL[r.cls]}</td>
                <td className="oc-lic-seen">
                  {r.seen.map(([name, href], i) => (
                    <span key={name}>
                      {i > 0 && ", "}
                      {href ? (
                        <a href={href} rel="noopener">
                          {name}
                        </a>
                      ) : (
                        name
                      )}
                    </span>
                  ))}
                </td>
                <td className="n">{r.n}</td>
                <td className="n">{r.rated}</td>
                <td className="n">{r.gated}</td>
                <td>
                  {r.example && (
                    <>
                      <Link className="row-link" state={INTERNAL} to={`/models/${r.example.key}`}>
                        {r.example.displayName}
                      </Link>
                      {scoreOf(r.example, index) !== null && (
                        <span className="vd oc-block">AA {fmtScore(scoreOf(r.example, index)!)}</span>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">
        Grouped by the licence named on Hugging Face, as we read it on {asOf}. This is not legal advice: custom terms can add usage
        policies, user caps or attribution requirements. Read the licence. A licence we haven't reviewed is unclassified, never
        assumed permissive. "Gated" means Hugging Face asks you to accept terms before downloading.
      </p>
    </>
  );
});
