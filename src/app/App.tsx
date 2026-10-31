import { useShallow } from "zustand/react/shallow";
import workspaceIcon from "../assets/workspace-icon.png";
import workspaceIcon1x from "../assets/workspace-icon@1x.png";
import workspaceIcon3x from "../assets/workspace-icon@3x.png";
import { installViewResources } from "../features/workspace/viewResources";
import { chooseCurrentWindow } from "../features/workspace/projectWindow";
import StatusBar from "./StatusBar";
import { EditorTabs } from "../features/editor/EditorTabs";
import { MetadataWarning } from "../features/editor/MetadataWarning";
import { createTabCloser } from "../features/editor/tabActions";
import {
  workspaceSnapshot,
  activeDocumentUi,
} from "../shared/state/workspaceSelectors";
import { installShortcutRouter, shortcutLabel } from "../shared/keymap";
import { selectedFileQuery } from "../shared/selection";
import { ModalContent } from "../shared/components/ModalContent";
import {
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  type ComponentProps,
} from "react";

import {
  FolderOpen,
  Search,
  Settings as SettingsIcon,
  Files,
  GitBranch,
  TerminalSquare,
  Save,
  Columns2,
  X,
  Command,
  RefreshCw,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { listen } from "@tauri-apps/api/event";
import { useApp, perform, notice } from "../shared/state/store";
import { call, rpc, subscribe, errorText } from "../shared/ipc/client";
import { coalesceRefresh } from "../shared/state/refresh";
import { NotificationToast } from "../shared/components/NotificationToast";
import {
  DialogHost,
  ask,
  askWhenIdle,
  waitForDialogIdle,
} from "../shared/components/Dialog";
import ProjectExplorer from "../features/explorer/ProjectExplorer";
import GitToolWindow from "../features/git/GitToolWindow";
import DockWorkspace, {
  DockLayoutMenu,
} from "../features/workspace/DockWorkspace";
import {
  defaultDock,
  showPanel as revealPanel,
  hidePanel,
  restoreDock,
} from "../features/workspace/dockModel";
import {
  schedulePersistence,
  flushWorkspacePersistence,
  persistenceWarning,
} from "../features/workspace/persistence";
import type { DockLayout, DockPanel, Project } from "../generated/protocol";
import { installFileDrops } from "../features/explorer/fileDrag";
import SearchPanel from "../features/search/SearchPanel";
const SettingsPanel = lazy(() => import("../features/settings/Settings"));
import {
  installAutoSave,
  flushConfiguredAutoSave,
} from "../features/editor/autosave";
import {
  loadDocument,
  saveAll,
  checkpoint,
  saveDocument,
  disposeModel,
  abandonModelLoads,
  models,
  reconcileDocuments,
} from "../features/editor/models";
const MediaPreview = lazy(() => import("../features/media/MediaPreview"));
const Editor = lazy(() => import("../features/editor/Editor"));
const DiffEditor = lazy(() => import("../features/editor/DiffEditor"));
const ConflictEditor = lazy(() => import("../features/editor/ConflictEditor"));
const GitConflictEditor = lazy(
  () => import("../features/git/GitConflictEditor"),
);
const Terminal = lazy(() => import("../features/terminal/Terminal"));
function RepairPreferencesButton(props: ComponentProps<"button">) {
  const busy = useApp((s) => s.busy > 0);
  return <button {...props} disabled={busy} />;
}
function OperationOutput() {
  const message = useApp((state) => state.notice);
  return (
    <div className="output-panel">
      <button
        onClick={() =>
          void perform(async () =>
            notice((await call({ type: "diagnostics" }, "text")).text),
          )
        }
      >
        Preview diagnostics
      </button>
      <p>
        {message ||
          "Operation results and errors appear here. Terminal transcripts are not persisted."}
      </p>
    </div>
  );
}
export default function App() {
  const [dock, setDock] = useState<DockLayout>(defaultDock);
  const [explorerSearch, setExplorerSearch] = useState(false);
  const [uiReady, setUiReady] = useState(false);
  const [uiError, setUiError] = useState("");
  const showPanel = useCallback(
    (panel: DockPanel) => setDock((old) => revealPanel(old, panel)),
    [],
  );
  const closed = useRef<string[]>([]);
  const commandActions = useRef(new Map<string, () => Promise<unknown>>());
  const restoring = useRef(false);
  const closePending = useRef(false);
  const state = useApp(useShallow(workspaceSnapshot));
  const activeDoc = useApp(useShallow(activeDocumentUi));
  const settingsReady = !!state.settings;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [startupIssue, setStartupIssue] = useState<string | null>(null);
  const [palette, setPalette] = useState<"commands" | "files" | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const openQuickOpen = useCallback(() => {
    setFileQuery(selectedFileQuery());
    setPalette("files");
  }, []);
  const [commandFilter, setCommandFilter] = useState("");
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [layout, setLayout] = useState<number[]>([22, 78, 68, 32, 50, 50]);
  const openProject = useCallback(async (path?: string, resume = false) => {
    if (resume && !path) path = useApp.getState().project?.root;
    if (!path) path = (await call({ type: "pickFolder" }, "text")).text;
    if (!path) return;
    if (
      !resume &&
      !(await chooseCurrentWindow(path, !!useApp.getState().project))
    )
      return;
    await flushConfiguredAutoSave();
    const current = useApp.getState();
    if (Object.values(current.docs).some((d) => d.dirty)) {
      if (
        !(await ask({
          title: "Save before switching projects",
          description:
            "Open buffers need an explicit decision. Save all and switch, or cancel and resolve them individually.",
          choices: ["Save all and switch"],
        }))
      )
        return;
      await saveAll();
    }
    if (current.project && !resume) {
      const { terminals } = await call(
        { type: "terminalList", scope: current.project.id },
        "terminals",
      );
      if (terminals.length) {
        if (
          !(await ask({
            title: "Close terminals before switching",
            description: `Terminate ${terminals.length} project terminal(s) and switch folders? Running commands may have unsaved work.`,
            choices: ["Terminate and switch"],
          }))
        )
          return;
        const { destroyRenderer } =
          await import("../features/terminal/session");
        for (const terminal of terminals) {
          await rpc({
            type: "terminalClose",
            scope: current.project.id,
            id: terminal.id,
          });
          destroyRenderer(terminal.id);
        }
      }
    }
    if (current.project) await flushWorkspacePersistence(current.project.id);
    restoring.current = true;
    let project: Project;
    try {
      if (resume)
        project = (await call({ type: "bootstrap" }, "bootstrap")).project!;
      else {
        const result = await rpc({ type: "openProject", path });
        if (result.type === "windowOpened") {
          restoring.current = false;
          return;
        }
        if (result.type !== "project")
          throw new Error("Expected an opened project");
        project = result.project;
      }
    } catch (error) {
      restoring.current = false;
      const previous = current.settings?.recent.find(
        (item) => item.root === path,
      );
      if (
        !previous ||
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "notFound"
        )
      )
        throw error;
      const located = await ask({
        title: "Locate missing project folder",
        description: `Locate the original ${previous.name} folder. Its filesystem identity must match. Unsaved recovery, layout and terminal references are kept. A copied or unrelated folder must be opened separately.`,
        input: previous.root,
        browseFolder: true,
        choices: ["Use folder"],
      });
      if (!located) return;
      project = (
        await call(
          { type: "relocateProject", project: previous.id, path: located },
          "project",
        )
      ).project;
    }
    restoring.current = true;
    setUiReady(false);
    setUiError("");
    setTerminalMounted(true);
    abandonModelLoads();
    for (const id of Object.keys(current.docs)) disposeModel(id);
    useApp.getState().set({
      project,
      docs: {},
      tabs: [],
      active: null,
      split: null,
      explorerExpanded: [],
      gitHistory: false,
    });
    const boot = await call({ type: "bootstrap" }, "bootstrap");
    useApp.getState().set({ settings: boot.settings });
    try {
      const ui = await call({ type: "uiRead", scope: project.id }, "ui").catch(
        async (error: unknown) => {
          if (!(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            [
              "corruptState",
              "stateVersion",
              "unsafePath",
              "resourceLimit",
            ].includes(String(error.code))
          ))
            throw error;
          if (
            !(await ask({
              title: "Repair saved editor layout",
              description:
                "The saved editor layout cannot be read. Reset its tab references and geometry? The original layout, previous backup and all unsaved editor checkpoints will be retained.",
              choices: ["Reset editor layout"],
            }))
          )
            throw error;
          await rpc({
            type: "repairLayout",
            scope: project.id,
            terminal: false,
          });
          return call({ type: "uiRead", scope: project.id }, "ui");
        },
      );
      setDock(restoreDock(ui.dock));
      setExplorerSearch(ui.view.explorerSearch);
      useApp.setState({
        gitHistory: ui.view.gitHistory,
        explorerExpanded: ui.view.expanded,
        bottom: ui.view.gitHistory ? "history" : "changes",
      });
      persistenceWarning(project.id, ui.persistence);
      if (ui.layout.length >= 2)
        setLayout([
          ui.layout[0],
          ui.layout[1],
          ui.layout[2] ?? 68,
          ui.layout[3] ?? 32,
          ui.layout[4] ?? 50,
          ui.layout[5] ?? 50,
        ]);
      for (const entry of ui.tabs) {
        try {
          await loadDocument(entry, false);
        } catch (e) {
          notice(`Could not restore a tab: ${errorText(e)}`);
        }
      }
      useApp.getState().set({
        split: ui.split && useApp.getState().docs[ui.split] ? ui.split : null,
        active:
          ui.active &&
          useApp.getState().tabs.some((tab) => tab.id === ui.active)
            ? ui.active
            : (useApp.getState().tabs.at(-1)?.id ?? null),
      });
    } catch (error) {
      setUiError(errorText(error));
      throw error;
    } finally {
      restoring.current = false;
    }
    setUiReady(true);
    const recovery = await call(
      { type: "recoveries", scope: project.id },
      "items",
    );
    if (recovery.items.length) {
      notice(
        `${recovery.items.length} acknowledged editor checkpoint(s) available. Use Recover unsaved files in the command palette.`,
      );
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const stop = installFileDrops((drop) => {
      void perform(async () => {
        const initial = useApp.getState().project?.id;
        if (drop.drag) {
          if (drop.drag.scope !== initial) return;
          for (const entry of drop.drag.entries) {
            if (useApp.getState().project?.id !== initial) return;
            if (entry.kind === "file") await loadDocument(entry.id);
          }
          return;
        }
        if (!drop.offer) return;
        if (!initial && drop.folder) await openProject(drop.folder);
        const scope = useApp.getState().project?.id;
        if (!scope || (initial && scope !== initial)) return;
        const result = await call(
          { type: "openDroppedFiles", scope, offer: drop.offer },
          "fileDrop",
        );
        const errors = [...result.errors];
        for (const entry of result.entries) {
          if (useApp.getState().project?.id !== scope) return;
          try {
            await loadDocument(entry.id);
          } catch (error) {
            errors.push(`${entry.name}: ${errorText(error)}`);
          }
        }
        if (errors.length) notice(errors.join("\n"));
      });
    });
    void stop
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
      })
      .catch((error) => notice(errorText(error)));
    return () => {
      disposed = true;
      void stop.then((unsubscribe) => unsubscribe()).catch(() => {});
    };
  }, [openProject]);
  useEffect(() => {
    void perform(async () => {
      try {
        const r = await call({ type: "bootstrap" }, "bootstrap");
        useApp.getState().set({ settings: r.settings });
        setStartupIssue(r.startup_issue);
        if (r.startup_issue) return;
        if (r.project) await openProject(r.project.root, true);
      } finally {
        // Record usability after React commits and the first paint opportunity.
        // This is an aggregate diagnostic, with no test driver or data override.
        let reported = false;
        const report = (painted: boolean) => {
          if (reported) return;
          reported = true;
          void call(
            {
              type: "startupReady",
              visible: document.visibilityState === "visible",
              painted,
            },
            "ok",
          ).catch(() => {});
        };
        // Background views can suspend animation frames. Retain a distinct
        // non-paint diagnostic, which is never eligible for a foreground budget.
        const timer = setTimeout(() => report(false), 1000);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            report(true);
          }),
        );
      }
    });
  }, [openProject]);
  useEffect(() => {
    if (!settingsReady || startupIssue) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // A signal arriving while an empty native read is in flight must schedule
    // a following drain; returning merely because a read is busy loses that wake.
    const check = coalesceRefresh(async () => {
      while (!disposed) {
        const { text: path } = await call({ type: "takeOpenRequest" }, "text");
        if (!path) break;
        await perform(async () => {
          if (
            await askWhenIdle({
              title: "Open requested folder",
              description: path,
              choices: ["Open folder"],
            })
          )
            await openProject(path);
        });
      }
    });
    void listen("folder-requested", () => {
      void perform(check);
    })
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          void perform(check);
        }
      })
      .catch((error) => notice(String(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [settingsReady, startupIssue, openProject]);
  useEffect(() => {
    document.documentElement.dataset.theme = state.settings?.theme ?? "dark";
  }, [state.settings?.theme]);
  useEffect(() => installAutoSave(), []);
  useEffect(() => {
    let disposed = false;
    let preferenceGeneration = -1,
      ticket = 0;
    const stops: Array<() => void> = [];
    const watch = async (pending: Promise<() => void>) => {
      try {
        const stop = await pending;
        if (disposed) stop();
        else stops.push(stop);
      } catch (error) {
        if (!disposed) notice(errorText(error));
      }
    };
    void watch(
      listen<number>("preferences-changed", ({ payload }) => {
        if (payload <= preferenceGeneration) return;
        preferenceGeneration = payload;
        const current = ++ticket;
        void perform(async () => {
          const result = await call({ type: "bootstrap" }, "bootstrap");
          if (disposed || current !== ticket) return;
          useApp.getState().set({ settings: result.settings });
          setStartupIssue(result.startup_issue);
        });
      }),
    );
    void watch(
      listen<string>("workspace-notice", ({ payload }) => {
        if (!disposed) notice(payload);
      }),
    );
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, []);
  useEffect(() => installViewResources(), []);
  useEffect(() => {
    if (!state.project) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribe(state.project.id, (event) => {
      if (event.scope !== useApp.getState().project?.id) return;
      if (event.type === "closeRequested") {
        if (closePending.current) return;
        closePending.current = true;
        void perform(async () => {
          let completed = false;
          try {
            await waitForDialogIdle();
            await flushConfiguredAutoSave();
            const s = useApp.getState();
            let decision: string | null = null;
            if (Object.values(s.docs).some((d) => d.dirty)) {
              decision = await askWhenIdle({
                title: "Unsaved changes before closing this window",
                description:
                  "Save all open changes, discard all unsaved editor changes, or cancel to keep working.",
                choices: ["Save all and close", "Discard unsaved changes"],
              });
              if (!decision) return;
            }
            if (s.project) {
              const { terminals } = await call(
                { type: "terminalList", scope: s.project.id },
                "terminals",
              );
              if (
                terminals.length &&
                !(await askWhenIdle({
                  title: "Close this window and its terminals",
                  description: `Stop ${terminals.length} shell(s) and their owned jobs? Commands are not restarted when you reopen.`,
                  choices: ["Terminate and close"],
                }))
              )
                return;
              if (decision === "Save all and close") await saveAll();
              else if (decision === "Discard unsaved changes")
                for (const id of models.keys())
                  await rpc({
                    type: "discard",
                    scope: s.project.id,
                    document: id,
                  });
              for (const t of terminals)
                await rpc({
                  type: "terminalClose",
                  scope: s.project.id,
                  id: t.id,
                });
            }
            if (s.project) await flushWorkspacePersistence(s.project.id);
            await waitForDialogIdle();
            await rpc({ type: "finishClose" });
            completed = true;
          } finally {
            if (!completed) await rpc({ type: "cancelClose" }).catch(() => {});
            closePending.current = false;
          }
        });
      } else if (event.type === "searchBatch") {
        window.dispatchEvent(
          new CustomEvent("search-batch", { detail: event }),
        );
      } else if (event.type === "credential") {
        void perform(async () => {
          const value = await askWhenIdle({
            title: "Git authentication",
            description:
              event.prompt +
              "\nCredentials are transient and sent only to this operation.",
            input: "",
            secret: true,
          });
          await rpc({
            type: "credentialReply",
            scope: event.scope,
            request: event.request,
            value,
          });
        });
      } else {
        if (event.degraded)
          notice(
            "File watching is degraded. Use Refresh; open files are also checked on focus.",
          );
        window.dispatchEvent(new Event("workspace-reconcile"));
      }
    })
      .then((fn) => {
        if (disposed) fn();
        else unsubscribe = fn;
      })
      .catch((e) => notice(`Native stream failed: ${String(e)}`));
    const refresh = () => {
      void perform(reconcileDocuments);
      window.dispatchEvent(new Event("workspace-refresh"));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconcile = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("workspace-reconcile", reconcile);
    const poll = setInterval(() => {
      if (document.hasFocus()) void perform(reconcileDocuments);
    }, 15000);
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("workspace-reconcile", reconcile);
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [state.project?.id]);
  useLayoutEffect(() => {
    if (!state.project || restoring.current || !uiReady) return;
    const tabs = state.tabs
      .filter((t) => t.kind === "editor" || t.kind === "media")
      .map((t) => t.id);
    schedulePersistence({
      type: "uiWrite",
      scope: state.project.id,
      tabs,
      active: tabs.includes(state.active ?? "") ? state.active : null,
      layout,
      split: state.split,
      dock,
      view: {
        explorerSearch,
        gitHistory: state.gitHistory,
        expanded: state.explorerExpanded,
      },
    });
  }, [
    state.project?.id,
    state.project?.trusted,
    state.tabs,
    state.active,
    state.split,
    state.gitHistory,
    state.explorerExpanded,
    layout,
    dock,
    uiReady,
    explorerSearch,
  ]);
  useEffect(() => {
    const reveal = () => {
      if (!restoring.current) showPanel("editor");
    };
    window.addEventListener("workspace-reveal-editor", reveal);
    const unsubscribe = useApp.subscribe((next, previous) => {
      // This runs at the state transition, rather than a later React effect:
      // restoring tabs/views must not act like an explicit navigation request.
      if (restoring.current || next.project?.id !== previous.project?.id)
        return;
      if (next.toolRequest !== previous.toolRequest) {
        if (next.bottom === "search") {
          setExplorerSearch(true);
          showPanel("explorer");
        } else
          showPanel(
            next.bottom === "changes" || next.bottom === "history"
              ? "git"
              : next.bottom,
          );
      }
      if (next.split !== previous.split)
        setDock((old) =>
          next.split
            ? revealPanel(old, "editorSecondary")
            : hidePanel(old, "editorSecondary"),
        );
      if (
        next.active &&
        next.active !== previous.active &&
        next.tabs.length >= previous.tabs.length
      )
        showPanel("editor");
    });
    return () => {
      unsubscribe();
      window.removeEventListener("workspace-reveal-editor", reveal);
    };
  }, [showPanel]);
  const closeTab = useMemo(
    () =>
      createTabCloser((entry) => {
        closed.current.push(entry);
        closed.current = closed.current.slice(-20);
      }),
    [],
  );
  useEffect(() => installShortcutRouter(), []);
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (!command.startsWith("app.")) return;
      event.preventDefault();
      const action = commandActions.current.get(command);
      if (action) {
        void perform(action);
        return;
      }
      const current = useApp.getState();
      const index = current.tabs.findIndex((tab) => tab.id === current.active);
      const selectTab = (direction: number) =>
        current.set({
          active:
            current.tabs[
              (index + direction + current.tabs.length) % current.tabs.length
            ]?.id ?? null,
        });
      switch (command) {
        case "app.save":
          if (current.active && current.docs[current.active])
            void perform(() => saveDocument(current.active!));
          break;
        case "app.saveAll":
          void perform(saveAll);
          break;
        case "app.openFolder":
          void perform(() => openProject());
          break;
        case "app.newWindow":
          void perform(() =>
            call({ type: "newWindow", path: null }, "windowOpened"),
          );
          break;
        case "app.quit":
          void perform(() => call({ type: "quitApplication" }, "ok"));
          break;
        case "app.quickOpen":
          openQuickOpen();
          break;
        case "app.commandPalette":
          setPalette("commands");
          break;
        case "app.settings":
          setSettingsOpen(true);
          break;
        case "app.closeTab":
          if (current.active) void perform(() => closeTab(current.active!));
          break;
        case "app.reopenTab": {
          const entry = closed.current.pop();
          if (entry) void perform(() => loadDocument(entry));
          break;
        }
        case "app.nextTab":
          selectTab(1);
          break;
        case "app.previousTab":
          selectTab(-1);
          break;
        case "app.focusPrimary":
        case "app.focusSecondary":
          window.dispatchEvent(
            new CustomEvent("editor-focus", {
              detail: command === "app.focusPrimary" ? "primary" : "secondary",
            }),
          );
          break;
        case "app.splitEditor":
          if (
            current.tabs.find((tab) => tab.id === current.active)?.kind ===
            "editor"
          )
            current.set({ split: current.split ? null : current.active });
          break;
        case "app.refresh":
          void perform(async () => {
            await reconcileDocuments();
            window.dispatchEvent(new Event("workspace-refresh"));
          });
          break;
        case "app.search":
          setExplorerSearch(true);
          showPanel("explorer");
          break;
        case "app.explorer":
          setExplorerSearch(false);
          showPanel("explorer");
          break;
        case "app.git":
          current.set({ bottom: "changes" });
          break;
        case "app.history":
          current.set({ bottom: "history" });
          break;
        case "app.terminal":
          setTerminalMounted(true);
          current.set({ bottom: "terminal" });
          break;
        case "app.output":
          current.set({ bottom: "output" });
          break;
      }
    };
    window.addEventListener("workspace-command", handler);
    return () => window.removeEventListener("workspace-command", handler);
  }, [closeTab, openProject, showPanel, openQuickOpen]);
  const commands = [
    ...(state.project
      ? [
          {
            id: "app.locateProject",
            label: "Locate moved project folder",
            run: async () => {
              const previous = useApp.getState().project;
              if (!previous) return;
              const path = await ask({
                title: "Locate original project folder",
                description:
                  "Choose the moved original folder. Its filesystem identity must match. Open buffers, recovery and running terminals are preserved; commands are never restarted.",
                input: previous.root,
                browseFolder: true,
                choices: ["Use folder"],
              });
              if (!path) return;
              const { project } = await call(
                { type: "relocateProject", project: previous.id, path },
                "project",
              );
              const boot = await call({ type: "bootstrap" }, "bootstrap");
              useApp.getState().set({ project, settings: boot.settings });
              window.dispatchEvent(new Event("workspace-refresh"));
              notice(
                "Project folder located. Buffers and terminals were preserved. Refresh any existing diff or replacement preview before applying changes.",
              );
            },
          },
        ]
      : []),
    {
      id: "app.restoreDeleted",
      label: "Restore deleted file or folder",
      run: async () => {
        const p = useApp.getState().project;
        if (!p) return;
        const { items } = await call(
          { type: "trashList", scope: p.id },
          "items",
        );
        if (!items.length) {
          notice("No recoverable deleted files or folders for this project.");
          return;
        }
        const choice = await ask({
          title: "Restore deleted file or folder",
          description:
            "Restore to the original path without overwriting existing files or folders. Parent directories must still exist.",
          choices: items.map((i) => `${i.label} · ${i.id.slice(0, 8)}`),
        });
        const item = items.find(
          (i) => `${i.label} · ${i.id.slice(0, 8)}` === choice,
        );
        if (item) {
          notice(
            (
              await call(
                { type: "trashRestore", scope: p.id, id: item.id },
                "text",
              )
            ).text,
          );
          window.dispatchEvent(new Event("workspace-refresh"));
        }
      },
    },
    {
      label: `Open folder · ${shortcutLabel("app.openFolder")}`,
      run: () => openProject(),
    },
    {
      label: `New window · ${shortcutLabel("app.newWindow")}`,
      run: () => call({ type: "newWindow", path: null }, "windowOpened"),
    },
    {
      label: "Quit Workspace",
      run: () => call({ type: "quitApplication" }, "ok"),
    },
    { label: `Save all · ${shortcutLabel("app.saveAll")}`, run: saveAll },
    {
      label: `Reopen closed tab · ${shortcutLabel("app.reopenTab")}`,
      run: async () => {
        const entry = closed.current.pop();
        if (entry) await loadDocument(entry);
      },
    },
    {
      label: "Open terminal",
      run: async () => {
        setTerminalMounted(true);
        state.set({ bottom: "terminal" });
      },
    },
    {
      label: `Quick open · ${shortcutLabel("app.quickOpen")}`,
      run: async () => openQuickOpen(),
    },
    {
      id: "app.recover",
      label: "Recover unsaved files",
      run: async () => {
        if (!state.project) return;
        const { items } = await call(
          { type: "recoveries", scope: state.project.id },
          "items",
        );
        if (!items.length) {
          notice("No acknowledged unsaved checkpoints.");
          return;
        }
        for (const item of items) await loadDocument(item.id);
      },
    },
    {
      label: "Refresh files and Git",
      run: async () => {
        await reconcileDocuments();
        window.dispatchEvent(new Event("workspace-refresh"));
      },
    },
    {
      label: "Settings and diagnostics",
      run: async () => setSettingsOpen(true),
    },
  ];
  const active = state.tabs.find((t) => t.id === state.active);
  commandActions.current = new Map(
    commands
      .filter((command) => "id" in command && command.id)
      .map((command) => [command.id!, command.run]),
  );
  if (startupIssue)
    return (
      <main className="welcome startup-repair">
        <h1>Repair application preferences</h1>
        <p>{startupIssue}</p>
        <p>
          Restore uses the last validated settings backup. Reset clears
          preferences and remembered trust, while keeping editor recovery and
          project files.
        </p>
        <NotificationToast />
        <div className="toolbar">
          {[true, false].map((restore) => (
            <RepairPreferencesButton
              key={String(restore)}
              onClick={() =>
                void perform(async () => {
                  if (
                    !(await ask({
                      title: restore
                        ? "Restore previous preferences"
                        : "Reset preferences",
                      description:
                        "Replace preferences only? A copy of the current file and all editor recovery files will be retained. No project or terminal will start automatically.",
                      choices: [
                        restore ? "Restore backup" : "Reset preferences",
                      ],
                    }))
                  )
                    return;
                  const result = await call(
                    { type: "repairSettings", restore_backup: restore },
                    "bootstrap",
                  );
                  useApp.getState().set({
                    settings: result.settings,
                    notice:
                      "Preferences repaired. Retained state copies and editor recovery are available in application data.",
                  });
                  setStartupIssue(result.startup_issue);
                })
              }
            >
              {restore ? "Restore previous preferences" : "Reset preferences"}
            </RepairPreferencesButton>
          ))}
        </div>
        <DialogHost />
      </main>
    );
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img
            className="brand-mark"
            src={workspaceIcon}
            srcSet={`${workspaceIcon1x} 1x, ${workspaceIcon} 2x, ${workspaceIcon3x} 3x`}
            alt="Workspace"
            width={24}
            height={24}
            draggable={false}
          />
        </div>
        <button onClick={() => void perform(() => openProject())}>
          <FolderOpen size={16} />
          Open folder
        </button>
        <select
          aria-label="Recent projects"
          value={state.project?.root ?? ""}
          onChange={(e) => {
            if (e.target.value) void perform(() => openProject(e.target.value));
          }}
        >
          <option value="">Recent projects</option>
          {state.settings?.recent.map((p) => (
            <option value={p.root} key={p.id}>
              {p.name} · {p.root}
            </option>
          ))}
        </select>
        <div className="header-spacer" />
        <button onClick={openQuickOpen} disabled={!state.project}>
          <Search size={15} />
          Quick open <kbd>{shortcutLabel("app.quickOpen")}</kbd>
        </button>
        <button
          aria-label="Command palette"
          title={`Command palette · ${shortcutLabel("app.commandPalette")}`}
          onClick={() => setPalette("commands")}
        >
          <Command size={16} />
        </button>
        <button aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon size={17} />
        </button>
      </header>
      <NotificationToast />
      {state.project && !state.project.trusted && (
        <div className="trust-banner">
          <span>
            Restricted project · {state.project.root}. Tools and saves require
            trust.
          </span>
          <button
            onClick={() =>
              void perform(async () => {
                if (
                  !(await ask({
                    title: "Trust this folder",
                    description:
                      "Git configuration, hooks and terminal tools may execute code with local permissions. Trust only projects you recognize.",
                    choices: ["Trust folder"],
                  }))
                )
                  return;
                const { project } = await call(
                  { type: "trust", scope: state.project!.id, trusted: true },
                  "project",
                );
                state.set({ project });
                window.dispatchEvent(new Event("workspace-refresh"));
              })
            }
          >
            Trust folder
          </button>
        </div>
      )}
      {!state.project ? (
        <main className="welcome">
          <span className="welcome-icon">
            <FolderOpen size={42} />
          </span>
          <h1>Open a folder. Make something.</h1>
          <p>Files, terminals, review and Git in one local workspace.</p>
          <button
            className="primary"
            onClick={() => void perform(() => openProject())}
          >
            Open local folder
          </button>
          <div className="recent-projects">
            {state.settings?.recent.slice(0, 8).map((p) => (
              <button
                key={p.id}
                onClick={() => void perform(() => openProject(p.root))}
              >
                <strong>{p.name}</strong>
                <span className="muted">{p.root}</span>
              </button>
            ))}
          </div>
          <p className="muted">
            Git and terminal programs are optional for opening and editing
            files.
          </p>
        </main>
      ) : (
        <div className="workspace">
          <nav className="activity-bar" aria-label="Tool windows">
            <button
              title="Project files"
              aria-label="Project files"
              onClick={() => {
                setExplorerSearch(false);
                showPanel("explorer");
              }}
            >
              <Files size={20} />
            </button>
            <button
              title="Git"
              aria-label="Changes"
              onClick={() => state.set({ bottom: "changes" })}
            >
              <GitBranch size={20} />
            </button>
            <button
              title="Search in explorer"
              aria-label="Search project"
              onClick={() => state.set({ bottom: "search" })}
            >
              <Search size={20} />
            </button>
            <button
              title="Terminal"
              aria-label="Terminal"
              onClick={() => {
                setTerminalMounted(true);
                state.set({ bottom: "terminal" });
              }}
            >
              <TerminalSquare size={20} />
            </button>
            <div className="header-spacer" />
            <button
              aria-label="Refresh workspace"
              title="Refresh workspace"
              onClick={() =>
                window.dispatchEvent(new Event("workspace-refresh"))
              }
            >
              <RefreshCw size={16} />
            </button>
            <DockLayoutMenu
              layout={dock}
              onChange={setDock}
              secondary={!!state.split}
              onReset={() =>
                setDock(
                  state.split
                    ? revealPanel(defaultDock(), "editorSecondary")
                    : defaultDock(),
                )
              }
            />
          </nav>
          {!uiReady && (
            <div className="empty" role="status">
              {uiError ? (
                <>
                  <p>{uiError}</p>
                  <button
                    onClick={() =>
                      void perform(() => openProject(undefined, true))
                    }
                  >
                    Retry workspace restore
                  </button>
                </>
              ) : (
                "Restoring workspace…"
              )}
            </div>
          )}
          {uiReady && (
            <DockWorkspace
              key={state.project.id}
              layout={dock}
              onChange={setDock}
              panels={{
                explorer: (
                  <ProjectExplorer
                    search={explorerSearch}
                    onMode={setExplorerSearch}
                  />
                ),
                editor: (
                  <div className="editor-area">
                    <div
                      className="tab-bar"
                      role="tablist"
                      aria-label="Workspace tabs"
                      onKeyDown={(e) => {
                        if (!(e.target as HTMLElement).closest('[role="tab"]'))
                          return;
                        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                        if (!keys.includes(e.key)) return;
                        e.preventDefault();
                        const index = state.tabs.findIndex(
                          (t) =>
                            t.id ===
                            (e.target as HTMLElement).closest<HTMLElement>(
                              "[data-editor-tab]",
                            )?.dataset.editorTab,
                        );
                        const next =
                          e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? state.tabs.length - 1
                              : (index +
                                  (e.key === "ArrowRight"
                                    ? 1
                                    : state.tabs.length - 1)) %
                                state.tabs.length;
                        state.set({ active: state.tabs[next]?.id ?? null });
                        const tabs =
                          e.currentTarget.querySelectorAll<HTMLElement>(
                            '[role="tab"]',
                          );
                        tabs[next]?.focus();
                      }}
                    >
                      <EditorTabs
                        tabs={state.tabs}
                        active={state.active}
                        onClose={closeTab}
                      />
                      <div className="header-spacer" />
                      {!(
                        state.settings?.autoSaveIdle ||
                        state.settings?.autoSaveOnFocusLoss
                      ) && (
                        <button
                          title="Save file"
                          aria-label="Save file"
                          disabled={!activeDoc || !activeDoc.dirty}
                          onClick={() =>
                            void perform(() => saveDocument(state.active!))
                          }
                        >
                          <Save size={15} />
                        </button>
                      )}
                      <button
                        title="Split editor"
                        aria-label="Split editor"
                        disabled={active?.kind !== "editor"}
                        onClick={() =>
                          state.set({
                            split: state.split ? null : state.active,
                          })
                        }
                      >
                        <Columns2 size={15} />
                      </button>
                    </div>
                    {activeDoc?.recoveryError && (
                      <div className="editor-warning" role="alert">
                        Recovery is not current: {activeDoc.recoveryError}
                        <button
                          onClick={() =>
                            void perform(() => checkpoint(activeDoc.id))
                          }
                        >
                          Retry checkpoint
                        </button>
                      </div>
                    )}
                    {activeDoc?.saveError && (
                      <div className="editor-warning" role="alert">
                        File not saved: {activeDoc.saveError}
                        <button
                          onClick={() =>
                            void perform(() => saveDocument(activeDoc.id))
                          }
                        >
                          Retry save
                        </button>
                      </div>
                    )}
                    {activeDoc?.metadata && (
                      <MetadataWarning
                        key={activeDoc.id}
                        document={activeDoc}
                      />
                    )}
                    {activeDoc?.readonly && !activeDoc.metadata && (
                      <div className="editor-warning">{activeDoc.readonly}</div>
                    )}
                    {activeDoc?.recovering && (
                      <div className="editor-warning">
                        Recovered acknowledged unsaved checkpoint. Review before
                        saving.
                        <button
                          disabled={!state.project?.trusted}
                          onClick={() =>
                            void perform(async () => {
                              const project = useApp.getState().project;
                              const handle = models.get(activeDoc.id);
                              if (!project || !handle) return;
                              const name = await ask({
                                title: "Save recovery as a UTF-8 copy",
                                description:
                                  "Create a new file in the project root containing the current recovered text. Existing files are never overwritten; the original checkpoint is retained.",
                                input: `recovered-${activeDoc.name}`,
                              });
                              if (!name) return;
                              const text = handle.model.getValue();
                              const { entries } = await call(
                                {
                                  type: "create",
                                  scope: project.id,
                                  parent: null,
                                  name,
                                  directory: false,
                                },
                                "entries",
                              );
                              const created = entries.find(
                                (entry) => entry.name === name,
                              );
                              if (!created)
                                throw new Error(
                                  "Copy was created but could not be opened; refresh the explorer. The original recovery remains retained.",
                                );
                              await loadDocument(created.id);
                              models.get(created.id)!.model.setValue(text);
                              await saveDocument(created.id);
                              window.dispatchEvent(
                                new Event("workspace-refresh"),
                              );
                              notice(
                                "Recovered UTF-8 copy saved. Review or explicitly discard the original checkpoint separately.",
                              );
                            })
                          }
                        >
                          Save a copy
                        </button>
                      </div>
                    )}
                    {activeDoc?.conflict && (
                      <div className="editor-warning">
                        <button
                          onClick={() =>
                            void perform(async () => {
                              const { diff } = await call(
                                {
                                  type: "documentCompare",
                                  scope: state.project!.id,
                                  document: activeDoc.id,
                                },
                                "diff",
                              );
                              const id = `conflict:${activeDoc.id}`;
                              useApp.setState((s) => ({
                                tabs: [
                                  ...s.tabs.filter((t) => t.id !== id),
                                  {
                                    id,
                                    kind: "conflict",
                                    diff,
                                    title: `Conflict · ${activeDoc.name}`,
                                  },
                                ],
                                active: id,
                              }));
                            })
                          }
                        >
                          Compare three versions
                        </button>
                        Disk changed while this buffer is dirty. Recovery is
                        retained. Save will refuse a stale baseline.
                        <button
                          onClick={() =>
                            void perform(async () => {
                              if (
                                await ask({
                                  title: "Keep disk version",
                                  description:
                                    "Explicitly discard the local buffer and its recovery after reviewing your changes.",
                                  choices: ["Keep disk"],
                                })
                              ) {
                                await rpc({
                                  type: "discard",
                                  scope: state.project!.id,
                                  document: activeDoc.id,
                                });
                                disposeModel(activeDoc.id);
                                await loadDocument(activeDoc.entry);
                              }
                            })
                          }
                        >
                          Discard local after review
                        </button>
                      </div>
                    )}
                    <div className="editor-row">
                      <Suspense
                        fallback={
                          <div className="empty-state">Loading editor…</div>
                        }
                      >
                        <div className="main-editor">
                          {active?.kind === "media" ? (
                            <MediaPreview
                              key={active.instance}
                              media={active.media}
                            />
                          ) : active?.kind === "editor" ? (
                            <Editor entry={active.entry} />
                          ) : active?.kind === "diff" ? (
                            <DiffEditor
                              diff={active.diff}
                              staged={active.staged}
                            />
                          ) : active?.kind === "gitConflict" ? (
                            <GitConflictEditor conflict={active.conflict} />
                          ) : active?.kind === "conflict" ? (
                            <ConflictEditor diff={active.diff} />
                          ) : (
                            <div className="empty-state">
                              <h2>{state.project.name}</h2>
                              <p>
                                Open a file, use a terminal, or review changes.
                              </p>
                              <button
                                onClick={() => {
                                  setTerminalMounted(true);
                                  state.set({ bottom: "terminal" });
                                }}
                              >
                                Open terminal
                              </button>
                              <button onClick={openQuickOpen}>
                                Quick open
                              </button>
                            </div>
                          )}
                        </div>
                      </Suspense>
                    </div>
                  </div>
                ),
                editorSecondary: state.split ? (
                  <div className="split-editor">
                    <div className="toolbar">
                      <label>
                        Second editor
                        <select
                          aria-label="Second editor file"
                          value={state.split}
                          onChange={(e) => state.set({ split: e.target.value })}
                        >
                          {state.tabs
                            .filter((t) => t.kind === "editor")
                            .map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        aria-label="Close second editor"
                        onClick={() => state.set({ split: null })}
                      >
                        Close split
                      </button>
                    </div>
                    <Suspense fallback="Loading editor…">
                      <Editor entry={state.split} group="secondary" />
                    </Suspense>
                  </div>
                ) : null,
                git: <GitToolWindow />,
                terminal: terminalMounted ? (
                  <Suspense fallback="Loading terminal…">
                    <Terminal key={state.project.id} />
                  </Suspense>
                ) : null,
                output: <OperationOutput />,
              }}
            />
          )}
        </div>
      )}
      <StatusBar />
      <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <ModalContent className="dialog-content wide">
            <Dialog.Title>Workspace settings</Dialog.Title>
            <Dialog.Description>
              Local preferences, installed tools and diagnostics.
            </Dialog.Description>
            <Suspense fallback="Loading settings…">
              <SettingsPanel />
            </Suspense>
            <Dialog.Close className="dialog-close" aria-label="Close settings">
              <X size={16} />
            </Dialog.Close>
          </ModalContent>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={palette !== null}
        onOpenChange={(open) => {
          if (!open) setPalette(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <ModalContent className="dialog-content palette">
            <Dialog.Title>
              {palette === "files" ? "Quick open" : "Command palette"}
            </Dialog.Title>
            <Dialog.Description>
              {palette === "files"
                ? "Type a file name. Use ↑/↓ to choose, Enter to open, Escape to close."
                : "Keyboard shortcuts use Command on macOS and Control on other systems."}
            </Dialog.Description>
            {palette === "files" ? (
              <SearchPanel
                names
                initialQuery={fileQuery}
                onOpened={() => setPalette(null)}
              />
            ) : (
              <>
                <input
                  aria-label="Filter commands"
                  autoFocus
                  value={commandFilter}
                  onChange={(e) => setCommandFilter(e.target.value)}
                />
                {commands
                  .filter((c) =>
                    c.label.toLowerCase().includes(commandFilter.toLowerCase()),
                  )
                  .map((c) => (
                    <button
                      className="command-option"
                      key={c.label}
                      onClick={() => {
                        setPalette(null);
                        void perform(c.run);
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
              </>
            )}
          </ModalContent>
        </Dialog.Portal>
      </Dialog.Root>
      <DialogHost />
    </div>
  );
}
