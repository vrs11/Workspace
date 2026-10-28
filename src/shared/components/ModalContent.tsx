import * as Dialog from "@radix-ui/react-dialog";
import {
  forwardRef,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
} from "react";

function buttonsIn(dialog: HTMLElement) {
  return [
    ...dialog.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled):not([aria-disabled=true])",
    ),
  ].filter((button) => {
    if (button.closest('[role="dialog"]') !== dialog) return false;
    for (
      let element: HTMLElement | null = button;
      element && element !== dialog;
      element = element.parentElement
    ) {
      const style = getComputedStyle(element);
      if (
        element.hidden ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return false;
    }
    return true;
  });
}
function navigateButtons(event: KeyboardEvent<HTMLDivElement>) {
  if (
    !["Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
      event.key,
    ) ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229 ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  const target = event.target as HTMLElement;
  const dialog = event.currentTarget;
  if (
    target.closest('[role="dialog"]') !== dialog ||
    target.closest(
      "input, textarea, select, [contenteditable=true], [role=tablist], [role=listbox], [role=tree], [role=menu], [role=slider], [role=radiogroup]",
    )
  )
    return;
  const buttons = buttonsIn(dialog);
  const button = target.closest<HTMLButtonElement>("button");
  const index = button ? buttons.indexOf(button) : -1;
  if (event.key === "Enter" && index !== -1) {
    event.preventDefault();
    if (!event.repeat) button!.click();
  } else if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
    buttons.length
  ) {
    event.preventDefault();
    const direction =
      event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    buttons[(index + direction + buttons.length) % buttons.length].focus();
  }
}

export const ModalContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof Dialog.Content>
>(function ModalContent(
  { onKeyDown, onOpenAutoFocus, ...props },
  forwardedRef,
) {
  const content = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog.Content
      {...props}
      ref={(element) => {
        content.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      }}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (event.defaultPrevented) return;
        const initial =
          content.current?.querySelector<HTMLElement>("[data-dialog-input]") ??
          content.current?.querySelector<HTMLButtonElement>(
            "[data-dialog-default]:not(:disabled)",
          );
        if (initial) {
          event.preventDefault();
          initial.focus();
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        navigateButtons(event);
      }}
    />
  );
});
