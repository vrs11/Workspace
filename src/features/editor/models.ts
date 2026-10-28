import { closeMediaTab } from "../media/session";
import { languageFor } from "./languages";
import type * as Monaco from "monaco-editor";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { useApp, notice, reportError } from "../../shared/state/store";
import { ask } from "../../shared/components/Dialog";
type Handle = {
  model: Monaco.editor.ITextModel;
  listener: Monaco.IDisposable;
  timer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>;
  savedVersion: number;
  revision: number;
  updating: boolean;
};
export const models = new Map<string, Handle>();
let modelEpoch = 0,
  activation = 0;
const loading = new Map<string, Promise<void>>();
export function abandonModelLoads() {
  modelEpoch++;
  loading.clear();
  activation++;
}
export async function settleModelLoads() {
  const epoch = modelEpoch;
  // File operations must see models whose native open already began. Joining
  // loads prevents a just-opened editor from appearing after the close decision.
  while (epoch === modelEpoch && loading.size)
    await Promise.all([...loading.values()]);
}
export async function loadDocument(
  entry: string,
  activate = true,
  text = false,
) {
  if (text && !(await closeDocument(entry))) return;
  const project = useApp.getState().project?.id;
  const ticket = activate ? ++activation : activation;
  let pending = loading.get(entry);
  if (!pending) {
    pending = loadDocumentInner(entry, text, activate ? ticket : undefined);
    loading.set(entry, pending);
    const current = pending;
    void pending
      .finally(() => {
        if (loading.get(entry) === current) loading.delete(entry);
      })
      .catch(() => {});
  }
  await pending;
  const s = useApp.getState();
  if (
    activate &&
    ticket === activation &&
    s.project?.id === project &&
    s.tabs.some((tab) => tab.id === entry)
  ) {
    if (s.active !== entry) s.set({ active: entry });
    window.dispatchEvent(new Event("workspace-reveal-editor"));
  }
}
async function loadDocumentInner(
  entry: string,
  text = false,
  activateTicket?: number,
) {
  const state = useApp.getState();
  const epoch = modelEpoch;
  if (!state.project) return;
  let handle = models.get(entry);
  if (!handle) {
    const existing = useApp
      .getState()
      .tabs.find((tab) => tab.kind === "media" && tab.entry === entry);
    if (existing) return;
    const response = await rpc({
      type: text ? "openDocument" : "openFile",
      scope: state.project.id,
      entry,
    });
    if (
      epoch !== modelEpoch ||
      useApp.getState().project?.id !== state.project.id
    )
      return;
    if (response.type === "media") {
      useApp.setState((s) => ({
        tabs: [
          ...s.tabs.filter((tab) => tab.id !== entry),
          {
            id: entry,
            kind: "media",
            instance: crypto.randomUUID(),
            entry,
            title: response.media.name,
            media: response.media,
          },
        ],
        ...(activateTicket === activation ? { active: entry } : {}),
      }));
      return;
    }
    if (response.type !== "document")
      throw new Error("Expected an opened file");
    const d = response.document;
    const { monaco } = await import("./monaco");
    if (
      epoch !== modelEpoch ||
      useApp.getState().project?.id !== state.project.id
    )
      return;
    const language = languageFor(monaco, d.name, d.recovery ?? d.text);
    const model = monaco.editor.createModel(
      d.recovery ?? d.text,
      language,
      monaco.Uri.from({
        scheme: "workspace",
        authority: state.project.id,
        path: `/${d.id}/${d.name}`,
      }),
    );
    const { text: _text, recovery: _recovery, ...metadata } = d;
    useApp.setState((s) => ({
      docs: {
        ...s.docs,
        [entry]: {
          ...metadata,
          language,
          dirty: d.recovery !== null,
          recovering: d.recovery !== null,
          acknowledged: d.revision,
          conflict: !!d.readonly?.startsWith("External change"),
          recoveryError: null,
          saveError: null,
        },
      },
    }));
    handle = {
      model,
      savedVersion: d.recovery !== null ? -1 : model.getAlternativeVersionId(),
      revision: d.revision,
      updating: false,
      timer: null,
      queue: Promise.resolve(),
      listener: { dispose() {} },
    };
    const h = handle;
    h.listener = model.onDidChangeContent(() => {
      if (h.updating) return;
      h.revision++;
      const dirty = model.getAlternativeVersionId() !== h.savedVersion;
      useApp.getState().doc(entry, { dirty, revision: h.revision });
      if (h.timer) clearTimeout(h.timer);
      h.timer = setTimeout(() => {
        void checkpoint(entry).catch((error) =>
          reportError(error, { prefix: "Recovery checkpoint failed: " }),
        );
      }, 500);
    });
    models.set(entry, handle);
  }
  useApp.setState((s) => ({
    tabs: s.tabs.some((t) => t.id === entry)
      ? s.tabs
      : [
          ...s.tabs,
          { id: entry, kind: "editor", entry, title: s.docs[entry].name },
        ],
    // A new tab and its selection are one transition. Restores and superseded
    // requests leave selection alone; a later deduplicated caller can still
    // activate the completed load through its own ticket above.
    ...(activateTicket === activation ? { active: entry } : {}),
  }));
}
function enqueue(h: Handle, work: () => Promise<void>) {
  const next = h.queue.catch(() => {}).then(work);
  h.queue = next;
  return next;
}
function snapshot(h: Handle) {
  return {
    text: h.model.getValue(),
    revision: h.revision,
    version: h.model.getAlternativeVersionId(),
  };
}
async function checkpointSnapshot(
  entry: string,
  h: Handle,
  value: ReturnType<typeof snapshot>,
) {
  const state = useApp.getState();
  const d = state.docs[entry];
  if (
    models.get(entry) !== h ||
    !state.project ||
    !d ||
    d.readonly ||
    value.revision < d.acknowledged
  )
    return;
  const scope = state.project.id;
  try {
    await call(
      {
        type: "checkpoint",
        scope,
        document: entry,
        text: value.text,
        revision: value.revision,
        baseline: d.baseline,
      },
      "saved",
    );
    const current = useApp.getState();
    if (current.project?.id === scope && current.docs[entry])
      current.doc(entry, { acknowledged: value.revision, recoveryError: null });
  } catch (error) {
    const current = useApp.getState();
    if (current.project?.id === scope && current.docs[entry])
      current.doc(entry, { recoveryError: errorText(error) });
    throw error;
  }
}
export async function checkpoint(entry: string) {
  const h = models.get(entry);
  if (!h) return;
  if (h.timer) {
    clearTimeout(h.timer);
    h.timer = null;
  }
  const value = snapshot(h);
  await enqueue(h, () => checkpointSnapshot(entry, h, value));
}
export async function saveDocument(entry: string, automatic = false) {
  const h = models.get(entry);
  const scope = useApp.getState().project?.id;
  if (!h || !scope) return;
  if (h.timer) {
    clearTimeout(h.timer);
    h.timer = null;
  }
  await enqueue(h, async () => {
    const s = useApp.getState();
    const d = s.docs[entry];
    if (models.get(entry) !== h || s.project?.id !== scope || !d) return;
    if (
      automatic &&
      (!s.project.trusted ||
        !d.dirty ||
        d.readonly ||
        d.recovering ||
        d.conflict)
    )
      return;
    const value = snapshot(h);
    try {
      await checkpointSnapshot(entry, h, value);
      const result = await call(
        {
          type: "save",
          scope,
          document: entry,
          text: value.text,
          revision: value.revision,
          baseline: d.baseline,
        },
        "saved",
      );
      if (
        models.get(entry) !== h ||
        useApp.getState().project?.id !== scope ||
        !useApp.getState().docs[entry]
      )
        return;
      h.savedVersion = value.version;
      useApp.getState().doc(entry, {
        baseline: result.baseline,
        recovering: false,
        dirty: h.model.getAlternativeVersionId() !== value.version,
        conflict: false,
        saveError: null,
      });
      window.dispatchEvent(new Event("workspace-refresh"));
    } catch (error) {
      if (
        models.get(entry) === h &&
        useApp.getState().project?.id === scope &&
        useApp.getState().docs[entry]
      )
        useApp.getState().doc(entry, {
          saveError: errorText(error),
          ...(typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "conflict"
            ? { conflict: true }
            : {}),
        });
      throw error;
    }
  });
}
export async function saveAll() {
  for (const [id, d] of Object.entries(useApp.getState().docs))
    if (d.dirty) await saveDocument(id);
}
export async function closeDocument(entry: string, autoSave = true) {
  await loading.get(entry);
  const s = useApp.getState();
  if (!s.project) return false;
  const mediaTab = s.tabs.find(
    (tab) => tab.id === entry && tab.kind === "media",
  );
  if (mediaTab?.kind === "media") return closeMediaTab(entry);

  const h = models.get(entry);
  let discarded = false;
  if (autoSave && s.docs[entry]?.dirty) {
    try {
      await saveDocument(entry, true);
    } catch (error) {
      reportError(error, { prefix: "Could not save before closing: " });
    }
  }
  if (useApp.getState().docs[entry]?.dirty) {
    const action = await ask({
      title: "Unsaved changes",
      description: `${s.docs[entry].path}: save or explicitly discard this buffer.`,
      choices: ["Save", "Discard"],
    });
    if (!action) return false;
    if (action === "Save") await saveDocument(entry);
    else {
      if (h?.timer) {
        clearTimeout(h.timer);
        h.timer = null;
      }
      await h?.queue.catch(() => {});
      const revision = h?.revision;
      await rpc({ type: "discard", scope: s.project.id, document: entry });
      if (h && h.revision !== revision) {
        await checkpoint(entry);
        notice("New edits arrived while discarding; the editor was kept open.");
        return false;
      }
      discarded = true;
    }
  }
  if (!discarded) {
    // Join earlier saves/reconciliation before deciding whether a durable write
    // is needed. A loaded/saved, already acknowledged clean model has no new
    // recovery bytes; an undo-to-clean model can still need acknowledgement.
    await h?.queue.catch(() => {});
    const closing = useApp.getState().docs[entry];
    if (closing && (closing.dirty || closing.revision !== closing.acknowledged))
      await checkpoint(entry);
    if (useApp.getState().docs[entry]?.dirty) {
      notice(
        "New edits arrived while closing; save or discard the current buffer.",
      );
      return false;
    }
  }
  const revision = h?.revision;
  await rpc({ type: "closeDocument", scope: s.project.id, document: entry });
  if (h && h.revision !== revision) {
    await call(
      { type: "openDocument", scope: s.project.id, entry },
      "document",
    );
    await checkpoint(entry);
    notice("New edits arrived while closing; the editor was kept open.");
    return false;
  }
  disposeModel(entry);
  useApp.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== entry);
    const docs = { ...s.docs };
    delete docs[entry];
    return {
      docs,
      tabs,
      active: s.active === entry ? (tabs.at(-1)?.id ?? null) : s.active,
      split: s.split === entry ? null : s.split,
    };
  });
  return true;
}
export function disposeModel(entry: string) {
  const h = models.get(entry);
  if (h) {
    if (h.timer) clearTimeout(h.timer);
    h.listener.dispose();
    h.model.dispose();
    models.delete(entry);
  }
}
let reconciling = false;
export async function reconcileDocuments() {
  if (reconciling) return;
  reconciling = true;
  try {
    await reconcileOpenDocuments();
  } finally {
    reconciling = false;
  }
}
async function reconcileOpenDocuments() {
  const s = useApp.getState();
  if (!s.project) return;
  const scope = s.project.id;
  for (const [id, h] of models) {
    await enqueue(h, async () => {
      const meta = useApp.getState().docs[id];
      if (
        !meta ||
        models.get(id) !== h ||
        useApp.getState().project?.id !== scope
      )
        return;
      const revision = h.revision;
      try {
        const { document: d, refresh } = await call(
          { type: "reconcileDocument", scope: scope, document: id },
          "reconciled",
        );
        if (models.get(id) !== h || useApp.getState().project?.id !== scope)
          return;
        const current = useApp.getState().docs[id];
        if (current.dirty || h.revision !== revision) {
          if (refresh) {
            await rpc({
              type: "finishReconcile",
              scope: scope,
              refresh,
              accept: false,
            });
            await checkpointSnapshot(id, h, snapshot(h));
          }
          if (
            d.baseline !== current.baseline ||
            d.readonly?.startsWith("External change")
          )
            useApp.getState().doc(id, { conflict: true });
        } else {
          // No await between the revision check and the synchronous model update:
          // typing that follows uses the adopted baseline, and cannot be erased.
          if (d.baseline !== meta.baseline) {
            window.dispatchEvent(
              new CustomEvent("editor-before-reload", { detail: id }),
            );
            h.updating = true;
            try {
              h.model.setValue(d.text);
            } finally {
              h.updating = false;
            }
            h.revision = Math.max(h.revision, d.revision);
            h.savedVersion = h.model.getAlternativeVersionId();
            window.dispatchEvent(
              new CustomEvent("editor-after-reload", { detail: id }),
            );
          }
          useApp.getState().doc(id, {
            baseline: d.baseline,
            readonly: d.readonly,
            dirty: false,
            revision: h.revision,
            acknowledged: d.revision,
            conflict: false,
            saveError: null,
          });
          if (refresh) {
            await rpc({
              type: "finishReconcile",
              scope: scope,
              refresh,
              accept: true,
            });
          }
        }
      } catch (error) {
        if (models.get(id) !== h || useApp.getState().project?.id !== scope)
          return;
        useApp.getState().doc(id, { conflict: true });
        notice(
          `External change/deletion: ${meta.path}. Buffer retained. ${errorText(error)}`,
        );
      }
    });
  }
}
