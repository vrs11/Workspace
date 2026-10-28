import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { cpus, totalmem, release } from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { preserveEvidence } from "./evidence.mjs";

if (process.platform !== "darwin")
  throw new Error(
    "This resource-accounting harness requires macOS; use native platform measurements elsewhere.",
  );
const app = realpathSync(
  process.argv[2] ?? "src-tauri/target/release/bundle/macos/Workspace.app",
);
const identifier = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
if (identifier !== "org.agentworkspace.performance")
  throw new Error(
    "Build with tests/performance/tauri.conf.json first. Refusing to profile or terminate the user's normal application.",
  );
const executable = realpathSync(join(app, "Contents/MacOS/agent-workspace"));
function matchingApplications() {
  return execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match && match[2] === executable)
    .map((match) => Number(match[1]));
}
if (matchingApplications().length)
  throw new Error(
    "The isolated performance application is already running; finish its owning session first.",
  );
const output = resolve("artifacts/performance");
mkdirSync(output, { recursive: true });
// Share the GUI-test lock: profiling must not overlap another native window
// session or steal its foreground state.
mkdirSync("artifacts/desktop-test", { recursive: true });
const lockPath = resolve("artifacts/desktop-test/session.lock");
const lock = openSync(lockPath, "wx", 0o600);
writeFileSync(lock, String(process.pid));
let ownedPid;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  terminateOwned();
  closeSync(lock);
  unlinkSync(lockPath);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
function terminateOwned() {
  if (!ownedPid) return;
  try {
    const command = execFileSync(
      "/bin/ps",
      ["-p", String(ownedPid), "-o", "comm="],
      { encoding: "utf8" },
    ).trim();
    if (command !== executable)
      throw new Error(
        "Performance process identity changed; refusing termination.",
      );
    process.kill(ownedPid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH" && error.status !== 1) throw error;
  } finally {
    ownedPid = undefined;
  }
}
const helper = join(output, "macos-resources");
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
preserveEvidence("artifacts/evidence/performance-desktop.json");
const report = {
  timestamp: new Date().toISOString(),
  host: {
    os: process.platform,
    release: release(),
    arch: process.arch,
    cpu: cpus()[0].model,
    ramGiB: totalmem() / 2 ** 30,
    powerState: execFileSync("pmset", ["-g", "batt"], {
      encoding: "utf8",
    }).split("\n")[0],
    webkitBuild: execFileSync(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleVersion",
        "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist",
      ],
      { encoding: "utf8" },
    ).trim(),
  },
  source: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0,
    node: process.version,
    dependencies: JSON.parse(readFileSync("package.json", "utf8")).dependencies,
  },
  binarySha256: createHash("sha256")
    .update(readFileSync(executable))
    .digest("hex"),
  profile:
    "ordinary optimized release application; separate normal bundle identifier; no desktop driver, remote debug port or test data override",
  fixture: {
    projectOpen: false,
    description:
      "Normal startup/welcome baseline with no active project or shell; not production working-project acceptance",
  },
  method:
    "20 fresh process launches through LaunchServices. OS disk caches are not purged; native elapsed begins at run(), wall elapsed begins before open. Readiness follows bootstrap and two animation frames; a one-second fallback reports painted=false when frames are unavailable and makes the run ineligible for foreground acceptance. No PTY command auto-starts. Resource counters include all members of the app's isolated resource coalition and must include WebKit.",
  launches: [],
  idle: null,
  summary: null,
  remaining: [
    "Warm-focus startup",
    "Typing during terminal/search load",
    "Optimized cached-file input-to-paint",
    "One idle terminal/full-session memory",
    "Physical keyboard/IME and other platforms",
  ],
};
function save() {
  mkdirSync("artifacts/evidence", { recursive: true });
  writeFileSync(
    "artifacts/evidence/performance-desktop.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
function sample() {
  return JSON.parse(
    execFileSync(helper, [String(ownedPid)], { encoding: "utf8" }),
  );
}
try {
  execFileSync("cc", [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "tests/performance/macos-resources.c",
    "-lproc",
    "-o",
    helper,
  ]);
  for (let run = 0; run < 20; run++) {
    const stderr = join(output, `launch-${run}.stderr`),
      stdout = join(output, `launch-${run}.stdout`);
    writeFileSync(stderr, "", { mode: 0o600 });
    writeFileSync(stdout, "", { mode: 0o600 });
    const started = performance.now();
    const launcher = spawn(
      "/usr/bin/open",
      ["-W", "-n", "-a", app, "--stdout", stdout, "--stderr", stderr],
      { stdio: "ignore" },
    );
    let launchFailure;
    launcher.once("error", (error) => {
      launchFailure = error;
    });
    const exited = new Promise((resolve) => launcher.once("exit", resolve));
    let metric;
    while (
      !(metric =
        /AW_METRIC startup_ready_ms=(\d+) pid=(\d+) visible=(true|false) painted=(true|false)/.exec(
          existsSync(stderr) ? readFileSync(stderr, "utf8") : "",
        ))
    ) {
      if (launchFailure) throw launchFailure;
      if (performance.now() - started > 20000) {
        const candidates = matchingApplications();
        if (candidates.length === 1) ownedPid = candidates[0];
        throw new Error(
          `Launch ${run + 1} never acknowledged UI readiness; inspect its private stderr artifact.`,
        );
      }
      await delay(10);
    }
    ownedPid = Number(metric[2]);
    const launch = {
      run: run + 1,
      nativeReadyMs: Number(metric[1]),
      viewVisible: metric[3] === "true",
      paintObserved: metric[4] === "true",
      launchToReadyMs: performance.now() - started,
    };
    report.launches.push(launch);
    save();
    console.log(
      `Launch ${run + 1}/20: native ${launch.nativeReadyMs} ms, LaunchServices-to-ready ${launch.launchToReadyMs.toFixed(1)} ms`,
    );
    if (run === 0) {
      await delay(5000);
      const before = sample(),
        samples = [before];
      const baseline = new Map(
        before.members.map((member) => [
          member.pid + ":" + member.startAbstime,
          member.cpuNs,
        ]),
      );
      let cpuNs = 0,
        membershipChanges = 0;
      const idleStarted = performance.now();
      for (let tick = 0; tick < 60; tick++) {
        await delay(1000);
        const current = sample();
        const present = new Set();
        for (const member of current.members) {
          const key = member.pid + ":" + member.startAbstime;
          present.add(key);
          if (baseline.has(key))
            cpuNs += Math.max(0, member.cpuNs - baseline.get(key));
          else {
            cpuNs += member.cpuNs;
            membershipChanges++;
          }
          baseline.set(key, member.cpuNs);
        }
        for (const key of baseline.keys())
          if (!present.has(key)) {
            baseline.delete(key);
            membershipChanges++;
          }
        samples.push(current);
      }
      const elapsedMs = performance.now() - idleStarted;
      const peakResidentBytes = Math.max(
        ...samples.map((s) => s.residentBytes),
      );
      const peakFootprintBytes = Math.max(
        ...samples.map((s) => s.footprintBytes),
      );
      report.idle = {
        elapsedMs,
        cpuNs,
        cpuPercentOfOneCore: (cpuNs / (elapsedMs * 1e6)) * 100,
        peakResidentBytes,
        peakFootprintBytes,
        membershipChanges,
        samples,
        accounting:
          "macOS libproc coalition SPI for membership; public proc_pid_rusage V4 for RSS/physical footprint/CPU. RSS can double-count shared pages. No native-only fallback. Membership changes leave final exited-process CPU between samples unaccounted and block CPU certification.",
      };
      console.log(
        `Idle sample: ${(peakResidentBytes / 2 ** 20).toFixed(1)} MiB aggregate RSS, ${(peakFootprintBytes / 2 ** 20).toFixed(1)} MiB footprint; ${report.idle.cpuPercentOfOneCore.toFixed(3)}% of one core`,
      );
      save();
    }
    terminateOwned();
    await Promise.race([
      exited,
      delay(5000).then(() => {
        throw new Error("LaunchServices did not observe the owned app exit");
      }),
    ]);
    await delay(250);
  }
  const wallP95Ms = percentile(
    report.launches.map((v) => v.launchToReadyMs),
    0.95,
  );
  const foregroundEligible = report.launches.every(
    (launch) => launch.viewVisible && launch.paintObserved,
  );
  const acceptanceEligible = foregroundEligible && report.fixture.projectOpen;
  report.summary = {
    launches: report.launches.length,
    nativeP95Ms: percentile(
      report.launches.map((v) => v.nativeReadyMs),
      0.95,
    ),
    wallP95Ms,
    foregroundEligible,
    workingProjectAcceptanceEligible: acceptanceEligible,
    processStartupBudgetPass: acceptanceEligible ? wallP95Ms <= 2000 : null,
    idleMemoryBudgetPass: acceptanceEligible
      ? report.idle.peakResidentBytes <= 300 * 2 ** 20
      : null,
    idleCpuBudgetPass: acceptanceEligible
      ? report.idle.membershipChanges === 0 &&
        report.idle.cpuPercentOfOneCore < 1
      : null,
    productionAcceptance:
      "INCOMPLETE: remaining metrics, fixtures, native platforms and release gates remain open",
  };
  save();
  console.log(JSON.stringify(report.summary, null, 2));
} catch (error) {
  report.failure = String(error);
  save();
  throw error;
} finally {
  cleanup();
}
