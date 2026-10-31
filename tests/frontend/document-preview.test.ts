import { expect, it } from "vitest";
import {
  previewFormat,
  PREVIEW_LIMIT,
} from "../../src/features/editor/previewFormat";
import {
  delimitedRows,
  renderDocument,
} from "../../src/features/editor/previewParser";
import { sanitizePreview } from "../../src/features/editor/previewSanitizer";
it("renders Markdown headings, code, tables, lists and task checkboxes", () => {
  const fragment = sanitizePreview(
    renderDocument(
      "# Title\n\n**bold** and `code`\n\n- [x] done\n\n| one | two |\n| --- | --- |\n| a | b |\n\n```js\nconst x = '<tag>';\n```",
      "markdown",
    ),
  );
  expect(fragment.querySelector("h1")?.id).toBe("user-content-title");
  expect(fragment.querySelector("strong")?.textContent).toBe("bold");
  expect(fragment.querySelector("input")?.disabled).toBe(true);
  expect(fragment.querySelectorAll("td")).toHaveLength(2);
  expect(fragment.querySelector("pre code")?.textContent).toContain("<tag>");
});
it("keeps document HTML inert and leaves images/links for explicit capability resolution", () => {
  const html =
    '<script>alert(1)</script><style>body{display:none}</style><iframe src="https://example.invalid"></iframe><form action="https://example.invalid"><input type="password"></form><div style="position:fixed" onclick="alert(1)" data-preview-href="file:///secret"><img src="https://example.invalid/a.png" srcset="https://example.invalid/b.png" onerror="alert(1)"><a href="javascript:alert(1)">bad</a><a href="../file.md">local</a><h1 id="location">Hello</h1></div>';
  const fragment = sanitizePreview(html);
  expect(fragment.querySelector("script,style,iframe,form,input")).toBeNull();
  expect(
    fragment.querySelector("[style],[onclick],[onerror],[srcset],[src]"),
  ).toBeNull();
  expect(fragment.querySelector("img")?.dataset.previewImage).toBe(
    "https://example.invalid/a.png",
  );
  const links = fragment.querySelectorAll("a");
  expect(links[0].hasAttribute("href")).toBe(false);
  expect(links[1].dataset.previewHref).toBe("../file.md");
  expect(fragment.querySelector("div")?.dataset.previewHref).toBeUndefined();
  expect(fragment.querySelector("h1")?.id).toBe("user-content-location");
});
it("parses quoted CSV/TSV including newlines, escaped quotes, empty and trailing cells", () => {
  expect(delimitedRows('a,"b,c","line\nnext","a""b"\r\nx,,', ",")).toEqual([
    ["a", "b,c", "line\nnext", 'a"b'],
    ["x", "", ""],
  ]);
  expect(delimitedRows("a\tb\r\nc\t\r\n", "\t")).toEqual([
    ["a", "b"],
    ["c", ""],
  ]);
  expect(renderDocument('"<img onerror=alert(1)>"', "csv")).toContain(
    "&lt;img",
  );
  expect(() => delimitedRows('"unfinished', ",")).toThrow("Unclosed");
  expect(() => delimitedRows('"end"extra', ",")).toThrow("unexpected");
});
it("bounds parsing and DOM output without changing the editable source", () => {
  expect(() =>
    renderDocument("x".repeat(PREVIEW_LIMIT + 1), "markdown"),
  ).toThrow("1 MiB");
  expect(() => renderDocument("x\n".repeat(10_001), "csv")).toThrow(
    "10,000 rows",
  );
  expect(() => renderDocument("x,".repeat(256), "csv")).toThrow("256 columns");
  expect(() => sanitizePreview("<br>".repeat(25_001))).toThrow(
    "too many elements",
  );
  expect(previewFormat("README.MD")).toBe("markdown");
  expect(previewFormat("page.html")).toBe("html");
  expect(previewFormat("data.tsv")).toBe("tsv");
  expect(previewFormat("file.ts")).toBeNull();
});
