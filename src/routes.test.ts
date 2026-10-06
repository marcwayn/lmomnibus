import { describe, expect, it } from "vitest";
import { PAGES } from "./App.tsx";
import { ROUTES } from "./routes.ts";

describe("route table", () => {
  // Every route needs a page and a build-time HTML shell. With 404.html in
  // the build, Pages no longer falls back to index.html, so a route missing
  // from the table would hard-404 in production.
  it("has a page component for every route, and no page without a route", () => {
    expect(Object.keys(PAGES).sort()).toEqual(ROUTES.map((r) => r.path).sort());
  });

  it("gives every route a title, a description and a preview image", () => {
    for (const r of ROUTES) {
      expect(r.title).toBeTruthy();
      expect(r.description({ as_of: "2026-01-01", models: 1 })).toBeTruthy();
      expect(r.ogImage).toMatch(/^\/og\/[a-z]+\.png$/);
    }
  });
});
