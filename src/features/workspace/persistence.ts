import type { Request } from "../../generated/protocol";
import { rpc } from "../../shared/ipc/client";
import { notice, reportError, useApp } from "../../shared/state/store";
type Write = Extract<Request, { type: "uiWrite" | "terminalLayoutWrite" }>;
type Slot = {
  pending?: Write;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};
const slots = new Map<string, Slot>();
const warnings = new Map<string, string | null>();
export function persistenceWarning(scope: string, warning: string | null) {
  const previous = warnings.get(scope);
  if (warning && previous !== warning) notice(warning);
  else if (!warning && previous && useApp.getState().notice === previous)
    notice("");
  warnings.set(scope, warning);
}
export function schedulePersistence(request: Write) {
  const key = `${request.scope}:${request.type}`;
  let slot = slots.get(key);
  if (!slot) {
    slot = {};
    slots.set(key, slot);
  }
  slot.pending = request;
  clearTimeout(slot.timer);
  slot.timer = setTimeout(() => void flushSlot(slot!).catch(reportError), 350);
}
async function flushSlot(slot: Slot): Promise<void> {
  clearTimeout(slot.timer);
  if (slot.running) {
    await slot.running;
    return flushSlot(slot);
  }
  if (!slot.pending) return;
  const request = slot.pending;
  slot.pending = undefined;
  slot.running = (async () => {
    try {
      const result = await rpc(request);
      if (result.type === "persistence")
        persistenceWarning(request.scope, result.warning);
    } catch (error) {
      slot.pending ??= request;
      throw error;
    }
  })();
  try {
    await slot.running;
  } finally {
    slot.running = undefined;
  }
  if (slot.pending) await flushSlot(slot);
}
export async function flushWorkspacePersistence(scope: string) {
  // UI and terminal metadata share one project document natively. Serialize the
  // flush as well as debounced writes; the host merges each validated section.
  for (const [key, slot] of slots)
    if (key.startsWith(`${scope}:`)) {
      await flushSlot(slot);
      if (!slot.running && !slot.pending) {
        clearTimeout(slot.timer);
        slots.delete(key);
      }
    }
  warnings.delete(scope);
}
