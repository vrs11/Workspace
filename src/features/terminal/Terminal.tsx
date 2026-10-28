import { schedulePersistence } from "../workspace/persistence";
import { shortcutLabel } from "../../shared/keymap";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Plus,
  Search,
  ChevronDown,
  ChevronUp,
  X,
  Columns2,
  Rows2,
  Maximize2,
  Minimize2,
  Pencil,
  Copy,
  ClipboardPaste,
  Square,
  TextSelect,
} from "lucide-react";
import { DockHeader } from "../workspace/DockWorkspace";
import { Group, Panel } from "react-resizable-panels";
import {
  ResizeSeparator,
  resizeTargetMinimumSize,
} from "../../shared/components/ResizeSeparator";
import type {
  TerminalInfo,
  TerminalLayout,
  TerminalNode,
} from "../../generated/protocol";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { useApp, perform, notice, reportError } from "../../shared/state/store";
import { ask } from "../../shared/components/Dialog";
import {
  renderer,
  destroyRenderer,
  markRendererClosing,
  type Renderer,
} from "./session";
import { panes, mapPane, removePane, ratio } from "./layout";
import "@xterm/xterm/css/xterm.css";
type PaneControls = {
  find: () => void;
  copy: () => Promise<void>;
  paste: () => Promise<void>;
  selectAll: () => void;
  focus: () => void;
};
const fresh = () => crypto.randomUUID();
function TerminalPanel() {
  const project = useApp((s) => s.project);
  const [layout, setLayout] = useState<TerminalLayout>({
    version: 1,
    tabs: [],
    active: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [activePane, setActivePane] = useState<string | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const controls = useRef(new Map<string, PaneControls>());
  const register = useCallback((id: string, actions: PaneControls | null) => {
    if (actions) controls.current.set(id, actions);
    else controls.current.delete(id);
  }, []);
  const [, refreshInfo] = useState(0);
  const updateInfo = useCallback((info: TerminalInfo) => {
    infos.current.set(info.id, info);
    refreshInfo((n) => n + 1);
  }, []);
  const infos = useRef(new Map<string, TerminalInfo>());
  const tokens = useRef(new Map<string, string>());
  const mutating = useRef(false);
  const returnFocusAfterClose = useRef(false);
  const [busy, setBusy] = useState(false);
  async function terminalPerform(work: () => Promise<unknown>) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    try {
      await perform(work);
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!project) return;
    let gone = false;
    setLoaded(false);
    setLoadError("");
    void (async () => {
      const [saved, list] = await Promise.all([
        call(
          { type: "terminalLayoutRead", scope: project.id },
          "terminalLayout",
        ),
        call({ type: "terminalList", scope: project.id }, "terminals"),
      ]);
      if (gone) return;
      for (const info of list.terminals) infos.current.set(info.id, info);
      const known = new Set(
        saved.layout.tabs.flatMap((t) => panes(t.root).map((p) => p.session)),
      );
      const tabs = [...saved.layout.tabs];
      for (const info of list.terminals)
        if (!known.has(info.id))
          tabs.push({
            id: fresh(),
            title: "Shell",
            root: { type: "pane", id: fresh(), session: info.id },
          });
      const active =
        tabs.find((t) => t.id === saved.layout.active)?.id ??
        tabs[0]?.id ??
        null;
      setLayout({ version: 1, tabs, active });
      setActivePane(
        tabs.find((t) => t.id === active)
          ? panes(tabs.find((t) => t.id === active)!.root)[0].id
          : null,
      );
      setLoaded(true);
    })().catch((error: unknown) => {
      if (!gone) setLoadError(errorText(error));
    });
    return () => {
      gone = true;
    };
  }, [project?.id, reload]);
  useLayoutEffect(() => {
    if (loaded && project)
      schedulePersistence({
        type: "terminalLayoutWrite",
        scope: project.id,
        layout,
      });
  }, [layout, loaded, project?.id, project?.trusted]);
  const active = layout.tabs.find((t) => t.id === layout.active);
  const selected =
    active &&
    (panes(active.root).find((p) => p.id === activePane) ??
      panes(active.root)[0]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useLayoutEffect(() => {
    if (!returnFocusAfterClose.current) return;
    returnFocusAfterClose.current = false;
    const focused = document.activeElement;
    if (
      selected &&
      (focused === document.body ||
        focused?.closest(".terminal-header, .terminal-panel"))
    )
      controls.current.get(selected.id)?.focus();
  }, [layout.tabs, selected?.id]);
  async function open(target?: string, direction = "horizontal") {
    if (!project) return;
    const count = layout.tabs.reduce((n, t) => n + panes(t.root).length, 0);
    if (count >= 16 || (!target && layout.tabs.length >= 8)) {
      notice("Terminal limit: 8 tabs and 16 panes.");
      return;
    }
    const targetTab = layout.active;
    const { info, token } = await call(
      { type: "terminalOpen", scope: project.id, cols: 100, rows: 24 },
      "terminal",
    );
    infos.current.set(info.id, info);
    tokens.current.set(info.id, token);
    const pane: TerminalNode = { type: "pane", id: fresh(), session: info.id };
    if (target)
      setLayout((l) => ({
        ...l,
        active: targetTab,
        tabs: l.tabs.map((t) =>
          t.id === targetTab
            ? {
                ...t,
                root: mapPane(t.root, target, (n) => ({
                  type: "split",
                  id: fresh(),
                  direction,
                  ratio: 50,
                  first: n,
                  second: pane,
                })),
              }
            : t,
        ),
      }));
    else {
      const id = fresh();
      setLayout((l) => ({
        version: 1,
        tabs: [
          ...l.tabs,
          { id, title: `Shell ${l.tabs.length + 1}`, root: pane },
        ],
        active: id,
      }));
    }
    setActivePane(pane.id);
    setMaximized(null);
  }
  function removeClosedPane(tabId: string, paneId: string) {
    returnFocusAfterClose.current = true;
    setLayout((old) => {
      const tab = old.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return old;
      const root = removePane(tab.root, paneId);
      const tabs = root
        ? old.tabs.map((candidate) =>
            candidate.id === tabId ? { ...candidate, root } : candidate,
          )
        : old.tabs.filter((candidate) => candidate.id !== tabId);
      return {
        ...old,
        tabs,
        active:
          old.active === tabId && !root ? (tabs[0]?.id ?? null) : old.active,
      };
    });
    setActivePane((old) => (old === paneId ? null : old));
    setMaximized((old) => (old === paneId ? null : old));
  }
  async function stopPane(
    tabId: string,
    pane: Extract<TerminalNode, { type: "pane" }>,
  ) {
    if (!project) return;
    if (pane.session && infos.current.has(pane.session)) {
      markRendererClosing(pane.session, true);
      try {
        await rpc({
          type: "terminalClose",
          scope: project.id,
          id: pane.session,
        });
        destroyRenderer(pane.session);
        infos.current.delete(pane.session);
        tokens.current.delete(pane.session);
      } finally {
        markRendererClosing(pane.session, false);
      }
    }
    removeClosedPane(tabId, pane.id);
  }
  async function close(paneId: string) {
    if (!project || !active) return;
    const pane = panes(active.root).find(
      (candidate) => candidate.id === paneId,
    );
    if (!pane) return;
    if (
      pane.session &&
      infos.current.has(pane.session) &&
      !(await ask({
        title: "Close terminal pane",
        description:
          "Close this terminal and stop any remaining owned jobs? Unsaved work inside running commands may be lost.",
        choices: ["Close terminal"],
      }))
    ) {
      controls.current.get(paneId)?.focus();
      return;
    }
    await stopPane(active.id, pane);
  }
  async function closeTab(tabId: string) {
    const tab = layout.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || !project) return;
    const tabPanes = panes(tab.root);
    const owned = tabPanes.filter(
      (pane) => pane.session && infos.current.has(pane.session),
    );
    if (
      owned.length &&
      !(await ask({
        title: "Close terminal tab",
        description: `Close ${tab.title} and stop ${owned.length} owned terminal session(s), including its splits? Other tabs remain running. Unsaved work inside commands may be lost.`,
        choices: ["Close tab"],
      }))
    ) {
      if (selected) controls.current.get(selected.id)?.focus();
      return;
    }
    // Acknowledge each close before removing its reference. A partial failure
    // leaves every unclosed session visible and never recreates a process.
    for (const pane of tabPanes) await stopPane(tab.id, pane);
  }
  async function renameTab() {
    if (!active) return;
    const title = await ask({
      title: "Rename terminal tab",
      description: "Name this terminal tab.",
      input: active.title,
    });
    if (selected) controls.current.get(selected.id)?.focus();
    if (!title?.trim()) return;
    const name = title
      .trim()
      .slice(0, 120)
      .split("")
      .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      .join("");
    if (!name) return;
    setLayout((old) => ({
      ...old,
      tabs: old.tabs.map((tab) =>
        tab.id === active.id ? { ...tab, title: name } : tab,
      ),
    }));
  }
  const renderNode = (node: TerminalNode): React.ReactNode =>
    node.type === "pane" ? (
      <Pane
        key={node.id}
        pane={node}
        split={layout.tabs.some(
          (tab) =>
            panes(tab.root).some((pane) => pane.id === node.id) &&
            panes(tab.root).length > 1,
        )}
        busy={busy}
        register={register}
        onStatus={updateInfo}
        info={node.session ? infos.current.get(node.session) : undefined}
        token={node.session ? tokens.current.get(node.session) : undefined}
        active={node.id === selected?.id}
        hidden={!!maximized && maximized !== node.id}
        focus={() => setActivePane(node.id)}
        close={() => void terminalPerform(() => close(node.id))}
        start={() =>
          void terminalPerform(async () => {
            if (!project) return;
            const { info, token } = await call(
              { type: "terminalOpen", scope: project.id, cols: 100, rows: 24 },
              "terminal",
            );
            infos.current.set(info.id, info);
            tokens.current.set(info.id, token);
            setLayout((l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({
                ...t,
                root: mapPane(t.root, node.id, (p) => ({
                  ...p,
                  session: info.id,
                })),
              })),
            }));
          })
        }
      />
    ) : (
      <Group
        key={node.id}
        disableCursor
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        orientation={node.direction === "vertical" ? "vertical" : "horizontal"}
        onLayoutChanged={(sizes) => {
          const size = sizes[`${node.id}-a`];
          if (size !== undefined && Math.abs(size - node.ratio) > 0.2)
            setLayout((l) => ({
              ...l,
              tabs: l.tabs.map((t) => ({
                ...t,
                root: ratio(t.root, node.id, Math.max(10, Math.min(90, size))),
              })),
            }));
        }}
      >
        <Panel id={`${node.id}-a`} defaultSize={`${node.ratio}%`} minSize="10%">
          {renderNode(node.first)}
        </Panel>
        <ResizeSeparator
          className={`separator ${node.direction === "vertical" ? "horizontal" : ""}`}
        />
        <Panel id={`${node.id}-b`} minSize="10%">
          {renderNode(node.second)}
        </Panel>
      </Group>
    );
  useEffect(() => {
    const command = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id.startsWith("terminal.")) return;
      event.preventDefault();
      if (!loaded || busy || !project?.trusted) {
        notice(
          "Trust the workspace and wait for terminal operations to finish.",
        );
        return;
      }
      const control = selected && controls.current.get(selected.id);
      const cycle = (direction: number, split = false) => {
        if (!active) return;
        if (split) {
          const list = panes(active.root),
            index = list.findIndex((pane) => pane.id === selected?.id);
          const pane = list[(index + direction + list.length) % list.length];
          setActivePane(pane.id);
          controls.current.get(pane.id)?.focus();
        } else {
          const index = layout.tabs.findIndex((tab) => tab.id === active.id),
            tab =
              layout.tabs[
                (index + direction + layout.tabs.length) % layout.tabs.length
              ];
          setLayout((old) => ({ ...old, active: tab.id }));
          setActivePane(panes(tab.root)[0].id);
          setMaximized(null);
        }
      };
      switch (id) {
        case "terminal.new":
          void terminalPerform(() => open());
          break;
        case "terminal.closeTab":
          if (active) void terminalPerform(() => closeTab(active.id));
          break;
        case "terminal.closeSplit":
          if (selected) void terminalPerform(() => close(selected.id));
          break;
        case "terminal.splitRight":
          if (selected)
            void terminalPerform(() => open(selected.id, "horizontal"));
          break;
        case "terminal.splitDown":
          if (selected)
            void terminalPerform(() => open(selected.id, "vertical"));
          break;
        case "terminal.maximize":
          if (selected) setMaximized((old) => (old ? null : selected.id));
          break;
        case "terminal.rename":
          void perform(renameTab);
          break;
        case "terminal.nextTab":
          cycle(1);
          break;
        case "terminal.previousTab":
          cycle(-1);
          break;
        case "terminal.nextSplit":
          cycle(1, true);
          break;
        case "terminal.previousSplit":
          cycle(-1, true);
          break;
        case "terminal.find":
          control?.find();
          break;
        case "terminal.copy":
          if (control) void perform(() => control.copy());
          break;
        case "terminal.paste":
          if (control) void perform(() => control.paste());
          break;
        case "terminal.selectAll":
          control?.selectAll();
          break;
      }
    };
    window.addEventListener("workspace-command", command);
    return () => window.removeEventListener("workspace-command", command);
  });
  return (
    <section
      className={`terminal-panel ${maximized ? "terminal-maximized" : ""}`}
    >
      <DockHeader>
        <div
          className="terminal-header"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && selected)
              controls.current.get(selected.id)?.focus();
          }}
        >
          <div
            className="terminal-tabs"
            role="tablist"
            aria-label="Terminal tabs"
            onKeyDown={(event) => {
              if (
                !(event.target as HTMLElement).closest('[role="tab"]') ||
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const index = layout.tabs.findIndex(
                (tab) => tab.id === layout.active,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? layout.tabs.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        layout.tabs.length) %
                      layout.tabs.length;
              const tab = layout.tabs[next];
              if (!tab) return;
              setLayout((old) => ({ ...old, active: tab.id }));
              setActivePane(panes(tab.root)[0].id);
              setMaximized(null);
              const tabs =
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs[next]?.focus();
            }}
          >
            {layout.tabs.map((tab) => (
              <div
                className={`terminal-tab ${tab.id === layout.active ? "active" : ""}`}
                key={tab.id}
              >
                <button
                  role="tab"
                  aria-selected={tab.id === layout.active}
                  tabIndex={tab.id === layout.active ? 0 : -1}
                  title={tab.title}
                  onDoubleClick={() => void perform(renameTab)}
                  onClick={() => {
                    setLayout((old) => ({ ...old, active: tab.id }));
                    setActivePane(panes(tab.root)[0].id);
                    setMaximized(null);
                  }}
                >
                  <span className="truncate">{tab.title}</span>
                </button>
                <button
                  className="terminal-tab-close"
                  aria-label={`Close terminal tab ${tab.title}`}
                  title={`Close ${tab.title} and its splits`}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    void terminalPerform(() => closeTab(tab.id));
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <button
            className="terminal-icon"
            aria-label="New terminal"
            title="New terminal"
            disabled={!loaded || !project?.trusted || busy}
            onClick={() => void terminalPerform(() => open())}
          >
            <Plus size={15} />
          </button>
          <button
            className="terminal-icon"
            aria-label="Find in terminal"
            title={`Find in terminal (${shortcutLabel("terminal.find")})`}
            disabled={
              !selected?.session || !infos.current.has(selected.session)
            }
            onClick={() =>
              selected && controls.current.get(selected.id)?.find()
            }
          >
            <Search size={14} />
          </button>
          <Menu.Root>
            <Menu.Trigger asChild>
              <button
                className="terminal-icon"
                aria-label="Terminal actions"
                title="Terminal actions"
                disabled={!selected || busy}
              >
                <ChevronDown size={14} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="dock-menu terminal-menu"
                sideOffset={5}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  const current = selectedRef.current;
                  if (
                    !document.querySelector(
                      '.terminal-find:focus-within, .dialog-content[role="dialog"], [role="menu"]',
                    ) &&
                    current
                  )
                    controls.current.get(current.id)?.focus();
                }}
              >
                <Menu.Item
                  disabled={!project?.trusted || busy}
                  onSelect={() =>
                    selected &&
                    void terminalPerform(() => open(selected.id, "horizontal"))
                  }
                >
                  <Columns2 size={14} /> Split right
                </Menu.Item>
                <Menu.Item
                  disabled={!project?.trusted || busy}
                  onSelect={() =>
                    selected &&
                    void terminalPerform(() => open(selected.id, "vertical"))
                  }
                >
                  <Rows2 size={14} /> Split down
                </Menu.Item>
                <Menu.Item
                  onSelect={() =>
                    setMaximized((old) => (old ? null : (selected?.id ?? null)))
                  }
                >
                  {maximized ? (
                    <Minimize2 size={14} />
                  ) : (
                    <Maximize2 size={14} />
                  )}
                  {maximized ? "Restore panes" : "Maximize pane"}
                </Menu.Item>
                <Menu.Item onSelect={() => void perform(renameTab)}>
                  <Pencil size={14} />
                  Rename tab
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item
                  disabled={
                    !selected?.session || !infos.current.has(selected.session)
                  }
                  onSelect={() =>
                    selected && controls.current.get(selected.id)?.selectAll()
                  }
                >
                  <TextSelect size={14} />
                  Select all
                </Menu.Item>
                <Menu.Item
                  disabled={
                    !selected?.session || !infos.current.has(selected.session)
                  }
                  onSelect={() =>
                    void perform(
                      async () =>
                        selected && controls.current.get(selected.id)?.copy(),
                    )
                  }
                >
                  <Copy size={14} />
                  Copy
                </Menu.Item>
                <Menu.Item
                  disabled={
                    !selected?.session ||
                    !infos.current.has(selected.session) ||
                    infos.current.get(selected.session)?.exited
                  }
                  onSelect={() =>
                    void perform(
                      async () =>
                        selected && controls.current.get(selected.id)?.paste(),
                    )
                  }
                >
                  <ClipboardPaste size={14} />
                  Paste
                </Menu.Item>
                <Menu.Item
                  disabled={
                    !selected?.session || !infos.current.has(selected.session)
                  }
                  onSelect={() =>
                    selected && controls.current.get(selected.id)?.find()
                  }
                >
                  <Search size={14} />
                  Find in terminal
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item
                  onSelect={() =>
                    selected && void terminalPerform(() => close(selected.id))
                  }
                >
                  <Square size={14} />
                  {selected?.session &&
                  infos.current.has(selected.session) &&
                  !infos.current.get(selected.session)?.exited
                    ? "Terminate"
                    : "Close pane"}
                </Menu.Item>
                <Menu.Item
                  onSelect={() =>
                    active && void terminalPerform(() => closeTab(active.id))
                  }
                >
                  <X size={14} />
                  Close tab
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </DockHeader>
      {loadError && (
        <div className="terminal-empty" role="alert">
          <p>{loadError}</p>
          <button onClick={() => setReload((n) => n + 1)}>
            Retry terminal layout
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                if (
                  !project ||
                  !(await ask({
                    title: "Repair saved terminal layout",
                    description:
                      "Reset terminal tab references and geometry? Retain the original layout and editor recovery. Existing owned terminals will be reattached; no command is started or replayed.",
                    choices: ["Reset terminal layout"],
                  }))
                )
                  return;
                await rpc({
                  type: "repairLayout",
                  scope: project.id,
                  terminal: true,
                });
                setReload((n) => n + 1);
              })
            }
          >
            Reset terminal layout
          </button>
        </div>
      )}
      {!loaded && <div className="empty-state">Restoring terminal layout…</div>}
      {loaded && !layout.tabs.length && (
        <div className="empty-state">
          <button
            disabled={!project?.trusted || busy}
            onClick={() => void terminalPerform(() => open())}
          >
            <Plus size={15} />
            Start a local shell
          </button>
        </div>
      )}
      {layout.tabs.map((tab) => (
        <div
          className="terminal-tab-body"
          key={tab.id}
          hidden={tab.id !== layout.active}
        >
          {renderNode(tab.root)}
        </div>
      ))}
    </section>
  );
}
function Pane({
  pane,
  split,
  busy,
  register,
  onStatus,
  info,
  token,
  active,
  hidden,
  focus,
  close,
  start,
}: {
  pane: Extract<TerminalNode, { type: "pane" }>;
  split: boolean;
  busy: boolean;
  register: (id: string, controls: PaneControls | null) => void;
  onStatus: (info: TerminalInfo) => void;
  info?: TerminalInfo;
  token?: string;
  active: boolean;
  hidden: boolean;
  focus: () => void;
  close: () => void;
  start: () => void;
}) {
  const settings = useApp((s) => s.settings);
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<Renderer | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const [status, setStatus] = useState<TerminalInfo | undefined>(info);
  const [finding, setFinding] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState("");
  useEffect(() => {
    let gone = false;
    if (!info || !settings) return;
    void renderer(info, settings, token)
      .then((r) => {
        if (gone || !ref.current) return;
        instance.current = r;
        ref.current.appendChild(r.host);
        r.change = () => {
          setStatus({ ...r.info });
          onStatus({ ...r.info });
        };
        setStatus({ ...r.info });
        r.fit();
        if (activeRef.current && !hiddenRef.current) r.term.focus();
      })
      .catch((e) => reportError(e));
    return () => {
      gone = true;
      if (instance.current) instance.current.change = () => {};
      instance.current = null;
    };
  }, [pane.session]);
  useEffect(() => {
    if (settings) instance.current?.update(settings);
  }, [settings]);
  useEffect(() => {
    if (active && !hidden) {
      instance.current?.fit();
      if (document.activeElement !== findInput.current)
        instance.current?.term.focus();
    }
  }, [active, hidden]);
  useEffect(() => {
    register(pane.id, {
      find: () => {
        setFinding(true);
        findInput.current?.focus();
        findInput.current?.select();
      },
      copy: async () => {
        await instance.current?.copy();
      },
      paste: async () => {
        await instance.current?.paste();
      },
      selectAll: () => {
        instance.current?.term.selectAll();
        instance.current?.term.focus();
      },
      focus: () => instance.current?.term.focus(),
    });
    return () => register(pane.id, null);
  }, [pane.id, register]);
  useLayoutEffect(() => {
    if (finding) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [finding]);
  const closeFind = () => {
    setFinding(false);
    instance.current?.search.clearDecorations();
    instance.current?.term.focus();
  };
  const find = (previous: boolean) => {
    if (!query) return;
    setMatches(
      (
        previous
          ? instance.current?.search.findPrevious(query)
          : instance.current?.search.findNext(query)
      )
        ? "Match"
        : "No match",
    );
  };
  return (
    <div
      className={`terminal-view ${active ? "active-pane" : ""} ${hidden ? "minimized-pane" : ""}`}
      onFocusCapture={focus}
      onClickCapture={focus}
      data-pane={pane.id}
      data-session={pane.session ?? ""}
    >
      {split && (
        <button
          className="terminal-split-close terminal-icon"
          aria-label="Close terminal split"
          title="Close this split"
          disabled={busy}
          onClick={close}
        >
          <X size={13} />
        </button>
      )}
      {finding && (
        <form
          className="terminal-find"
          role="search"
          aria-label="Terminal search"
          onSubmit={(event) => {
            event.preventDefault();
            find(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeFind();
            }
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              find(true);
            }
          }}
        >
          <Search size={14} aria-hidden="true" />
          <input
            ref={findInput}
            aria-label="Find in terminal"
            placeholder="Find"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches("");
            }}
          />
          <span role="status" className="terminal-match">
            {matches}
          </span>
          <button
            type="button"
            className="terminal-icon"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!query}
            onClick={() => find(true)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="submit"
            className="terminal-icon"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={!query}
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            className="terminal-icon"
            aria-label="Close terminal search"
            title="Close (Escape)"
            onClick={closeFind}
          >
            <X size={14} />
          </button>
        </form>
      )}
      {(!info || status?.exited || status?.error) && (
        <div className="terminal-exit">
          <span className="terminal-state" role="status">
            {!info
              ? "Session ended"
              : (status?.error ??
                `Exited ${status?.signal ?? status?.exitCode ?? "?"}`)}
          </span>
          <button
            className="terminal-icon"
            aria-label="Close ended terminal"
            title="Close pane"
            onClick={close}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {info ? (
        <div ref={ref} className="terminal-surface" onPointerDown={focus} />
      ) : (
        <div className="empty-state">
          <p>Session ended.</p>
          <button onClick={start}>Start shell</button>
        </div>
      )}
    </div>
  );
}
export default memo(TerminalPanel);
