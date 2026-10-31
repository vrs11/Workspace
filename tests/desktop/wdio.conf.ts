import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pixelFixture } from "./png";
import { browser } from "@wdio/globals";
import { execFileSync } from "node:child_process";
const performanceSuite = process.env.AW_DESKTOP_PERFORMANCE_ONLY === "1";
const packaged =
  process.platform === "darwin" &&
  (performanceSuite || process.env.AW_DESKTOP_PACKAGED === "1");
const desktopBinary =
  process.env.AW_DESKTOP_BINARY ??
  (packaged
    ? resolve("scripts/desktop-macos-launcher.mjs")
    : resolve(
        `artifacts/${performanceSuite ? "desktop-perf" : "desktop-test"}/agent-workspace${process.platform === "win32" ? ".exe" : ""}`,
      ));
if (!process.env.AW_DESKTOP_PROJECT) {
  const sandbox = mkdtempSync(join(tmpdir(), "agent-workspace-desktop-"));
  const project = join(sandbox, "GUI fixture 🌍");
  const data = join(sandbox, "app-data");
  const remote = join(sandbox, "remote.git");
  mkdirSync(project);
  mkdirSync(data);
  const tui = join(sandbox, "terminal-tui.mjs");
  copyFileSync(resolve("tests/fixtures/terminal-tui.mjs"), tui);
  process.env.AW_DESKTOP_TUI = tui;
  const writer = join(sandbox, "terminal-write.mjs");
  copyFileSync(resolve("tests/fixtures/terminal-write.mjs"), writer);
  process.env.AW_DESKTOP_WRITER = writer;
  const flood = join(sandbox, "terminal-flood.mjs");
  copyFileSync(resolve("tests/fixtures/terminal-flood.mjs"), flood);
  process.env.AW_DESKTOP_FLOOD = flood;
  process.env.AW_DESKTOP_NODE = process.execPath;
  process.env.AW_DESKTOP_DATA = data;
  const git =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git";
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (...args: string[]) =>
    execFileSync(git, args, { cwd: project, env });
  run("init", "-b", "main");
  run("config", "user.name", "Desktop Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  run("config", "core.hooksPath", join(project, ".git", "hooks"));
  writeFileSync(
    join(project, "hello.ts"),
    performanceSuite
      ? 'export const greeting = "hello";\n' +
          "// ordinary cached text line\n".repeat(3000)
      : 'export const greeting = "hello";\n',
  );
  if (process.env.AW_DESKTOP_INTERACTION_ONLY === "1")
    writeFileSync(
      join(project, "hello-extra.ts"),
      "export const extra = true;\n",
    );
  if (process.env.AW_DESKTOP_FEATURES_ONLY === "1") {
    writeFileSync(join(project, "pixels.png"), pixelFixture());
    for (const file of ["preview.mp4", "preview.wav", "preview.png"])
      copyFileSync(resolve("tests/fixtures", file), join(project, file));
    for (const [file, text] of Object.entries({
      "preview.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="teal"/></svg>',
      "broken.webm": "invalid media fixture",
      Dockerfile: "FROM alpine:3\nRUN echo hello\n",
      "Cargo.toml": '[package]\nname = "highlight"\nversion = "1.0.0"\n',
      "build.gradle.kts": 'val greeting: String = "hello"\n',
      "App.tsx":
        'export const App = () => <div className="hello">Hello</div>;\n',
    }))
      writeFileSync(join(project, file), text);
  }
  if (process.env.AW_DESKTOP_EDITOR_ONLY === "1")
    writeFileSync(join(project, "multi.txt"), "item1 item2 item3\n");
  if (performanceSuite) {
    mkdirSync(join(project, "load"));
    const content = "search_fixture_bytes\n".repeat(3200);
    for (let index = 0; index < 10000; index++)
      writeFileSync(join(project, "load", `file-${index}.txt`), content);
    writeFileSync(join(project, ".gitignore"), "load/\n");
  }
  if (process.env.AW_DESKTOP_INTEROP_ONLY === "1")
    writeFileSync(
      join(project, "sections.txt"),
      "header\nold first\n" + "context\n".repeat(35) + "old last\n",
    );
  run("add", "--all");
  run("commit", "-m", "Fixture baseline");
  run("init", "--bare", remote);
  run("remote", "add", "origin", remote);
  run("push", "--set-upstream", "origin", "main");
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      version: 1,
      git,
      theme: "dark",
      fontSize: 14,
      shell: process.platform === "win32" ? null : "/bin/sh",
      autoSaveIdle:
        process.env.AW_DESKTOP_EDITOR_ONLY === "1" ||
        process.env.AW_DESKTOP_FEATURES_ONLY === "1",
      autoSaveDelay: process.env.AW_DESKTOP_EDITOR_ONLY === "1" ? 1 : 300,
      autoSaveOnFocusLoss: process.env.AW_DESKTOP_EDITOR_ONLY === "1",
      recent: [
        {
          id: "fixture-untrusted",
          root: project,
          name: "GUI fixture 🌍",
          trusted: false,
        },
      ],
    }),
  );
  if (process.env.AW_DESKTOP_REPAIR_ONLY === "1") {
    copyFileSync(join(data, "settings.json"), join(data, "settings.bak"));
    writeFileSync(join(data, "settings.json"), "damaged preferences");
    writeFileSync(
      join(data, "recovery-preserved.bak"),
      "private checkpoint fixture",
    );
  }
  if (process.platform !== "win32") process.env.SHELL = "/bin/sh";
  delete process.env.ENV;
  delete process.env.BASH_ENV;
  process.env.AW_APP_DATA_DIR = data;
  process.env.AW_DESKTOP_PROJECT = project;
  process.env.AW_DESKTOP_REMOTE = remote;
  process.env.AW_DESKTOP_GIT = git;
}
export const config = {
  runner: "local",
  specs: [
    resolve(
      process.env.AW_DESKTOP_INTEROP_ONLY === "1"
        ? "tests/desktop/interoperability.spec.ts"
        : process.env.AW_DESKTOP_FILES_ONLY === "1"
          ? "tests/desktop/file-transfer.spec.ts"
          : performanceSuite
            ? "tests/desktop/performance.spec.ts"
            : process.env.AW_DESKTOP_STABILITY_ONLY === "1"
              ? "tests/desktop/stability.spec.ts"
              : process.env.AW_DESKTOP_REPAIR_ONLY === "1"
                ? "tests/desktop/repair.spec.ts"
                : process.env.AW_DESKTOP_LAUNCH_ONLY === "1"
                  ? "tests/desktop/launch.spec.ts"
                  : process.env.AW_DESKTOP_INTERACTION_ONLY === "1"
                    ? "tests/desktop/interaction.spec.ts"
                    : process.env.AW_DESKTOP_DOCKING_ONLY === "1"
                      ? "tests/desktop/docking.spec.ts"
                      : process.env.AW_DESKTOP_EXPLORER_ONLY === "1"
                        ? "tests/desktop/explorer.spec.ts"
                        : process.env.AW_DESKTOP_EDITOR_ONLY === "1"
                          ? "tests/desktop/editor.spec.ts"
                          : process.env.AW_DESKTOP_FEATURES_ONLY === "1"
                            ? "tests/desktop/features.spec.ts"
                            : process.env.AW_DESKTOP_POINTER_ONLY === "1"
                              ? "tests/desktop/pointer.spec.ts"
                              : "tests/desktop/workflow.spec.ts",
    ),
  ],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: desktopBinary,
      },
    },
  ],
  services: [
    [
      "tauri",
      {
        appBinaryPath: desktopBinary,
        driverProvider: "embedded",
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 20000,
  connectionRetryTimeout: 60000,
  mochaOpts: {
    grep: process.env.AW_DESKTOP_GREP,
    timeout: process.env.AW_DESKTOP_STABILITY_ONLY === "1" ? 300000 : 180000,
    bail: true,
  },
  before: async () => {
    console.info("Verifying native desktop driver");
    const ready = await browser.execute(
      () => "__wdio_original_core__" in window,
    );
    if (!ready)
      throw new Error(
        "Desktop guest driver missing: rebuild isolated desktop assets with VITE_DESKTOP_TEST=true",
      );
  },
  outputDir: "./artifacts/evidence/desktop",
  beforeTest: async (test: { title: string }) =>
    console.info(`Starting: ${test.title}`),
  afterTest: async (
    test: { title: string },
    _context: unknown,
    _result: { passed: boolean },
  ) => {
    mkdirSync("artifacts/evidence/desktop", { recursive: true });
    const slug = test.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 100);
    await browser.saveScreenshot(`artifacts/evidence/desktop/${slug}.png`);
    await browser.saveScreenshot("artifacts/evidence/desktop/latest.png");
    writeFileSync(
      "artifacts/evidence/desktop/latest.html",
      await browser.getPageSource(),
    );
  },
};
