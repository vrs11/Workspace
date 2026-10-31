import { useEffect, useRef, useState } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import type {
  GitBlame,
  BlameCommit,
  BlameLine,
} from "../../generated/protocol";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";
import { useApp, perform } from "../../shared/state/store";
import { useDockVisible } from "../workspace/DockWorkspace";
import { monaco } from "./monaco";

type Row = { line: BlameLine; top: number; height: number };
const uncommitted = (commit: BlameCommit) => /^0+$/.test(commit.id);
const dates = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function date(commit: BlameCommit) {
  const value = new Date(commit.timestamp * 1000);
  return Number.isNaN(value.getTime()) ? "" : dates.format(value);
}
export function blameDescription(commit: BlameCommit, line: BlameLine) {
  return uncommitted(commit)
    ? "Uncommitted changes"
    : `${commit.author}${commit.email ? ` <${commit.email}>` : ""}\n${date(commit)} · ${commit.id}\n${commit.summary}\nOriginal line ${line.originalLine}`;
}
export default function BlameGutter({
  entry,
  editor,
}: {
  entry: string;
  editor: MonacoEditor.IStandaloneCodeEditor;
}) {
  const [result, setResult] = useState<GitBlame | null>(null);
  const [status, setStatus] = useState("Loading annotations…");
  const [retry, setRetry] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [font, setFont] = useState(14);
  const [lineHeight, setLineHeight] = useState(20);
  const gutter = useRef<HTMLElement>(null);
  const visible = useDockVisible();
  const scope = useApp((s) => s.project?.id);
  const trusted = useApp((s) => !!s.project?.trusted);
  const git = useApp((s) => s.settings?.git);
  const currentResult = useRef(result);
  currentResult.current = result;
  useEffect(() => {
    const element = gutter.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? lineHeight
          : event.deltaMode === 2
            ? editor.getLayoutInfo().height
            : 1;
      editor.setScrollTop(editor.getScrollTop() + event.deltaY * unit);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [editor, lineHeight]);
  useEffect(() => {
    const model = editor.getModel();
    if (!scope || !model || !visible || !trusted || !git) {
      setResult(null);
      setStatus(
        !trusted
          ? "Trust this project to use Git blame."
          : !git
            ? "Configure Git in Settings."
            : "",
      );
      return;
    }
    let gone = false,
      running = false,
      queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const valid = () =>
      !gone &&
      editor.getModel() === model &&
      useApp.getState().project?.id === scope &&
      useApp.getState().project?.trusted;
    const load = async () => {
      if (!valid()) return;
      if (running) {
        queued = true;
        return;
      }
      if (
        model.getValueLength() > 2 * 1024 * 1024 ||
        model.getLineCount() > 100_000
      ) {
        setStatus("Blame supports files up to 2 MiB and 100,000 lines.");
        return;
      }
      running = true;
      queued = false;
      const version = model.getVersionId();
      setStatus("Loading annotations…");
      try {
        const response = await call(
          { type: "gitBlame", scope, entry, text: model.getValue() },
          "gitBlame",
        );
        if (
          valid() &&
          model.getVersionId() === version &&
          response.blame.entry === entry
        ) {
          setResult(response.blame);
          setStatus(response.blame.lines.length ? "" : "No lines to annotate.");
        }
      } catch (error) {
        if (valid() && model.getVersionId() === version) {
          setResult(null);
          setStatus(errorText(error));
        }
      } finally {
        running = false;
        if (queued && valid()) {
          clearTimeout(timer);
          timer = setTimeout(() => void load(), 400);
        }
      }
    };
    const schedule = () => {
      // Remove obsolete attribution immediately; never label new text using an
      // old version while Git is computing its replacement.
      setResult(null);
      setStatus("Updating annotations…");
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const changed = model.onDidChangeContent(schedule);
    window.addEventListener("workspace-refresh", schedule);
    window.addEventListener("focus", schedule);
    void load();
    return () => {
      gone = true;
      clearTimeout(timer);
      changed.dispose();
      window.removeEventListener("workspace-refresh", schedule);
      window.removeEventListener("focus", schedule);
    };
  }, [entry, editor, scope, visible, trusted, git, retry]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const blame = currentResult.current;
      if (!blame) {
        setRows([]);
        return;
      }
      const height = editor.getLayoutInfo().height;
      const scroll = editor.getScrollTop();
      const ranges = editor.getVisibleRanges();
      const next: Row[] = [];
      for (const range of ranges) {
        for (
          let number = range.startLineNumber;
          number <= range.endLineNumber && next.length < 500;
          number++
        ) {
          const line = blame.lines[number - 1];
          if (!line) continue;
          const top = editor.getTopForLineNumber(number) - scroll;
          const bottom = editor.getBottomForLineNumber(number) - scroll;
          if (bottom >= 0 && top <= height)
            next.push({ line, top, height: bottom - top });
        }
      }
      setFont(useApp.getState().settings?.fontSize ?? 14);
      setLineHeight(editor.getOption(monaco.editor.EditorOption.lineHeight));
      setRows(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const listeners = [
      editor.onDidScrollChange(schedule),
      editor.onDidLayoutChange(schedule),
      editor.onDidChangeConfiguration(schedule),
    ];
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      listeners.forEach((item) => item.dispose());
    };
  }, [editor, result]);
  return (
    <aside
      ref={gutter}
      className="blame-gutter"
      aria-label="Git blame annotations"
      style={{ fontSize: font }}
    >
      {status ? (
        <div className="blame-status" role="status">
          {status}
          {!status.endsWith("…") && (
            <button onClick={() => setRetry((value) => value + 1)}>
              Retry
            </button>
          )}
        </div>
      ) : null}
      {result &&
        rows.map(({ line: geometry, top, height }) => {
          const line = result.lines[geometry.line - 1];
          if (!line) return null;
          const commit = result.commits[line.commit];
          if (!commit) return null;
          const local = uncommitted(commit);
          return (
            <button
              key={line.line}
              className={`blame-line ${local ? "uncommitted" : ""}`}
              style={{ top, height, lineHeight: `${lineHeight}px` }}
              title={blameDescription(commit, line)}
              aria-label={`Line ${line.line}: ${local ? "Uncommitted changes" : `${commit.author}, ${commit.summary}`}`}
              onClick={() =>
                void perform(async () => {
                  const action = await ask({
                    title: local
                      ? "Uncommitted changes"
                      : commit.summary || "Git blame",
                    description: blameDescription(commit, line),
                    choices: local ? ["Close"] : ["Copy commit hash"],
                  });
                  if (!local && action === "Copy commit hash")
                    await rpc({ type: "clipboardWrite", text: commit.id });
                })
              }
            >
              <span className="blame-author">
                {local ? "Uncommitted" : commit.author}
              </span>
              {!local && <small>{date(commit)}</small>}
            </button>
          );
        })}
    </aside>
  );
}
