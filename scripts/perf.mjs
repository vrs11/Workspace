import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
const output = execFileSync(
  "bash",
  ["scripts/cargo.sh", "run", "--locked", "--example", "performance"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
const report = {
  timestamp: new Date().toISOString(),
  host: {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    ramGiB: os.totalmem() / 1024 ** 3,
  },
  commit: execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim(),
  measurements: JSON.parse(output.trim()),
  releaseAcceptance:
    "BLOCKED: production startup, input latency, total webview/process memory, 60s idle CPU and 100-cycle UI leak tests require separate measurements",
};
mkdirSync("artifacts/evidence", { recursive: true });
writeFileSync(
  "artifacts/evidence/performance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
