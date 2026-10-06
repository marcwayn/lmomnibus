import { useMemo, useState } from "react";
import { allModels, modelByKey } from "../core/catalog.ts";
import { costFor, DEFAULT_WORKLOAD, type CostBreakdown, type Workload } from "../core/cost.ts";
import { todayIso } from "../core/date.ts";
import { fmtMoney, fmtRate } from "../core/fmt.ts";
import { primaryCard, primaryMode, yearMonth, type Model } from "../core/model.ts";
import { availableYears, search } from "../core/query.ts";
import { trackEvent } from "../analytics.ts";
import { NumberField, U32_MAX } from "../NumberField.tsx";

const YEARS = availableYears(allModels());
const VENDOR_COUNT = new Set(allModels().map((m) => m.vendorKey)).size;

export function CostTool() {
  const [queryText, setQueryText] = useState("");
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [releasedYear, setReleasedYear] = useState<number | null>(null);
  const [bench, setBench] = useState<string[]>([]);
  const [workload, setWorkload] = useState<Workload>(DEFAULT_WORKLOAD);
  const setField = (field: keyof Workload) => (value: number) => setWorkload((w) => ({ ...w, [field]: value }));

  const results = useMemo(
    () => search(allModels(), { text: queryText, vendors: selectedVendors, releasedYear, limit: 25 }),
    [queryText, selectedVendors, releasedYear],
  );

  const today = todayIso();
  const benchCosts = useMemo(() => {
    const rows = bench
      .map((key) => modelByKey(key))
      .filter((m): m is Model => m !== undefined)
      .map((m) => [m, costFor(m, workload, primaryMode(m), today)!] as const);
    return rows.sort((a, b) => a[1].monthlyCost.cmp(b[1].monthlyCost));
  }, [bench, workload, today]);
  const cheapest = benchCosts[0]?.[1].monthlyCost ?? null;

  const addToBench = (key: string) => {
    trackEvent("Cost Calculator", "Add to bench", key);
    setBench((b) => (b.includes(key) ? b : [...b, key]));
  };
  const removeFromBench = (key: string) => setBench((b) => b.filter((k) => k !== key));
  const toggleVendor = (vk: string) =>
    setSelectedVendors((v) => (v.includes(vk) ? v.filter((x) => x !== vk) : [...v, vk]));

  return (
    <>
      <title>LMOmnibus - Cost Calculator</title>
      <div className="tool-head">
        <span className="eyebrow">Tool 01</span>
        <h1>Cost Calculator</h1>
        <p className="sub">
          Search for the models you actually use, add them to the bench, and compare what your workload really costs —
          including long-context tiers and live promotional rates.
        </p>
      </div>

      <section className="section" aria-label="Find models">
        <div className="searchfield">
          <input
            type="text"
            aria-label="Search models"
            placeholder={'Search by model or vendor — try "opus" or "gpt"'}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
          />
          <span className="count">
            {results.totalMatching} match{results.totalMatching === 1 ? "" : "es"}
          </span>
        </div>

        <div className="filters-row">
          <div className="filter-group">
            <label className="filter-label" htmlFor="released-year">
              Released
            </label>
            <select
              id="released-year"
              value={releasedYear ?? ""}
              onChange={(e) => setReleasedYear(e.target.value === "" ? null : Number(e.target.value))}
            >
              <option value="">Any year</option>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="chips">
          {results.vendorCounts.slice(0, 10).map(({ vendorKey, vendorName, count }) => {
            const on = selectedVendors.includes(vendorKey);
            return (
              <button
                key={`${vendorKey}/${vendorName}`}
                type="button"
                className={on ? "chip on" : "chip"}
                aria-pressed={on}
                onClick={() => toggleVendor(vendorKey)}
              >
                {`${vendorName} ${count}`}
              </button>
            );
          })}
        </div>

        <div className="results">
          <div className="res-row hdr">
            <span>Model</span>
            <span className="n rel">Released</span>
            <span className="n">In /MTok</span>
            <span className="n out-rate">Out /MTok</span>
            <span></span>
          </div>
          {results.hits.map((model) => {
            const card = primaryCard(model);
            return (
              <button
                key={model.key}
                type="button"
                className="res-row"
                aria-label={`Add ${model.displayName} to bench`}
                onClick={() => addToBench(model.key)}
              >
                <span>
                  <span className="nm">{model.displayName}</span>
                  <span className="vd">{model.vendorName}</span>
                </span>
                <span className="n rel">{yearMonth(model.released)}</span>
                <span className="n">{fmtRate(card.input)}</span>
                <span className="n out-rate">{fmtRate(card.output)}</span>
                <span className="add">+</span>
              </button>
            );
          })}
          {results.hits.length === 0 && (
            <div className="empty-note">No models match. Try a different name, vendor, or year.</div>
          )}
        </div>
      </section>

      <div className="meter section-break" aria-hidden="true" />

      <section className="section" aria-label="Compare">
        <div className="section-title">
          <h2>Workload</h2>
        </div>
        <div className="inputs-row">
          <NumberField label="Input tokens / request" value={workload.inputTokens} onChange={setField("inputTokens")} min={0} step={100} limit={U32_MAX} />
          <NumberField label="Output tokens / request" value={workload.outputTokens} onChange={setField("outputTokens")} min={0} step={100} limit={U32_MAX} />
          <NumberField label="Requests / month" value={workload.requestsPerMonth} onChange={setField("requestsPerMonth")} min={0} step={1000} limit={U32_MAX} />
          <NumberField
            label="Cached input %"
            value={workload.cachedPct}
            onChange={(v) => setField("cachedPct")(Math.min(v, 100))}
            min={0}
            max={100}
            step={5}
            limit={255}
          />
        </div>

        <div className="section-title bench-head" style={{ marginTop: 32 }}>
          <h2>Bench ({bench.length})</h2>
          {bench.length > 0 && (
            <button className="clear" onClick={() => setBench([])}>
              Clear bench
            </button>
          )}
        </div>

        {bench.length === 0 ? (
          <div className="empty-bench">Search above and add a model to see what it costs.</div>
        ) : (
          <div className="bench-grid">
            {benchCosts.map(([model, breakdown]) => (
              <BenchCard
                key={model.key}
                model={model}
                breakdown={breakdown}
                cheapest={cheapest}
                onRemove={() => removeFromBench(model.key)}
              />
            ))}
          </div>
        )}
      </section>

      <div className="foot">
        <span className="mono">{allModels().length} models tracked</span>
        <span className="mono">{VENDOR_COUNT} vendors</span>
        <span>Built with React</span>
      </div>
    </>
  );
}

interface BenchCardProps {
  model: Model;
  breakdown: CostBreakdown;
  cheapest: CostBreakdown["monthlyCost"] | null;
  onRemove: () => void;
}

function BenchCard({ model, breakdown, cheapest, onRemove }: BenchCardProps) {
  const isCheapest = cheapest !== null && breakdown.monthlyCost.eq(cheapest);
  const card = primaryCard(model);
  const released = yearMonth(model.released);
  const byline =
    breakdown.mode === "Standard"
      ? `${model.vendorName} · ${released}`
      : `${model.vendorName} · ${released} · ${breakdown.mode.toLowerCase()} rate only`;

  return (
    <div className={`bench-card${isCheapest ? " best" : ""}`}>
      <button className="rm" aria-label={`Remove ${model.displayName} from bench`} onClick={onRemove}>
        ×
      </button>
      <div className="bn">{model.displayName}</div>
      <div className="bv">{byline}</div>
      <div className="figure-big">
        {fmtMoney(breakdown.monthlyCost)}
        <span className="figure-unit">/mo</span>
      </div>
      {isCheapest ? (
        <div className="delta down">◆ cheapest on bench</div>
      ) : cheapest !== null ? (
        <div className="delta up">{`▲ ${fmtMoney(breakdown.monthlyCost.minus(cheapest))} vs cheapest`}</div>
      ) : null}
      <div className="delta muted">{`${fmtMoney(breakdown.blendedPerMTok)} blended /MTok`}</div>
      {(breakdown.tierCrossed || breakdown.usesPromo) && (
        <div className="card-notes">
          {breakdown.tierCrossed && (
            <div className="card-note">{`long-context tier: ${fmtRate(breakdown.effectiveInputRate)} in / ${fmtRate(breakdown.effectiveOutputRate)} out`}</div>
          )}
          {breakdown.usesPromo && (
            <div className="card-note">{`promo rate until ${card.promo!.until} · list ${fmtRate(card.input)} / ${fmtRate(card.output)}`}</div>
          )}
        </div>
      )}
    </div>
  );
}
