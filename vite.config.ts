import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Client routes that get their own copy of index.html in the build. Keep in
 * sync with the <Route>s in src/App.tsx.
 *
 * Unknown paths already fall back to index.html on Pages, so this isn't
 * needed for routing. It's needed for caching: Pages' edge cache holds HTML
 * per URL, and a new deploy only refreshes the cached copies of paths that
 * exist as files in that deploy. Without a real `tools/cost.html` in every
 * build, an old cached /tools/cost can outlive the deploy that replaced it.
 */
const ROUTE_SHELLS = ["tools/cost", "tools/speed"];

function routeShells(): Plugin {
  let outDir = "dist";
  return {
    name: "route-shells",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      for (const route of ROUTE_SHELLS) {
        const file = join(outDir, `${route}.html`);
        mkdirSync(dirname(file), { recursive: true });
        copyFileSync(join(outDir, "index.html"), file);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), routeShells()],
  server: { port: 5173, strictPort: true },
});
