import { $, browser, expect } from "@wdio/globals";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
async function key(
  selector: string,
  key: string,
  code: string,
  keyCode: number,
  modifiers: Record<string, boolean> = {},
) {
  await browser.execute(
    (selector, key, code, keyCode, modifiers) => {
      const target = document.querySelector<HTMLElement>(selector)!;
      target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key,
          code,
          keyCode,
          which: keyCode,
          bubbles: true,
          ...modifiers,
        }),
      );
    },
    selector,
    key,
    code,
    keyCode,
    modifiers,
  );
}
const input = ".editor-surface .monaco-editor textarea.inputarea";
const platform =
  process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
async function paste(text: string) {
  await browser.execute(
    (selector, text) => {
      const target = document.querySelector<HTMLTextAreaElement>(selector)!;
      target.focus();
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    input,
    text,
  );
}
async function openFind(selector = input) {
  await key(selector, "f", "KeyF", 70, platform);
  await $(".find-widget.visible .monaco-findInput textarea").waitForDisplayed();
  await browser.waitUntil(() =>
    browser.execute(() => {
      const widget = document.querySelector<HTMLElement>(
        ".find-widget.visible",
      )!;
      const transform = getComputedStyle(widget).transform;
      return (
        transform === "none" ||
        Math.abs(new DOMMatrixReadOnly(transform).m42) < 0.1
      );
    }),
  );
}
async function expectOpaqueContextMenu(selector = input) {
  await key(selector, "F10", "F10", 121, { shiftKey: true });
  const menu = $(".context-view.monaco-menu-container");
  await menu.waitForDisplayed();
  const colors = await browser.execute(() => {
    const host = document.querySelector<HTMLElement>(
      ".context-view.monaco-menu-container",
    )!;
    const surface = host.querySelector<HTMLElement>(
      ":scope > .monaco-scrollable-element",
    )!;
    return [host, surface].map((element) => ({
      background: getComputedStyle(element).backgroundColor,
      opacity: getComputedStyle(element).opacity,
      color: getComputedStyle(element).color,
    }));
  });
  for (const color of colors) {
    expect(color.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(color.opacity).toBe("1");
  }
  await key(
    ".context-view.monaco-menu-container [role=menuitem]",
    "Escape",
    "Escape",
    27,
  );
  await menu.waitForDisplayed({ reverse: true });
}
async function hoverHint() {
  await browser.execute(() => {
    const target = document.querySelector<HTMLElement>(
      '.find-widget.visible [aria-label^="Use Regular Expression"]',
    )!;
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        clientX: box.left + 8,
        clientY: box.top + 8,
      }),
    );
  });
  await $(".monaco-hover.workbench-hover").waitForDisplayed();
  const evidence = await browser.execute(() => {
    const hint = document.querySelector<HTMLElement>(
      ".monaco-hover.workbench-hover",
    )!;
    const view = hint.closest<HTMLElement>(".context-view")!;
    const anchor = document.querySelector<HTMLElement>(
      '.find-widget.visible [aria-label^="Use Regular Expression"]',
    )!;
    const box = hint.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const originalTop = view.style.top,
      originalLeft = view.style.left;
    // Force the observed popup/anchor overlap and use native WebView hit testing.
    view.style.top = `${a.top}px`;
    view.style.left = `${a.left}px`;
    const hit = document.elementFromPoint(a.left + 8, a.top + 8);
    const passesThrough = !view.contains(hit);
    view.style.top = originalTop;
    view.style.left = originalLeft;
    (window as unknown as { editorHint: HTMLElement }).editorHint = hint;
    return {
      rootIsBody: view.parentElement === document.body,
      pointerEvents: getComputedStyle(view).pointerEvents,
      passesThrough,
      animation: getComputedStyle(hint).animationName,
      zIndex: getComputedStyle(view).zIndex,
      tooltipTop: box.top,
      anchorTop: a.top,
      height: box.height,
    };
  });
  expect(evidence.rootIsBody).toBe(true);
  expect(evidence.pointerEvents).toBe("none");
  expect(evidence.passesThrough).toBe(true);
  expect(evidence.animation).toBe("none");
  expect(evidence.height).toBeGreaterThan(10);
  await browser.pause(1200);
  expect(
    await browser.execute(
      () =>
        (window as unknown as { editorHint: HTMLElement }).editorHint
          .isConnected,
    ),
  ).toBe(true);
  return evidence;
}
describe("native search, multicursor and IntelliJ-style autosave", () => {
  it("selects regex find matches as independent cursors, edits and undoes across autosaves", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $('.tree-label[title="multi.txt"]').waitForDisplayed();
    await $('.tree-label[title="multi.txt"]').doubleClick();
    await $(input).waitForExist();
    await openFind();
    await $(".find-widget.visible .monaco-findInput textarea").setValue(
      "item\\d",
    );
    await $(
      '.find-widget.visible [aria-label^="Use Regular Expression"]',
    ).click();
    await $(".find-widget.visible .matchesCount").waitForDisplayed();
    await $('[aria-label="Select all matches as cursors"]').click();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[aria-label="Select all matches as cursors"]',
        )!;
        return button.disabled && button.tabIndex === -1;
      }),
    );
    await browser.waitUntil(async () =>
      (await $(".status-bar").getText()).includes("3 carets"),
    );
    await paste("value");
    const path = join(process.env.AW_DESKTOP_PROJECT!, "multi.txt");
    await browser.waitUntil(
      () => readFileSync(path, "utf8") === "value value value\n",
    );
    await key(input, "z", "KeyZ", 90, platform);
    await browser.waitUntil(
      () => readFileSync(path, "utf8") === "item1 item2 item3\n",
    );
    await key(input, "Escape", "Escape", 27);
    await key(input, "Home", "Home", 36, platform);
    const next =
      process.platform === "darwin" ? { ctrlKey: true } : { altKey: true };
    await key(
      input,
      process.platform === "darwin" ? "g" : "j",
      process.platform === "darwin" ? "KeyG" : "KeyJ",
      process.platform === "darwin" ? 71 : 74,
      next,
    );
    await key(
      input,
      process.platform === "darwin" ? "g" : "j",
      process.platform === "darwin" ? "KeyG" : "KeyJ",
      process.platform === "darwin" ? 71 : 74,
      next,
    );
    // Each item is distinct; use Alt+Shift+click to add another caret at a real text position.
    await browser.execute(() => {
      const line = document.querySelector<HTMLElement>(
        ".monaco-editor .view-line",
      )!;
      const box = line.getBoundingClientRect();
      line.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          altKey: true,
          shiftKey: true,
          clientX: box.left + 100,
          clientY: box.top + box.height / 2,
        }),
      );
    });
    await browser.waitUntil(async () =>
      (await $(".status-bar").getText()).includes("carets"),
    );
    await key(input, "Escape", "Escape", 27);
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/editor-multicursor.png",
    );
  });
  it("keeps document and side-by-side/inline diff search hints visible and stable", async () => {
    await expectOpaqueContextMenu();
    await openFind();
    const editor = await hoverHint();
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/editor-find-tooltip.png",
    );
    await key(
      ".find-widget.visible .monaco-findInput textarea",
      "Escape",
      "Escape",
      27,
    );
    writeFileSync(
      join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"),
      'export const greeting = "changed for diff search";\n',
    );
    await $('[aria-label="Refresh workspace"]').click();
    await $('[data-git-kind="working"]').waitForDisplayed();
    await $('[data-git-kind="working"]').click();
    await $(".monaco-diff-editor .line-insert").waitForExist();
    await expectOpaqueContextMenu(
      ".monaco-diff-editor .modified textarea.inputarea",
    );
    await openFind(".monaco-diff-editor .modified textarea.inputarea");
    const sideBySide = await hoverHint();
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/diff-find-tooltip.png",
    );
    await key(
      ".find-widget.visible .monaco-findInput textarea",
      "Escape",
      "Escape",
      27,
    );
    await $("button=Inline").click();
    await $(".monaco-diff-editor .line-insert").waitForExist();
    await openFind(".monaco-diff-editor .modified textarea.inputarea");
    const inline = await hoverHint();
    writeFileSync(
      "artifacts/evidence/desktop/editor-find.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "Native test WebView; actual hover service and forced-overlap hit testing, not physical mouse/IME certification",
          editor,
          sideBySide,
          inline,
          regexMulticursorEditAndUndoSaved: true,
        },
        null,
        2,
      ) + "\n",
    );
    await key(
      ".find-widget.visible .monaco-findInput textarea",
      "Escape",
      "Escape",
      27,
    );
  });
  it("searches files with regex, rejects invalid patterns and previews/applies captures", async () => {
    await $('[aria-label="Search project"]').click();
    await $('.search-panel input[placeholder="Literal text…"]').setValue(
      "item[13]",
    );
    await $('input[aria-label="Use regular expression"]').click();
    await $(".search-panel").$("button=Search").click();
    await $(
      '.search-panel [aria-label="Search results"] [role="option"]',
    ).waitForDisplayed();
    expect(
      await $('.search-panel [aria-label="Search results"]').getText(),
    ).toContain("multi.txt");
    await $('.search-panel input[placeholder="Regular expression…"]').setValue(
      "[",
    );
    await $(".search-panel").$("button=Search").click();
    await $(".search-error").waitForDisplayed();
    expect(await $(".search-error").getText()).toContain("regular expression");
    await $('.search-panel input[placeholder="Regular expression…"]').setValue(
      "item([0-9])",
    );
    await $(".search-panel").$("button=Search").click();
    await $(
      '.search-panel [aria-label="Search results"] [role="option"]',
    ).waitForDisplayed();
    await $('input[aria-label="Replace with"]').setValue("number-$1");
    await $("button=Preview replacement").click();
    await $("button=Review replacement diff").waitForDisplayed();
    await $("button=Review replacement diff").click();
    await browser.waitUntil(async () =>
      (await $(".monaco-diff-editor").getText()).includes("number-1"),
    );
    await $("button=Apply selected replacements").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      () =>
        readFileSync(
          join(process.env.AW_DESKTOP_PROJECT!, "multi.txt"),
          "utf8",
        ) === "number-1 number-2 number-3\n",
    );
  });
  it("autosaves on terminal focus, app deactivation and file close and preserves external conflicts", async () => {
    await $('[aria-label="Settings"]').click();
    await $('input[aria-label="Save when idle"]').waitForDisplayed();
    await $('input[aria-label="Save when idle"]').click();
    await $("button=Save autosave preferences").click();
    await $('[aria-label="Close settings"]').click();
    await $('[aria-label="Project files"]').click();
    await $('.tree-label[title="multi.txt"]').doubleClick();
    await $(input).waitForExist();
    await paste("// terminal focus\n");
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-view .xterm-helper-textarea").waitForExist();
    await $(".terminal-view .xterm-helper-textarea").click();
    const path = join(process.env.AW_DESKTOP_PROJECT!, "multi.txt");
    await browser.waitUntil(() =>
      readFileSync(path, "utf8").includes("terminal focus"),
    );
    await $(input).click();
    await paste("// app blur\n");
    await browser.execute(() => window.dispatchEvent(new Event("blur")));
    await browser.waitUntil(() =>
      readFileSync(path, "utf8").includes("app blur"),
    );
    await paste("// close saves\n");
    await $('[aria-label="Close multi.txt"]').click();
    await browser.waitUntil(() =>
      readFileSync(path, "utf8").includes("close saves"),
    );
    await $('.tree-label[title="multi.txt"]').doubleClick();
    await $(input).waitForExist();
    await paste("// unsaved local\n");
    writeFileSync(path, "external version\n");
    await browser.execute(() => window.dispatchEvent(new Event("blur")));
    await $("button=Compare three versions").waitForDisplayed();
    expect(readFileSync(path, "utf8")).toBe("external version\n");
    expect(await $('[aria-label="Save file"]').isExisting()).toBe(false);
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/autosave-conflict.png",
    );
  });
});
