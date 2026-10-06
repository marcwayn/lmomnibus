import tapeText from "../data/changes.jsonl?raw";
import { parseTape, type Change } from "./core/changes.ts";

/**
 * The change tape, bundled into its own chunk: only the Ledger and the
 * "since you last looked" strip load it (via dynamic import), so it never
 * weighs on first paint as it grows.
 */
export const TAPE: Change[] = parseTape(tapeText);
