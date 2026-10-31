import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApp } from "../../src/shared/state/store";
import {
  clearEditorFileFocus,
  rememberEditorFile,
} from "../../src/shared/fileTargets";
import {
  installEditorCommands,
  runEditorCommand,
} from "../../src/features/editor/editorCommands";
import {
  setBlame,
  useDocumentViews,
} from "../../src/features/editor/documentViewState";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn() }));
beforeEach(() => {
  useApp.setState({
    project: { id: "p", name: "fixture", root: "/fixture", trusted: true },
    settings: { git: "/fixture/git" } as never,
    tabs: [
      { id: "a", kind: "editor", entry: "a", title: "first.md" },
      { id: "b", kind: "editor", entry: "b", title: "second.csv" },
    ],
    active: "a",
    split: "b",
    docs: {
      a: { name: "first.md" } as never,
      b: { name: "second.csv" } as never,
    },
  });
});
afterEach(() => {
  clearEditorFileFocus();
  document.body.innerHTML = "";
  useApp.setState({
    project: null,
    settings: null,
    docs: {},
    tabs: [],
    active: null,
    split: null,
  });
});
it("routes native/palette actions to the focused split and keeps modes independent per file", async () => {
  rememberEditorFile("b");
  await runEditorCommand("preview.rendered");
  expect(useDocumentViews.getState().modes).toEqual({ b: "rendered" });
  clearEditorFileFocus();
  await runEditorCommand("editor.blame");
  expect(useDocumentViews.getState().blame).toEqual({ a: true });
  await runEditorCommand("preview.split");
  expect(useDocumentViews.getState().modes.a).toBe("split");
  await runEditorCommand("preview.invalid");
  expect(useDocumentViews.getState().modes.a).toBe("split");
});
it("can hide annotations after trust revocation and does not trigger actions behind a modal", async () => {
  setBlame("a", true);
  useApp.setState({
    project: { ...useApp.getState().project!, trusted: false },
  });
  await runEditorCommand("editor.blame");
  expect(useDocumentViews.getState().blame.a).toBe(false);
  const stop = installEditorCommands();
  document.body.innerHTML = '<div class="dialog-content" role="dialog"></div>';
  const event = new CustomEvent("workspace-command", {
    detail: "preview.rendered",
    cancelable: true,
  });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(useDocumentViews.getState().modes.a).toBeUndefined();
  stop();
});
