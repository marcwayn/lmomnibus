import { Link } from "react-router";

export function HomePage() {
  return (
    <header className="masthead">
      <title>LMOmnibus - Instruments for language models</title>
      <h1 className="wordmark-big">
        <span className="lm">LM</span>Omnibus
      </h1>
      <p className="thesis">A workbench of instruments for pricing, comparing, and choosing language models.</p>
      <div className="cta-row">
        <Link className="btn btn-primary" to="/tools/cost">
          {"Open the Cost Calculator ->"}
        </Link>
        <Link className="btn btn-ghost" to="/tools/speed">
          Try the Speed Simulator
        </Link>
      </div>
    </header>
  );
}
