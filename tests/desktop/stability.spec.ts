import { browser, $, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type * as Monaco from "monaco-editor";
describe("native editor lifetime stability", () => {
  it("keeps editor DOM and native descriptors bounded through one hundred open/close cycles", async () => {
    await $("h1").waitForDisplayed();
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $('[role="dialog"] button.primary').waitForDisplayed();
    await $('[role="dialog"] button.primary').click();
    await browser.waitUntil(
      async () => !(await $(".trust-banner").isExisting()),
    );
    await $('.explorer [role="treeitem"]').waitForDisplayed();
    const packaged =
      process.platform === "darwin" && process.env.AW_DESKTOP_PACKAGED === "1";
    const executable = resolve(
      packaged
        ? "artifacts/desktop-perf/Workspace Test.app/Contents/MacOS/agent-workspace"
        : "artifacts/desktop-test/agent-workspace",
    );
    const pid =
      process.platform === "darwin"
        ? execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
            .split("\n")
            .find((line) => line.trim().endsWith(executable))
            ?.trim()
            .split(/\s+/)[0]
        : undefined;
    if (process.platform === "darwin") expect(pid).toBeDefined();
    const inventory = () =>
      pid
        ? execFileSync("/usr/sbin/lsof", ["-a", "-p", pid, "-Ffn"], {
            encoding: "utf8",
          }).split("\n")
        : [];
    // lsof also reports txt/cwd/memory mappings. Only numeric f records are
    // open descriptors; loading an editor framework must not look like FD growth.
    const descriptorCount = (lines: string[]) =>
      pid ? lines.filter((line) => /^f[0-9]+/.test(line)).length : null;
    const stableDescriptors = async () => {
      const samples: (number | null)[] = [];
      let lines: string[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        lines = inventory();
        samples.push(descriptorCount(lines));
        if (
          !pid ||
          (samples.length >= 3 &&
            samples.slice(-3).every((count) => count === samples.at(-1)))
        )
          return {
            value: samples.at(-1) ?? null,
            samples,
            inventory: lines,
            stabilized: true,
          };
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      return {
        value: samples.at(-1) ?? null,
        samples,
        inventory: lines,
        stabilized: false,
      };
    };
    const coldInventory = inventory();
    await browser.execute(() => {
      const file = document.querySelector('.tree-label[title="hello.ts"]');
      if (!file) throw new Error("Fixture file missing");
      file.closest('[role="treeitem"]')!.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
      );
    });
    await $(".main-editor .monaco-editor").waitForExist();
    // Allow the normal language-service debounce/initialization before taking a
    // retained-memory baseline; a rapidly closed first model can avoid it.
    if (packaged) await new Promise((resolve) => setTimeout(resolve, 3000));
    await $('[aria-label="Close hello.ts"]').click();
    await browser.waitUntil(
      async () =>
        !(await $('[aria-label="Close hello.ts"]').isExisting()) &&
        !(await $(".main-editor .monaco-editor").isExisting()),
    );
    const beforeSnapshot = await stableDescriptors();
    type Cohort = {
      residentBytes: number;
      footprintBytes: number;
      hasApp: boolean;
      hasWebview: boolean;
      queryFailures: number;
      members: { pid: number; startAbstime: number }[];
    };
    const settledCohort = async () => {
      if (!packaged || !pid) return null;
      const samples: Cohort[] = [];
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        samples.push(
          JSON.parse(
            execFileSync("artifacts/performance/macos-resources", [pid], {
              encoding: "utf8",
            }),
          ) as Cohort,
        );
      }
      return {
        samples,
        peakResidentBytes: Math.max(
          ...samples.map((sample) => sample.residentBytes),
        ),
        peakFootprintBytes: Math.max(
          ...samples.map((sample) => sample.footprintBytes),
        ),
        complete: samples.every(
          (sample) =>
            sample.hasApp && sample.hasWebview && sample.queryFailures === 0,
        ),
      };
    };
    const cohortBefore = await settledCohort();
    const rss = () =>
      pid
        ? Number(
            execFileSync("/bin/ps", ["-p", pid, "-o", "rss="], {
              encoding: "utf8",
            }).trim(),
          ) * 1024
        : null;
    const beforeDescriptors = beforeSnapshot.value,
      beforeRss = rss();
    await browser.setTimeout({ script: 300000 });
    // DOM clicks use the same React handlers and real native IPC as user clicks.
    // Keep the loop in the webview so driver polling latency is not measured.
    // Observe actual DOM commits: inactive WebKit windows may suspend rAF or
    // throttle short timers, which must not masquerade as an editor deadlock.
    await browser.execute(() => {
      const probe = window as unknown as {
        __editorLifetime?: {
          running?: boolean;
          failure?: string;
          cycles?: number;
          elapsedMs?: number;
          maxEditorDom?: number;
          editorDomAfter?: number;
          phase?: string;
        };
      };
      probe.__editorLifetime = { running: true };
      void (async () => {
        const started = performance.now();
        let maxEditors = 0;
        let cycle = 0;
        let phase = "opening";
        const waitFor = (predicate: () => boolean) =>
          new Promise<void>((resolve, reject) => {
            const finish = (failure?: Error) => {
              observer.disconnect();
              clearTimeout(timer);
              if (failure) reject(failure);
              else resolve();
            };
            const check = () => {
              if (document.querySelector('[role="dialog"]'))
                finish(
                  new Error("Unexpected dialog while closing a clean fixture"),
                );
              else if (predicate()) finish();
            };
            const observer = new MutationObserver(check);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
            });
            const timer = setTimeout(
              () =>
                finish(
                  new Error(
                    `Editor lifetime transition timed out at cycle ${cycle + 1} (${phase})`,
                  ),
                ),
              10000,
            );
            check();
          });
        try {
          for (; cycle < 100; cycle++) {
            phase = "opening";
            probe.__editorLifetime = { running: true, cycles: cycle, phase };
            const file = Array.from(
              document.querySelectorAll<HTMLElement>(
                '.explorer [role="treeitem"]',
              ),
            ).find((node) => node.textContent?.trim() === "hello.ts");
            if (!file) throw new Error("Fixture file missing");
            file.dispatchEvent(
              new MouseEvent("dblclick", { bubbles: true, detail: 2 }),
            );
            await waitFor(
              () =>
                !!document.querySelector('[aria-label="Close hello.ts"]') &&
                !!document.querySelector(".main-editor .monaco-editor"),
            );
            maxEditors = Math.max(
              maxEditors,
              document.querySelectorAll(".monaco-editor").length,
            );
            phase = "closing";
            probe.__editorLifetime = { running: true, cycles: cycle, phase };
            document
              .querySelector<HTMLElement>('[aria-label="Close hello.ts"]')!
              .click();
            await waitFor(
              () =>
                !document.querySelector('[aria-label="Close hello.ts"]') &&
                !document.querySelector(".main-editor .monaco-editor"),
            );
          }
          probe.__editorLifetime = {
            cycles: 100,
            elapsedMs: performance.now() - started,
            maxEditorDom: maxEditors,
            editorDomAfter: document.querySelectorAll(".monaco-editor").length,
          };
        } catch (error) {
          probe.__editorLifetime = {
            failure: String(error),
            cycles: cycle,
            phase,
            elapsedMs: performance.now() - started,
            maxEditorDom: maxEditors,
            editorDomAfter: document.querySelectorAll(".monaco-editor").length,
          };
        }
      })();
      return true;
    });
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            !(window as unknown as { __editorLifetime?: { running?: boolean } })
              .__editorLifetime?.running,
        ),
      { timeout: 180000, interval: 1000 },
    );
    const result = await browser.execute(
      () =>
        (
          window as unknown as {
            __editorLifetime: {
              cycles?: number;
              failure?: string;
              elapsedMs: number;
              maxEditorDom: number;
              editorDomAfter: number;
            };
          }
        ).__editorLifetime,
    );
    const module =
      "/assets/" +
      readdirSync("dist-desktop-test/assets").find((name) =>
        /^monaco-[\w-]+\.js$/.test(name),
      )!;
    const retained = await browser.execute(async (path) => {
      const { monaco } = (await import(path)) as { monaco: typeof Monaco };
      return {
        models: monaco.editor.getModels().length,
        views: monaco.editor.getEditors().length,
        emptyViews: monaco.editor
          .getEditors()
          .every((editor) => editor.getModel() === null),
      };
    }, module);
    expect(retained.models).toBe(0);
    expect(retained.views).toBe(1);
    expect(retained.emptyViews).toBe(true);
    const afterSnapshot = await stableDescriptors();
    const afterDescriptors = afterSnapshot.value,
      afterRss = rss();
    const cohortAfter = await settledCohort();
    const retainedGrowth =
      cohortBefore && cohortAfter
        ? cohortAfter.peakResidentBytes / cohortBefore.peakResidentBytes - 1
        : null;
    writeFileSync(
      "artifacts/evidence/desktop/stability.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          scenario: process.env.AW_DESKTOP_LOAD_SCENARIO ?? "idle",
          profile: packaged
            ? "optimized packaged native desktop with isolated driver; aggregate retained-memory regression, not ordinary-build absolute-budget certification"
            : "development native desktop with test driver; not production memory certification",
          ...result,
          retained,
          descriptorMeasurement:
            "Numeric lsof f records only; one editor warm-up before baseline; three equal samples, unchanged +5 retained-FD limit",
          warmupCycles: 1,
          nativeColdInventory: coldInventory,
          nativeDescriptorSamplesBefore: beforeSnapshot.samples,
          nativeDescriptorSamplesAfter: afterSnapshot.samples,
          nativeInventoryBefore: beforeSnapshot.inventory,
          nativeInventoryAfter: afterSnapshot.inventory,
          nativeDescriptorsStabilized:
            beforeSnapshot.stabilized && afterSnapshot.stabilized,
          nativeDescriptorsBefore: beforeDescriptors,
          nativeDescriptorsAfter: afterDescriptors,
          nativeRssBefore: beforeRss,
          nativeRssAfter: afterRss,
          cohortBefore,
          cohortAfter,
          retainedGrowth,
          limits: packaged
            ? "Aggregate RSS includes app/WebKit/worker/driver members and can double-count shared pages; footprint is separate. Five natural one-second samples before/after 100 real cycles, no forced GC. Physical input and ordinary absolute resource targets are separate."
            : "Native RSS excludes WebKit processes; production startup/input/idle CPU, heap and all-process memory remain unverified.",
        },
        null,
        2,
      ) + "\n",
    );
    expect(result.failure).toBeUndefined();
    expect(result.cycles).toBe(100);
    expect(result.maxEditorDom).toBeLessThanOrEqual(2);
    expect(result.editorDomAfter).toBe(0);
    expect(beforeSnapshot.stabilized && afterSnapshot.stabilized).toBe(true);
    if (beforeDescriptors !== null && afterDescriptors !== null)
      expect(afterDescriptors).toBeLessThanOrEqual(beforeDescriptors + 5);
    if (cohortBefore && cohortAfter) {
      expect(cohortBefore.complete && cohortAfter.complete).toBe(true);
      expect(retainedGrowth).toBeLessThanOrEqual(0.1);
    }
  });
});
