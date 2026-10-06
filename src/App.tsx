import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router";
import { CostTool } from "./pages/CostTool.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SpeedTool } from "./pages/SpeedTool.tsx";

export function App() {
  return (
    <BrowserRouter>
      <TopNav />
      <main className="shell">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/tools/cost" element={<CostTool />} />
          <Route path="/tools/speed" element={<SpeedTool />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

function TopNav() {
  return (
    <header>
      <div className="topnav">
        <Link className="wordmark" to="/">
          <span className="lm">LM</span>Omnibus
        </Link>
        <nav>
          <NavLink to="/tools/cost">Cost Calculator</NavLink>
          <NavLink to="/tools/speed">Speed Simulator</NavLink>
        </nav>
      </div>
      <div className="topnav-rule">
        <div className="meter" aria-hidden="true" />
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <>
      <title>LMOmnibus</title>
      <p className="not-found">Page not found.</p>
    </>
  );
}
