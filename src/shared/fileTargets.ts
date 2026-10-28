import { useApp, type Tab } from "./state/store";

export function tabEntry(tab: Tab | undefined): string | null {
  if (!tab) return null;
  return "entry" in tab
    ? tab.entry
    : tab.kind === "gitConflict"
      ? tab.conflict.entry
      : tab.diff.entry;
}
export function editableTabEntry(tab: Tab): string | null {
  return tab.kind === "editor" ||
    tab.kind === "conflict" ||
    tab.kind === "gitConflict"
    ? tabEntry(tab)
    : null;
}
let focused: { scope: string; active: string | null; entry: string } | null =
  null;
export function rememberEditorFile(entry: string) {
  const state = useApp.getState();
  if (state.project)
    focused = { scope: state.project.id, active: state.active, entry };
}
export function clearEditorFileFocus() {
  focused = null;
}
export function activeFileEntry(): string | null {
  const state = useApp.getState();
  if (
    focused?.scope === state.project?.id &&
    focused?.active === state.active &&
    focused?.entry === state.split
  )
    return focused.entry;
  return tabEntry(state.tabs.find((tab) => tab.id === state.active));
}
