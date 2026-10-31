export type PreviewFormat = "markdown" | "html" | "csv" | "tsv";
export const PREVIEW_LIMIT = 1024 * 1024;
export function previewFormat(name: string): PreviewFormat | null {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["md", "markdown", "mdown", "mkd", "mkdn"].includes(extension ?? ""))
    return "markdown";
  if (["html", "htm", "xhtml"].includes(extension ?? "")) return "html";
  return extension === "csv" || extension === "tsv" ? extension : null;
}
