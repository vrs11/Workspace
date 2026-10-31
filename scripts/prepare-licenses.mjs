import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "artifacts");
const destination = join(artifacts, "legal");
const lock = join(artifacts, ".licenses.lock");
const force = process.argv.includes("--force");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inputs = [
  "package.json",
  "pnpm-lock.yaml",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "rust-toolchain.toml",
  "patches/manifest.json",
  "scripts/license-overrides.json",
  "scripts/licenses.mjs",
  "scripts/license-notices.mjs",
  "scripts/prepare-licenses.mjs",
];
const digest = createHash("sha256").update(
  process.platform + ":" + process.arch,
);
for (const path of inputs)
  digest.update(path).update(readFileSync(join(root, path)));
digest.update(
  execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
);
const inputHash = digest.digest("hex");
function inventory(directory, prefix = "") {
  return Object.fromEntries(
    readdirSync(join(directory, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((item) => {
        const path = prefix ? prefix + "/" + item.name : item.name;
        if (path === "cache.json") return [];
        if (item.isDirectory())
          return Object.entries(inventory(directory, path));
        if (!item.isFile())
          throw new Error("Unexpected legal-cache entry: " + path);
        return [[path, hash(readFileSync(join(directory, path)))]];
      }),
  );
}
function valid() {
  try {
    const cache = JSON.parse(
      readFileSync(join(destination, "cache.json"), "utf8"),
    );
    return (
      cache.inputHash === inputHash &&
      JSON.stringify(cache.files) === JSON.stringify(inventory(destination))
    );
  } catch {
    return false;
  }
}
mkdirSync(artifacts, { recursive: true });
if (!force && valid()) process.exit(0);
const deadline = Date.now() + 120_000;
for (;;) {
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), String(process.pid));
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const owner = Number(readFileSync(join(lock, "owner"), "utf8"));
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if (error.code === "ESRCH") {
            rmSync(lock, { recursive: true });
            continue;
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30_000) {
        rmSync(lock, { recursive: true });
        continue;
      }
    }
    if (Date.now() >= deadline)
      throw new Error("Another license preparation is still running");
    await delay(100);
  }
}
let staging;
try {
  if (!force && valid()) process.exitCode = 0;
  else {
    staging = mkdtempSync(join(artifacts, ".legal-"));
    execFileSync(process.execPath, [join(root, "scripts/licenses.mjs")], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, AW_LICENSE_OUTPUT_DIR: staging },
    });
    writeFileSync(
      join(staging, "cache.json"),
      JSON.stringify({ inputHash, files: inventory(staging) }, null, 2) + "\n",
    );
    const previous = staging + ".previous";
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    console.log(
      "Prepared bundled license resources in ignored artifacts/legal/.",
    );
  }
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
  rmSync(lock, { recursive: true, force: true });
}
