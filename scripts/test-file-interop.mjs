// Prepare first, then run one bounded native batch after foreground readiness.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
const pointer = resolve("artifacts/desktop-test/file-interop-prepared.json");
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
if (process.argv.includes("--prepare")) {
  if (
    process.platform !== "darwin" ||
    !existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  )
    throw Error(
      "The native interoperability batch requires macOS and the existing Chrome installation.",
    );
  const preparedPath = resolve(
    "artifacts/evidence/runs/file-interop-" +
      new Date().toISOString().replaceAll(/[:.]/g, "-"),
  );
  mkdirSync(preparedPath, { recursive: true });
  const evidence = realpathSync(preparedPath);
  const binary = join(evidence, "agent-workspace");
  copyFileSync("artifacts/desktop-test/agent-workspace", binary);
  chmodSync(binary, 0o755);
  const root = join(evidence, "project"),
    data = join(evidence, "app-data");
  mkdirSync(root);
  mkdirSync(data);
  const git = "/usr/bin/git",
    env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
  const run = (...args) =>
    execFileSync(git, args, { cwd: root, env, stdio: "pipe" });
  run("init", "-b", "main");
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "hello.ts"), 'export const greeting = "hello";\n');
  writeFileSync(
    join(root, "sections.txt"),
    "header\nold first\n" + "context\n".repeat(35) + "old last\n",
  );
  run("add", "--all");
  run("commit", "-m", "Fixture baseline");
  writeFileSync(join(root, "upload.txt"), "Browser upload bytes\n");
  writeFileSync(join(root, "move.txt"), "Native move bytes\n");
  mkdirSync(join(root, "destination"));
  writeFileSync(join(evidence, "outside.txt"), "OS clipboard to Explorer\n");
  mkdirSync(join(evidence, "inbound-folder"));
  writeFileSync(join(evidence, "inbound-folder/nested.txt"), "nested paste\n");
  mkdirSync(join(evidence, "move-target"));
  mkdirSync(join(evidence, "chrome-profile"));
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      version: 1,
      git,
      theme: "dark",
      fontSize: 14,
      shell: "/bin/sh",
      autoSaveIdle: false,
      autoSaveDelay: 300,
      autoSaveOnFocusLoss: false,
      recent: [
        {
          id: "fixture-untrusted",
          root,
          name: "Interop fixture",
          trusted: false,
        },
      ],
    }),
  );
  const inputs = [
    binary,
    "artifacts/desktop-test/file-transfer-macos",
    "artifacts/desktop-test/file-clipboard-macos",
    "tests/desktop/interoperability.spec.ts",
    "tests/desktop/wdio.conf.ts",
    "scripts/desktop-test.mjs",
  ];
  const plan = {
    evidence,
    root,
    data,
    binary,
    git,
    hashes: Object.fromEntries(inputs.map((p) => [resolve(p), hash(p)])),
  };
  writeFileSync(pointer, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(
    join(evidence, "prepared.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
  console.log(
    "Native file interoperability fixtures, tools and frozen test binary prepared without launching a GUI.",
  );
} else if (process.argv.includes("--run")) {
  const plan = JSON.parse(readFileSync(pointer, "utf8"));
  for (const [path, digest] of Object.entries(plan.hashes))
    if (hash(path) !== digest) throw Error("Prepared input changed: " + path);
  const env = {
    ...process.env,
    AW_DESKTOP_PROJECT: plan.root,
    AW_DESKTOP_DATA: plan.data,
    AW_APP_DATA_DIR: plan.data,
    AW_DESKTOP_GIT: plan.git,
    AW_DESKTOP_BINARY: plan.binary,
    SHELL: "/bin/sh",
  };
  delete env.ENV;
  delete env.BASH_ENV;
  const child = spawn("node", ["scripts/desktop-test.mjs", "--interop"], {
    env,
    stdio: "inherit",
  });
  const timer = setTimeout(() => {
    console.error(
      "Prepared foreground window reached its 3-minute limit; stopping this batch.",
    );
    child.kill("SIGTERM");
  }, 180000);
  const code = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", done);
  });
  clearTimeout(timer);
  writeFileSync(
    join(plan.evidence, "exit.json"),
    JSON.stringify({ exitCode: code }) + "\n",
  );
  console.log("Foreground interoperability batch finished; input is free.");
  process.exitCode = code ?? 1;
} else
  throw Error(
    "Use --prepare or --run; preparation never starts a foreground session.",
  );
