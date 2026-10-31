import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const graph = execFileSync(
  "bash",
  ["scripts/cargo.sh", "tree", "--locked", "-e", "normal"],
  { encoding: "utf8" },
);
if (/tauri-plugin-single-instance/.test(graph))
  throw new Error("An application-wide single-instance dependency must not ship");
if (/tauri-plugin-wdio/.test(graph))
  throw new Error("Test driver appears in ordinary native dependency graph");
for (const file of readdirSync("dist/assets").filter((f) => f.endsWith(".js")))
  if (
    /__wdio_original_core__|TAURI_WEBDRIVER_PORT|plugin:wdio/.test(
      readFileSync(join("dist/assets", file), "utf8"),
    )
  )
    throw new Error(`Test helper leaked into ordinary web assets: ${file}`);
const binary = `src-tauri/target/release/agent-workspace${process.platform === "win32" ? ".exe" : ""}`;
const bytes = readFileSync(binary);
const updaterPolicy = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
).plugins.updater;
if (
  updaterPolicy.requireSignedVersion !== true ||
  updaterPolicy.allowDowngrades !== false ||
  [
    "dangerousInsecureTransportProtocol",
    "dangerousAcceptInvalidCerts",
    "dangerousAcceptInvalidHostnames",
  ].some((key) => updaterPolicy[key] === true)
)
  throw new Error(
    "Release updater transport/version/signature policy was weakened",
  );
for (const marker of [
  "TAURI_WEBDRIVER_PORT",
  "AW_APP_DATA_DIR",
  "/wdio/eval",
  "DURABLE_FIXTURE_ACK",
  "disposable-fixture-marker",
])
  if (bytes.includes(Buffer.from(marker)))
    throw new Error(
      `Test control marker present in ordinary binary: ${marker}`,
    );
console.log(
  "Ordinary native graph, binary and bundled frontend exclude test-driver controls.",
);
