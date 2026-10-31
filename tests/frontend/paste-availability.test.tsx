import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFilePasteAvailability } from "../../src/features/explorer/useFilePasteAvailability";
import { call } from "../../src/shared/ipc/client";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(call).mockResolvedValue({
    type: "clipboardFiles",
    available: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("starts disabled, enables only for native files and disables again for text or an empty clipboard", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }) as never,
  );
  const view = renderHook(() => useFilePasteAvailability(true, "project"));
  expect(view.result.current.available).toBe(false);
  await act(async () => finish({ type: "clipboardFiles", available: true }));
  expect(view.result.current.available).toBe(true);
  act(() => {
    window.dispatchEvent(new Event("workspace-clipboard-changed"));
  });
  await waitFor(() => expect(view.result.current.available).toBe(false));
});
it("invalidates immediately on text copy/cut and refreshes after a successful clipboard write", async () => {
  vi.mocked(call).mockResolvedValue({
    type: "clipboardFiles",
    available: true,
  });
  const view = renderHook(() => useFilePasteAvailability(true, "project"));
  await waitFor(() => expect(view.result.current.available).toBe(true));
  act(() => {
    document.dispatchEvent(new Event("copy", { bubbles: true }));
  });
  expect(view.result.current.available).toBe(false);
  expect(call).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event("workspace-clipboard-changed"));
  });
  await waitFor(() => expect(view.result.current.available).toBe(true));
  act(() => {
    document.dispatchEvent(new Event("cut", { bubbles: true }));
  });
  expect(view.result.current.available).toBe(false);
});
it("refreshes after returning from another app and does no periodic polling", async () => {
  vi.mocked(call).mockResolvedValue({
    type: "clipboardFiles",
    available: true,
  });
  const view = renderHook(() => useFilePasteAvailability(true, "project"));
  await waitFor(() => expect(view.result.current.available).toBe(true));
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(view.result.current.available).toBe(false);
  vi.mocked(call).mockResolvedValue({
    type: "clipboardFiles",
    available: false,
  });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(view.result.current.available).toBe(false);
  expect(call).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(call).toHaveBeenCalledTimes(2);
});
it("disables while hidden or restricted and ignores a late response from the prior project", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }) as never,
  );
  const view = renderHook(
    ({ enabled, owner }) => useFilePasteAvailability(enabled, owner),
    { initialProps: { enabled: true, owner: "old" } },
  );
  view.rerender({ enabled: true, owner: "new" });
  await act(async () => finish({ type: "clipboardFiles", available: true }));
  expect(view.result.current.available).toBe(false);
  vi.mocked(call).mockResolvedValue({
    type: "clipboardFiles",
    available: true,
  });
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(view.result.current.available).toBe(true);
  view.rerender({ enabled: false, owner: "new" });
  expect(view.result.current.available).toBe(false);
});
it("stays disabled on native errors and does not update a disposed view", async () => {
  vi.mocked(call).mockRejectedValueOnce(Error("Clipboard unavailable"));
  const view = renderHook(() => useFilePasteAvailability(true, "project"));
  await act(async () => {});
  expect(view.result.current.available).toBe(false);
  let finish!: (value: unknown) => void;
  vi.mocked(call).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }) as never,
  );
  let pending!: Promise<boolean>;
  act(() => {
    pending = view.result.current.refresh();
  });
  view.unmount();
  finish({ type: "clipboardFiles", available: true });
  expect(await pending).toBe(false);
});
