import { test } from "node:test";
import assert from "node:assert/strict";
import { noticeTextIndex } from "../scripts/license-notices.mjs";

test("only identical full notices share text and distinct copyright remains separate", () => {
  const index = noticeTextIndex();
  const first = "Copyright First contributor\nPermission is granted.\n";
  const second = "Copyright Second contributor\nPermission is granted.\n";
  assert.equal(index.reference(first), index.reference(first));
  assert.notEqual(index.reference(first), index.reference(second));
  const sections = index.sections();
  assert.equal(sections.filter((item) => item === first).length, 1);
  assert.equal(sections.filter((item) => item === second).length, 1);
  assert.ok(sections.includes("## License text 1"));
  assert.ok(sections.includes("## License text 2"));
});

test("keeps text unchanged, safely fences Markdown and preserves distinct whitespace", () => {
  const index = noticeTextIndex();
  const text = "Original notice 🌍\r\n```text\n  exact text\n```\n";
  const reference = index.reference(text);
  assert.notEqual(reference, index.reference(text.trim()));
  const sections = index.sections();
  assert.ok(sections.includes(text));
  assert.ok(sections.includes("````text"));
  assert.deepEqual(noticeTextIndex().sections(), []);
});
