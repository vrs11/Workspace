import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { installEditorKeymap } from "./keymap";
import { registerLanguages } from "./languages";
import { clipboardService } from "./clipboard";
import { editorLayoutService } from "./interactions";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
self.MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === "json"
      ? new JsonWorker()
      : ["css", "scss", "less"].includes(label)
        ? new CssWorker()
        : ["html", "handlebars", "razor"].includes(label)
          ? new HtmlWorker()
          : ["typescript", "javascript"].includes(label)
            ? new TsWorker()
            : new EditorWorker(),
};
const monaco = await import("monaco-editor");
// Load every standalone contribution before freezing the service collection,
// then override clipboard access before creating any model/editor. Initializing
// earlier omits the diff-provider service registered by editor.main.
StandaloneServices.initialize({
  clipboardService,
  layoutService: editorLayoutService(() => {
    monaco.editor
      .getEditors()
      .find((editor) => editor.hasWidgetFocus())
      ?.focus();
  }),
});
registerLanguages(monaco);
const disposeKeymap = installEditorKeymap(monaco);
if (import.meta.hot) import.meta.hot.dispose(disposeKeymap);
export { monaco };
