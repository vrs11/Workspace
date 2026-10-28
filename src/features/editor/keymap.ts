import type * as Monaco from "monaco-editor";
import { KeybindingsRegistry } from "monaco-editor/platform/keybinding/common/keybindingsRegistry.js";
import { IKeybindingService } from "monaco-editor/platform/keybinding/common/keybinding.js";
import { EditorExtensionsRegistry } from "monaco-editor/editor/browser/editorExtensions.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { useApp, reportError } from "../../shared/state/store";
import {
  bindingsFor,
  applicationShortcuts,
  normalizeShortcut,
  mac,
  type Shortcut,
} from "../../shared/keymap";

export function encodeShortcut(monaco: typeof Monaco, binding: string): number {
  const strokes = normalizeShortcut(binding).split(" ");
  if (strokes.length > 2)
    throw new Error("A shortcut can have one key stroke or a two-step chord.");
  const encode = (stroke: string) => {
    const parts = stroke.split("+"),
      name = parts.at(-1)!;
    const special: Record<string, string> = {
      ArrowUp: "UpArrow",
      ArrowDown: "DownArrow",
      ArrowLeft: "LeftArrow",
      ArrowRight: "RightArrow",
      Backquote: "Backquote",
      Plus: "Equal",
      NumpadAdd: "NumpadAdd",
      NumpadSubtract: "NumpadSubtract",
      NumpadMultiply: "NumpadMultiply",
      NumpadDivide: "NumpadDivide",
    };
    const enumName = /^[A-Z]$/.test(name)
      ? `Key${name}`
      : /^\d$/.test(name)
        ? `Digit${name}`
        : (special[name] ?? name);
    const code = (monaco.KeyCode as unknown as Record<string, number>)[
      enumName
    ];
    if (typeof code !== "number" || code <= 0)
      throw new Error(`Unknown key: ${name}`);
    return (
      code |
      (parts.includes("Ctrl")
        ? mac()
          ? monaco.KeyMod.WinCtrl
          : monaco.KeyMod.CtrlCmd
        : 0) |
      (parts.includes("Meta")
        ? mac()
          ? monaco.KeyMod.CtrlCmd
          : monaco.KeyMod.WinCtrl
        : 0) |
      (parts.includes("Alt") ? monaco.KeyMod.Alt : 0) |
      (parts.includes("Shift") ? monaco.KeyMod.Shift : 0)
    );
  };
  return strokes.length === 2
    ? monaco.KeyMod.chord(encode(strokes[0]), encode(strokes[1]))
    : encode(strokes[0]);
}
export function actionBindings(monaco: typeof Monaco, id: string): number[] {
  try {
    return bindingsFor(id).map((key) => encodeShortcut(monaco, key));
  } catch (error) {
    reportError(error, { prefix: "Invalid editor shortcut; using defaults. " });
    return (
      applicationShortcuts().find((row) => row.id === id)?.defaults ?? []
    ).map((key) => encodeShortcut(monaco, key));
  }
}
let defaultRows: Shortcut[] | undefined;
export function editorShortcuts(): Shortcut[] {
  if (defaultRows) return defaultRows;
  const service = StandaloneServices.get<{
    getKeybindings(): {
      command: string | null;
      resolvedKeybinding?: { getUserSettingsLabel(): string | null };
      when?: { serialize(): string };
    }[];
  }>(IKeybindingService);
  const actions = EditorExtensionsRegistry.getEditorActions();
  const rows = new Map<string, Shortcut>();
  for (const action of actions)
    rows.set(action.id, {
      id: `monaco:${action.id}`,
      label: action.label,
      scope: "Editor",
      defaults: [],
      when: action.precondition?.serialize(),
    });
  for (const item of service.getKeybindings()) {
    if (!item.command) continue;
    const row = rows.get(item.command) ?? {
      id: `monaco:${item.command}`,
      label: item.command
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[._]/g, " "),
      scope: "Editor" as const,
      defaults: [],
    };
    const label = item.resolvedKeybinding?.getUserSettingsLabel();
    if (label) {
      const key = normalizeShortcut(label);
      if (!row.defaults.includes(key)) row.defaults.push(key);
    }
    row.when ??= item.when?.serialize();
    rows.set(item.command, row);
  }
  defaultRows = [...rows.values()];
  return defaultRows;
}
export function installEditorKeymap(monaco: typeof Monaco) {
  let active: Monaco.IDisposable | undefined;
  const update = () => {
    active?.dispose();
    const rows = editorShortcuts();
    const rules: Monaco.editor.IKeybindingRule[] = [];
    for (const [id, keys] of Object.entries(
      useApp.getState().settings?.keybindings ?? {},
    )) {
      if (!id.startsWith("monaco:") || id.startsWith("monaco:workspace."))
        continue;
      const command = id.slice(7),
        row = rows.find((row) => row.id === id);
      if (!row) continue;
      let encoded: number[];
      try {
        encoded = (keys ?? []).map((key) => encodeShortcut(monaco, key));
      } catch (error) {
        reportError(error, {
          prefix: `Invalid shortcut for ${command}; using defaults. `,
        });
        continue;
      }
      rules.push({ keybinding: 0, command: `-${command}` });
      const defaults = KeybindingsRegistry.getDefaultKeybindings().filter(
        (item) => item.command === command,
      );
      for (const keybinding of encoded) {
        if (defaults.length) {
          for (const item of defaults)
            rules.push({
              keybinding,
              command,
              when: item.when?.serialize() ?? "editorTextFocus",
              commandArgs: item.commandArgs,
            });
        } else
          rules.push({
            keybinding,
            command,
            when: row.when
              ? `editorTextFocus && (${row.when})`
              : "editorTextFocus",
          });
      }
    }
    active = monaco.editor.addKeybindingRules(rules);
  };
  update();
  const unsubscribe = useApp.subscribe((next, before) => {
    if (next.settings?.keybindings !== before.settings?.keybindings) update();
  });
  return () => {
    active?.dispose();
    unsubscribe();
  };
}
export function shortcutCatalog(): Shortcut[] {
  const application = applicationShortcuts();
  const ids = new Set(application.map((row) => row.id));
  return [
    ...application,
    ...editorShortcuts().filter((row) => !ids.has(row.id)),
  ].sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label),
  );
}
