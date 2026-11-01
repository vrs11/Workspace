import type { Entry } from "../../generated/protocol";

export type TreeChildren = Record<string, Entry[]>;
export type RenamedBranch = {
  removed: Set<string>;
  replacements: Map<string, Entry>;
  children: TreeChildren;
  errors: unknown[];
};

// Native IDs are path-bound. Re-read only folders already cached in the renamed
// branch, obtaining their new IDs from native listings rather than guessing IDs
// or walking the rest of the project.
export async function prepareRenamedBranch(
  cached: TreeChildren,
  source: Entry,
  renamed: Entry | undefined,
  parent: string | null,
  entries: Entry[],
  list: (parent: string) => Promise<Entry[]>,
  current: () => boolean,
): Promise<RenamedBranch | null> {
  const result: RenamedBranch = {
    removed: new Set(),
    replacements: new Map(),
    children: { [parent ?? "root"]: entries },
    errors: [],
  };
  const collect = (entry: Entry) => {
    if (result.removed.has(entry.id)) return;
    result.removed.add(entry.id);
    if (entry.kind === "directory")
      for (const child of cached[entry.id] ?? []) collect(child);
  };
  collect(source);
  if (renamed) result.replacements.set(source.id, renamed);
  const queue: [Entry, Entry][] =
    renamed && source.kind === "directory" ? [[source, renamed]] : [];
  for (let index = 0; index < queue.length; index++) {
    if (!current()) return null;
    const [before, after] = queue[index];
    const previous = cached[before.id];
    if (!previous) continue;
    let children: Entry[];
    try {
      children = await list(after.id);
    } catch (error) {
      if (!current()) return null;
      result.errors.push(error);
      continue;
    }
    if (!current()) return null;
    result.children[after.id] = children;
    const names = new Map<string, Entry[]>();
    for (const child of children) {
      const key = JSON.stringify([child.name, child.kind]);
      const matches = names.get(key) ?? [];
      matches.push(child);
      names.set(key, matches);
    }
    const oldNames = new Map<string, number>();
    for (const child of previous) {
      const key = JSON.stringify([child.name, child.kind]);
      oldNames.set(key, (oldNames.get(key) ?? 0) + 1);
    }
    for (const child of previous) {
      const key = JSON.stringify([child.name, child.kind]);
      const matches = names.get(key);
      // Display names can be ambiguous for non-UTF-8 native filenames. Never
      // attach selection/expansion to an arbitrary item in that case.
      if (matches?.length !== 1 || oldNames.get(key) !== 1) continue;
      const replacement = matches[0];
      result.replacements.set(child.id, replacement);
      if (child.kind === "directory") queue.push([child, replacement]);
    }
  }
  return current() ? result : null;
}

export function applyRenamedBranch(
  cached: TreeChildren,
  update: RenamedBranch,
): TreeChildren {
  const next = { ...cached };
  for (const id of update.removed) delete next[id];
  for (const [parent, entries] of Object.entries(next)) {
    if (Object.hasOwn(update.children, parent)) continue;
    if (entries.some((entry) => update.removed.has(entry.id)))
      next[parent] = entries.filter((entry) => !update.removed.has(entry.id));
  }
  return Object.assign(next, update.children);
}
export function renamedIds(ids: Iterable<string>, update: RenamedBranch) {
  return new Set(
    [...ids].flatMap((id) => {
      const replacement = update.replacements.get(id);
      return replacement
        ? [replacement.id]
        : update.removed.has(id)
          ? []
          : [id];
    }),
  );
}
