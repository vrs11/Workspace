import { afterEach, expect, it, vi } from "vitest";
import { useApp, type Tab } from "../../src/shared/state/store";
import {
  tabEntry,
  activeFileEntry,
  rememberEditorFile,
  clearEditorFileFocus,
} from "../../src/shared/fileTargets";
import { copyEntryPath } from "../../src/shared/components/FilePathMenu";
import { call, rpc } from "../../src/shared/ipc/client";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn(), rpc: vi.fn() }));
const project = { id: "p", root: "/fixture", name: "fixture", trusted: true };
const tabs: Tab[] = [
  { id: "a", entry: "a", kind: "editor", title: "a" },
  { id: "b", entry: "b", kind: "editor", title: "b" },
];
afterEach(() => {
  clearEditorFileFocus();
  useApp.setState({ project: null, tabs: [], active: null, split: null });
  vi.mocked(call).mockReset();
  vi.mocked(rpc).mockReset();
});
it("resolves the current file across editor, diff and focused secondary views", () => {
  useApp.setState({ project, tabs, active: "a", split: "b" });
  expect(activeFileEntry()).toBe("a");
  rememberEditorFile("b");
  expect(activeFileEntry()).toBe("b");
  clearEditorFileFocus();
  expect(activeFileEntry()).toBe("a");
  const diff = {
    id: "snap",
    entry: "source",
    path: "source",
    base: "",
    next: "",
    baseLabel: "old",
    nextLabel: "new",
    hunks: [],
    hunkUnavailable: null,
  };
  const comparison: Tab = {
    id: "diff:source",
    kind: "diff",
    title: "Working · source",
    diff,
    staged: false,
  };
  useApp.setState({ tabs: [...tabs, comparison], active: "diff:source" });
  expect(tabEntry(comparison)).toBe("source");
  expect(activeFileEntry()).toBe("source");
  useApp.setState({ project: { ...project, id: "next" }, active: "a" });
  expect(activeFileEntry()).toBe("a");
});
it.each(["name", "project", "git", "absolute"] as const)(
  "uses the same native copy action for %s without parsing display titles",
  async (kind) => {
    useApp.setState({ project });
    vi.mocked(call).mockResolvedValue({
      type: "text",
      text: "native path 🌍\nwith spaces",
    });
    await copyEntryPath("p", "opaque-entry", kind);
    expect(call).toHaveBeenCalledExactlyOnceWith(
      { type: "filePath", scope: "p", entry: "opaque-entry", kind },
      "text",
    );
    expect(rpc).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardWrite",
      text: "native path 🌍\nwith spaces",
    });
  },
);
it("does not write stale project paths to the clipboard or replace it after a failed read", async () => {
  useApp.setState({ project });
  let finish!: (value: Awaited<ReturnType<typeof call>>) => void;
  vi.mocked(call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const copying = copyEntryPath("p", "a", "absolute");
  useApp.setState({ project: { ...project, id: "next" } });
  finish({ type: "text", text: "old project" });
  await copying;
  expect(rpc).not.toHaveBeenCalled();
  await copyEntryPath("p", "a", "project");
  expect(call).toHaveBeenCalledTimes(1);
  useApp.setState({ project });
  vi.mocked(call).mockRejectedValueOnce(new Error("not a repository"));
  await expect(copyEntryPath("p", "a", "git")).rejects.toThrow(
    "not a repository",
  );
  expect(rpc).not.toHaveBeenCalled();
});
