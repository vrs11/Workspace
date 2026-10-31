import type { useApp } from "./store";
type State = ReturnType<typeof useApp.getState>;
// Editor counters and notifications update their own views, independently of docks.
export function workspaceSnapshot(state: State) {
  const { docs, cursor, busy, notice, noticeDetails, ...snapshot } = state;
  void docs;
  void cursor;
  void busy;
  void notice;
  void noticeDetails;
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
