import type * as Monaco from "monaco-editor";
import { useApp } from "../../shared/state/store";
import { installEditorInteractions } from "./interactions";

type View = {
  scope: string;
  host: HTMLDivElement;
  editor: Monaco.editor.IStandaloneCodeEditor;
  interactions: () => void;
  lease?: symbol;
};
// At most one empty, reusable view per editor group. Models still close normally;
// retaining a view must never retain a closed file or its language worker mirror.
const pool = new Map<string, View>();
function dispose(view: View) {
  view.interactions();
  view.editor.dispose();
  view.host.remove();
}
function clear() {
  for (const view of pool.values()) dispose(view);
  pool.clear();
}
const unsubscribe = useApp.subscribe((state, previous) => {
  if (state.project?.id !== previous.project?.id) clear();
});
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribe();
    clear();
  });
export function leaseEditorView(
  scope: string,
  group: string,
  monaco: typeof Monaco,
  container: HTMLElement,
  options: Monaco.editor.IStandaloneEditorConstructionOptions,
) {
  let view = pool.get(group);
  if (view && view.scope !== scope) {
    dispose(view);
    pool.delete(group);
    view = undefined;
  }
  if (!view) {
    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    container.appendChild(host);
    const editor = monaco.editor.create(host, { ...options, model: null });
    view = {
      scope,
      host,
      editor,
      interactions: installEditorInteractions(editor, monaco),
    };
    pool.set(group, view);
  }
  const current = view;
  container.appendChild(current.host);
  const lease = Symbol(group);
  current.lease = lease;
  current.editor.updateOptions({
    fontSize: options.fontSize,
    readOnly: options.readOnly,
    wordWrap: options.wordWrap,
    lineNumbers: options.lineNumbers,
  });
  current.editor.setModel(options.model ?? null);
  return {
    host: current.host,
    editor: current.editor,
    release() {
      if (pool.get(group) !== current || current.lease !== lease) return;
      current.lease = undefined;
      current.editor.setModel(null);
      current.host.remove();
    },
  };
}
