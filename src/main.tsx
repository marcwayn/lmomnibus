import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts: no request to Google, nothing render-blocking from a third party.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/500.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { App } from "./App.tsx";
import "./styles.css";

// After a deploy, an open tab's lazy chunks (the Ledger, the change tape)
// no longer exist under their old hashed names. Reload once to pick up the
// new build instead of failing; the session flag stops a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (sessionStorage.getItem("lmo:reloaded")) return;
    sessionStorage.setItem("lmo:reloaded", "1");
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
