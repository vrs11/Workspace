import { afterEach, expect, it, vi } from "vitest";
import { useApp } from "../../src/shared/state/store";
import {
  applicationShortcuts,
  normalizeShortcut,
  shortcutStroke,
  installShortcutRouter,
  shortcutLabel,
} from "../../src/shared/keymap";
afterEach(() => {
  useApp.setState({ settings: null });
  document.body.innerHTML = "";
});
it("normalizes chords and platform modifiers without mixing text and physical keys", () => {
  expect(normalizeShortcut("ctrl+shift+= ctrl+c")).toBe(
    "Ctrl+Shift+Equal Ctrl+C",
  );
  expect(
    shortcutStroke(
      new KeyboardEvent("keydown", {
        key: "!",
        code: "Digit1",
        shiftKey: true,
      }),
    ),
  ).toBe("Shift+1");
  expect(
    shortcutStroke(
      new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        isComposing: true,
      }),
    ),
  ).toBeNull();
  expect(() => normalizeShortcut("Ctrl+Ctrl+X")).toThrow();
});
it("routes configured chords, ignores IME and preserves ordinary terminal Ctrl+C/D/Z", () => {
  useApp.setState({
    settings: {
      keybindings: {
        "app.quickOpen": ["Ctrl+K Ctrl+P"],
        "terminal.find": ["Ctrl+Alt+F"],
      },
    } as unknown as NonNullable<ReturnType<typeof useApp.getState>["settings"]>,
  });
  document.body.innerHTML =
    '<div class="terminal-panel"><textarea></textarea></div><input id="workspace">';
  const commands: string[] = [];
  const callback = (event: Event) => {
    event.preventDefault();
    commands.push((event as CustomEvent<string>).detail);
  };
  window.addEventListener("workspace-command", callback);
  const dispose = installShortcutRouter();
  const key = (
    target: Element,
    code: string,
    modifiers: KeyboardEventInit = {},
  ) => {
    const e = new KeyboardEvent("keydown", {
      code,
      key: code.replace("Key", ""),
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const terminal = document.querySelector("textarea")!;
  for (const code of ["KeyC", "KeyD", "KeyZ", "KeyP"])
    expect(key(terminal, code, { ctrlKey: true })).toBe(false);
  expect(key(terminal, "KeyF", { ctrlKey: true, altKey: true })).toBe(true);
  const target = document.querySelector("input")!;
  expect(key(target, "KeyK", { ctrlKey: true, isComposing: true })).toBe(false);
  expect(key(target, "KeyK", { ctrlKey: true })).toBe(true);
  expect(key(target, "KeyP", { ctrlKey: true })).toBe(true);
  expect(key(target, "KeyK", { ctrlKey: true })).toBe(true);
  expect(key(target, "KeyX", { ctrlKey: true, isComposing: true })).toBe(false);
  expect(key(target, "KeyP", { ctrlKey: true })).toBe(false);
  expect(commands).toEqual(["terminal.find", "app.quickOpen"]);
  dispose();
  window.removeEventListener("workspace-command", callback);
});
it("publishes unique command IDs and keeps platform defaults populated", () => {
  const rows = applicationShortcuts();
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  expect(rows.every((row) => row.defaults.length > 0)).toBe(true);
  const spy = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  expect(
    applicationShortcuts().find((row) => row.id === "app.save")!.defaults,
  ).toEqual(["Meta+S"]);
  spy.mockRestore();
});
it.each(["MacIntel", "Linux x86_64"])(
  "routes New Window from the media view and preserves terminal Rename on %s",
  (platform) => {
    const spy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue(platform);
    document.body.innerHTML =
      '<div class="media-preview" tabindex="0"></div><div class="terminal-panel"><textarea></textarea></div>';
    const commands: string[] = [];
    const callback = (event: Event) => {
      event.preventDefault();
      commands.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("workspace-command", callback);
    const dispose = installShortcutRouter();
    try {
      const press = (target: Element, shiftKey: boolean) => {
        const event = new KeyboardEvent("keydown", {
          key: "n",
          code: "KeyN",
          metaKey: platform === "MacIntel",
          ctrlKey: platform !== "MacIntel",
          altKey: true,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      };
      press(document.querySelector(".media-preview")!, true);
      press(document.querySelector("textarea")!, false);
      expect(commands).toEqual(["app.newWindow", "terminal.rename"]);
    } finally {
      dispose();
      window.removeEventListener("workspace-command", callback);
      spy.mockRestore();
    }
  },
);
it.each(["MacIntel", "Linux x86_64"])(
  "keeps only Double Shift for Quick open on %s and releases the old shortcut",
  (platform) => {
    const spy = vi
      .spyOn(navigator, "platform", "get")
      .mockReturnValue(platform);
    const commands: string[] = [];
    const callback = (event: Event) => {
      event.preventDefault();
      commands.push((event as CustomEvent<string>).detail);
    };
    window.addEventListener("workspace-command", callback);
    const dispose = installShortcutRouter();
    try {
      expect(
        applicationShortcuts().find((row) => row.id === "app.quickOpen")!
          .defaults,
      ).toEqual(["Shift Shift"]);
      expect(shortcutLabel("app.quickOpen")).toBe("Double Shift");
      const press = (shiftKey: boolean) => {
        const event = new KeyboardEvent("keydown", {
          key: "p",
          code: "KeyP",
          metaKey: platform === "MacIntel",
          ctrlKey: platform !== "MacIntel",
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(press(false)).toBe(false);
      expect(commands).toEqual([]);
      expect(press(true)).toBe(true);
      expect(commands).toEqual(["app.commandPalette"]);
    } finally {
      dispose();
      window.removeEventListener("workspace-command", callback);
      spy.mockRestore();
    }
  },
);
