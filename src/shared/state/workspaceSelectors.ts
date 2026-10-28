import type { useApp } from "./store";
type State = ReturnType<typeof useApp.getState>;
// Frequent editor counters belong to the status bar, not the dock tree.
export function workspaceSnapshot(state: State) {
  const { docs, cursor, busy, ...snapshot } = state;
  void docs;
  void cursor;
  void busy;
  return snapshot;
}
export function activeDocumentUi(state: State) {
  const document = state.docs[state.active ?? ""];
  if (!document) return undefined;
  const { revision, acknowledged, baseline, ...ui } = document;
  void revision;
  void acknowledged;
  void baseline;
  return ui;
}
