import KeymapPreferences from "./KeymapPreferences";
import { useApp, perform, notice } from "../../shared/state/store";
import { call, rpc } from "../../shared/ipc/client";
import { useState } from "react";
import type { Settings } from "../../generated/protocol";
export default function SettingsPanel() {
  const settings = useApp((s) => s.settings);
  const [category, setCategory] = useState<"general" | "keymap">("general");
  const [output, setOutput] = useState("");
  if (!settings) return <p>Loading native settings…</p>;
  return (
    <section className="settings-panel">
      <div
        className="settings-tabs"
        role="tablist"
        aria-label="Settings categories"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const next = category === "general" ? "keymap" : "general";
          setCategory(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`[data-category="${next}"]`)!
            .focus();
        }}
      >
        <button
          role="tab"
          data-category="general"
          aria-selected={category === "general"}
          tabIndex={category === "general" ? 0 : -1}
          onClick={() => setCategory("general")}
        >
          General
        </button>
        <button
          role="tab"
          data-category="keymap"
          aria-selected={category === "keymap"}
          tabIndex={category === "keymap" ? 0 : -1}
          onClick={() => setCategory("keymap")}
        >
          Keyboard shortcuts
        </button>
      </div>
      {category === "keymap" ? (
        <KeymapPreferences />
      ) : (
        <>
          <h2>Settings and installed tools</h2>
          <p>
            Tool paths must refer to installed absolute executables. This app
            does not download command-line programs.
          </p>
          {(["git"] as const).map((tool) => (
            <div className="tool-setting" key={tool}>
              <strong>{tool}</strong>
              <code>{settings[tool] ?? "Not configured"}</code>
              <button
                onClick={() =>
                  void perform(async () => {
                    const r = await call(
                      { type: "pickExecutable", tool },
                      "bootstrap",
                    );
                    useApp.getState().set({ settings: r.settings });
                  })
                }
              >
                Locate executable
              </button>
              <button
                onClick={() =>
                  void perform(async () => {
                    const r = await call(
                      { type: "checkRuntime", tool },
                      "text",
                    );
                    setOutput(r.text);
                  })
                }
              >
                Check again
              </button>
              <button
                onClick={() =>
                  void perform(() =>
                    rpc({
                      type: "openLink",
                      url: "https://git-scm.com/downloads",
                    }),
                  )
                }
              >
                Official installation guide
              </button>
              <small>Official installation: git-scm.com/downloads</small>
            </div>
          ))}
          <ShellPreferences
            key={settings.shell ?? "default"}
            settings={settings}
          />
          <AutoSavePreferences settings={settings} />
          <label>
            Theme
            <select
              value={settings.theme}
              onChange={(e) =>
                void perform(async () => {
                  const r = await call(
                    {
                      type: "settings",
                      settings: { ...settings, theme: e.target.value },
                    },
                    "bootstrap",
                  );
                  useApp.getState().set({ settings: r.settings });
                })
              }
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            Editor font size
            <input
              type="number"
              min={10}
              max={32}
              value={settings.fontSize}
              onChange={(e) => {
                const size = Number(e.target.value);
                if (size >= 10 && size <= 32)
                  void perform(async () => {
                    const r = await call(
                      {
                        type: "settings",
                        settings: { ...settings, fontSize: size },
                      },
                      "bootstrap",
                    );
                    useApp.getState().set({ settings: r.settings });
                  });
              }}
            />
          </label>
          <div className="toolbar">
            <button
              onClick={() =>
                void perform(async () =>
                  setOutput((await call({ type: "updateCheck" }, "text")).text),
                )
              }
            >
              Check signed updates
            </button>
            <button
              onClick={() =>
                void perform(async () => {
                  const { ask } =
                    await import("../../shared/components/Dialog");
                  if (
                    await ask({
                      title: "Install checked update",
                      description:
                        "Save or discard unsaved files and close terminals first. The signature and version will be verified before installation. " +
                        (navigator.platform.startsWith("Win")
                          ? "Windows will close this app to run the installer. Reopen it yourself when installation finishes."
                          : "Restart explicitly after installation finishes."),
                      choices: ["Install checked update"],
                    })
                  ) {
                    setOutput(
                      navigator.platform.startsWith("Win")
                        ? "Verifying the update. This app closes when the Windows installer starts; reopen it after installation."
                        : "Verifying and installing the update. Keep this application open until installation finishes.",
                    );
                    setOutput(
                      (await call({ type: "updateInstall" }, "text")).text,
                    );
                  }
                })
              }
            >
              Install checked update
            </button>
          </div>
          <div className="toolbar">
            <button
              onClick={() =>
                void perform(async () => {
                  const r = await call({ type: "diagnostics" }, "text");
                  setOutput(r.text);
                })
              }
            >
              Preview diagnostics
            </button>
            <button
              disabled={!output}
              onClick={() =>
                void perform(async () => {
                  await rpc({ type: "clipboardWrite", text: output });
                  notice("Diagnostics copied by explicit request.");
                })
              }
            >
              Copy preview
            </button>
          </div>
          <pre>{output}</pre>
          <p className="muted">
            Release signing, verified updates and other operating-system test
            gates remain tracked in the release checklist. This is an unsigned
            development build.
          </p>
        </>
      )}
    </section>
  );
}

function AutoSavePreferences({ settings }: { settings: Settings }) {
  const [idle, setIdle] = useState(settings.autoSaveIdle);
  const [delay, setDelay] = useState(settings.autoSaveDelay);
  const [focus, setFocus] = useState(settings.autoSaveOnFocusLoss);
  return (
    <fieldset>
      <legend>Autosave</legend>
      <label>
        <input
          type="checkbox"
          aria-label="Save when idle"
          checked={idle}
          onChange={(e) => setIdle(e.target.checked)}
        />
        Save when idle
      </label>
      <label>
        Idle time (seconds)
        <input
          aria-label="Autosave idle seconds"
          type="number"
          min={1}
          max={300}
          value={delay}
          onChange={(e) => setDelay(Number(e.target.value))}
        />
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Save when switching apps or to the terminal"
          checked={focus}
          onChange={(e) => setFocus(e.target.checked)}
        />
        Save when switching apps or to the terminal
      </label>
      <small>
        Also saves before closing files and Git operations. Conflicting and
        recovered edits wait for review.
      </small>
      <button
        disabled={!Number.isInteger(delay) || delay < 1 || delay > 300}
        onClick={() =>
          void perform(async () => {
            const current = useApp.getState().settings;
            if (!current) return;
            const result = await call(
              {
                type: "settings",
                settings: {
                  ...current,
                  autoSaveIdle: idle,
                  autoSaveDelay: delay,
                  autoSaveOnFocusLoss: focus,
                },
              },
              "bootstrap",
            );
            useApp.getState().set({ settings: result.settings });
            notice("Autosave preferences saved.");
          })
        }
      >
        Save autosave preferences
      </button>
    </fieldset>
  );
}

function ShellPreferences({ settings }: { settings: Settings }) {
  const [shell, setShell] = useState(settings.shell ?? "");
  const [args, setArgs] = useState(settings.shellArgs.join("\n"));
  const [font, setFont] = useState(settings.terminalFontSize);
  const [scrollback, setScrollback] = useState(settings.terminalScrollback);
  return (
    <fieldset>
      <legend>Terminal</legend>
      <label>
        Shell executable
        <input
          aria-label="Shell executable"
          value={shell}
          placeholder="System shell"
          onChange={(e) => setShell(e.target.value)}
        />
      </label>
      <label>
        Shell arguments (one per line)
        <textarea
          aria-label="Shell arguments"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </label>
      <label>
        Terminal font size
        <input
          type="number"
          min={10}
          max={32}
          value={font}
          onChange={(e) => setFont(Number(e.target.value))}
        />
      </label>
      <label>
        Scrollback lines
        <input
          type="number"
          min={100}
          max={50000}
          value={scrollback}
          onChange={(e) => setScrollback(Number(e.target.value))}
        />
      </label>
      <p>
        New shells inherit the application's environment. Default macOS sessions
        load login profiles; an explicit shell and arguments override that
        choice. Existing sessions keep running. Terminal output and input
        history are not stored by this app.
      </p>
      <button
        onClick={() =>
          void perform(async () => {
            const r = await call(
              {
                type: "settings",
                settings: {
                  ...settings,
                  shell: shell.trim() || null,
                  shellArgs: args ? args.split("\n") : [],
                  terminalFontSize: font,
                  terminalScrollback: scrollback,
                },
              },
              "bootstrap",
            );
            useApp.getState().set({ settings: r.settings });
            notice(
              "Terminal preferences saved. Shell changes apply to new sessions.",
            );
          })
        }
      >
        Save terminal preferences
      </button>
    </fieldset>
  );
}
