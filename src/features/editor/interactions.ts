import { bindingsFor } from "../../shared/keymap";
import { actionBindings } from "./keymap";
import type * as Monaco from "monaco-editor";
import { useApp } from "../../shared/state/store";
import { registerSelectionReader } from "../../shared/selection";

// All editors share the application viewport for transient widgets. Dock panes
// deliberately clip their own contents; a tooltip must not inherit that clip.
export function editorLayoutService(focus: () => void) {
  const noEvent = () => ({ dispose() {} });
  return {
    get mainContainer() {
      return document.body;
    },
    get activeContainer() {
      return document.body;
    },
    get containers() {
      return [document.body];
    },
    get mainContainerDimension() {
      return { width: window.innerWidth, height: window.innerHeight };
    },
    get activeContainerDimension() {
      return { width: window.innerWidth, height: window.innerHeight };
    },
    mainContainerOffset: { top: 0, quickPickTop: 0 },
    activeContainerOffset: { top: 0, quickPickTop: 0 },
    onDidLayoutMainContainer: noEvent,
    onDidLayoutActiveContainer: noEvent,
    onDidLayoutContainer: noEvent,
    onDidChangeActiveContainer: noEvent,
    onDidAddContainer: noEvent,
    getContainer: () => document.body,
    whenContainerStylesLoaded() {},
    focus,
  };
}

export function installEditorInteractions(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
) {
  const container = editor.getContainerDomNode();
  const disposables: Monaco.IDisposable[] = [];
  const stopSelection = registerSelectionReader(() => {
    if (!editor.hasTextFocus()) return null;
    const selection = editor.getSelection();
    return selection
      ? (editor.getModel()?.getValueInRange(selection) ?? "")
      : "";
  });
  const selectMatches = () => {
    editor.trigger("workspace", "editor.action.selectAllMatches", null);
    editor.trigger("workspace", "closeFindWidget", null);
    editor.focus();
  };
  const all = () => {
    if (container.querySelector(".find-widget.visible")) selectMatches();
    else editor.trigger("workspace", "editor.action.selectHighlights", null);
  };
  let actions: Monaco.IDisposable[] = [];
  const bindActions = () => {
    actions.forEach((action) => action.dispose());
    actions = [];
    actions.push(
      editor.addAction({
        id: "workspace.selectAllOccurrences",
        label: "Select All Occurrences",
        keybindings: actionBindings(
          monaco,
          "monaco:workspace.selectAllOccurrences",
        ),
        keybindingContext: "editorFocus",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 5,
        run: all,
      }),
    );
    actions.push(
      editor.addAction({
        id: "workspace.selectNextOccurrence",
        label: "Add Selection for Next Occurrence",
        keybindings: actionBindings(
          monaco,
          "monaco:workspace.selectNextOccurrence",
        ),
        keybindingContext: "editorTextFocus",
        contextMenuGroupId: "1_modification",
        contextMenuOrder: 4,
        run: () =>
          editor.trigger(
            "workspace",
            "editor.action.addSelectionToNextFindMatch",
            null,
          ),
      }),
    );
    actions.push(
      editor.addAction({
        id: "workspace.deselectLastOccurrence",
        label: "Deselect Last Occurrence",
        keybindings: actionBindings(
          monaco,
          "monaco:workspace.deselectLastOccurrence",
        ),
        keybindingContext: "editorTextFocus",
        run: () => {
          const selections = editor.getSelections();
          if (selections && selections.length > 1)
            editor.setSelections(selections.slice(0, -1));
        },
      }),
    );
  };
  bindActions();
  const unsubscribeKeys = useApp.subscribe((next, before) => {
    if (next.settings?.keybindings !== before.settings?.keybindings)
      bindActions();
  });
  disposables.push({
    dispose: () => {
      unsubscribeKeys();
      actions.forEach((action) => action.dispose());
    },
  });
  const caretClick = (event: MouseEvent) => {
    if (!event.altKey || !event.shiftKey || event.button !== 0) return;
    const target = editor.getTargetAtClientPoint(event.clientX, event.clientY);
    if (
      !target?.position ||
      ![
        monaco.editor.MouseTargetType.CONTENT_TEXT,
        monaco.editor.MouseTargetType.CONTENT_EMPTY,
      ].includes(target.type)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selections = editor.getSelections() ?? [];
    const position = target.position;
    const remaining = selections.filter(
      (selection) => !selection.getPosition().equals(position),
    );
    editor.setSelections(
      remaining.length !== selections.length && remaining.length
        ? remaining
        : [
            ...selections,
            new monaco.Selection(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          ],
    );
    editor.focus();
  };
  container.addEventListener("pointerdown", caretClick, true);
  container.addEventListener("mousedown", caretClick, true);
  let button: HTMLButtonElement | undefined;
  let visibility: MutationObserver | undefined;
  const bind = () => {
    const actions = container.querySelector(".find-widget .find-actions");
    if (!actions || button) return;
    button = document.createElement("button");
    button.type = "button";
    button.className =
      "button codicon codicon-selection workspace-select-matches";
    button.title = `Select all matches as cursors (${bindingsFor("monaco:workspace.selectAllOccurrences").join("; ")})`;
    button.setAttribute("aria-label", "Select all matches as cursors");
    button.addEventListener("click", selectMatches);
    actions.append(button);
    const widget = actions.closest(".find-widget")!;
    const updateVisibility = () => {
      const visible = widget.getAttribute("aria-hidden") === "false";
      button!.disabled = !visible;
      button!.tabIndex = visible ? 0 : -1;
    };
    visibility = new MutationObserver(updateVisibility);
    visibility.observe(widget, {
      attributes: true,
      attributeFilter: ["aria-hidden"],
    });
    updateVisibility();
    observer.disconnect();
  };
  const observer = new MutationObserver(bind);
  observer.observe(container, { childList: true, subtree: true });
  bind();
  disposables.push(
    editor.onDidChangeCursorSelection(() => {
      const selections = editor.getSelections() ?? [];
      const position = editor.getPosition();
      if (position)
        useApp.getState().set({
          cursor:
            selections.length > 1
              ? `${selections.length} carets`
              : `Ln ${position.lineNumber}, Col ${position.column}`,
        });
    }),
  );
  return () => {
    stopSelection();
    observer.disconnect();
    visibility?.disconnect();
    button?.remove();
    container.removeEventListener("pointerdown", caretClick, true);
    container.removeEventListener("mousedown", caretClick, true);
    disposables.forEach((item) => item.dispose());
  };
}
