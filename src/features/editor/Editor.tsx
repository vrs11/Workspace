import { memo } from "react";
import { useEffect, useRef } from "react";
import { useApp } from "../../shared/state/store";
import { models } from "./models";
import { leaseEditorView } from "./viewPool";
import { rememberEditorFile } from "../../shared/fileTargets";
const views = new Map<
  string,
  import("monaco-editor").editor.ICodeEditorViewState
>();
function Editor({
  entry,
  group = "primary",
}: {
  entry: string;
  group?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<
    import("monaco-editor").editor.IStandaloneCodeEditor | null
  >(null);
  const theme = useApp((s) => s.settings?.theme);
  const font = useApp((s) => s.settings?.fontSize);
  const readonly = useApp((s) => s.docs[entry]?.readonly);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("./monaco").then(({ monaco }) => {
      const model = models.get(entry)?.model;
      if (disposed || !ref.current || !model) return;
      const current = useApp.getState();
      if (!current.project) return;
      const lease = leaseEditorView(
        current.project.id,
        group,
        monaco,
        ref.current,
        {
          model,
          automaticLayout: true,
          theme: current.settings?.theme === "light" ? "vs" : "vs-dark",
          fontSize: current.settings?.fontSize,
          minimap: { enabled: false },
          readOnly: !!current.docs[entry]?.readonly,
          scrollBeyondLastLine: false,
          wordWrap: "off",
          accessibilitySupport: "auto",
          largeFileOptimizations: true,
          fixedOverflowWidgets: true,
          // Standalone theme variables do not cross the body-level menu's
          // shadow boundary. Keep overflow widgets in the themed document.
          useShadowDOM: false,
          multiCursorModifier: "alt",
        },
      );
      const editor = lease.editor;
      instance.current = editor;
      monaco.editor.setTheme(
        current.settings?.theme === "light" ? "vs" : "vs-dark",
      );
      const key = `${entry}:${group}`;
      const view = views.get(key);
      if (view) editor.restoreViewState(view);
      const target = useApp.getState().navigate;
      if (target?.entry === entry) {
        editor.setPosition({
          lineNumber: Math.min(target.line, model.getLineCount()),
          column: 1,
        });
        editor.revealLineInCenter(target.line);
        useApp.getState().set({ navigate: null });
      }
      const focus = (event: Event) => {
        if ((event as CustomEvent<string>).detail === group) editor.focus();
      };
      let reloaded: import("monaco-editor").editor.ICodeEditorViewState | null =
        null;
      const beforeReload = (e: Event) => {
        if ((e as CustomEvent<string>).detail === entry)
          reloaded = editor.saveViewState();
      };
      const afterReload = (e: Event) => {
        if ((e as CustomEvent<string>).detail === entry && reloaded)
          editor.restoreViewState(reloaded);
      };
      window.addEventListener("editor-before-reload", beforeReload);
      window.addEventListener("editor-after-reload", afterReload);
      window.addEventListener("editor-focus", focus);
      // Lazy creation can finish after the user has opened another control.
      if (
        !document.querySelector('.dialog-content[role="dialog"], [role="menu"]')
      )
        editor.focus();
      // An editor can finish loading while its portal host is being attached.
      // Render once at the actual layout size; do not wait for a mouse event to
      // make the first lines visible in a freshly shown native WebView.
      editor.layout();
      editor.render(true);
      cleanup = () => {
        if (instance.current === editor) instance.current = null;
        const view = editor.saveViewState();
        if (view) {
          if (views.size > 200) views.clear();
          views.set(key, view);
        }
        window.removeEventListener("editor-before-reload", beforeReload);
        window.removeEventListener("editor-after-reload", afterReload);
        window.removeEventListener("editor-focus", focus);
        lease.release();
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [entry, group]);
  useEffect(() => {
    const editor = instance.current;
    if (editor) {
      editor.updateOptions({ fontSize: font, readOnly: !!readonly });
      void import("./monaco").then(({ monaco }) =>
        monaco.editor.setTheme(theme === "light" ? "vs" : "vs-dark"),
      );
    }
  }, [font, readonly, theme]);
  return (
    <div
      ref={ref}
      className="editor-surface"
      onFocusCapture={() => rememberEditorFile(entry)}
      aria-label={`Editor ${useApp.getState().docs[entry]?.name ?? ""}`}
    />
  );
}

export default memo(Editor);
