import { $, browser, expect } from "@wdio/globals";
import { installCaptureBridge } from "./pointerCapture";
import { terminalAction } from "./terminalActions";
import { readdirSync, writeFileSync } from "node:fs";
import type * as Monaco from "monaco-editor";
type ProbeWindow = Window & { pointerMonaco: typeof Monaco };
const modulePath = () =>
  "/assets/" +
  readdirSync("dist-desktop-test/assets").find((name) =>
    /^monaco-[\w-]+\.js$/.test(name),
  )!;
async function move(selector: string) {
  return browser.execute((selector) => {
    const node = document.querySelector<HTMLElement>(selector)!;
    const box = node.getBoundingClientRect();
    const x = box.left + Math.min(box.width / 2, 80),
      y = box.top + Math.min(box.height / 2, 12);
    const hit = document.elementFromPoint(x, y)!;
    const event = new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 0,
      button: -1,
      clientX: x,
      clientY: y,
    });
    hit.dispatchEvent(event);
    return {
      cursor: getComputedStyle(hit).cursor,
      globalCursorRules: Array.from(document.adoptedStyleSheets)
        .flatMap((sheet) =>
          Array.from(sheet.cssRules).map((rule) => rule.cssText),
        )
        .filter((rule) => /^\*,/.test(rule) && rule.includes("cursor:")),
      prevented: event.defaultPrevented,
      hit: hit.tagName,
      classes: hit.getAttribute("class"),
      x,
      y,
    };
  }, selector);
}
describe("native pointer hit testing, cursor restoration and focus isolation", () => {
  it("restores the text cursor after divider hover and isolates editor focus from the rest of the app", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $('.tree-label[title="hello.ts"]').waitForDisplayed();
    await $('.tree-label[title="hello.ts"]').doubleClick();
    await $(".monaco-editor textarea.inputarea").waitForExist();
    await browser.execute(async (path) => {
      (window as unknown as ProbeWindow).pointerMonaco = (
        await import(path)
      ).monaco;
    }, modulePath());
    await $('[aria-label="Split editor"]').click();
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          (window as unknown as ProbeWindow).pointerMonaco.editor.getEditors()
            .length === 2,
      ),
    );
    // The embedded WebView is hidden and does not guarantee animation frames.
    // Render through the public API before sampling native text hit targets.
    await browser.execute(() => {
      for (const editor of (
        window as unknown as ProbeWindow
      ).pointerMonaco.editor.getEditors())
        editor.render(true);
    });
    await browser.waitUntil(() =>
      browser.execute(() =>
        Array.from(
          document.querySelectorAll(".monaco-editor .view-lines"),
        ).every((view) =>
          view.querySelector(".view-line")?.textContent?.includes("export"),
        ),
      ),
    );
    await browser.execute(() =>
      (
        document.querySelector('button[aria-label="Fetch"]') as HTMLElement
      ).focus(),
    );
    const focus = await browser.execute(() =>
      (window as unknown as ProbeWindow).pointerMonaco.editor
        .getEditors()
        .map((editor) => ({
          text: editor.hasTextFocus(),
          widget: editor.hasWidgetFocus(),
          bodyOwnsWidgets:
            (
              editor as unknown as { getOverflowWidgetsDomNode(): HTMLElement }
            ).getOverflowWidgetsDomNode() === document.body,
        })),
    );
    const divider = await move('.separator[aria-orientation="vertical"]');
    const text = await move(".monaco-editor .view-lines");
    writeFileSync(
      "artifacts/evidence/desktop/pointer-hover.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "Native WebView hit testing and cancelable pointermove events; public Monaco focus API; not physical-device certification",
          focus,
          divider,
          text,
        },
        null,
        2,
      ) + "\n",
    );
    expect(text.cursor).toBe("text");
    expect(divider.globalCursorRules).toEqual([]);
    expect(focus.every((editor) => !editor.bodyOwnsWidgets)).toBe(true);
    expect(focus.every((editor) => !editor.text && !editor.widget)).toBe(true);
    expect(["col-resize", "ew-resize"]).toContain(divider.cursor);
  });
  it("resizes from visible dividers and clears capture/cursor state on release, cancellation, blur and Escape", async () => {
    await installCaptureBridge();
    const selector = '.separator[aria-orientation="vertical"]';
    const selections = await browser.execute(() =>
      (window as unknown as ProbeWindow).pointerMonaco.editor
        .getEditors()
        .map((editor) => editor.getSelections()),
    );
    const point = async () =>
      browser.execute((selector) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + 30),
        };
      }, selector);
    const width = () =>
      browser.execute(
        () =>
          document
            .querySelector('[data-dock-panel="explorer"]')!
            .getBoundingClientRect().width,
      );
    const before = await width();
    const start = await point();
    await browser
      .action("pointer")
      .move(start)
      .down({ button: 0 })
      .move({ x: start.x + 40, y: start.y, duration: 80 })
      .up({ button: 0 })
      .perform();
    expect(await width()).toBeGreaterThan(before + 20);
    const endings = ["escape", "blur", "cancel", "lost", "released-outside"];
    for (const ending of endings) {
      const original = await width();
      const p = await point();
      await browser
        .action("pointer")
        .move(p)
        .down({ button: 0 })
        .move({ x: p.x + 25, y: p.y, duration: 40 })
        .perform(true);
      expect(
        await browser.execute(
          () => document.documentElement.dataset.workspaceResize,
        ),
      ).toBe("vertical");
      await browser.execute((ending) => {
        if (ending === "escape")
          document.activeElement!.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        else if (ending === "blur") window.dispatchEvent(new Event("blur"));
        else if (ending === "lost")
          document
            .querySelector<HTMLElement>('[data-resize-active="true"]')!
            .releasePointerCapture(1);
        else
          document.dispatchEvent(
            new PointerEvent(
              ending === "cancel" ? "pointercancel" : "pointermove",
              {
                bubbles: true,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
                buttons: 0,
              },
            ),
          );
      }, ending);
      await browser.releaseActions();
      expect(
        await browser.execute(() =>
          document.documentElement.hasAttribute("data-workspace-resize"),
        ),
      ).toBe(false);
      const settled = await width();
      expect(Math.abs(settled - original)).toBeLessThan(40);
      expect((await move(".monaco-editor .view-lines")).cursor).toBe("text");
      expect(Math.abs((await width()) - settled)).toBeLessThan(2);
      expect((await move(".monaco-editor .view-lines")).cursor).toBe("text");
    }
    expect(
      await browser.execute(() =>
        (window as unknown as ProbeWindow).pointerMonaco.editor
          .getEditors()
          .map((editor) => editor.getSelections()),
      ),
    ).toEqual(selections);
    expect(await browser.execute(() => window.getSelection()?.toString())).toBe(
      "",
    );
    // A normal text drag must select only its intended range, then stop at UP.
    const text = await browser.execute(() => {
      const editor = (
        window as unknown as ProbeWindow
      ).pointerMonaco.editor.getEditors()[0];
      const r = editor.getDomNode()!.getBoundingClientRect();
      const a = editor.getScrolledVisiblePosition({
          lineNumber: 1,
          column: 1,
        })!,
        b = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 7 })!;
      return {
        a: {
          x: Math.round(r.left + a.left + 1),
          y: Math.round(r.top + a.top + a.height / 2),
        },
        b: {
          x: Math.round(r.left + b.left),
          y: Math.round(r.top + b.top + b.height / 2),
        },
      };
    });
    await browser
      .action("pointer")
      .move(text.a)
      .down({ button: 0 })
      .move({ ...text.b, duration: 80 })
      .up({ button: 0 })
      .perform();
    const selected = await browser.execute(() => {
      const e = (
        window as unknown as ProbeWindow
      ).pointerMonaco.editor.getEditors()[0];
      return e.getModel()!.getValueInRange(e.getSelection()!);
    });
    expect(selected).toBe("export");
    await move(".monaco-editor .view-lines");
    expect(
      await browser.execute(() => {
        const e = (
          window as unknown as ProbeWindow
        ).pointerMonaco.editor.getEditors()[0];
        return e.getModel()!.getValueInRange(e.getSelection()!);
      }),
    ).toBe("export");
    writeFileSync(
      "artifacts/evidence/desktop/pointer-drag.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "Embedded-driver coordinate actions with test-only capture-contract bridge; actual WebView hit tests/panel/editor handlers, not physical mouse certification",
          endings,
          normalTextSelection: selected,
          noEditorSelectionDuringResize: true,
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("keeps terminal split resizing local and responsive without leaving resize cursors behind", async () => {
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-view .xterm-helper-textarea").waitForExist();
    await terminalAction("Split right");
    await $(
      '.terminal-panel .separator[aria-orientation="vertical"]',
    ).waitForDisplayed();
    const point = await browser.execute(() => {
      const r = document
        .querySelector(
          '.terminal-panel .separator[aria-orientation="vertical"]',
        )!
        .getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 50) };
    });
    const before = (await $(".terminal-view").getSize()).width;
    await browser
      .action("pointer")
      .move(point)
      .down({ button: 0 })
      .move({ x: point.x + 35, y: point.y, duration: 60 })
      .up({ button: 0 })
      .perform();
    expect((await $(".terminal-view").getSize()).width).toBeGreaterThan(
      before + 15,
    );
    expect(
      await browser.execute(() =>
        document.documentElement.hasAttribute("data-workspace-resize"),
      ),
    ).toBe(false);
    expect((await move(".monaco-editor .view-lines")).cursor).toBe("text");
    await browser.execute(() =>
      (
        window as unknown as { disposePointerCaptureBridge: () => void }
      ).disposePointerCaptureBridge(),
    );
  });
});
