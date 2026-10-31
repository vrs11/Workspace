import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { useApp, reportError } from "../../shared/state/store";
import { models, loadDocument } from "./models";
import { useDockVisible } from "../workspace/DockWorkspace";
import { PREVIEW_LIMIT, type PreviewFormat } from "./previewFormat";
import { sanitizePreview } from "./previewSanitizer";
import previewStyle from "./preview.css?inline";
import PreviewWorker from "./preview.worker?worker";

export default function DocumentPreview({
  entry,
  format,
}: {
  entry: string;
  format: PreviewFormat;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Rendering…");
  const [retry, setRetry] = useState(0);
  const visible = useDockVisible();
  const scope = useApp((s) => s.project?.id);
  useEffect(() => {
    const host = surface.current;
    const model = models.get(entry)?.model;
    if (!host || !model || !scope || !visible) return;
    const metadata = useApp.getState().docs[entry];
    if (
      metadata?.encoding === "binary" ||
      /^(?:Bounded preview:|Long-line guard:)/.test(metadata?.readonly ?? "")
    ) {
      setStatus(
        "Rendered mode requires a complete text document. This file is a binary or bounded preview.",
      );
      return;
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = previewStyle;
    const article = document.createElement("article");
    root.replaceChildren(style, article);
    let gone = false,
      running = false,
      queued = false,
      generation = 0;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const leases = new Set<string>();
    const valid = () =>
      !gone &&
      useApp.getState().project?.id === scope &&
      models.get(entry)?.model === model;
    const release = (token: string) => {
      leases.delete(token);
      if (useApp.getState().project?.id === scope)
        void rpc({ type: "closeMedia", scope, token }).catch(() => {});
    };
    const clearImages = () => {
      for (const token of leases) release(token);
    };
    const imageNote = (image: HTMLImageElement, message: string) => {
      const note = document.createElement("span");
      note.className = "preview-image-note";
      note.textContent = `${image.alt ? `${image.alt} — ` : ""}${message}`;
      image.replaceWith(note);
    };
    const images = async (version: number) => {
      const sources = new Map<string, HTMLImageElement[]>();
      for (const image of article.querySelectorAll("img")) {
        const href = image.dataset.previewImage ?? "";
        if (!href || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(href)) {
          imageNote(image, "Remote images are not loaded");
          continue;
        }
        if (!sources.has(href) && sources.size >= 16) {
          imageNote(image, "Image limit reached (16 per preview)");
          continue;
        }
        sources.set(href, [...(sources.get(href) ?? []), image]);
      }
      for (const [href, nodes] of sources) {
        if (!valid() || generation !== version) return;
        try {
          const response = await call(
            { type: "previewImage", scope, document: entry, href },
            "media",
          );
          const token = response.media.token;
          if (!valid() || generation !== version) {
            release(token);
            return;
          }
          leases.add(token);
          for (const image of nodes) {
            image.src = `${convertFileSrc("", "workspace-media")}${scope}/${token}`;
            image.addEventListener(
              "error",
              () => imageNote(image, "Image could not be decoded"),
              { once: true },
            );
          }
        } catch (error) {
          if (valid() && generation === version)
            for (const image of nodes) imageNote(image, errorText(error));
        }
      }
    };
    const show = (html: string) => {
      const fragment = sanitizePreview(html);
      clearImages();
      generation++;
      const scroll = host.parentElement?.scrollTop ?? 0;
      article.replaceChildren(fragment);
      if (host.parentElement) host.parentElement.scrollTop = scroll;
      setStatus("");
      void images(generation);
    };
    const render = () => {
      if (!valid()) return;
      if (running) {
        queued = true;
        return;
      }
      if (model.getValueLength() > PREVIEW_LIMIT) {
        article.replaceChildren();
        clearImages();
        setStatus(
          "Rendered preview supports files up to 1 MiB. Use Code mode for the full file.",
        );
        return;
      }
      setStatus("Rendering…");
      queued = false;
      running = true;
      try {
        worker ??= new PreviewWorker();
      } catch (error) {
        running = false;
        setStatus(`Could not start the preview: ${errorText(error)}`);
        return;
      }
      worker.onmessage = (
        event: MessageEvent<{ version: number; html?: string; error?: string }>,
      ) => {
        clearTimeout(deadline);
        running = false;
        if (!valid()) return;
        if (event.data.version === model.getVersionId()) {
          try {
            if (event.data.error || typeof event.data.html !== "string")
              throw new Error(
                event.data.error || "Could not render this document.",
              );
            show(event.data.html);
          } catch (error) {
            setStatus(errorText(error));
          }
        }
        if (queued) {
          clearTimeout(timer);
          timer = setTimeout(render, 200);
        }
      };
      worker.onerror = () => {
        clearTimeout(deadline);
        worker?.terminate();
        worker = undefined;
        running = false;
        if (valid())
          setStatus("Could not render this document. Retry or use Code mode.");
      };
      deadline = setTimeout(() => {
        worker?.terminate();
        worker = undefined;
        running = false;
        if (valid())
          setStatus(
            "Rendering took too long. Retry or use Code mode for this file.",
          );
      }, 3000);
      try {
        worker.postMessage({
          version: model.getVersionId(),
          text: model.getValue(),
          format,
        });
      } catch (error) {
        clearTimeout(deadline);
        worker.terminate();
        worker = undefined;
        running = false;
        setStatus(`Could not render the preview: ${errorText(error)}`);
      }
    };
    const changed = model.onDidChangeContent(() => {
      generation++;
      clearTimeout(timer);
      timer = setTimeout(render, 200);
    });
    const click = (event: Event) => {
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[data-preview-href]",
      );
      if (!link) return;
      event.preventDefault();
      const href = link.dataset.previewHref!;
      if (href.startsWith("#")) {
        try {
          const id = decodeURIComponent(href.slice(1));
          const target =
            root.getElementById(`user-content-${id}`) ??
            root.getElementById(id);
          if (target && host.parentElement)
            host.parentElement.scrollTop +=
              target.getBoundingClientRect().top -
              host.parentElement.getBoundingClientRect().top -
              12;
        } catch {
          /* A malformed fragment cannot grant navigation authority. */
        }
        return;
      }
      void (async () => {
        if (/^https:\/\//i.test(href)) {
          await rpc({ type: "openLink", url: href });
          return;
        }
        const response = await call(
          { type: "previewLink", scope, document: entry, href },
          "entries",
        );
        if (valid() && response.entries[0])
          await loadDocument(response.entries[0].id);
      })().catch(reportError);
    };
    root.addEventListener("click", click);
    render();
    return () => {
      gone = true;
      generation++;
      clearTimeout(timer);
      clearTimeout(deadline);
      changed.dispose();
      worker?.terminate();
      clearImages();
      root.removeEventListener("click", click);
      root.replaceChildren();
    };
  }, [entry, format, scope, visible, retry]);
  return (
    <section
      className="document-preview"
      aria-label="Rendered document"
      tabIndex={0}
    >
      {status && (
        <div className="preview-status" role="status">
          {status}
          {!status.endsWith("…") && (
            <button onClick={() => setRetry((value) => value + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      <div ref={surface} className="document-preview-content" />
    </section>
  );
}
