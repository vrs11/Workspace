import { startDrag, dropOn } from "./fileDragActions";
import { terminalAction, gitAction, explorerAction } from "./terminalActions";
import { $, browser, expect } from "@wdio/globals";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
const quote = (text: string) =>
  process.platform === "win32"
    ? `"${text.replaceAll('"', '""')}"`
    : `'${text.replaceAll("'", "'\\''")}'`;
async function confirm() {
  await $('[role="dialog"] button.primary').waitForDisplayed();
  await $('[role="dialog"] button.primary').click();
}
async function pasteTerminal(text: string) {
  await browser.execute((value) => {
    const input = document.querySelector<HTMLTextAreaElement>(
      ".terminal-view.active-pane .xterm-helper-textarea",
    )!;
    input.focus();
    const data = new DataTransfer();
    data.setData("text/plain", value);
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
}
async function startPanelDrag(panel: string) {
  await browser.execute((panel) => {
    const grip = document.querySelector<HTMLElement>(
      `[data-dock-panel="${panel}"] .dock-grip`,
    )!;
    const box = grip.getBoundingClientRect();
    const x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    if (!grip.contains(document.elementFromPoint(x, y)))
      throw new Error(`${panel} drag grip is covered`);
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 9,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    };
    grip.dispatchEvent(new PointerEvent("pointerdown", init));
    grip.dispatchEvent(
      new PointerEvent("pointermove", { ...init, clientX: x + 8 }),
    );
  }, panel);
  await $(".dock-workspace.is-dragging").waitForExist();
}
async function dropPanelOn(selector: string) {
  await browser.execute((selector) => {
    const target = document.querySelector<HTMLElement>(selector)!;
    const box = target.getBoundingClientRect();
    const x = box.left + box.width / 2,
      y = box.top + box.height / 2;
    if (!target.contains(document.elementFromPoint(x, y)))
      throw new Error("Dock drop target is covered");
    const init = {
      bubbles: true,
      cancelable: true,
      pointerId: 9,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    };
    target.dispatchEvent(new PointerEvent("pointermove", init));
    target.dispatchEvent(
      new PointerEvent("pointerup", { ...init, buttons: 0 }),
    );
  }, selector);
  await browser.waitUntil(
    async () => !(await $(".dock-workspace.is-dragging").isExisting()),
  );
}
describe("independent movable workspace panes and real file drops", () => {
  it("docks panes without restarting PTYs, moves dirty files safely, and restores the layout", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await confirm();
    await $('[data-dock-panel="git"]').waitForDisplayed();
    const editor = $('[data-dock-panel="editor"]'),
      git = $('[data-dock-panel="git"]'),
      terminal = $('[data-dock-panel="terminal"]');
    expect((await git.getLocation()).x).toBeGreaterThan(
      (await editor.getLocation()).x,
    );
    expect((await terminal.getLocation()).y).toBeGreaterThan(
      (await editor.getLocation()).y,
    );
    expect(
      await browser.execute(() =>
        document
          .querySelector(".git-panel")
          ?.closest("[data-dock-panel]")
          ?.getAttribute("data-dock-panel"),
      ),
    ).toBe("git");
    expect(
      await browser.execute(() =>
        document
          .querySelector(".terminal-panel")
          ?.closest("[data-dock-panel]")
          ?.getAttribute("data-dock-panel"),
      ),
    ).toBe("terminal");
    await $('.tree-label[title="hello.ts"]').doubleClick();
    await $(".monaco-editor textarea.inputarea").waitForExist();
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-editor textarea.inputarea",
      )!;
      input.focus();
      const data = new DataTransfer();
      data.setData("text/plain", "// unsaved docking\n");
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').waitForEnabled();
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-view .xterm-helper-textarea").waitForExist();
    const root = process.env.AW_DESKTOP_PROJECT!;
    await pasteTerminal(
      `${quote(process.env.AW_DESKTOP_NODE!)} ${quote(process.env.AW_DESKTOP_WRITER!)} started.txt b25jZQ== write\n`,
    );
    await browser.waitUntil(() => existsSync(join(root, "started.txt")));
    const session = await $(".terminal-view").getAttribute("data-session");
    expect(session).toBeTruthy();
    const compactGeometry = await browser.execute(() => {
      const panel = document
        .querySelector('[data-dock-panel="terminal"]')!
        .getBoundingClientRect();
      const surface = document
        .querySelector(".terminal-surface")!
        .getBoundingClientRect();
      const title = document
        .querySelector('[data-dock-panel="terminal"] .dock-header')!
        .getBoundingClientRect();
      const tabs = document
        .querySelector(".terminal-tabs")!
        .getBoundingClientRect();
      return {
        panelHeight: panel.height,
        surfaceHeight: surface.height,
        chrome: surface.top - panel.top,
        titleHeight: title.height,
        tabsTop: tabs.top,
        titleTop: title.top,
      };
    });
    expect(compactGeometry.chrome).toBeLessThanOrEqual(32);
    expect(compactGeometry.surfaceHeight).toBeGreaterThanOrEqual(
      compactGeometry.panelHeight - 32,
    );
    expect(compactGeometry.titleHeight).toBe(29);
    writeFileSync(
      "artifacts/evidence/desktop/terminal-density.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "native GUI with embedded test driver; geometry only, not production performance",
          ...compactGeometry,
        },
        null,
        2,
      ) + "\n",
    );
    expect(
      Math.abs(compactGeometry.tabsTop - compactGeometry.titleTop),
    ).toBeLessThan(2);
    expect(await $('input[aria-label="Find in terminal"]').isExisting()).toBe(
      false,
    );
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".terminal-view.active-pane .xterm-helper-textarea",
      )!;
      input.focus();
      const mac = navigator.platform.includes("Mac");
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('input[aria-label="Find in terminal"]').waitForDisplayed();
    expect(
      await browser.execute(() =>
        document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Find in terminal");
    expect((await $(".terminal-surface").getSize()).height).toBe(
      compactGeometry.surfaceHeight,
    );
    await browser.execute(() =>
      document
        .querySelector('input[aria-label="Find in terminal"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    await browser.waitUntil(
      async () =>
        !(await $('input[aria-label="Find in terminal"]').isExisting()),
    );
    await terminalAction("Rename tab");
    await $('[role="dialog"] input').setValue("Work shell");
    await confirm();
    await $(".terminal-tabs").$("button=Work shell").waitForDisplayed();
    // Direct tab close stays discoverable and closes only the named tab.
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-tabs").$("button=Shell 2").waitForDisplayed();
    await terminalAction("Split right");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll(".terminal-view").length,
        )) === 3,
    );
    const splitClose = $(
      '.terminal-view.active-pane button[aria-label="Close terminal split"]',
    );
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.activeElement?.closest(".terminal-view") ===
          document.querySelector(".terminal-view.active-pane"),
      ),
    );
    // CSS :focus-within also requires native WebView focus. DOM activeElement
    // alone can retain the input while this isolated test window is inactive.
    await browser.execute(() => {
      const api = (
        window as unknown as {
          __TAURI__: {
            window: { getCurrentWindow(): { setFocus(): Promise<void> } };
            webview: { getCurrentWebview(): { setFocus(): Promise<void> } };
          };
        }
      ).__TAURI__;
      void (async () => {
        try {
          await api.window.getCurrentWindow().setFocus();
          await api.webview.getCurrentWebview().setFocus();
          document
            .querySelector<HTMLTextAreaElement>(
              ".terminal-view.active-pane .xterm-helper-textarea",
            )!
            .focus();
          document.documentElement.dataset.dockingNativeFocus = "ready";
        } catch (error) {
          document.documentElement.dataset.dockingNativeFocus = String(error);
        }
      })();
    });
    await browser.waitUntil(() =>
      browser.execute(() => {
        const status = document.documentElement.dataset.dockingNativeFocus;
        if (status && status !== "ready") throw new Error(status);
        return status === "ready";
      }),
    );
    writeFileSync(
      "artifacts/evidence/desktop/docking-focus.json",
      JSON.stringify(
        await browser.execute(() => {
          const pane = document.querySelector<HTMLElement>(
            ".terminal-view.active-pane",
          )!;
          const button = pane.querySelector<HTMLButtonElement>(
            ".terminal-split-close",
          )!;
          return {
            timestamp: new Date().toISOString(),
            documentFocused: document.hasFocus(),
            visibility: document.visibilityState,
            paneFocusWithin: pane.matches(":focus-within"),
            inputFocused: pane.contains(document.activeElement),
            buttonOpacity: getComputedStyle(button).opacity,
          };
        }),
        null,
        2,
      ) + "\n",
    );
    await splitClose.waitForDisplayed();
    await splitClose.click();
    await $("h2=Close terminal pane").waitForDisplayed();
    await $('[role="dialog"] button:not(.primary)').click();
    expect(
      await browser.execute(
        () => document.querySelectorAll(".terminal-view").length,
      ),
    ).toBe(3);
    await $('button[aria-label="Close terminal tab Work shell"]').click();
    await $("h2=Close terminal tab").waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain("Work shell");
    await $('[role="dialog"] button:not(.primary)').click();
    expect(
      await $(
        'button[aria-label="Close terminal tab Work shell"]',
      ).isExisting(),
    ).toBe(true);
    await $(".terminal-tabs").$("button=Work shell").click();
    await $('button[aria-label="Close terminal tab Shell 2"]').click();
    await $("h2=Close terminal tab").waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(
      "2 owned terminal session",
    );
    await confirm();
    await browser.waitUntil(
      async () =>
        !(await $(
          'button[aria-label="Close terminal tab Shell 2"]',
        ).isExisting()),
    );
    expect(await $(".terminal-view").getAttribute("data-session")).toBe(
      session,
    );
    expect(readFileSync(join(root, "started.txt"), "utf8")).toBe("once");
    expect(
      await browser.execute(() =>
        document.activeElement
          ?.closest(".terminal-view")
          ?.getAttribute("data-session"),
      ),
    ).toBe(session);
    expect(await $(".notice").isExisting()).toBe(false);
    // Compact VCS: one branch/action row, no empty Staged region, real staging.
    await $('button[aria-label="Refresh Git"]').click();
    await $(
      '[data-git-kind="working"][title="started.txt"]',
    ).waitForDisplayed();
    const vcsGeometry = await browser.execute(() => {
      const panel = document
        .querySelector('[data-dock-panel="git"]')!
        .getBoundingClientRect();
      const toolbar = document
        .querySelector(".git-toolbar")!
        .getBoundingClientRect();
      const list = document
        .querySelector('.git-panel [aria-label="Repository changes"]')!
        .getBoundingClientRect();
      const footer = document
        .querySelector(".git-panel .commit-box")!
        .getBoundingClientRect();
      return {
        chrome: list.top - panel.top,
        toolbarHeight: toolbar.height,
        footerHeight: footer.height,
      };
    });
    expect(vcsGeometry.chrome).toBeLessThanOrEqual(62);
    expect(vcsGeometry.toolbarHeight).toBe(31);
    expect(vcsGeometry.footerHeight).toBeLessThanOrEqual(36);
    expect(await $('[data-git-group="staged"]').isExisting()).toBe(false);
    await $('[data-git-kind="working"][title="started.txt"]')
      .$("button=Stage")
      .waitForEnabled();
    await $('[data-git-kind="working"][title="started.txt"]')
      .$("button=Stage")
      .click();
    await $('[data-git-kind="staged"][title="started.txt"]').waitForDisplayed();
    await $("#commit-message").waitForDisplayed();
    expect(
      execFileSync(
        process.env.AW_DESKTOP_GIT!,
        ["diff", "--cached", "--name-only"],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    ).toBe("started.txt");
    await $('[data-git-group="staged"]').click();
    await browser.waitUntil(
      async () => !(await $('[data-git-kind="staged"]').isExisting()),
    );
    const collapsedHeight = (await $('[data-git-group="staged"]').getSize())
      .height;
    expect(collapsedHeight).toBeLessThanOrEqual(30);
    expect(collapsedHeight).toBeGreaterThanOrEqual(24);
    await $('[data-git-group="staged"]').click();
    await $('[data-git-kind="staged"][title="started.txt"]')
      .$("button=Unstage")
      .waitForEnabled();
    await $('[data-git-kind="staged"][title="started.txt"]')
      .$("button=Unstage")
      .click();
    await browser.waitUntil(
      async () => !(await $('[data-git-group="staged"]').isExisting()),
    );
    expect(
      execFileSync(
        process.env.AW_DESKTOP_GIT!,
        ["diff", "--cached", "--name-only"],
        { cwd: root, encoding: "utf8" },
      ).trim(),
    ).toBe("");
    await gitAction("Repository details");
    await $("h2=Repository details").waitForDisplayed();
    expect(await $(".git-details").getText()).toContain("Fixture");
    await $('button[aria-label="Close repository details"]').click();
    writeFileSync(
      "artifacts/evidence/desktop/vcs-density.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          ...vcsGeometry,
          emptyStagedRegion: false,
          stagedAndUnstagedNativeFile: true,
          directTabClosePreservedOtherSession: true,
        },
        null,
        2,
      ) + "\n",
    );

    await browser.saveScreenshot(
      "artifacts/evidence/desktop/default-independent-panes.png",
    );
    await browser.execute(() => {
      const state = window as unknown as {
        __terminalBefore: Element | null;
        __editorBefore: Element | null;
      };
      state.__terminalBefore = document.querySelector(".terminal-view");
      state.__editorBefore = document.querySelector(".monaco-editor");
    });
    await browser.execute(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Move Terminal panel"]',
      )!;
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $("div=Dock left").waitForDisplayed();
    await $("div=Dock left").click();
    await browser.waitUntil(
      async () =>
        (await terminal.getLocation()).x <
        (await $('[data-dock-panel="explorer"]').getLocation()).x,
    );
    expect(
      await browser.execute(() => {
        const header = document
          .querySelector('[data-dock-panel="terminal"] .dock-header')!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(
            ".terminal-header > button, .terminal-header > [data-state]",
          ),
        ].every((button) => {
          const rect = button.getBoundingClientRect();
          return (
            rect.left >= header.left &&
            rect.right <= header.right &&
            rect.top >= header.top &&
            rect.bottom <= header.bottom
          );
        });
      }),
    ).toBe(true);
    // Owner regression: Explorer moved after Git on the right must not leave
    // Git's next grip gesture inert. Cover adjacent and vertically stacked panes
    // and consecutive moves, using real WebView hit testing (scripted pointers).
    await startPanelDrag("explorer");
    await dropPanelOn('[data-dock-target="workspace"][data-dock-side="right"]');
    expect((await git.getLocation()).x).toBeLessThan(
      (await $('[data-dock-panel="explorer"]').getLocation()).x,
    );
    await startPanelDrag("git");
    await dropPanelOn('[data-dock-target="workspace"][data-dock-side="left"]');
    expect((await git.getLocation()).x).toBeLessThan(
      (await terminal.getLocation()).x,
    );
    await startPanelDrag("git");
    await dropPanelOn('[data-dock-target="explorer"][data-dock-side="top"]');
    expect((await git.getLocation()).y).toBeLessThan(
      (await $('[data-dock-panel="explorer"]').getLocation()).y,
    );
    await startPanelDrag("git");
    await $(
      '[data-dock-target="editor"][data-dock-side="bottom"]',
    ).waitForDisplayed();
    await dropPanelOn('[data-dock-target="editor"][data-dock-side="bottom"]');
    await browser.waitUntil(
      async () => (await git.getLocation()).y > (await editor.getLocation()).y,
    );
    expect(await $(".terminal-view").getAttribute("data-session")).toBe(
      session,
    );
    expect(
      await browser.execute(() => {
        const state = window as unknown as {
          __terminalBefore: Element;
          __editorBefore: Element;
        };
        return (
          state.__terminalBefore === document.querySelector(".terminal-view") &&
          state.__editorBefore === document.querySelector(".monaco-editor")
        );
      }),
    ).toBe(true);
    await $('[aria-label="Search project"]').click();
    await $('[data-dock-panel="explorer"] .search-panel').waitForDisplayed();
    expect(await $('[data-dock-panel="git"]').isDisplayed()).toBe(true);
    expect(await $('[data-dock-panel="terminal"]').isDisplayed()).toBe(true);
    await $('[aria-label="Project files"]').click();
    await explorerAction("New folder…", true);
    await $('[role="dialog"] input').setValue("destination");
    await confirm();
    await $('.tree-label[title="destination"]').waitForDisplayed();
    // Git actions now autosave. Create fresh unsaved work specifically for the
    // destructive move's independent Save/Discard/Cancel contract.
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-editor textarea.inputarea",
      )!;
      input.focus();
      const data = new DataTransfer();
      data.setData("text/plain", "// unsaved move\n");
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').waitForEnabled();
    await startDrag('.tree-label[title="hello.ts"]');
    await dropOn('.tree-label[title="destination"]');
    await $("h2=Unsaved changes").waitForDisplayed();
    expect(existsSync(join(root, "hello.ts"))).toBe(true);
    expect(existsSync(join(root, "destination/hello.ts"))).toBe(false);
    await $('[role="dialog"] button:not(.primary)').click();
    await startDrag('.tree-label[title="hello.ts"]');
    await dropOn('.tree-label[title="destination"]');
    await $("h2=Unsaved changes").waitForDisplayed();
    await $("button=Save").click();
    await browser.waitUntil(
      () =>
        existsSync(join(root, "destination/hello.ts")) &&
        !existsSync(join(root, "hello.ts")),
    );
    expect(readFileSync(join(root, "destination/hello.ts"), "utf8")).toContain(
      "unsaved docking",
    );
    expect(
      execFileSync(process.env.AW_DESKTOP_GIT!, ["show", ":hello.ts"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).not.toContain("unsaved docking");
    await $(".monaco-editor textarea.inputarea").waitForExist();
    const movedReference = Buffer.from(
      join("destination", "hello.ts"),
      process.platform === "win32" ? "utf16le" : "utf8",
    ).toString("hex");
    await browser.waitUntil(async () => {
      const file = join(root, ".agent-workspace", "workspace.json");
      if (!existsSync(file)) return false;
      const saved = JSON.parse(readFileSync(file, "utf8")).ui;
      const current = await browser.execute(() =>
        document.querySelector(".dock-workspace")?.getAttribute("data-layout"),
      );
      return (
        saved.tabs.includes(movedReference) &&
        current !== null &&
        current !== undefined &&
        isDeepStrictEqual(saved.dock, JSON.parse(current))
      );
    });
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/movable-panes-file-drop.png",
    );
    await browser.execute(() => location.reload());
    await $(".terminal-view").waitForExist();
    expect(await $(".terminal-view").getAttribute("data-session")).toBe(
      session,
    );
    expect(readFileSync(join(root, "started.txt"), "utf8")).toBe("once");
    await browser.waitUntil(
      async () =>
        (await terminal.getLocation()).x <
        (await $('[data-dock-panel="explorer"]').getLocation()).x,
    );
    // Relocating the same filesystem object keeps this project's saved dock and
    // recovery namespace; it does not bind an unrelated same-named directory.
    const moved = join(dirname(root), "Moved GUI fixture 🌍");
    await $(".monaco-editor textarea.inputarea").waitForExist();
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-editor textarea.inputarea",
      )!;
      input.focus();
      const data = new DataTransfer();
      data.setData("text/plain", "// dirty through relocation\n");
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').waitForEnabled();
    renameSync(root, moved);
    await $('[aria-label="Command palette"]').click();
    await $(".palette input").setValue("Locate moved project folder");
    await $("button=Locate moved project folder").click();
    await $("h2=Locate original project folder").waitForDisplayed();
    await $('[role="dialog"] input').setValue(moved);
    await confirm();
    await browser.waitUntil(async () =>
      String(
        await $('select[aria-label="Recent projects"]').getValue(),
      ).includes("Moved GUI fixture"),
    );
    expect(await $('[data-dock-panel="terminal"]').isDisplayed()).toBe(true);
    expect(await $('[data-dock-panel="git"]').isDisplayed()).toBe(true);
    expect(await $(".terminal-view").getAttribute("data-session")).toBe(
      session,
    );
    await $('[aria-label="Save file"]').click();
    await browser.waitUntil(() =>
      readFileSync(join(moved, "destination/hello.ts"), "utf8").includes(
        "dirty through relocation",
      ),
    );
    await pasteTerminal(
      `${quote(process.env.AW_DESKTOP_NODE!)} ${quote(process.env.AW_DESKTOP_WRITER!)} after-relocation.txt YWZ0ZXI= write\n`,
    );
    await browser.waitUntil(() =>
      existsSync(join(moved, "after-relocation.txt")),
    );
    expect(readFileSync(join(moved, "after-relocation.txt"), "utf8")).toBe(
      "after",
    );
    await terminalAction("Terminate");
    await confirm();
  });
});
