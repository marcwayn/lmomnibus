import { Link } from "react-router";
import { allModels } from "../core/catalog.ts";
import { compareReleased, yearMonth } from "../core/model.ts";

const MODELS = allModels();
const VENDOR_COUNT = new Set(MODELS.map((m) => m.vendorKey)).size;
const NEWEST = MODELS.reduce((a, b) => (compareReleased(b.released, a.released) > 0 ? b : a));

export function HomePage() {
  return (
    <header className="masthead">
      <title>LMOmnibus - Instruments for language models</title>
      <h1 className="wordmark-big">
        <span className="lm">LM</span>Omnibus
      </h1>
      <p className="thesis">A workbench of instruments for pricing, comparing, and choosing language models.</p>

      <dl className="meta-strip">
        <div className="meta-cell">
          <dt>Models tracked</dt>
          <dd>{MODELS.length}</dd>
        </div>
        <div className="meta-cell">
          <dt>Vendors</dt>
          <dd>{VENDOR_COUNT}</dd>
        </div>
        <div className="meta-cell">
          <dt>Newest release</dt>
          <dd>
            {NEWEST.displayName} · {yearMonth(NEWEST.released)}
          </dd>
        </div>
        <div className="meta-cell">
          <dt>Priced in</dt>
          <dd>USD / 1M tokens</dd>
        </div>
      </dl>

      <div className="cta-row">
        <Link className="btn btn-primary" to="/tools/cost">
          Open the Cost Calculator →
        </Link>
        <Link className="btn btn-ghost" to="/tools/speed">
          Try the Speed Simulator
        </Link>
      </div>
    </header>
  );
}
