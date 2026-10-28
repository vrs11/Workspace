import type { TerminalNode } from "../../generated/protocol";
export function panes(
  node: TerminalNode,
): Extract<TerminalNode, { type: "pane" }>[] {
  return node.type === "pane"
    ? [node]
    : [...panes(node.first), ...panes(node.second)];
}
export function mapPane(
  node: TerminalNode,
  id: string,
  replace: (n: Extract<TerminalNode, { type: "pane" }>) => TerminalNode,
): TerminalNode {
  return node.type === "pane"
    ? node.id === id
      ? replace(node)
      : node
    : {
        ...node,
        first: mapPane(node.first, id, replace),
        second: mapPane(node.second, id, replace),
      };
}
export function removePane(
  node: TerminalNode,
  id: string,
): TerminalNode | null {
  if (node.type === "pane") return node.id === id ? null : node;
  const first = removePane(node.first, id),
    second = removePane(node.second, id);
  return first && second ? { ...node, first, second } : (first ?? second);
}
export function ratio(
  node: TerminalNode,
  id: string,
  value: number,
): TerminalNode {
  if (node.type === "pane") return node;
  return {
    ...node,
    ratio: node.id === id ? value : node.ratio,
    first: ratio(node.first, id, value),
    second: ratio(node.second, id, value),
  };
}
