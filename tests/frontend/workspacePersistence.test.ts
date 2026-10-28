import { afterEach, expect, it, vi } from "vitest";
import { rpc } from "../../src/shared/ipc/client";
import {
  schedulePersistence,
  flushWorkspacePersistence,
} from "../../src/features/workspace/persistence";
import type { Request, Response } from "../../src/generated/protocol";
vi.mock("../../src/shared/ipc/client", () => ({ rpc: vi.fn() }));
const write = (
  scope: string,
  n: number,
): Extract<Request, { type: "uiWrite" }> => ({
  type: "uiWrite",
  scope,
  tabs: [],
  active: null,
  layout: [n, 100 - n],
  split: null,
});
afterEach(() => {
  vi.mocked(rpc).mockReset();
});
it("flushes the newest debounced snapshot before switching, independently for each project", async () => {
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  schedulePersistence(write("project-a", 20));
  schedulePersistence(write("project-a", 27));
  schedulePersistence(write("project-b", 41));
  await flushWorkspacePersistence("project-a");
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenLastCalledWith(write("project-a", 27));
  await flushWorkspacePersistence("project-b");
  expect(rpc).toHaveBeenLastCalledWith(write("project-b", 41));
});
it("joins a running write then drains newer geometry instead of allowing an older result to win", async () => {
  let complete!: (value: Response) => void;
  vi.mocked(rpc)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    )
    .mockResolvedValue({ type: "ok" });
  schedulePersistence(write("serial", 20));
  const first = flushWorkspacePersistence("serial");
  schedulePersistence(write("serial", 35));
  const second = flushWorkspacePersistence("serial");
  expect(rpc).toHaveBeenCalledTimes(1);
  complete({ type: "ok" });
  await Promise.all([first, second]);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenLastCalledWith(write("serial", 35));
});
it("retains a failed write for an explicit transition retry", async () => {
  vi.mocked(rpc)
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue({ type: "ok" });
  schedulePersistence(write("retry", 29));
  await expect(flushWorkspacePersistence("retry")).rejects.toThrow("disk full");
  await flushWorkspacePersistence("retry");
  expect(rpc).toHaveBeenCalledTimes(2);
});
