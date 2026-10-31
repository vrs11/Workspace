import { expect, it } from "vitest";
import {
  selectEntries,
  selectionRoots,
} from "../../src/features/explorer/selection";
import type { Entry } from "../../src/generated/protocol";
const entry = (id: string, path = id, kind = "file"): Entry => ({
  id,
  path,
  name: id,
  kind,
});
const rows = [entry("a"), entry("b"), entry("c"), entry("d")];
const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
it("supports plain, additive and toggle selection with a stable range anchor", () => {
  let state = selectEntries({ ids: new Set(), anchor: null }, rows, "b", plain);
  expect([...state.ids]).toEqual(["b"]);
  state = selectEntries(state, rows, "d", { ...plain, shiftKey: true });
  expect([...state.ids]).toEqual(["b", "c", "d"]);
  state = selectEntries(state, rows, "c", { ...plain, shiftKey: true });
  expect([...state.ids]).toEqual(["b", "c"]);
  state = selectEntries(state, rows, "a", { ...plain, metaKey: true });
  expect([...state.ids]).toEqual(["b", "c", "a"]);
  state = selectEntries(state, rows, "b", { ...plain, ctrlKey: true });
  expect([...state.ids]).toEqual(["c", "a"]);
  state = selectEntries(state, rows, "d", plain);
  expect([...state.ids]).toEqual(["d"]);
});
it("adds a range to unrelated selected files and recovers a missing anchor", () => {
  const state = selectEntries({ ids: new Set(["a"]), anchor: "c" }, rows, "d", {
    ...plain,
    shiftKey: true,
    metaKey: true,
  });
  expect([...state.ids]).toEqual(["a", "c", "d"]);
  expect([
    ...selectEntries({ ids: new Set(["a"]), anchor: "gone" }, rows, "b", {
      ...plain,
      shiftKey: true,
    }).ids,
  ]).toEqual(["b"]);
});
it("moves/deletes selected folders once without dropping similarly named siblings", () => {
  const folder = entry("src", "src", "directory");
  const child = entry("child", "src/sub/file.txt");
  const sibling = entry("sibling", "src-other/file.txt");
  expect(selectionRoots([child, folder, sibling, folder], "/")).toEqual([
    folder,
    sibling,
  ]);
  expect(
    selectionRoots([entry("win", "src\\file"), folder, sibling], "\\"),
  ).toEqual([folder, sibling]);
});
