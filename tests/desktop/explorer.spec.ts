import { $, browser, expect } from "@wdio/globals";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
async function menu(label: string, item: string) {
  await browser.execute((label) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
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
  }, label);
  await $(`div=${item}`).waitForDisplayed();
  await $(`div=${item}`).click();
}
async function confirm() {
  await $('[role="dialog"] button.primary').waitForEnabled();
  await $('[role="dialog"] button.primary').click();
}
const file = (path: string) => $(`.tree-label[title="${path}"]`);
async function expectArrowCursor(path: string) {
  const cursors = await browser.execute((path) => {
    const label = Array.from(
      document.querySelectorAll<HTMLElement>(".tree-label"),
    ).find((element) => element.title === path)!;
    const row = label.closest<HTMLElement>('[role="treeitem"]')!;
    return [row, ...row.querySelectorAll("*")].map(
      (element) => getComputedStyle(element).cursor,
    );
  }, path);
  expect(cursors.length).toBeGreaterThan(1);
  expect(cursors.every((cursor) => cursor === "default")).toBe(true);
}
describe("clear explorer actions and actionable file errors", () => {
  it("keeps conflicting names editable, exposes references on demand and preserves files", async () => {
    const root = process.env.AW_DESKTOP_PROJECT!;
    const original = readFileSync(join(root, "hello.ts"), "utf8");
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await confirm();
    await file("hello.ts").waitForDisplayed();
    await expectArrowCursor("hello.ts");
    expect((await $(".explorer-toolbar").getSize()).height).toBe(31);
    expect(await $('button[aria-label="New file or folder"]').getText()).toBe(
      "New",
    );
    expect(
      await $('button[aria-label="Selected file actions"]').getText(),
    ).toBe("Actions");
    await menu("New file or folder", "New file…");
    await $('[role="dialog"] input').setValue("hello.ts");
    await confirm();
    await $(".question-error").waitForDisplayed();
    const message = await $(".question-error").getText();
    expect(message).toContain("hello.ts");
    expect(message).toContain("already exists");
    expect(message).not.toContain("Filesystem/process");
    expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(await $('[role="dialog"] input').getValue()).toBe("hello.ts");
    expect(readFileSync(join(root, "hello.ts"), "utf8")).toBe(original);
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/explorer-name-error.png",
    );
    await $(".question-error").$("button=Details").click();
    await $("h2=Error details").waitForDisplayed();
    expect(await $(".error-details").getText()).toContain("alreadyExists");
    expect(await $(".error-details").getText()).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
    if (process.platform === "darwin") {
      const previous = execFileSync("/usr/bin/pbpaste");
      try {
        await $("button=Copy reference").click();
        await $("button=Copied").waitForDisplayed();
        expect(
          execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }),
        ).toContain("Code: alreadyExists");
      } finally {
        execFileSync("/usr/bin/pbcopy", { input: previous });
      }
    }
    await $('button[aria-label="Close error details"]').click();
    await $("h2=New file").waitForDisplayed();
    await $('[role="dialog"] input').setValue("created.txt");
    await confirm();
    await browser.waitUntil(() => existsSync(join(root, "created.txt")));
    await $('[aria-label="Close created.txt"]').waitForDisplayed();
    await file("created.txt").waitForDisplayed();
    await browser.execute(() => {
      const row = document
        .querySelector('.tree-label[title="created.txt"]')!
        .closest('[role="treeitem"]')!;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          button: 2,
          clientX: rect.left + 20,
          clientY: rect.top + 10,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $("div=Rename…").waitForDisplayed();
    await $(".monaco-editor textarea.inputarea").waitForExist();
    await $("div=Rename…").waitForDisplayed();
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/explorer-actions.png",
    );
    await $("div=Rename…").click();
    await $('[role="dialog"] input').setValue("hello.ts");
    await confirm();
    await $(".question-error").waitForDisplayed();
    expect(await $(".question-error").getText()).toContain("already exists");
    expect(readFileSync(join(root, "hello.ts"), "utf8")).toBe(original);
    expect(existsSync(join(root, "created.txt"))).toBe(true);
    await $('[role="dialog"] input').setValue("renamed.txt");
    await confirm();
    await browser.waitUntil(
      () =>
        existsSync(join(root, "renamed.txt")) &&
        !existsSync(join(root, "created.txt")),
    );
    await menu("New file or folder", "New folder…");
    await $('[role="dialog"] input').setValue("folder");
    await confirm();
    await $('button[aria-label="Expand folder"]').waitForDisplayed();
    await expectArrowCursor("folder");
    await $('button[aria-label="Expand folder"]').click();
    await $('button[aria-label="Collapse folder"]').waitForDisplayed();
    await expectArrowCursor("folder");
    await menu("New file or folder", "New file…");
    await $('[role="dialog"] input').setValue("child.txt");
    await confirm();
    await browser.waitUntil(() => existsSync(join(root, "folder/child.txt")));
    expect(existsSync(join(root, "child.txt"))).toBe(false);
    await file("folder/child.txt").click();
    await browser.execute(() => {
      const tree = document.querySelector<HTMLElement>(
        '.explorer [role="tree"]',
      )!;
      tree.focus();
      tree.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $("div=Move to folder…").waitForDisplayed();
    await $("div=Move to folder…").click();
    await $("button=Project root").waitForDisplayed();
    await $("button=Project root").click();
    await $("h2=Move destination name").waitForDisplayed();
    await confirm();
    await browser.waitUntil(
      () =>
        existsSync(join(root, "child.txt")) &&
        !existsSync(join(root, "folder/child.txt")),
    );
    await menu("Selected file actions", "Delete…");
    await confirm();
    await browser.waitUntil(() => !existsSync(join(root, "child.txt")));
    writeFileSync(join(root, "folder/hello.ts"), "destination stays");
    await $('button[aria-label="Refresh files"]').click();
    await file("hello.ts").waitForDisplayed();
    await file("folder").waitForDisplayed();
    await browser.execute(() => {
      const source = document.querySelector('.tree-label[title="hello.ts"]')!;
      const target = document.querySelector('.tree-label[title="folder"]')!;
      const data = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      for (const type of ["dragover", "drop"])
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      source.dispatchEvent(
        new DragEvent("dragend", { dataTransfer: data, bubbles: true }),
      );
    });
    await $(".notice").waitForDisplayed();
    expect(await $(".notice").getText()).toContain("folder/hello.ts");
    expect(await $(".notice").getText()).toContain("already exists");
    expect(await $(".notice").getText()).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-/,
    );
    expect(readFileSync(join(root, "hello.ts"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "folder/hello.ts"), "utf8")).toBe(
      "destination stays",
    );
    await $(".notice").$("button=Details").click();
    await $("h2=Error details").waitForDisplayed();
    expect(await $(".error-details").getText()).toContain("alreadyExists");
    await $('button[aria-label="Close error details"]').click();
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/explorer-errors.png",
    );
    writeFileSync(
      "artifacts/evidence/desktop/explorer-errors.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          toolbarHeight: 31,
          labelledActions: true,
          mouseAndKeyboardContextMenus: true,
          duplicateCreateAndRenameRetainInput: true,
          conflictingCreateAndMovePreserveBothFiles: true,
          operationReferenceOnlyInDetails: true,
          copyReferenceVerified: process.platform === "darwin",
        },
        null,
        2,
      ) + "\n",
    );
  });
});
