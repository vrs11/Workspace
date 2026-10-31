// Apply a deterministic platform frame and export the real artwork at each
// native/display size. No image-generation service is part of the application.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const source = readFileSync("src-tauri/icons/workspace-source.png");
const output = resolve("artifacts/icon-generation");
mkdirSync(output, { recursive: true });
const frame = join(output, "framed.svg");
writeFileSync(
  frame,
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><clipPath id="tile"><rect width="1024" height="1024" rx="220"/></clipPath></defs><image width="1024" height="1024" clip-path="url(#tile)" href="data:image/png;base64,${source.toString("base64")}"/></svg>`,
);
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const args of [
  ["exec", "tauri", "icon", frame, "--output", join(output, "native")],
  [
    "exec",
    "tauri",
    "icon",
    frame,
    "--output",
    join(output, "toolbar"),
    "--png",
    "16,24,32,48,64,72",
  ],
]) {
  const run = spawnSync(command, args, { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
// This is a desktop application. Retain precisely the native files referenced
// by its bundle configuration; mobile/Store exports stay disposable intermediates.
const icons = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
  .bundle.icon;
for (const path of icons) {
  if (!/^icons\/[^/]+\.(png|ico|icns)$/.test(path))
    throw new Error(`Unexpected desktop icon path: ${path}`);
  copyFileSync(
    join(output, "native", path.slice("icons/".length)),
    join("src-tauri", path),
  );
}
for (const [size, name] of [
  [24, "workspace-icon@1x.png"],
  [48, "workspace-icon.png"],
  [72, "workspace-icon@3x.png"],
])
  copyFileSync(
    join(output, "toolbar", `${size}x${size}.png`),
    join("src/assets", name),
  );
