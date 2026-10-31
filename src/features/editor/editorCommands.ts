import { useApp, notice, reportError } from "../../shared/state/store";
import { activeFileEntry } from "../../shared/fileTargets";
import { setEditorOption } from "./viewOptions";
import {
  setBlame,
  setDocumentMode,
  useDocumentViews,
  type DocumentMode,
} from "./documentViewState";
import { previewFormat } from "./previewFormat";
export const editorCommandLabels = [
  ["editor.softWrap", "Toggle soft wrap"],
  ["editor.lineNumbers", "Show / hide line numbers"],
  ["editor.blame", "Show / hide Git blame"],
  ["preview.code", "Document: Code"],
  ["preview.split", "Document: Side by side"],
  ["preview.rendered", "Document: Rendered"],
] as const;
export async function runEditorCommand(id: string) {
  if (!editorCommandLabels.some(([command]) => command === id)) return;
  const state = useApp.getState();
  if (id === "editor.softWrap")
    return setEditorOption("softWrap", !state.settings?.editorSoftWrap);
  if (id === "editor.lineNumbers")
    return setEditorOption(
      "lineNumbers",
      state.settings?.editorLineNumbers === false,
    );
  const entry = activeFileEntry();
  const document = entry ? state.docs[entry] : undefined;
  if (
    (id === "editor.blame" || id.startsWith("preview.")) &&
    state.tabs.find((tab) => tab.id === state.active)?.kind === "diff" &&
    entry !== state.split
  ) {
    notice("Open the working file with Edit file to use this view.");
    return;
  }
  if (!entry || !document) {
    notice("Open a text file first.");
    return;
  }
  if (id === "editor.blame") {
    if (useDocumentViews.getState().blame[entry]) {
      setBlame(entry, false);
      return;
    }
    if (!state.project?.trusted || !state.settings?.git) {
      notice("Trust this project and configure Git in Settings to use blame.");
      return;
    }
    setBlame(entry, true);
  } else if (id.startsWith("preview.")) {
    if (!previewFormat(document.name)) {
      notice(
        "Rendered view is available for Markdown, HTML, CSV and TSV files.",
      );
      return;
    }
    setDocumentMode(entry, id.slice(8) as DocumentMode);
  }
}
export function installEditorCommands() {
  const handle = (event: Event) => {
    const id = (event as CustomEvent<string>).detail;
    if (!editorCommandLabels.some(([command]) => command === id)) return;
    if (document.querySelector('.dialog-content[role="dialog"]')) return;
    event.preventDefault();
    void runEditorCommand(id).catch(reportError);
  };
  window.addEventListener("workspace-command", handle);
  return () => window.removeEventListener("workspace-command", handle);
}
