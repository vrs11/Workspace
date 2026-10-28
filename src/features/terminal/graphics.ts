import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";
type Addon = ITerminalAddon & {
  onContextLoss(listener: () => void): IDisposable;
};
type Target = Pick<
  Terminal,
  "element" | "loadAddon" | "refresh" | "cols" | "rows"
>;
type Load = () => Promise<() => Addon>;

/** One bounded renderer pool; terminal buffers, parsers and PTYs stay untouched. */
export function createGraphicsPool(limit: number, load: Load) {
  let reserved = 0;
  let unavailable = false;
  return (term: Target, host: HTMLElement) => {
    let disposed = false;
    let attempted = false;
    let ownsSlot = false;
    let addon: Addon | undefined;
    let loss: IDisposable | undefined;
    let previous = new Set<HTMLCanvasElement>();
    const contexts = new Set<WebGL2RenderingContext>();
    host.dataset.terminalRenderer = "dom";
    host.dataset.terminalGraphicsReady = "false";
    const collect = () => {
      for (const canvas of term.element?.querySelectorAll("canvas") ?? []) {
        if (!previous.has(canvas)) {
          const gl = canvas.getContext("webgl2");
          if (gl) contexts.add(gl);
        }
      }
    };
    const release = () => {
      loss?.dispose();
      loss = undefined;
      const old = addon;
      addon = undefined;
      if (old) {
        collect();
        try {
          old.dispose(); // The addon restores xterm's DOM renderer.
        } catch {
          // xterm disposal runs all registered cleanup before reporting errors.
          // Stop future acceleration attempts after an unexpected driver failure.
          unavailable = true;
          console.warn("Terminal graphics cleanup fell back to DOM rendering");
        } finally {
          // Removing a canvas alone can leave its GPU context alive until GC.
          // Use the public canvas API, never private xterm renderer fields.
          for (const gl of contexts) {
            try {
              gl.getExtension("WEBGL_lose_context")?.loseContext();
            } catch {
              unavailable = true;
            }
          }
          contexts.clear();
        }
      }
      if (ownsSlot) {
        reserved--;
        ownsSlot = false;
      }
      host.dataset.terminalRenderer = "dom";
      if (!disposed) term.refresh(0, term.rows - 1);
    };
    return {
      fit() {
        if (unavailable || reserved >= limit)
          host.dataset.terminalGraphicsReady = "true";
        if (
          disposed ||
          attempted ||
          unavailable ||
          reserved >= limit ||
          !host.isConnected
        )
          return;
        attempted = true;
        ownsSlot = true;
        reserved++;
        void load()
          .then((create) => {
            if (disposed) return;
            previous = new Set(term.element?.querySelectorAll("canvas"));
            const current = create();
            addon = current;
            loss = current.onContextLoss(release);
            term.loadAddon(current);
            collect();
            if (addon === current) host.dataset.terminalRenderer = "webgl";
          })
          .catch(() => {
            // Unsupported/failed graphics must leave a usable ordinary terminal.
            unavailable = true;
            release();
          })
          .finally(() => {
            host.dataset.terminalGraphicsReady = "true";
            if (!addon && ownsSlot) {
              reserved--;
              ownsSlot = false;
            }
          });
      },
      dispose() {
        disposed = true;
        release();
      },
    };
  };
}

export const terminalGraphics = createGraphicsPool(4, async () => {
  const { WebglAddon } = await import("@xterm/addon-webgl");
  return () => new WebglAddon();
});
