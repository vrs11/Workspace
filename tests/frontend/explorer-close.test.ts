import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApp, type DocMeta, type Tab } from "../../src/shared/state/store";
import { closeAffectedEntry } from "../../src/features/explorer/closeAffected";
import {
  closeDocument,
  settleModelLoads,
} from "../../src/features/editor/models";
vi.mock("../../src/features/editor/models", () => ({
  closeDocument: vi.fn(),
  settleModelLoads: vi.fn(),
}));
const project = { id: "p", root: "/fixture", name: "fixture", trusted: true };
const folder = { id: "folder", path: "src", name: "src", kind: "directory" };
const doc = (id: string, path: string) =>
  ({ id, entry: id, path, dirty: true }) as DocMeta;
const editor = (id: string): Tab => ({
  id,
  entry: id,
  kind: "editor",
  title: id,
});
const media: Tab = {
  id: "media",
  kind: "media",
  entry: "pic",
  instance: "instance",
  title: "pic",
  media: {
    entry: "pic",
    token: "token",
    path: "src/pic.png",
    name: "pic",
    kind: "image",
    mime: "image/png",
    size: 1,
  },
};
beforeEach(() => {
  useApp.setState({
    project,
    docs: { a: doc("a", "src/a.txt"), b: doc("b", "src-other/b.txt") },
    tabs: [editor("a"), editor("b"), media],
    active: "a",
    split: null,
  });
  vi.mocked(closeDocument).mockReset().mockResolvedValue(true);
  vi.mocked(settleModelLoads).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  useApp.setState({
    project: null,
    docs: {},
    tabs: [],
    active: null,
    split: null,
  });
  vi.restoreAllMocks();
});
it("stops at Cancel and retains the folder's remaining editor/media views", async () => {
  vi.mocked(closeDocument).mockResolvedValueOnce(false);
  expect(await closeAffectedEntry("p", folder)).toBe(false);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith("a", false);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual([
    "a",
    "b",
    "media",
  ]);
});
it("closes all related document, diff and conflict views while preserving similarly named sibling folders", async () => {
  const diff = {
    id: "snapshot",
    entry: "a",
    path: "src/a.txt",
    base: "",
    next: "",
    baseLabel: "old",
    nextLabel: "new",
    hunks: [],
    hunkUnavailable: null,
  };
  useApp.setState((state) => ({
    tabs: [
      ...state.tabs,
      { id: "diff", kind: "diff", diff, staged: false, title: "diff" },
      { id: "conflict", kind: "conflict", diff, title: "conflict" },
    ],
    active: "conflict",
  }));
  expect(await closeAffectedEntry("p", folder)).toBe(true);
  expect(vi.mocked(closeDocument).mock.calls).toEqual([
    ["a", false],
    ["media", false],
  ]);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["b"]);
  expect(useApp.getState().active).toBe("b");
});
it("waits for media close acknowledgement before retiring its view", async () => {
  useApp.setState({ docs: {}, tabs: [media], active: "media" });
  let finish!: (closed: boolean) => void;
  vi.mocked(closeDocument).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const closing = closeAffectedEntry("p", folder);
  await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledTimes(1));
  expect(useApp.getState().tabs).toEqual([media]);
  finish(true);
  expect(await closing).toBe(true);
  expect(useApp.getState().tabs).toEqual([]);
});
it("does not continue closing views after the active project changes", async () => {
  vi.mocked(closeDocument).mockImplementationOnce(async () => {
    useApp.setState({
      project: { ...project, id: "other" },
      tabs: [editor("a"), media],
      active: "a",
    });
    return true;
  });
  expect(await closeAffectedEntry("p", folder)).toBe(false);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith("a", false);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["a", "media"]);
});
it("uses Windows path-component boundaries when closing descendants", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  useApp.setState({
    docs: { a: doc("a", "src\\a.txt"), b: doc("b", "src-other\\b.txt") },
    tabs: [editor("a"), editor("b")],
    active: "a",
  });
  expect(await closeAffectedEntry("p", folder)).toBe(true);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith("a", false);
  expect(useApp.getState().tabs.map((tab) => tab.id)).toEqual(["b"]);
});
