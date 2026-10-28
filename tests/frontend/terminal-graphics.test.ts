import { afterEach, expect, it, vi } from "vitest";
import type { ITerminalAddon } from "@xterm/xterm";
import { createGraphicsPool } from "../../src/features/terminal/graphics";
function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const lose = vi.fn();
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({
    getExtension: () => ({ loseContext: lose }),
  } as unknown as WebGL2RenderingContext);
  let onLoss = () => {};
  const unsubscribe = vi.fn();
  const addon = {
    activate() {},
    dispose: vi.fn(() => canvas.remove()),
    onContextLoss: (listener: () => void) => {
      onLoss = listener;
      return { dispose: unsubscribe };
    },
  };
  const term = {
    element: host,
    cols: 80,
    rows: 24,
    loadAddon: vi.fn((_addon: ITerminalAddon) => host.append(canvas)),
    refresh: vi.fn(),
  };
  return {
    host,
    canvas,
    addon,
    term,
    lose,
    unsubscribe,
    onLoss: () => onLoss(),
  };
}
const controllers: Array<{ dispose(): void }> = [];
afterEach(() => {
  controllers.splice(0).forEach((c) => c.dispose());
  document.body.replaceChildren();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
it("keeps terminal/renderer identity and explicitly releases GPU resources on close", async () => {
  const f = fixture();
  const pool = createGraphicsPool(1, async () => () => f.addon);
  const c = pool(f.term, f.host);
  controllers.push(c);
  c.fit();
  await flush();
  expect(f.term.loadAddon).toHaveBeenCalledOnce();
  expect(f.host.dataset.terminalRenderer).toBe("webgl");
  c.fit();
  expect(f.term.loadAddon).toHaveBeenCalledOnce();
  c.dispose();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.addon.dispose).toHaveBeenCalledOnce();
  expect(f.lose).toHaveBeenCalledOnce();
});
it("restores DOM rendering after context loss and never replays or recreates the terminal", async () => {
  const f = fixture();
  const pool = createGraphicsPool(1, async () => () => f.addon);
  const c = pool(f.term, f.host);
  controllers.push(c);
  c.fit();
  await flush();
  f.onLoss();
  expect(f.host.dataset.terminalRenderer).toBe("dom");
  expect(f.term.refresh).toHaveBeenCalledWith(0, 23);
  expect(f.lose).toHaveBeenCalledOnce();
  c.fit();
  expect(f.term.loadAddon).toHaveBeenCalledOnce();
});
it("bounds pending and live GPU contexts while leaving other terminals on DOM", async () => {
  const a = fixture(),
    b = fixture();
  let ready!: (factory: () => typeof a.addon) => void;
  const pool = createGraphicsPool(
    1,
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const first = pool(a.term, a.host),
    second = pool(b.term, b.host);
  controllers.push(first, second);
  first.fit();
  second.fit();
  expect(b.host.dataset.terminalRenderer).toBe("dom");
  first.dispose();
  ready(() => a.addon);
  await flush();
  expect(a.term.loadAddon).not.toHaveBeenCalled();
  second.fit();
  ready(() => b.addon);
  await flush();
  expect(b.term.loadAddon).toHaveBeenCalledOnce();
});
it("keeps unsupported graphics usable and avoids repeated failed activations", async () => {
  const f = fixture();
  const load = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const c = createGraphicsPool(1, load)(f.term, f.host);
  controllers.push(c);
  c.fit();
  await flush();
  c.fit();
  expect(f.host.dataset.terminalRenderer).toBe("dom");
  expect(f.term.refresh).toHaveBeenCalledWith(0, 23);
  expect(load).toHaveBeenCalledOnce();
});
it("falls back and releases an allocated context after partial activation failure", async () => {
  const f = fixture();
  f.term.loadAddon.mockImplementation(() => {
    f.host.append(f.canvas);
    throw new Error("graphics failed");
  });
  const c = createGraphicsPool(1, async () => () => f.addon)(f.term, f.host);
  controllers.push(c);
  c.fit();
  await flush();
  expect(f.addon.dispose).toHaveBeenCalledOnce();
  expect(f.lose).toHaveBeenCalledOnce();
  expect(f.host.dataset.terminalRenderer).toBe("dom");
});
