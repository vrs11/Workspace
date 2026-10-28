import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Entry,
  GitDecoration,
  Settings,
} from "../../src/generated/protocol";
import {
  decorationLabel,
  useGitDecorations,
  withDirtyDecorations,
} from "../../src/features/explorer/gitDecorations";
import { useApp } from "../../src/shared/state/store";
import { call } from "../../src/shared/ipc/client";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn() }));
const entries: Entry[] = [
  { id: "folder", name: "folder", path: "folder", kind: "directory" },
  { id: "file", name: "file.txt", path: "folder/file.txt", kind: "file" },
];
const parents = new Map([
  ["folder", "root"],
  ["file", "folder"],
]);
const clean = new Map<string, GitDecoration>(
  entries.map((entry) => [
    entry.id,
    { entry: entry.id, status: "clean", staged: false },
  ]),
);
const project = {
  id: "scope",
  root: "/project",
  name: "project",
  trusted: true,
};
const settings: Settings = {
  version: 2,
  git: "/git",
  theme: "dark",
  fontSize: 14,
  recent: [],
  shell: null,
  shellArgs: [],
  terminalFontSize: 14,
  terminalScrollback: 2000,
  autoSaveIdle: true,
  autoSaveDelay: 15,
  autoSaveOnFocusLoss: true,
  keybindings: {},
};
beforeEach(() => {
  vi.mocked(call).mockReset();
  useApp.setState({ project, settings, docs: {} });
});
afterEach(() => {
  useApp.setState({ project: null, settings: null, docs: {} });
});

it("shows unsaved edits immediately on the file and its parent while retaining staged state", () => {
  const staged = new Map(clean);
  staged.set("file", { entry: "file", status: "staged", staged: true });
  const result = withDirtyDecorations(entries, staged, ["file"], parents);
  expect(result.get("file")).toEqual({
    entry: "file",
    status: "modified",
    staged: true,
  });
  expect(result.get("folder")?.status).toBe("modified");
  expect(staged.get("file")?.status).toBe("staged");
  expect(decorationLabel(result.get("file")!)).toBe("Modified; staged changes");
});

it("preserves ignored, untracked and conflicting status and does not invent committed state", () => {
  for (const status of ["ignored", "untracked", "conflict"] as const) {
    const original = new Map(clean);
    original.set("file", { entry: "file", status, staged: false });
    expect(
      withDirtyDecorations(entries, original, ["file"], parents).get("file")
        ?.status,
    ).toBe(status);
  }
  expect(withDirtyDecorations(entries, new Map(), ["file"], parents).size).toBe(
    0,
  );
  expect(
    withDirtyDecorations(entries, clean, [], parents).get("file")?.status,
  ).toBe("clean");
});

it("never runs Git for restricted projects, missing Git or hidden Explorer views", async () => {
  const { rerender, unmount } = renderHook(
    ({ active }) => useGitDecorations(entries, parents, active),
    { initialProps: { active: false } },
  );
  act(() => {
    useApp.setState({ project: { ...project, trusted: false } });
  });
  rerender({ active: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(call).not.toHaveBeenCalled();
  act(() => {
    useApp.setState({ project, settings: { ...settings, git: null } });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(call).not.toHaveBeenCalled();
  unmount();
});

it("uses the native snapshot without the Git panel, refreshes on changes and clears failed status", async () => {
  vi.mocked(call).mockResolvedValue({
    type: "gitDecorations",
    decorations: [...clean.values()],
  });
  const { result, unmount } = renderHook(() =>
    useGitDecorations(entries, parents, true),
  );
  await waitFor(() => expect(result.current.get("file")?.status).toBe("clean"));
  expect(call).toHaveBeenCalledWith(
    { type: "gitDecorations", scope: "scope", entries: ["folder", "file"] },
    "gitDecorations",
  );
  vi.mocked(call).mockRejectedValue(new Error("Git unavailable"));
  act(() => {
    window.dispatchEvent(new Event("workspace-refresh"));
  });
  await waitFor(() => expect(result.current.size).toBe(0));
  unmount();
});

it("discards late results from a previously opened project", async () => {
  let finish!: (value: Awaited<ReturnType<typeof call>>) => void;
  vi.mocked(call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, unmount } = renderHook(() =>
    useGitDecorations(entries, parents, true),
  );
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  act(() => {
    useApp.setState({ project: { ...project, id: "next", trusted: false } });
  });
  await act(async () => {
    finish({ type: "gitDecorations", decorations: [...clean.values()] });
  });
  expect(result.current.size).toBe(0);
  unmount();
});

it("requests only visible rows, keeps one worker across tree updates and drains the latest viewport", async () => {
  const loaded = Array.from({ length: 1000 }, (_, index) => ({
    id: `row-${index}`,
    name: `row-${index}`,
    path: `row-${index}`,
    kind: "file",
  }));
  const emptyParents = new Map(loaded.map((entry) => [entry.id, "root"]));
  const pending: Array<(value: Awaited<ReturnType<typeof call>>) => void> = [];
  vi.mocked(call).mockImplementation(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const { rerender, unmount } = renderHook(
    ({ shown, all }) => useGitDecorations(all, emptyParents, true, shown),
    { initialProps: { shown: loaded.slice(0, 2), all: loaded } },
  );
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  expect(vi.mocked(call).mock.calls[0][0]).toEqual({
    type: "gitDecorations",
    scope: "scope",
    entries: ["row-0", "row-1"],
  });
  rerender({ shown: loaded.slice(500, 502), all: [...loaded] });
  act(() => {
    for (let i = 0; i < 30; i++)
      window.dispatchEvent(new Event("workspace-refresh"));
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(call).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.shift()!({ type: "gitDecorations", decorations: [] });
  });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(vi.mocked(call).mock.calls[1][0]).toEqual({
    type: "gitDecorations",
    scope: "scope",
    entries: ["row-500", "row-501"],
  });
  await act(async () => {
    pending.shift()!({ type: "gitDecorations", decorations: [] });
  });
  unmount();
});

it("reuses viewport colors on clicks and returning scrolls, then invalidates on real refresh", async () => {
  vi.mocked(call).mockImplementation(async (request) => ({
    type: "gitDecorations",
    decorations:
      request.type === "gitDecorations"
        ? request.entries.map((entry) => ({
            entry,
            status: "clean" as const,
            staged: false,
          }))
        : [],
  }));
  const { rerender, result, unmount } = renderHook(
    ({ shown }) => useGitDecorations(entries, parents, true, shown),
    { initialProps: { shown: entries.slice(0, 1) } },
  );
  await waitFor(() =>
    expect(result.current.get("folder")?.status).toBe("clean"),
  );
  rerender({ shown: [...entries.slice(0, 1)] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(call).toHaveBeenCalledTimes(1);
  rerender({ shown: entries.slice(1) });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  rerender({ shown: entries.slice(0, 1) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(call).toHaveBeenCalledTimes(2);
  act(() => {
    window.dispatchEvent(new Event("workspace-refresh"));
  });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
  act(() => {
    window.dispatchEvent(new Event("explorer-git-refresh"));
  });
  await waitFor(() => expect(call).toHaveBeenCalledTimes(4));
  unmount();
});
