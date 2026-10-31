import { $, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
describe("native folder launch offers", () => {
  it("queues folder offers behind trust, preserves cancelled work and autosaves an approved switch", async () => {
    await $("h1").waitForDisplayed();
    const project = process.env.AW_DESKTOP_PROJECT!;
    const other = join(dirname(project), "Other plain folder 🌍");
    mkdirSync(other);
    const launch = (path: string) =>
      execFileSync(
        resolve(
          process.platform === "darwin" &&
            process.env.AW_DESKTOP_PACKAGED === "1"
            ? "artifacts/desktop-perf/Workspace Test.app/Contents/MacOS/agent-workspace"
            : `artifacts/desktop-test/agent-workspace${process.platform === "win32" ? ".exe" : ""}`,
        ),
        [basename(path)],
        { cwd: dirname(path), env: process.env, timeout: 15000, stdio: "pipe" },
      );
    launch(project);
    await $("h2=Open requested folder").waitForDisplayed();
    expect(await $('[role="dialog"]').getText()).toContain(project);
    await $('[role="dialog"] button:not(.primary)').click();
    expect(await $("h1").isDisplayed()).toBe(true);
    launch(project);
    await $("h2=Open requested folder").waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $("h2=Trust this folder").waitForDisplayed();
    launch(other);
    // Launch offers must not cancel or replace a pending trust decision.
    expect(await $("h2=Trust this folder").isDisplayed()).toBe(true);
    await $('[role="dialog"] button:not(.primary)').click();
    await $("h2=Open requested folder").waitForDisplayed();
    await $('[role="dialog"] button:not(.primary)').click();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $('.explorer [role="treeitem"]').waitForDisplayed();
    await $('.explorer [role="treeitem"]').doubleClick();
    await $(".monaco-editor textarea.inputarea").waitForExist();
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-editor textarea.inputarea",
      )!;
      input.focus();
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "// launch preserves dirty work\n");
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').waitForEnabled();
    launch(other);
    await $("h2=Open requested folder").waitForDisplayed();
    await $('[role="dialog"] button:not(.primary)').click();
    expect(readFileSync(join(project, "hello.ts"), "utf8")).not.toContain(
      "launch preserves",
    );
    expect(
      await $('select[aria-label="Recent projects"]').getValue(),
    ).toContain("GUI fixture");
    expect(await $('[aria-label="Save file"]').isEnabled()).toBe(true);
    launch(other);
    await $("h2=Open requested folder").waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(() =>
      readFileSync(join(project, "hello.ts"), "utf8").includes(
        "launch preserves",
      ),
    );
    await $(".trust-banner").waitForDisplayed();
    expect(await $('select[aria-label="Recent projects"]').getText()).toContain(
      "Other plain folder",
    );
  });
  it("restores independent project-local layouts and reopens hidden panels in their original slots", async () => {
    const first = process.env.AW_DESKTOP_PROJECT!,
      second = join(dirname(first), "Other plain folder 🌍");
    const select = async (path: string) => {
      path = realpathSync(path);
      await browser.execute((path) => {
        const s = document.querySelector<HTMLSelectElement>(
          'select[aria-label="Recent projects"]',
        )!;
        const option = [...s.options].find((o) => o.value === path)!;
        if (!option) throw new Error("Missing recent project");
        s.value = option.value;
        s.dispatchEvent(new Event("change", { bubbles: true }));
      }, path);
      await browser.waitUntil(
        async () =>
          (await $('select[aria-label="Recent projects"]').getValue()) === path,
      );
      await $('[data-dock-panel="explorer"]').waitForDisplayed();
    };
    const root = () =>
      browser.execute(
        () =>
          JSON.parse(
            document
              .querySelector(".dock-workspace")!
              .getAttribute("data-layout")!,
          ).root,
      );
    const show = async (panel: string) => {
      await browser.execute(() => {
        const trigger = document.querySelector<HTMLButtonElement>(
          '[aria-label="Workspace layout"]',
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
      await $(`[role="menuitemcheckbox"]=${panel}`).waitForDisplayed();
      await $(`[role="menuitemcheckbox"]=${panel}`).click();
    };
    // Folder B starts with its own restricted defaults; trust only to permit
    // the explicit project metadata write, never to start a program.
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $('[aria-label="Hide Git panel"]').click();
    const secondRoot = await root();
    // Switching immediately, inside the debounce interval, must flush B.
    await select(first);
    await browser.waitUntil(() =>
      existsSync(join(second, ".agent-workspace/workspace.json")),
    );
    expect(
      JSON.parse(
        readFileSync(join(second, ".agent-workspace/workspace.json"), "utf8"),
      ).ui.dock.hidden,
    ).toContain("git");
    await browser.execute(() => {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Move Explorer panel"]',
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
    await $("div=Dock right").waitForDisplayed();
    await $("div=Dock right").click();
    const before = await root();
    await $('[aria-label="Hide Explorer panel"]').click();
    await show("Explorer");
    await $('[data-dock-panel="explorer"]').waitForDisplayed();
    expect(await root()).toEqual(before);
    await $('[aria-label="Hide Terminal panel"]').click();
    await show("Terminal");
    await $('[data-dock-panel="terminal"]').waitForDisplayed();
    expect(await root()).toEqual(before);
    await select(second);
    expect(await root()).toEqual(secondRoot);
    expect(await $('[data-dock-panel="git"]').isExisting()).toBe(false);
    await select(first);
    expect(await root()).toEqual(before);
    await $('[aria-label="Hide Editor panel"]').click();
    await browser.waitUntil(() =>
      JSON.parse(
        readFileSync(join(first, ".agent-workspace/workspace.json"), "utf8"),
      ).ui.dock.hidden.includes("editor"),
    );
    await browser.refresh();
    await $('[data-dock-panel="explorer"]').waitForDisplayed();
    expect(await $('[data-dock-panel="editor"]').isExisting()).toBe(false);
    await show("Editor");
    await $('[data-dock-panel="editor"]').waitForDisplayed();
    expect(await root()).toEqual(before);
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/project-layout-persistence.png",
    );
  });
});
