import { afterEach, expect, it, vi } from "vitest";
import {
  armFileDrag,
  installFileDrops,
  nativeFileTarget,
  startFileDrag,
  type NativeFileEvent,
} from "../../src/features/explorer/fileDrag";
import { listen } from "@tauri-apps/api/event";
import { rpc } from "../../src/shared/ipc/client";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../src/shared/ipc/client", () => ({ rpc: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
it("uses normalized client coordinates for OS drop hit testing", () => {
  const target = document.createElement("div");
  const hit = vi.fn().mockReturnValue(target);
  vi.stubGlobal("devicePixelRatio", 2);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: hit,
  });
  expect(nativeFileTarget({ x: 50, y: 75 } as NativeFileEvent)).toBe(target);
  expect(hit).toHaveBeenCalledWith(50, 75);
  vi.unstubAllGlobals();
});
it("routes editor drops and retains a multi-file selection until native drag end", async () => {
  const callbacks = new Map<string, (event: { payload: unknown }) => void>();
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    callbacks.set(name, handler as (event: { payload: unknown }) => void);
    return unlisten;
  });
  const target = document.createElement("div");
  target.className = "editor-area";
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => target,
  });
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  const open = vi.fn();
  const stop = await installFileDrops(open);
  const entries = ["a", "b"].map((id) => ({
    id,
    name: id,
    path: id,
    kind: "file",
  }));
  await startFileDrag("project", entries);
  expect(rpc).toHaveBeenCalledWith({
    type: "startFileDrag",
    scope: "project",
    entries: ["a", "b"],
  });
  callbacks.get("workspace-native-file")!({
    payload: { phase: "drop", x: 10, y: 20, offer: "os-offer", folder: null },
  });
  callbacks.get("workspace-native-file-end")!({ payload: null });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ drag: { scope: "project", entries } }),
  );
  callbacks.get("workspace-native-file")!({
    payload: {
      phase: "drop",
      x: 10,
      y: 20,
      offer: "external-offer",
      folder: null,
    },
  });
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ drag: null, offer: "external-offer" }),
  );
  stop();
  expect(unlisten).toHaveBeenCalledTimes(2);
});
it("starts only held pointer gestures and cleans up cancelled drags", () => {
  const event = (values: object) =>
    Object.assign(new Event("pointermove", { cancelable: true }), {
      pointerId: 1,
      buttons: 1,
      clientX: 0,
      clientY: 0,
      ...values,
    });
  const initial = {
    pointerId: 1,
    button: 0,
    pointerType: "mouse",
    clientX: 0,
    clientY: 0,
  } as PointerEvent;
  const start = vi.fn();
  const clear = armFileDrag(initial, start);
  window.dispatchEvent(event({ clientX: 4 }));
  expect(start).not.toHaveBeenCalled();
  window.dispatchEvent(event({ clientX: 8 }));
  expect(start).toHaveBeenCalledTimes(1);
  window.dispatchEvent(event({ clientX: 12 }));
  expect(start).toHaveBeenCalledTimes(1);
  clear();
  armFileDrag(initial, start);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  window.dispatchEvent(event({ clientX: 8 }));
  expect(start).toHaveBeenCalledTimes(1);
  armFileDrag(initial, start);
  window.dispatchEvent(event({ buttons: 0 }));
  window.dispatchEvent(event({ clientX: 8 }));
  expect(start).toHaveBeenCalledTimes(1);
});
