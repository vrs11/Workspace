import { afterEach, expect, it, vi } from "vitest";
import { rpc } from "../../src/shared/ipc/client";
import { useApp, type Tab } from "../../src/shared/state/store";
import {
  installViewResources,
  viewOperation,
  releasePreview,
} from "../../src/features/workspace/viewResources";
vi.mock("../../src/shared/ipc/client", () => ({ rpc: vi.fn() }));
const scope = { id: "p", root: "/fixture", name: "fixture", trusted: true };
function diff(id: string): Tab {
  return {
    id: `tab-${id}`,
    kind: "diff",
    title: id,
    staged: false,
    diff: {
      id,
      entry: "a",
      path: "a",
      base: "old",
      next: "new",
      hunks: [],
      hunkUnavailable: null,
      baseLabel: "Index",
      nextLabel: "Working",
    },
  };
}
const tick = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};
afterEach(() => {
  vi.mocked(rpc).mockReset();
  useApp.setState({ project: null, tabs: [] });
});
it("releases replaced/closed comparisons, keeping snapshots referenced by another tab", async () => {
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  useApp.setState({
    project: scope,
    tabs: [diff("one"), { ...diff("one"), id: "another" }],
  });
  const dispose = installViewResources();
  useApp.setState({ tabs: [diff("one")] });
  await tick();
  expect(rpc).not.toHaveBeenCalled();
  useApp.setState({ tabs: [diff("two")] });
  await tick();
  expect(rpc).toHaveBeenCalledWith({
    type: "releaseViews",
    scope: "p",
    diffs: ["one"],
    previews: [],
  });
  dispose();
});
it("joins a started hunk/replacement operation before releasing its snapshot", async () => {
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  useApp.setState({ project: scope, tabs: [diff("one")] });
  const dispose = installViewResources();
  let done!: () => void;
  const pending = viewOperation(
    "p",
    "one",
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await tick();
  useApp.setState({ tabs: [] });
  await tick();
  expect(rpc).not.toHaveBeenCalled();
  done();
  await pending;
  await tick();
  expect(rpc).toHaveBeenCalledOnce();
  dispose();
});
it("does not send a stale cleanup into a different workspace", async () => {
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  useApp.setState({ project: scope, tabs: [diff("one")] });
  const dispose = installViewResources();
  useApp.setState({ project: { ...scope, id: "other" }, tabs: [] });
  await tick();
  expect(rpc).not.toHaveBeenCalled();
  dispose();
});
it("releases only the explicitly abandoned replacement preview", async () => {
  vi.mocked(rpc).mockResolvedValue({ type: "ok" });
  useApp.setState({ project: scope });
  releasePreview("p", "preview");
  await tick();
  expect(rpc).toHaveBeenCalledWith({
    type: "releaseViews",
    scope: "p",
    diffs: [],
    previews: ["preview"],
  });
});
