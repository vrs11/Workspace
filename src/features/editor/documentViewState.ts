import { create } from "zustand";
import { useApp } from "../../shared/state/store";
export type DocumentMode = "code" | "split" | "rendered";
export const useDocumentViews = create<{
  blame: Record<string, boolean>;
  modes: Record<string, DocumentMode>;
}>(() => ({ blame: {}, modes: {} }));
export function setBlame(entry: string, value: boolean) {
  useDocumentViews.setState((s) => ({ blame: { ...s.blame, [entry]: value } }));
}
export function setDocumentMode(entry: string, value: DocumentMode) {
  useDocumentViews.setState((s) => ({ modes: { ...s.modes, [entry]: value } }));
}
const stop = useApp.subscribe((state, previous) => {
  if (state.project?.id !== previous.project?.id) {
    useDocumentViews.setState({ blame: {}, modes: {} });
  } else if (state.docs !== previous.docs) {
    const views = useDocumentViews.getState();
    if (
      Object.keys(views.blame).some((id) => !state.docs[id]) ||
      Object.keys(views.modes).some((id) => !state.docs[id])
    ) {
      useDocumentViews.setState({
        blame: Object.fromEntries(
          Object.entries(views.blame).filter(([id]) => state.docs[id]),
        ),
        modes: Object.fromEntries(
          Object.entries(views.modes).filter(([id]) => state.docs[id]),
        ),
      });
    }
  }
});
if (import.meta.hot) import.meta.hot.dispose(stop);
