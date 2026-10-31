import { act, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useShallow } from "zustand/react/shallow";
import { useApp, type DocMeta } from "../../src/shared/state/store";
import {
  workspaceSnapshot,
  activeDocumentUi,
} from "../../src/shared/state/workspaceSelectors";
const doc = (): DocMeta => ({
  id: "a",
  entry: "a",
  name: "a",
  path: "a",
  encoding: "utf8",
  eol: "LF",
  baseline: "one",
  revision: 0,
  readonly: null,
  metadata: null,
  size: 0,
  dirty: false,
  recovering: false,
  acknowledged: 0,
  conflict: false,
  recoveryError: null,
  saveError: null,
});
afterEach(() => {
  cleanup();
  useApp.setState({
    project: null,
    docs: {},
    active: null,
    cursor: "",
    tabs: [],
    busy: 0,
    notice: "",
    noticeDetails: null,
  });
});
it("updates visible cursor/recovery counters without rendering the workspace on each editor event", () => {
  let renders = 0;
  function Workspace() {
    useApp(useShallow(workspaceSnapshot));
    renders++;
    return <span>Workspace</span>;
  }
  function Status() {
    const cursor = useApp((s) => s.cursor),
      revision = useApp((s) => s.docs.a?.revision ?? 0);
    return (
      <output>
        {cursor}:{revision}
      </output>
    );
  }
  render(
    <>
      <Workspace />
      <Status />
    </>,
  );
  const before = renders;
  for (let i = 1; i <= 100; i++)
    act(() =>
      useApp.setState((s) => ({
        cursor: `Ln ${i}`,
        docs: { ...s.docs, a: { ...doc(), ...s.docs.a, revision: i } },
      })),
    );
  expect(renders).toBe(before);
  expect(screen.getByRole("status").textContent).toBe("Ln 100:100");
});
it("keeps real dirty/errors/warnings responsive while excluding checkpoint counters", () => {
  useApp.setState({
    active: "a",
    docs: {
      a: doc(),
    },
  });
  let renders = 0;
  function Warnings() {
    const doc = useApp(useShallow(activeDocumentUi));
    renders++;
    return (
      <p>
        {doc?.dirty ? "Unsaved" : "Saved"} {doc?.saveError}
      </p>
    );
  }
  render(<Warnings />);
  const before = renders;
  act(() =>
    useApp
      .getState()
      .doc("a", { revision: 1, acknowledged: 1, baseline: "two" }),
  );
  expect(renders).toBe(before);
  act(() =>
    useApp.getState().doc("a", { dirty: true, saveError: "Disk full" }),
  );
  expect(screen.getByText("Unsaved Disk full")).toBeTruthy();
  expect(renders).toBe(before + 1);
});
it("keeps operation progress local while preserving busy-control updates", () => {
  let renders = 0;
  function Workspace() {
    useApp(useShallow(workspaceSnapshot));
    renders++;
    return null;
  }
  function RepairControl() {
    const busy = useApp((s) => s.busy > 0);
    return <button disabled={busy}>Repair</button>;
  }
  render(
    <>
      <Workspace />
      <RepairControl />
    </>,
  );
  const before = renders;
  for (const busy of [1, 2, 1, 0]) {
    act(() => useApp.setState({ busy }));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
      busy > 0,
    );
  }
  expect(renders).toBe(before);
});

it("updates notification subscribers without rendering or persisting the workspace", () => {
  let renders = 0;
  function Workspace() {
    useApp(useShallow(workspaceSnapshot));
    renders++;
    return <div>Workspace</div>;
  }
  function Notification() {
    return <output>{useApp((state) => state.notice)}</output>;
  }
  render(
    <>
      <Workspace />
      <Notification />
    </>,
  );
  const before = renders;
  act(() => useApp.getState().set({ notice: "Files moved" }));
  expect(screen.getByRole("status")).toHaveTextContent("Files moved");
  act(() =>
    useApp.getState().set({
      notice: "Couldn't move file",
      noticeDetails: { code: "permissionDenied" },
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Couldn't move file");
  expect(renders).toBe(before);
});
