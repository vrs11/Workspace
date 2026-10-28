import { rpc } from "../../shared/ipc/client";
import { useApp, reportError } from "../../shared/state/store";
const pending = new Map<string, Set<Promise<unknown>>>();
export function viewOperation<T>(
  scope: string,
  id: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${scope}:${id}`,
    operations = pending.get(key) ?? new Set<Promise<unknown>>();
  pending.set(key, operations);
  const operation = Promise.resolve().then(work);
  operations.add(operation);
  void operation
    .finally(() => {
      operations.delete(operation);
      if (!operations.size && pending.get(key) === operations)
        pending.delete(key);
    })
    .catch(() => {});
  return operation;
}
async function release(scope: string, diffs: string[], previews: string[]) {
  await Promise.allSettled(
    [...diffs, ...previews].flatMap((id) => [
      ...(pending.get(`${scope}:${id}`) ?? []),
    ]),
  );
  if (useApp.getState().project?.id !== scope) return;
  await rpc({ type: "releaseViews", scope, diffs, previews });
}
export function releasePreview(scope: string, id: string) {
  void release(scope, [], [id]).catch(reportError);
}
export function installViewResources() {
  return useApp.subscribe((state, previous) => {
    const scope = previous.project?.id;
    if (!scope || state.project?.id !== scope || state.tabs === previous.tabs)
      return;
    const retained = new Set(
      state.tabs.flatMap((tab) => (tab.kind === "diff" ? [tab.diff.id] : [])),
    );
    const removed = [
      ...new Set(
        previous.tabs.flatMap((tab) =>
          tab.kind === "diff" && !retained.has(tab.diff.id)
            ? [tab.diff.id]
            : [],
        ),
      ),
    ];
    if (removed.length) void release(scope, removed, []).catch(reportError);
  });
}
