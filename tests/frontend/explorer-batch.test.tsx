import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Explorer from "../../src/features/explorer/Explorer";
import { useApp } from "../../src/shared/state/store";
import { call, rpc } from "../../src/shared/ipc/client";
import { ask } from "../../src/shared/components/Dialog";
import { closeAffectedEntry } from "../../src/features/explorer/closeAffected";
import type { Entry } from "../../src/generated/protocol";
const dragArm = vi.hoisted(() => ({ start: null as (() => void) | null }));
vi.mock("../../src/features/explorer/fileDrag", () => ({
  armFileDrag: (_event: PointerEvent, start: () => void) => {
    dragArm.start = start;
    return vi.fn();
  },
  startFileDrag: vi.fn().mockResolvedValue(undefined),
}));
import { startFileDrag } from "../../src/features/explorer/fileDrag";
import {
  loadDocument,
  settleModelLoads,
} from "../../src/features/editor/models";
vi.mock("../../src/shared/ipc/client", async (original) => ({
  ...(await original<object>()),
  call: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("../../src/shared/components/Dialog", () => ({ ask: vi.fn() }));
vi.mock("../../src/features/explorer/closeAffected", () => ({
  closeAffectedEntry: vi.fn(),
}));
vi.mock("../../src/features/editor/models", () => ({
  loadDocument: vi.fn(),
  settleModelLoads: vi.fn(),
}));
vi.mock("../../src/features/workspace/DockWorkspace", () => ({
  useDockVisible: () => true,
}));
vi.mock("../../src/features/explorer/gitDecorations", () => ({
  useGitDecorations: () => new Map(),
  gitLabels: {},
  decorationLabel: vi.fn(),
}));
vi.mock("../../src/shared/components/VirtualList", () => ({
  VirtualList: ({
    items,
    render,
    onSelect,
    onDoubleClick,
    selected,
  }: {
    items: { entry: Entry }[];
    render: (row: { entry: Entry }, index: number) => React.ReactNode;
    onSelect: (row: { entry: Entry }, event: React.MouseEvent) => void;
    onDoubleClick: (row: { entry: Entry }, event: React.MouseEvent) => void;
    selected: (row: { entry: Entry }) => boolean;
  }) => (
    <div role="tree" className="virtual-list">
      {items.map((row, index) => (
        <div
          role="treeitem"
          aria-selected={selected(row)}
          key={row.entry.id}
          onClick={(event) => onSelect(row, event)}
          onDoubleClick={(event) => onDoubleClick(row, event)}
        >
          {render(row, index)}
        </div>
      ))}
    </div>
  ),
}));
const entries: Entry[] = ["a", "b", "c"].map((id) => ({
  id,
  name: id,
  path: id + ".txt",
  kind: "file",
}));
const destination: Entry = {
  id: "dest",
  name: "dest",
  path: "dest",
  kind: "directory",
};
const order: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  useApp.setState({
    project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
    explorerExpanded: [],
    docs: {},
    tabs: [],
    active: null,
    settings: null,
    busy: 0,
    notice: "",
  });
  vi.mocked(call).mockImplementation(async (request) => {
    if (request.type === "list")
      return {
        type: "entries",
        entries: request.parent ? [] : [destination, ...entries],
        truncated: false,
      } as never;
    if (request.type === "moveEntry") {
      order.push("move:" + request.entry);
      return { type: "entries", entries: [], truncated: false } as never;
    }
    if (request.type === "reviewDelete")
      return {
        type: "deleteReview",
        entry: request.entry,
        path: request.entry + ".txt",
        directory: false,
        review: "review:" + request.entry,
      } as never;
    throw Error("Unexpected call: " + request.type);
  });
  vi.mocked(rpc).mockImplementation(async (request) => {
    if (request.type === "delete") order.push("delete:" + request.entry);
    return { type: "ok" };
  });
  vi.mocked(ask).mockResolvedValue("Delete");
  vi.mocked(closeAffectedEntry).mockImplementation(async (_scope, entry) => {
    order.push("close:" + entry.id);
    return true;
  });
});
afterEach(cleanup);
async function mount() {
  render(<Explorer />);
  await screen.findByText("a");
}
const selected = () =>
  screen
    .getAllByRole("treeitem")
    .filter((row) => row.getAttribute("aria-selected") === "true");
async function remove() {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("workspace-command", {
        detail: "explorer.delete",
        cancelable: true,
      }),
    );
  });
}
it("selects files without opening them, opens on double click and leaves modified clicks for multi-selection", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  expect(selected()).toHaveLength(2);
  expect(loadDocument).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText("b"), { metaKey: true });
  expect(loadDocument).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText("c"));
  await waitFor(() =>
    expect(loadDocument).toHaveBeenCalledExactlyOnceWith("c"),
  );
});
it.each([false, true])(
  "only reopens an already-open file after renaming (%s)",
  async (opened) => {
    await mount();
    fireEvent.click(screen.getByText("a"));
    vi.mocked(settleModelLoads).mockImplementationOnce(async () => {
      if (opened)
        useApp.getState().doc("a", {
          id: "a",
          entry: "a",
          name: "a",
          path: "a.txt",
          baseline: "baseline",
          encoding: "utf8",
          eol: "LF",
          readonly: null,
          metadata: null,
          size: 1,
          revision: 0,
          acknowledged: 0,
          dirty: false,
          recovering: false,
          conflict: false,
          recoveryError: null,
          saveError: null,
        });
    });
    vi.mocked(ask).mockResolvedValue("renamed");
    const original = vi.mocked(call).getMockImplementation()!;
    vi.mocked(call).mockImplementation(async (request, type) => {
      if (request.type === "rename")
        return {
          type: "entries",
          entries: [
            { id: "renamed", name: "renamed", path: "renamed", kind: "file" },
          ],
          truncated: false,
        } as never;
      return original(request, type);
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("workspace-command", {
          detail: "explorer.rename",
          cancelable: true,
        }),
      );
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rename", entry: "a" }),
      "entries",
    );
    if (opened) expect(loadDocument).toHaveBeenCalledExactlyOnceWith("renamed");
    else expect(loadDocument).not.toHaveBeenCalled();
  },
);
it("deletes all selected files only after resolving every editor and preserves unselected files", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  expect(selected()).toHaveLength(2);
  await remove();
  await waitFor(() =>
    expect(order).toEqual(["close:a", "close:b", "delete:a", "delete:b"]),
  );
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Delete 2 items?" }),
  );
  expect(order).not.toContain("delete:c");
});
it("cancels the entire delete before touching files when a dirty editor is kept", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("c"), { shiftKey: true });
  expect(selected()).toHaveLength(3);
  vi.mocked(closeAffectedEntry)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  await remove();
  expect(rpc).not.toHaveBeenCalled();
  expect(selected()).toHaveLength(3);
});
it("does not prune the new project's tree after a late deletion acknowledgement", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  let finish!: (result: { type: "ok" }) => void;
  vi.mocked(rpc).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await remove();
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith({
      type: "delete",
      scope: "p",
      entry: "a",
    }),
  );
  await act(async () => {
    useApp.setState({
      project: { ...useApp.getState().project!, id: "new-project" },
    });
  });
  await screen.findByText("a");
  await act(async () => {
    finish({ type: "ok" });
  });
  expect(screen.getByText("a")).toBeVisible();
  expect(useApp.getState().notice).not.toContain("deleted");
});
it("keeps remaining selection when permanent deletion is cancelled after a partial batch", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { ctrlKey: true });
  vi.mocked(rpc).mockResolvedValueOnce({ type: "ok" }).mockRejectedValueOnce({
    code: "permissionDenied",
    message: "Permission denied for b",
  });
  vi.mocked(ask).mockResolvedValueOnce("Delete").mockResolvedValueOnce(null);
  await remove();
  await waitFor(() =>
    expect(useApp.getState().notice).toContain(
      "1 item(s) deleted; remaining items were kept",
    ),
  );
  expect(selected().map((row) => row.textContent)).toEqual(["b"]);
  expect(ask).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Permanently delete this file?",
      description: expect.stringContaining("Permission denied for b"),
    }),
  );
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("reports mixed recoverable and confirmed permanent deletions honestly", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  vi.mocked(rpc).mockResolvedValueOnce({ type: "ok" }).mockRejectedValueOnce({
    code: "unsupported",
    message: "Recovery unavailable",
  });
  vi.mocked(ask)
    .mockResolvedValueOnce("Delete")
    .mockImplementationOnce(async (question) => {
      await question.submit?.("Delete permanently");
      return "Delete permanently";
    });
  await remove();
  await waitFor(() =>
    expect(useApp.getState().notice).toContain(
      "2 item(s) deleted; 1 permanently",
    ),
  );
  expect(useApp.getState().notice).toContain(
    "other items remain in private recovery",
  );
  expect(selected()).toHaveLength(0);
  expect(rpc).toHaveBeenLastCalledWith({
    type: "deletePermanently",
    scope: "p",
    entry: "b",
    review: "review:b",
  });
});
it("moves a multi-selection through native drop targeting and preflights name collisions", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  const target = document.querySelector('[data-file-entry="dest"]');
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("workspace-file-drop", {
        detail: {
          target,
          drag: { scope: "p", entries: entries.slice(0, 2) },
          offer: null,
          folder: null,
        },
      }),
    );
  });
  await waitFor(() =>
    expect(order).toEqual(["close:a", "close:b", "move:a", "move:b"]),
  );
  expect(loadDocument).not.toHaveBeenCalled();
});
it("moves an external OS offer into the hovered Explorer folder after dirty-file decisions", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (request, type) => {
    if (request.type === "inspectDroppedMove")
      return {
        type: "entries",
        entries: [
          {
            id: "outside",
            name: "outside.txt",
            path: "/outside.txt",
            kind: "file",
          },
        ],
        truncated: false,
      } as never;
    if (request.type === "moveDroppedFiles") {
      order.push("incoming:" + request.parent);
      return { type: "fileDrop", entries: [], errors: [] } as never;
    }
    return original(request, type);
  });
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent("workspace-file-drop", {
        detail: {
          target: document.querySelector('[data-file-entry="dest"]'),
          drag: null,
          offer: "native-offer",
          folder: null,
        },
      }),
    ),
  );
  await waitFor(() =>
    expect(order).toEqual(["close:outside", "incoming:dest"]),
  );
  expect(call).toHaveBeenCalledWith(
    {
      type: "moveDroppedFiles",
      scope: "p",
      offer: "native-offer",
      parent: "dest",
    },
    "fileDrop",
  );
});

it("freezes the pressed drag selection before later selection updates", async () => {
  await mount();
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  const label = document.querySelector('[data-file-entry="a"]')!;
  const down = new Event("pointerdown", { bubbles: true });
  Object.assign(down, { button: 0, pointerType: "mouse", pointerId: 1 });
  label.dispatchEvent(down);
  expect(dragArm.start).not.toBeNull();
  fireEvent.click(screen.getByText("c"));
  await act(async () => dragArm.start!());
  expect(startFileDrag).toHaveBeenCalledWith("p", entries.slice(0, 2));
  expect(loadDocument).not.toHaveBeenCalled();
});
it("keeps a newer user selection when an earlier incoming move finishes", async () => {
  await mount();
  const original = vi.mocked(call).getMockImplementation()!;
  let finish!: (value: unknown) => void;
  vi.mocked(call).mockImplementation(async (request, type) => {
    if (request.type === "inspectDroppedMove")
      return {
        type: "entries",
        entries: [
          {
            id: "outside",
            name: "outside.txt",
            path: "/outside.txt",
            kind: "file",
          },
        ],
        truncated: false,
      } as never;
    if (request.type === "moveDroppedFiles")
      return (await new Promise<unknown>((resolve) => {
        finish = resolve;
      })) as never;
    return original(request, type);
  });
  act(() => {
    window.dispatchEvent(
      new CustomEvent("workspace-file-drop", {
        detail: {
          target: document.querySelector('[data-file-entry="dest"]'),
          drag: null,
          offer: "native-offer",
          folder: null,
        },
      }),
    );
  });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByText("a"));
  fireEvent.click(screen.getByText("b"), { metaKey: true });
  await act(async () =>
    finish({
      type: "fileDrop",
      entries: [
        {
          id: "imported",
          name: "outside.txt",
          path: "dest/outside.txt",
          kind: "file",
        },
      ],
      errors: [],
    }),
  );
  expect(selected().map((row) => row.textContent)).toEqual(["a", "b"]);
});
