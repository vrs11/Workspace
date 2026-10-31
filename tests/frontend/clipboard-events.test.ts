import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { rpc } from "../../src/shared/ipc/client";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("announces only acknowledged clipboard writes, preserving the prior clipboard state after failure", async () => {
  const changed = vi.fn();
  window.addEventListener("workspace-clipboard-changed", changed);
  try {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ type: "ok" })
      .mockResolvedValueOnce({ type: "ok" })
      .mockRejectedValueOnce(Error("Copy failed"));
    await rpc({ type: "clipboardWrite", text: "plain text" });
    await rpc({ type: "copyFiles", scope: "p", entries: ["file"] });
    await expect(
      rpc({ type: "copyFiles", scope: "p", entries: ["missing"] }),
    ).rejects.toThrow("Copy failed");
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener("workspace-clipboard-changed", changed);
  }
});
it("does not announce availability reads and cause a refresh loop", async () => {
  const changed = vi.fn();
  window.addEventListener("workspace-clipboard-changed", changed);
  try {
    vi.mocked(invoke).mockResolvedValue({
      type: "clipboardFiles",
      available: false,
    });
    await rpc({ type: "clipboardHasFiles" });
    expect(changed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("workspace-clipboard-changed", changed);
  }
});
