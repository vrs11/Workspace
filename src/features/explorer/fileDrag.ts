export const fileDragMime = "application/x-agent-workspace-entry";
export type FileDrag = {
  scope: string;
  id: string;
  kind: "file" | "directory";
};
export function readFileDrag(raw: string, scope: string): FileDrag | null {
  if (!raw || raw.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const object = value as Record<string, unknown>;
    return object.scope === scope &&
      typeof object.id === "string" &&
      object.id.length > 0 &&
      object.id.length <= 128 &&
      (object.kind === "file" || object.kind === "directory")
      ? { scope, id: object.id, kind: object.kind }
      : null;
  } catch {
    return null;
  }
}
