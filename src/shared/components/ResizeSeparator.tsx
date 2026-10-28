import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Separator } from "react-resizable-panels";

// Match the visible mouse target. Expanded targets must not steal editor clicks.
export const resizeTargetMinimumSize = { fine: 5, coarse: 24 };
let cancelActiveResize: (() => void) | undefined;

export function ResizeSeparator({ className }: { className: string }) {
  const cancel = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cancel.current?.(), []);
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The panel library accepts the gesture in document capture and cancels its
    // default action. Other buttons/blocked gestures must not set a global cursor.
    if (event.button !== 0 || !event.isPrimary || !event.defaultPrevented)
      return;
    const element = event.currentTarget;
    if (element.getAttribute("aria-disabled") === "true") return;
    cancelActiveResize?.();
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    const pointerId = event.pointerId;
    const orientation = element.getAttribute("aria-orientation")!;
    let ended = false;
    const finish = (cancelled: boolean) => {
      if (ended) return;
      ended = true;
      delete doc.documentElement.dataset.workspaceResize;
      delete element.dataset.resizeActive;
      win.removeEventListener("pointerup", up, true);
      win.removeEventListener("pointercancel", lost, true);
      win.removeEventListener("lostpointercapture", lost, true);
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("keydown", key, true);
      win.removeEventListener("blur", abort);
      win.removeEventListener("pagehide", abort);
      if (cancel.current === abort) cancel.current = undefined;
      if (cancelActiveResize === abort) cancelActiveResize = undefined;
      if (cancelled) {
        doc.dispatchEvent(
          new PointerEvent("pointercancel", {
            bubbles: true,
            pointerId,
            pointerType: event.pointerType,
            isPrimary: true,
          }),
        );
        if (element.hasPointerCapture?.(pointerId))
          element.releasePointerCapture(pointerId);
      }
    };
    const abort = () => finish(true);
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(event.defaultPrevented);
    };
    const lost = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(true);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId && event.buttons === 0) finish(true);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(true);
    };
    cancel.current = cancelActiveResize = abort;
    doc.documentElement.dataset.workspaceResize = orientation;
    element.dataset.resizeActive = "true";
    win.addEventListener("pointerup", up, true);
    win.addEventListener("pointercancel", lost, true);
    win.addEventListener("lostpointercapture", lost, true);
    win.addEventListener("pointermove", move, true);
    win.addEventListener("keydown", key, true);
    win.addEventListener("blur", abort);
    win.addEventListener("pagehide", abort);
    // Capture on DOWN, before the first move can be consumed by Monaco. Waiting
    // until document-bubble pointermove lets the editor prevent resizing entirely.
    try {
      element.setPointerCapture(pointerId);
    } catch (error) {
      // A pointer can expire before capture (also true of script-generated
      // events). The document/window cancellation handlers still restore state.
      if (!(error instanceof DOMException)) {
        abort();
        throw error;
      }
    }
  };
  return <Separator className={className} onPointerDown={begin} />;
}
