import {
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
// Refuse an existing driver instead of connecting to a stale app instance.
const occupied = await new Promise((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port: 4445 });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  socket.setTimeout(1000, () => {
    socket.destroy();
    resolve(false);
  });
});
if (occupied)
  throw new Error(
    "Desktop test port 4445 is already in use. Finish the owning test app before starting another session.",
  );
mkdirSync("artifacts/desktop-test", { recursive: true });
mkdirSync("artifacts/evidence/desktop", { recursive: true });
const path = "artifacts/desktop-test/session.lock";
let lock;
try {
  lock = openSync(path, "wx", 0o600);
} catch {
  throw new Error(
    "A desktop session lock exists. Finish the owning test session first; do not run two instances against one driver port.",
  );
}
writeFileSync(lock, String(process.pid));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  closeSync(lock);
  unlinkSync(path);
}
const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["exec", "wdio", "run", "tests/desktop/wdio.conf.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      AW_DESKTOP_STABILITY_ONLY: process.argv.includes("--stability")
        ? "1"
        : "0",
      AW_DESKTOP_REPAIR_ONLY: process.argv.includes("--repair") ? "1" : "0",
      AW_DESKTOP_LAUNCH_ONLY: process.argv.includes("--launch") ? "1" : "0",
      AW_DESKTOP_INTEROP_ONLY: process.argv.includes("--interop") ? "1" : "0",
      AW_DESKTOP_FILES_ONLY: process.argv.includes("--files") ? "1" : "0",
      AW_DESKTOP_EXPLORER_ONLY: process.argv.includes("--explorer") ? "1" : "0",
      AW_DESKTOP_FEATURES_ONLY: process.argv.includes("--features") ? "1" : "0",
      AW_DESKTOP_EDITOR_ONLY: process.argv.includes("--editor") ? "1" : "0",
      AW_DESKTOP_VIEWS_ONLY: process.argv.includes("--views") ? "1" : "0",
      AW_DESKTOP_POINTER_ONLY: process.argv.includes("--pointer") ? "1" : "0",
      AW_DESKTOP_DOCKING_ONLY: process.argv.includes("--docking") ? "1" : "0",
      AW_DESKTOP_INTERACTION_ONLY: process.argv.includes("--interaction")
        ? "1"
        : "0",
      AW_DESKTOP_PERFORMANCE_ONLY: process.argv.includes("--performance")
        ? "1"
        : "0",
    },
    detached: process.platform !== "win32",
  },
);
function signalOwned(signal) {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    signalOwned(signal);
    setTimeout(() => signalOwned("SIGKILL"), 2000).unref();
  });
child.on("error", (e) => {
  cleanup();
  throw e;
});
child.on("exit", (code) => {
  signalOwned("SIGTERM");
  cleanup();
  process.exitCode = code ?? 1;
});
