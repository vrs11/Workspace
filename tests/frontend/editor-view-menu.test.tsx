import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import type { Settings } from "../../src/generated/protocol";
import { EditorViewMenu } from "../../src/features/editor/EditorViewMenu";
import {
  editorViewOptions,
  installGutterMenu,
  setEditorOption,
} from "../../src/features/editor/viewOptions";
import { useApp } from "../../src/shared/state/store";
import { useDocumentViews } from "../../src/features/editor/documentViewState";
const fake = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../../src/shared/ipc/client", () => ({ call: fake.call }));
const defaults = {
  editorSoftWrap: false,
  editorLineNumbers: true,
  git: "/fixture/git",
} as Settings;
beforeEach(() => {
  useApp.setState({
    settings: defaults,
    project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
    docs: { e: { name: "file.md", path: "file.md" } as never },
  });
  fake.call.mockReset();
  fake.call.mockImplementation(async (request) => ({
    settings: {
      ...useApp.getState().settings,
      ...(request.soft_wrap !== null
        ? { editorSoftWrap: request.soft_wrap }
        : {}),
      ...(request.line_numbers !== null
        ? { editorLineNumbers: request.line_numbers }
        : {}),
    },
  }));
});
afterEach(() => {
  cleanup();
  useApp.setState({ project: null, settings: null, docs: {} });
});
async function open() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Editor view options" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
  await screen.findByRole("menuitemcheckbox", { name: "Soft wrap" });
}
it("uses the same persisted options in the menu, including restoring hidden line numbers", async () => {
  render(<EditorViewMenu entry="e" />);
  await open();
  expect(
    screen.getByRole("menuitemcheckbox", { name: "Show line numbers" }),
  ).toHaveAttribute("aria-checked", "true");
  fireEvent.click(
    screen.getByRole("menuitemcheckbox", { name: "Show line numbers" }),
  );
  await waitFor(() =>
    expect(useApp.getState().settings?.editorLineNumbers).toBe(false),
  );
  expect(editorViewOptions()).toEqual({ wordWrap: "off", lineNumbers: "off" });
  await open();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Soft wrap" }));
  await waitFor(() =>
    expect(useApp.getState().settings?.editorSoftWrap).toBe(true),
  );
  await open();
  fireEvent.click(
    screen.getByRole("menuitemcheckbox", { name: "Show line numbers" }),
  );
  await waitFor(() =>
    expect(editorViewOptions()).toEqual({ wordWrap: "on", lineNumbers: "on" }),
  );
});
it("toggles blame per open document and disables it for restricted or non-file views", async () => {
  const view = render(<EditorViewMenu entry="e" />);
  await open();
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Git blame" }));
  expect(useDocumentViews.getState().blame.e).toBe(true);
  act(() => useApp.setState({ docs: {} }));
  expect(useDocumentViews.getState().blame.e).toBeUndefined();
  view.rerender(<EditorViewMenu />);
  await open();
  expect(
    screen.getByRole("menuitemcheckbox", { name: "Git blame" }),
  ).toHaveAttribute("data-disabled");
});
it("leaves normal text context menus alone and offers no gutter menu when numbers are hidden", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const target = vi.fn(() => ({ type: 3 }));
  const open = vi.fn();
  const editor = {
    getContainerDomNode: () => container,
    getTargetAtClientPoint: target,
  } as unknown as Monaco.editor.IStandaloneCodeEditor;
  const monaco = {
    editor: { MouseTargetType: { GUTTER_LINE_NUMBERS: 3 } },
  } as unknown as typeof Monaco;
  const stop = installGutterMenu(editor, monaco, open);
  const event = () =>
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 8,
      clientY: 30,
    });
  const gutter = event();
  container.dispatchEvent(gutter);
  expect(open).toHaveBeenCalledWith({ x: 8, y: 30 });
  expect(gutter.defaultPrevented).toBe(true);
  target.mockReturnValue({ type: 6 });
  const text = event();
  container.dispatchEvent(text);
  expect(text.defaultPrevented).toBe(false);
  useApp.setState({ settings: { ...defaults, editorLineNumbers: false } });
  target.mockReturnValue({ type: 3 });
  container.dispatchEvent(event());
  expect(open).toHaveBeenCalledOnce();
  stop();
  container.remove();
});
it("serializes partial preference writes and retains acknowledged values on failure", async () => {
  await Promise.all([
    setEditorOption("softWrap", true),
    setEditorOption("lineNumbers", false),
  ]);
  expect(editorViewOptions()).toEqual({ wordWrap: "on", lineNumbers: "off" });
  fake.call.mockRejectedValueOnce(new Error("disk full"));
  await expect(setEditorOption("softWrap", false)).rejects.toThrow("disk full");
  expect(editorViewOptions().wordWrap).toBe("on");
});
