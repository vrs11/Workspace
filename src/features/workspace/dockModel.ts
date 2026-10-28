import type { DockLayout, DockNode, DockPanel } from "../../generated/protocol";
export type DockSide = "left" | "right" | "top" | "bottom";
export const panelIds: DockPanel[] = [
  "explorer",
  "editor",
  "editorSecondary",
  "git",
  "terminal",
  "output",
];
export const panelTitles: Record<DockPanel, string> = {
  explorer: "Explorer",
  editor: "Editor",
  editorSecondary: "Editor split",
  git: "Git",
  terminal: "Terminal",
  output: "Output",
};
const leaf = (panel: DockPanel): DockNode => ({ type: "panel", panel });
export function defaultDock(): DockLayout {
  return {
    version: 2,
    hidden: ["editorSecondary", "output"],
    root: {
      type: "split",
      id: "explorer-main",
      direction: "horizontal",
      ratio: 0.2,
      first: leaf("explorer"),
      second: {
        type: "split",
        id: "center-git",
        direction: "horizontal",
        ratio: 0.7,
        first: {
          type: "split",
          id: "editor-terminal",
          direction: "vertical",
          ratio: 0.7,
          first: {
            type: "split",
            id: "editors",
            direction: "horizontal",
            ratio: 0.5,
            first: leaf("editor"),
            second: leaf("editorSecondary"),
          },
          second: {
            type: "split",
            id: "terminal-output",
            direction: "vertical",
            ratio: 0.7,
            first: leaf("terminal"),
            second: leaf("output"),
          },
        },
        second: leaf("git"),
      },
    },
  };
}
export function hasPanel(node: DockNode | null, panel: DockPanel): boolean {
  return (
    !!node &&
    (node.type === "panel"
      ? node.panel === panel
      : hasPanel(node.first, panel) || hasPanel(node.second, panel))
  );
}
export function removePanel(
  node: DockNode | null,
  panel: DockPanel,
): DockNode | null {
  if (!node || node.type === "panel")
    return node?.panel === panel ? null : node;
  const first = removePanel(node.first, panel),
    second = removePanel(node.second, panel);
  return !first
    ? second
    : !second
      ? first
      : first === node.first && second === node.second
        ? node
        : { ...node, first, second };
}
let sequence = 0;
function join(existing: DockNode, panel: DockPanel, side: DockSide): DockNode {
  const before = side === "left" || side === "top";
  return {
    type: "split",
    id: `dock-${++sequence}-${crypto.randomUUID()}`,
    direction: side === "left" || side === "right" ? "horizontal" : "vertical",
    ratio: before ? 0.25 : 0.75,
    first: before ? leaf(panel) : existing,
    second: before ? existing : leaf(panel),
  };
}
export function movePanel(
  layout: DockLayout,
  panel: DockPanel,
  target: DockPanel | "workspace",
  side: DockSide,
): DockLayout {
  if (panel === target) return layout;
  const root = removePanel(layout.root, panel);
  const hidden = (layout.hidden ?? []).filter((id) => id !== panel);
  if (!root) return { version: 2, hidden, root: leaf(panel) };
  if (target === "workspace" || !hasPanel(root, target))
    return { version: 2, hidden, root: join(root, panel, side) };
  const insert = (node: DockNode): DockNode =>
    node.type === "panel"
      ? node.panel === target
        ? join(node, panel, side)
        : node
      : { ...node, first: insert(node.first), second: insert(node.second) };
  return { version: 2, hidden, root: insert(root) };
}
export function resizeDock(
  layout: DockLayout,
  id: string,
  ratio: number,
): DockLayout {
  if (!Number.isFinite(ratio)) return layout;
  const visit = (node: DockNode): DockNode => {
    if (node.type === "panel") return node;
    if (node.id === id)
      return Math.abs(node.ratio - ratio) < 0.001
        ? node
        : { ...node, ratio: Math.min(0.95, Math.max(0.05, ratio)) };
    const first = visit(node.first),
      second = visit(node.second);
    return first === node.first && second === node.second
      ? node
      : { ...node, first, second };
  };
  const root = layout.root ? visit(layout.root) : null;
  return root === layout.root ? layout : { ...layout, root };
}

// Visibility is separate from geometry: closing a tool window never discards
// its dock slot, siblings or saved split ratios.
export function isPanelVisible(layout: DockLayout, panel: DockPanel) {
  return hasPanel(layout.root, panel) && !(layout.hidden ?? []).includes(panel);
}
export function hidePanel(layout: DockLayout, panel: DockPanel): DockLayout {
  return !isPanelVisible(layout, panel)
    ? layout
    : { ...layout, hidden: [...(layout.hidden ?? []), panel] };
}
export function showPanel(layout: DockLayout, panel: DockPanel): DockLayout {
  if (!hasPanel(layout.root, panel))
    return movePanel(
      layout,
      panel,
      "workspace",
      panel === "terminal" || panel === "output" ? "bottom" : "right",
    );
  return isPanelVisible(layout, panel)
    ? layout
    : { ...layout, hidden: (layout.hidden ?? []).filter((id) => id !== panel) };
}
export function visibleDockRoot(layout: DockLayout): DockNode | null {
  let root = layout.root;
  for (const panel of layout.hidden ?? []) root = removePanel(root, panel);
  return root;
}
export function restoreDock(layout: DockLayout | null | undefined): DockLayout {
  if (!layout) return defaultDock();
  if (layout.version === 2) return layout;
  let next: DockLayout = { ...layout, version: 2, hidden: [] };
  for (const panel of panelIds)
    if (!hasPanel(next.root, panel)) {
      next = movePanel(
        next,
        panel,
        panel === "editorSecondary" ? "editor" : "workspace",
        panel === "terminal" || panel === "output" ? "bottom" : "right",
      );
      next = hidePanel(next, panel);
    }
  return next;
}
export function dockKey(node: DockNode): string {
  return node.type === "panel"
    ? node.panel
    : `${node.id}(${dockKey(node.first)},${dockKey(node.second)})`;
}
