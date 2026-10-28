import { useApp, reportError } from "../../shared/state/store";
import { saveDocument } from "./models";

const failed = new Map<string, { revision: number; baseline: string }>();
let flushing: Promise<void> | null = null;

export function flushAutoSave(explicitAction = false): Promise<void> {
  if (flushing) return flushing;
  const state = useApp.getState();
  if (
    !state.project?.trusted ||
    (!explicitAction &&
      (state.busy ||
        document.querySelector(
          '.dialog-content[role="dialog"], [role="menu"]',
        )))
  )
    return Promise.resolve();
  const scope = state.project.id;
  flushing = (async () => {
    for (const [entry, d] of Object.entries(state.docs)) {
      if (useApp.getState().project?.id !== scope) break;
      const key = `${scope}:${entry}`;
      const previous = failed.get(key);
      if (!d.dirty || d.readonly || d.recovering || d.conflict) continue;
      // Failed automatic writes wait for an edit or an explicit Save/Retry.
      if (
        d.saveError &&
        previous?.revision === d.revision &&
        previous.baseline === d.baseline
      )
        continue;
      try {
        await saveDocument(entry, true);
        failed.delete(key);
      } catch (error) {
        failed.set(key, { revision: d.revision, baseline: d.baseline });
        reportError(error, { prefix: `Could not autosave ${d.path}: ` });
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Install once at app lifetime. Timers only exist while eligible work is dirty. */
export function installAutoSave() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let lastScope = useApp.getState().project?.id;
  let focusSavePending = false;
  let active = true;
  const flushFocusSave = () => {
    const state = useApp.getState();
    if (
      !active ||
      !focusSavePending ||
      state.busy ||
      document.querySelector('.dialog-content[role="dialog"], [role="menu"]')
    )
      return;
    focusSavePending = false;
    void flushAutoSave();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const state = useApp.getState();
    if (
      !state.project?.trusted ||
      state.busy ||
      !state.settings?.autoSaveIdle ||
      !Object.values(state.docs).some(
        (d) => d.dirty && !d.readonly && !d.recovering && !d.conflict,
      )
    )
      return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void flushAutoSave();
      },
      Math.max(
        0,
        state.settings.autoSaveDelay * 1000 - (Date.now() - lastActivity),
      ),
    );
  };
  const activity = () => {
    lastActivity = Date.now();
    schedule();
  };
  const onBlur = () => {
    if (useApp.getState().settings?.autoSaveOnFocusLoss) {
      focusSavePending = true;
      flushFocusSave();
    }
  };
  const onFocus = (event: FocusEvent) => {
    flushFocusSave();
    if (
      event.target instanceof Element &&
      event.target.closest('[data-dock-panel="terminal"]') &&
      (!(event.relatedTarget instanceof Element) ||
        !event.relatedTarget.closest('[data-dock-panel="terminal"]'))
    )
      onBlur();
  };
  const unsubscribe = useApp.subscribe((state, previous) => {
    if (lastScope !== state.project?.id) {
      failed.clear();
      lastScope = state.project?.id;
      focusSavePending = false;
    }
    if (
      state.docs !== previous.docs ||
      state.settings !== previous.settings ||
      state.project !== previous.project ||
      (state.busy === 0 && previous.busy !== 0)
    )
      schedule();
    if (state.busy === 0 && previous.busy !== 0) queueMicrotask(flushFocusSave);
  });
  for (const event of ["keydown", "pointerdown", "input"])
    document.addEventListener(event, activity, true);
  document.addEventListener("focusin", onFocus);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", flushFocusSave);
  schedule();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    unsubscribe();
    for (const event of ["keydown", "pointerdown", "input"])
      document.removeEventListener(event, activity, true);
    document.removeEventListener("focusin", onFocus);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", flushFocusSave);
    failed.clear();
  };
}

export async function saveBeforeAction() {
  await flushAutoSave(true);
  if (Object.values(useApp.getState().docs).some((d) => d.dirty))
    throw new Error(
      "Resolve unsaved, recovered or conflicting files before this operation. Your buffers are retained.",
    );
}
