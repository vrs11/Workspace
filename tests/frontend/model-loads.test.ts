import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApp } from "../../src/shared/state/store";
import { rpc } from "../../src/shared/ipc/client";
import {
  abandonModelLoads,
  disposeModel,
  loadDocument,
  models,
  settleModelLoads,
} from "../../src/features/editor/models";
import type { Response } from "../../src/generated/protocol";
vi.mock("../../src/shared/ipc/client", () => ({
  call: vi.fn(),
  rpc: vi.fn(),
  errorText: String,
}));
vi.mock("../../src/features/editor/monaco", () => ({
  monaco: {
    languages: { getLanguages: () => [] },
    Uri: { from: (value: unknown) => value },
    editor: {
      createModel: () => ({
        getAlternativeVersionId: () => 1,
        onDidChangeContent: () => ({ dispose() {} }),
        dispose() {},
      }),
    },
  },
}));
const project = { id: "p", root: "/fixture", name: "fixture", trusted: true };
function opened(entry: string): Response {
  return {
    type: "document",
    document: {
      id: entry,
      entry,
      name: `${entry}.txt`,
      path: `${entry}.txt`,
      text: "text",
      recovery: null,
      baseline: "base",
      encoding: "utf8",
      eol: "lf",
      readonly: null,
      size: 4,
      revision: 0,
    },
  };
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  abandonModelLoads();
  useApp.setState({ project, docs: {}, tabs: [], active: null });
});
afterEach(() => {
  abandonModelLoads();
  for (const entry of models.keys()) disposeModel(entry);
  vi.mocked(rpc).mockReset();
  useApp.setState({ project: null, docs: {}, tabs: [], active: null });
});
it.each(["document", "media"] as const)(
  "publishes a ready %s tab and selection together without an intermediate empty editor",
  async (kind) => {
    vi.mocked(rpc).mockResolvedValue(
      kind === "document"
        ? opened("a")
        : {
            type: "media",
            media: {
              entry: "a",
              token: "token",
              name: "a.png",
              path: "a.png",
              mime: "image/png",
              kind: "image",
              size: 32,
            },
          },
    );
    const transitions: Array<{ tabs: string[]; active: string | null }> = [];
    const stop = useApp.subscribe((state, previous) => {
      if (state.tabs !== previous.tabs || state.active !== previous.active) {
        transitions.push({
          tabs: state.tabs.map((t) => t.id),
          active: state.active,
        });
        if (kind === "document" && state.active === "a") {
          expect(models.has("a")).toBe(true);
          expect(state.docs.a.name).toBe("a.txt");
        }
      }
    });
    try {
      await loadDocument("a");
      expect(transitions).toEqual([{ tabs: ["a"], active: "a" }]);
    } finally {
      stop();
    }
  },
);
it("restores background tabs without changing selection or revealing the editor", async () => {
  vi.mocked(rpc).mockResolvedValue(opened("a"));
  useApp.setState({ active: "selected" });
  const reveal = vi.fn();
  window.addEventListener("workspace-reveal-editor", reveal);
  try {
    await loadDocument("a", false);
    expect(useApp.getState().active).toBe("selected");
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["a"]);
    expect(reveal).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("workspace-reveal-editor", reveal);
  }
});
it("a superseded slow load cannot replace the latest selection", async () => {
  const a = deferred(),
    b = deferred();
  vi.mocked(rpc).mockImplementation((request) =>
    request.type === "openFile" && request.entry === "a"
      ? a.promise
      : b.promise,
  );
  const first = loadDocument("a"),
    latest = loadDocument("b");
  b.resolve(opened("b"));
  await latest;
  a.resolve(opened("a"));
  await first;
  expect(useApp.getState().active).toBe("b");
  expect(useApp.getState().tabs.map((t) => t.id)).toEqual(["b", "a"]);
});
it("a later caller can activate a deduplicated background load while file operations join publication", async () => {
  const a = deferred(),
    b = deferred();
  vi.mocked(rpc).mockImplementation((request) =>
    request.type === "openFile" && request.entry === "a"
      ? a.promise
      : b.promise,
  );
  const background = loadDocument("a", false),
    other = loadDocument("b"),
    latest = loadDocument("a");
  const settled = settleModelLoads();
  a.resolve(opened("a"));
  await Promise.all([background, latest]);
  expect(useApp.getState().active).toBe("a");
  b.resolve(opened("b"));
  await Promise.all([other, settled]);
  expect(useApp.getState().active).toBe("a");
  expect(models.has("a") && models.has("b")).toBe(true);
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("does not publish a late load into another project", async () => {
  const a = deferred();
  vi.mocked(rpc).mockReturnValue(a.promise);
  const pending = loadDocument("a");
  abandonModelLoads();
  useApp.setState({ project: { ...project, id: "other" } });
  a.resolve(opened("a"));
  await pending;
  expect(useApp.getState().tabs).toEqual([]);
  expect(useApp.getState().active).toBeNull();
  expect(models.size).toBe(0);
});
