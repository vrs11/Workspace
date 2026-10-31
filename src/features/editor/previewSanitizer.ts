import DOMPurify from "dompurify";
export function sanitizePreview(html: string) {
  if (html.length > 4 * 1024 * 1024)
    throw new Error(
      "Rendered output is too large. Use Code mode for this file.",
    );
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    SANITIZE_NAMED_PROPS: true,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_TAGS: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "hr",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "em",
      "strong",
      "b",
      "i",
      "u",
      "s",
      "del",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "th",
      "td",
      "caption",
      "div",
      "span",
      "section",
      "article",
      "header",
      "footer",
      "main",
      "nav",
      "details",
      "summary",
      "dl",
      "dt",
      "dd",
      "kbd",
      "samp",
      "sub",
      "sup",
      "input",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      "id",
      "class",
      "colspan",
      "rowspan",
      "start",
      "type",
      "checked",
      "disabled",
    ],
  });
  if (fragment.querySelectorAll("*").length > 25_000)
    throw new Error(
      "This preview contains too many elements. Use Code mode for the full document.",
    );
  for (const input of fragment.querySelectorAll("input")) {
    if (input.getAttribute("type") !== "checkbox") input.remove();
    else {
      input.disabled = true;
      input.tabIndex = -1;
    }
  }
  for (const image of fragment.querySelectorAll("img")) {
    const source = image.getAttribute("src");
    image.removeAttribute("src");
    if (source) image.dataset.previewImage = source;
    image.loading = "lazy";
    image.decoding = "async";
  }
  for (const link of fragment.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    link.removeAttribute("href");
    if (href) {
      link.dataset.previewHref = href;
      link.href = "#";
    }
  }
  const ids = new Set(
    [...fragment.querySelectorAll("[id]")].map((node) => node.id),
  );
  for (const heading of fragment.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (heading.id) continue;
    const slug =
      (heading.textContent ?? "")
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-")
        .slice(0, 200) || "heading";
    let id = `user-content-${slug}`,
      suffix = 1;
    while (ids.has(id)) id = `user-content-${slug}-${suffix++}`;
    heading.id = id;
    ids.add(id);
  }
  return fragment;
}
