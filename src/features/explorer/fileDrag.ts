import { listen } from "@tauri-apps/api/event";
import { notice } from "../../shared/state/store";
import { rpc } from "../../shared/ipc/client";
import type { Entry } from "../../generated/protocol";
export type FileDrag = { scope: string; entries: Entry[] };
export type NativeFileEvent = {
  phase: "over" | "leave" | "drop";
  error?: string | null;
  x: number;
  y: number;
  offer: string | null;
  folder: string | null;
};
export type FileDrop = {
  target: Element | null;
  drag: FileDrag | null;
  offer: string | null;
  folder: string | null;
};
let activeDrag: FileDrag | null = null;
export async function startFileDrag(scope: string, entries: Entry[]) {
  if (activeDrag) return;
  if (entries.length > 100)
    throw new Error("Drag up to 100 files or folders at a time.");
  const drag = { scope, entries };
  activeDrag = drag;
  try {
    await rpc({
      type: "startFileDrag",
      scope,
      entries: entries.map((entry) => entry.id),
    });
  } catch (error) {
    if (activeDrag === drag) activeDrag = null;
    throw error;
  }
}
export function nativeFileTarget(event: NativeFileEvent) {
  // The native bridge normalizes platform coordinates to CSS pixels.
  return document.elementFromPoint(event.x, event.y);
}
export async function installFileDrops(open: (drop: FileDrop) => void) {
  const stops: (() => void)[] = [];
  try {
    stops.push(
      await listen<NativeFileEvent>("workspace-native-file", ({ payload }) => {
        if (payload.error) {
          notice(payload.error);
          return;
        }
        const target =
          payload.phase === "leave" ? null : nativeFileTarget(payload);
        const drop = {
          target,
          drag: activeDrag,
          offer: payload.offer,
          folder: payload.folder,
        };
        if (payload.phase === "drop") {
          // Capture the selection before the OS drag-end callback clears it.
          if (
            target?.closest(
              ".editor-area, .split-editor, .welcome:not(.startup-repair)",
            )
          )
            open(drop);
          else
            window.dispatchEvent(
              new CustomEvent<FileDrop>("workspace-file-drop", {
                detail: drop,
              }),
            );
        }
        window.dispatchEvent(
          new CustomEvent<FileDrop>("workspace-file-hover", {
            detail: payload.phase === "over" ? drop : { ...drop, target: null },
          }),
        );
      }),
    );
    stops.push(
      await listen("workspace-native-file-end", () => {
        activeDrag = null;
        window.dispatchEvent(
          new CustomEvent<FileDrop>("workspace-file-hover", {
            detail: { target: null, drag: null, offer: null, folder: null },
          }),
        );
      }),
    );
  } catch (error) {
    stops.forEach((stop) => stop());
    throw error;
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stops.forEach((stop) => stop());
    activeDrag = null;
  };
}
// Only a real held pointer passing the movement threshold starts an OS session.
export function armFileDrag(event: PointerEvent, start: () => void) {
  if (event.button !== 0 || event.pointerType === "touch") return () => {};
  const pointer = event.pointerId,
    x = event.clientX,
    y = event.clientY;
  const clear = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", clear, true);
    window.removeEventListener("pointercancel", clear, true);
    window.removeEventListener("blur", clear);
    window.removeEventListener("pagehide", clear);
    window.removeEventListener("keydown", key, true);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") clear();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    if (!(e.buttons & 1)) {
      clear();
      return;
    }
    if (Math.hypot(e.clientX - x, e.clientY - y) < 6) return;
    e.preventDefault();
    clear();
    start();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", clear, true);
  window.addEventListener("pointercancel", clear, true);
  window.addEventListener("blur", clear);
  window.addEventListener("pagehide", clear);
  window.addEventListener("keydown", key, true);
  return clear;
}
