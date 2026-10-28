import { viewOperation } from "../workspace/viewResources";
import { languageFor } from "./languages";
import { useEffect, useRef, useState } from "react";
import type { Diff } from "../../generated/protocol";
import { useApp, perform } from "../../shared/state/store";
import { rpc, errorText } from "../../shared/ipc/client";
import { loadDocument } from "./models";
import { saveBeforeAction } from "./autosave";
import { installEditorInteractions } from "./interactions";
import { rememberEditorFile } from "../../shared/fileTargets";
export default function DiffEditor({
  diff,
  staged,
}: {
  diff: Diff;
  staged: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inline, setInline] = useState(false);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const theme = useApp((s) => s.settings?.theme);
  useEffect(() => {
    setReady(false);
    setFailure("");
    let gone = false;
    let dispose: (() => void) | undefined;
    void import("./monaco")
      .then(({ monaco }) => {
        if (gone || !ref.current) return;
        const original = monaco.editor.createModel(
          diff.base,
          languageFor(monaco, diff.path, diff.base),
        );
        const modified = monaco.editor.createModel(
          diff.next,
          languageFor(monaco, diff.path, diff.next),
        );
        dispose = () => {
          original.dispose();
          modified.dispose();
        };
        const editor = monaco.editor.createDiffEditor(ref.current, {
          automaticLayout: true,
          readOnly: true,
          renderSideBySide: !inline,
          theme: theme === "light" ? "vs" : "vs-dark",
          minimap: { enabled: false },
          fixedOverflowWidgets: true,
          useShadowDOM: false,
        });
        const originalInteractions = installEditorInteractions(
          editor.getOriginalEditor(),
          monaco,
        );
        const modifiedInteractions = installEditorInteractions(
          editor.getModifiedEditor(),
          monaco,
        );
        const updated = editor.onDidUpdateDiff(() => {
          if (!gone) {
            editor.getOriginalEditor().render(true);
            editor.getModifiedEditor().render(true);
            setReady(true);
          }
        });
        dispose = () => {
          updated.dispose();
          originalInteractions();
          modifiedInteractions();
          editor.dispose();
          original.dispose();
          modified.dispose();
        };
        try {
          editor.setModel({ original, modified });
        } catch (error) {
          dispose();
          dispose = undefined;
          throw error;
        }
      })
      .catch((error: unknown) => {
        dispose?.();
        dispose = undefined;
        if (!gone) {
          ref.current?.replaceChildren();
          setFailure(errorText(error));
        }
      });
    return () => {
      gone = true;
      dispose?.();
    };
  }, [diff, inline, theme]);
  return (
    <div className="diff-content">
      <div className="toolbar">
        <strong>
          {diff.baseLabel} ↔ {diff.nextLabel}
        </strong>
        <button onClick={() => setInline(!inline)}>
          {inline ? "Side by side" : "Inline"}
        </button>
        <button onClick={() => void perform(() => loadDocument(diff.entry))}>
          Edit file
        </button>
      </div>
      <div
        className="editor-surface"
        ref={ref}
        onFocusCapture={() => rememberEditorFile(diff.entry)}
      />
      {failure && <p role="alert">Could not open comparison: {failure}</p>}
      <div className="hunk-bar">
        {diff.hunkUnavailable ? (
          <span>{diff.hunkUnavailable}</span>
        ) : (
          diff.hunks.map((_h, i) => (
            <button
              key={i}
              disabled={!ready || !!failure}
              onClick={() =>
                void perform(() => {
                  const scope = useApp.getState().project!.id;
                  return viewOperation(scope, diff.id, async () => {
                    await saveBeforeAction();
                    await rpc({
                      type: "gitHunk",
                      scope,
                      diff: diff.id,
                      hunk: i,
                      unstage: staged,
                    });
                    window.dispatchEvent(new Event("workspace-refresh"));
                  });
                })
              }
            >
              {staged ? "Unstage" : "Stage"} hunk {i + 1}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
