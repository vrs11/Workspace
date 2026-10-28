import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
/** Preserve a previous run once, before writing the next report. */
export function preserveEvidence(path) {
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  let stamp = "undated";
  try {
    stamp = JSON.parse(bytes).timestamp ?? stamp;
  } catch {
    /* Retain malformed evidence too. */
  }
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const directory = "artifacts/evidence/history";
  mkdirSync(directory, { recursive: true });
  const file = `${basename(path, ".json")}-${String(stamp).replace(/[^a-zA-Z0-9-]/g, "-")}-${id}.json`;
  const destination = join(directory, file);
  if (!existsSync(destination)) copyFileSync(path, destination);
}
