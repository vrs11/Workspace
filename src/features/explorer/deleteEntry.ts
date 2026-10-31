import type { Entry } from "../../generated/protocol";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";
import { useApp } from "../../shared/state/store";

const reviewable = new Set([
  "unsupported",
  "crossDevice",
  "resourceLimit",
  "diskFull",
  "permissionDenied",
  "readOnly",
  "io",
]);

/** All Explorer delete controls share this reviewed, scoped fallback. */
export async function deleteEntry(scope: string, entry: Entry) {
  try {
    await rpc({ type: "delete", scope, entry: entry.id });
    return "recovery" as const;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "unknownOutcome"
    )
      window.dispatchEvent(new Event("workspace-refresh"));
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      !reviewable.has(String(error.code))
    )
      throw error;
    if (useApp.getState().project?.id !== scope) return null;
    const review = await call(
      { type: "reviewDelete", scope, entry: entry.id },
      "deleteReview",
    );
    if (useApp.getState().project?.id !== scope) return null;
    const state = {
      deleted: false,
      pending: undefined as Promise<void> | undefined,
    };
    await ask({
      title: review.directory
        ? "Permanently delete this folder?"
        : "Permanently delete this file?",
      description: `A recoverable delete could not be completed:\n${errorText(error)}\n\n“${review.path}”${review.directory ? " and everything inside it" : ""} will be permanently deleted, including its metadata. No recovery copy will be made. This cannot be undone.`,
      choices: ["Delete permanently"],
      returnFocus: document.querySelector<HTMLElement>(
        '.explorer [aria-label="Project tree"]',
      ),
      submit: async () => {
        if (useApp.getState().project?.id !== scope)
          throw new Error("The project changed. Cancel this deletion review.");
        const mutation = async () => {
          try {
            await rpc({
              type: "deletePermanently",
              scope,
              entry: entry.id,
              review: review.review,
            });
            state.deleted = true;
          } catch (failure) {
            window.dispatchEvent(new Event("workspace-refresh"));
            throw failure;
          }
        };
        state.pending = mutation();
        try {
          await state.pending;
        } finally {
          state.pending = undefined;
        }
      },
    });
    // A newer question can replace this modal while IPC is in flight. Account
    // for the acknowledged mutation before the caller updates its selection.
    await state.pending;
    return state.deleted ? ("permanent" as const) : null;
  }
}
