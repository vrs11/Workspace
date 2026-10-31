import { renderDocument } from "./previewParser";
import type { PreviewFormat } from "./previewFormat";
self.onmessage = (
  event: MessageEvent<{ version: number; text: string; format: PreviewFormat }>,
) => {
  const { version, text, format } = event.data;
  try {
    self.postMessage({ version, html: renderDocument(text, format) });
  } catch (error) {
    self.postMessage({
      version,
      error:
        error instanceof Error
          ? error.message
          : "Could not render this document.",
    });
  }
};
