import { lazy, Suspense, useLayoutEffect, useRef } from "react";
import { Code, Columns2, BookOpen } from "lucide-react";
import { Group, Panel, useGroupRef } from "react-resizable-panels";
import {
  ResizeSeparator,
  resizeTargetMinimumSize,
} from "../../shared/components/ResizeSeparator";
import { useApp } from "../../shared/state/store";
import { rememberEditorFile } from "../../shared/fileTargets";
import { previewFormat } from "./previewFormat";
import {
  useDocumentViews,
  setDocumentMode,
  type DocumentMode,
} from "./documentViewState";
import Editor from "./Editor";
const DocumentPreview = lazy(() => import("./DocumentPreview"));
const modes = [
  ["code", "Code", Code],
  ["split", "Side by side", Columns2],
  ["rendered", "Rendered", BookOpen],
] as const;
export default function DocumentEditor({
  entry,
  group = "primary",
}: {
  entry: string;
  group?: string;
}) {
  const name = useApp((s) => s.docs[entry]?.name ?? "");
  const mode = useDocumentViews((s) => s.modes[entry] ?? "code");
  const format = previewFormat(name);
  const panels = useGroupRef();
  const split = useRef<Record<string, number>>({ code: 50, rendered: 50 });
  useLayoutEffect(() => {
    if (format)
      panels.current?.setLayout(
        mode === "code"
          ? { code: 100, rendered: 0 }
          : mode === "rendered"
            ? { code: 0, rendered: 100 }
            : split.current,
      );
  }, [mode, format, panels]);
  if (!format) return <Editor entry={entry} group={group} />;
  return (
    <div
      className="document-editor"
      onFocusCapture={() => rememberEditorFile(entry)}
    >
      <div className="document-modes" role="group" aria-label="Document view">
        {modes.map(([value, label, Icon]) => (
          <button
            key={value}
            aria-label={label}
            aria-pressed={mode === value}
            title={label}
            onClick={() => setDocumentMode(entry, value as DocumentMode)}
          >
            <Icon size={14} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <Group
        groupRef={panels}
        className="document-panels"
        orientation="horizontal"
        disableCursor
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        onLayoutChanged={(layout) => {
          if (mode === "split" && layout.code > 0 && layout.rendered > 0)
            split.current = layout;
        }}
      >
        <Panel
          id="code"
          defaultSize={
            mode === "rendered" ? "0%" : mode === "code" ? "100%" : "50%"
          }
          collapsible
          minSize="15%"
          className="document-code"
          inert={mode === "rendered"}
        >
          <Editor entry={entry} group={group} visible={mode !== "rendered"} />
        </Panel>
        {mode === "split" && (
          <ResizeSeparator className="resize-handle document-preview-resize" />
        )}
        <Panel
          id="rendered"
          defaultSize={
            mode === "code" ? "0%" : mode === "rendered" ? "100%" : "50%"
          }
          collapsible
          minSize="15%"
          className="document-rendered"
          inert={mode === "code"}
        >
          {mode !== "code" && (
            <Suspense
              fallback={<div className="empty-state">Loading preview…</div>}
            >
              <DocumentPreview entry={entry} format={format} />
            </Suspense>
          )}
        </Panel>
      </Group>
    </div>
  );
}
