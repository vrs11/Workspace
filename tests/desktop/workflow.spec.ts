import { terminalAction, explorerAction } from "./terminalActions";
import { browser, $, $$, expect } from "@wdio/globals";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
const shellQuote = (text: string) =>
  process.platform === "win32"
    ? `"${text.replaceAll('"', '""')}"`
    : `'${text.replaceAll("'", "'\\''")}'`;
const terminalWrite = (path: string, text: string, append = false) =>
  `${shellQuote(process.env.AW_DESKTOP_NODE!)} ${shellQuote(process.env.AW_DESKTOP_WRITER!)} ${shellQuote(path)} ${shellQuote(Buffer.from(text).toString("base64"))} ${append ? "append" : "write"}\n`;
describe("real native GUI workflow", () => {
  it("opens a restricted folder, trusts it, edits, reviews, stages, commits and pushes", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    console.info("Folder opened");
    await $(".trust-banner").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      async () => (await $$(".trust-banner")).length === 0,
    );
    await $('.explorer [role="treeitem"]').waitForDisplayed();
    await $('.explorer [role="treeitem"]').click();
    await $(".monaco-editor").waitForDisplayed();
    console.info("Editor ready");
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".monaco-editor textarea.inputarea",
      )!;
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          which: 65,
          metaKey: navigator.platform.includes("Mac"),
          ctrlKey: !navigator.platform.includes("Mac"),
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          which: 65,
          bubbles: true,
        }),
      );
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/plain",
        'export const greeting = "edited in GUI";\n',
      );
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await $('[aria-label="Save file"]').waitForEnabled();
    await $('[aria-label="Save file"]').click();
    await browser.waitUntil(() =>
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"),
        "utf8",
      ).includes("edited in GUI"),
    );
    await $('[aria-label="Refresh workspace"]').click();
    await $('[data-git-kind="working"]').waitForDisplayed();
    await $('[data-git-kind="working"]').click();
    await $(".monaco-diff-editor").waitForDisplayed();
    await browser.waitUntil(async () =>
      (await $(".monaco-diff-editor").getText()).includes("edited"),
    );
    await $(".monaco-diff-editor .line-insert").waitForExist();
    mkdirSync("artifacts/evidence/desktop", { recursive: true });
    await browser.saveScreenshot("artifacts/evidence/desktop/review.png");
    console.info("Diff reviewed");
    await $("button=Stage hunk 1").click();
    await $('[data-git-kind="staged"]').waitForDisplayed();
    await $("#commit-message").setValue("GUI-only native edit");
    await $("button=Commit staged").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      async () => !(await $('[data-git-group="staged"]').isExisting()),
    );
    console.info("Commit completed");
    await $('button[aria-label="Push"]').waitForEnabled();
    await $('button[aria-label="Push"]').click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(() =>
      execFileSync(
        process.env.AW_DESKTOP_GIT!,
        ["--git-dir", process.env.AW_DESKTOP_REMOTE!, "show", "main:hello.ts"],
        { encoding: "utf8" },
      ).includes("edited in GUI"),
    );
    expect(
      readFileSync(join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"), "utf8"),
    ).toBe('export const greeting = "edited in GUI";\n');
    await browser.saveScreenshot("artifacts/evidence/desktop/committed.png");
    expect(
      readFileSync(join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"), "utf8"),
    ).toContain("edited in GUI");
  });
  it("provides real search, themes and a native PTY", async () => {
    expect(await $(".workspace").isExisting()).toBe(true);
    await $('[aria-label="Search project"]').click();
    await $(".search-panel input:not([type=checkbox])").setValue("greeting");
    await $(".search-panel").$("button=Search").click();
    await $('[aria-label="Search results"] [role="option"]').waitForDisplayed();
    await $('[aria-label="Settings"]').click();
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[role="dialog"] select',
      )!;
      select.value = "light";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      async () => (await $("html").getAttribute("data-theme")) === "light",
    );
    await $('[aria-label="Close settings"]').click();
    await $('[aria-label="Terminal"]').click();
    await $('button[aria-label="New terminal"]').click();
    await $(".xterm").waitForDisplayed();
    await browser.execute(
      (command) => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".xterm-helper-textarea",
        )!;
        input.focus();
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", command);
        input.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      terminalWrite("pty-proof.txt", "NATIVE_PTY_OK"),
    );
    expect(await $('.dialog-content[role="dialog"]').isExisting()).toBe(false);
    await browser.waitUntil(
      () =>
        existsSync(join(process.env.AW_DESKTOP_PROJECT!, "pty-proof.txt")) &&
        readFileSync(
          join(process.env.AW_DESKTOP_PROJECT!, "pty-proof.txt"),
          "utf8",
        ) === "NATIVE_PTY_OK",
    );
    await $('button[aria-label="Find in terminal"]').click();
    await $('input[aria-label="Find in terminal"]').setValue("NATIVE_PTY_OK");
    await $('button[aria-label="Next match"]').click();
    await browser.waitUntil(
      async () =>
        (await $(".terminal-view [role=status]").getText()) === "Match",
    );

    await $('button[aria-label="Close terminal search"]').click();
    expect(await $('input[aria-label="Find in terminal"]').isExisting()).toBe(
      false,
    );
    if (process.platform === "darwin") {
      const prior = execFileSync("/usr/bin/pbpaste");
      try {
        await terminalAction("Select all");
        await terminalAction("Copy");
        await browser.waitUntil(() =>
          execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }).includes(
            "NATIVE_PTY_OK",
          ),
        );
        execFileSync("/usr/bin/pbcopy", {
          input: terminalWrite("clipboard-proof.txt", "NATIVE_CLIPBOARD_OK"),
        });
        await terminalAction("Paste");
        await browser.waitUntil(() =>
          existsSync(
            join(process.env.AW_DESKTOP_PROJECT!, "clipboard-proof.txt"),
          ),
        );
        expect(
          readFileSync(
            join(process.env.AW_DESKTOP_PROJECT!, "clipboard-proof.txt"),
            "utf8",
          ),
        ).toBe("NATIVE_CLIPBOARD_OK");
        const clipboardBeforeEscape = execFileSync("/usr/bin/pbpaste");
        const forbiddenCopy = Buffer.from(
          "TERMINAL_ESCAPES_MUST_NOT_CHANGE_CLIPBOARD",
        ).toString("base64");
        // The marker is octal-encoded in the command, so finding its decoded
        // form proves the parser consumed the preceding OSC rather than merely
        // matching the shell's command echo. No clipboard text enters evidence.
        await paste(
          String.raw`printf '\033]52;c;${forbiddenCopy}\007\117\123\103\065\062\137\104\117\116\105\n'` +
            "\n",
        );
        await $('button[aria-label="Find in terminal"]').click();
        await $('input[aria-label="Find in terminal"]').setValue("OSC52_DONE");
        await browser.waitUntil(async () => {
          await $('button[aria-label="Next match"]').click();
          return (
            (await $(".terminal-view [role=status]").getText()) === "Match"
          );
        });
        expect(
          execFileSync("/usr/bin/pbpaste").equals(clipboardBeforeEscape),
        ).toBe(true);
        await $('button[aria-label="Close terminal search"]').click();
      } finally {
        execFileSync("/usr/bin/pbcopy", { input: prior });
      }
    }
    await browser.saveScreenshot("artifacts/evidence/desktop/terminal.png");
    await terminalAction("Terminate");
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
  });
  it("keeps independent split PTYs, runs a raw TUI and reattaches after renderer reload", async () => {
    await $('[aria-label="Terminal"]').click();
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-view.active-pane .xterm-helper-textarea").waitForExist();
    const first = await $(".terminal-view.active-pane").getAttribute(
      "data-pane",
    );
    await paste(terminalWrite("first-session.txt", "FIRST_SESSION\n"));
    await browser.waitUntil(() =>
      existsSync(join(process.env.AW_DESKTOP_PROJECT!, "first-session.txt")),
    );
    await terminalAction("Split right");
    await browser.waitUntil(
      async () => (await $$(".terminal-view")).length === 2,
    );
    const second = await $(".terminal-view.active-pane").getAttribute(
      "data-pane",
    );
    expect(second).not.toBe(first);
    await paste(terminalWrite("second-session.txt", "SECOND_SESSION"));
    await browser.waitUntil(() =>
      existsSync(join(process.env.AW_DESKTOP_PROJECT!, "second-session.txt")),
    );
    await browser.waitUntil(() =>
      browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>(".terminal-emulator")].every(
          (node) => node.dataset.terminalGraphicsReady === "true",
        ),
      ),
    );
    const graphicsBefore = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>(".terminal-emulator")].map(
        (node) => node.dataset.terminalRenderer,
      ),
    );
    if (process.env.AW_REQUIRE_GPU === "1")
      expect(graphicsBefore).toEqual(["webgl", "webgl"]);
    const sessionBeforeLoss = await $(`[data-pane="${first}"]`).getAttribute(
      "data-session",
    );
    const lost = await browser.execute((pane) => {
      const host = document.querySelector<HTMLElement>(
        `[data-pane="${pane}"] .terminal-emulator`,
      )!;
      if (host.dataset.terminalRenderer !== "webgl") return false;
      for (const canvas of host.querySelectorAll("canvas")) {
        const gl = canvas.getContext("webgl2");
        const extension = gl?.getExtension("WEBGL_lose_context");
        if (extension) {
          extension.loseContext();
          return true;
        }
      }
      return false;
    }, first);
    if (process.env.AW_REQUIRE_GPU === "1") expect(lost).toBe(true);
    if (lost) {
      await browser.waitUntil(() =>
        browser.execute((pane) => {
          const host = document.querySelector<HTMLElement>(
            `[data-pane="${pane}"] .terminal-emulator`,
          )!;
          return (
            host.dataset.terminalRenderer === "dom" &&
            !!host
              .querySelector(".xterm-rows")
              ?.textContent?.includes("FIRST_SESSION")
          );
        }, first),
      );
      expect(
        await $(`[data-pane="${first}"]`).getAttribute("data-session"),
      ).toBe(sessionBeforeLoss);
      await browser.execute(
        (pane) =>
          document
            .querySelector<HTMLTextAreaElement>(
              `[data-pane="${pane}"] .xterm-helper-textarea`,
            )!
            .focus(),
        first,
      );
      await paste(terminalWrite("gpu-after-loss.txt", "AFTER_CONTEXT_LOSS"));
      await browser.waitUntil(() =>
        existsSync(join(process.env.AW_DESKTOP_PROJECT!, "gpu-after-loss.txt")),
      );
      expect(
        readFileSync(
          join(process.env.AW_DESKTOP_PROJECT!, "gpu-after-loss.txt"),
          "utf8",
        ),
      ).toBe("AFTER_CONTEXT_LOSS");
      await browser.execute(
        (pane) =>
          document
            .querySelector<HTMLTextAreaElement>(
              `[data-pane="${pane}"] .xterm-helper-textarea`,
            )!
            .focus(),
        second,
      );
    }
    writeFileSync(
      "artifacts/evidence/desktop/terminal-graphics.json",
      JSON.stringify(
        {
          graphicsBefore,
          contextLossExercised: lost,
          retainedSession: sessionBeforeLoss,
          sameTerminalAndPty: true,
          scope:
            "Real WebView renderer loss and CLI output; no physical keyboard/IME certification",
        },
        null,
        2,
      ) + "\n",
    );
    const quote = (text: string) =>
      process.platform === "win32"
        ? `"${text.replaceAll('"', '""')}"`
        : `'${text.replaceAll("'", "'\\''")}'`;
    const log = join(process.env.AW_DESKTOP_PROJECT!, "tui-input.jsonl");
    await paste(
      `${process.platform === "win32" ? "" : "exec "}${quote(process.env.AW_DESKTOP_NODE!)} ${quote(process.env.AW_DESKTOP_TUI!)} ${quote(log)}${process.platform === "win32" ? " & exit /b 17" : ""}\n`,
    );
    await browser.waitUntil(
      () =>
        existsSync(log) && readFileSync(log, "utf8").includes('"ready":true'),
    );
    await sendKey("c", "KeyC", 67, { ctrlKey: true });
    await sendKey("z", "KeyZ", 90, { ctrlKey: true });
    await sendKey("ArrowUp", "ArrowUp", 38, {});
    await paste("first line\nsecond line");
    expect(await $('.dialog-content[role="dialog"]').isExisting()).toBe(false);
    await browser.waitUntil(() => {
      const logText = readFileSync(log, "utf8");
      return (
        logText.includes("03") &&
        logText.includes("1a") &&
        logText.includes("1b5b41") &&
        logText.includes("1b5b3230307e")
      );
    });
    const splitSize = await $(".terminal-view.active-pane").getSize();
    await terminalAction("Maximize pane");
    await browser.waitUntil(async () => {
      // Read the rendered geometry as well as the program's SIGWINCH proof.
      // The embedded driver otherwise leaves an inactive WebKit frame deferred.
      const maximized = await $(".terminal-view.active-pane").getSize();
      return (
        maximized.width > splitSize.width &&
        readFileSync(log, "utf8").includes('"resize":true')
      );
    });
    await terminalAction("Restore panes");
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/terminal-split-tui.png",
    );
    const pid = JSON.parse(readFileSync(log, "utf8").split("\n")[0]).pid;
    // Native host/PTYS stay alive; only the webview reloads. No command replay.
    await reloadRenderer();
    await $(".workspace").waitForDisplayed();
    await $('[aria-label="Terminal"]').click();
    await browser.waitUntil(
      async () => (await $$(".terminal-view")).length === 2,
    );
    await $(`[data-pane="${second}"] .xterm-helper-textarea`).waitForExist();
    await browser.execute(
      (pane) =>
        document
          .querySelector<HTMLTextAreaElement>(
            `[data-pane="${pane}"] .xterm-helper-textarea`,
          )!
          .focus(),
      second,
    );
    await browser.waitUntil(async () =>
      (await $(`[data-pane="${second}"]`).getAttribute("class")).includes(
        "active-pane",
      ),
    );
    await sendKey("d", "KeyD", 68, { ctrlKey: true });
    await browser.waitUntil(async () =>
      (await $(`[data-pane="${second}"] .terminal-state`).getText()).includes(
        "Exited 17",
      ),
    );
    expect(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.includes('"ready":true')).length,
    ).toBe(1);
    expect(JSON.parse(readFileSync(log, "utf8").split("\n")[0]).pid).toBe(pid);
    await browser.waitUntil(() =>
      browser.execute(
        (pane) =>
          document.querySelector<HTMLElement>(
            `[data-pane="${pane}"] .terminal-emulator`,
          )?.dataset.terminalGraphicsReady === "true",
        second,
      ),
    );
    const closingContexts = await browser.execute((pane) => {
      const contexts = [
        ...document.querySelectorAll<HTMLCanvasElement>(
          `[data-pane="${pane}"] canvas`,
        ),
      ]
        .map((canvas) => canvas.getContext("webgl2"))
        .filter((gl) => gl !== null);
      (
        window as unknown as { closingGpuContexts: WebGL2RenderingContext[] }
      ).closingGpuContexts = contexts;
      return contexts.length;
    }, second);
    if (process.env.AW_REQUIRE_GPU === "1")
      expect(closingContexts).toBeGreaterThan(0);
    await $(
      `[data-pane="${second}"] button[aria-label="Close ended terminal"]`,
    ).click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      async () => !(await $(`[data-pane="${second}"]`).isExisting()),
    );
    await browser.waitUntil(() =>
      browser.execute(() =>
        (
          window as unknown as { closingGpuContexts: WebGL2RenderingContext[] }
        ).closingGpuContexts.every((gl) => gl.isContextLost()),
      ),
    );
    await browser.execute(() => {
      delete (
        window as unknown as { closingGpuContexts?: WebGL2RenderingContext[] }
      ).closingGpuContexts;
    });
    const graphicsEvidence = JSON.parse(
      readFileSync("artifacts/evidence/desktop/terminal-graphics.json", "utf8"),
    );
    graphicsEvidence.closedContextsExplicitlyLost = closingContexts;
    writeFileSync(
      "artifacts/evidence/desktop/terminal-graphics.json",
      JSON.stringify(graphicsEvidence, null, 2) + "\n",
    );
    await terminalAction("Terminate");
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
  });
  it("previews selected project replacements and reviews a terminal edit through graphical Git", async () => {
    await $('[aria-label="Search project"]').click();
    await $(".search-panel input:not([type=checkbox])").setValue(
      "edited in GUI",
    );
    await $(".search-panel").$("button=Search").click();
    await $('[aria-label="Search results"] [role="option"]').waitForDisplayed();
    await $('[aria-label="Replace with"]').setValue("reviewed replacement");
    await $("button=Preview replacement").click();
    await $("button=Review replacement diff").waitForDisplayed();
    await $("button=Review replacement diff").click();
    await $(".monaco-diff-editor").waitForDisplayed();
    await $("button=Apply selected replacements").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(() =>
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"),
        "utf8",
      ).includes("reviewed replacement"),
    );
    await $('[aria-label="Terminal"]').click();
    await $('button[aria-label="New terminal"]').click();
    await $(".terminal-view.active-pane .xterm-helper-textarea").waitForExist();
    await paste(terminalWrite("hello.ts", "// ordinary CLI edit\n", true));
    await browser.waitUntil(() =>
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "hello.ts"),
        "utf8",
      ).includes("ordinary CLI edit"),
    );
    await $('[aria-label="Changes"]').click();
    await $('[aria-label="Refresh workspace"]').click();
    const row = $('[data-git-kind="working"][title="hello.ts"]');
    await row.waitForDisplayed();
    await row.click();
    await $(".monaco-diff-editor").waitForDisplayed();
    await $("button=Stage hunk 1").click();
    await $("#commit-message").setValue(
      "Reviewed ordinary CLI and selected project replacement",
    );
    await $("button=Commit staged").waitForEnabled();
    await $("button=Commit staged").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await $('button[aria-label="Push"]').waitForEnabled();
    await $('button[aria-label="Push"]').click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(() =>
      execFileSync(
        process.env.AW_DESKTOP_GIT!,
        ["--git-dir", process.env.AW_DESKTOP_REMOTE!, "show", "main:hello.ts"],
        { encoding: "utf8" },
      ).includes("ordinary CLI edit"),
    );
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/terminal-edit-reviewed.png",
    );
    await $('[aria-label="Terminal"]').click();
    await terminalAction("Terminate");
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
  });
  it("shows historical visual diffs and saves an explicitly reviewed Git conflict resolution", async () => {
    const root = process.env.AW_DESKTOP_PROJECT!,
      git = process.env.AW_DESKTOP_GIT!;
    const run = (...args: string[]) => execFileSync(git, args, { cwd: root });
    const subject =
      "History layout fixture with a deliberately long commit subject that must remain readable without overlapping adjacent rows";
    writeFileSync(join(root, "history-layout.txt"), "History layout fixture\n");
    run("add", "--", "history-layout.txt");
    run(
      "commit",
      "-m",
      subject,
      "-m",
      "Full commit body remains available in Commit details.",
    );
    const refs = Array.from(
      { length: 8 },
      (_, index) => `history-layout/long-branch-name-for-narrow-panel-${index}`,
    );
    refs.forEach((name) => run("branch", name));
    await $("button=History").click();
    const commit = $('[aria-label="Repository history"] [role="option"]');
    await commit.waitForDisplayed();
    expect(await commit.$(".git-history-row").getAttribute("title")).toContain(
      refs[7],
    );
    expect(await commit.$(".git-history-row").getAttribute("title")).toContain(
      subject,
    );
    const geometry = [];
    for (const width of [250, 180]) {
      geometry.push(
        await browser.execute((width) => {
          const area = document.querySelector<HTMLElement>(".history-area")!;
          area.style.width = `${width}px`;
          const rows = Array.from(
            area.querySelectorAll<HTMLElement>('[role="option"]'),
          );
          return {
            width,
            rows: rows.map((row) => {
              const box = row.getBoundingClientRect();
              const content =
                row.querySelector<HTMLElement>(".git-history-row")!;
              return {
                height: box.height,
                top: box.top,
                bottom: box.bottom,
                contentHeight: content.scrollHeight,
                contentWidth: content.getBoundingClientRect().width,
                rowWidth: box.width,
                lines: Array.from(content.children).map((element) => ({
                  whiteSpace: getComputedStyle(element).whiteSpace,
                  height: element.getBoundingClientRect().height,
                })),
              };
            }),
          };
        }, width),
      );
    }
    for (const sample of geometry) {
      expect(sample.rows.length).toBeGreaterThan(2);
      for (const [index, row] of sample.rows.entries()) {
        expect(row.height).toBe(30);
        expect(row.contentHeight).toBeLessThanOrEqual(30);
        expect(row.contentWidth).toBeLessThan(row.rowWidth);
        expect(
          row.lines.every(
            (line) => line.whiteSpace === "nowrap" && line.height <= 24,
          ),
        ).toBe(true);
        if (index > 0)
          expect(row.top).toBeGreaterThanOrEqual(sample.rows[index - 1].bottom);
      }
    }
    writeFileSync(
      "artifacts/evidence/desktop/history-density.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "Native WebView with real Git commits/refs; history area constrained to 250px and 180px; not a performance measurement",
          geometry,
        },
        null,
        2,
      ) + "\n",
    );
    await browser.execute(() => {
      document.querySelector<HTMLElement>(".history-area")!.style.width =
        "250px";
    });
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/history-narrow.png",
    );
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>(".history-area")!
        .style.removeProperty("width");
    });
    await commit.click();
    await $("summary=Commit details").waitForDisplayed();
    await $("summary=Commit details").click();
    const details = $(".tool-surface:not([hidden]) .git-output");
    expect(await details.getText()).toContain(subject);
    expect(await details.getText()).toContain(refs[7]);
    expect(await details.getText()).toContain(
      "Full commit body remains available",
    );
    await $("summary=Commit details").click();
    const file = $(".revision-files button");
    await file.waitForDisplayed();
    await file.waitForEnabled();
    await file.click();
    await $(".monaco-diff-editor").waitForDisplayed();
    const fs = await import("node:fs");
    fs.writeFileSync(join(root, "conflict.txt"), "base\n");
    run("add", "--", "conflict.txt");
    run("commit", "-m", "Conflict fixture base");
    run("checkout", "-b", "incoming-fixture");
    fs.writeFileSync(join(root, "conflict.txt"), "incoming\n");
    run("commit", "-am", "Incoming fixture");
    run("checkout", "main");
    fs.writeFileSync(join(root, "conflict.txt"), "current\n");
    run("commit", "-am", "Current fixture");
    const cp = await import("node:child_process");
    const merged = cp.spawnSync(git, ["merge", "incoming-fixture"], {
      cwd: root,
    });
    expect(merged.status).not.toBe(0);
    await $('[aria-label="Changes"]').click();
    await $('[aria-label="Refresh workspace"]').click();
    await $("button=Resolve").waitForDisplayed();
    await $("button=Resolve").waitForEnabled();
    await $("button=Resolve").click();
    await $(".git-conflict-editor").waitForDisplayed();
    await $("button=Use incoming").click();
    await confirmDialog();
    await $("button=Save and stage resolution").click();
    await confirmDialog();
    await browser.waitUntil(
      () => run("ls-files", "-u").toString().trim() === "",
    );
    expect(readFileSync(join(root, "conflict.txt"), "utf8")).toBe("incoming\n");
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/git-conflict-reviewed.png",
    );
  });
  it("creates, renames, deletes and restores a file without stale editor references", async () => {
    await $('[aria-label="Project files"]').click();
    await explorerAction("New file…", true);
    await $('[role="dialog"] input').waitForDisplayed();
    await $('[role="dialog"] input').setValue("rename-me.txt");
    await confirmDialog();
    const original = $(".explorer").$("span=rename-me.txt");
    await original.waitForDisplayed();
    await original.click();
    await explorerAction("Rename…");
    await $('[role="dialog"] input').waitForDisplayed();
    await $('[role="dialog"] input').setValue("renamed.txt");
    await confirmDialog();
    await browser.waitUntil(
      () =>
        existsSync(join(process.env.AW_DESKTOP_PROJECT!, "renamed.txt")) &&
        !existsSync(join(process.env.AW_DESKTOP_PROJECT!, "rename-me.txt")),
    );
    const moved = $(".explorer").$("span=renamed.txt");
    await moved.waitForDisplayed();
    await moved.click();
    await explorerAction("Delete…");
    await confirmDialog();
    await browser.waitUntil(
      () => !existsSync(join(process.env.AW_DESKTOP_PROJECT!, "renamed.txt")),
    );
    await $('[aria-label="Command palette"]').click();
    await $('[aria-label="Filter commands"]').setValue("Restore deleted file");
    await $("button=Restore deleted file").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(() =>
      existsSync(join(process.env.AW_DESKTOP_PROJECT!, "renamed.txt")),
    );
    expect(
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "renamed.txt"),
        "utf8",
      ),
    ).toBe("");
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/files-restored.png",
    );
  });

  it("opens recovery after external deletion and saves an explicit UTF-8 copy", async () => {
    const root = process.env.AW_DESKTOP_PROJECT!;
    const data = process.env.AW_DESKTOP_DATA!;
    const text = 'export const restored = "acknowledged recovery 🌍";\n';
    await $(".explorer").$("span=hello.ts").click();
    await $(".main-editor .monaco-editor").waitForDisplayed();
    await browser.execute((value: string) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".main-editor .monaco-editor textarea.inputarea",
      )!;
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          which: 65,
          metaKey: navigator.platform.includes("Mac"),
          ctrlKey: !navigator.platform.includes("Mac"),
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          which: 65,
          bubbles: true,
        }),
      );
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", value);
      input.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, text);
    let checkpoint = "";
    await browser.waitUntil(() => {
      for (const name of readdirSync(data).filter(
        (name) => name.startsWith("recovery-") && name.endsWith(".json"),
      )) {
        try {
          if (
            JSON.parse(readFileSync(join(data, name), "utf8")).text === text
          ) {
            checkpoint = name;
            return true;
          }
        } catch {
          /* A checkpoint replacement can be in flight. */
        }
      }
      return false;
    });
    unlinkSync(join(root, "hello.ts"));
    await reloadRenderer();
    // Reload can occur before the last navigation debounce is persisted.
    // Recovery may restore in a background tab; select it through the real UI.
    await $(
      '.tab:has([aria-label="Close hello.ts"]) [role="tab"]',
    ).waitForDisplayed();
    await $('.tab:has([aria-label="Close hello.ts"]) [role="tab"]').click();
    await $("button=Save a copy").waitForDisplayed();
    await $("button=Save a copy").click();
    await $('[role="dialog"] input').waitForDisplayed();
    await $('[role="dialog"] input').setValue("recovered-copy.ts");
    await confirmDialog();
    await browser.waitUntil(
      () =>
        existsSync(join(root, "recovered-copy.ts")) &&
        readFileSync(join(root, "recovered-copy.ts"), "utf8") === text,
    );
    expect(existsSync(join(root, "hello.ts"))).toBe(false);
    expect(JSON.parse(readFileSync(join(data, checkpoint), "utf8")).text).toBe(
      text,
    );
  });
});

async function paste(text: string) {
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
async function confirmDialog() {
  await $('[role="dialog"] button.primary').waitForDisplayed();
  await $('[role="dialog"] button.primary').click();
}
async function sendKey(
  key: string,
  code: string,
  keyCode: number,
  modifiers: Record<string, boolean>,
) {
  await browser.execute(
    (k, c, n, m) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        ".terminal-view.active-pane .xterm-helper-textarea",
      )!;
      input.focus();
      for (const type of ["keydown", "keyup"])
        input.dispatchEvent(
          new KeyboardEvent(type, {
            key: k,
            code: c,
            keyCode: n,
            which: n,
            ...m,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    key,
    code,
    keyCode,
    modifiers,
  );
}

async function reloadRenderer() {
  await browser.execute(() => {
    document
      .getElementById("root")!
      .setAttribute("data-reload-probe", "old-document");
  });
  await browser.refresh();
  await browser.waitUntil(
    async () =>
      await browser.execute(
        () =>
          !document.getElementById("root")?.hasAttribute("data-reload-probe"),
      ),
  );
}
