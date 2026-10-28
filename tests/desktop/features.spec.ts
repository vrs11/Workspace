import { readPng } from "./png";
import { $, browser, expect } from "@wdio/globals";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Monaco from "monaco-editor";
const mod =
  process.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
async function key(
  selector: string,
  key: string,
  code: string,
  extra: Record<string, boolean> = {},
) {
  await browser.execute(
    (selector, key, code, modifiers) => {
      const target = document.querySelector<HTMLElement>(selector)!;
      target.focus();
      for (const type of ["keydown", "keyup"])
        target.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code,
            keyCode: code.startsWith("Key")
              ? code.charCodeAt(3)
              : code.startsWith("F")
                ? 111 + Number(code.slice(1))
                : 0,
            bubbles: true,
            cancelable: true,
            ...modifiers,
          }),
        );
    },
    selector,
    key,
    code,
    { ...mod, ...extra },
  );
}
async function open(file: string) {
  await $(`.tree-label[title="${file}"]`).click();
}
async function setBinding(id: string, value: string) {
  await $('input[aria-label="Search keyboard shortcuts"]').setValue(id);
  const button = $(`.keymap-table [data-command-id="${id}"] button`);
  await button.waitForDisplayed();
  await button.click();
  await $(".keymap-editor input").setValue(value);
  await $("button=Apply shortcut").click();
  await browser.waitUntil(
    async () => !(await $(".keymap-editor").isExisting()),
  );
}
describe("syntax, real media and configurable keymap", () => {
  it("detects common languages and extensionless technologies and renders actual syntax tokens", async () => {
    await $("h1").waitForDisplayed();
    expect(await browser.getTitle()).toBe("Workspace");
    expect(await $(".brand").getText()).toContain("Workspace");
    expect(await $(".brand").getText()).not.toContain("Agent");
    await $(".recent-projects button").click();
    await $(".trust-banner button").waitForDisplayed();
    await $(".trust-banner button").click();
    await $(".dialog-content button.primary").waitForDisplayed();
    await $(".dialog-content button.primary").click();
    await $('.tree-label[title="hello.ts"]').waitForDisplayed();
    const results = [];
    for (const [name, language] of [
      ["Dockerfile", "dockerfile"],
      ["Cargo.toml", "toml"],
      ["build.gradle.kts", "kotlin"],
      ["App.tsx", "typescript"],
    ]) {
      await open(name);
      await $(".editor-surface textarea.inputarea").waitForExist();
      await $('select[aria-label="Language mode"]').waitForExist();
      await browser.waitUntil(
        async () =>
          (await $('select[aria-label="Language mode"]').getValue()) ===
          language,
      );
      const path =
        "/assets/" +
        readdirSync("dist-desktop-test/assets").find((name) =>
          /^monaco-[\w-]+\.js$/.test(name),
        )!;
      await browser.execute(async (path) => {
        const monaco = (await import(path)).monaco as typeof Monaco;
        (window as unknown as { featureMonaco: typeof Monaco }).featureMonaco =
          monaco;
        monaco.editor.getEditors()[0].render(true);
      }, path);
      await browser.waitUntil(() =>
        browser.execute(() => {
          const m = (window as unknown as { featureMonaco: typeof Monaco })
            .featureMonaco;
          const editor = m.editor.getEditors()[0];
          editor.render(true);
          return m.editor
            .tokenize(editor.getValue(), editor.getModel()!.getLanguageId())
            .flat()
            .some((token) => token.type !== "");
        }),
      );
      results.push(
        await browser.execute(() => {
          const m = (window as unknown as { featureMonaco: typeof Monaco })
            .featureMonaco;
          const model = m.editor.getEditors()[0].getModel()!;
          return {
            language: model.getLanguageId(),
            uri: model.uri.toString(),
            types: [
              ...new Set(
                m.editor
                  .tokenize(model.getValue(), model.getLanguageId())
                  .flat()
                  .map((token) => token.type),
              ),
            ],
            registered: m.languages.getLanguages().length,
          };
        }),
      );
    }
    expect(results[3].uri.endsWith("App.tsx")).toBe(true);
    expect(results[0].registered).toBeGreaterThan(70);
    // Syntax tokens alone do not prove bundled language workers can answer.
    // Use disposable, in-memory fixtures; never modify the opened documents.
    const workers = await browser.execute(async () => {
      const m = (window as unknown as { featureMonaco: typeof Monaco })
        .featureMonaco;
      const fixtures = [
        ["typescript", "ts", "const result: number = 'wrong';"],
        ["javascript", "js", "const value = 42;\nvalue;"],
        ["json", "json", '{"value": }'],
        ["css", "css", "a{color:#ff0000;display:block}"],
        [
          "html",
          "html",
          "<html><body><div><p>hello</p><p>world</p></div></body></html>",
        ],
      ];
      const temporary = fixtures.map(([language, extension, text]) =>
        m.editor.createModel(
          text,
          language,
          m.Uri.parse(`inmemory://worker-proof/fixture.${extension}`),
        ),
      );
      const surface = document.createElement("div");
      surface.style.cssText =
        "position:fixed;inset:100px auto auto 100px;width:500px;height:250px";
      let scratch: Monaco.editor.IStandaloneCodeEditor | undefined;
      try {
        const [ts, js, json, css, html] = temporary;
        const tsWorker = await (
          await m.typescript.getTypeScriptWorker()
        )(ts.uri);
        const jsWorker = await (
          await m.typescript.getJavaScriptWorker()
        )(js.uri);
        const jsonWorker = await (await m.json.getWorker())(json.uri);
        document.body.append(surface);
        scratch = m.editor.create(surface, {
          model: css,
          minimap: { enabled: false },
        });
        const formatted = [];
        for (const model of [css, html]) {
          scratch.setModel(model);
          scratch.focus();
          const action = scratch.getAction("editor.action.formatDocument")!;
          const deadline = performance.now() + 10000;
          // Lazy language providers register asynchronously. Wait for readiness
          // before issuing one formatting action, without retrying the action.
          while (!action.isSupported()) {
            if (performance.now() >= deadline)
              throw new Error(
                `Formatter unavailable: ${model.getLanguageId()}`,
              );
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          await action.run();
          formatted.push(model.getValue().includes("\n"));
        }
        return {
          typeErrors: (
            await tsWorker.getSemanticDiagnostics(ts.uri.toString())
          ).map((diagnostic) => diagnostic.code),
          javascriptType: (
            await jsWorker.getQuickInfoAtPosition(
              js.uri.toString(),
              js.getValue().lastIndexOf("value"),
            )
          )?.displayParts
            ?.map((part) => part.text)
            .join(""),
          jsonErrors: (await jsonWorker.doValidation(json.uri.toString()))
            .length,
          cssFormatting: formatted[0],
          htmlFormatting: formatted[1],
        };
      } finally {
        scratch?.dispose();
        surface.remove();
        temporary.forEach((model) => model.dispose());
        m.editor.getEditors()[0]?.focus();
      }
    });
    expect(workers.typeErrors).toContain(2322);
    expect(workers.javascriptType).toContain("42");
    expect(workers.jsonErrors).toBeGreaterThan(0);
    expect(workers.cssFormatting).toBe(true);
    expect(workers.htmlFormatting).toBe(true);
    writeFileSync(
      "artifacts/evidence/desktop/language-workers.json",
      JSON.stringify(workers, null, 2) + "\n",
    );
    await browser.execute(() => {
      (
        window as unknown as {
          featureModel: unknown;
          featureMonaco: typeof Monaco;
        }
      ).featureModel = (
        window as unknown as { featureMonaco: typeof Monaco }
      ).featureMonaco.editor
        .getEditors()[0]
        .getModel();
    });
    writeFileSync(
      "artifacts/evidence/desktop/language-highlighting.json",
      JSON.stringify(results, null, 2) + "\n",
    );
  });
  it("updates editor preferences without replacing the view, selection, model or undo history", async () => {
    await browser.execute(() => {
      const win = window as unknown as {
        featureMonaco: typeof Monaco;
        preferenceEditor: Monaco.editor.IStandaloneCodeEditor;
        preferenceOriginal: string;
      };
      const editor =
        win.featureMonaco.editor.getEditors()[0] as Monaco.editor.IStandaloneCodeEditor;
      win.preferenceEditor = editor;
      win.preferenceOriginal = editor.getValue();
      editor.executeEdits("preference-fixture", [
        {
          range: new win.featureMonaco.Range(1, 1, 1, 1),
          text: "// preference fixture\n",
        },
      ]);
      editor.setSelection(new win.featureMonaco.Range(2, 5, 2, 10));
    });
    await $('[aria-label="Settings"]').click();
    const theme = $(".settings-panel select:has(option[value=light])");
    await theme.waitForExist();
    const setTheme = async (value: string) =>
      browser.execute((value) => {
        const select = document.querySelector<HTMLSelectElement>(
          ".settings-panel select:has(option[value=light])",
        )!;
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    await setTheme("light");
    await browser.waitUntil(
      async () => (await $("html").getAttribute("data-theme")) === "light",
    );
    const setFont = async (value: string) =>
      browser.execute((value) => {
        const label = Array.from(
          document.querySelectorAll<HTMLLabelElement>(".settings-panel label"),
        ).find((label) => label.textContent?.trim() === "Editor font size");
        const input = label?.querySelector("input");
        if (!input) throw new Error("Editor font preference missing");
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    await setFont("17");
    await browser.waitUntil(() =>
      browser.execute(() => {
        const win = window as unknown as {
          featureMonaco: typeof Monaco;
          preferenceEditor: Monaco.editor.IStandaloneCodeEditor;
        };
        return (
          win.preferenceEditor.getOption(
            win.featureMonaco.editor.EditorOption.fontSize,
          ) === 17
        );
      }),
    );
    const result = await browser.execute(() => {
      const win = window as unknown as {
        featureMonaco: typeof Monaco;
        preferenceEditor: Monaco.editor.IStandaloneCodeEditor;
        featureModel: Monaco.editor.ITextModel;
      };
      const editor = win.featureMonaco.editor.getEditors()[0];
      return {
        sameView: editor === win.preferenceEditor,
        sameModel: editor.getModel() === win.featureModel,
        selection: editor.getSelection(),
      };
    });
    expect(result.sameView).toBe(true);
    expect(result.sameModel).toBe(true);
    expect(result.selection).toMatchObject({
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 10,
    });
    await setTheme("dark");
    await browser.waitUntil(
      async () => (await $("html").getAttribute("data-theme")) === "dark",
    );
    await setFont("14");
    await browser.waitUntil(() =>
      browser.execute(() => {
        const win = window as unknown as {
          featureMonaco: typeof Monaco;
          preferenceEditor: Monaco.editor.IStandaloneCodeEditor;
        };
        return (
          win.preferenceEditor.getOption(
            win.featureMonaco.editor.EditorOption.fontSize,
          ) === 14
        );
      }),
    );
    await $('[aria-label="Close settings"]').click();
    expect(
      await browser.execute(() => {
        const win = window as unknown as {
          preferenceEditor: Monaco.editor.IStandaloneCodeEditor;
          preferenceOriginal: string;
        };
        win.preferenceEditor.trigger("preference-fixture", "undo", null);
        return win.preferenceEditor.getValue() === win.preferenceOriginal;
      }),
    ).toBe(true);
  });
  it("decodes images, audio and video, seeks real media and reports invalid codecs without editing bytes", async () => {
    await open("preview.svg");
    await $(".media-content img").waitForExist();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const img =
          document.querySelector<HTMLImageElement>(".media-content img");
        return img?.complete && img.naturalWidth === 80;
      }),
    );
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Image zoom"]',
      )!;
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      async () =>
        Number(await $(".image-viewport").getAttribute("data-image-scale")) ===
        2,
    );
    expect(
      await browser.execute(() =>
        Math.round(
          document.querySelector(".media-content img")!.getBoundingClientRect()
            .width,
        ),
      ),
    ).toBe(160);
    const navigation = await browser.execute(() => {
      const viewport = document.querySelector<HTMLElement>(".image-viewport")!,
        img = viewport.querySelector("img")!;
      const rect = viewport.getBoundingClientRect(),
        point = {
          x: Math.round(rect.left + rect.width / 2 + 20),
          y: Math.round(rect.top + rect.height / 2 + 10),
        };
      const before = img.getBoundingClientRect();
      viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -100,
          clientX: point.x,
          clientY: point.y,
        }),
      );
      return {
        point,
        before: {
          left: before.left,
          top: before.top,
          width: before.width,
          height: before.height,
        },
      };
    });
    await browser.waitUntil(
      async () =>
        Number(await $(".image-viewport").getAttribute("data-image-scale")) >
        2.4,
    );
    const measuredZoom = Number(
      await $(".image-viewport").getAttribute("data-image-scale"),
    );
    const anchor = await browser.execute((point) => {
      const r = document
        .querySelector(".image-viewport img")!
        .getBoundingClientRect();
      return {
        x: (point.x - r.left) / r.width,
        y: (point.y - r.top) / r.height,
      };
    }, navigation.point);
    expect(anchor.x).toBeCloseTo(
      (navigation.point.x - navigation.before.left) / navigation.before.width,
      3,
    );
    expect(anchor.y).toBeCloseTo(
      (navigation.point.y - navigation.before.top) / navigation.before.height,
      3,
    );
    const beforePanY = Number(
      await $(".image-viewport").getAttribute("data-image-y"),
    );
    const beforePan = Number(
      await $(".image-viewport").getAttribute("data-image-x"),
    );
    await browser.execute(() => {
      const img = document.querySelector(".image-viewport img")!,
        r = img.getBoundingClientRect();
      img.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 91,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: r.left + 30,
          clientY: r.top + 20,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId: 91,
          isPrimary: true,
          buttons: 1,
          clientX: r.left + 80,
          clientY: r.top + 55,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 91,
          isPrimary: true,
          button: 0,
          buttons: 0,
        }),
      );
    });
    await browser.waitUntil(
      async () =>
        Math.abs(
          Number(await $(".image-viewport").getAttribute("data-image-x")) -
            beforePan -
            50,
        ) < 0.1,
    );
    const measuredPan = {
      x:
        Number(await $(".image-viewport").getAttribute("data-image-x")) -
        beforePan,
      y:
        Number(await $(".image-viewport").getAttribute("data-image-y")) -
        beforePanY,
    };
    expect(measuredPan.y).toBeCloseTo(35, 3);
    expect(await $(".image-viewport").getAttribute("class")).not.toContain(
      "panning",
    );
    expect(await browser.execute(() => window.getSelection()?.toString())).toBe(
      "",
    );
    await browser.execute(() => {
      const img = document.querySelector(".image-viewport img")!;
      img.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          pointerId: 92,
          isPrimary: true,
          button: 0,
          buttons: 1,
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(await $(".image-viewport").getAttribute("class")).not.toContain(
      "panning",
    );
    await browser.execute(() => {
      const s = document.querySelector<HTMLSelectElement>(
        'select[aria-label="Image zoom"]',
      )!;
      s.value = "fit";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await browser.waitUntil(
      async () =>
        Number(await $(".image-viewport").getAttribute("data-image-x")) === 0,
    );
    writeFileSync(
      "artifacts/evidence/desktop/image-navigation.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          profile:
            "native WebKit; untrusted embedded-driver wheel/pointer events; integer client coordinates",
          image: { width: 80, height: 60 },
          zoomBefore: 2,
          zoomAfter: measuredZoom,
          anchorBefore: {
            x:
              (navigation.point.x - navigation.before.left) /
              navigation.before.width,
            y:
              (navigation.point.y - navigation.before.top) /
              navigation.before.height,
          },
          anchorAfter: anchor,
          panDelta: measuredPan,
          fitReset: await browser.execute(() => {
            const v = document.querySelector<HTMLElement>(".image-viewport")!;
            return {
              scale: Number(v.dataset.imageScale),
              x: Number(v.dataset.imageX),
              y: Number(v.dataset.imageY),
              selection: window.getSelection()?.toString(),
            };
          }),
        },
        null,
        2,
      ) + "\n",
    );
    await browser.saveScreenshot(
      "artifacts/evidence/desktop/image-wheel-pan.png",
    );
    await $("button=Open as code").click();
    await $(".editor-surface textarea.inputarea").waitForExist();
    await browser.waitUntil(() =>
      browser.execute(() =>
        (
          window as unknown as { featureMonaco: typeof Monaco }
        ).featureMonaco.editor
          .getEditors()[0]
          .getValue()
          .includes("<svg"),
      ),
    );
    await $('[aria-label="Close preview.svg"]').click();
    await open("preview.png");
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.querySelector<HTMLImageElement>(".media-content img")
            ?.naturalWidth === 8,
      ),
    );
    await open("preview.wav");
    await $(".media-content audio").waitForExist();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const player = document.querySelector("audio");
        return (
          player && Number.isFinite(player.duration) && player.duration > 0
        );
      }),
    );
    const audio = await browser.execute(() => ({
      duration: document.querySelector("audio")!.duration,
      readyState: document.querySelector("audio")!.readyState,
    }));
    await open("preview.mp4");
    await $(".media-content video").waitForExist();
    await browser.waitUntil(() =>
      browser.execute(() => {
        const player = document.querySelector("video");
        return (
          player &&
          player.videoWidth === 64 &&
          Number.isFinite(player.duration) &&
          player.duration > 0
        );
      }),
    );
    const video = await browser.execute(() => {
      const player = document.querySelector("video")!;
      player.currentTime = 0.5;
      return {
        width: player.videoWidth,
        height: player.videoHeight,
        duration: player.duration,
        url: player.currentSrc,
      };
    });
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          Math.abs(document.querySelector("video")!.currentTime - 0.5) < 0.1,
      ),
    );
    expect(video.height).toBe(48);
    await $("button=Reload preview").click();
    await browser.waitUntil(() =>
      browser.execute((previous) => {
        const player = document.querySelector("video");
        return (
          player && player.currentSrc !== previous && player.videoWidth === 64
        );
      }, video.url),
    );
    await open("broken.webm");
    await $('.media-preview [role="alert"]').waitForDisplayed();
    expect(await $('.media-preview [role="alert"]').getText()).toContain(
      "could not be decoded",
    );
    expect(
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "broken.webm"),
        "utf8",
      ),
    ).toBe("invalid media fixture");
    writeFileSync(
      "artifacts/evidence/desktop/media-preview.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          audio,
          video,
          image: { width: 80, height: 60, zoom: true },
          invalidPreserved: true,
          scope:
            "Actual WebView image/audio/video metadata decoding and seek; codec/physical playback matrix still requires native platforms",
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("hides autosave chrome, applies and persists workspace/editor/terminal bindings without recreating editors", async () => {
    await open("App.tsx");
    await $(".editor-surface textarea.inputarea").waitForExist();
    expect(await $('[aria-label="Save file"]').isExisting()).toBe(false);
    await $('[aria-label="Settings"]').click();
    await $('button[role="tab"][data-category="keymap"]').click();
    await $('input[aria-label="Search keyboard shortcuts"]').waitForDisplayed();
    await browser.waitUntil(async () =>
      (await $(".keymap-preferences").getText()).includes("actions"),
    );
    const m = process.platform === "darwin" ? "Meta" : "Ctrl";
    await setBinding("app.save", `${m}+Alt+Shift+F9`);
    await setBinding("monaco:actions.find", `${m}+Alt+Shift+F10`);
    await setBinding("terminal.find", `${m}+Alt+Shift+F11`);
    const persisted = JSON.parse(
      readFileSync(join(process.env.AW_DESKTOP_DATA!, "settings.json"), "utf8"),
    );
    expect(persisted.keybindings["app.save"]).toEqual([`${m}+Alt+Shift+F9`]);
    await $('[aria-label="Close settings"]').click();
    expect(
      await browser.execute(() => {
        const state = window as unknown as {
          featureModel: unknown;
          featureMonaco: typeof Monaco;
        };
        return (
          state.featureModel ===
          state.featureMonaco.editor.getEditors()[0].getModel()
        );
      }),
    ).toBe(true);
    const input = ".editor-surface textarea.inputarea";
    await browser.execute((selector) => {
      const target = document.querySelector<HTMLTextAreaElement>(selector)!;
      target.focus();
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", "// custom save shortcut\n");
      target.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, input);
    await key(input, "F9", "F9", { altKey: true, shiftKey: true });
    await browser.waitUntil(() =>
      readFileSync(
        join(process.env.AW_DESKTOP_PROJECT!, "App.tsx"),
        "utf8",
      ).includes("custom save shortcut"),
    );
    await key(input, "F10", "F10", { altKey: true, shiftKey: true });
    await $(".find-widget.visible").waitForDisplayed();
    await key(
      ".find-widget.visible .monaco-findInput textarea",
      "Escape",
      "Escape",
      { metaKey: false, ctrlKey: false },
    );
    await $('button[aria-label="New terminal"]').click();
    await $(".xterm-helper-textarea").waitForExist();
    await key(".xterm-helper-textarea", "F11", "F11", {
      altKey: true,
      shiftKey: true,
    });
    await $('input[aria-label="Find in terminal"]').waitForDisplayed();
    await key('input[aria-label="Find in terminal"]', "Escape", "Escape", {
      metaKey: false,
      ctrlKey: false,
    });
    await $('[aria-label="Refresh workspace"]').click();
    const changed = $('[data-git-kind="working"][title="App.tsx"]');
    await changed.waitForDisplayed();
    await changed.click();
    await $(".monaco-diff-editor .line-insert").waitForExist();
    const diffLanguages = await browser.execute(() =>
      (
        window as unknown as { featureMonaco: typeof Monaco }
      ).featureMonaco.editor
        .getModels()
        .filter((model) => model.uri.scheme === "inmemory")
        .map((model) => model.getLanguageId()),
    );
    expect(diffLanguages).toEqual(["typescript", "typescript"]);
    writeFileSync(
      "artifacts/evidence/desktop/keymap.json",
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          workspaceSaveWorks: true,
          editorFindWorks: true,
          terminalFindWorks: true,
          persistedOverrides: persisted.keybindings,
          editorInstancePreserved: true,
          autosaveButtonHidden: true,
          diffLanguages,
        },
        null,
        2,
      ) + "\n",
    );
  });
  it("renders raster source pixels sharply at actual size and magnification", async () => {
    if (await $(".recent-projects button").isExisting()) {
      await $(".recent-projects button").click();
      await $(".trust-banner button").waitForDisplayed();
      await $(".trust-banner button").click();
      await $(".dialog-content button.primary").waitForDisplayed();
      await $(".dialog-content button.primary").click();
    }
    await $('.tree-label[title="pixels.png"]').waitForDisplayed();
    await open("pixels.png");
    await browser.waitUntil(() =>
      browser.execute(
        () =>
          document.querySelector<HTMLImageElement>(".image-viewport img")
            ?.naturalWidth === 256,
      ),
    );
    const retina = process.env.AW_DESKTOP_RETINA === "1";
    if (retina) {
      await browser.execute(() => {
        const api = (
          window as unknown as {
            __TAURI__: {
              window: {
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
            const monitors = await api.window.availableMonitors(),
              monitor = monitors.find((m) => m.scaleFactor >= 2);
            if (!monitor) throw new Error("Native Retina monitor unavailable");
            await api.window
              .getCurrentWindow()
              .setPosition(
                new api.window.PhysicalPosition(
                  monitor.position.x + 80,
                  monitor.position.y + 80,
                ),
              );
            document.documentElement.dataset.qualityRetina = "ready";
          } catch (error) {
            document.documentElement.dataset.qualityRetina = String(error);
          }
        })();
      });
      await browser.waitUntil(() =>
        browser.execute(() => {
          const status = document.documentElement.dataset.qualityRetina;
          if (status && status !== "ready") throw new Error(status);
          return (
            status === "ready" &&
            window.devicePixelRatio >= 2 &&
            Number(
              document.querySelector<HTMLElement>(".image-viewport")!.dataset
                .imageDensity,
            ) === window.devicePixelRatio
          );
        }),
      );
    }
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
          document.querySelector<HTMLElement>(".media-preview")!.focus();
          document.documentElement.dataset.qualityFocus = "ready";
        } catch (error) {
          document.documentElement.dataset.qualityFocus = String(error);
        }
      })();
    });
    await browser.waitUntil(() =>
      browser.execute(() => {
        const status = document.documentElement.dataset.qualityFocus;
        if (status && status !== "ready") throw new Error(status);
        return status === "ready" && document.hasFocus();
      }),
    );
    const results = [];
    for (const zoom of [1, 4]) {
      if (zoom === 4) {
        await browser.execute(() => {
          const trigger = document.querySelector<HTMLButtonElement>(
            '[aria-label="Image rendering"]',
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
        await $('[role="menuitemradio"]=Source pixels').waitForDisplayed();
        await $('[role="menuitemradio"]=Source pixels').click();
      }
      await browser.execute((zoom) => {
        if (zoom === 4) {
          for (let i = 0; i < 2; i++)
            window.dispatchEvent(
              new CustomEvent("workspace-command", { detail: "media.zoomIn" }),
            );
        } else {
          const s = document.querySelector<HTMLSelectElement>(
            'select[aria-label="Image zoom"]',
          )!;
          s.value = "1";
          s.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, zoom);
      await browser.waitUntil(
        async () =>
          Number(
            await $(".image-viewport").getAttribute("data-image-scale"),
          ) === zoom,
      );
      const geometry = await browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>(
            ".image-viewport img",
          )!,
          r = image.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          devicePixelRatio: window.devicePixelRatio,
          windowWidth: innerWidth,
          windowHeight: innerHeight,
          visibility: document.visibilityState,
          focused: document.hasFocus(),
          transform: getComputedStyle(image).transform,
          interpolation: getComputedStyle(image).imageRendering,
        };
      });
      const screenshot = `artifacts/evidence/desktop/image-pixels-${retina ? "retina-" : ""}${zoom}00.png`;
      await browser.saveScreenshot(screenshot);
      const png = readPng(readFileSync(screenshot)),
        density = png.width / geometry.windowWidth;
      const start = {
        x: Math.round(geometry.left * density),
        y: Math.round(geometry.top * density),
      };
      let mismatches = 0,
        maximumError = 0;
      // Sample the central source region, including individual pixel edges,
      // which stays inside the viewport even at 400% on ordinary displays.
      for (let y = 60; y < 100; y++)
        for (let x = 108; x < 148; x++)
          for (let dy = 0; dy < zoom; dy++)
            for (let dx = 0; dx < zoom; dx++) {
              const actual = png.pixel(
                  start.x + x * zoom + dx,
                  start.y + y * zoom + dy,
                ),
                expected = (x + y) % 2 ? 255 : 0;
              const error = Math.max(
                ...actual.map((channel) => Math.abs(channel - expected)),
              );
              maximumError = Math.max(maximumError, error);
              if (error > 1) mismatches++;
            }
      results.push({
        zoom,
        ...geometry,
        screenshotDensity: density,
        mismatches,
        maximumError,
      });
      writeFileSync(
        `artifacts/evidence/desktop/image-quality${retina ? "-retina" : ""}.json`,
        JSON.stringify(results, null, 2) + "\n",
      );
      expect(geometry.interpolation).toBe(zoom === 1 ? "auto" : "pixelated");
      expect(geometry.transform).toBe("none");
      expect(geometry.visibility).toBe("visible");
      expect(geometry.focused).toBe(true);
      expect(geometry.width * geometry.devicePixelRatio).toBeCloseTo(
        256 * zoom,
        2,
      );
      expect(geometry.height * geometry.devicePixelRatio).toBeCloseTo(
        160 * zoom,
        2,
      );
      expect(mismatches).toBe(0);
    }
  });
});
