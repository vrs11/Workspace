import { $, browser, expect } from "@wdio/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as Monaco from "monaco-editor";
type FixtureWindow = Window & {
  viewsMonaco: typeof Monaco;
  viewsEditor: Monaco.editor.IStandaloneCodeEditor;
  viewsModel: Monaco.editor.ITextModel;
  previewExecuted?: boolean;
};
async function option(name: string, checked?: boolean) {
  // Radix opens on pointerdown. The driver's plain click() calls el.click().
  await $('.tab-bar button[aria-label="Editor view options"]').click({
    button: "left",
  });
  const item = $(`[role="menuitemcheckbox"]=${name}`);
  await item.waitForDisplayed();
  if (
    checked === undefined ||
    (await item.getAttribute("aria-checked")) !== String(checked)
  )
    await item.click();
  else await browser.keys("Escape");
}
async function open(name: string) {
  // The embedded driver's pointer actions emit click(detail=1), never dblclick.
  // Use the real Explorer keyboard activation route for this suite's setup.
  await $(`.tree-label[title="${name}"]`).click();
  await browser.execute(() => {
    const tree = document.querySelector<HTMLElement>(
      '.explorer [role="tree"][aria-label="Project tree"]',
    )!;
    tree.focus();
    tree.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await browser.waitUntil(() =>
    browser.execute((name) => {
      const active = document.querySelector(
        '.tab-bar [role="tab"][aria-selected="true"]',
      );
      if (!active?.textContent?.includes(name)) return false;
      const monaco = (window as FixtureWindow).viewsMonaco;
      return (
        !monaco ||
        monaco.editor
          .getEditors()
          .some((view) => view.getModel()?.uri.path.endsWith(`/${name}`))
      );
    }, name),
  );
  await $(".editor-surface textarea.inputarea").waitForExist();
}
async function previewHeading(value: string) {
  await browser.waitUntil(() =>
    browser.execute(
      (value) =>
        [...document.querySelectorAll(".document-preview-content")].some(
          (node) => node.shadowRoot?.querySelector("h1")?.textContent === value,
        ),
      value,
    ),
  );
}
describe("editor annotations, wrapping and document rendering", () => {
  it("preserves the editor and undo while gutter menus wrap, hide numbers and show current-buffer blame", async () => {
    await $(".recent-projects button").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $(".dialog-content button.primary").waitForDisplayed();
    await $(".dialog-content button.primary").click();
    await $('.tree-label[title="README.md"]').waitForDisplayed();
    await open("README.md");
    const chunk =
      "/assets/" +
      readdirSync("dist-desktop-test/assets").find(
        (name) =>
          /^monaco-[\w-]+\.js$/.test(name) &&
          /\bas monaco\b/.test(
            readFileSync(join("dist-desktop-test/assets", name), "utf8"),
          ),
      )!;
    await browser.execute(async (chunk) => {
      const win = window as FixtureWindow;
      win.viewsMonaco = (await import(chunk)).monaco;
      win.viewsEditor = win.viewsMonaco.editor
        .getEditors()
        .find((view) => view.getModel()?.uri.path.endsWith("/README.md"))!;
      win.viewsModel = win.viewsEditor.getModel()!;
      const end = win.viewsModel.getLineMaxColumn(1);
      win.viewsEditor.pushUndoStop();
      win.viewsEditor.executeEdits("test", [
        { range: new win.viewsMonaco.Range(1, end, 1, end), text: " unsaved" },
      ]);
      win.viewsEditor.pushUndoStop();
      win.viewsEditor.setPosition({ lineNumber: 3, column: 4 });
    }, chunk);
    await browser.execute(() => {
      const line = document.querySelector<HTMLElement>(
        ".editor-surface .margin-view-overlays .line-numbers",
      )!;
      const rect = line.getBoundingClientRect();
      const target = (
        window as FixtureWindow
      ).viewsEditor.getTargetAtClientPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (
        !rect.width ||
        !rect.height ||
        target?.type !==
          (window as FixtureWindow).viewsMonaco.editor.MouseTargetType
            .GUTTER_LINE_NUMBERS
      )
        throw new Error(
          `Expected a visible line number; got target ${target?.type}, size ${rect.width}x${rect.height}`,
        );
      line.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    await $('[role="menuitemcheckbox"]=Soft wrap').waitForDisplayed();
    await $('[role="menuitemcheckbox"]=Soft wrap').click();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const win = window as FixtureWindow,
          editor = win.viewsEditor;
        return (
          editor.getOption(win.viewsMonaco.editor.EditorOption.wordWrap) ===
            "on" &&
          editor.getTopForLineNumber(4) - editor.getTopForLineNumber(3) >
            editor.getOption(win.viewsMonaco.editor.EditorOption.lineHeight) * 2
        );
      }),
    );
    await option("Show line numbers");
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          (window as FixtureWindow).viewsEditor.getLayoutInfo()
            .lineNumbersWidth === 0,
      ),
    );
    await option("Show line numbers");
    await option("Git blame");
    await $(".blame-line.uncommitted").waitForDisplayed();
    await browser.waitUntil(async () =>
      (await $(".blame-gutter").getText()).includes("Desktop Fixture"),
    );
    const state = await browser.execute(() => {
      const win = window as FixtureWindow;
      return {
        sameModel: win.viewsEditor.getModel() === win.viewsModel,
        cursor: win.viewsEditor.getPosition(),
        wrap: win.viewsEditor.getOption(
          win.viewsMonaco.editor.EditorOption.wordWrap,
        ),
        numbers: win.viewsEditor.getLayoutInfo().lineNumbersWidth,
      };
    });
    expect(state.sameModel).toBe(true);
    expect(state.cursor).toEqual({ lineNumber: 3, column: 4 });
    expect(state.numbers).toBeGreaterThan(0);
    expect(
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "README.md"),
        "utf8",
      ).startsWith("# Preview title\n"),
    ).toBe(true);
  });
  it("renders live Markdown, local images, CSV and inert HTML without replacing the code view", async () => {
    await $('button[aria-label="Side by side"]').click();
    await previewHeading("Preview title unsaved");
    await browser.execute(() => {
      const root = document.querySelector(
        ".document-preview-content",
      )?.shadowRoot;
      root?.querySelector("img")?.scrollIntoView({ block: "center" });
    });
    await browser.waitUntil(() =>
      browser.execute(() => {
        const root = document.querySelector(
          ".document-preview-content",
        )?.shadowRoot;
        const image = root?.querySelector<HTMLImageElement>("img");
        return (
          !!image?.complete &&
          image.naturalWidth > 0 &&
          !!root?.querySelector("pre code") &&
          root.textContent!.includes("Remote images are not loaded")
        );
      }),
    );
    await browser.execute(() => {
      const win = window as FixtureWindow;
      win.viewsEditor.pushUndoStop();
      win.viewsEditor.executeEdits("test", [
        {
          range: new win.viewsMonaco.Range(
            1,
            1,
            1,
            win.viewsModel.getLineMaxColumn(1),
          ),
          text: "# Live heading",
        },
      ]);
      win.viewsEditor.pushUndoStop();
    });
    await previewHeading("Live heading");
    await $('button[aria-label="Rendered"]').click();
    await previewHeading("Live heading");
    expect(
      await browser.execute(
        () =>
          document.querySelector(".document-code")!.getBoundingClientRect()
            .width,
      ),
    ).toBeLessThan(1);
    await $('button[aria-label="Code"]').click();
    const same = await browser.execute(() => {
      const win = window as FixtureWindow;
      return (
        win.viewsEditor.getModel() === win.viewsModel &&
        win.viewsMonaco.editor.getEditors().includes(win.viewsEditor)
      );
    });
    expect(same).toBe(true);
    await browser.execute(() =>
      (window as FixtureWindow).viewsEditor.trigger("test", "undo", null),
    );
    expect(
      await browser.execute(() =>
        (window as FixtureWindow).viewsModel.getLineContent(1),
      ),
    ).toBe("# Preview title unsaved");
    await open("data.csv");
    await $('button[aria-label="Rendered"]').click();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document
            .querySelector(".document-preview-content")
            ?.shadowRoot?.querySelectorAll("td").length === 4,
      ),
    );
    expect(
      await browser.execute(() =>
        document
          .querySelector(".document-preview-content")
          ?.shadowRoot?.querySelector("img,b"),
      ),
    ).toBeNull();
    await open("page.html");
    await $('button[aria-label="Rendered"]').click();
    await previewHeading("Static page");
    expect(
      await browser.execute(() => ({
        executed: !!(window as FixtureWindow).previewExecuted,
        unsafe: !!document
          .querySelector(".document-preview-content")
          ?.shadowRoot?.querySelector("script,iframe,form,[onclick]"),
      })),
    ).toEqual({ executed: false, unsafe: false });
  });
  it("applies the persisted options to both sides of a real diff", async () => {
    await $('[aria-label="Changes"]').click();
    await $('[data-git-kind="working"]').waitForDisplayed();
    await $('[data-git-kind="working"]').click();
    await $(".monaco-diff-editor").waitForDisplayed();
    await option("Soft wrap", true);
    await option("Show line numbers", false);
    await browser.waitUntil(() =>
      browser.execute(() => {
        const win = window as FixtureWindow;
        const views = win.viewsMonaco.editor
          .getEditors()
          .filter((view) =>
            view.getContainerDomNode().closest(".monaco-diff-editor"),
          );
        return (
          views.length === 2 &&
          views.every(
            (view) =>
              view.getLayoutInfo().lineNumbersWidth === 0 &&
              view.getOption(win.viewsMonaco.editor.EditorOption.wordWrap) ===
                "on",
          )
        );
      }),
    );
    const preferences = JSON.parse(
      readFileSync(join(process.env.AW_DESKTOP_DATA!, "settings.json"), "utf8"),
    );
    expect(preferences.editorSoftWrap).toBe(true);
    expect(preferences.editorLineNumbers).toBe(false);
    await option("Show line numbers");
  });
});
