// Read-only ordinary-build working-session profile. No driver or input replay.
import { execFileSync } from "node:child_process";
import {
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { preserveEvidence } from "./evidence.mjs";
if (process.platform !== "darwin")
  throw new Error("macOS accounting helper required");
const [pidText, source, editor, fixture] = process.argv.slice(2);
const pid = Number(pidText);
if (
  !Number.isSafeInteger(pid) ||
  pid < 1 ||
  !/^[a-f0-9]{40}$/.test(source ?? "") ||
  !editor ||
  !["editor", "editor-terminal"].includes(fixture)
)
  throw new Error(
    "Usage: node scripts/perf-session-macos.mjs <fixture-pid> <built-source-commit> <file-name> <editor|editor-terminal>",
  );
const uiState = () =>
  JSON.parse(
    execFileSync(
      "python3",
      ["tests/performance/macos-ui-state.py", String(pid)],
      { encoding: "utf8" },
    ),
  );
const uiBefore = uiState(); // Validates fixture identity and suppresses source values.
const validateUi = (state) => {
  if (
    !state.labels.some(
      (x) => x.role === "AXTextArea" && x.label === "Editor content",
    ) ||
    !state.labels.some((x) => x.label === `Close ${editor}`)
  )
    throw new Error("Expected ordinary editor is not exposed in the native UI");
  if (
    fixture === "editor-terminal" &&
    !state.labels.some(
      (x) => x.role === "AXTextArea" && x.label === "Terminal input",
    )
  )
    throw new Error("Expected terminal is not exposed in the native UI");
};
validateUi(uiBefore);
const executable = execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
  encoding: "utf8",
}).trim();
const sample = () =>
  JSON.parse(
    execFileSync("artifacts/performance/macos-resources", [String(pid)], {
      encoding: "utf8",
    }),
  );
const foreground = () => {
  const asn = execFileSync("/usr/bin/lsappinfo", ["front"], {
    encoding: "utf8",
  }).trim();
  const text = execFileSync(
    "/usr/bin/lsappinfo",
    ["info", "-only", "pid", asn],
    { encoding: "utf8" },
  );
  const value = /"pid"=(\d+)/.exec(text);
  if (!value) throw new Error("Native foreground identity unavailable");
  return Number(value[1]);
};
const path = "artifacts/evidence/performance-session.json";
mkdirSync("artifacts/evidence", { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  source,
  host: {
    os: release(),
    architecture: process.arch,
    cpu: cpus()[0].model,
    ramBytes: totalmem(),
    node: process.version,
  },
  dependencies: JSON.parse(readFileSync("package.json", "utf8")).dependencies,
  accountingHelperSha256: createHash("sha256")
    .update(readFileSync("artifacts/performance/macos-resources"))
    .digest("hex"),
  binarySha256: createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex"),
  profile:
    "ordinary optimized isolated performance build; no test driver or injected controls",
  fixture,
  editor,
  uiBefore,
  method:
    "60 one-second libproc app/WebKit/worker/shell coalition samples after settling; CPU deltas fence PID/start time; native foreground PID checked throughout; RSS can double-count shared pages; footprint separate. Read-only AX labels at the boundaries verify exposed views, without exporting source/terminal values. This does not measure physical input or prove every browser paint.",
  power: execFileSync("pmset", ["-g", "custom"], { encoding: "utf8" }),
  idle: null,
};
const save = () => writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
mkdirSync("artifacts/desktop-test", { recursive: true });
const lockPath = "artifacts/desktop-test/session.lock";
const lock = openSync(lockPath, "wx", 0o600);
writeFileSync(lock, String(process.pid));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  closeSync(lock);
  unlinkSync(lockPath);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    report.failure = `Interrupted by ${signal}; owned application remains running`;
    save();
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
try {
  preserveEvidence(path);
  await delay(5000);
  const samples = [sample()],
    foregroundPids = [foreground()];
  if (fixture === "editor-terminal") {
    const shells = samples[0].members.filter((m) => {
      try {
        return /\/(sh|bash|zsh|fish|dash)$/.test(
          execFileSync("/bin/ps", ["-p", String(m.pid), "-o", "comm="], {
            encoding: "utf8",
          }).trim(),
        );
      } catch {
        return false;
      }
    });
    if (shells.length !== 1)
      throw new Error(
        "Full-session fixture requires exactly one live idle shell in the app coalition",
      );
  }
  const counters = new Map(
    samples[0].members.map((m) => [`${m.pid}:${m.startAbstime}`, m.cpuNs]),
  );
  let cpuNs = 0,
    membershipChanges = 0;
  const start = performance.now();
  for (let tick = 0; tick < 60; tick++) {
    await delay(1000);
    const current = sample();
    samples.push(current);
    foregroundPids.push(foreground());
    const present = new Set();
    for (const member of current.members) {
      const key = `${member.pid}:${member.startAbstime}`;
      present.add(key);
      if (counters.has(key))
        cpuNs += Math.max(0, member.cpuNs - counters.get(key));
      else {
        cpuNs += member.cpuNs;
        membershipChanges++;
      }
      counters.set(key, member.cpuNs);
    }
    for (const key of counters.keys())
      if (!present.has(key)) {
        counters.delete(key);
        membershipChanges++;
      }
  }
  const elapsedMs = performance.now() - start;
  report.uiAfter = uiState();
  validateUi(report.uiAfter);
  const foregroundEligible = foregroundPids.every((x) => x === pid);
  const cohortComplete = samples.every(
    (x) => x.hasApp && x.hasWebview && x.queryFailures === 0,
  );
  const cpuPercentOfOneCore = (cpuNs / (elapsedMs * 1e6)) * 100;
  const peakResidentBytes = Math.max(...samples.map((x) => x.residentBytes));
  report.idle = {
    elapsedMs,
    cpuPercentOfOneCore,
    peakResidentBytes,
    peakFootprintBytes: Math.max(...samples.map((x) => x.footprintBytes)),
    membershipChanges,
    foregroundPids,
    samples,
  };
  report.acceptance = {
    foregroundEligible,
    cohortComplete,
    cpuEligible:
      foregroundEligible && cohortComplete && membershipChanges === 0,
    idleCpuBudgetPass:
      foregroundEligible &&
      cohortComplete &&
      membershipChanges === 0 &&
      cpuPercentOfOneCore < 1,
    memoryBudgetPass:
      foregroundEligible &&
      cohortComplete &&
      peakResidentBytes <=
        (fixture === "editor-terminal" ? 500 : 300) * 2 ** 20,
  };
  save();
  console.log(
    JSON.stringify(
      { ...report.acceptance, cpuPercentOfOneCore, peakResidentBytes },
      null,
      2,
    ),
  );
  if (
    !report.acceptance.idleCpuBudgetPass ||
    !report.acceptance.memoryBudgetPass
  )
    process.exitCode = 1;
} catch (error) {
  report.failure = String(error);
  save();
  throw error;
} finally {
  cleanup();
}
