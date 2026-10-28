import { call, rpc } from "../../shared/ipc/client";
import { useApp, type Tab } from "../../shared/state/store";
type MediaTab = Extract<Tab, { kind: "media" }>;
const operations = new Map<string, Promise<unknown>>();
function current(scope: string, initial: MediaTab) {
  const state = useApp.getState();
  if (state.project?.id !== scope) return;
  return state.tabs.find(
    (tab): tab is MediaTab =>
      tab.kind === "media" && tab.instance === initial.instance,
  );
}
function enqueue<T>(id: string, operation: () => Promise<T>) {
  const next = (operations.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  operations.set(id, next);
  void next
    .finally(() => {
      if (operations.get(id) === next) operations.delete(id);
    })
    .catch(() => {});
  return next;
}
export async function reloadMedia(entry: string) {
  const state = useApp.getState(),
    scope = state.project?.id;
  const initial = state.tabs.find(
    (tab): tab is MediaTab => tab.kind === "media" && tab.entry === entry,
  );
  if (!scope || !initial) return;
  await enqueue(entry, async () => {
    const tab = current(scope, initial);
    if (!tab) return;
    const result = await call({ type: "openFile", scope, entry }, "media");
    if (!current(scope, initial)) {
      if (useApp.getState().project?.id === scope)
        await rpc({ type: "closeMedia", scope, token: result.media.token });
      return;
    }
    useApp.setState((s) => ({
      tabs: s.tabs.map((candidate) =>
        candidate.kind === "media" && candidate.instance === initial.instance
          ? { ...candidate, media: result.media }
          : candidate,
      ),
    }));
  });
}
export async function closeMediaTab(entry: string): Promise<boolean> {
  const state = useApp.getState(),
    scope = state.project?.id;
  const initial = state.tabs.find(
    (tab): tab is MediaTab => tab.kind === "media" && tab.entry === entry,
  );
  if (!scope || !initial) return false;
  return enqueue(entry, async () => {
    const tab = current(scope, initial);
    if (!tab) return true;
    await rpc({ type: "closeMedia", scope, token: tab.media.token });
    if (!current(scope, initial)) return true;
    useApp.setState((s) => {
      const tabs = s.tabs.filter(
        (candidate) =>
          candidate.kind !== "media" || candidate.instance !== initial.instance,
      );
      return {
        tabs,
        active: s.active === entry ? (tabs.at(-1)?.id ?? null) : s.active,
      };
    });
    return true;
  });
}
