import type { DockPanel } from "../../generated/protocol";
import { panelIds, type DockSide } from "./dockModel";

export type PanelDrop = { target: DockPanel | "workspace"; side: DockSide };
const sides: DockSide[] = ["left", "right", "top", "bottom"];

// Pane movement stays inside this WebView. Capture each grip gesture explicitly
// rather than relying on a browser-native drag session across branch reparenting.
// Keep HTML drag-and-drop for actual file moves.
export function beginPanelDrag(
  handle: HTMLElement,
  event: PointerEvent,
  panel: DockPanel,
  callbacks: {
    start: () => void;
    hover: (drop: PanelDrop | null) => void;
    finish: (drop: PanelDrop | null) => void;
  },
): (() => void) | undefined {
  if (event.button !== 0 || !event.isPrimary || event.defaultPrevented) return;
  const workspace = handle.closest<HTMLElement>(".dock-workspace");
  if (!workspace) return;
  const doc = handle.ownerDocument;
  const win = doc.defaultView!;
  const id = event.pointerId;
  let active = false;
  let ended = false;
  let hovered: PanelDrop | null = null;
  const dropAt = (event: PointerEvent): PanelDrop | null => {
    const element = doc
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".dock-drop");
    if (!element || !workspace.contains(element)) return null;
    const { dockTarget: target, dockSide: side } = element.dataset;
    if (
      target === panel ||
      (target !== "workspace" && !panelIds.includes(target as DockPanel)) ||
      !sides.includes(side as DockSide)
    )
      return null;
    return { target: target as PanelDrop["target"], side: side as DockSide };
  };
  const finish = (drop: PanelDrop | null) => {
    if (ended) return;
    ended = true;
    win.removeEventListener("pointermove", move, true);
    win.removeEventListener("pointerup", up, true);
    win.removeEventListener("pointercancel", lost, true);
    win.removeEventListener("lostpointercapture", lost, true);
    win.removeEventListener("keydown", key, true);
    win.removeEventListener("blur", cancel);
    win.removeEventListener("pagehide", cancel);
    delete workspace.dataset.panelDragging;
    if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
    callbacks.finish(drop);
  };
  const cancel = () => finish(null);
  const move = (next: PointerEvent) => {
    if (next.pointerId !== id) return;
    if (next.buttons === 0 || !handle.isConnected) return cancel();
    if (!active) {
      if (
        Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) <
        4
      )
        return;
      active = true;
      workspace.dataset.panelDragging = "true";
      callbacks.start();
    }
    next.preventDefault();
    const drop = dropAt(next);
    if (drop?.target !== hovered?.target || drop?.side !== hovered?.side) {
      hovered = drop;
      callbacks.hover(drop);
    }
  };
  const up = (next: PointerEvent) => {
    if (next.pointerId !== id) return;
    if (active) next.preventDefault();
    finish(active && handle.isConnected ? dropAt(next) : null);
  };
  const lost = (next: PointerEvent) => {
    if (next.pointerId === id) cancel();
  };
  const key = (next: KeyboardEvent) => {
    if (next.key === "Escape") {
      next.preventDefault();
      cancel();
    }
  };
  // Suppress text selection/native HTML dragging only for this grip gesture.
  event.preventDefault();
  win.addEventListener("pointermove", move, true);
  win.addEventListener("pointerup", up, true);
  win.addEventListener("pointercancel", lost, true);
  win.addEventListener("lostpointercapture", lost, true);
  win.addEventListener("keydown", key, true);
  win.addEventListener("blur", cancel);
  win.addEventListener("pagehide", cancel);
  try {
    handle.setPointerCapture(id);
  } catch (error) {
    // Scripted events have no live native pointer. Window listeners still give
    // them the same routing/cleanup; unexpected capture failures stay visible.
    if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
      cancel();
      throw error;
    }
  }
  return cancel;
}
