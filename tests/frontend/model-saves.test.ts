import { afterEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { useApp, type DocMeta } from "../../src/shared/state/store";
import { call, rpc } from "../../src/shared/ipc/client";
import {
  models,
  saveDocument,
  checkpoint,
  disposeModel,
  reconcileDocuments,
  closeDocument,
} from "../../src/features/editor/models";
import type { Request, Response } from "../../src/generated/protocol";
vi.mock("../../src/shared/ipc/client", async () => {
  const errors = await import("../../src/shared/errors");
  return { call: vi.fn(), rpc: vi.fn(), ...errors };
});
afterEach(() => {
  disposeModel("a");
  vi.mocked(call).mockReset();
  vi.mocked(rpc).mockReset();
});
it("serializes full saves with checkpoints/reconciliation and retains edits typed during a save", async () => {
  let text = "first",
    version = 1;
  const model = {
    getValue: () => text,
    getAlternativeVersionId: () => version,
    dispose() {},
    setValue: vi.fn(),
  };
  const meta: DocMeta = {
    id: "a",
    entry: "a",
    name: "a.ts",
    path: "a.ts",
    baseline: "old",
    encoding: "utf8",
    eol: "lf",
    readonly: null,
    metadata: null,
    size: 3,
    revision: 1,
    dirty: true,
    recovering: false,
    acknowledged: 0,
    conflict: false,
    recoveryError: null,
    saveError: null,
  };
  useApp.setState({
    project: {
      id: "p",
      root: "/fixture",
      name: "fixture",
      trusted: true,
    },
    docs: { a: meta },
  });
  const h = {
    model: model as unknown as Monaco.editor.ITextModel,
    listener: { dispose() {} },
    timer: null,
    queue: Promise.resolve(),
    savedVersion: 0,
    revision: 1,
    updating: false,
  };
  models.set("a", h);
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests: Request[] = [];
  vi.mocked(call).mockImplementation(
    async <T extends Response["type"]>(
      request: Request,
      kind: T,
    ): Promise<Extract<Response, { type: T }>> => {
      requests.push(request);
      if (request.type === "save" && request.text === "first") {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const response: Response =
        request.type === "reconcileDocument"
          ? {
              type: "reconciled",
              document: {
                ...meta,
                text: "newest",
                recovery: null,
                baseline: "newest",
                revision: 2,
              },
              refresh: null,
            }
          : {
              type: "saved",
              baseline: request.type === "save" ? request.text : "old",
              revision: "revision" in request ? request.revision : 1,
            };
      if (response.type !== kind)
        throw new Error("Unexpected mock response type");
      return response as Extract<Response, { type: T }>;
    },
  );
  const first = saveDocument("a", true);
  await firstStarted;
  text = "newest";
  version = 2;
  h.revision = 2;
  useApp.getState().doc("a", { revision: 2, dirty: true });
  const queuedCheckpoint = checkpoint("a");
  const second = saveDocument("a");
  const reconcile = reconcileDocuments();
  expect(requests.filter((r) => r.type === "save")).toHaveLength(1);
  release();
  await first;
  expect(useApp.getState().docs.a.dirty).toBe(true);
  await Promise.all([queuedCheckpoint, second, reconcile]);
  const saves = requests.filter((r) => r.type === "save");
  expect(saves.map((r) => [r.text, r.baseline])).toEqual([
    ["first", "old"],
    ["newest", "first"],
  ]);
  const checkpoints = requests.filter((r) => r.type === "checkpoint");
  expect(checkpoints.at(-1)?.baseline).toBe("first");
  expect(useApp.getState().docs.a.dirty).toBe(false);
  expect(useApp.getState().docs.a.baseline).toBe("newest");
  expect(model.setValue).not.toHaveBeenCalled();
});

it.each([true, false])(
  "joins pending operations and closes clean buffers without skipping unacknowledged recovery (%s)",
  async (acknowledged) => {
    const meta: DocMeta = {
      id: "a",
      entry: "a",
      name: "a.ts",
      path: "a.ts",
      baseline: "base",
      encoding: "utf8",
      eol: "lf",
      readonly: null,
      metadata: null,
      size: 3,
      revision: 1,
      dirty: false,
      recovering: false,
      acknowledged: acknowledged ? 1 : 0,
      conflict: false,
      recoveryError: null,
      saveError: null,
    };
    useApp.setState({
      project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
      docs: { a: meta },
      tabs: [{ id: "a", kind: "editor", entry: "a", title: "a.ts" }],
      active: "a",
    });
    let release!: () => void;
    const disposed = vi.fn();
    const model = {
      getValue: () => "base",
      getAlternativeVersionId: () => 1,
      dispose: disposed,
    } as unknown as Monaco.editor.ITextModel;
    models.set("a", {
      model,
      listener: { dispose() {} },
      timer: null,
      queue: new Promise<void>((resolve) => {
        release = resolve;
      }),
      savedVersion: 1,
      revision: 1,
      updating: false,
    });
    vi.mocked(call).mockResolvedValue({
      type: "saved",
      baseline: "base",
      revision: 1,
    });
    vi.mocked(rpc).mockImplementation(async (request) => {
      expect(request.type).toBe("closeDocument");
      expect(useApp.getState().docs.a.acknowledged).toBe(1);
      return { type: "ok" };
    });
    const closing = closeDocument("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc).not.toHaveBeenCalled();
    release();
    expect(await closing).toBe(true);
    expect(call).toHaveBeenCalledTimes(acknowledged ? 0 : 1);
    expect(disposed).toHaveBeenCalledOnce();
    expect(useApp.getState().docs.a).toBeUndefined();
  },
);
