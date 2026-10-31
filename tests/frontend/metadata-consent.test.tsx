import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import type { Request, Response } from "../../src/generated/protocol";
import { MetadataWarning } from "../../src/features/editor/MetadataWarning";
import {
  disposeModel,
  models,
  reviewDocumentMetadata,
  saveDocument,
} from "../../src/features/editor/models";
import { DialogHost } from "../../src/shared/components/Dialog";
import { call } from "../../src/shared/ipc/client";
import { useApp, type DocMeta } from "../../src/shared/state/store";
vi.mock("../../src/shared/ipc/client", async () => ({
  ...(await import("../../src/shared/errors")),
  call: vi.fn(),
  rpc: vi.fn(),
}));
const warning = {
  review: "native-review",
  items: ["com.apple.metadata:_kMDItemUserTags", "Custom access rules (ACL)"],
  accepted: false,
};
const setValue = vi.fn();
let requests: Request[];
beforeEach(() => {
  requests = [];
  setValue.mockReset();
  const meta: DocMeta = {
    id: "a",
    entry: "a",
    path: "a.txt",
    name: "a.txt",
    baseline: "baseline",
    encoding: "utf8",
    eol: "LF",
    readonly: "Metadata cannot be preserved",
    metadata: warning,
    size: 4,
    revision: 1,
    acknowledged: 0,
    dirty: false,
    recovering: false,
    conflict: false,
    recoveryError: null,
    saveError: null,
  };
  useApp.setState({
    project: { id: "p", name: "fixture", root: "/fixture", trusted: true },
    docs: { a: meta },
    notice: "",
    busy: 0,
  });
  models.set("a", {
    model: {
      getValue: () => "buffer",
      getAlternativeVersionId: () => 7,
      setValue,
      dispose() {},
    } as unknown as Monaco.editor.ITextModel,
    listener: { dispose() {} },
    timer: null,
    queue: Promise.resolve(),
    revision: 1,
    savedVersion: 7,
    updating: false,
  });
  vi.mocked(call).mockImplementation(
    async <T extends Response["type"]>(
      request: Request,
      kind: T,
    ): Promise<Extract<Response, { type: T }>> => {
      requests.push(request);
      const result: Response =
        request.type === "reviewMetadata" ||
        request.type === "allowMetadataLoss"
          ? {
              type: "documentMetadata",
              document: "a",
              readonly:
                request.type === "allowMetadataLoss"
                  ? null
                  : "Metadata cannot be preserved",
              metadata: {
                ...warning,
                accepted: request.type === "allowMetadataLoss",
              },
            }
          : { type: "saved", revision: 1, baseline: "saved" };
      expect(result.type).toBe(kind);
      return result as Extract<Response, { type: T }>;
    },
  );
});
afterEach(async () => {
  if (screen.queryByRole("dialog"))
    await userEvent.setup().keyboard("{Escape}");
  cleanup();
  disposeModel("a");
  vi.mocked(call).mockReset();
});
function View() {
  const document = useApp((s) => s.docs.a);
  return (
    <>
      <MetadataWarning document={document} />
      <DialogHost />
    </>
  );
}
it("reviews the actual metadata and Escape cancels without enabling editing or saving", async () => {
  render(<View />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit anyway…" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(warning.items[0]);
  expect(dialog).toHaveTextContent(warning.items[1]);
  expect(dialog).toHaveTextContent("Autosave, if enabled, also applies");
  expect(dialog).toHaveTextContent(
    "Nothing is removed until the file is saved",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit anyway…" })).toBeEnabled(),
  );
  expect(requests.map((r) => r.type)).toEqual(["reviewMetadata"]);
  expect(useApp.getState().docs.a.readonly).not.toBeNull();
  expect(setValue).not.toHaveBeenCalled();
});
it("keyboard confirmation enables editing for just this file without resetting text, versions or undo", async () => {
  render(<View />);
  const handle = models.get("a")!;
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit anyway…" }));
  const accept = await screen.findByRole("button", {
    name: "Accept loss and edit",
  });
  expect(accept).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(requests).toEqual([
    { type: "reviewMetadata", scope: "p", document: "a" },
    {
      type: "allowMetadataLoss",
      scope: "p",
      document: "a",
      review: "native-review",
    },
  ]);
  expect(useApp.getState().docs.a).toMatchObject({
    readonly: null,
    metadata: { accepted: true },
    baseline: "baseline",
    dirty: false,
  });
  expect(models.get("a")).toBe(handle);
  expect(handle.savedVersion).toBe(7);
  expect(setValue).not.toHaveBeenCalled();
  expect(screen.queryByText(/Metadata loss accepted/)).toBeNull();
  expect(screen.queryByText(/metadata that cannot be preserved/)).toBeNull();
  // Hide the notice, not the native consent. A new review must still be visible.
  act(() =>
    useApp
      .getState()
      .doc("a", {
        metadata: { ...warning, review: "new-review" },
        readonly: "Metadata cannot be preserved",
      }),
  );
  expect(screen.getByRole("button", { name: "Edit anyway…" })).toBeVisible();
});
it("keeps a failed approval in the modal and prevents submission to a replaced editor instance", async () => {
  render(<View />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit anyway…" }));
  await screen.findByRole("dialog");
  const old = models.get("a")!;
  models.set("a", { ...old });
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The file is no longer open",
  );
  expect(requests.map((r) => r.type)).toEqual(["reviewMetadata"]);
  expect(useApp.getState().docs.a.metadata?.accepted).toBe(false);
});
it("disables approval in restricted mode", () => {
  useApp.setState({
    project: { ...useApp.getState().project!, trusted: false },
  });
  render(<View />);
  expect(screen.getByRole("button", { name: "Edit anyway…" })).toBeDisabled();
  expect(requests).toEqual([]);
});
it("fences late metadata responses after a project switch", async () => {
  let finish!: (value: Extract<Response, { type: "documentMetadata" }>) => void;
  vi.mocked(call).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = reviewDocumentMetadata("a");
  const rejected = expect(pending).rejects.toThrow("no longer open");
  await waitFor(() => expect(call).toHaveBeenCalled());
  useApp.setState({
    project: { ...useApp.getState().project!, id: "different" },
  });
  finish({
    type: "documentMetadata",
    document: "a",
    readonly: null,
    metadata: { ...warning, accepted: true },
  });
  await rejected;
  expect(useApp.getState().docs.a.metadata?.accepted).toBe(false);
});
it("reopens metadata review after a stale-consent save failure and preserves the edited model", async () => {
  useApp.getState().doc("a", {
    readonly: null,
    metadata: { ...warning, accepted: true },
    dirty: true,
  });
  const impl = vi.mocked(call).getMockImplementation()!;
  vi.mocked(call).mockImplementation(async (request, kind) => {
    if (request.type === "save")
      throw { code: "metadataChanged", message: "Review metadata again" };
    return impl(request, kind);
  });
  await expect(saveDocument("a")).rejects.toMatchObject({
    code: "metadataChanged",
  });
  expect(useApp.getState().docs.a).toMatchObject({
    dirty: true,
    metadata: { accepted: false },
    readonly: "Metadata cannot be preserved",
  });
  expect(setValue).not.toHaveBeenCalled();
  expect(models.get("a")!.model.getValue()).toBe("buffer");
});
it("successful saving clears the one-time metadata warning", async () => {
  act(() =>
    useApp.getState().doc("a", {
      readonly: null,
      metadata: { ...warning, accepted: true },
      dirty: true,
    }),
  );
  await saveDocument("a");
  expect(useApp.getState().docs.a.metadata).toBeNull();
  expect(useApp.getState().docs.a.dirty).toBe(false);
});
