// Appends what changed between two catalog snapshots to data/changes.jsonl.
//
//   node scripts/changes.ts --prev old-catalog.json --since 2026-10-05
//
// --prev   the catalog before the refresh (the daily workflow copies it aside
//          before running ingest)
// --since  that catalog's as_of date
// The new side is data/catalog.json, dated by data/catalog-meta.json.
// The tape is append-only: rerunning adds only entries it doesn't already
// hold, so a second refresh on the same day can't erase the first.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { appendToTape, diffCatalogs, parseTape, type RawModel } from "../src/core/changes.ts";

const TAPE = "data/changes.jsonl";
const { values: args } = parseArgs({
  options: { prev: { type: "string" }, since: { type: "string" } },
});
if (!args.prev || !args.since) throw new Error("usage: node scripts/changes.ts --prev old.json --since YYYY-MM-DD");

const prev: RawModel[] = JSON.parse(readFileSync(args.prev, "utf8"));
const next: RawModel[] = JSON.parse(readFileSync("data/catalog.json", "utf8"));
const date: string = JSON.parse(readFileSync("data/catalog-meta.json", "utf8")).as_of;

if (args.since > date) throw new Error(`--since ${args.since} is after the new snapshot's date ${date}`);
const fresh = diffCatalogs(prev, next, args.since, date);
const tape = appendToTape(existsSync(TAPE) ? parseTape(readFileSync(TAPE, "utf8")) : [], fresh);
const lines = tape.map((c) => JSON.stringify(c));
writeFileSync(TAPE, lines.length ? lines.join("\n") + "\n" : "");

const counts = fresh.reduce<Record<string, number>>((n, c) => ((n[c.kind] = (n[c.kind] ?? 0) + 1), n), {});
console.error(`${date} vs ${args.since}: ${fresh.length} changes ${JSON.stringify(counts)}`);
