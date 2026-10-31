import { afterEach, expect, it, vi } from "vitest";
import { chooseCurrentWindow } from "../../src/features/workspace/projectWindow";
import { call } from "../../src/shared/ipc/client";
import { ask } from "../../src/shared/components/Dialog";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn() }));
vi.mock("../../src/shared/components/Dialog", () => ({ ask: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function available() {
  vi.mocked(call).mockResolvedValue({
    type: "windowOpened",
    window: null,
    existing: false,
  });
}
it("focuses an already open project without switching or asking to close current work", async () => {
  vi.mocked(call).mockResolvedValue({
    type: "windowOpened",
    window: "registered",
    existing: true,
  });
  expect(await chooseCurrentWindow("/project", true)).toBe(false);
  expect(call).toHaveBeenCalledExactlyOnceWith(
    { type: "focusProjectWindow", path: "/project" },
    "windowOpened",
  );
  expect(ask).not.toHaveBeenCalled();
});
it("opens another window before any save/disposal/terminal-close workflow", async () => {
  available();
  vi.mocked(ask).mockResolvedValue("New window");
  expect(await chooseCurrentWindow("/project", true)).toBe(false);
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({ choices: ["New window", "This window"] }),
  );
  expect(vi.mocked(call).mock.calls.map(([request]) => request.type)).toEqual([
    "focusProjectWindow",
    "newWindow",
  ]);
  expect(call).toHaveBeenLastCalledWith(
    { type: "newWindow", path: "/project" },
    "windowOpened",
  );
});
it.each(["This window", null])(
  "only replaces the current window after that explicit choice (%s)",
  async (choice) => {
    available();
    vi.mocked(ask).mockResolvedValue(choice);
    expect(await chooseCurrentWindow("/project", true)).toBe(
      choice === "This window",
    );
    expect(call).toHaveBeenCalledTimes(1);
  },
);
it("uses an empty window without an unnecessary placement question", async () => {
  available();
  expect(await chooseCurrentWindow("/project", false)).toBe(true);
  expect(ask).not.toHaveBeenCalled();
});
it("retains missing-folder relocation and refuses to switch on new-window failure", async () => {
  vi.mocked(call).mockRejectedValueOnce({
    code: "notFound",
    message: "Missing folder",
  });
  expect(await chooseCurrentWindow("/project", true)).toBe(true);
  expect(ask).not.toHaveBeenCalled();
  available();
  vi.mocked(ask).mockResolvedValue("New window");
  vi.mocked(call)
    .mockResolvedValueOnce({
      type: "windowOpened",
      window: null,
      existing: false,
    })
    .mockRejectedValueOnce(new Error("Window unavailable"));
  await expect(chooseCurrentWindow("/other", true)).rejects.toThrow(
    "Window unavailable",
  );
});
