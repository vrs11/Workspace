// Ordinary bounded-duration CLI output workload; no application protocol.
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
const proof = process.argv[2];
if (!proof) throw new Error("A disposable fixture proof path is required");
const chunk = Buffer.from(
  "\x1b[32mTERMINAL_LOAD unicode 🌍 0123456789\x1b[0m\r\n".repeat(32),
);
const started = performance.now();
writeFileSync(proof, JSON.stringify({ ready: true, pid: process.pid }));
let bytes = 0;
while (performance.now() - started < 40000) {
  if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
  bytes += chunk.length;
  await delay(2);
}
writeFileSync(
  proof,
  JSON.stringify({
    ready: true,
    done: true,
    bytes,
    elapsedMs: performance.now() - started,
  }),
);
