import { describe, expect, it } from "vitest";
import type { DockNode } from "../../src/generated/protocol";
import {
  defaultDock,
  hasPanel,
  movePanel,
  panelIds,
  removePanel,
  resizeDock,
  hidePanel,
  showPanel,
  visibleDockRoot,
  restoreDock,
} from "../../src/features/workspace/dockModel";
function leaves(node: DockNode | null): string[] {
  return !node
    ? []
    : node.type === "panel"
      ? [node.panel]
      : [...leaves(node.first), ...leaves(node.second)];
}
describe("movable workspace panes", () => {
  it("starts with separate vertical Git and dedicated terminal areas", () => {
    const layout = defaultDock();
    expect(leaves(visibleDockRoot(layout))).toEqual([
      "explorer",
      "editor",
      "terminal",
      "git",
    ]);
    const root = visibleDockRoot(layout)!;
    if (
      root.type !== "split" ||
      root.second.type !== "split" ||
      root.second.first.type !== "split"
    )
      throw new Error("Missing separate pane regions");
    expect(root.direction).toBe("horizontal");
    expect(root.second.second).toEqual({ type: "panel", panel: "git" });
    expect(root.second.first.direction).toBe("vertical");
    expect(root.second.first.second).toEqual({
      type: "panel",
      panel: "terminal",
    });
  });
  it("moves every pane beside every other pane on every side without loss or duplication", () => {
    let layout = movePanel(
      movePanel(defaultDock(), "output", "workspace", "bottom"),
      "editorSecondary",
      "editor",
      "right",
    );
    const original = JSON.stringify(layout);
    for (const panel of panelIds)
      for (const target of panelIds.filter((id) => id !== panel))
        for (const side of ["left", "right", "top", "bottom"] as const) {
          layout = movePanel(layout, panel, target, side);
          expect(leaves(layout.root).sort()).toEqual([...panelIds].sort());
        }
    expect(JSON.parse(original).root).toBeTruthy();
    const before = JSON.stringify(layout);
    movePanel(layout, "git", "workspace", "left");
    expect(JSON.stringify(layout)).toBe(before);
  });
  it("ignores late resize events for removed branches and refuses nonfinite geometry", () => {
    const original = defaultDock();
    const old = original.root!;
    if (old.type !== "split") throw new Error("Missing split");
    const moved = movePanel(original, "explorer", "git", "right");
    expect(resizeDock(moved, old.id, 0.7)).toBe(moved);
    expect(resizeDock(moved, "not-a-current-split", 0.5)).toBe(moved);
    expect(resizeDock(moved, old.id, Number.NaN)).toBe(moved);
    expect(hasPanel(removePanel(moved.root, "terminal"), "terminal")).toBe(
      false,
    );
  });
});

it("hides and reopens all panels without changing placement or ratios", () => {
  let layout = movePanel(defaultDock(), "explorer", "git", "right");
  const baseline = JSON.stringify(layout.root);
  for (const panel of panelIds) layout = hidePanel(layout, panel);
  expect(visibleDockRoot(layout)).toBeNull();
  for (const panel of [...panelIds].reverse())
    layout = showPanel(layout, panel);
  expect(JSON.stringify(layout.root)).toBe(baseline);
  expect(leaves(visibleDockRoot(layout)).sort()).toEqual([...panelIds].sort());
});
it("migrates legacy layouts retaining all visible positions and remembering missing panes", () => {
  const legacy = {
    version: 1,
    root: visibleDockRoot(defaultDock()),
    hidden: [],
  };
  const next = restoreDock(legacy);
  expect(next.version).toBe(2);
  expect(visibleDockRoot(next)).toEqual(legacy.root);
  expect(next.hidden).toEqual(
    expect.arrayContaining(["editorSecondary", "output"]),
  );
  expect(restoreDock(next)).toBe(next);
});
