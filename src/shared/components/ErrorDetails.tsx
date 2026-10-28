import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { X, Copy } from "lucide-react";
import type { ErrorDetails as Details } from "../errors";
import { errorText } from "../errors";
import { rpc } from "../ipc/client";
import { ModalContent } from "./ModalContent";
export function ErrorDetails({ details }: { details: Details | null }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Details | null>(null);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState("");
  if (!details && !open) return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="error-details-trigger"
          disabled={!details}
          onClick={() => {
            setSnapshot(details);
            setCopied(false);
            setFailure("");
          }}
        >
          Details
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <ModalContent className="dialog-content error-details">
          <Dialog.Title>Error details</Dialog.Title>
          <Dialog.Description>
            Reference information for troubleshooting.
          </Dialog.Description>
          <dl>
            {snapshot?.code && (
              <>
                <dt>Code</dt>
                <dd>{snapshot.code}</dd>
              </>
            )}
            {snapshot?.operationId && (
              <>
                <dt>Operation ID</dt>
                <dd>{snapshot.operationId}</dd>
              </>
            )}
          </dl>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                try {
                  const text = [
                    snapshot?.code && `Code: ${snapshot.code}`,
                    snapshot?.operationId &&
                      `Operation ID: ${snapshot.operationId}`,
                  ]
                    .filter(Boolean)
                    .join("\n");
                  await rpc({ type: "clipboardWrite", text });
                  setCopied(true);
                } catch (error) {
                  setFailure(errorText(error));
                }
              })()
            }
          >
            <Copy size={14} />
            {copied ? "Copied" : "Copy reference"}
          </button>
          {failure && <p role="alert">{failure}</p>}
          <Dialog.Close asChild>
            <button
              type="button"
              className="dialog-close"
              aria-label="Close error details"
              data-dialog-default
            >
              <X size={16} />
            </button>
          </Dialog.Close>
        </ModalContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
