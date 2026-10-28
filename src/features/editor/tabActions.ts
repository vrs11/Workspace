import { useApp, type Tab } from "../../shared/state/store";
import { editableTabEntry } from "../../shared/fileTargets";
import { closeDocument } from "./models";

export type CloseTabGroup = "left" | "right" | "rest" | "close";
export function tabCloseTargets(
  tabs: Tab[],
  anchor: string,
  group: CloseTabGroup,
): string[] {
  const index = tabs.findIndex((tab) => tab.id === anchor);
  if (index < 0) return [];
  return (
    group === "left"
      ? tabs.slice(0, index)
      : group === "right"
        ? tabs.slice(index + 1)
        : group === "rest"
          ? tabs.filter((tab) => tab.id !== anchor)
          : [tabs[index]]
  ).map((tab) => tab.id);
}
export async function closeTabGroup(
  anchor: string,
  group: CloseTabGroup,
  close: (id: string) => Promise<boolean>,
) {
  const state = useApp.getState(),
    scope = state.project?.id;
  const targets = tabCloseTargets(state.tabs, anchor, group);
  if (group !== "close" && state.active && targets.includes(state.active))
    state.set({ active: anchor });
  for (const id of targets) {
    if (useApp.getState().project?.id !== scope || !(await close(id))) {
      const current = useApp.getState();
      if (
        current.project?.id === scope &&
        current.active === anchor &&
        current.tabs.some((tab) => tab.id === id)
      )
        current.set({ active: id });
      return false;
    }
  }
  return true;
}
// Serialize all close routes, including tab buttons, shortcuts and bulk menus.
// Editable conflict views retain their shared model until its last view closes.
export function createTabCloser(onClosed: (entry: string) => void) {
  let pending = Promise.resolve();
  return (id: string): Promise<boolean> => {
    const scope = useApp.getState().project?.id;
    const operation = pending.then(async () => {
      const state = useApp.getState();
      if (!scope || state.project?.id !== scope) return false;
      const tab = state.tabs.find((tab) => tab.id === id);
      if (!tab) return true;
      const entry = editableTabEntry(tab);
      const retained =
        entry &&
        state.tabs.some(
          (other) => other.id !== id && editableTabEntry(other) === entry,
        );
      if (tab.kind === "media" || (entry && !retained)) {
        const document = entry ?? id;
        if (!(await closeDocument(document))) return false;
        if (useApp.getState().project?.id !== scope) return false;
        onClosed(document);
      }
      useApp.setState((current) => {
        if (current.project?.id !== scope) return {};
        const tabs = current.tabs.filter((tab) => tab.id !== id);
        return {
          tabs,
          active:
            current.active === id ? (tabs.at(-1)?.id ?? null) : current.active,
          ...(tab.kind === "editor" && current.split === entry
            ? { split: null }
            : {}),
        };
      });
      return true;
    });
    pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  };
}
