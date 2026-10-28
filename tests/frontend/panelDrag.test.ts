import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  beginPanelDrag,
  type PanelDrop,
} from "../../src/features/workspace/panelDrag";
import {
  defaultDock,
  movePanel,
  visibleDockRoot,
} from "../../src/features/workspace/dockModel";
import type { DockPanel } from "../../src/generated/protocol";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}
let cleanup: (() => void) | undefined;
let workspace: HTMLDivElement;
let handle: HTMLButtonElement;
let hit: Element | null;
const pointer = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    isPrimary: true,
    buttons: 1,
    clientX: 10,
    clientY: 10,
    ...init,
  });
function target(panel = "workspace", side = "right") {
  const node = document.createElement("div");
  node.className = "dock-drop";
  node.dataset.dockTarget = panel;
  node.dataset.dockSide = side;
  workspace.appendChild(node);
  return node;
}
function start(panel: DockPanel = "git") {
  const callbacks = { start: vi.fn(), hover: vi.fn(), finish: vi.fn() };
  cleanup = beginPanelDrag(handle, pointer("pointerdown"), panel, callbacks);
  return callbacks;
}
const move = (init: PointerEventInit = {}) =>
  window.dispatchEvent(pointer("pointermove", { clientX: 30, ...init }));
beforeEach(() => {
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  workspace = document.createElement("div");
  workspace.className = "dock-workspace";
  handle = document.createElement("button");
  workspace.appendChild(handle);
  document.body.appendChild(workspace);
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = vi.fn(() => true);
  handle.releasePointerCapture = vi.fn();
  hit = null;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => hit),
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  workspace.remove();
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("starts a fresh Git drag after Explorer moves right and its source branch is replaced", () => {
  let layout = defaultDock();
  for (const [panel, destination, side] of [
    ["explorer", "workspace", "right"],
    ["git", "workspace", "left"],
    ["git", "explorer", "top"],
    ["git", "workspace", "right"],
  ] as const) {
    const callbacks = start(panel);
    const node = target(destination, side);
    // First move activates targets; the next hit uses their actual location.
    move();
    expect(callbacks.start).toHaveBeenCalledOnce();
    expect(workspace.dataset.panelDragging).toBe("true");
    hit = node;
    move();
    const expected: PanelDrop = { target: destination, side };
    expect(callbacks.hover).toHaveBeenLastCalledWith(expected);
    window.dispatchEvent(pointer("pointerup", { clientX: 30, buttons: 0 }));
    expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(expected);
    expect(workspace.dataset.panelDragging).toBeUndefined();
    layout = movePanel(layout, panel, destination, side);
    // A completed move replaces the branch, including its drag handle.
    const next = handle.cloneNode() as HTMLButtonElement;
    handle.replaceWith(next);
    handle = next;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn(() => false);
    handle.releasePointerCapture = vi.fn();
    node.remove();
    hit = null;
  }
  const root = visibleDockRoot(layout)!;
  expect(root.type === "split" && root.second).toEqual({
    type: "panel",
    panel: "git",
  });
});

it("keeps clicks, other pointers and text/file interactions outside a pane gesture alone", () => {
  const callbacks = start();
  move({ pointerId: 2 });
  move({ clientX: 12, clientY: 11 });
  expect(callbacks.start).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointerup", { buttons: 0 }));
  expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(null);
  move();
  expect(callbacks.start).not.toHaveBeenCalled();
  for (const init of [{ button: 2 }, { isPrimary: false }]) {
    expect(
      beginPanelDrag(handle, pointer("pointerdown", init), "git", callbacks),
    ).toBeUndefined();
  }
});

it.each([
  "pointercancel",
  "lostpointercapture",
  "Escape",
  "blur",
  "pagehide",
  "buttons=0",
  "unmount",
])(
  "cancels on %s, releases capture and removes listeners without moving a pane",
  (reason) => {
    const callbacks = start();
    move();
    hit = target();
    move();
    if (reason === "Escape")
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    else if (reason === "buttons=0") move({ buttons: 0 });
    else if (reason === "unmount") cleanup?.();
    else
      window.dispatchEvent(
        reason.startsWith("pointer") || reason === "lostpointercapture"
          ? pointer(reason)
          : new Event(reason),
      );
    expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(null);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(workspace.dataset.panelDragging).toBeUndefined();
    window.dispatchEvent(pointer("pointerup"));
    move();
    expect(callbacks.finish).toHaveBeenCalledOnce();
  },
);

it("uses the release hit rather than stale hover and ignores foreign/self/invalid targets", () => {
  const callbacks = start();
  move();
  hit = target();
  move();
  const foreign = target();
  document.body.appendChild(foreign);
  for (const node of [
    target("git"),
    target("bad"),
    target("editor", "bad"),
    foreign,
  ]) {
    hit = node;
    move();
    expect(callbacks.hover).toHaveBeenLastCalledWith(null);
    node.remove();
  }
  window.dispatchEvent(pointer("pointerup", { buttons: 0 }));
  expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(null);
});

it("cancels if a pending drag loses its source and tolerates an already-expired native pointer", () => {
  handle.setPointerCapture = vi.fn(() => {
    throw new DOMException("No active pointer", "NotFoundError");
  });
  const callbacks = start();
  move();
  handle.remove();
  move();
  expect(callbacks.finish).toHaveBeenCalledExactlyOnceWith(null);
  expect(workspace.dataset.panelDragging).toBeUndefined();
});
