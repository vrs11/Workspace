import { marked } from "marked";
import { PREVIEW_LIMIT, type PreviewFormat } from "./previewFormat";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
export function delimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    afterQuote = false;
  const field = () => {
    row.push(cell);
    cell = "";
    afterQuote = false;
    if (row.length > 256)
      throw new Error("Table preview supports up to 256 columns.");
  };
  const record = () => {
    field();
    rows.push(row);
    row = [];
    if (rows.length > 10_000)
      throw new Error(
        "Table preview supports up to 10,000 rows. Use Code mode for the full file.",
      );
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else cell += char;
    } else if (char === delimiter) field();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record();
    } else if (char === '"' && !cell && !afterQuote) quoted = true;
    else {
      if (afterQuote)
        throw new Error(
          "Invalid table: unexpected content after a quoted field.",
        );
      cell += char;
    }
  }
  if (quoted)
    throw new Error(
      "Unclosed quoted field. Finish the value or use Code mode.",
    );
  if (cell || row.length || afterQuote) record();
  return rows;
}
export function renderDocument(text: string, format: PreviewFormat): string {
  if (
    text.length > PREVIEW_LIMIT ||
    new TextEncoder().encode(text).byteLength > PREVIEW_LIMIT
  )
    throw new Error(
      "Rendered preview supports files up to 1 MiB. Use Code mode for the full file.",
    );
  if (format === "markdown")
    return marked.parse(text, { async: false, gfm: true });
  if (format === "html") return text;
  const rows = delimitedRows(
    text.replace(/^\uFEFF/, ""),
    format === "csv" ? "," : "\t",
  );
  return `<table><tbody>${rows.map((row) => `<tr>${row.map((value) => `<td>${escape(value)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
