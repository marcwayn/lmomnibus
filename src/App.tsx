import { lazy, Suspense, useEffect, useRef, type ComponentType } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from "react-router";
import { usePageViews } from "./analytics.ts";
import { Meter, SiteFooter } from "./components.tsx";
import { CostTool } from "./pages/CostTool.tsx";
import { FrontierTool } from "./pages/FrontierTool.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SpeedTool } from "./pages/SpeedTool.tsx";
import { SwitchTool } from "./pages/SwitchTool.tsx";
import { AgentTool } from "./pages/AgentTool.tsx";

// Loaded on demand: it carries the change tape, which grows every day.
const LedgerPage = lazy(() => import("./pages/LedgerPage.tsx").then((m) => ({ default: m.LedgerPage })));
import { ROUTES } from "./routes.ts";

/** Page component per route path; every entry in ROUTES must have one (see routes.test.ts). */
export const PAGES: Record<string, ComponentType> = {
  "/": HomePage,
  "/tools/cost": CostTool,
  "/tools/frontier": FrontierTool,
  "/tools/speed": SpeedTool,
  "/changes": LedgerPage,
  "/tools/switch": SwitchTool,
  "/tools/agent": AgentTool,
};

export function App() {
  return (
    <BrowserRouter>
      <Analytics />
      <RouteFocus />
      <TopNav />
      <main className="shell">
        <Suspense fallback={<p className="loading">Loading…</p>}>
          <Routes>
            {ROUTES.map((r) => {
              const Page = PAGES[r.path];
              return <Route key={r.path} path={r.path} element={<Page />} />;
            })}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <SiteFooter />
    </BrowserRouter>
  );
}

function Analytics() {
  usePageViews();
  return null;
}

/**
 * A client-side route change should behave like a page load: start at the
 * top, and move focus to the new page's heading so screen readers announce it
 * and keyboard users don't stay stranded in the old page's position.
 */
function RouteFocus() {
  const { pathname, hash } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!hash) window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }, [pathname, hash]);
  return null;
}

function TopNav() {
  return (
    <header>
      <div className="topnav">
        <Link className="wordmark" to="/">
          <span className="lm">LM</span>Omnibus
        </Link>
        <nav aria-label="Instruments">
          {ROUTES.filter((r) => r.nav).map((r) => (
            <NavLink key={r.path} to={r.path}>
              <span className="nav-num">{r.nav!.num}</span> {r.nav!.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="topnav-rule">
        <Meter />
      </div>
    </header>
  );
}

function NotFound() {
  return (
    <>
      <title>Page not found — LMOmnibus</title>
      <div className="not-found">
        <span className="eyebrow">404</span>
        <h1>Page not found.</h1>
        <p>
          <Link to="/">Back to the board</Link> · <Link to="/tools/cost">Cost Calculator</Link>
        </p>
      </div>
    </>
  );
}
