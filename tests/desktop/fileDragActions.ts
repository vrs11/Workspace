// Scoped drop routing for broad UI suites. file-transfer.spec exercises real OS sessions.
import { browser } from "@wdio/globals";
import type { Entry } from "../../src/generated/protocol";
export async function startDrag(selector: string) {
  await browser.execute(async (selector) => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const api = (
      window as unknown as {
        __TAURI__: {
          core: {
            invoke(
              command: string,
              args: object,
            ): Promise<{ project: { id: string } }>;
          };
        };
      }
    ).__TAURI__;
    const boot = await api.core.invoke("dispatch", {
      request: { type: "bootstrap" },
    });
    (
      window as unknown as { __fileDrag: { scope: string; entries: Entry[] } }
    ).__fileDrag = {
      scope: boot.project.id,
      entries: [
        {
          id: element.dataset.fileEntry!,
          kind: element.dataset.fileKind!,
          name: element.title.split(/[\\/]/).at(-1)!,
          path: element.title,
        },
      ],
    };
  }, selector);
}
export async function dropOn(selector: string) {
  await browser.execute((selector) => {
    const target = document.querySelector<HTMLElement>(selector)!;
    const state = window as unknown as {
      __fileDrag?: { scope: string; entries: Entry[] };
    };
    window.dispatchEvent(
      new CustomEvent("workspace-file-drop", {
        detail: { target, drag: state.__fileDrag, offer: null, folder: null },
      }),
    );
    delete state.__fileDrag;
  }, selector);
}
