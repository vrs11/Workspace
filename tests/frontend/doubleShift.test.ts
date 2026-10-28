import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  installShortcutRouter,
  normalizeShortcut,
} from "../../src/shared/keymap";
import { useApp } from "../../src/shared/state/store";

let dispose: () => void;
let commands: string[];
const command = (event: Event) => {
  event.preventDefault();
  commands.push((event as CustomEvent<string>).detail);
};
function key(type: string, key = "Shift", init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, {
    key,
    code: key === "Shift" ? "ShiftLeft" : "KeyA",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.activeElement!.dispatchEvent(event);
  return event;
}
const tap = () => {
  key("keydown");
  key("keyup");
};
beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ settings: null });
  document.body.innerHTML =
    '<div class="monaco-editor"><textarea></textarea></div>';
  document.querySelector("textarea")!.focus();
  commands = [];
  window.addEventListener("workspace-command", command);
  dispose = installShortcutRouter();
});
afterEach(() => {
  dispose();
  window.removeEventListener("workspace-command", command);
  vi.useRealTimers();
  document.body.innerHTML = "";
  useApp.setState({ settings: null });
});
it("opens quick files after two short Shift taps while preserving each initial press", () => {
  expect(normalizeShortcut("shift   shift")).toBe("Shift Shift");
  expect(key("keydown").defaultPrevented).toBe(false);
  key("keyup");
  vi.advanceTimersByTime(120);
  key("keydown");
  expect(key("keyup").defaultPrevented).toBe(true);
  expect(commands).toEqual(["app.quickOpen"]);
  key("keyup");
  expect(commands).toHaveLength(1);
});
it("does not open after holds, repeats, timed-out taps, typing or selection shortcuts", () => {
  key("keydown");
  vi.advanceTimersByTime(500);
  key("keydown", "Shift", { repeat: true });
  key("keyup");
  tap();
  expect(commands).toEqual([]);
  vi.advanceTimersByTime(500);
  tap();
  vi.advanceTimersByTime(500);
  tap();
  expect(commands).toEqual([]);
  key("keydown", "ArrowLeft", { shiftKey: true });
  key("keyup", "ArrowLeft");
  tap();
  expect(commands).toEqual([]);
  key("keydown", "a", { shiftKey: true });
  key("keyup", "a");
  tap();
  expect(commands).toEqual([]);
});
it.each(["pointerdown", "blur", "compositionstart"])(
  "resets on %s and preserves IME/modified Shift",
  (type) => {
    tap();
    window.dispatchEvent(new Event(type, { bubbles: true }));
    tap();
    expect(commands).toEqual([]);
    key("keydown", "Shift", { isComposing: true });
    key("keyup", "Shift", { isComposing: true });
    tap();
    expect(commands).toEqual([]);
    key("keydown", "Shift", { altKey: true });
    key("keyup", "Shift", { altKey: true });
    tap();
    expect(commands).toEqual([]);
  },
);
it("works from terminal selection, yields inside modals and respects live keymap overrides", () => {
  document.body.innerHTML =
    '<div class="terminal-panel"><textarea></textarea></div>';
  document.querySelector("textarea")!.focus();
  tap();
  tap();
  expect(commands).toEqual(["app.quickOpen"]);
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div class="dialog-content" role="dialog"><input></div>',
  );
  document.querySelector("input")!.focus();
  tap();
  tap();
  expect(commands).toHaveLength(1);
  document.querySelector('[role="dialog"]')!.remove();
  document.querySelector("textarea")!.focus();
  useApp.setState({
    settings: {
      keybindings: {
        "app.quickOpen": [],
        "app.commandPalette": ["Shift Shift"],
      },
    } as unknown as NonNullable<ReturnType<typeof useApp.getState>["settings"]>,
  });
  tap();
  tap();
  expect(commands).toEqual(["app.quickOpen", "app.commandPalette"]);
  useApp.setState({
    settings: {
      keybindings: { "app.quickOpen": [], "app.commandPalette": [] },
    } as unknown as NonNullable<ReturnType<typeof useApp.getState>["settings"]>,
  });
  tap();
  tap();
  expect(commands).toHaveLength(2);
});
