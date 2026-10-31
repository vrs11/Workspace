import { $, browser, expect } from "@wdio/globals";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const row = (path: string) => `.tree-label[title="${path}"]`;
async function command(id: string) {
  await browser.execute((id) => {
    window.dispatchEvent(
      new CustomEvent("workspace-command", { detail: id, cancelable: true }),
    );
  }, id);
}
async function select(path: string) {
  await $(row(path)).click();
}
async function point(selector: string) {
  return browser.execute(async (selector) => {
    const api = (
      window as unknown as {
        __TAURI__: {
          window: {
            getCurrentWindow(): {
              innerPosition(): Promise<{ x: number; y: number }>;
              scaleFactor(): Promise<number>;
            };
          };
        };
      }
    ).__TAURI__;
    const win = api.window.getCurrentWindow();
    const [pos, scale] = await Promise.all([
      win.innerPosition(),
      win.scaleFactor(),
    ]);
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return {
      x: pos.x / scale + r.left + Math.min(70, r.width / 2),
      y: pos.y / scale + r.top + r.height / 2,
    };
  }, selector);
}
async function cdp(profile: string) {
  let port = "";
  for (let i = 0; i < 100; i++) {
    try {
      port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(
        "\n",
      )[0];
      break;
    } catch {
      await pause(100);
    }
  }
  if (!port) throw Error("Prepared browser did not start");
  const info = (await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise<void>((done, fail) => {
    socket.onopen = () => done();
    socket.onerror = fail;
  });
  let next = 0;
  const tasks = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id) {
      const task = tasks.get(reply.id)!;
      tasks.delete(reply.id);
      if (reply.error) task.reject(Error(JSON.stringify(reply.error)));
      else task.resolve(reply.result);
    }
  };
  const call = (
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++next;
      tasks.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { socket, call };
}
it("copies files through the system clipboard, drags to a real browser, retains native moves and navigates diffs", async function () {
  if (process.platform !== "darwin") this.skip();
  const root = process.env.AW_DESKTOP_PROJECT!,
    sandbox = dirname(root),
    evidence = resolve("artifacts/evidence/file-interop");
  const outside = join(sandbox, "outside.txt"),
    inbound = join(sandbox, "inbound-folder"),
    sink = join(sandbox, "move-target"),
    profile = join(sandbox, "chrome-profile");
  mkdirSync(inbound, { recursive: true });
  mkdirSync(sink, { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(outside, "OS clipboard to Explorer\n");
  writeFileSync(join(inbound, "nested.txt"), "nested paste\n");
  writeFileSync(join(root, "upload.txt"), "Browser upload bytes\n");
  writeFileSync(join(root, "move.txt"), "Native move bytes\n");
  mkdirSync(join(root, "destination"), { recursive: true });
  const page = join(sandbox, "browser.html");
  writeFileSync(
    page,
    `<!doctype html><title>Workspace file interoperability test</title><style>body{margin:0;background:#18252a;color:white;font:18px system-ui}#target{height:100vh;display:grid;place-content:center;border:4px dashed teal;box-sizing:border-box;outline:0}</style><div id="target" tabindex="0">Drop or paste a file here</div><script>window.results=[];const target=document.querySelector('#target');for(const name of ['dragenter','dragover'])target.addEventListener(name,e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});async function receive(e){e.preventDefault();const files=Array.from((e.dataTransfer||e.clipboardData).files);results.push({kind:e.type,files:await Promise.all(files.map(async f=>({name:f.name,text:await f.text()})))});target.textContent=JSON.stringify(results)}target.addEventListener('drop',receive);target.addEventListener('paste',receive);target.focus();</script>`,
  );
  const helperPath = resolve("artifacts/desktop-test/file-clipboard-macos"),
    dragPath = resolve("artifacts/desktop-test/file-transfer-macos");
  let helper: ChildProcess | undefined,
    chrome: ChildProcess | undefined,
    target: ChildProcess | undefined,
    connection: Awaited<ReturnType<typeof cdp>> | undefined;
  let clipboardText = "",
    targetText = "",
    session = "";
  const clip = async (action: object) => {
    const before = clipboardText.split("\n").length;
    helper!.stdin!.write(JSON.stringify(action) + "\n");
    await browser.waitUntil(() => clipboardText.split("\n").length > before, {
      timeout: 5000,
    });
    return JSON.parse(clipboardText.trim().split("\n").at(-1)!);
  };
  const report: Record<string, unknown> = {};
  try {
    helper = spawn(helperPath, ["serve", sandbox], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    helper.stdout!.on("data", (b) => {
      clipboardText += b;
    });
    await browser.waitUntil(() => clipboardText.includes('"ready":true'), {
      timeout: 5000,
    });
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').click();
    await $(row("upload.txt")).waitForDisplayed();
    await browser.execute(async () => {
      const api = (
        window as unknown as {
          __TAURI__: {
            dpi: {
              LogicalPosition: new (x: number, y: number) => unknown;
              LogicalSize: new (w: number, h: number) => unknown;
            };
            window: {
              getCurrentWindow(): {
                setPosition(p: unknown): Promise<void>;
                setSize(s: unknown): Promise<void>;
                setFocus(): Promise<void>;
              };
            };
          };
        }
      ).__TAURI__;
      const win = api.window.getCurrentWindow();
      await win.setPosition(new api.dpi.LogicalPosition(20, 40));
      await win.setSize(new api.dpi.LogicalSize(850, 700));
      await win.setFocus();
    });
    await select("upload.txt");
    await command("explorer.copy");
    await browser.waitUntil(
      async () =>
        (await clip({ action: "verify", paths: [join(root, "upload.txt")] }))
          .matches,
      { timeout: 5000 },
    );
    report.explorerToSystemClipboard = true;
    await select("destination");
    await command("explorer.paste");
    await browser.waitUntil(() =>
      existsSync(join(root, "destination/upload.txt")),
    );
    expect(readFileSync(join(root, "destination/upload.txt"), "utf8")).toBe(
      "Browser upload bytes\n",
    );
    expect(existsSync(join(root, "upload.txt"))).toBe(true);
    report.internalClipboardCopy = true;
    expect(
      (await clip({ action: "write", paths: [outside, inbound] })).written,
    ).toBe(true);
    await select("destination");
    await command("explorer.paste");
    await browser.waitUntil(() =>
      existsSync(join(root, "destination/inbound-folder/nested.txt")),
    );
    expect(readFileSync(join(root, "destination/outside.txt"), "utf8")).toBe(
      "OS clipboard to Explorer\n",
    );
    expect(existsSync(outside)).toBe(true);
    report.systemClipboardToExplorer = true;
    await select("upload.txt");
    await command("explorer.copy");
    await browser.waitUntil(
      async () =>
        (await clip({ action: "verify", paths: [join(root, "upload.txt")] }))
          .matches,
    );
    chrome = spawn(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--window-position=880,70",
        "--window-size=480,560",
        `--app=file://${page}`,
      ],
      { stdio: "ignore", detached: true },
    );
    connection = await cdp(profile);
    await browser.waitUntil(
      async () => {
        const snapshot = (await connection!.call("Target.getTargets")) as {
          targetInfos: { url: string }[];
        };
        return snapshot.targetInfos.some((target) =>
          target.url.startsWith("file:"),
        );
      },
      { timeout: 10000 },
    );
    const targets = (await connection.call("Target.getTargets")) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const pageTarget = targets.targetInfos.find((t) =>
      t.url.startsWith("file:"),
    )!;
    session = (
      (await connection.call("Target.attachToTarget", {
        targetId: pageTarget.targetId,
        flatten: true,
      })) as { sessionId: string }
    ).sessionId;
    const evaluate = async (expression: string) => {
      const r = (await connection!.call(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        session,
      )) as { result: { value: unknown } };
      return r.result.value;
    };
    await browser.waitUntil(
      async () =>
        (await evaluate(
          "document.readyState === 'complete' && Array.isArray(window.results)",
        )) === true,
      { timeout: 10000 },
    );
    await connection.call("Page.bringToFront", {}, session);
    await evaluate("document.querySelector('#target').focus()");
    execFileSync(helperPath, ["key", "9"], { timeout: 5000 });
    await browser.waitUntil(
      async () =>
        JSON.stringify(await evaluate("results")).includes('"kind":"paste"'),
      { timeout: 8000 },
    );
    expect(JSON.stringify(await evaluate("results"))).toContain(
      "Browser upload bytes",
    );
    report.explorerClipboardToBrowser = true;
    const destination = (await evaluate(
      "({x:screenX+innerWidth/2,y:screenY+(outerHeight-innerHeight)+innerHeight/2})",
    )) as { x: number; y: number };
    const from = await point(row("upload.txt"));
    execFileSync(
      dragPath,
      [
        "drag",
        String(from.x),
        String(from.y),
        String(destination.x),
        String(destination.y),
      ],
      { timeout: 10000 },
    );
    await browser.waitUntil(
      async () =>
        JSON.stringify(await evaluate("results")).includes('"kind":"drop"'),
      { timeout: 8000 },
    );
    expect(existsSync(join(root, "upload.txt"))).toBe(true);
    report.explorerDragToBrowser = true;
    connection.socket.close();
    connection = undefined;
    process.kill(-chrome.pid!, "SIGTERM");
    chrome = undefined;
    target = spawn(dragPath, ["serve", outside, sink], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    target.stdout!.on("data", (b) => {
      targetText += b;
    });
    await browser.waitUntil(() => targetText.includes('"ready":true'), {
      timeout: 5000,
    });
    const geometry = JSON.parse(
      targetText.split("\n").find((l) => l.includes('"ready":true'))!,
    );
    const move = await point(row("move.txt"));
    execFileSync(
      dragPath,
      [
        "drag",
        String(move.x),
        String(move.y),
        String(geometry.targetX),
        String(geometry.targetY),
      ],
      { timeout: 10000 },
    );
    await browser.waitUntil(() => existsSync(join(sink, "move.txt")), {
      timeout: 8000,
    });
    expect(existsSync(join(root, "move.txt"))).toBe(false);
    report.nativeMovePreserved = true;
    target.kill("SIGTERM");
    target = undefined;
    // Compare two separated modifications using the real native Git and Monaco.
    writeFileSync(
      join(root, "sections.txt"),
      "header\nnew first\n" + "context\n".repeat(35) + "new last\n",
    );
    await browser.execute(async () => {
      const api = (
        window as unknown as {
          __TAURI__: {
            core: {
              invoke(
                c: string,
                a: object,
              ): Promise<{ project: { id: string } }>;
            };
            window: { getCurrentWindow(): { setFocus(): Promise<void> } };
          };
        }
      ).__TAURI__;
      await api.window.getCurrentWindow().setFocus();
      const boot = await api.core.invoke("dispatch", {
        request: { type: "bootstrap" },
      });
      window.dispatchEvent(new Event("workspace-refresh"));
      (window as unknown as { __scope: string }).__scope = boot.project.id;
    });
    await $('[aria-label="Changes"]').click();
    await $(
      '[data-git-kind="working"][title="sections.txt"]',
    ).waitForDisplayed();
    await $('[data-git-kind="working"][title="sections.txt"]').click();
    await $('[aria-label="Next change"]').waitForEnabled();
    const monacoAsset =
      "/assets/" +
      readdirSync("dist-desktop-test/assets").find((name) =>
        /^monaco-[\w-]+\.js$/.test(name),
      )!;
    await browser.execute(async (path) => {
      (window as unknown as { __interopMonaco: unknown }).__interopMonaco = (
        await import(path)
      ).monaco;
    }, monacoAsset);
    const line = () =>
      browser.execute(() => {
        const monaco = (
          window as unknown as {
            __interopMonaco: typeof import("monaco-editor");
          }
        ).__interopMonaco;
        return monaco.editor
          .getEditors()
          .find((editor) => editor.getModel()?.getValue().includes("new first"))
          ?.getPosition()?.lineNumber;
      });
    await $('[aria-label="Next change"]').click();
    const first = await line();
    await $('[aria-label="Previous change"]').click();
    const last = await line();
    expect(last).toBeGreaterThan(first!);
    execFileSync(helperPath, ["key", "125", "alt"], { timeout: 5000 });
    await browser.waitUntil(async () => (await line()) !== last);
    report.diffNavigationLines = { first, last };
    await $("button=Inline").click();
    await $('[aria-label="Next change"]').waitForEnabled();
    await $('[aria-label="Next change"]').click();
    report.diffArrowsBothModes = true;
    report.result = "PASS";
  } finally {
    connection?.socket.close();
    if (chrome?.pid)
      try {
        process.kill(-chrome.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    target?.kill("SIGTERM");
    if (helper?.stdin?.writable) {
      try {
        report.clipboardRestored = (await clip({ action: "restore" })).restored;
      } catch {
        helper.kill("SIGTERM");
      }
    }
    writeFileSync(
      join(evidence, "native-interop.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
});
