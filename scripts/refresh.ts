// One catalog refresh: fetch the feed (scripts/ingest.ts), re-read the
// open-weight models' Hugging Face repos (scripts/hf.ts), and append what
// changed to data/changes.jsonl (scripts/changes.ts). The daily workflow and
// a by-hand refresh both run exactly this, so neither can skip the tape.
//
//   npm run refresh                 # then: review the diff, npm test, commit
//   npm run refresh -- --allow-shrink
//
// Hugging Face is best effort: hf.ts keeps the previous weights files when
// too many repos fail, and if it fails outright the prices still refresh.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prev = join(mkdtempSync(join(tmpdir(), "lmo-")), "catalog.json");
copyFileSync("data/catalog.json", prev);
const since: string = JSON.parse(readFileSync("data/catalog-meta.json", "utf8")).as_of;

const run = (script: string, args: string[], timeout?: number) =>
  execFileSync(process.execPath, [script, ...args], { stdio: "inherit", timeout });
run("scripts/ingest.ts", process.argv.slice(2));
try {
  // hf.ts stops itself after 20 minutes; this is the backstop for a hung process.
  run("scripts/hf.ts", [], 25 * 60_000);
} catch (e) {
  const status = (e as { status?: number | null }).status;
  console.warn(
    `warning: scripts/hf.ts failed${status ? ` (exit ${status})` : ""}; keeping the previous data/weights.json and data/weights-index.json. Prices still refresh.`,
  );
}
run("scripts/changes.ts", ["--prev", prev, "--since", since]);
