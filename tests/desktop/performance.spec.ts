import { browser, $, $$, expect } from "@wdio/globals";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { preserveEvidence } from "../../scripts/evidence.mjs";
type Probe = {
  running?: boolean;
  failure?: string;
  opens?: number[];
  input?: number[];
  searchInput?: number[];
  cancelMs?: number;
  typing?: boolean;
};
describe("optimized native UI performance", () => {
  it("measures cached opens and input paint under real PTY output and native search", async () => {
    preserveEvidence("artifacts/evidence/performance-ui.json");
    const report: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      applicationSource: process.env.AW_PERF_SOURCE ?? "working tree",
      binarySha256: createHash("sha256")
        .update(readFileSync("artifacts/desktop-perf/agent-workspace"))
        .digest("hex"),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        osRelease: release(),
        cpu: cpus()[0].model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        powerProfile: execFileSync("/usr/bin/pmset", ["-g", "custom"], {
          encoding: "utf8",
        }).trim(),
        power: execFileSync("/usr/bin/pmset", ["-g", "batt"], {
          encoding: "utf8",
        }).trim(),
      },
      profile:
        "optimized release with isolated embedded test driver; normal distribution driver exclusion is a separate check",
      method:
        "Real editor/native IPC; browser selected-range text input, two animation-frame paint opportunities per character. Samples run inside the WebView, like cached opens, to exclude per-character WebDriver transport. Physical keyboard/OS queue latency excluded. Fixed 150/50/100 ms budgets are not relaxed.",
    };
    const save = () =>
      writeFileSync(
        "artifacts/evidence/performance-ui.json",
        JSON.stringify(report, null, 2) + "\n",
      );
    try {
      await $("h1").waitForDisplayed();
      await $(".recent-projects button").click();
      await $(".trust-banner button").waitForDisplayed();
      await $(".trust-banner button").click();
      await $('[role="dialog"] button.primary').waitForDisplayed();
      await $('[role="dialog"] button.primary').click();
      await $('.explorer [role="treeitem"]').waitForDisplayed();
      // Put the isolated benchmark on a real display before asking WebKit to
      // paint. LaunchServices may restore the test window onto another Space.
      await browser.execute(() => {
        const api = (
          window as unknown as {
            __TAURI__: {
              window: {
                currentMonitor(): Promise<{
                  scaleFactor: number;
                  position: { x: number; y: number };
                } | null>;
                availableMonitors(): Promise<
                  { scaleFactor: number; position: { x: number; y: number } }[]
                >;
                PhysicalPosition: new (x: number, y: number) => unknown;
                getCurrentWindow(): {
                  setPosition(position: unknown): Promise<void>;
                };
              };
            };
          }
        ).__TAURI__;
        void (async () => {
          try {
            const all = await api.window.availableMonitors(),
              current = await api.window.currentMonitor(),
              monitor = current ?? all[0];
            if (!monitor) throw new Error("No display available");
            // Retain LaunchServices' actual foreground display/Space. Moving to
            // another display can remove native focus even on an unlocked Mac.
            if (!current)
              await api.window
                .getCurrentWindow()
                .setPosition(
                  new api.window.PhysicalPosition(
                    monitor.position.x + 80,
                    monitor.position.y + 80,
                  ),
                );
            document.documentElement.dataset.perfDisplay = "ready";
          } catch (error) {
            document.documentElement.dataset.perfDisplay = String(error);
          }
        })();
      });
      await browser.waitUntil(() =>
        browser.execute(() => {
          const status = document.documentElement.dataset.perfDisplay;
          if (status && status !== "ready") throw new Error(status);
          return status === "ready";
        }),
      );
      // Test-only scoped focus permission; never enable it to conceal a missing
      // paint. A background/suspended animation frame must fail the measurement.
      await browser.execute(() => {
        const api = window as unknown as {
          __TAURI__: {
            window: {
              getCurrentWindow: () => {
                setFocus: () => Promise<void>;
                show: () => Promise<void>;
                isVisible: () => Promise<boolean>;
                isFocused: () => Promise<boolean>;
              };
            };
            webview: {
              getCurrentWebview: () => {
                setFocus: () => Promise<void>;
                show: () => Promise<void>;
              };
            };
          };
        };
        void (async () => {
          try {
            await api.__TAURI__.window.getCurrentWindow().show();
            await api.__TAURI__.webview.getCurrentWebview().show();
            await api.__TAURI__.window.getCurrentWindow().setFocus();
            await api.__TAURI__.webview.getCurrentWebview().setFocus();
            document.documentElement.dataset.perfNativeVisible = String(
              await api.__TAURI__.window.getCurrentWindow().isVisible(),
            );
            document.documentElement.dataset.perfNativeFocused = String(
              await api.__TAURI__.window.getCurrentWindow().isFocused(),
            );
            document.body.tabIndex = -1;
            document.body.focus();
            document.documentElement.dataset.perfFocus = "ready";
          } catch (error) {
            document.documentElement.dataset.perfFocus = String(error);
          }
        })();
        return true;
      });
      await browser.waitUntil(() =>
        browser.execute(() => {
          const status = document.documentElement.dataset.perfFocus;
          if (status && status !== "ready") throw new Error(status);
          return status === "ready";
        }),
      );
      await browser
        .waitUntil(
          () =>
            browser.execute(
              () =>
                document.visibilityState === "visible" && document.hasFocus(),
            ),
          { timeout: 10000 },
        )
        .catch(() => {});
      report.window = await browser.execute(() => ({
        documentFocused: document.hasFocus(),
        visibility: document.visibilityState,
        nativeVisible: document.documentElement.dataset.perfNativeVisible,
        nativeFocused: document.documentElement.dataset.perfNativeFocused,
        devicePixelRatio,
        userAgent: navigator.userAgent,
      }));
      if (
        (report.window as { visibility: string }).visibility !== "visible" ||
        !(report.window as { documentFocused: boolean }).documentFocused
      ) {
        report.status = "BLOCKED";
        throw new Error(
          "Foreground paint measurement is unavailable: WebKit is hidden or unfocused despite native show/focus requests. Run on an active desktop; no latency budget was evaluated.",
        );
      }
      await browser.execute(() => {
        const win = window as unknown as {
          __frameBaseline: {
            running: boolean;
            intervals: number[];
            delays: number[];
          };
        };
        win.__frameBaseline = { running: true, intervals: [], delays: [] };
        let previous = 0;
        const frame = (timestamp: number) => {
          if (previous)
            win.__frameBaseline.intervals.push(timestamp - previous);
          win.__frameBaseline.delays.push(performance.now() - timestamp);
          previous = timestamp;
          if (win.__frameBaseline.intervals.length < 60)
            requestAnimationFrame(frame);
          else win.__frameBaseline.running = false;
        };
        requestAnimationFrame(frame);
      });
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            !(window as unknown as { __frameBaseline: { running: boolean } })
              .__frameBaseline.running,
        ),
      );
      report.frameBaseline = await browser.execute(
        () =>
          (window as unknown as { __frameBaseline: unknown }).__frameBaseline,
      );
      const hello = join(process.env.AW_DESKTOP_PROJECT!, "hello.ts");
      report.fileBytes = statSync(hello).size;
      const activityOnly = process.env.AW_PERF_ACTIVITY_ONLY === "1";
      let opens: Probe = { opens: [] };
      if (!activityOnly) {
        await browser.execute(() => {
          const state = window as unknown as { __perf: Probe };
          state.__perf = {
            running: true,
            opens: [],
            input: [],
            searchInput: [],
          };
          void (async () => {
            const wait = (predicate: () => boolean) =>
              new Promise<void>((resolve, reject) => {
                const observer = new MutationObserver(check);
                const timer = setTimeout(() => {
                  observer.disconnect();
                  reject(new Error("UI transition exceeded 10 seconds"));
                }, 10000);
                function check() {
                  if (predicate()) {
                    clearTimeout(timer);
                    observer.disconnect();
                    resolve();
                  }
                }
                observer.observe(document.body, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                });
                check();
              });
            const paint = () =>
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Visible paint was unavailable")),
                  10000,
                );
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    clearTimeout(timer);
                    resolve();
                  }),
                );
              });
            try {
              for (let run = 0; run < 35; run++) {
                const file = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    '.explorer [role="treeitem"]',
                  ),
                ).find((node) => node.textContent?.trim() === "hello.ts");
                if (!file) throw new Error("Actual fixture file missing");
                const started = performance.now();
                file.click();
                await wait(
                  () =>
                    !!document
                      .querySelector(".main-editor .view-lines")
                      ?.textContent?.includes("greeting"),
                );
                await paint();
                if (
                  document.visibilityState !== "visible" ||
                  !document.hasFocus()
                )
                  throw new Error(
                    "Foreground eligibility lost during cached opening; hidden/unfocused frames cannot establish a latency budget",
                  );
                if (run >= 5)
                  state.__perf.opens!.push(performance.now() - started);
                document
                  .querySelector<HTMLElement>('[aria-label="Close hello.ts"]')!
                  .click();
                await wait(
                  () =>
                    !document.querySelector('[aria-label="Close hello.ts"]'),
                );
              }
              state.__perf.running = false;
            } catch (error) {
              state.__perf.failure = String(error);
              state.__perf.running = false;
            }
          })();
          return true;
        });
        await browser.waitUntil(
          () =>
            browser.execute(
              () => !(window as unknown as { __perf: Probe }).__perf.running,
            ),
          { timeout: 90000 },
        );
        opens = await browser.execute(
          () => (window as unknown as { __perf: Probe }).__perf,
        );
        report.cachedOpen = opens;
        if (opens.failure?.includes("Foreground eligibility"))
          report.status = "BLOCKED";
        save();
        expect(opens.failure).toBeUndefined();
        expect(opens.opens?.length).toBe(30);
      } else
        report.cachedOpen = {
          status: "BLOCKED",
          reason:
            "Pre-change optimized editor first paint failed. This run measures settled working-session activity only.",
        };
      const files = await $$('.explorer [role="treeitem"]');
      for (const file of files)
        if ((await file.getText()).trim() === "hello.ts") await file.click();
      await $(".main-editor .monaco-editor textarea.inputarea").waitForExist();
      if (activityOnly) {
        const module =
          "/assets/" +
          readdirSync("dist-desktop-test/assets").find((name) =>
            /^monaco-[\w-]+\.js$/.test(name),
          )!;
        await browser.execute((path) => {
          void import(path).then((module) => {
            for (const editor of module.monaco.editor.getEditors()) {
              editor.layout();
              editor.render(true);
            }
            document.documentElement.dataset.perfDiagnosticRender = "ready";
          });
        }, module);
        await browser.waitUntil(() =>
          browser.execute(
            () =>
              document.documentElement.dataset.perfDiagnosticRender === "ready",
          ),
        );
      }
      await $('[aria-label="Terminal"]').click();
      await $('button[aria-label="New terminal"]').click();
      await $(".xterm-helper-textarea").waitForExist();
      await browser.waitUntil(() =>
        browser.execute(() =>
          [
            ...document.querySelectorAll<HTMLElement>(".terminal-emulator"),
          ].every((node) => node.dataset.terminalGraphicsReady === "true"),
        ),
      );
      report.terminalRendering = await browser.execute(() =>
        [...document.querySelectorAll<HTMLElement>(".terminal-emulator")].map(
          (node) => node.dataset.terminalRenderer,
        ),
      );
      if (process.env.AW_REQUIRE_GPU === "1")
        expect(report.terminalRendering).toEqual(["webgl"]);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await browser.execute(() => {
        const win = window as unknown as {
          __idleForeground: { start: boolean; lost: boolean; stop: () => void };
        };
        const visible = () =>
          document.visibilityState === "visible" && document.hasFocus();
        const check = () => {
          if (!visible()) win.__idleForeground.lost = true;
        };
        win.__idleForeground = {
          start: visible(),
          lost: false,
          stop: () => {
            window.removeEventListener("blur", check);
            document.removeEventListener("visibilitychange", check);
          },
        };
        window.addEventListener("blur", check);
        document.addEventListener("visibilitychange", check);
      });
      const data = process.env.AW_DESKTOP_DATA!;
      const pid = Number(
        /AW_METRIC process_started pid=(\d+)/.exec(
          readFileSync(join(data, "packaged-test.stderr"), "utf8"),
        )?.[1],
      );
      if (!pid) throw new Error("Owned performance PID missing");
      const helper = resolve("artifacts/performance/macos-resources");
      const sample = () =>
        JSON.parse(
          execFileSync(helper, [String(pid)], { encoding: "utf8" }),
        ) as {
          residentBytes: number;
          footprintBytes: number;
          members: { pid: number; startAbstime: number; cpuNs: number }[];
        };
      const idleStart = performance.now(),
        samples = [sample()];
      const idleSeconds = Number(process.env.AW_PERF_IDLE_SECONDS ?? 60);
      for (let second = 0; second < idleSeconds; second++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        samples.push(sample());
      }
      let cpuNs = 0,
        membershipChanged = false;
      const counters = new Map(
        samples[0].members.map((m) => [`${m.pid}:${m.startAbstime}`, m.cpuNs]),
      );
      for (const current of samples.slice(1)) {
        const keys = new Set(
          current.members.map((m) => `${m.pid}:${m.startAbstime}`),
        );
        if (
          keys.size !== counters.size ||
          [...keys].some((k) => !counters.has(k))
        )
          membershipChanged = true;
        for (const m of current.members) {
          const key = `${m.pid}:${m.startAbstime}`,
            old = counters.get(key);
          if (old !== undefined) cpuNs += Math.max(0, m.cpuNs - old);
          counters.set(key, m.cpuNs);
        }
      }
      const idleMs = performance.now() - idleStart;
      const foreground = await browser.execute(() => {
        const observed = (
          window as unknown as {
            __idleForeground: {
              start: boolean;
              lost: boolean;
              stop: () => void;
            };
          }
        ).__idleForeground;
        observed.stop();
        return {
          start: observed.start,
          lost: observed.lost,
          end: document.visibilityState === "visible" && document.hasFocus(),
        };
      });
      const eligible =
        foreground.start &&
        !foreground.lost &&
        foreground.end &&
        !membershipChanged &&
        idleSeconds >= 60 &&
        idleMs >= 60000;
      const peakResidentBytes = Math.max(
        ...samples.map((s) => s.residentBytes),
      );
      const idleCpuPercent = (cpuNs / (idleMs * 1e6)) * 100;
      report.idleSession = {
        seconds: idleSeconds,
        elapsedMs: idleMs,
        cpuPercentOfOneCore: idleCpuPercent,
        membershipChanged,
        foreground,
        peakResidentBytes,
        peakFootprintBytes: Math.max(...samples.map((s) => s.footprintBytes)),
        requestObserver:
          "Unavailable; this driver cannot intercept the read-only invoke entry point. No IPC counts claimed.",
        samples,
        accounting:
          "Actual app resource coalition, including WebKit and idle shell; RSS may double-count shared pages; physical footprint separate. Stable membership is required for CPU acceptance.",
        budgets: {
          cpuMeasurementEligible: eligible,
          cpuBelowOnePercent: eligible ? idleCpuPercent < 1 : null,
          fullSessionRssWithin500MiB: peakResidentBytes <= 500 * 1024 * 1024,
          scope:
            "One visible editor and one idle shell, optimized test driver included. Separate from ordinary no-driver startup and release certification.",
        },
      };
      save();
      if (activityOnly) {
        report.status = "DIAGNOSTIC";
        report.limits =
          "Settled activity comparison only; cached opening was blocked by the initial render defect. A public Monaco layout/render call prepares the same visible working session for baseline/after activity. This is not a latency-budget pass.";
        save();
        return;
      }
      const proof = join(process.env.AW_DESKTOP_PROJECT!, "flood-proof.json");
      const originalText = readFileSync(hello, "utf8");
      const module =
        "/assets/" +
        readdirSync("dist-desktop-test/assets").find((name) =>
          /^monaco-[\w-]+\.js$/.test(name),
        )!;
      await browser.execute((path) => {
        void import(path)
          .then(({ monaco }) => {
            const editor = monaco.editor
              .getEditors()
              .find((e: { getDomNode(): HTMLElement | null }) =>
                e.getDomNode()?.closest(".main-editor"),
              );
            if (!editor?.getModel())
              throw new Error("Primary benchmark editor missing");
            editor.setPosition({ lineNumber: 1, column: 1 });
            let length = editor.getModel().getValueLength();
            (window as unknown as { __perfFocus: () => void }).__perfFocus =
              () => editor.focus();
            (window as unknown as { __perfType: () => void }).__perfType =
              () => {
                if (
                  document.visibilityState !== "visible" ||
                  !document.hasFocus()
                )
                  throw new Error("Foreground eligibility lost during typing");
                // WebDriver addValue appends the whole accessibility context buffer.
                // Let WebKit perform its normal selected-range text edit instead.
                if (!document.execCommand("insertText", false, "a"))
                  throw new Error("Browser text insertion unavailable");
                length++;
                if (editor.getModel().getValueLength() !== length)
                  throw new Error(
                    "Benchmark input did not insert exactly one character",
                  );
              };
            document.documentElement.dataset.perfTyping = "ready";
          })
          .catch((error) => {
            document.documentElement.dataset.perfTyping = String(error);
          });
      }, module);
      await browser.waitUntil(() =>
        browser.execute(() => {
          const value = document.documentElement.dataset.perfTyping;
          if (value && value !== "ready") throw new Error(value);
          return value === "ready";
        }),
      );
      const typeSamples = async (searching: boolean) => {
        await browser.execute((searching) => {
          const win = window as unknown as {
            __perf: Probe;
            __perfType: () => void;
            __perfFocus: () => void;
          };
          win.__perf.typing = true;
          void (async () => {
            try {
              win.__perfFocus();
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
              for (let i = 0; i < 60; i++) {
                if (searching) {
                  const submit = Array.from(
                    document.querySelectorAll<HTMLButtonElement>(
                      ".search-panel button",
                    ),
                  ).find((button) => button.textContent === "Search");
                  if (submit && !submit.disabled) submit.click();
                }
                win.__perfType();
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                );
              }
            } catch (error) {
              win.__perf.failure = String(error);
            } finally {
              win.__perf.typing = false;
            }
          })();
        }, searching);
        await browser.waitUntil(
          () =>
            browser.execute(
              () => !(window as unknown as { __perf: Probe }).__perf.typing,
            ),
          { timeout: 30000 },
        );
        expect(
          await browser.execute(
            () =>
              (window as unknown as { __perf: Probe }).__perf.failure ?? null,
          ),
        ).toBeNull();
      };
      const quote = (text: string) =>
        process.platform === "win32"
          ? `"${text.replaceAll('"', '""')}"`
          : `'${text.replaceAll("'", "'\\''")}'`;
      const command = `${quote(process.env.AW_DESKTOP_NODE!)} ${quote(process.env.AW_DESKTOP_FLOOD!)} ${quote(proof)}\n`;
      await browser.execute((text) => {
        const input = document.querySelector<HTMLTextAreaElement>(
          ".xterm-helper-textarea",
        )!;
        input.focus();
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", text);
        input.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, command);
      await browser.waitUntil(() => existsSync(proof));
      await browser.execute(() => {
        const state = window as unknown as { __perf: Probe };
        document.addEventListener(
          "input",
          (event) => {
            if (
              !(event.target instanceof HTMLTextAreaElement) ||
              !event.target.matches(".main-editor textarea.inputarea") ||
              (event as InputEvent).inputType !== "insertText"
            )
              return;
            const started = performance.now();
            const searching = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                ".search-panel button",
              ),
            ).some(
              (button) => button.textContent === "Cancel" && !button.disabled,
            );
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const duration = performance.now() - started;
                state.__perf.input!.push(duration);
                if (searching) state.__perf.searchInput!.push(duration);
              }),
            );
          },
          true,
        );
      });
      await typeSamples(false);
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            (window as unknown as { __perf: Probe }).__perf.input!.length >= 60,
        ),
      );
      const underOutput = await browser.execute(() => [
        ...(window as unknown as { __perf: Probe }).__perf.input!,
      ]);
      report.inputDuringTerminal = underOutput;
      save();
      await $('[aria-label="Search project"]').click();
      await $(".search-panel input:not([type=checkbox])").setValue(
        "NO_POSSIBLE_FIXTURE_MATCH_198731",
      );
      await $(".search-panel input[type=checkbox]:not([aria-label])").click();
      await $(".search-panel").$("button=Search").click();
      await $(".search-panel").$("button=Cancel").waitForEnabled();
      await browser.execute(() => {
        const state = window as unknown as { __perf: Probe };
        const cancel = Array.from(
          document.querySelectorAll<HTMLButtonElement>(".search-panel button"),
        ).find((button) => button.textContent === "Cancel")!;
        const started = performance.now();
        cancel.click();
        const check = () => {
          if (cancel.disabled) {
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                state.__perf.cancelMs = performance.now() - started;
              }),
            );
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(cancel, { attributes: true });
        check();
      });
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            (window as unknown as { __perf: Probe }).__perf.cancelMs !==
            undefined,
        ),
      );
      report.cancelMs = await browser.execute(
        () => (window as unknown as { __perf: Probe }).__perf.cancelMs,
      );
      await $(".search-panel").$("button=Search").click();
      await $(".search-panel").$("button=Cancel").waitForEnabled();
      await typeSamples(true);
      await browser.waitUntil(() =>
        browser.execute(
          () =>
            (window as unknown as { __perf: Probe }).__perf.input!.length >=
            120,
        ),
      );
      const allInput = await browser.execute(
        () => (window as unknown as { __perf: Probe }).__perf.input!,
      );
      const searchInput = await browser.execute(
        () => (window as unknown as { __perf: Probe }).__perf.searchInput!,
      );
      report.inputDuringSearchAndTerminal = searchInput;
      expect(searchInput.length).toBeGreaterThanOrEqual(30);
      await $('[aria-label="Save file"]').waitForEnabled();
      await $('[aria-label="Save file"]').click();
      await browser.waitUntil(
        () => readFileSync(hello, "utf8") === "a".repeat(120) + originalText,
      );
      await browser.waitUntil(
        () => {
          try {
            return JSON.parse(readFileSync(proof, "utf8")).done === true;
          } catch {
            return false;
          }
        },
        { timeout: 50000 },
      );
      const flood = JSON.parse(readFileSync(proof, "utf8"));
      report.terminalFlood = flood;
      expect(flood.bytes).toBeGreaterThan(1024 * 1024);
      const percentile = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
      const summary = {
        cachedOpenP95Ms: percentile(opens.opens!),
        inputOutputP95Ms: percentile(underOutput),
        inputSearchOutputP95Ms: percentile(searchInput),
        stallsOver100Ms: allInput.filter((value) => value > 100).length,
        cancelMs: report.cancelMs,
      };
      report.summary = summary;
      save();
      expect(summary.cachedOpenP95Ms).toBeLessThanOrEqual(150);
      expect(summary.inputOutputP95Ms).toBeLessThanOrEqual(50);
      expect(summary.inputSearchOutputP95Ms).toBeLessThanOrEqual(50);
      expect(summary.cancelMs).toBeLessThanOrEqual(100);
      expect(summary.stallsOver100Ms).toBeLessThanOrEqual(1);
    } catch (error) {
      report.failure = String(error);
      save();
      throw error;
    }
  });
});
