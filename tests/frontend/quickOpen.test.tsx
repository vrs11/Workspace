import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SearchPanel from "../../src/features/search/SearchPanel";
import { useApp } from "../../src/shared/state/store";
const native = vi.hoisted(() => ({
  call: vi.fn(),
  rpc: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../src/shared/ipc/client", () => ({
  call: native.call,
  rpc: native.rpc,
  errorText: (error: Error) => error.message,
}));
vi.mock("../../src/features/editor/models", () => ({
  loadDocument: native.load,
  models: new Map(),
  reconcileDocuments: vi.fn(),
}));
// Search request/selection tests; real virtualization and geometry are covered
// in the packaged native interaction suite.
vi.mock("../../src/shared/components/VirtualList", () => ({
  VirtualList: ({
    items,
    onSelect,
    activeIndex,
  }: {
    items: { entry: string; path: string }[];
    onSelect: (item: { entry: string; path: string }) => void;
    activeIndex: number;
  }) => (
    <div role="listbox" aria-label="Search results">
      {items.map((item, index) => (
        <button
          role="option"
          key={item.entry}
          aria-selected={index === activeIndex}
          onClick={() => onSelect(item)}
        >
          {item.path}
        </button>
      ))}
    </div>
  ),
}));
const matches = [
  { entry: "one", path: "one.ts", line: 1, text: "" },
  { entry: "two", path: "two.ts", line: 1, text: "" },
];
beforeEach(() => {
  vi.useFakeTimers();
  native.call.mockReset();
  native.rpc.mockReset();
  native.load.mockReset();
  native.rpc.mockResolvedValue({ type: "ok" });
  native.load.mockResolvedValue(undefined);
  native.call.mockImplementation(async (request) => ({
    type: "search",
    generation: request.generation,
    matches,
    truncated: false,
  }));
  useApp.setState({
    project: { id: "p", name: "fixture", root: "/fixture", trusted: true },
    busy: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useApp.setState({ project: null, busy: 0 });
});
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(160);
  });
it("searches the selected file text automatically and opens the keyboard-selected result", async () => {
  const opened = vi.fn();
  render(<SearchPanel names initialQuery=".ts" onOpened={opened} />);
  const query = screen.getByRole("combobox");
  expect(query).toHaveValue(".ts");
  expect(native.call).not.toHaveBeenCalled();
  await tick();
  expect(native.call).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "search",
      scope: "p",
      query: ".ts",
      names: true,
      regex: false,
    }),
    "search",
  );
  fireEvent.keyDown(query, { key: "ArrowDown" });
  expect(query).toHaveFocus();
  expect(screen.getByRole("option", { name: "two.ts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.keyDown(query, { key: "Enter" });
  await act(async () => {});
  expect(native.load).toHaveBeenCalledExactlyOnceWith("two");
  expect(opened).toHaveBeenCalledOnce();
});
it("cancels outdated typing and closing searches and ignores their late results", async () => {
  const pending: ((value: unknown) => void)[] = [];
  native.call.mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const view = render(<SearchPanel names initialQuery="old" />);
  await tick();
  const old = native.call.mock.calls[0][0];
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
  expect(native.rpc).toHaveBeenCalledWith({
    type: "cancelSearch",
    scope: "p",
    generation: old.generation,
  });
  await tick();
  const latest = native.call.mock.calls[1][0];
  await act(async () => {
    pending[0]({
      type: "search",
      generation: old.generation,
      matches,
      truncated: false,
    });
  });
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  view.unmount();
  expect(native.rpc).toHaveBeenCalledWith({
    type: "cancelSearch",
    scope: "p",
    generation: latest.generation,
  });
  await act(async () => {
    pending[1]({
      type: "search",
      generation: latest.generation,
      matches,
      truncated: false,
    });
  });
  expect(useApp.getState().busy).toBe(0);
});
it("keeps project content search explicit and reports filename-regex errors inline", async () => {
  const view = render(<SearchPanel />);
  fireEvent.change(screen.getByRole("textbox", { name: "Find in project" }), {
    target: { value: "text" },
  });
  await tick();
  expect(native.call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await act(async () => {});
  expect(native.call).toHaveBeenCalledWith(
    expect.objectContaining({ names: false }),
    "search",
  );
  view.unmount();
  native.call.mockRejectedValue(new Error("Invalid regular expression"));
  render(<SearchPanel names initialQuery="[" />);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Use regular expression" }),
  );
  await tick();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Invalid regular expression",
  );
});

it("does not dismiss a newer picker when an old selected file finishes loading after close", async () => {
  let loaded!: () => void;
  native.load.mockReturnValue(
    new Promise<void>((resolve) => {
      loaded = resolve;
    }),
  );
  const opened = vi.fn();
  const view = render(
    <SearchPanel names initialQuery=".ts" onOpened={opened} />,
  );
  await tick();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(native.load).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => {
    loaded();
  });
  expect(opened).not.toHaveBeenCalled();
});
