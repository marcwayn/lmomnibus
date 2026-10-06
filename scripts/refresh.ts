// One catalog refresh: fetch the feed (scripts/ingest.ts) and append what
// changed to data/changes.jsonl (scripts/changes.ts). The daily workflow and
// a by-hand refresh both run exactly this, so neither can skip the tape.
//
//   npm run refresh                 # then: review the diff, npm test, commit
//   npm run refresh -- --allow-shrink

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prev = join(mkdtempSync(join(tmpdir(), "lmo-")), "catalog.json");
copyFileSync("data/catalog.json", prev);
const since: string = JSON.parse(readFileSync("data/catalog-meta.json", "utf8")).as_of;

const run = (script: string, args: string[]) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit" });
run("scripts/ingest.ts", process.argv.slice(2));
run("scripts/changes.ts", ["--prev", prev, "--since", since]);
