import type { Entry } from "../../generated/protocol";
import { useApp, type Tab } from "../../shared/state/store";
import { tabEntry } from "../../shared/fileTargets";
import { closeDocument, settleModelLoads } from "../editor/models";

export async function closeAffectedEntry(scope: string, entry: Entry) {
  await settleModelLoads();
  const current = () => useApp.getState().project?.id === scope;
  if (!current()) return false;
  const state = useApp.getState();
  const separator = navigator.platform.includes("Win") ? "\\" : "/";
  const matches = (id: string, path: string) =>
    id === entry.id ||
    (entry.kind === "directory" && path.startsWith(entry.path + separator));
  const documents = Object.values(state.docs).filter((document) =>
    matches(document.entry, document.path),
  );
  const related = (tab: Tab) => {
    const id = tabEntry(tab);
    const path =
      tab.kind === "editor"
        ? state.docs[tab.entry]?.path
        : tab.kind === "media"
          ? tab.media.path
          : tab.kind === "gitConflict"
            ? tab.conflict.path
            : tab.diff.path;
    return !!id && matches(id, path ?? "");
  };
  const tabs = state.tabs.filter(related);
  for (const document of documents)
    if (!current() || !(await closeDocument(document.id, false))) return false;
  for (const tab of tabs)
    if (tab.kind === "media")
      if (!current() || !(await closeDocument(tab.id, false))) return false;
  if (!current()) return false;
  const closed = new Set(tabs.map((tab) => tab.id));
  useApp.setState((state) => {
    if (state.project?.id !== scope) return {};
    const tabs = state.tabs.filter((tab) => !closed.has(tab.id));
    return {
      tabs,
      active:
        state.active && closed.has(state.active)
          ? (tabs.at(-1)?.id ?? null)
          : state.active,
    };
  });
  return true;
}
