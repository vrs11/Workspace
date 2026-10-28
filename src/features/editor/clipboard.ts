import type { Uri } from "monaco-editor";
import { call, rpc } from "../../shared/ipc/client";
// A desktop clipboard service avoids browser permission popovers, including
// WebKit's asynchronous write-on-every-keydown workaround. Resources/find text
// are transient editor metadata; neither is persisted or treated as file input.
let findText = "";
let resources: Uri[] = [];
let resourceText = "";
const typedText = new Map<string, string>();
export const clipboardService = {
  triggerPaste: () => undefined,
  readText: async (type?: string) =>
    type
      ? (typedText.get(type) ?? "")
      : (await call({ type: "clipboardRead" }, "text")).text,
  writeText: async (text: string, type?: string) => {
    resources = [];
    if (type) typedText.set(type, text);
    else await rpc({ type: "clipboardWrite", text });
  },
  readFindText: async () => findText,
  writeFindText: async (text: string) => {
    findText = text;
  },
  readResources: async () => {
    if (!resources.length) return [];
    const text = (await call({ type: "clipboardRead" }, "text")).text;
    return text === resourceText ? resources : [];
  },
  writeResources: async (value: Uri[]) => {
    resources = [...value];
    resourceText = (await call({ type: "clipboardRead" }, "text")).text;
  },
  hasResources: async () => resources.length > 0,
  clearInternalState: () => {
    resources = [];
    typedText.clear();
    findText = "";
    resourceText = "";
  },
};
