import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentPreview from "../../src/features/editor/DocumentPreview";
import { useApp } from "../../src/shared/state/store";
const fake = vi.hoisted(() => ({
  workers: [] as {
    onmessage: ((event: { data: object }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }[],
  model: {
    getValueLength: vi.fn(),
    getValue: vi.fn(),
    getVersionId: vi.fn(),
    onDidChangeContent: vi.fn(),
  },
  models: new Map(),
  call: vi.fn(),
  rpc: vi.fn(),
  change: () => {},
  dispose: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../src/features/editor/preview.worker?worker", () => ({
  default: class {
    onmessage = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      fake.workers.push(this);
    }
  },
}));
vi.mock("../../src/features/editor/models", () => ({
  models: fake.models,
  loadDocument: fake.load,
}));
vi.mock("../../src/shared/ipc/client", () => ({
  call: fake.call,
  rpc: fake.rpc,
  errorText: (error: Error) => error.message,
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: () => "workspace-media://localhost/",
}));
beforeEach(() => {
  vi.clearAllMocks();
  fake.workers.length = 0;
  fake.models.set("e", { model: fake.model });
  fake.model.getValueLength.mockReturnValue(10);
  fake.model.getValue.mockReturnValue("# unsaved");
  fake.model.getVersionId.mockReturnValue(1);
  fake.model.onDidChangeContent.mockImplementation((fn: () => void) => {
    fake.change = fn;
    return { dispose: fake.dispose };
  });
  fake.rpc.mockResolvedValue({ type: "ok" });
  useApp.setState({
    project: { id: "p", name: "fixture", root: "/fixture", trusted: false },
  });
});
afterEach(() => {
  cleanup();
  fake.models.clear();
  useApp.setState({ project: null });
});
function respond(version: number, html: string) {
  act(() => fake.workers.at(-1)!.onmessage?.({ data: { version, html } }));
}
it("renders current unsaved text through a lazy worker and rejects obsolete versions", async () => {
  const view = render(<DocumentPreview entry="e" format="markdown" />);
  expect(fake.workers[0].postMessage).toHaveBeenCalledWith({
    version: 1,
    text: "# unsaved",
    format: "markdown",
  });
  const host = view.container.querySelector(".document-preview-content")!;
  respond(1, "<h1>Unsaved</h1>");
  expect(host.shadowRoot?.textContent).toContain("Unsaved");
  act(() => {
    fake.model.getVersionId.mockReturnValue(2);
    fake.change();
  });
  respond(1, "<h1>STALE</h1>");
  expect(host.shadowRoot?.textContent).not.toContain("STALE");
  await waitFor(() =>
    expect(fake.workers[0].postMessage).toHaveBeenCalledTimes(2),
  );
  respond(2, "<h1>Current</h1>");
  expect(host.shadowRoot?.textContent).toContain("Current");
  expect(fake.rpc).not.toHaveBeenCalled();
  view.unmount();
  expect(fake.workers[0].terminate).toHaveBeenCalledOnce();
  expect(fake.dispose).toHaveBeenCalledOnce();
});
it("resolves local images with native leases, never loads remote resources and releases late replies", async () => {
  let resolve: (value: object) => void = () => {};
  fake.call.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<DocumentPreview entry="e" format="markdown" />);
  respond(
    1,
    '<img src="https://example.invalid/private"><img src="images/local.png">',
  );
  expect(fake.call).toHaveBeenCalledWith(
    {
      type: "previewImage",
      scope: "p",
      document: "e",
      href: "images/local.png",
    },
    "media",
  );
  const host = view.container.querySelector(".document-preview-content")!;
  expect(host.shadowRoot?.querySelector("[src]")).toBeNull();
  expect(host.shadowRoot?.textContent).toContain(
    "Remote images are not loaded",
  );
  view.unmount();
  await act(async () => resolve({ media: { token: "late-image" } }));
  expect(fake.rpc).toHaveBeenCalledWith({
    type: "closeMedia",
    scope: "p",
    token: "late-image",
  });
});
it("routes explicit links through scoped native resolution and retains parse errors without saving", async () => {
  fake.call.mockResolvedValue({ entries: [{ id: "linked" }] });
  const view = render(<DocumentPreview entry="e" format="html" />);
  respond(1, '<a href="sibling.md">Open sibling</a>');
  await act(async () =>
    view.container
      .querySelector(".document-preview-content")!
      .shadowRoot!.querySelector("a")!
      .click(),
  );
  expect(fake.call).toHaveBeenCalledWith(
    { type: "previewLink", scope: "p", document: "e", href: "sibling.md" },
    "entries",
  );
  expect(fake.load).toHaveBeenCalledWith("linked");
  act(() =>
    fake.workers[0].onmessage?.({
      data: { version: 1, error: "Unclosed quoted field" },
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Unclosed quoted field");
  expect(fake.rpc).not.toHaveBeenCalled();
});
