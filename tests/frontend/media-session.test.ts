import { afterEach, expect, it, vi } from "vitest";
import { useApp, type Tab } from "../../src/shared/state/store";
import { call, rpc } from "../../src/shared/ipc/client";
import { reloadMedia, closeMediaTab } from "../../src/features/media/session";
import type { Media, Response } from "../../src/generated/protocol";
vi.mock("../../src/shared/ipc/client", () => ({ call: vi.fn(), rpc: vi.fn() }));
const media: Media = {
  entry: "a",
  token: "old",
  name: "a.png",
  path: "a.png",
  mime: "image/png",
  kind: "image",
  size: 32,
};
function tab(instance = "one"): Tab {
  return {
    id: "a",
    kind: "media",
    instance,
    entry: "a",
    title: "a.png",
    media,
  };
}
function setup() {
  useApp.setState({
    project: { id: "p", root: "/fixture", name: "fixture", trusted: true },
    tabs: [tab()],
    active: "a",
  });
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
}
afterEach(() => {
  vi.mocked(call).mockReset();
  vi.mocked(rpc).mockReset();
  useApp.setState({ tabs: [], active: null });
});
it("waits for an in-flight reload and closes the replacement token instead of orphaning it", async () => {
  setup();
  let resolve!: (response: Extract<Response, { type: "media" }>) => void;
  vi.mocked(call).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const reload = reloadMedia("a"),
    close = closeMediaTab("a");
  await Promise.resolve();
  await Promise.resolve();
  expect(rpc).not.toHaveBeenCalled();
  resolve({ type: "media", media: { ...media, token: "new" } });
  await Promise.all([reload, close]);
  expect(rpc).toHaveBeenCalledWith({
    type: "closeMedia",
    scope: "p",
    token: "new",
  });
  expect(useApp.getState().tabs).toEqual([]);
});
it("does not reopen a preview when reload was queued after closing it", async () => {
  setup();
  await Promise.all([closeMediaTab("a"), reloadMedia("a")]);
  expect(call).not.toHaveBeenCalled();
  expect(useApp.getState().tabs).toEqual([]);
});
it("releases a late result without replacing a newly opened instance of the same file", async () => {
  setup();
  let resolve!: (response: Extract<Response, { type: "media" }>) => void;
  vi.mocked(call).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const reload = reloadMedia("a");
  await Promise.resolve();
  await Promise.resolve();
  useApp.getState().set({ tabs: [tab("replacement")] });
  resolve({ type: "media", media: { ...media, token: "late" } });
  await reload;
  expect(rpc).toHaveBeenCalledWith({
    type: "closeMedia",
    scope: "p",
    token: "late",
  });
  expect(useApp.getState().tabs[0]).toEqual(tab("replacement"));
});
