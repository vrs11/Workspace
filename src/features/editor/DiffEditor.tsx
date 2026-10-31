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
import { ArrowUp, ArrowDown } from "lucide-react";
import { shortcutLabel } from "../../shared/keymap";
import type { editor } from "monaco-editor";
import { editorViewOptions, installGutterMenu } from "./viewOptions";
import { GutterContextMenu } from "./EditorViewMenu";
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
  const [hasChanges, setHasChanges] = useState(false);
  const comparison = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [failure, setFailure] = useState("");
  const theme = useApp((s) => s.settings?.theme);
  const softWrap = useApp((s) => s.settings?.editorSoftWrap);
  const numbers = useApp((s) => s.settings?.editorLineNumbers);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setReady(false);
    setHasChanges(false);
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
          ...editorViewOptions(),
          diffWordWrap: useApp.getState().settings?.editorSoftWrap
            ? "on"
            : "off",
        });
        comparison.current = editor;
        const originalInteractions = installEditorInteractions(
          editor.getOriginalEditor(),
          monaco,
        );
        const modifiedInteractions = installEditorInteractions(
          editor.getModifiedEditor(),
          monaco,
        );
        const gutters = [
          editor.getOriginalEditor(),
          editor.getModifiedEditor(),
        ].map((view) => installGutterMenu(view, monaco, setContext));
        const updated = editor.onDidUpdateDiff(() => {
          if (!gone) {
            editor.getOriginalEditor().render(true);
            editor.getModifiedEditor().render(true);
            setReady(true);
            setHasChanges(!!editor.getLineChanges()?.length);
          }
        });
        dispose = () => {
          updated.dispose();
          originalInteractions();
          modifiedInteractions();
          gutters.forEach((stop) => stop());
          editor.dispose();
          if (comparison.current === editor) comparison.current = null;
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
  useEffect(() => {
    comparison.current?.updateOptions({
      ...editorViewOptions(),
      diffWordWrap: softWrap ? "on" : "off",
    });
  }, [softWrap, numbers]);
  const navigate = (direction: "next" | "previous") => {
    comparison.current?.goToDiff(direction);
    comparison.current?.getModifiedEditor().focus();
  };
  useEffect(() => {
    const command = (event: Event) => {
      if (
        !ref.current?.closest(".diff-content")?.contains(document.activeElement)
      )
        return;
      const id = (event as CustomEvent<string>).detail;
      if (id !== "diff.nextChange" && id !== "diff.previousChange") return;
      event.preventDefault();
      if (ready && hasChanges)
        navigate(id === "diff.nextChange" ? "next" : "previous");
    };
    window.addEventListener("workspace-command", command);
    return () => window.removeEventListener("workspace-command", command);
  }, [ready, hasChanges]);
  return (
    <div className="diff-content">
      <div className="toolbar">
        <strong>
          {diff.baseLabel} ↔ {diff.nextLabel}
        </strong>
        <button
          aria-label="Previous change"
          title={`Previous change (${shortcutLabel("diff.previousChange")})`}
          disabled={!ready || !hasChanges || !!failure}
          onClick={() => navigate("previous")}
        >
          <ArrowUp size={15} />
        </button>
        <button
          aria-label="Next change"
          title={`Next change (${shortcutLabel("diff.nextChange")})`}
          disabled={!ready || !hasChanges || !!failure}
          onClick={() => navigate("next")}
        >
          <ArrowDown size={15} />
        </button>
        <button onClick={() => setInline(!inline)}>
          {inline ? "Side by side" : "Inline"}
        </button>
        <button onClick={() => void perform(() => loadDocument(diff.entry))}>
          Edit file
        </button>
      </div>
      <GutterContextMenu
        point={context}
        onClose={() => setContext(null)}
        onFocus={() => comparison.current?.getModifiedEditor().focus()}
      />
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
