import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifyPackageResources } from "./package-resources.mjs";
if (process.env.CI !== "true" || process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error(
    "Signed output verification requires protected main-branch CI",
  );
const root = "src-tauri/target/release/bundle";
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return []; // App framework links are checked by codesign.
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const inventory = files(root);
const config = JSON.parse(
  readFileSync("artifacts/protected-release-config.json", "utf8"),
);
const version = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
).version;
const signed = inventory.filter((path) => path.endsWith(".sig"));
if (!signed.length) throw new Error("No signed updater artifacts produced");
for (const suffix of process.platform === "darwin"
  ? [".dmg", ".app.tar.gz.sig"]
  : process.platform === "win32"
    ? [".exe", ".msi"]
    : [".deb", ".AppImage", ".AppImage.sig"])
  if (!inventory.some((path) => path.endsWith(suffix)))
    throw new Error(`Missing required package: ${suffix}`);
if (process.platform === "darwin") {
  const app = join(root, "macos", "Workspace.app");
  verifyPackageResources(join(app, "Contents", "Resources"));
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "inherit",
  });
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  execFileSync("spctl", ["--assess", "--type", "execute", app], {
    stdio: "inherit",
  });
} else if (process.platform === "win32") {
  execFileSync(
    "pwsh",
    ["-NoProfile", "-File", "scripts/verify-windows-signatures.ps1"],
    { stdio: "inherit" },
  );
}
const artifacts = signed.map((signaturePath) => {
  const path = signaturePath.slice(0, -4);
  const bytes = readFileSync(path);
  if (!bytes.length) throw new Error("Empty updater artifact");
  return {
    path: resolve(path),
    signature: readFileSync(signaturePath, "utf8").trim(),
    size: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});
writeFileSync(
  "artifacts/release-artifacts.json",
  JSON.stringify(
    { version, publicKey: config.plugins.updater.pubkey, artifacts },
    null,
    2,
  ),
);
// Actual application verifier: cryptographic payload + trusted version, with no download/install.
execFileSync(
  "bash",
  [
    "scripts/cargo.sh",
    "test",
    "--test",
    "updates",
    "--locked",
    "protected_release_artifacts",
    "--",
    "--ignored",
    "--exact",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      AW_RELEASE_MANIFEST: resolve("artifacts/release-artifacts.json"),
    },
  },
);
console.log(
  `Verified ${artifacts.length} signed updater artifacts; native upgrade/interruption testing remains a separate release gate.`,
);
