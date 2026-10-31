import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { useApp } from "../../src/shared/state/store";
import BlameGutter from "../../src/features/editor/BlameGutter";
const fake = vi.hoisted(() => ({
  call: vi.fn(),
  change: () => {},
  scroll: () => {},
  version: 1,
}));
vi.mock("../../src/features/editor/monaco", () => ({
  monaco: { editor: { EditorOption: { lineHeight: 67 } } },
}));
vi.mock("../../src/shared/ipc/client", () => ({
  call: fake.call,
  rpc: vi.fn(),
  errorText: (error: Error) => error.message,
}));
const blame = {
  entry: "e",
  commits: [
    {
      id: "a".repeat(40),
      author: "Example Author",
      email: "example@example.invalid",
      timestamp: 100,
      summary: "Introduced line",
    },
  ],
  lines: Array.from({ length: 10000 }, (_, i) => ({
    line: i + 1,
    originalLine: i + 1,
    commit: 0,
  })),
};
function fixture() {
  const model = {
    getVersionId: () => fake.version,
    getValueLength: () => 12,
    getLineCount: () => 10000,
    getValue: () => "current text",
    onDidChangeContent: (callback: () => void) => {
      fake.change = callback;
      return { dispose: vi.fn() };
    },
  };
  return {
    getModel: () => model,
    getLayoutInfo: () => ({ height: 100 }),
    getVisibleRanges: () => [{ startLineNumber: 20, endLineNumber: 25 }],
    getScrollTop: () => 380,
    getTopForLineNumber: (line: number) => (line - 1) * 20,
    getBottomForLineNumber: (line: number) => line * 20,
    getOption: () => 20,
    onDidScrollChange: (callback: () => void) => {
      fake.scroll = callback;
      return { dispose: vi.fn() };
    },
    onDidLayoutChange: () => ({ dispose: vi.fn() }),
    onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
  } as unknown as editor.IStandaloneCodeEditor;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.version = 1;
  fake.call.mockResolvedValue({ blame });
  useApp.setState({
    project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
    settings: { git: "/fixture/git", fontSize: 14 } as never,
  });
});
afterEach(() => {
  cleanup();
  useApp.setState({ project: null, settings: null });
});
it("annotates only visible rows and scrolls without requesting blame again", async () => {
  const view = render(<BlameGutter entry="e" editor={fixture()} />);
  await screen.findByRole("button", {
    name: "Line 20: Example Author, Introduced line",
  });
  expect(view.container.querySelectorAll(".blame-line")).toHaveLength(6);
  expect(
    view.container.querySelector<HTMLButtonElement>(".blame-line")?.style.top,
  ).toBe("0px");
  act(() => fake.scroll());
  await act(async () => {});
  expect(fake.call).toHaveBeenCalledOnce();
});
it("removes stale attribution while edits are pending and ignores the old reply", async () => {
  let resolve: (value: object) => void = () => {};
  fake.call.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<BlameGutter entry="e" editor={fixture()} />);
  act(() => {
    fake.version = 2;
    fake.change();
  });
  await act(async () => resolve({ blame }));
  expect(view.container.querySelector(".blame-line")).toBeNull();
  await waitFor(() => expect(fake.call).toHaveBeenCalledTimes(2));
  await screen.findByRole("button", {
    name: "Line 20: Example Author, Introduced line",
  });
});
it("does not publish annotations after the project or trust changes", async () => {
  let resolve: (value: object) => void = () => {};
  fake.call.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<BlameGutter entry="e" editor={fixture()} />);
  act(() =>
    useApp.setState({
      project: { id: "q", root: "/elsewhere", name: "other", trusted: false },
    }),
  );
  await act(async () => resolve({ blame }));
  expect(view.container.querySelector(".blame-line")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Trust this project");
  expect(fake.call).toHaveBeenCalledOnce();
});
