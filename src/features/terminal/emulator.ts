import { terminalGraphics } from "./graphics";
import { shortcutMatches } from "../../shared/keymap";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import type { Settings, TerminalInfo } from "../../generated/protocol";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { notice, reportError } from "../../shared/state/store";
import { registerSelectionReader } from "../../shared/selection";
export type Renderer = {
  host: HTMLDivElement;
  term: Terminal;
  search: SearchAddon;
  info: TerminalInfo;
  fit: () => void;
  paste: (text?: string) => Promise<void>;
  copy: () => Promise<void>;
  change: () => void;
  dispose: () => void;
  update: (s: Settings) => void;
};
export async function createRenderer(
  initial: TerminalInfo,
  settings: Settings,
  isClosing: () => boolean,
  initialToken?: string,
): Promise<Renderer> {
  const { token } = initialToken
    ? { token: initialToken }
    : await call(
        { type: "terminalAttach", scope: initial.scope, id: initial.id },
        "terminal",
      );
  const host = document.createElement("div");
  host.className = "terminal-emulator";
  const term = new Terminal({
    scrollback: settings.terminalScrollback,
    fontSize: settings.terminalFontSize,
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(host);
  const stopSelection = registerSelectionReader(() =>
    host.contains(document.activeElement) ? term.getSelection() : null,
  );
  const graphics = terminalGraphics(term, host);
  const base = { scope: initial.scope, id: initial.id, token };
  let disposed = false;
  const expectedClose = (error: unknown) =>
    isClosing() &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "notFound";
  let inputFailed = false;
  let sequence = 0;
  let queuedBytes = 0;
  let sending = false;
  const input: Uint8Array[] = [];
  const drain = async () => {
    if (sending) return;
    sending = true;
    try {
      while (input.length && !disposed && !inputFailed) {
        const data = input[0];
        try {
          await rpc({
            type: "terminalWrite",
            ...base,
            sequence,
            data: Array.from(data),
          });
          sequence++;
          input.shift();
          queuedBytes -= data.length;
        } catch (e) {
          if (
            typeof e === "object" &&
            e &&
            "code" in e &&
            e.code === "terminalBusy"
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 15));
            continue;
          }
          inputFailed = true;
          input.length = 0;
          queuedBytes = 0;
          if (!disposed && !expectedClose(e))
            reportError(e, { suffix: ". Pending input was not replayed." });
        }
      }
    } finally {
      sending = false;
    }
  };
  const send = (bytes: Uint8Array) => {
    if (disposed || initial.exited || inputFailed) return;
    if (queuedBytes + bytes.length > 1024 * 1024) {
      notice("Terminal input queue is full; this input was not sent.");
      return;
    }
    for (let offset = 0; offset < bytes.length; offset += 8192)
      input.push(bytes.slice(offset, offset + 8192));
    queuedBytes += bytes.length;
    void drain();
  };
  const encoder = new TextEncoder();
  const data = term.onData((text) => send(encoder.encode(text)));
  const binary = term.onBinary((text) =>
    send(Uint8Array.from(text, (c) => c.charCodeAt(0) & 255)),
  );
  const osc = term.parser.registerOscHandler(52, () => true);
  const copy = async () => {
    if (term.hasSelection())
      await rpc({ type: "clipboardWrite", text: term.getSelection() });
    term.focus();
  };
  const paste = async (text?: string) => {
    text ??= (await call({ type: "clipboardRead" }, "text")).text;
    if (encoder.encode(text).length > 1024 * 1024)
      throw new Error("Paste exceeds the 1 MiB terminal input limit");
    term.paste(text); // xterm applies the program's bracketed-paste mode.
    term.focus();
  };
  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void paste(text).catch((e) => reportError(e));
  };
  host.addEventListener("paste", onPaste, true);
  term.attachCustomKeyEventHandler((e) => {
    if (e.isComposing || e.key === "Process" || e.keyCode === 229) return true;
    const copyKey = shortcutMatches(e, "terminal.copy");
    const pasteKey = shortcutMatches(e, "terminal.paste");
    if (copyKey || pasteKey) {
      e.preventDefault();
      if (e.type === "keydown")
        void (copyKey ? copy() : paste()).catch((e) => reportError(e));
      return false;
    }
    return true; // Ctrl+C/D/Z, arrows, Alt and function keys belong to the PTY.
  });
  let lastSize = "";
  const result: Renderer = {
    host,
    term,
    search,
    info: initial,
    paste,
    copy,
    change: () => {},
    fit: () => {
      if (
        disposed ||
        !host.clientWidth ||
        !host.clientHeight ||
        !host.getClientRects().length
      )
        return;
      fit.fit();
      graphics.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize && term.cols >= 2 && term.rows >= 1) {
        lastSize = size;
        void rpc({
          type: "terminalResize",
          ...base,
          cols: term.cols,
          rows: term.rows,
        }).catch((e) => {
          if (!disposed && !expectedClose(e)) reportError(e);
        });
      }
    },
    update: (s) => {
      term.options.fontSize = s.terminalFontSize;
      term.options.scrollback = s.terminalScrollback;
      term.options.theme =
        s.theme === "light"
          ? {
              background: "#f7f8fa",
              foreground: "#24292f",
              selectionBackground: "#acc5ee",
            }
          : {
              background: "#121619",
              foreground: "#dce2e4",
              selectionBackground: "#3c536d",
            };
      result.fit();
    },
    dispose: () => {
      disposed = true;
      stopSelection();
      input.length = 0;
      host.removeEventListener("paste", onPaste, true);
      data.dispose();
      binary.dispose();
      osc.dispose();
      observer.disconnect();
      graphics.dispose();
      term.dispose();
      host.remove();
    },
  };
  const observer = new ResizeObserver(() => result.fit());
  observer.observe(host);
  result.update(settings);
  void (async () => {
    try {
      while (!disposed) {
        const { chunk } = await call(
          { type: "terminalRead", ...base },
          "terminalData",
        );
        if (disposed) break;
        if (chunk.data.length)
          await new Promise<void>((resolve) =>
            term.write(new Uint8Array(chunk.data), resolve),
          );
        const changed =
          JSON.stringify(result.info) !== JSON.stringify(chunk.info);
        result.info = chunk.info;
        initial = chunk.info;
        if (changed) {
          result.change();
          if (chunk.info.exited)
            window.dispatchEvent(new Event("workspace-reconcile"));
        }
        if (chunk.done) {
          result.change();
          break;
        }
      }
    } catch (e) {
      if (!disposed) {
        inputFailed = true;
        if (!expectedClose(e)) reportError(e);
        result.info = { ...result.info, error: errorText(e) };
        result.change();
      }
    }
  })();
  return result;
}
