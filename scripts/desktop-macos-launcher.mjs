#!/usr/bin/env node
// Launch the isolated packaged test app through LaunchServices. Directly
// spawned bare executables can remain off-screen/hidden on macOS and cannot
// provide meaningful paint timings. Never target the user's normal app.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
if (process.platform !== "darwin") throw new Error("macOS test launcher only");
const app = realpathSync(
  resolve("artifacts/desktop-perf/Workspace Test.app"),
);
const identifier = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
if (identifier !== "org.agentworkspace.desktop-test")
  throw new Error("Refusing a non-test application bundle");
const executable = realpathSync(join(app, "Contents/MacOS/agent-workspace"));
const data = process.env.AW_APP_DATA_DIR;
if (!data) throw new Error("An isolated fixture data directory is required");
function matches() {
  return execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && m[2] === executable)
    .map((m) => Number(m[1]));
}
if (matches().length)
  throw new Error("The private packaged test app already has an owner");
const stderr = join(data, "packaged-test.stderr"),
  stdout = join(data, "packaged-test.stdout");
writeFileSync(stderr, "", { mode: 0o600 });
writeFileSync(stdout, "", { mode: 0o600 });
const args = ["-W", "-n", "-a", app, "--stdout", stdout, "--stderr", stderr];
// LaunchServices deliberately doesn't inherit the caller's environment. Pass
// only the fixture directory, shell and driver configuration; no credentials.
for (const key of ["AW_APP_DATA_DIR", "SHELL", "TAURI_WEBDRIVER_PORT"]) {
  if (process.env[key]) args.push("--env", `${key}=${process.env[key]}`);
}
args.push("--env", "ENV=", "--env", "BASH_ENV=");
let pid,
  stopping = false;
const child = spawn("/usr/bin/open", args, { stdio: "ignore" });
const watch = setInterval(() => {
  if (!pid)
    pid =
      Number(
        /AW_METRIC process_started pid=(\d+)/.exec(
          readFileSync(stderr, "utf8"),
        )?.[1],
      ) || undefined;
}, 10);
function signalOwned(signal) {
  const candidates = pid ? [pid] : matches();
  for (const owned of candidates) {
    try {
      const path = execFileSync(
        "/bin/ps",
        ["-p", String(owned), "-o", "comm="],
        { encoding: "utf8" },
      ).trim();
      if (path === executable) process.kill(owned, signal);
    } catch (error) {
      if (error.code !== "ESRCH" && error.status !== 1) throw error;
    }
  }
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    signalOwned("SIGTERM");
    setTimeout(() => signalOwned("SIGKILL"), 500).unref();
  });
child.once("error", (error) => {
  clearInterval(watch);
  throw error;
});
child.once("exit", (code) => {
  clearInterval(watch);
  signalOwned("SIGTERM");
  process.exitCode = stopping ? 0 : (code ?? 1);
});
