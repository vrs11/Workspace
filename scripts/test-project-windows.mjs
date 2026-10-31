// One prepared, bounded native batch. Preparation never launches a GUI.
import { spawn, execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
const pointer = resolve("artifacts/desktop-test/project-windows-prepared.json");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const binaryName =
  process.platform === "win32" ? "agent-workspace.exe" : "agent-workspace";
if (process.argv.includes("--prepare")) {
  const directory = resolve(
    "artifacts/evidence/project-windows-" +
      new Date().toISOString().replace(/[:.]/g, "-"),
  );
  mkdirSync(directory, { recursive: true });
  const binary = join(directory, binaryName);
  copyFileSync(resolve("artifacts/desktop-test", binaryName), binary);
  chmodSync(binary, 0o755);
  const data = join(directory, "app-data");
  mkdirSync(data);
  const roots = [join(directory, "Project A"), join(directory, "Project B")];
  const git =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "/usr/bin/git";
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const [index, root] of roots.entries()) {
    mkdirSync(root);
    writeFileSync(
      join(root, "hello.ts"),
      `export const project = ${JSON.stringify(index ? "B" : "A")};\n`,
    );
    copyFileSync(
      resolve("tests/fixtures/preview.png"),
      join(root, "preview.png"),
    );
    const run = (...args) =>
      execFileSync(git, args, { cwd: root, env: environment, stdio: "pipe" });
    run("init", "-b", "main");
    run("config", "user.name", "Window Fixture");
    run("config", "user.email", "fixture@example.invalid");
    run("config", "commit.gpgsign", "false");
    run("add", "--all");
    run("commit", "-m", "Fixture");
  }
  writeFileSync(
    join(data, "settings.json"),
    JSON.stringify({
      version: 2,
      git,
      theme: "dark",
      fontSize: 14,
      recent: [
        { id: "fixture", root: roots[0], name: "Project A", trusted: false },
      ],
      shell: process.platform === "win32" ? null : "/bin/sh",
      shellArgs: [],
      terminalFontSize: 14,
      terminalScrollback: 2000,
      autoSaveIdle: false,
      autoSaveDelay: 300,
      autoSaveOnFocusLoss: false,
      keybindings: {},
    }),
  );
  const manifest = {
    directory,
    binary,
    binarySha256: hash(binary),
    data,
    roots,
  };
  writeFileSync(
    join(directory, "prepared.json"),
    JSON.stringify(manifest, null, 2),
  );
  writeFileSync(pointer, JSON.stringify(manifest, null, 2));
  console.log("Prepared native project-window batch; no GUI launched.");
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(pointer, "utf8"));
if (hash(fixture.binary) !== fixture.binarySha256)
  throw Error(
    "Prepared binary changed; prepare a new batch before taking focus",
  );
const lockPath = resolve("artifacts/desktop-test/session.lock");
const lock = openSync(lockPath, "wx", 0o600);
writeFileSync(lock, String(process.pid));
let child,
  browser,
  watchdog,
  complete = false;
const receipt = {
  foregroundFocusTaken: true,
  binarySha256: fixture.binarySha256,
  steps: [],
};
const record = (step) => {
  receipt.steps.push(step);
  console.log(step);
};
const alive = () => {
  if (!child?.pid) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const api = (request) =>
  browser.execute(
    (request) => window.__TAURI__.core.invoke("dispatch", { request }),
    request,
  );
const command = (id) =>
  browser.execute(
    (id) =>
      window.dispatchEvent(
        new CustomEvent("workspace-command", { detail: id, cancelable: true }),
      ),
    id,
  );
async function until(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await pause(80);
  }
  throw Error("Timed out: " + label);
}
async function click(selector) {
  await browser.execute((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw Error("Missing " + selector);
    element.click();
  }, selector);
}
async function textButton(text) {
  await browser.execute((text) => {
    const button = [
      ...document.querySelectorAll('[role="dialog"] button'),
    ].find((b) => b.textContent === text);
    if (!button) throw Error("Missing dialog button " + text);
    button.click();
  }, text);
}
async function dialog() {
  return browser.execute(
    () => document.querySelector('[role="dialog"]')?.textContent ?? "",
  );
}
async function focus(handle) {
  await browser.switchToWindow(handle);
  await until(
    () =>
      browser.execute(
        () =>
          typeof window.__TAURI__?.window?.getCurrentWindow === "function" &&
          !!document.querySelector(".brand-mark"),
      ),
    "new window initialization",
  );
  await browser.execute(() =>
    window.__TAURI__.window.getCurrentWindow().setFocus(),
  );
}
async function paste(selector, text) {
  await browser.execute(
    (selector, text) => {
      const input = document.querySelector(selector);
      if (!input) throw Error("Missing editor/terminal input");
      input.focus();
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    selector,
    text,
  );
}
async function trust() {
  await until(
    () =>
      browser.execute(() => !!document.querySelector(".trust-banner button")),
    "trust banner",
  );
  await click(".trust-banner button");
  await until(() => dialog(), "trust question");
  await click('[role="dialog"] button.primary');
  await until(
    () => browser.execute(() => !document.querySelector(".trust-banner")),
    "trusted project",
  );
}
async function file(name) {
  await until(
    () =>
      browser.execute(
        (name) => !!document.querySelector(`.tree-label[title="${name}"]`),
        name,
      ),
    "file row",
  );
  await browser.execute((name) => {
    const row = document
      .querySelector(`.tree-label[title="${name}"]`)
      .closest('[role="treeitem"]');
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  }, name);
}
async function terminal(marker, root) {
  await click('button[aria-label="New terminal"]');
  await until(
    () =>
      browser.execute(
        () => !!document.querySelector(".terminal-view .xterm-helper-textarea"),
      ),
    "interactive terminal",
  );
  await paste(
    ".terminal-view .xterm-helper-textarea",
    `printf alive > ${marker}\n`,
  );
  await until(
    () => existsSync(join(root, marker)),
    "PTY command in correct project",
  );
}
try {
  const occupied = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 4445 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (occupied) throw Error("Native driver already running");
  const out = openSync(join(fixture.directory, "app.stdout"), "w");
  const err = openSync(join(fixture.directory, "app.stderr"), "w");
  const env = {
    ...process.env,
    AW_APP_DATA_DIR: fixture.data,
    TAURI_WEBDRIVER_PORT: "4445",
    SHELL: process.platform === "win32" ? process.env.SHELL : "/bin/sh",
  };
  delete env.ENV;
  delete env.BASH_ENV;
  child = spawn(fixture.binary, [], {
    cwd: fixture.directory,
    env,
    stdio: ["ignore", out, err],
    detached: process.platform !== "win32",
  });
  closeSync(out);
  closeSync(err);
  watchdog = setTimeout(() => {
    receipt.result = "INTERRUPTED";
    writeFileSync(
      join(fixture.directory, "result.json"),
      JSON.stringify(receipt, null, 2),
    );
    if (alive()) child.kill("SIGTERM");
  }, 180000);
  await until(async () => {
    if (!alive()) throw Error("Native app exited during startup");
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: 4445 });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  }, "native driver");
  const { remote } = await import("webdriverio");
  browser = await remote({
    hostname: "127.0.0.1",
    port: 4445,
    path: "/",
    capabilities: { browserName: "tauri" },
    logLevel: "warn",
    connectionRetryTimeout: 5000,
    connectionRetryCount: 0,
  });
  await focus("main");
  await until(
    () =>
      browser.execute(
        () => !!document.querySelector(".recent-projects button"),
      ),
    "welcome",
  );
  await click(".recent-projects button");
  await trust();
  await file("hello.ts");
  await until(
    () =>
      browser.execute(
        () => !!document.querySelector(".monaco-editor textarea.inputarea"),
      ),
    "editor A",
  );
  await paste(".monaco-editor textarea.inputarea", "// retained-window-A\n");
  const a = (await api({ type: "bootstrap" })).project;
  await terminal("alive-a.txt", fixture.roots[0]);
  record("Project A editor and real PTY running");
  await file("preview.png");
  await until(
    () => browser.execute(() => !!document.querySelector(".media-preview img")),
    "media A",
  );
  const image = await browser.execute(
    () => document.querySelector(".media-preview img").src,
  );
  const opened = await api({ type: "newWindow", path: fixture.roots[1] });
  if (opened.type !== "windowOpened" || opened.existing || !opened.window)
    throw Error("Second window did not open");
  const second = opened.window;
  await until(
    async () => (await browser.getWindowHandles()).length === 2,
    "two windows",
  );
  await focus(second);
  await trust();
  const b = (await api({ type: "bootstrap" })).project;
  if (a.id === b.id) throw Error("Projects share a scope");
  await file("hello.ts");
  await until(
    () =>
      browser.execute(
        () => !!document.querySelector(".monaco-editor textarea.inputarea"),
      ),
    "editor B",
  );
  await paste(".monaco-editor textarea.inputarea", "// retained-window-B\n");
  await terminal("alive-b.txt", fixture.roots[1]);
  let rejected = false;
  try {
    await api({ type: "list", scope: a.id, parent: null });
  } catch {
    rejected = true;
  }
  if (!rejected) throw Error("Cross-window project authority accepted");
  const blocked = await browser.execute(
    (src) =>
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(false);
        image.onerror = () => resolve(true);
        image.src = src;
      }),
    image,
  );
  if (!blocked) throw Error("Cross-window media capability accepted");
  record(
    "Project B isolated editor, PTY, filesystem scope and media capabilities",
  );
  const existing = await api({ type: "newWindow", path: fixture.roots[0] });
  if (
    !existing.existing ||
    existing.window !== "main" ||
    (await browser.getWindowHandles()).length !== 2
  )
    throw Error("Duplicate project was opened twice");
  await focus("main");
  if ((await api({ type: "bootstrap" })).project.id !== a.id)
    throw Error("First project replaced");
  await browser.execute(() =>
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "n",
        code: "KeyN",
        metaKey: /Mac/.test(navigator.platform),
        ctrlKey: !/Mac/.test(navigator.platform),
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await until(
    async () => (await browser.getWindowHandles()).length === 3,
    "configurable New Window shortcut",
  );
  const blank = (await browser.getWindowHandles()).find(
    (h) => h !== "main" && h !== second,
  );
  await focus(blank);
  // Native Close Window waits for destruction outside the closing WebView.
  // An awaited script cannot report success after its own IPC channel closes.
  await browser.closeWindow();
  await until(
    async () => (await browser.getWindowHandles()).length === 2,
    "blank window close",
  );
  record(
    "Existing project focused; New Window shortcut creates an independent window",
  );
  await focus(second);
  await browser.execute(() =>
    window.__TAURI__.window.getCurrentWindow().close(),
  );
  await until(() => dialog(), "window close guard");
  if (!(await dialog()).includes("Unsaved changes"))
    throw Error("Close saved dirty files despite disabled autosave");
  await textButton("Cancel");
  await until(async () => !(await dialog()), "cancel close");
  if ((await browser.getWindowHandles()).length !== 2)
    throw Error("Cancel closed a project");
  if (
    readFileSync(join(fixture.roots[1], "hello.ts"), "utf8").includes(
      "retained-window-B",
    )
  )
    throw Error("Cancelling close changed B's saved file");
  await command("app.quit");
  let target;
  await until(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await dialog()) {
        target = handle;
        return true;
      }
    }
    return false;
  }, "application-wide quit guard");
  await textButton("Cancel");
  await until(async () => !(await dialog()), "cancel application quit");
  if ((await browser.getWindowHandles()).length !== 2)
    throw Error("Cancelled quit terminated another project");
  record(
    "Window close and application quit both preserve projects when cancelled",
  );
  await focus(second);
  await browser.execute(() =>
    window.__TAURI__.window.getCurrentWindow().close(),
  );
  await until(() => dialog(), "close B save decision");
  await textButton("Save all and close");
  await until(
    async () => (await dialog()).includes("terminals"),
    "close B owned-job decision",
  );
  let bCloseError;
  try {
    await textButton("Terminate and close");
  } catch (error) {
    if (!String(error).includes("Channel closed")) throw error;
    bCloseError = String(error);
  }
  await focus("main");
  await until(
    async () => (await browser.getWindowHandles()).length === 1,
    "only B closed",
  );
  if (bCloseError) receipt.bTransportClosedWithWindow = bCloseError;
  if (
    !readFileSync(join(fixture.roots[1], "hello.ts"), "utf8").includes(
      "retained-window-B",
    )
  )
    throw Error("B edits were not saved");
  await paste(
    ".terminal-view .xterm-helper-textarea",
    "printf alive > survived-b-close.txt\n",
  );
  await until(
    () => existsSync(join(fixture.roots[0], "survived-b-close.txt")),
    "A terminal survives B close",
  );
  const appearance = await browser.execute(() => {
    const logo = document.querySelector(".brand-mark");
    return {
      text: document.querySelector(".brand").textContent.trim(),
      loaded: logo.complete && logo.naturalWidth > 0,
      variants: (logo.srcset.match(/\s[123]x(?=,|$)/g) || []).length,
    };
  });
  if (appearance.text || !appearance.loaded || appearance.variants !== 3)
    throw Error("Logo-only header or density variants missing");
  receipt.logo = appearance;
  await browser.saveScreenshot(
    join(fixture.directory, "before-final-quit.png"),
  );
  record("B saved/closed; A buffer and PTY survive; header and logo verified");
  await command("app.quit");
  await until(() => dialog(), "final application quit");
  await textButton("Save all and close");
  await until(
    async () => (await dialog()).includes("terminals"),
    "final owned-job decision",
  );
  try {
    await textButton("Terminate and close");
  } catch (error) {
    if (
      alive() &&
      !/Channel closed|fetch failed|ECONNREFUSED|UND_ERR_SOCKET/.test(String(error))
    )
      throw error;
    receipt.finalTransportClosedWithProcess = true;
  }
  await until(() => !alive(), "acknowledged final process exit");
  if (child.exitCode !== 0 || child.signalCode)
    throw Error("Final quit did not exit normally with status zero");
  if (
    !readFileSync(join(fixture.roots[0], "hello.ts"), "utf8").includes(
      "retained-window-A",
    )
  )
    throw Error("A edits were not saved on final quit");
  record(
    "Confirmed quit saves the final project, closes owned jobs and exits normally",
  );
  receipt.result = "PASS";
  complete = true;
} catch (error) {
  receipt.result = "FAIL";
  receipt.error = String(error.stack ?? error);
  if (browser && alive())
    try {
      await browser.saveScreenshot(join(fixture.directory, "failure.png"));
      writeFileSync(
        join(fixture.directory, "failure.html"),
        await browser.getPageSource(),
      );
    } catch {}
  throw error;
} finally {
  clearTimeout(watchdog);
  if (browser && alive())
    try {
      await browser.deleteSession();
    } catch {}
  if (alive()) child.kill("SIGTERM");
  receipt.inputFreeAt = new Date().toISOString();
  writeFileSync(
    join(fixture.directory, "result.json"),
    JSON.stringify(receipt, null, 2),
  );
  closeSync(lock);
  unlinkSync(lockPath);
  console.log(
    "Native project-window batch finished; keyboard and mouse are free.",
  );
}
if (complete)
  console.log(JSON.stringify({ result: "PASS", checks: receipt.steps.length }));
