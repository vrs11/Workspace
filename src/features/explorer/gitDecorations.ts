import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  Entry,
  GitDecoration,
  GitFileStatus,
} from "../../generated/protocol";
import { call } from "../../shared/ipc/client";
import { useApp } from "../../shared/state/store";
import { coalesceRefresh } from "../../shared/state/refresh";

export const gitLabels: Record<
  GitFileStatus,
  { label: string; badge: string }
> = {
  clean: { label: "Unchanged", badge: "" },
  ignored: { label: "Ignored by Git", badge: "I" },
  untracked: { label: "Untracked", badge: "?" },
  added: { label: "Added to Git", badge: "A" },
  modified: { label: "Modified", badge: "M" },
  staged: { label: "Staged", badge: "S" },
  renamed: { label: "Renamed", badge: "R" },
  deleted: { label: "Contains deleted files", badge: "D" },
  conflict: { label: "Merge conflict", badge: "!" },
};

export function decorationLabel(value: GitDecoration) {
  const label = gitLabels[value.status].label;
  return value.staged && !["staged", "clean", "ignored"].includes(value.status)
    ? `${label}; staged changes`
    : label;
}

// Dirty buffers update colors immediately, without subscribing the Explorer to
// text revisions or running Git on keystrokes. Propagate that state up the tree.
export function withDirtyDecorations(
  entries: Entry[],
  decorations: Map<string, GitDecoration>,
  dirty: string[],
  parents: Map<string, string>,
) {
  if (!entries.length) return new Map<string, GitDecoration>();
  const result = new Map(decorations);
  for (const id of dirty) {
    let current: string | undefined = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const before = result.get(current);
      if (
        !before ||
        ["ignored", "untracked", "conflict"].includes(before.status)
      )
        break;
      result.set(current, { ...before, status: "modified" });
      current = parents.get(current);
    }
  }
  return result;
}

export function useGitDecorations(
  entries: Entry[],
  parents: Map<string, string>,
  active: boolean,
  visibleEntries: Entry[] = entries,
) {
  const scope = useApp((state) => state.project?.id);
  const trusted = useApp((state) => state.project?.trusted);
  const git = useApp((state) => state.settings?.git);
  const dirty = useApp(
    useShallow((state) =>
      Object.values(state.docs)
        .filter((doc) => doc.dirty)
        .map((doc) => doc.entry),
    ),
  );
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    values: Map<string, GitDecoration>;
  } | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const view = useRef({ parents, visibleEntries });
  view.current = { parents, visibleEntries };
  const schedule = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!scope || !trusted || !git || !active) return;
    let disposed = false;
    let epoch = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = new Set<string>();
    const cache = new Map(
      snapshotRef.current?.scope === scope ? snapshotRef.current.values : [],
    );
    const publish = () => {
      if (!disposed && useApp.getState().project?.id === scope)
        startTransition(() => setSnapshot({ scope, values: new Map(cache) }));
    };
    const refresh = coalesceRefresh(async () => {
      if (disposed) return;
      const ids = view.current.visibleEntries
        .map((entry) => entry.id)
        .filter((id) => view.current.parents.has(id) && !valid.has(id))
        .slice(0, 512);
      if (!ids.length) return;
      const version = epoch;
      try {
        const response = await call(
          { type: "gitDecorations", scope, entries: ids },
          "gitDecorations",
        );
        if (
          disposed ||
          epoch !== version ||
          useApp.getState().project?.id !== scope
        )
          return;
        for (const id of ids) {
          valid.add(id);
          cache.delete(id);
        }
        for (const value of response.decorations) cache.set(value.entry, value);
        while (cache.size > 5000) {
          const id = cache.keys().next().value!;
          cache.delete(id);
          valid.delete(id);
        }
        while (valid.size > 5000) valid.delete(valid.values().next().value!);
      } catch {
        // Git is optional; errors must not label unknown files as committed.
        if (disposed || epoch !== version) return;
        for (const id of ids) {
          cache.delete(id);
          valid.add(id);
        }
      }
      publish();
    });
    const request = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 100);
    };
    schedule.current = request;
    const invalidate = () => {
      epoch++;
      valid.clear();
      request();
    };
    request();
    window.addEventListener("workspace-refresh", invalidate);
    window.addEventListener("explorer-git-refresh", invalidate);
    return () => {
      disposed = true;
      clearTimeout(timer);
      schedule.current = null;
      window.removeEventListener("workspace-refresh", invalidate);
      window.removeEventListener("explorer-git-refresh", invalidate);
    };
  }, [scope, trusted, git, active]);
  useEffect(() => {
    schedule.current?.();
  }, [visibleEntries, entries]);
  return useMemo(
    () =>
      withDirtyDecorations(
        entries,
        trusted && git && snapshot && snapshot.scope === scope
          ? snapshot.values
          : new Map(),
        dirty,
        parents,
      ),
    [entries, parents, scope, trusted, git, snapshot, dirty],
  );
}
