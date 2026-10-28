import { beforeEach, expect, it, vi } from "vitest";
import type { Settings, TerminalInfo } from "../../src/generated/protocol";
import type { Renderer } from "../../src/features/terminal/session";

const engine = vi.hoisted(() => ({
  loaded: vi.fn(),
  create: vi.fn<(...args: unknown[]) => Promise<Renderer>>(),
}));
vi.mock("../../src/features/terminal/emulator", () => {
  engine.loaded();
  return { createRenderer: engine.create };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
const info = { id: "pty", scope: "project" } as TerminalInfo;
const settings = {} as Settings;
function deferred() {
  let resolve!: (value: Renderer) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Renderer>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const view = () => ({ dispose: vi.fn() }) as unknown as Renderer;

it("keeps an empty pane free of the emulator and deduplicates concurrent session initialization", async () => {
  const session = await import("../../src/features/terminal/session");
  expect(engine.loaded).not.toHaveBeenCalled();
  const ready = deferred();
  engine.create.mockReturnValue(ready.promise);
  const first = session.renderer(info, settings, "attachment");
  expect(session.renderer(info, settings)).toBe(first);
  await vi.waitFor(() => expect(engine.create).toHaveBeenCalledOnce());
  expect(engine.create.mock.calls[0].slice(0, 2)).toEqual([info, settings]);
  expect(engine.create.mock.calls[0][3]).toBe("attachment");
  const result = view();
  ready.resolve(result);
  expect(await first).toBe(result);
  session.destroyRenderer(info.id);
  await Promise.resolve();
  expect(result.dispose).toHaveBeenCalledOnce();
});

it("disposes a renderer closed during loading and keeps close state live", async () => {
  const session = await import("../../src/features/terminal/session");
  const ready = deferred();
  engine.create.mockReturnValue(ready.promise);
  const pending = session.renderer(info, settings);
  await vi.waitFor(() => expect(engine.create).toHaveBeenCalledOnce());
  const isClosing = engine.create.mock.calls[0][2] as () => boolean;
  expect(isClosing()).toBe(false);
  session.markRendererClosing(info.id, true);
  session.destroyRenderer(info.id);
  expect(isClosing()).toBe(true);
  const result = view();
  ready.resolve(result);
  await pending;
  expect(result.dispose).toHaveBeenCalledOnce();
  session.markRendererClosing(info.id, false);
  expect(isClosing()).toBe(false);
});

it("does not let an old failed load evict a reopened session or create an unhandled close rejection", async () => {
  const session = await import("../../src/features/terminal/session");
  const old = deferred(),
    fresh = deferred();
  engine.create
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const first = session.renderer(info, settings);
  await vi.waitFor(() => expect(engine.create).toHaveBeenCalledTimes(1));
  session.destroyRenderer(info.id);
  const second = session.renderer(info, settings);
  await vi.waitFor(() => expect(engine.create).toHaveBeenCalledTimes(2));
  const failed = expect(first).rejects.toThrow("attachment closed");
  old.reject(new Error("attachment closed"));
  await failed;
  expect(session.renderer(info, settings)).toBe(second);
  const result = view();
  fresh.resolve(result);
  await second;
  session.destroyRenderer(info.id);
  await Promise.resolve();
  expect(result.dispose).toHaveBeenCalledOnce();
});
