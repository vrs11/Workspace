import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DiffEditor from "../../src/features/editor/DiffEditor";
import type { Diff } from "../../src/generated/protocol";
const fake = vi.hoisted(() => ({
  goToDiff: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  updated: (() => {}) as () => void,
  changes: [] as object[],
}));
vi.mock("../../src/features/editor/monaco", () => ({
  monaco: {
    editor: {
      createModel: () => ({ dispose: vi.fn() }),
      createDiffEditor: () => ({
        goToDiff: fake.goToDiff,
        dispose: fake.dispose,
        getOriginalEditor: () => ({ render: vi.fn() }),
        getModifiedEditor: () => ({ render: vi.fn(), focus: fake.focus }),
        getLineChanges: () => fake.changes,
        onDidUpdateDiff: (callback: () => void) => {
          fake.updated = callback;
          return { dispose: vi.fn() };
        },
        setModel: vi.fn(),
      }),
    },
  },
}));
vi.mock("../../src/features/editor/interactions", () => ({
  installEditorInteractions: () => () => {},
}));
vi.mock("../../src/features/editor/languages", () => ({
  languageFor: () => "plaintext",
}));
vi.mock("../../src/features/editor/models", () => ({ loadDocument: vi.fn() }));
const diff: Diff = {
  id: "comparison",
  entry: "file",
  path: "file.txt",
  baseLabel: "Index",
  nextLabel: "Working file",
  base: "old",
  next: "new",
  hunks: [],
  hunkUnavailable: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  fake.updated = () => {};
  fake.changes = [];
});
afterEach(cleanup);
it("enables compact change arrows only after computation and navigates both directions", async () => {
  render(<DiffEditor diff={diff} staged={false} />);
  expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
  await waitFor(() =>
    expect(fake.updated.toString()).not.toBe((() => {}).toString()),
  );
  act(() => {
    fake.changes = [{}, {}];
    fake.updated();
  });
  fireEvent.click(screen.getByRole("button", { name: "Next change" }));
  fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
  expect(fake.goToDiff.mock.calls).toEqual([["next"], ["previous"]]);
  expect(fake.focus).toHaveBeenCalledTimes(2);
});
it("keeps navigation disabled for identical files and scopes commands to the focused comparison", async () => {
  render(<DiffEditor diff={diff} staged={false} />);
  await waitFor(() =>
    expect(fake.updated.toString()).not.toBe((() => {}).toString()),
  );
  act(() => fake.updated());
  expect(
    screen.getByRole("button", { name: "Previous change" }),
  ).toBeDisabled();
  act(() => {
    fake.changes = [{}];
    fake.updated();
  });
  window.dispatchEvent(
    new CustomEvent("workspace-command", {
      detail: "diff.nextChange",
      cancelable: true,
    }),
  );
  expect(fake.goToDiff).not.toHaveBeenCalled();
  screen.getByRole("button", { name: "Next change" }).focus();
  act(() => {
    window.dispatchEvent(
      new CustomEvent("workspace-command", {
        detail: "diff.nextChange",
        cancelable: true,
      }),
    );
  });
  expect(fake.goToDiff).toHaveBeenCalledWith("next");
});
it("disposes and resets navigation when switching inline mode or comparison", async () => {
  const view = render(<DiffEditor diff={diff} staged={false} />);
  await waitFor(() =>
    expect(fake.updated.toString()).not.toBe((() => {}).toString()),
  );
  act(() => {
    fake.changes = [{}];
    fake.updated();
  });
  fireEvent.click(screen.getByRole("button", { name: "Inline" }));
  expect(fake.dispose).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Next change" })).toBeDisabled();
  await act(async () => {});
  act(() => fake.updated());
  expect(screen.getByRole("button", { name: "Next change" })).toBeEnabled();
  view.unmount();
  expect(fake.dispose).toHaveBeenCalledTimes(2);
});
