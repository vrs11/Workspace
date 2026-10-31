import { $, $$, browser, expect } from "@wdio/globals";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const row = (name: string) => `.tree-label[title="${name}"]`;
async function point(selector: string) {
  return browser.execute(async (selector) => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const native = (
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
    ).__TAURI__.window.getCurrentWindow();
    const [position, scale] = await Promise.all([
      native.innerPosition(),
      native.scaleFactor(),
    ]);
    const rect = element.getBoundingClientRect();
    return {
      x: position.x / scale + rect.left + Math.min(rect.width / 2, 80),
      y: position.y / scale + rect.top + rect.height / 2,
    };
  }, selector);
}
async function select(name: string, add = false) {
  await browser.execute(
    (selector, add) =>
      document.querySelector(selector)!.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          metaKey: add,
          cancelable: true,
        }),
      ),
    row(name),
    add,
  );
}
async function confirm() {
  await $('[role="dialog"] button.primary').waitForDisplayed();
  await $('[role="dialog"] button.primary').click();
}
it("transfers real files through native OS drags, moves/deletes a multi-selection and preserves external editing", async function () {
  if (process.platform !== "darwin") this.skip();
  const root = process.env.AW_DESKTOP_PROJECT!;
  const sandbox = dirname(root),
    outside = join(sandbox, "native-files"),
    sink = join(sandbox, "native-drop-target");
  mkdirSync(outside);
  mkdirSync(sink);
  mkdirSync(join(root, "destination"));
  const external = join(outside, "fixture.txt");
  writeFileSync(external, "outside workspace\n");
  writeFileSync(join(root, "drag-a.txt"), "alpha\n");
  writeFileSync(join(root, "drag-b.txt"), "beta\n");
  await $(".recent-projects button").click();
  await $(".trust-banner button").waitForDisplayed();
  await $(".trust-banner button").click();
  await confirm();
  await $(row("drag-a.txt")).waitForDisplayed();
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
              setPosition(value: unknown): Promise<void>;
              setSize(value: unknown): Promise<void>;
              setFocus(): Promise<void>;
            };
          };
        };
      }
    ).__TAURI__;
    const win = api.window.getCurrentWindow();
    await win.setPosition(new api.dpi.LogicalPosition(20, 30));
    await win.setSize(new api.dpi.LogicalSize(950, 700));
    await win.setFocus();
  });
  const helperPath = resolve("artifacts/desktop-test/file-transfer-macos");
  const helper = spawn(helperPath, ["serve", external, sink], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "",
    stderr = "";
  helper.stdout!.on("data", (bytes) => {
    text += bytes;
  });
  helper.stderr!.on("data", (bytes) => {
    stderr += bytes;
  });
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    execFileSync(
      helperPath,
      ["drag", String(from.x), String(from.y), String(to.x), String(to.y)],
      { timeout: 10000 },
    );
  let dropPoint: { x: number; y: number } | undefined;
  try {
    await browser.execute(async () => {
      const events: unknown[] = [];
      (window as unknown as { __fileEvents: unknown[] }).__fileEvents = events;
      const api = (
        window as unknown as {
          __TAURI__: {
            event: {
              listen(
                name: string,
                handler: (event: { payload: unknown }) => void,
              ): Promise<unknown>;
            };
          };
        }
      ).__TAURI__;
      document.addEventListener(
        "pointerdown",
        (event) => {
          const target = (event.target as Element).closest<HTMLElement>(
            "[data-file-entry]",
          );
          events.push({
            name: "pointerdown",
            x: event.clientX,
            y: event.clientY,
            entry: target?.title,
            selected: [
              ...document.querySelectorAll(
                '[role="treeitem"][aria-selected="true"]',
              ),
            ].map((row) => row.textContent),
          });
        },
        true,
      );
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke(
              command: string,
              args: { request?: { type: string } },
            ): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      internals.invoke = (command, args) => {
        if (command === "dispatch" && args?.request?.type === "startFileDrag")
          events.push({ name: "startFileDrag", request: args.request });
        return invoke(command, args);
      };
      for (const name of [
        "workspace-native-file",
        "tauri://drag-enter",
        "tauri://drag-drop",
      ])
        await api.event.listen(name, ({ payload }) =>
          events.push({ name, payload }),
        );
    });
    await browser.waitUntil(() => text.includes('"ready":true'), {
      timeout: 10000,
      timeoutMsg: "Native file source did not start: " + stderr,
    });
    const ready = JSON.parse(
      text.split("\n").find((line) => line.includes('"ready":true'))!,
    );
    dropPoint = await point(".editor-area");
    drag({ x: ready.sourceX, y: ready.sourceY }, dropPoint);
    await $('[role="tab"]=fixture.txt').waitForDisplayed();
    console.info("Native editor drop opened the external file");
    await $(".editor-surface textarea.inputarea").waitForExist();
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".editor-surface textarea.inputarea",
      )!;
      input.focus();
      const data = new DataTransfer();
      data.setData("text/plain", "edited externally: ");
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').click();
    await browser.waitUntil(() =>
      readFileSync(external, "utf8").includes("edited externally: "),
    );
    expect(existsSync(join(root, "fixture.txt"))).toBe(false);
    // A second OS drop into Explorer moves the opened external file in place.
    drag(
      { x: ready.sourceX, y: ready.sourceY },
      await point(row("destination")),
    );
    await browser.waitUntil(
      () =>
        !existsSync(external) &&
        existsSync(join(root, "destination/fixture.txt")),
    );
    expect(
      readFileSync(join(root, "destination/fixture.txt"), "utf8"),
    ).toContain("edited externally: ");
    await $(row("destination/fixture.txt")).waitForDisplayed();
    console.info(
      "Native Explorer drop moved the external file and retained its edits",
    );
    await select("drag-a.txt");
    await select("drag-b.txt", true);
    expect(
      await $$('.explorer [role="treeitem"][aria-selected="true"]').length,
    ).toBe(2);
    // The same selection moves within Workspace via a real native drop.
    await browser.execute(async () => {
      await (
        window as unknown as {
          __TAURI__: {
            window: { getCurrentWindow(): { setFocus(): Promise<void> } };
          };
        }
      ).__TAURI__.window
        .getCurrentWindow()
        .setFocus();
    });
    drag(await point(row("drag-a.txt")), await point(row("destination")));
    await browser.waitUntil(
      () =>
        existsSync(join(root, "destination/drag-a.txt")) &&
        existsSync(join(root, "destination/drag-b.txt")),
    );
    if (await $('[aria-label="Expand destination"]').isExisting())
      await $('[aria-label="Expand destination"]').click();
    await $(row("destination/drag-a.txt")).waitForDisplayed();
    await select("destination/drag-a.txt");
    await select("destination/drag-b.txt", true);
    await browser.execute(() =>
      window.dispatchEvent(
        new CustomEvent("workspace-command", {
          detail: "explorer.delete",
          cancelable: true,
        }),
      ),
    );
    await $("h2=Delete 2 items?").waitForDisplayed();
    await confirm();
    await browser.waitUntil(
      () =>
        !existsSync(join(root, "destination/drag-a.txt")) &&
        !existsSync(join(root, "destination/drag-b.txt")),
    );
    expect(existsSync(join(root, "hello.ts"))).toBe(true);
    // Move a separate selection out through a genuine native target.
    writeFileSync(join(root, "out-a.txt"), "out alpha");
    writeFileSync(join(root, "out-b.txt"), "out beta");
    await $('[aria-label="Refresh files"]').click();
    await $(row("out-a.txt")).waitForDisplayed();
    await select("out-a.txt");
    await select("out-b.txt", true);
    await browser.execute(async () => {
      await (
        window as unknown as {
          __TAURI__: {
            window: { getCurrentWindow(): { setFocus(): Promise<void> } };
          };
        }
      ).__TAURI__.window
        .getCurrentWindow()
        .setFocus();
    });
    drag(await point(row("out-a.txt")), { x: ready.targetX, y: ready.targetY });
    await browser.waitUntil(
      () =>
        existsSync(join(sink, "out-a.txt")) &&
        existsSync(join(sink, "out-b.txt")),
    );
    expect(
      !existsSync(join(root, "out-a.txt")) &&
        !existsSync(join(root, "out-b.txt")),
    ).toBe(true);
    expect(readFileSync(join(sink, "out-a.txt"), "utf8")).toBe("out alpha");
    console.info(
      "Native multi-file move out and confirmed internal move/delete passed",
    );
    // Native text drag preservation is covered by the pinned handler's file-only filter.
    writeFileSync(
      "artifacts/evidence/desktop/native-file-transfer.json",
      JSON.stringify(
        {
          result: "PASS",
          nativeIncomingDrop: true,
          outsideProjectEditedInPlace: true,
          nativeMultiFileMoveOut: true,
          nativeExternalExplorerMove: true,
          moveOutRemovesOriginals: true,
          nativeInternalMultiMove: true,
          confirmedMultiDelete: true,
          unselectedFileRetained: true,
          helperOutput: text,
          limits:
            "Synthetic macOS mouse events and native AppKit drag sessions; other platforms unverified",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    const events = await browser
      .execute(
        () => (window as unknown as { __fileEvents: unknown[] }).__fileEvents,
      )
      .catch(() => []);
    writeFileSync(
      "artifacts/evidence/desktop/native-file-transfer-trace.json",
      JSON.stringify({ helper: text, stderr, dropPoint, events }, null, 2) +
        "\n",
    );
    helper.kill("SIGTERM");
  }
});
