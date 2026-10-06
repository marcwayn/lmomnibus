import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Matomo, cookieless: `disableCookies` means nothing is stored in the
 * visitor's browser. Page views are sent by `usePageViews` on every client
 * route change, since the site is a single-page app and Matomo's stock
 * snippet would only ever see the first page. Events carry no workload
 * numbers or search text — only which feature was used.
 */
type Paq = unknown[][];

const URL = import.meta.env.VITE_MATOMO_URL as string | undefined;
const SITE_ID = import.meta.env.VITE_MATOMO_SITE_ID as string | undefined;
const ENABLED = import.meta.env.PROD && Boolean(URL && SITE_ID);

declare global {
  interface Window {
    _paq?: Paq;
  }
}

let loaded = false;

function paq(): Paq {
  return (window._paq = window._paq || []);
}

function load() {
  if (loaded || !ENABLED) return;
  loaded = true;
  const q = paq();
  q.push(["disableCookies"]);
  q.push(["enableLinkTracking"]);
  q.push(["setTrackerUrl", `${URL}matomo.php`]);
  q.push(["setSiteId", SITE_ID]);
  const script = document.createElement("script");
  script.async = true;
  script.src = `${URL}matomo.js`;
  document.head.appendChild(script);
}

/** Sends a page view whenever the route changes (and once on first load). */
export function usePageViews() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!ENABLED) return;
    load();
    const q = paq();
    q.push(["setCustomUrl", window.location.origin + pathname]);
    q.push(["setDocumentTitle", document.title]);
    q.push(["trackPageView"]);
  }, [pathname]);
}

export function trackEvent(category: string, action: string, name?: string) {
  if (!ENABLED) return;
  paq().push(name ? ["trackEvent", category, action, name] : ["trackEvent", category, action]);
}
