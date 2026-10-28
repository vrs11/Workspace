import type { Settings, TerminalInfo } from "../../generated/protocol";
import type { Renderer } from "./emulator";
export type { Renderer } from "./emulator";

// Keep the pane's tabs/menus/layout lightweight until a real session needs xterm.
// Imported modules stay cached, while each PTY retains its own renderer/buffer.
const renderers = new Map<string, Promise<Renderer>>();
const closing = new Set<string>();
export function markRendererClosing(id: string, value: boolean) {
  if (value) closing.add(id);
  else closing.delete(id);
}
export function destroyRenderer(id: string) {
  const pending = renderers.get(id);
  renderers.delete(id);
  // Creation errors still reach the original caller. Disposal must not create
  // another unhandled rejection when close races with a failed initialization.
  void pending?.then(
    (r) => r.dispose(),
    () => {},
  );
}
export function renderer(
  info: TerminalInfo,
  settings: Settings,
  initialToken?: string,
): Promise<Renderer> {
  const old = renderers.get(info.id);
  if (old) return old;
  const pending = import("./emulator").then(({ createRenderer }) =>
    createRenderer(info, settings, () => closing.has(info.id), initialToken),
  );
  renderers.set(info.id, pending);
  void pending.catch(() => {
    if (renderers.get(info.id) === pending) renderers.delete(info.id);
  });
  return pending;
}
