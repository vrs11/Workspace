import type * as Monaco from "monaco-editor";
import { call } from "../../shared/ipc/client";
import { useApp } from "../../shared/state/store";

export function editorViewOptions(): Monaco.editor.IEditorOptions {
  const settings = useApp.getState().settings;
  return {
    wordWrap: settings?.editorSoftWrap ? "on" : "off",
    lineNumbers: settings?.editorLineNumbers === false ? "off" : "on",
  };
}
let saving: Promise<unknown> = Promise.resolve();
export function setEditorOption(
  option: "softWrap" | "lineNumbers",
  value: boolean,
) {
  const operation = saving
    .catch(() => {})
    .then(async () => {
      const result = await call(
        {
          type: "editorOptions",
          soft_wrap: option === "softWrap" ? value : null,
          line_numbers: option === "lineNumbers" ? value : null,
        },
        "bootstrap",
      );
      useApp.getState().set({ settings: result.settings });
    });
  saving = operation;
  return operation;
}

export function installGutterMenu(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  open: (point: { x: number; y: number }) => void,
) {
  const container = editor.getContainerDomNode();
  const handler = (event: MouseEvent) => {
    if (useApp.getState().settings?.editorLineNumbers === false) return;
    if (
      editor.getTargetAtClientPoint(event.clientX, event.clientY)?.type !==
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    open({ x: event.clientX, y: event.clientY });
  };
  container.addEventListener("contextmenu", handler, true);
  return () => container.removeEventListener("contextmenu", handler, true);
}
