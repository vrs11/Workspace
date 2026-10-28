import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useApp, type Tab } from "../../src/shared/state/store";
import { closeDocument } from "../../src/features/editor/models";
import {
  tabCloseTargets,
  closeTabGroup,
  createTabCloser,
} from "../../src/features/editor/tabActions";
vi.mock("../../src/features/editor/models", () => ({ closeDocument: vi.fn() }));
const project = { id: "p", root: "/fixture", name: "fixture", trusted: true };
const tab = (id: string): Tab => ({ id, entry: id, kind: "editor", title: id });
const tabs = [tab("a"), tab("b"), tab("c")];
beforeEach(() => {
  useApp.setState({ project, tabs, active: "b", docs: {}, split: null });
  vi.mocked(closeDocument).mockReset();
  vi.mocked(closeDocument).mockResolvedValue(true);
});
afterEach(() =>
  useApp.setState({
    project: null,
    tabs: [],
    active: null,
    docs: {},
    split: null,
  }),
);
it("targets tab order relative to the context-clicked tab, not the active tab", () => {
  expect(tabCloseTargets(tabs, "b", "left")).toEqual(["a"]);
  expect(tabCloseTargets(tabs, "b", "right")).toEqual(["c"]);
  expect(tabCloseTargets(tabs, "b", "rest")).toEqual(["a", "c"]);
  expect(tabCloseTargets(tabs, "b", "close")).toEqual(["b"]);
  expect(tabCloseTargets(tabs, "a", "left")).toEqual([]);
  expect(tabCloseTargets(tabs, "c", "right")).toEqual([]);
  expect(tabCloseTargets(tabs, "missing", "rest")).toEqual([]);
});
it("stops a bulk close on Cancel, restores the canceled tab and retains remaining buffers", async () => {
  const closer = vi.fn(async (id: string) => {
    if (id === "b") return false;
    useApp.setState((s) => ({ tabs: s.tabs.filter((tab) => tab.id !== id) }));
    return true;
  });
  expect(await closeTabGroup("c", "left", closer)).toBe(false);
  expect(closer.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
  expect(useApp.getState().active).toBe("b");
});
it("captures targets before closing so newly opened tabs are preserved", async () => {
  let finish!: () => void;
  const first = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const closer = vi.fn(async (id: string) => {
    if (id === "b") await first;
    useApp.setState((s) => ({ tabs: s.tabs.filter((tab) => tab.id !== id) }));
    return true;
  });
  const operation = closeTabGroup("a", "rest", closer);
  useApp.setState((s) => ({ tabs: [...s.tabs, tab("new")] }));
  finish();
  expect(await operation).toBe(true);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["a", "new"]);
});
it("does not continue a bulk close in another project", async () => {
  const closer = vi.fn(async () => {
    useApp.setState({
      project: { ...project, id: "other" },
      tabs: [tab("b"), tab("c")],
      active: "c",
    });
    return true;
  });
  expect(await closeTabGroup("a", "rest", closer)).toBe(false);
  expect(closer).toHaveBeenCalledTimes(1);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["b", "c"]);
});
it("serializes concurrent view closes and closes a shared model only after its last editable view", async () => {
  const diff = {
    id: "snapshot",
    entry: "a",
    path: "a",
    base: "",
    next: "",
    baseLabel: "base",
    nextLabel: "working",
    hunks: [],
    hunkUnavailable: null,
  };
  useApp.setState({
    tabs: [
      tab("a"),
      { id: "conflict:a", kind: "conflict", diff, title: "Conflict" },
    ],
    active: "conflict:a",
    split: "a",
  });
  const history = vi.fn(),
    close = createTabCloser(history);
  expect(await close("a")).toBe(true);
  expect(closeDocument).not.toHaveBeenCalled();
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["conflict:a"]);
  expect(useApp.getState().split).toBeNull();
  await Promise.all([close("conflict:a"), close("conflict:a")]);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith("a");
  expect(history).toHaveBeenCalledExactlyOnceWith("a");
  expect(useApp.getState().tabs).toEqual([]);
});
it("keeps canceled/failed closes intact and allows a later retry", async () => {
  const history = vi.fn(),
    close = createTabCloser(history);
  vi.mocked(closeDocument)
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("save failed"))
    .mockResolvedValueOnce(true);
  expect(await close("a")).toBe(false);
  expect(useApp.getState().tabs).toHaveLength(3);
  await expect(close("a")).rejects.toThrow("save failed");
  expect(useApp.getState().tabs).toHaveLength(3);
  expect(history).not.toHaveBeenCalled();
  expect(await close("a")).toBe(true);
  expect(history).toHaveBeenCalledExactlyOnceWith("a");
});
it("waits for the native media close acknowledgement before removing its tab", async () => {
  let finish!: (value: boolean) => void;
  const media: Tab = {
    id: "media",
    entry: "file",
    kind: "media",
    instance: "instance",
    title: "pic",
    media: {
      entry: "file",
      token: "token",
      name: "pic",
      path: "pic",
      kind: "image",
      mime: "image/png",
      size: 1,
    },
  };
  useApp.setState({ tabs: [media], active: "media" });
  vi.mocked(closeDocument).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const close = createTabCloser(vi.fn()),
    pending = close("media");
  await Promise.resolve();
  expect(useApp.getState().tabs).toEqual([media]);
  finish(true);
  expect(await pending).toBe(true);
  expect(useApp.getState().tabs).toEqual([]);
});
