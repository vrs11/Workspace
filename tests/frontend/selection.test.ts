import { afterEach, expect, it } from "vitest";
import {
  registerSelectionReader,
  selectedFileQuery,
} from "../../src/shared/selection";
afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});
it("seeds from selected input or rendered text and never uses password selection", () => {
  document.body.innerHTML =
    '<input value="prefix hello.ts suffix"><p>src/日本語.ts</p><input type="password" value="private">';
  const input = document.querySelector("input")!;
  input.focus();
  input.setSelectionRange(7, 15);
  expect(selectedFileQuery()).toBe("hello.ts");
  const password = document.querySelector<HTMLInputElement>(
    "input[type=password]",
  )!;
  password.focus();
  password.select();
  expect(selectedFileQuery()).toBe("");
  password.blur();
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("p")!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  expect(selectedFileQuery()).toBe("src/日本語.ts");
});
it("reads lazy editor/terminal selections on demand, bounds UTF-8 and unregisters closed views", () => {
  let reads = 0;
  const stop = registerSelectionReader(() => {
    reads++;
    return "🌍".repeat(300) + "\nrest";
  });
  expect(reads).toBe(0);
  const query = selectedFileQuery();
  expect(query).toBe("🌍".repeat(250));
  expect(new TextEncoder().encode(query)).toHaveLength(1000);
  stop();
  expect(selectedFileQuery()).toBe("");
  expect(reads).toBe(1);
  const stopFirst = registerSelectionReader(() => null),
    stopNext = registerSelectionReader(() => " hello.ts\nnext line ");
  expect(selectedFileQuery()).toBe("hello.ts");
  stopFirst();
  stopNext();
});
