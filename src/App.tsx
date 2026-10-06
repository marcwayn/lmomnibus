import { Component, lazy, Suspense, useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigationType } from "react-router";
import { usePageViews } from "./analytics.ts";
import { Meter, SiteFooter } from "./components.tsx";
import { CostTool } from "./pages/CostTool.tsx";
import { FrontierTool } from "./pages/FrontierTool.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SpeedTool } from "./pages/SpeedTool.tsx";
import { SwitchTool } from "./pages/SwitchTool.tsx";
import { AgentTool } from "./pages/AgentTool.tsx";
import { ModelPage } from "./pages/ModelPage.tsx";

// Loaded on demand: the Ledger carries the change tape, which grows every day;
// the open-weights tools carry the Hugging Face architecture data.
const LedgerPage = lazy(() => import("./pages/LedgerPage.tsx").then((m) => ({ default: m.LedgerPage })));
const OpenTool = lazy(() => import("./pages/OpenTool.tsx").then((m) => ({ default: m.OpenTool })));
const VramTool = lazy(() => import("./pages/VramTool.tsx").then((m) => ({ default: m.VramTool })));
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
  "/tools/open": OpenTool,
  "/tools/vram": VramTool,
};

export function App() {
  return (
    <BrowserRouter>
      <Analytics />
      <RouteFocus />
      <TopNav />
      <main className="shell">
        <PageErrorBoundary>
        <Suspense fallback={<p className="loading">Loading…</p>}>
          <Routes>
            {ROUTES.map((r) => {
              const Page = PAGES[r.path];
              return <Route key={r.path} path={r.path} element={<Page />} />;
            })}
            <Route path="/models/*" element={<ModelPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </PageErrorBoundary>
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
  const navType = useNavigationType();
  const first = useRef(true);
  const prev = useRef({ pathname, hash });
  useEffect(() => {
    const was = prev.current;
    prev.current = { pathname, hash };
    if (first.current) {
      first.current = false;
      return;
    }
    // Same page: only a new anchor counts. A tool's URL-sync replace drops the hash, and
    // that mustn't throw the reader back to the top.
    if (was.pathname === pathname && !hash) return;
    // Back/Forward restore the previous position; only new navigations start at the top.
    if (!hash && navType !== "POP") window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
    // Only a new page or anchor: the tools' own replace navigations (URL sync)
    // keep the same pathname and mustn't move scroll or focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, hash]);
  return null;
}

/** A page that throws (or a chunk that won't load) offers a reload instead of a blank screen. */
class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="not-found">
        <span className="eyebrow">Something broke</span>
        <h1>This page didn't load.</h1>
        <p>
          The site may have just been updated.{" "}
          <button type="button" className="text-btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      </div>
    );
  }
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
