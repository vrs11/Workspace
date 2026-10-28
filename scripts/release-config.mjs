import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing protected release input: ${name}`);
  return value;
}
function publicHttps(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Release URLs require HTTPS and no embedded credentials/query/fragment",
    );
  return value;
}
export function releaseConfig(platform, env) {
  const pubkey = required(env, "AW_UPDATER_PUBLIC_KEY");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey) ||
    !Buffer.from(pubkey, "base64")
      .toString("utf8")
      .includes("untrusted comment:")
  )
    throw new Error(
      "Updater public key must be the base64-encoded minisign public key",
    );
  const config = {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey,
        endpoints: [publicHttps(required(env, "AW_UPDATER_ENDPOINT"))],
        requireSignedVersion: true,
        allowDowngrades: false,
      },
    },
  };
  if (platform === "darwin") {
    const identity = required(env, "APPLE_SIGNING_IDENTITY");
    if (!identity.startsWith("Developer ID Application: "))
      throw new Error(
        "macOS release requires an approved Developer ID Application identity",
      );
    config.bundle.targets = ["app", "dmg"];
    config.bundle.macOS = { signingIdentity: identity };
  } else if (platform === "win32") {
    const thumbprint = required(env, "AW_WINDOWS_THUMBPRINT");
    if (!/^[0-9A-F]{40}$/.test(thumbprint))
      throw new Error("Invalid Windows identity thumbprint");
    config.bundle.targets = ["nsis", "msi"];
    config.bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      tsp: true,
      timestampUrl: publicHttps(required(env, "AW_WINDOWS_TIMESTAMP_URL")),
    };
  } else if (platform === "linux") {
    config.bundle.targets = ["deb", "appimage"];
  } else throw new Error("Unsupported release platform");
  return config;
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.CI !== "true" || process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Release configuration requires protected main-branch CI");
  mkdirSync("artifacts", { recursive: true });
  writeFileSync(
    "artifacts/protected-release-config.json",
    JSON.stringify(releaseConfig(process.platform, process.env), null, 2),
  );
}
