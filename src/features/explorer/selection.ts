import type { Entry } from "../../generated/protocol";
export type SelectionGesture = {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
};
export type TreeSelection = { ids: Set<string>; anchor: string | null };
export function selectEntries(
  old: TreeSelection,
  rows: Entry[],
  id: string,
  gesture: SelectionGesture,
): TreeSelection {
  const toggle = gesture.metaKey || gesture.ctrlKey;
  if (gesture.shiftKey) {
    const start = rows.findIndex((row) => row.id === old.anchor);
    const end = rows.findIndex((row) => row.id === id);
    if (start >= 0 && end >= 0) {
      const ids = toggle ? new Set(old.ids) : new Set<string>();
      for (const row of rows.slice(
        Math.min(start, end),
        Math.max(start, end) + 1,
      ))
        ids.add(row.id);
      return { ids, anchor: old.anchor };
    }
  }
  const ids = toggle ? new Set(old.ids) : new Set<string>();
  if (toggle && ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}
// A selected folder already includes its selected children. Never operate twice.
export function selectionRoots(
  entries: Entry[],
  separator = navigator.platform.includes("Win") ? "\\" : "/",
) {
  const folders = entries.filter((entry) => entry.kind === "directory");
  return entries.filter(
    (entry, index) =>
      entries.findIndex((item) => item.id === entry.id) === index &&
      !folders.some(
        (folder) =>
          folder.id !== entry.id &&
          entry.path.startsWith(folder.path + separator),
      ),
  );
}
