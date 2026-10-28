import { useApp, notice } from "./state/store";
import { doubleShiftGesture } from "./doubleShift";
export type ShortcutScope =
  "Workspace" | "Editor" | "Terminal" | "Explorer" | "Git" | "Media";
export type Shortcut = {
  id: string;
  label: string;
  scope: ShortcutScope;
  defaults: string[];
  when?: string;
};
export const mac = () => /Mac/.test(navigator.platform);
const mod = () => (mac() ? "Meta" : "Ctrl");
const definition = (
  id: string,
  label: string,
  scope: ShortcutScope,
  keys: string[] = [],
): Shortcut => ({ id, label, scope, defaults: keys });
let applicationDefaults: { mac: boolean; rows: Shortcut[] } | undefined;
export function applicationShortcuts(): Shortcut[] {
  const platformMac = mac();
  if (applicationDefaults?.mac === platformMac) return applicationDefaults.rows;
  const m = mod();
  const rows: Shortcut[] = [
    definition("media.playPause", "Play / pause media", "Media", ["Space"]),
    definition("media.seekBack", "Seek media backward", "Media", ["ArrowLeft"]),
    definition("media.seekForward", "Seek media forward", "Media", [
      "ArrowRight",
    ]),
    definition("media.mute", "Mute / unmute media", "Media", ["M"]),
    definition("media.volumeUp", "Increase media volume", "Media", ["ArrowUp"]),
    definition("media.volumeDown", "Decrease media volume", "Media", [
      "ArrowDown",
    ]),
    definition("media.fit", "Fit image", "Media", [`${m}+0`]),
    definition("media.zoomIn", "Zoom image in", "Media", [`${m}+Equal`]),
    definition("media.zoomOut", "Zoom image out", "Media", [`${m}+Minus`]),
    definition(
      "app.locateProject",
      "Locate moved project folder",
      "Workspace",
      [`${m}+Alt+Shift+O`],
    ),
    definition(
      "app.restoreDeleted",
      "Restore deleted file or folder",
      "Workspace",
      [`${m}+Alt+Shift+D`],
    ),
    definition("app.recover", "Recover unsaved files", "Workspace", [
      `${m}+Alt+Shift+R`,
    ]),
    definition("app.openFolder", "Open folder", "Workspace", [`${m}+O`]),
    definition("app.quickOpen", "Quick open", "Workspace", ["Shift Shift"]),
    definition("app.commandPalette", "Command palette", "Workspace", [
      `${m}+Shift+P`,
    ]),
    definition("app.save", "Save file", "Workspace", [`${m}+S`]),
    definition("app.saveAll", "Save all", "Workspace", [`${m}+Shift+S`]),
    definition("app.closeTab", "Close active tab", "Workspace", [`${m}+W`]),
    definition("app.reopenTab", "Reopen closed tab", "Workspace", [
      `${m}+Shift+T`,
    ]),
    definition("app.nextTab", "Next editor tab", "Workspace", ["Ctrl+Tab"]),
    definition("app.previousTab", "Previous editor tab", "Workspace", [
      "Ctrl+Shift+Tab",
    ]),
    definition("app.focusPrimary", "Focus primary editor", "Workspace", [
      `${m}+1`,
    ]),
    definition("app.focusSecondary", "Focus second editor", "Workspace", [
      `${m}+2`,
    ]),
    definition("app.splitEditor", "Toggle second editor", "Workspace", [
      `${m}+Alt+2`,
    ]),
    definition("app.settings", "Settings", "Workspace", [`${m}+Comma`]),
    definition("app.refresh", "Refresh files and Git", "Workspace", [
      `${m}+Alt+Y`,
    ]),
    definition("app.search", "Find in project", "Workspace", [`${m}+Shift+F`]),
    definition("app.explorer", "Show files", "Workspace", [`${m}+Shift+E`]),
    definition("app.git", "Show Git changes", "Workspace", [`${m}+Shift+G`]),
    definition("app.history", "Show Git history", "Workspace", [`${m}+Alt+H`]),
    definition("app.terminal", "Show terminal", "Workspace", [
      `${m}+Backquote`,
    ]),
    definition("app.output", "Show output", "Workspace", [`${m}+Alt+O`]),
    definition("terminal.new", "New terminal", "Terminal", [`${m}+Alt+T`]),
    definition("terminal.closeTab", "Close terminal tab", "Terminal", [
      `${m}+Shift+W`,
    ]),
    definition("terminal.closeSplit", "Close terminal split", "Terminal", [
      `${m}+Alt+W`,
    ]),
    definition("terminal.splitRight", "Split terminal right", "Terminal", [
      `${m}+Alt+R`,
    ]),
    definition("terminal.splitDown", "Split terminal down", "Terminal", [
      `${m}+Alt+D`,
    ]),
    definition(
      "terminal.maximize",
      "Maximize / restore terminal split",
      "Terminal",
      [`${m}+Shift+Enter`],
    ),
    definition("terminal.rename", "Rename terminal tab", "Terminal", [
      `${m}+Alt+N`,
    ]),
    definition("terminal.nextTab", "Next terminal tab", "Terminal", [
      `${m}+Shift+BracketRight`,
    ]),
    definition("terminal.previousTab", "Previous terminal tab", "Terminal", [
      `${m}+Shift+BracketLeft`,
    ]),
    definition("terminal.nextSplit", "Focus next terminal split", "Terminal", [
      `${m}+Alt+ArrowRight`,
    ]),
    definition(
      "terminal.previousSplit",
      "Focus previous terminal split",
      "Terminal",
      [`${m}+Alt+ArrowLeft`],
    ),
    definition("terminal.find", "Find in terminal", "Terminal", [
      mac() ? "Meta+F" : "Ctrl+Shift+F",
    ]),
    definition("terminal.copy", "Copy terminal selection", "Terminal", [
      mac() ? "Meta+C" : "Ctrl+Shift+C",
    ]),
    definition("terminal.paste", "Paste into terminal", "Terminal", [
      mac() ? "Meta+V" : "Ctrl+Shift+V",
    ]),
    definition("terminal.selectAll", "Select all terminal output", "Terminal", [
      `${m}+Shift+A`,
    ]),
    definition("explorer.newFile", "New file", "Explorer", [
      mac() ? "Meta+N" : "Ctrl+N",
    ]),
    definition("explorer.newFolder", "New folder", "Explorer", [
      `${m}+Shift+N`,
    ]),
    definition("explorer.rename", "Rename selected file / folder", "Explorer", [
      "F2",
    ]),
    definition("explorer.move", "Move selected file / folder", "Explorer", [
      "F6",
    ]),
    definition(
      "explorer.delete",
      "Recoverable delete selected file / folder",
      "Explorer",
      [mac() ? "Meta+Backspace" : "Delete"],
    ),
    definition("explorer.refresh", "Refresh explorer", "Explorer", ["F5"]),
    definition("git.refresh", "Refresh Git", "Git", [`${m}+R`]),
    definition("git.fetch", "Fetch", "Git", [`${m}+Alt+F`]),
    definition("git.pull", "Pull (fast-forward only)", "Git", [`${m}+Alt+L`]),
    definition("git.push", "Push", "Git", [`${m}+Shift+K`]),
    definition("git.branches", "Branches", "Git", [`${m}+Alt+B`]),
    definition("git.newBranch", "New branch", "Git", [`${m}+Alt+N`]),
    definition("git.stashes", "Stashes", "Git", [`${m}+Alt+S`]),
    definition("git.saveStash", "Save stash", "Git", [`${m}+Alt+Shift+S`]),
    definition("git.details", "Repository details", "Git", [`${m}+Alt+I`]),
    definition("git.commit", "Commit staged changes", "Git", [`${m}+Enter`]),
    definition(
      "monaco:workspace.selectNextOccurrence",
      "Add selection for next occurrence",
      "Editor",
      [mac() ? "Ctrl+G" : "Alt+J"],
    ),
    definition(
      "monaco:workspace.selectAllOccurrences",
      "Select all occurrences",
      "Editor",
      [mac() ? "Meta+Ctrl+G" : "Ctrl+Alt+Shift+J"],
    ),
    definition(
      "monaco:workspace.deselectLastOccurrence",
      "Deselect last occurrence",
      "Editor",
      [mac() ? "Ctrl+Shift+G" : "Alt+Shift+J"],
    ),
  ];
  applicationDefaults = { mac: platformMac, rows };
  return rows;
}
const aliases: Record<string, string> = {
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  ctrl: "Ctrl",
  control: "Ctrl",
  option: "Alt",
  alt: "Alt",
  shift: "Shift",
  mod: "Mod",
  cmdorctrl: "Mod",
  esc: "Escape",
  escape: "Escape",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  " ": "Space",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  pageup: "PageUp",
  pagedown: "PageDown",
  delete: "Delete",
  backspace: "Backspace",
  tab: "Tab",
  home: "Home",
  end: "End",
  insert: "Insert",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  "'": "Quote",
  ";": "Semicolon",
};
const namedKeys = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Escape",
  "Tab",
  "Enter",
  "Space",
  "Home",
  "End",
  "Insert",
  "Comma",
  "Period",
  "Slash",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Minus",
  "Equal",
  "Backquote",
  "Quote",
  "Semicolon",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PauseBreak",
  "ContextMenu",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
];
for (const name of namedKeys) aliases[name.toLowerCase()] ??= name;
Object.assign(aliases, {
  numpad_add: "NumpadAdd",
  numpad_subtract: "NumpadSubtract",
  numpad_multiply: "NumpadMultiply",
  numpad_divide: "NumpadDivide",
  numpad_decimal: "NumpadDecimal",
});
export function normalizeShortcut(value: string): string {
  if (/^shift\s+shift$/i.test(value.trim())) return "Shift Shift";
  return value
    .trim()
    .split(/\s+/)
    .map((stroke) => {
      const pieces = stroke.split("+");
      if (pieces.some((part) => !part))
        throw new Error(
          "Use named keys such as Equal or Plus, with + between modifiers.",
        );
      const keys = pieces.map(
        (part) =>
          aliases[part.toLowerCase()] ??
          (/^f\d{1,2}$/i.test(part)
            ? part.toUpperCase()
            : part.length === 1
              ? part.toUpperCase()
              : part),
      );
      const modifiers = keys
        .slice(0, -1)
        .map((part) => (part === "Mod" ? mod() : part));
      if (
        modifiers.some(
          (part) => !["Ctrl", "Meta", "Alt", "Shift"].includes(part),
        ) ||
        new Set(modifiers).size !== modifiers.length
      )
        throw new Error(
          "Use Ctrl, Meta, Alt or Shift modifiers followed by a key.",
        );
      const key = keys.at(-1)!;
      if (["Ctrl", "Meta", "Alt", "Shift", "Mod"].includes(key))
        throw new Error("Choose a key after the modifiers.");
      return [
        ...["Ctrl", "Meta", "Alt", "Shift"].filter((part) =>
          modifiers.includes(part),
        ),
        key,
      ].join("+");
    })
    .join(" ");
}
export function shortcutStroke(event: KeyboardEvent): string | null {
  if (
    event.getModifierState?.("AltGraph") ||
    event.isComposing ||
    event.key === "Process" ||
    event.keyCode === 229 ||
    ["Control", "Meta", "Alt", "Shift"].includes(event.key)
  )
    return null;
  let key = event.code.replace(/^Key/, "").replace(/^Digit/, "");
  if (!key || key === "Unidentified")
    key = aliases[event.key.toLowerCase()] ?? event.key;
  return [
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.metaKey ? ["Meta"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key,
  ].join("+");
}
export function bindingsFor(id: string) {
  return (
    useApp.getState().settings?.keybindings?.[id] ??
    applicationShortcuts().find((item) => item.id === id)?.defaults ??
    []
  );
}
const invalidPreferences = new WeakSet<object>();
const normalizedBindings = new WeakMap<object, Map<string, string[]>>();
function safeBindingsFor(id: string) {
  const preferences = useApp.getState().settings?.keybindings;
  const owner = preferences ?? applicationShortcuts();
  let cache = normalizedBindings.get(owner);
  if (!cache) {
    cache = new Map();
    normalizedBindings.set(owner, cache);
  }
  const cached = cache.get(id);
  if (cached) return cached;
  let values: string[];
  try {
    values = bindingsFor(id).map(normalizeShortcut);
  } catch {
    if (preferences && !invalidPreferences.has(preferences)) {
      invalidPreferences.add(preferences);
      queueMicrotask(() =>
        notice(
          "Some keyboard shortcuts are invalid. Review Settings → Keyboard shortcuts or restore defaults. Saved preferences were retained.",
        ),
      );
    }
    values = (
      applicationShortcuts().find((item) => item.id === id)?.defaults ?? []
    ).map(normalizeShortcut);
  }
  cache.set(id, values);
  return values;
}
export function shortcutMatches(event: KeyboardEvent, id: string) {
  const stroke = shortcutStroke(event);
  return (
    stroke !== null && safeBindingsFor(id).some((value) => value === stroke)
  );
}
export function dispatchCommand(id: string) {
  const event = new CustomEvent("workspace-command", {
    detail: id,
    cancelable: true,
  });
  if (window.dispatchEvent(event))
    notice(
      "This action is unavailable in the current view. Open its tool window or select an item first.",
    );
}
export function installShortcutRouter() {
  const doubleShift = doubleShiftGesture();
  let chord = "",
    pendingScope: ShortcutScope | null = null,
    timeout: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    chord = "";
    pendingScope = null;
    clearTimeout(timeout);
    doubleShift.reset();
  };
  const tap = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      event.defaultPrevented ||
      target?.closest(
        '.dialog-content, [role="menu"], [data-keymap-recorder]',
      ) ||
      document.querySelector('.dialog-content[role="dialog"]')
    ) {
      doubleShift.reset();
      return;
    }
    if (!doubleShift.accept(event)) return;
    const item = applicationShortcuts().find(
      (item) =>
        item.scope === "Workspace" &&
        safeBindingsFor(item.id).includes("Shift Shift"),
    );
    if (item) {
      event.preventDefault();
      event.stopImmediatePropagation();
      reset();
      dispatchCommand(item.id);
    }
  };
  const handler = (event: KeyboardEvent) => {
    const stroke = shortcutStroke(event);
    if (!stroke) {
      if (
        event.isComposing ||
        event.key === "Process" ||
        event.keyCode === 229 ||
        event.getModifierState?.("AltGraph")
      )
        reset();
      return;
    }
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('.dialog-content, [role="menu"], [data-keymap-recorder]')
    ) {
      reset();
      return;
    }
    const scope: ShortcutScope = target?.closest(
      ".terminal-panel, .terminal-header",
    )
      ? "Terminal"
      : target?.closest(".explorer")
        ? "Explorer"
        : target?.closest(".git-panel")
          ? "Git"
          : target?.closest(".media-preview")
            ? "Media"
            : target?.closest(".monaco-editor")
              ? "Editor"
              : "Workspace";
    // Workspace keys deliberately yield to ordinary PTY input. Only explicit
    // terminal mappings are consumed there; Ctrl+C/D/Z remain programs' keys.
    if (
      scope === "Media" &&
      target?.closest("input, textarea, select, button") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    )
      return;
    const candidates = applicationShortcuts().filter(
      (item) =>
        !item.id.startsWith("monaco:") &&
        (item.scope === scope ||
          (item.scope === "Workspace" && scope !== "Terminal")),
    );
    if (pendingScope && pendingScope !== scope) reset();
    const sequence = chord ? `${chord} ${stroke}` : stroke;
    const item = candidates.find((item) =>
      safeBindingsFor(item.id).some((key) => key === sequence),
    );
    const prefix = candidates.some((item) =>
      safeBindingsFor(item.id).some((key) => key.startsWith(sequence + " ")),
    );
    if (item || prefix) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (item) {
        reset();
        dispatchCommand(item.id);
      } else {
        chord = sequence;
        pendingScope = scope;
        clearTimeout(timeout);
        timeout = setTimeout(reset, 1500);
      }
    } else reset();
  };
  window.addEventListener("keydown", tap, true);
  window.addEventListener("keyup", tap, true);
  window.addEventListener("keydown", handler, true);
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("compositionstart", reset, true);
  window.addEventListener("blur", reset);
  return () => {
    reset();
    window.removeEventListener("keydown", handler, true);
    window.removeEventListener("keydown", tap, true);
    window.removeEventListener("keyup", tap, true);
    window.removeEventListener("pointerdown", reset, true);
    window.removeEventListener("compositionstart", reset, true);
    window.removeEventListener("blur", reset);
  };
}

export function shortcutLabel(id: string) {
  const label =
    bindingsFor(id).join("; ").replaceAll("Shift Shift", "Double Shift") ||
    "Unassigned";
  return mac()
    ? label
        .replaceAll("Ctrl+", "⌃")
        .replaceAll("Meta+", "⌘")
        .replaceAll("Alt+", "⌥")
        .replaceAll("Shift+", "⇧")
    : label;
}
