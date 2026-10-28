import { browser } from "@wdio/globals";
// The embedded driver dispatches untrusted PointerEvents and does not implement
// implicit capture. Supply that browser contract only in the test WebView. All
// coordinates, hit tests, listeners, panel layout and editor behavior stay real.
export async function installCaptureBridge() {
  await browser.execute(() => {
    const captured = new Map<number, Element>();
    const set = Element.prototype.setPointerCapture;
    const has = Element.prototype.hasPointerCapture;
    const release = Element.prototype.releasePointerCapture;
    const lost = (element: Element, id: number) =>
      element.dispatchEvent(
        new PointerEvent("lostpointercapture", {
          bubbles: true,
          pointerId: id,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    Element.prototype.setPointerCapture = function (id) {
      try {
        set.call(this, id);
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "NotFoundError")
          throw error;
        captured.set(id, this);
      }
    };
    Element.prototype.hasPointerCapture = function (id) {
      return captured.get(id) === this || has.call(this, id);
    };
    Element.prototype.releasePointerCapture = function (id) {
      if (captured.get(id) === this) {
        captured.delete(id);
        lost(this, id);
      } else release.call(this, id);
    };
    const route = (event: PointerEvent) => {
      const target = captured.get(event.pointerId);
      if (!target) return;
      if (event.target !== target) {
        event.stopImmediatePropagation();
        target.dispatchEvent(new PointerEvent(event.type, event));
      }
      if (event.type === "pointerup" || event.type === "pointercancel")
        queueMicrotask(() => {
          if (captured.get(event.pointerId) === target) {
            captured.delete(event.pointerId);
            lost(target, event.pointerId);
          }
        });
    };
    for (const type of ["pointermove", "pointerup", "pointercancel"])
      window.addEventListener(type, route as EventListener, true);
    (
      window as unknown as { disposePointerCaptureBridge: () => void }
    ).disposePointerCaptureBridge = () => {
      for (const [id, element] of captured) {
        captured.delete(id);
        lost(element, id);
      }
      for (const type of ["pointermove", "pointerup", "pointercancel"])
        window.removeEventListener(type, route as EventListener, true);
      Element.prototype.setPointerCapture = set;
      Element.prototype.hasPointerCapture = has;
      Element.prototype.releasePointerCapture = release;
    };
  });
}
