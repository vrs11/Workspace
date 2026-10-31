import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApp, type DocMeta } from "../../src/shared/state/store";
import { saveDocument } from "../../src/features/editor/models";
import {
  installAutoSave,
  flushAutoSave,
  flushConfiguredAutoSave,
} from "../../src/features/editor/autosave";
vi.mock("../../src/features/editor/models", () => ({ saveDocument: vi.fn() }));
let cleanup: () => void;
const doc: DocMeta = {
  id: "a",
  entry: "a",
  name: "a.ts",
  path: "a.ts",
  baseline: "base",
  encoding: "utf8",
  eol: "lf",
  readonly: null,
  metadata: null,
  size: 3,
  revision: 1,
  dirty: true,
  recovering: false,
  acknowledged: 0,
  conflict: false,
  recoveryError: null,
  saveError: null,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(saveDocument).mockReset();
  vi.mocked(saveDocument).mockImplementation(async (id) => {
    useApp.getState().doc(id, { dirty: false, saveError: null });
  });
  useApp.setState({
    project: {
      id: "p",
      root: "/fixture",
      name: "fixture",
      trusted: true,
    },
    settings: {
      version: 2,
      keybindings: {},
      git: null,
      theme: "dark",
      fontSize: 14,
      recent: [],
      shell: null,
      shellArgs: [],
      terminalFontSize: 13,
      terminalScrollback: 5000,
      autoSaveIdle: true,
      autoSaveDelay: 15,
      autoSaveOnFocusLoss: true,
    },
    docs: { a: { ...doc } },
    busy: 0,
    notice: "",
  });
  cleanup = installAutoSave();
});
afterEach(async () => {
  await flushAutoSave();
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});
it("saves after idle time, resets on activity, and saves when entering the terminal", async () => {
  await vi.advanceTimersByTimeAsync(14000);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "x", bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(14000);
  expect(saveDocument).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(saveDocument).toHaveBeenCalledExactlyOnceWith("a", true);
  useApp.getState().doc("a", { dirty: true, revision: 2 });
  const pane = document.createElement("section");
  pane.dataset.dockPanel = "terminal";
  const input = document.createElement("textarea");
  pane.append(input);
  document.body.append(pane);
  input.focus();
  await flushAutoSave();
  expect(saveDocument).toHaveBeenCalledTimes(2);
});
it.each([
  [false, false, false],
  [true, false, true],
  [false, true, true],
])(
  "lifecycle flushing respects idle=%s and focus=%s autosave settings",
  async (autoSaveIdle, autoSaveOnFocusLoss, saves) => {
    useApp.getState().set({
      busy: 1,
      settings: {
        ...useApp.getState().settings!,
        autoSaveIdle,
        autoSaveOnFocusLoss,
      },
    });
    await flushConfiguredAutoSave();
    expect(saveDocument).toHaveBeenCalledTimes(saves ? 1 : 0);
    expect(useApp.getState().docs.a.dirty).toBe(!saves);
  },
);
it("does not repeatedly retry an automatic write failure and keeps the error visible", async () => {
  vi.mocked(saveDocument).mockImplementation(async (id) => {
    useApp.getState().doc(id, { saveError: "Disk full" });
    throw new Error("Disk full");
  });
  window.dispatchEvent(new Event("blur"));
  await flushAutoSave();
  window.dispatchEvent(new Event("blur"));
  await flushAutoSave();
  await vi.advanceTimersByTimeAsync(30000);
  expect(saveDocument).toHaveBeenCalledTimes(1);
  expect(useApp.getState().docs.a.dirty).toBe(true);
  expect(useApp.getState().docs.a.saveError).toBe("Disk full");
  useApp.getState().doc("a", { revision: 2 });
  await flushAutoSave();
  expect(saveDocument).toHaveBeenCalledTimes(2);
});
it("leaves restricted, conflicting and recovered buffers for explicit review", async () => {
  useApp.getState().doc("a", { conflict: true });
  await flushAutoSave(true);
  useApp.getState().doc("a", { conflict: false, recovering: true });
  await flushAutoSave(true);
  useApp.getState().doc("a", { recovering: false, readonly: "Read-only" });
  await flushAutoSave(true);
  useApp.getState().doc("a", { readonly: null });
  useApp
    .getState()
    .set({ project: { ...useApp.getState().project!, trusted: false } });
  await flushAutoSave(true);
  expect(saveDocument).not.toHaveBeenCalled();
});
it("defers a focus save through a busy native operation even when idle saving is disabled", async () => {
  useApp.getState().set({
    busy: 1,
    settings: { ...useApp.getState().settings!, autoSaveIdle: false },
  });
  window.dispatchEvent(new Event("blur"));
  expect(saveDocument).not.toHaveBeenCalled();
  useApp.getState().set({ busy: 0 });
  await vi.advanceTimersByTimeAsync(0);
  await flushAutoSave();
  expect(saveDocument).toHaveBeenCalledExactlyOnceWith("a", true);
});

it("ignores Monaco's hidden nonmodal find dialog when saving", async () => {
  const find = document.createElement("div");
  find.setAttribute("role", "dialog");
  find.setAttribute("aria-hidden", "true");
  document.body.append(find);
  await flushAutoSave();
  expect(saveDocument).toHaveBeenCalledExactlyOnceWith("a", true);
});
