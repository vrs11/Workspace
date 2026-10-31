import { afterEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { useApp } from "../../src/shared/state/store";
import { leaseEditorView } from "../../src/features/editor/viewPool";
import { installEditorInteractions } from "../../src/features/editor/interactions";
vi.mock("../../src/features/editor/interactions", () => ({
  installEditorInteractions: vi.fn(() => vi.fn()),
}));
const scope = { id: "p", root: "/fixture", name: "fixture", trusted: true };
function fixture() {
  useApp.setState({ project: scope });
  const editor = {
    setModel: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
  };
  const create = vi
    .fn<typeof Monaco.editor.create>()
    .mockReturnValue(editor as unknown as Monaco.editor.IStandaloneCodeEditor);
  return {
    editor,
    create,
    monaco: { editor: { create } } as unknown as typeof Monaco,
  };
}
afterEach(() => {
  useApp.setState({ project: null });
  vi.clearAllMocks();
});
it("reuses an empty view while releasing closed models and detaching its DOM", () => {
  const f = fixture(),
    a = {} as Monaco.editor.ITextModel,
    b = {} as Monaco.editor.ITextModel;
  const first = leaseEditorView("p", "primary", f.monaco, document.body, {
    model: a,
    fontSize: 14,
  });
  document.body.append(first.host);
  expect(f.create.mock.calls[0][1]?.model).toBeNull();
  first.release();
  expect(first.host.isConnected).toBe(false);
  expect(f.editor.setModel).toHaveBeenLastCalledWith(null);
  const next = leaseEditorView("p", "primary", f.monaco, document.body, {
    model: b,
    fontSize: 17,
    readOnly: true,
    wordWrap: "on",
    lineNumbers: "off",
  });
  expect(next.editor).toBe(first.editor);
  expect(next.host).toBe(first.host);
  expect(f.create).toHaveBeenCalledOnce();
  expect(installEditorInteractions).toHaveBeenCalledOnce();
  expect(f.editor.setModel).toHaveBeenLastCalledWith(b);
  expect(f.editor.updateOptions).toHaveBeenLastCalledWith({
    fontSize: 17,
    readOnly: true,
    wordWrap: "on",
    lineNumbers: "off",
  });
  next.release();
});
it("keeps editor groups independent and disposes active and parked views on a folder change", () => {
  const f = fixture();
  const primary = leaseEditorView("p", "primary", f.monaco, document.body, {});
  primary.release();
  leaseEditorView("p", "secondary", f.monaco, document.body, {});
  expect(f.create).toHaveBeenCalledTimes(2);
  useApp.setState({ project: { ...scope, id: "other" } });
  expect(f.editor.dispose).toHaveBeenCalledTimes(2);
});
it("an old cleanup cannot detach a newer lease or dispose a new folder's view", () => {
  const f = fixture();
  const old = leaseEditorView("p", "primary", f.monaco, document.body, {});
  const current = leaseEditorView("p", "primary", f.monaco, document.body, {});
  document.body.append(current.host);
  old.release();
  expect(current.host.isConnected).toBe(true);
  expect(f.editor.setModel).toHaveBeenLastCalledWith(null);
  useApp.setState({ project: { ...scope, id: "other" } });
  const fresh = leaseEditorView(
    "other",
    "primary",
    f.monaco,
    document.body,
    {},
  );
  document.body.append(fresh.host);
  current.release();
  expect(fresh.host.isConnected).toBe(true);
  fresh.release();
});
