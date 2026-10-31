import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { NotificationToast } from "../../src/shared/components/NotificationToast";
import { notice, useApp } from "../../src/shared/state/store";
afterEach(() => {
  cleanup();
  useApp.getState().set({ notice: "" });
});
it("shows and dismisses notices in a portal without moving focus out of the editor", async () => {
  useApp.getState().set({ notice: "" });
  const view = render(
    <>
      <input aria-label="Editor" />
      <NotificationToast />
    </>,
  );
  const editor = screen.getByRole("textbox");
  editor.focus();
  act(() => notice("Files moved"));
  expect(screen.getByRole("alert")).toHaveTextContent("Files moved");
  expect(
    view.container.contains(
      screen.getByRole("region", { name: "Notifications" }),
    ),
  ).toBe(false);
  expect(editor).toHaveFocus();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(useApp.getState().notice).toBe("");
});
it("retains an opened error reference when a background notice changes or clears", async () => {
  const details = {
    code: "permissionDenied",
    operationId: "10000000-0000-4000-8000-000000000001",
  };
  useApp
    .getState()
    .set({ notice: "Could not save file", noticeDetails: details });
  render(<NotificationToast />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Details" }));
  act(() => notice("Refreshed"));
  expect(
    screen.getByRole("dialog", { name: "Error details" }),
  ).toHaveTextContent(details.operationId);
  act(() => notice(""));
  expect(
    screen.getByRole("dialog", { name: "Error details" }),
  ).toHaveTextContent(details.operationId);
  await user.click(screen.getByRole("button", { name: "Close error details" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
