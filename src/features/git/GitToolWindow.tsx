import { useEffect } from "react";
import { DockHeader, useDockVisible } from "../workspace/DockWorkspace";
import GitPanel from "./GitPanel";
import { useApp } from "../../shared/state/store";
export default function GitToolWindow() {
  const visible = useDockVisible();
  const requested = useApp((state) => state.bottom);
  const history = useApp((s) => s.gitHistory);
  const setHistory = (gitHistory: boolean) => useApp.setState({ gitHistory });
  useEffect(() => {
    if (requested === "history" || requested === "changes")
      setHistory(requested === "history");
  }, [requested]);
  return (
    <div className="git-tool-window">
      <DockHeader>
        <div className="git-view-tabs" role="tablist" aria-label="Git views">
          <button
            role="tab"
            aria-selected={!history}
            className={!history ? "active" : ""}
            onClick={() => {
              setHistory(false);
              useApp.getState().set({ bottom: "changes" });
            }}
          >
            Changes
          </button>
          <button
            role="tab"
            aria-selected={history}
            className={history ? "active" : ""}
            onClick={() => {
              setHistory(true);
              useApp.getState().set({ bottom: "history" });
            }}
          >
            History
          </button>
        </div>
      </DockHeader>
      <div className="tool-surface" hidden={history}>
        <GitPanel active={visible && !history} />
      </div>
      {history && (
        <div className="tool-surface">
          <GitPanel history active={visible && history} />
        </div>
      )}
    </div>
  );
}
