import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deleteEntry } from "../../src/features/explorer/deleteEntry";
import { ask, DialogHost } from "../../src/shared/components/Dialog";
import { call, rpc } from "../../src/shared/ipc/client";
import { useApp } from "../../src/shared/state/store";
import type { Entry, Response } from "../../src/generated/protocol";
vi.mock("../../src/shared/ipc/client", async (original) => ({
  ...(await original<object>()),
  call: vi.fn(),
  rpc: vi.fn(),
}));
const entry: Entry = {
  id: "file",
  path: "folder/file.txt",
  name: "file.txt",
  kind: "file",
};
const failure = {
  code: "unsupported",
  message: "The extended metadata cannot be retained in recovery.",
};
beforeEach(() => {
  vi.resetAllMocks();
  useApp.setState({
    project: { id: "p", name: "project", root: "/fixture", trusted: true },
  });
  vi.mocked(rpc)
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ type: "ok" });
  vi.mocked(call).mockResolvedValue({
    type: "deleteReview",
    entry: entry.id,
    path: entry.path,
    directory: false,
    review: "native-review",
  });
});
afterEach(cleanup);
async function begin() {
  render(<DialogHost />);
  let pending!: ReturnType<typeof deleteEntry>;
  await act(async () => {
    pending = deleteEntry("p", entry);
  });
  await screen.findByRole("dialog");
  return { pending, user: userEvent.setup() };
}
it("deletes normally without requesting a permanent-deletion review", async () => {
  vi.mocked(rpc).mockReset().mockResolvedValue({ type: "ok" });
  expect(await deleteEntry("p", entry)).toBe("recovery");
  expect(call).not.toHaveBeenCalled();
});
it.each(["{Escape}", "{ArrowLeft}{Enter}"])(
  "cancels permanent deletion with %s and retains the item",
  async (keys) => {
    const { pending, user } = await begin();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(failure.message);
    expect(dialog).toHaveTextContent(entry.path);
    expect(dialog).toHaveTextContent("No recovery copy will be made");
    expect(dialog).toHaveTextContent("This cannot be undone");
    await user.keyboard(keys);
    expect(await pending).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  },
);
it("confirms the default action by keyboard with the native entry-scoped review", async () => {
  const { pending, user } = await begin();
  expect(
    screen.getByRole("button", { name: "Delete permanently" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await pending).toBe("permanent");
  expect(rpc).toHaveBeenLastCalledWith({
    type: "deletePermanently",
    scope: "p",
    entry: "file",
    review: "native-review",
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it.each([
  "unknownOutcome",
  "conflict",
  "untrusted",
  "scope",
  "unsafePath",
  "notFound",
])("does not offer to bypass %s", async (code) => {
  const error = { code, message: code };
  vi.mocked(rpc).mockReset().mockRejectedValue(error);
  await expect(deleteEntry("p", entry)).rejects.toEqual(error);
  expect(call).not.toHaveBeenCalled();
});
it("keeps an OS permission failure visible without claiming success and allows cancellation", async () => {
  const { pending, user } = await begin();
  vi.mocked(rpc).mockRejectedValueOnce({
    code: "permissionDenied",
    message: "The system denied deleting this file.",
  });
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The system denied deleting this file",
  );
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(await pending).toBeNull();
});
it("does not submit a review after switching projects", async () => {
  const { pending, user } = await begin();
  useApp.setState({ project: { ...useApp.getState().project!, id: "other" } });
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent("project changed");
  expect(rpc).toHaveBeenCalledTimes(1);
  await user.keyboard("{Escape}");
  expect(await pending).toBeNull();
});
it("discards a late review response from the previous project", async () => {
  let finish!: (result: Response) => void;
  vi.mocked(call).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve as typeof finish;
    }),
  );
  const pending = deleteEntry("p", entry);
  await waitFor(() => expect(call).toHaveBeenCalled());
  useApp.setState({ project: { ...useApp.getState().project!, id: "other" } });
  finish({
    type: "deleteReview",
    entry: "file",
    path: "file",
    directory: false,
    review: "old",
  });
  expect(await pending).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);
});
it("waits for a confirmed mutation if another question replaces its modal", async () => {
  const { pending, user } = await begin();
  let finish!: (result: Response) => void;
  vi.mocked(rpc).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await user.keyboard("{Enter}");
  let next!: Promise<string | null>;
  act(() => {
    next = ask({
      title: "New question",
      description: "Next action",
      choices: ["OK"],
    });
  });
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  await act(async () => {
    finish({ type: "ok" });
  });
  expect(await pending).toBe("permanent");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("New question");
  await user.keyboard("{Escape}");
  expect(await next).toBeNull();
});
