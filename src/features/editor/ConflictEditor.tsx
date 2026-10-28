import { useState } from "react";
import type { Diff } from "../../generated/protocol";
import { useApp, perform } from "../../shared/state/store";
import { call, rpc } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";
import DiffEditor from "./DiffEditor";
import Editor from "./Editor";
import { disposeModel, loadDocument, saveDocument } from "./models";
export default function ConflictEditor({ diff }: { diff: Diff }) {
  const [reviewed, setReviewed] = useState(false);
  const scope = useApp.getState().project!.id;
  return (
    <div className="conflict-editor">
      <div className="toolbar">
        <strong>Baseline · disk · your editable buffer</strong>
        <button
          onClick={() =>
            void perform(async () => {
              const r = await call(
                {
                  type: "reviewDisk",
                  scope,
                  document: diff.entry,
                  reviewed: diff.id,
                },
                "saved",
              );
              useApp.getState().doc(diff.entry, {
                baseline: r.baseline,
                readonly: null,
                conflict: true,
              });
              setReviewed(true);
            })
          }
        >
          I reviewed this disk version
        </button>
        <button
          disabled={!reviewed}
          onClick={() =>
            void perform(async () => {
              if (
                await ask({
                  title: "Save local / merged result",
                  description:
                    "Replace the reviewed disk version with the editable local buffer. Another disk change will still block this save.",
                  choices: ["Save reviewed result"],
                })
              )
                await saveDocument(diff.entry);
            })
          }
        >
          Save local / merged result
        </button>
        <button
          onClick={() =>
            void perform(async () => {
              if (
                !(await ask({
                  title: "Keep disk and discard local",
                  description:
                    "Discard the unsaved local buffer and its recovery copy after review.",
                  choices: ["Keep disk"],
                }))
              )
                return;
              await rpc({ type: "discard", scope, document: diff.entry });
              disposeModel(diff.entry);
              await loadDocument(diff.entry);
            })
          }
        >
          Keep disk
        </button>
      </div>
      <div className="conflict-comparison">
        <DiffEditor diff={diff} staged={false} />
      </div>
      <div className="section-title">LOCAL BUFFER — MANUAL MERGE RESULT</div>
      <div className="conflict-result">
        <Editor entry={diff.entry} />
      </div>
    </div>
  );
}
