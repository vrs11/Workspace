import * as Dialog from "@radix-ui/react-dialog";
import { useState, useRef, useLayoutEffect } from "react";
import { create } from "zustand";
import { errorText, errorDetails } from "../errors";
import { ErrorDetails } from "./ErrorDetails";
import { ModalContent } from "./ModalContent";
type Question = {
  title: string;
  description: string;
  input?: string;
  secret?: boolean;
  browseFolder?: boolean;
  choices?: string[];
  inputLabel?: string;
  returnFocus?: HTMLElement | null;
  submit?: (value: string) => Promise<void>;
};
type Pending = Question & {
  id: string;
  resolve: (value: string | null) => void;
  returnFocus: HTMLElement | null;
};
const useQuestion = create<{ pending: Pending | null }>(() => ({
  pending: null,
}));
export function ask(question: Question): Promise<string | null> {
  return new Promise((resolve) => {
    const old = useQuestion.getState().pending;
    old?.resolve(null);
    useQuestion.setState({
      pending: {
        ...question,
        id: crypto.randomUUID(),
        resolve,
        returnFocus:
          question.returnFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null),
      },
    });
  });
}
// External folder offers wait behind an existing save/credential/trust decision.
export async function waitForDialogIdle(): Promise<void> {
  while (useQuestion.getState().pending) {
    await new Promise<void>((resolve) => {
      const stop = useQuestion.subscribe((state) => {
        if (!state.pending) {
          stop();
          resolve();
        }
      });
    });
  }
}
export async function askWhenIdle(question: Question): Promise<string | null> {
  // Claim an idle slot synchronously. Always awaiting an already-idle promise
  // lets two callers both pass the check and replace one another's question.
  while (useQuestion.getState().pending) await waitForDialogIdle();
  return ask(question);
}
export function DialogHost() {
  const pending = useQuestion((s) => s.pending);
  if (!pending) return null;
  return <QuestionDialog key={pending.id} pending={pending} />;
}
function QuestionDialog({ pending }: { pending: Pending }) {
  const [text, setText] = useState(pending.input ?? "");
  const [browseError, setBrowseError] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (failure) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [failure]);
  const close = (value: string | null) => {
    if (useQuestion.getState().pending !== pending) return;
    pending.resolve(value);
    useQuestion.setState({ pending: null });
  };
  const finish = async (value: string) => {
    if (submittingRef.current) return;
    if (!pending.submit) {
      close(value);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      await pending.submit(value);
      close(value);
    } catch (error) {
      setFailure(
        error ?? new Error("The operation could not be completed. Try again."),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !submittingRef.current) close(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <ModalContent
          className="dialog-content"
          onEscapeKeyDown={(event) => {
            if (submittingRef.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (submittingRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            // A later menu/dialog owns focus. An old scope's delayed cleanup
            // must not pull focus back into the editor or terminal behind it.
            if (
              !document.querySelector(
                '.dialog-content[role="dialog"], [role="menu"]',
              ) &&
              pending.returnFocus?.isConnected
            )
              pending.returnFocus.focus();
          }}
        >
          <Dialog.Title>{pending.title}</Dialog.Title>
          <Dialog.Description>{pending.description}</Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void finish(
                pending.input !== undefined
                  ? text
                  : (pending.choices?.[0] ?? "Continue"),
              );
            }}
          >
            {pending.input !== undefined && (
              <label>
                {pending.inputLabel ?? "Value"}
                <input
                  ref={inputRef}
                  data-dialog-input
                  disabled={submitting}
                  aria-invalid={failure ? true : undefined}
                  aria-describedby={failure ? "question-error" : undefined}
                  type={pending.secret ? "password" : "text"}
                  autoFocus
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setFailure(null);
                  }}
                />
                {pending.browseFolder && (
                  <button
                    type="button"
                    onClick={() => {
                      void import("../ipc/client").then(
                        async ({ call, errorText }) => {
                          try {
                            setText(
                              (await call({ type: "pickFolder" }, "text")).text,
                            );
                            setBrowseError("");
                          } catch (error) {
                            if (!(
                              typeof error === "object" &&
                              error !== null &&
                              "code" in error &&
                              error.code === "cancelled"
                            ))
                              setBrowseError(errorText(error));
                          }
                        },
                      );
                    }}
                  >
                    Browse…
                  </button>
                )}
              </label>
            )}
            {browseError && <p role="alert">{browseError}</p>}
            {failure !== null && (
              <div className="question-error" id="question-error" role="alert">
                <span>{errorText(failure)}</span>
                <ErrorDetails details={errorDetails(failure)} />
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={submitting}
                onClick={() => close(null)}
              >
                Cancel
              </button>
              {(pending.choices ?? ["Continue"]).map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  className="primary"
                  data-dialog-default={index === 0 ? "" : undefined}
                  disabled={submitting}
                  onClick={() =>
                    void finish(pending.input !== undefined ? text : choice)
                  }
                >
                  {choice}
                </button>
              ))}
            </div>
          </form>
        </ModalContent>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
