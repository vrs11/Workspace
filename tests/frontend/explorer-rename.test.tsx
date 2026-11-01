import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry, Response } from "../../src/generated/protocol";
import Explorer from "../../src/features/explorer/Explorer";
import { useApp } from "../../src/shared/state/store";
import { call } from "../../src/shared/ipc/client";
import { ask } from "../../src/shared/components/Dialog";
import { closeAffectedEntry } from "../../src/features/explorer/closeAffected";
import { loadDocument } from "../../src/features/editor/models";

const scrollToIndex = vi.hoisted(() => vi.fn());
// Supply viewport measurements absent in jsdom, retaining the real VirtualList
// keyboard/focus behavior and the complete Explorer component.
vi.mock("@tanstack/react-virtual", async () => {
  const { useMemo } = await import("react");
  return {
    useVirtualizer: ({ count }: { count: number }) =>
      useMemo(() => {
        const rows = Array.from({ length: count }, (_, index) => ({
          index,
          key: index,
          size: 30,
          start: index * 30,
          end: (index + 1) * 30,
        }));
        return {
          getVirtualItems: () => rows,
          getTotalSize: () => count * 30,
          scrollOffset: 0,
          scrollRect: { height: 1000 },
          scrollToIndex,
        };
      }, [count]),
  };
});
vi.mock("../../src/shared/ipc/client", async (original) => ({
  ...(await original<object>()),
  call: vi.fn(),
}));
vi.mock("../../src/shared/components/Dialog", () => ({ ask: vi.fn() }));
vi.mock("../../src/features/explorer/closeAffected", () => ({
  closeAffectedEntry: vi.fn(),
}));
vi.mock("../../src/features/editor/models", () => ({
  loadDocument: vi.fn(),
  settleModelLoads: vi.fn(),
}));
vi.mock("../../src/features/explorer/fileDrag", () => ({
  armFileDrag: vi.fn(),
  startFileDrag: vi.fn(),
}));
vi.mock("../../src/features/workspace/DockWorkspace", () => ({
  useDockVisible: () => true,
}));
vi.mock("../../src/features/explorer/gitDecorations", () => ({
  useGitDecorations: () => new Map(),
  gitLabels: {},
  decorationLabel: vi.fn(),
}));

// Test fixture IDs deliberately change with paths, as native IDs do. Application
// code must obtain those IDs from listings; the scheme here is fixture-only.
const entry = (path: string, kind: Entry["kind"] = "file"): Entry => ({
  id: "fixture:" + path,
  path,
  name: path.split("/").at(-1)!,
  kind,
});
const src = entry("src", "directory"),
  nested = entry("src/nested", "directory"),
  other = entry("other", "directory"),
  unopened = entry("unopened", "directory"),
  a = entry("src/a.txt"),
  b = entry("src/b.txt"),
  child = entry("src/nested/child.txt"),
  keep = entry("other/keep.txt");
let listings: Record<string, Entry[]>;
function nativeRename(source: string, name: string): Response {
  const before = Object.values(listings)
    .flat()
    .find((item) => item.id === source)!;
  const path = before.path.includes("/")
    ? before.path.slice(0, before.path.lastIndexOf("/") + 1) + name
    : name;
  const replacement = (item: Entry) =>
    item.path === before.path || item.path.startsWith(before.path + "/")
      ? entry(path + item.path.slice(before.path.length), item.kind)
      : item;
  const parent = Object.entries(listings).find(([, entries]) =>
    entries.some((item) => item.id === source),
  )![0];
  listings = Object.fromEntries(
    Object.entries(listings).map(([key, entries]) => {
      const directory = Object.values(listings)
        .flat()
        .find((item) => item.id === key);
      return [
        directory ? replacement(directory).id : key,
        entries
          .map(replacement)
          .sort(
            (a, b) =>
              Number(b.kind === "directory") - Number(a.kind === "directory") ||
              a.name.localeCompare(b.name),
          ),
      ];
    }),
  );
  return { type: "entries", entries: listings[parent], truncated: false };
}
beforeEach(() => {
  vi.resetAllMocks();
  listings = {
    root: [src, other, unopened],
    [src.id]: [nested, a, b],
    [nested.id]: [child],
    [other.id]: [keep],
  };
  useApp.setState({
    project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
    explorerExpanded: [src.id, nested.id, other.id],
    docs: {},
    tabs: [],
    active: null,
    settings: null,
    busy: 0,
    notice: "",
  });
  vi.mocked(ask).mockResolvedValue("z.txt");
  vi.mocked(closeAffectedEntry).mockResolvedValue(true);
  vi.mocked(call).mockImplementation(async (request) => {
    if (request.type === "clipboardHasFiles")
      return { type: "clipboardFiles", available: false } as never;
    if (request.type === "rename")
      return nativeRename(request.entry, request.name) as never;
    if (request.type === "list") {
      if (request.scope !== "p")
        return {
          type: "entries",
          entries: [entry("new-project.txt")],
          truncated: false,
        } as never;
      const entries = listings[request.parent ?? "root"];
      if (!entries)
        throw {
          code: "notFound",
          message: "Invalid fixture directory: " + request.parent,
        };
      return { type: "entries", entries, truncated: false } as never;
    }
    throw Error("Unexpected call: " + request.type);
  });
});
afterEach(cleanup);
async function mount() {
  render(<Explorer />);
  await screen.findByText("keep.txt");
  await act(async () => {});
}
async function rename(name: string) {
  fireEvent.click(screen.getByText(name));
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("workspace-command", {
        detail: "explorer.rename",
        cancelable: true,
      }),
    );
  });
}
const selected = () =>
  screen
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.textContent);
const expanded = () => new Set(useApp.getState().explorerExpanded);
const focused = () => {
  const tree = screen.getByRole("tree");
  return document.getElementById(tree.getAttribute("aria-activedescendant")!)
    ?.textContent;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("renames a file without collapsing any folder, moving scroll, losing selection or opening a closed file", async () => {
  await mount();
  const tree = screen.getByRole("tree");
  tree.scrollTop = 90;
  const before = useApp.getState().explorerExpanded;
  await rename("a.txt");
  expect(screen.getByText("z.txt")).toBeVisible();
  expect(screen.queryByText("a.txt")).toBeNull();
  expect(screen.getByText("child.txt")).toBeVisible();
  expect(screen.getByText("keep.txt")).toBeVisible();
  expect(useApp.getState().explorerExpanded).toBe(before);
  expect(selected()).toEqual(["z.txt"]);
  expect(screen.getByRole("tree")).toBe(tree);
  expect(tree.scrollTop).toBe(90);
  expect(focused()).toBe("z.txt");
  expect(scrollToIndex).not.toHaveBeenCalled();
  expect(loadDocument).not.toHaveBeenCalled();
  // Sorting moves z.txt after b.txt; keyboard activation must still open z.txt.
  fireEvent.keyDown(tree, { key: "Enter" });
  await waitFor(() =>
    expect(loadDocument).toHaveBeenCalledExactlyOnceWith(entry("src/z.txt").id),
  );
});

it("still scrolls to the active editor file when Reveal is used after renaming", async () => {
  await mount();
  await rename("a.txt");
  await act(async () => {
    useApp.setState({
      tabs: [
        { id: "editor", kind: "editor", entry: keep.id, title: keep.name },
      ],
      active: "editor",
    });
  });
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (request, type) =>
    request.type === "revealEntry"
      ? ({ type: "entries", entries: [other, keep], truncated: false } as never)
      : original(request, type),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal active file in Explorer" }),
  );
  await waitFor(() => expect(selected()).toEqual(["keep.txt"]));
  expect(scrollToIndex).toHaveBeenCalledWith(expect.any(Number), {
    align: "center",
  });
  expect(focused()).toBe("keep.txt");
});

it("keeps renamed folders and their descendants expanded using fresh native IDs, preserving unrelated branches", async () => {
  await mount();
  vi.mocked(ask).mockResolvedValue("renamed");
  await rename("src");
  expect(expanded()).toEqual(
    new Set([entry("renamed").id, entry("renamed/nested").id, other.id]),
  );
  expect(screen.getByText("child.txt")).toBeVisible();
  expect(screen.getByText("a.txt")).toBeVisible();
  expect(screen.getByText("keep.txt")).toBeVisible();
  expect(selected()).toEqual(["renamed"]);
  expect(screen.queryByText("src")).toBeNull();
  expect(call).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "list", parent: unopened.id }),
    "entries",
  );
  expect(loadDocument).not.toHaveBeenCalled();
  expect(useApp.getState().notice).toBe("");
  // New descendant IDs must work for subsequent operations, too.
  vi.mocked(ask).mockResolvedValue("updated.txt");
  await rename("child.txt");
  expect(screen.getByText("updated.txt")).toBeVisible();
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "rename",
      entry: entry("renamed/nested/child.txt").id,
    }),
    "entries",
  );
});

it("ignores a pre-rename directory listing that arrives after the rename", async () => {
  await mount();
  const stale = deferred<Response>();
  vi.mocked(call).mockImplementationOnce(() => stale.promise as never);
  await act(async () => {
    window.dispatchEvent(new Event("workspace-refresh"));
  });
  await rename("a.txt");
  expect(screen.getByText("z.txt")).toBeVisible();
  await act(async () => {
    stale.resolve({ type: "entries", entries: [src], truncated: false });
  });
  expect(screen.getByText("other")).toBeVisible();
  expect(screen.getByText("unopened")).toBeVisible();
  expect(screen.getByText("z.txt")).toBeVisible();
  expect(screen.getByText("child.txt")).toBeVisible();
});

it.each(["dialog", "editor", "same name", "failure"])(
  "retains the tree and selection after %s cancellation/failure",
  async (reason) => {
    await mount();
    if (reason === "dialog") vi.mocked(ask).mockResolvedValue(null);
    if (reason === "editor")
      vi.mocked(closeAffectedEntry).mockResolvedValue(false);
    if (reason === "same name") vi.mocked(ask).mockResolvedValue("a.txt");
    if (reason === "failure") {
      const original = vi.mocked(call).getMockImplementation()!;
      vi.mocked(call).mockImplementation(async (request, type) => {
        if (request.type === "rename")
          throw { code: "alreadyExists", message: "Name already exists" };
        return original(request, type);
      });
    }
    await rename("a.txt");
    expect(expanded()).toEqual(new Set([src.id, nested.id, other.id]));
    expect(screen.getByText("a.txt")).toBeVisible();
    expect(screen.getByText("child.txt")).toBeVisible();
    expect(selected()).toEqual(["a.txt"]);
    expect(
      vi
        .mocked(call)
        .mock.calls.filter(([request]) => request.type === "rename"),
    ).toHaveLength(reason === "failure" ? 1 : 0);
    expect(loadDocument).not.toHaveBeenCalled();
  },
);

it("does not steal a newer selection or editor focus when a rename finishes", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  const result = deferred<Response>();
  vi.mocked(call).mockImplementation(async (request, type) =>
    request.type === "rename"
      ? ((await result.promise) as never)
      : original(request, type),
  );
  await rename("a.txt");
  fireEvent.click(screen.getByText("keep.txt"));
  const editor = document.createElement("textarea");
  document.body.append(editor);
  editor.focus();
  await act(async () => {
    result.resolve(nativeRename(a.id, "z.txt"));
  });
  expect(selected()).toEqual(["keep.txt"]);
  expect(document.activeElement).toBe(editor);
  expect(screen.getByText("z.txt")).toBeVisible();
  expect(expanded()).toEqual(new Set([src.id, nested.id, other.id]));
  editor.remove();
});

it("ignores an old project's delayed rename acknowledgement", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  const result = deferred<Response>();
  vi.mocked(call).mockImplementation(async (request, type) =>
    request.type === "rename"
      ? ((await result.promise) as never)
      : original(request, type),
  );
  await rename("src");
  await act(async () => {
    useApp.setState({
      project: { ...useApp.getState().project!, id: "new-project" },
      explorerExpanded: [],
    });
  });
  await screen.findByText("new-project.txt");
  fireEvent.click(screen.getByText("new-project.txt"));
  await act(async () => {
    result.resolve(nativeRename(src.id, "z.txt"));
  });
  expect(selected()).toEqual(["new-project.txt"]);
  expect(expanded()).toEqual(new Set());
  expect(screen.queryByText("z.txt")).toBeNull();
  expect(screen.queryByText("src")).toBeNull();
});

it("retains ancestor and sibling expansion when renaming a nested folder", async () => {
  await mount();
  vi.mocked(ask).mockResolvedValue("inner");
  await rename("nested");
  expect(expanded()).toEqual(
    new Set([src.id, entry("src/inner").id, other.id]),
  );
  expect(screen.getByText("child.txt")).toBeVisible();
  expect(screen.getByText("b.txt")).toBeVisible();
  expect(screen.getByText("keep.txt")).toBeVisible();
  expect(selected()).toEqual(["inner"]);
});

it("keeps a cached collapsed folder collapsed, with working descendants when reopened", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Collapse nested" }));
  expect(screen.queryByText("child.txt")).toBeNull();
  vi.mocked(ask).mockResolvedValue("renamed");
  await rename("src");
  expect(expanded()).toEqual(new Set([entry("renamed").id, other.id]));
  expect(screen.queryByText("child.txt")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand nested" }));
  expect(await screen.findByText("child.txt")).toBeVisible();
  expect(call).toHaveBeenCalledWith(
    { type: "list", scope: "p", parent: entry("renamed/nested").id },
    "entries",
  );
});

it("preserves unrelated expanded folders and reports a descendant refresh failure after a successful rename", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(ask).mockResolvedValue("renamed");
  vi.mocked(call).mockImplementation(async (request, type) => {
    if (
      request.type === "list" &&
      request.parent === entry("renamed/nested").id
    )
      throw {
        code: "permissionDenied",
        message: "Permission denied reading nested",
      };
    return original(request, type);
  });
  await rename("src");
  expect(screen.getByText("renamed")).toBeVisible();
  expect(screen.getByText("keep.txt")).toBeVisible();
  expect(screen.getByRole("button", { name: "Collapse other" })).toBeVisible();
  expect(selected()).toEqual(["renamed"]);
  expect(useApp.getState().notice).toContain("Renamed successfully");
  expect(
    vi.mocked(call).mock.calls.filter(([request]) => request.type === "rename"),
  ).toHaveLength(1);
});
