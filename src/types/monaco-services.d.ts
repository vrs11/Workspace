// Monaco 0.57's pinned standalone service initializer has no published d.ts.
// Keep the narrow internal boundary here; Vite resolves the actual module.
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    initialize(overrides: Record<string, unknown>): unknown;
    get<T>(id: unknown): T;
  };
}
declare module "monaco-editor/platform/keybinding/common/keybinding.js" {
  export const IKeybindingService: unknown;
}
declare module "monaco-editor/platform/keybinding/common/keybindingsRegistry.js" {
  export const KeybindingsRegistry: {
    getDefaultKeybindings(): {
      command: string | null;
      keybinding: unknown;
      commandArgs?: unknown;
      when?: { serialize(): string };
    }[];
  };
}
declare module "monaco-editor/editor/browser/editorExtensions.js" {
  export const EditorExtensionsRegistry: {
    getEditorActions(): {
      id: string;
      label: string;
      precondition?: { serialize(): string };
    }[];
  };
}
