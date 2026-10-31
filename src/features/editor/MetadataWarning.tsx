import { useState } from "react";
import { ask } from "../../shared/components/Dialog";
import { perform, useApp, type DocMeta } from "../../shared/state/store";
import { models, reviewDocumentMetadata } from "./models";

export function MetadataWarning({
  document,
}: {
  document: Pick<DocMeta, "id" | "name" | "metadata">;
}) {
  const trusted = useApp((state) => !!state.project?.trusted);
  const [pending, setPending] = useState(false);
  const warning = document.metadata;
  if (!warning || warning.accepted) return null;
  return (
    <div className="editor-warning">
      <span>This file has metadata that cannot be preserved on save.</span>
      <button
        type="button"
        disabled={!trusted || pending}
        title={!trusted ? "Trust this project to enable editing" : undefined}
        onClick={() => {
          setPending(true);
          void perform(async () => {
            const scope = useApp.getState().project?.id;
            const handle = models.get(document.id);
            const current = await reviewDocumentMetadata(document.id);
            if (!current.metadata) return;
            await ask({
              title: "Edit without preserving metadata?",
              description: `Saving “${document.name}” will permanently remove:\n\n${current.metadata.items.map((item) => `• ${item}`).join("\n")}\n\nResource forks may contain additional file data. Your edited text and standard file permissions will be preserved. Autosave, if enabled, also applies. Nothing is removed until the file is saved. This approval applies only to this open file.`,
              choices: ["Accept loss and edit"],
              submit: async () => {
                if (
                  useApp.getState().project?.id !== scope ||
                  models.get(document.id) !== handle
                )
                  throw new Error(
                    "The file is no longer open. Cancel this review.",
                  );
                await reviewDocumentMetadata(
                  document.id,
                  current.metadata!.review,
                );
              },
            });
          }).finally(() => setPending(false));
        }}
      >
        Edit anyway…
      </button>
    </div>
  );
}
