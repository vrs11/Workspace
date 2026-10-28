import { useState } from "react";
import type { Diff, GitConflict } from "../../generated/protocol";
import { useApp, perform, notice } from "../../shared/state/store";
import { rpc } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";
import { models, saveDocument } from "../editor/models";
import Editor from "../editor/Editor";
import DiffEditor from "../editor/DiffEditor";
export default function GitConflictEditor({
  conflict,
}: {
  conflict: GitConflict;
}) {
  const [view, setView] = useState("current");
  const diff: Diff = {
    id: conflict.reviewed,
    entry: conflict.entry,
    path: conflict.path,
    baseLabel:
      view === "compare" ? "INDEX STAGE 2 — CURRENT" : "INDEX STAGE 1 — BASE",
    nextLabel:
      view === "current"
        ? "INDEX STAGE 2 — CURRENT"
        : "INDEX STAGE 3 — INCOMING",
    base: view === "compare" ? conflict.current : conflict.base,
    next: view === "current" ? conflict.current : conflict.incoming,
    hunks: [],
    hunkUnavailable:
      "Git index stages are labelled literally. During rebase, current/incoming may differ from branch-name expectations. An absent stage is shown empty.",
  };
  async function take(text: string, label: string) {
    if (
      await ask({
        title: `Use ${label} as result`,
        description:
          "Replace the editable result buffer with this index stage? Editor undo remains available. Saving and staging are separate explicit actions.",
        choices: ["Use reviewed stage"],
      })
    )
      models.get(conflict.entry)?.model.setValue(text);
  }
  return (
    <div className="conflict-editor git-conflict-editor">
      <div className="toolbar">
        <strong>Resolve {conflict.path}</strong>
        <label>
          Compare
          <select value={view} onChange={(e) => setView(e.target.value)}>
            <option value="current">Base → current</option>
            <option value="incoming">Base → incoming</option>
            <option value="compare">Current → incoming</option>
          </select>
        </label>
        <button
          onClick={() => void perform(() => take(conflict.current, "current"))}
        >
          Use current
        </button>
        <button
          onClick={() =>
            void perform(() => take(conflict.incoming, "incoming"))
          }
        >
          Use incoming
        </button>
        <button
          onClick={() =>
            void perform(async () => {
              const scope = useApp.getState().project?.id;
              if (!scope) return;
              if (
                !(await ask({
                  title: "Save and stage reviewed resolution",
                  description:
                    "Review the editable result, including any remaining conflict markers. Save this file and stage its current contents as the explicit resolution? An index change since this review will refuse staging.",
                  choices: ["Save and stage resolution"],
                }))
              )
                return;
              await saveDocument(conflict.entry);
              await rpc({
                type: "gitResolve",
                scope,
                entry: conflict.entry,
                reviewed: conflict.reviewed,
              });
              notice(
                "Reviewed conflict resolution saved and staged. Commit separately.",
              );
              window.dispatchEvent(new Event("workspace-refresh"));
            })
          }
        >
          Save and stage resolution
        </button>
      </div>
      <div className="conflict-comparison">
        <DiffEditor diff={diff} staged={false} />
      </div>
      <div className="section-title">
        EDITABLE WORKING RESULT · Staging requires explicit review
      </div>
      <div className="conflict-result">
        <Editor entry={conflict.entry} />
      </div>
    </div>
  );
}
