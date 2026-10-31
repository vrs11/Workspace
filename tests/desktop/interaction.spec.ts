import { $, browser, expect } from "@wdio/globals";
import { readdirSync, writeFileSync } from "node:fs";
import type * as Monaco from "monaco-editor";
import { explorerAction } from "./terminalActions";
type Probe = Window & { interactionMonaco: typeof Monaco };
async function key(key: string, code = key, init: KeyboardEventInit = {}) {
  await browser.execute(
    (key, code, init) => {
      const target = document.activeElement!;
      for (const type of ["keydown", "keyup"])
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
    },
    key,
    code,
    init,
  );
}
describe("quick file navigation and keyboard dialog choices", () => {
  it("opens selected editor text with Double Shift, picks files with arrows/Enter and navigates modal choices", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    expect(
      await browser.execute(() => document.activeElement?.textContent),
    ).toBe("Trust folder");
    await key("ArrowLeft");
    expect(
      await browser.execute(() => document.activeElement?.textContent),
    ).toBe("Cancel");
    await key("Enter");
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await key("Enter");
    await $('.tree-label[title="hello.ts"]').waitForDisplayed();
    await $('.tree-label[title="hello.ts"]').doubleClick();
    await $(".editor-surface textarea.inputarea").waitForExist();
    const path =
      "/assets/" +
      readdirSync("dist-desktop-test/assets").find((name) =>
        /^monaco-[\w-]+\.js$/.test(name),
      )!;
    await browser.execute(async (path) => {
      (window as unknown as Probe).interactionMonaco = (
        await import(path)
      ).monaco;
    }, path);
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
          document.documentElement.dataset.interactionFocus = "ready";
        } catch (error) {
          document.documentElement.dataset.interactionFocus = String(error);
        }
      })();
    });
    await browser.waitUntil(() =>
      browser.execute(() => {
        const state = document.documentElement.dataset.interactionFocus;
        if (state && state !== "ready") throw Error(state);
        return state === "ready";
      }),
    );
    await browser.execute(() => {
      const monaco = (window as unknown as Probe).interactionMonaco;
      const editor = monaco.editor
        .getEditors()
        .find((editor) => editor.getModel()?.getValue().includes("greeting"))!;
      editor.setSelection(
        editor
          .getModel()!
          .findMatches("hello", false, false, true, null, false)[0].range,
      );
      editor.focus();
    });
    await key("Shift", "ShiftLeft");
    await key("Shift", "ShiftLeft");
    await $(".palette [role=combobox]").waitForDisplayed();
    expect(await $(".palette [role=combobox]").getValue()).toBe("hello");
    await browser.waitUntil(
      async () => (await $(".palette").$$("[role=option]")).length === 2,
    );
    await key("ArrowDown");
    expect((await $(".palette").getSize()).height).toBeLessThanOrEqual(300);
    expect(
      (await $('.palette [role="listbox"]').getSize()).height,
    ).toBeLessThanOrEqual(90);
    const selected = await $(
      '.palette [role="option"][aria-selected="true"]',
    ).getText();
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/quick-file-picker.png",
    );
    await key("Enter");
    await browser.waitUntil(async () => !(await $(".palette").isExisting()));
    expect(await $(".tab [role=tab][aria-selected=true]").getText()).toContain(
      selected.split(":")[0],
    );
    // A shifted selection/navigation key between taps must not open anything.
    await key("Shift", "ShiftLeft");
    await key("ArrowLeft", "ArrowLeft", { shiftKey: true });
    await key("Shift", "ShiftLeft");
    expect(await $(".palette").isExisting()).toBe(false);
    await explorerAction("New file…", true);
    await $('[role="dialog"] input').waitForDisplayed();
    await $('[role="dialog"] input').setValue("keyboard-cancel.txt");
    await key("ArrowLeft");
    expect(await browser.execute(() => document.activeElement?.tagName)).toBe(
      "INPUT",
    );
    await key("Escape");
    expect(await $('[role="dialog"]').isExisting()).toBe(false);
    writeFileSync(
      "artifacts/evidence/desktop/keyboard-interactions.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          selectedQuery: "hello",
          matchingFiles: 2,
          defaultChoiceFocused: true,
          arrowEnterCancel: true,
          arrowEnterConfirm: true,
          inputCaretPreserved: true,
          escapeCancel: true,
          shiftSelectionPreserved: true,
          profile:
            "native WebKit; scripted keyboard events, public Monaco selection and real virtualized file results; not physical-device certification",
        },
        null,
        2,
      ) + "\n",
    );
  });
});
