import * as Menu from "@radix-ui/react-dropdown-menu";
import { memo } from "react";
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  Folder,
  File,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Ellipsis,
  Crosshair,
  ChevronDown as MenuArrow,
} from "lucide-react";
import type { Entry } from "../../generated/protocol";
import { call, rpc } from "../../shared/ipc/client";
import { useApp, perform, notice } from "../../shared/state/store";
import { fileDragMime, readFileDrag } from "./fileDrag";
import type { DragEvent } from "react";
import { VirtualList } from "../../shared/components/VirtualList";
import { ask } from "../../shared/components/Dialog";
import { FilePathMenuItems } from "../../shared/components/FilePathMenu";
import { activeFileEntry, tabEntry } from "../../shared/fileTargets";
import { closeAffectedEntry } from "./closeAffected";
import { useDockVisible } from "../workspace/DockWorkspace";
import {
  useGitDecorations,
  gitLabels,
  decorationLabel,
} from "./gitDecorations";
import { loadDocument } from "../editor/models";
function Explorer({ active = true }: { active?: boolean }) {
  const visible = useDockVisible();
  const project = useApp((s) => s.project);
  const editorEntry = useApp((s) =>
    tabEntry(s.tabs.find((tab) => tab.id === s.active)),
  );
  const [children, setChildren] = useState<Record<string, Entry[]>>({});
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const revealEpoch = useRef(0);
  const revealing = useRef(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const revealComplete = useCallback(() => setRevealId(null), []);
  useEffect(() => {
    revealing.current = false;
    setRevealBusy(false);
    setRevealId(null);
    return () => {
      revealEpoch.current++;
    };
  }, [project?.id]);
  const expandedIds = useApp((s) => s.explorerExpanded);
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
  const setExpanded = (
    update: Set<string> | ((old: Set<string>) => Set<string>),
  ) =>
    useApp.setState((s) => ({
      explorerExpanded: [
        ...(typeof update === "function"
          ? update(new Set(s.explorerExpanded))
          : update),
      ],
    }));
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [selected, setSelected] = useState<Entry | null>(null);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const dragging = useRef<Entry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const load = useCallback(
    async (parent: string | null) => {
      if (!project || useApp.getState().project?.id !== project.id) return;
      const r = await call(
        { type: "list", scope: project.id, parent },
        "entries",
      );
      if (useApp.getState().project?.id !== project.id) return;
      setChildren((c) => ({ ...c, [parent ?? "root"]: r.entries }));
      if (r.truncated)
        useApp.getState().set({
          notice:
            "Directory display capped at 10,000 entries. Use Quick open to narrow results.",
        });
    },
    [project?.id],
  );
  useEffect(() => {
    setChildren({});
    setSelected(null);
    void perform(async () => {
      await load(null);
      for (const id of expandedRef.current) {
        try {
          await load(id);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "notFound"
          )
            useApp.setState((s) => ({
              explorerExpanded: s.explorerExpanded.filter(
                (entry) => entry !== id,
              ),
            }));
          else throw error;
        }
      }
    });
    const refresh = () =>
      void perform(async () => {
        await load(null);
        for (const id of expandedRef.current) await load(id);
      });
    window.addEventListener("workspace-refresh", refresh);
    return () => window.removeEventListener("workspace-refresh", refresh);
  }, [load]);
  const { rows, parents, paths } = useMemo(() => {
    const rows: { entry: Entry; depth: number }[] = [];
    const parents = new Map<string, string>(),
      paths = new Map<string, string>();
    for (const [parent, entries] of Object.entries(children))
      for (const entry of entries) {
        parents.set(entry.id, parent);
        paths.set(entry.id, entry.path);
      }
    const walk = (key: string, depth: number) => {
      for (const entry of children[key] ?? []) {
        rows.push({ entry, depth });
        if (expanded.has(entry.id)) walk(entry.id, depth + 1);
      }
    };
    walk("root", 0);
    return { rows, parents, paths };
  }, [children, expanded]);
  const entries = useMemo(() => Object.values(children).flat(), [children]);
  const [visibleEntries, setVisibleEntries] = useState<Entry[]>([]);
  const showEntries = useCallback((rows: { entry: Entry }[]) => {
    const next = rows.map((row) => row.entry);
    setVisibleEntries((old) =>
      old.length === next.length &&
      old.every((entry, index) => entry.id === next[index].id)
        ? old
        : next,
    );
  }, []);
  const decorations = useGitDecorations(
    entries,
    parents,
    active && visible,
    visibleEntries,
  );
  const selectedParent = selected ? parents.get(selected.id) : undefined;
  const parent =
    selected?.kind === "directory"
      ? selected.id
      : selectedParent && selectedParent !== "root"
        ? selectedParent
        : null;
  const location = parent
    ? (paths.get(parent) ?? "selected folder")
    : "project root";
  const focusTree = () =>
    document
      .querySelector<HTMLElement>('.explorer [aria-label="Project tree"]')
      ?.focus();
  const cancelReveal = () => {
    revealEpoch.current++;
    revealing.current = false;
    setRevealBusy(false);
    setRevealId(null);
  };
  async function revealActive() {
    const entry = activeFileEntry();
    if (!project || !entry || revealing.current) return;
    const scope = project.id,
      ticket = ++revealEpoch.current;
    const current = () =>
      ticket === revealEpoch.current &&
      useApp.getState().project?.id === scope &&
      activeFileEntry() === entry;
    revealing.current = true;
    setRevealBusy(true);
    try {
      const response = await call(
        { type: "revealEntry", scope, entry },
        "entries",
      );
      if (!current()) return;
      const chain = response.entries;
      const target = chain.at(-1);
      if (!target)
        throw new Error("This file could not be located in the project.");
      const loaded: Record<string, Entry[]> = {};
      for (let index = 0; index < chain.length; index++) {
        const parent = index ? chain[index - 1].id : null,
          key = parent ?? "root";
        const next = chain[index];
        let entries = childrenRef.current[key];
        if (!entries?.some((item) => item.id === next.id)) {
          const listed = await call({ type: "list", scope, parent }, "entries");
          if (!current()) return;
          entries = listed.entries;
          if (!entries.some((item) => item.id === next.id)) {
            if (!listed.truncated)
              throw new Error(
                "The file moved or was removed. Refresh Explorer and try again.",
              );
            entries = [...entries, next].sort(
              (a, b) =>
                Number(b.kind === "directory") -
                  Number(a.kind === "directory") ||
                (a.name.toLowerCase() < b.name.toLowerCase()
                  ? -1
                  : a.name.toLowerCase() > b.name.toLowerCase()
                    ? 1
                    : 0),
            );
          }
        }
        loaded[key] = entries;
      }
      if (!current()) return;
      setChildren((old) => ({ ...old, ...loaded }));
      setExpanded(
        (old) =>
          new Set([...old, ...chain.slice(0, -1).map((item) => item.id)]),
      );
      setSelected(target);
      setRevealId(target.id);
    } finally {
      if (ticket === revealEpoch.current) {
        revealing.current = false;
        setRevealBusy(false);
      }
    }
  }
  async function create(directory: boolean) {
    if (!project) return;
    const result = { entries: [] as Entry[] };
    const name = await ask({
      returnFocus: document.querySelector<HTMLElement>(
        '.explorer [aria-label="Project tree"]',
      ),
      title: directory ? "New folder" : "New file",
      description: `Create in ${location}`,
      inputLabel: "Name",
      input: "",
      choices: ["Create"],
      submit: async (name) => {
        result.entries = (
          await call(
            { type: "create", scope: project.id, parent, name, directory },
            "entries",
          )
        ).entries;
      },
    });
    if (!name) {
      focusTree();
      return;
    }
    setChildren((old) => ({ ...old, [parent ?? "root"]: result.entries }));
    if (parent) setExpanded((old) => new Set(old).add(parent));
    const created = result.entries.find((entry) => entry.name === name);
    if (created) {
      setSelected(created);
      if (!directory) await loadDocument(created.id);
    }
  }
  async function closeAffected(entry: Entry) {
    return project ? closeAffectedEntry(project.id, entry) : false;
  }
  async function rename(move: boolean) {
    if (!project || !selected) return;
    let target: string | null;
    if (move) {
      const directories = rows.filter(
        (r) => r.entry.kind === "directory" && r.entry.id !== selected.id,
      );
      const choice = await ask({
        returnFocus: document.querySelector<HTMLElement>(
          '.explorer [aria-label="Project tree"]',
        ),
        title: "Move file or directory",
        description:
          "Choose a loaded destination directory. Expand a directory first to make it available.",
        choices: [
          "Project root",
          ...directories.slice(0, 20).map((r) => r.entry.path),
        ],
      });
      if (!choice) return;
      target =
        directories.find((r) => r.entry.path === choice)?.entry.id ?? null;
    } else {
      const found = Object.entries(children).find(([, entries]) =>
        entries.some((e) => e.id === selected.id),
      );
      target = found && found[0] !== "root" ? found[0] : null;
    }
    const name = await ask({
      returnFocus: document.querySelector<HTMLElement>(
        '.explorer [aria-label="Project tree"]',
      ),
      title: move ? "Move destination name" : "Rename",
      description:
        "Existing destinations are never overwritten. Save/close open files before moving them.",
      input: selected.name,
      inputLabel: "Name",
      choices: [move ? "Move" : "Rename"],
      submit: async (name) => {
        const { entries } = await call(
          { type: "list", scope: project.id, parent: target },
          "entries",
        );
        if (
          entries.some(
            (entry) => entry.name === name && entry.id !== selected.id,
          )
        )
          throw new Error(
            `“${name}” already exists in the destination folder. Choose a different name.`,
          );
      },
    });
    if (!name || !(await closeAffected(selected))) return;
    const result = await call(
      {
        type: "rename",
        scope: project.id,
        entry: selected.id,
        parent: target,
        name,
      },
      "entries",
    );
    const moved = result.entries.find((e) => e.name === name);
    setSelected(moved ?? null);
    if (selected.kind === "file" && moved) await loadDocument(moved.id);
    setChildren({});
    setExpanded(new Set());
    await load(null);
  }
  function dragOver(event: DragEvent, destination: Entry | null) {
    if (!dragging.current || (destination && destination.kind !== "directory"))
      return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const target = destination?.id ?? "root";
    if (dropTarget !== target) {
      setDropTarget(target);
      clearTimeout(hover.current);
      if (destination && !expanded.has(destination.id))
        hover.current = setTimeout(
          () =>
            void perform(async () => {
              await load(destination.id);
              setExpanded((old) => new Set(old).add(destination.id));
            }),
          650,
        );
    }
  }
  function dropEntry(event: DragEvent, destination: Entry | null) {
    if (!project) return;
    const payload = readFileDrag(
      event.dataTransfer.getData(fileDragMime),
      project.id,
    );
    const source = dragging.current;
    if (!payload || !source || source.id !== payload.id) return;
    event.preventDefault();
    event.stopPropagation();
    dragging.current = null;
    setDropTarget(null);
    clearTimeout(hover.current);
    void perform(async () => {
      const parent = destination?.id ?? null;
      const currentParent =
        Object.entries(children).find(([, entries]) =>
          entries.some((entry) => entry.id === source.id),
        )?.[0] ?? "root";
      if ((parent ?? "root") === currentParent) return;
      if (
        source.id === parent ||
        (source.kind === "directory" &&
          destination?.path.startsWith(
            source.path + (navigator.platform.includes("Win") ? "\\" : "/"),
          ))
      )
        throw new Error("A folder cannot be moved inside itself.");
      const wasOpen = !!useApp.getState().docs[source.id];
      if (!(await closeAffected(source))) return;
      const { entries } = await call(
        { type: "moveEntry", scope: project.id, entry: source.id, parent },
        "entries",
      );
      const moved = entries.find((entry) => entry.name === source.name);
      const nextExpanded = new Set(expandedRef.current);
      for (const row of rows)
        if (
          row.entry.id === source.id ||
          row.entry.path.startsWith(
            source.path + (navigator.platform.includes("Win") ? "\\" : "/"),
          )
        )
          nextExpanded.delete(row.entry.id);
      if (destination) nextExpanded.add(destination.id);
      setSelected(moved ?? null);
      setChildren({});
      setExpanded(nextExpanded);
      await load(null);
      for (const id of nextExpanded) await load(id);
      if (source.kind === "file" && wasOpen && moved)
        await loadDocument(moved.id);
      window.dispatchEvent(new Event("workspace-refresh"));
    });
  }
  async function removeSelected() {
    if (!project || !selected) return;
    const target = selected,
      scope = project.id;
    if (
      !(await ask({
        returnFocus: document.querySelector<HTMLElement>(
          '.explorer [aria-label="Project tree"]',
        ),
        title:
          target.kind === "directory"
            ? "Delete folder and its contents?"
            : "Delete file?",
        description:
          target.kind === "directory"
            ? `Move “${target.path}” and everything inside it to private recovery. Use Restore deleted file or folder to bring it back.`
            : `Delete “${target.path}”. Files up to 20 MiB are retained in private recovery.`,
        choices: ["Delete"],
      }))
    )
      return;
    if (!(await closeAffectedEntry(scope, target))) return;
    await rpc({ type: "delete", scope, entry: target.id });
    if (useApp.getState().project?.id !== scope) return;
    const removed = new Set(
      entries
        .filter(
          (entry) =>
            entry.id === target.id ||
            (target.kind === "directory" &&
              entry.path.startsWith(
                target.path + (navigator.platform.includes("Win") ? "\\" : "/"),
              )),
        )
        .map((entry) => entry.id),
    );
    setSelected(null);
    setChildren((old) =>
      Object.fromEntries(
        Object.entries(old)
          .filter(([parent]) => !removed.has(parent))
          .map(([parent, children]) => [
            parent,
            children.filter((entry) => !removed.has(entry.id)),
          ]),
      ),
    );
    setExpanded((old) => new Set([...old].filter((id) => !removed.has(id))));
    window.dispatchEvent(new Event("workspace-refresh"));
    notice(
      target.kind === "directory"
        ? "Folder and its contents moved to private recovery. Use Restore deleted file or folder to restore it."
        : "File deleted. Its recovery copy is available in Restore deleted file or folder.",
    );
  }
  async function selectRepository() {
    if (!project || !selected) return;
    await rpc({
      type: "gitStatus",
      scope: project.id,
      repository: selected.id,
    });
    window.dispatchEvent(new Event("workspace-refresh"));
    useApp.getState().set({ bottom: "changes" });
  }
  async function toggleFolder(entry: Entry) {
    if (expandedRef.current.has(entry.id))
      setExpanded((old) => {
        const next = new Set(old);
        next.delete(entry.id);
        return next;
      });
    else {
      await load(entry.id);
      setExpanded((old) => new Set(old).add(entry.id));
    }
  }
  const actionItems = (includeNew = false) => (
    <>
      {includeNew && (
        <>
          <Menu.Item
            disabled={!project?.trusted}
            onSelect={() => void perform(() => create(false))}
          >
            New file…
          </Menu.Item>
          <Menu.Item
            disabled={!project?.trusted}
            onSelect={() => void perform(() => create(true))}
          >
            New folder…
          </Menu.Item>
          <Menu.Separator />
        </>
      )}
      <Menu.Item
        disabled={!selected || !project?.trusted}
        onSelect={() => void perform(() => rename(false))}
      >
        Rename…
      </Menu.Item>
      <Menu.Item
        disabled={!selected || !project?.trusted}
        onSelect={() => void perform(() => rename(true))}
      >
        Move to folder…
      </Menu.Item>
      <Menu.Item
        disabled={!selected || !project?.trusted}
        onSelect={() => void perform(removeSelected)}
      >
        Delete…
      </Menu.Item>
      <Menu.Separator />
      <FilePathMenuItems entry={selected?.id ?? null} />
      <Menu.Separator />
      <Menu.Item
        disabled={
          !selected || selected.kind !== "directory" || !project?.trusted
        }
        onSelect={() => void perform(selectRepository)}
      >
        Use folder as Git repository
      </Menu.Item>
    </>
  );
  useEffect(() => {
    const command = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id.startsWith("explorer.")) return;
      event.preventDefault();
      if (!project?.trusted && id !== "explorer.refresh") {
        notice("Trust the workspace before changing files.");
        return;
      }
      switch (id) {
        case "explorer.newFile":
          void perform(() => create(false));
          break;
        case "explorer.newFolder":
          void perform(() => create(true));
          break;
        case "explorer.rename":
          if (selected) void perform(() => rename(false));
          break;
        case "explorer.move":
          if (selected) void perform(() => rename(true));
          break;
        case "explorer.delete":
          if (selected) void perform(removeSelected);
          break;
        case "explorer.refresh":
          void perform(async () => {
            await load(null);
            window.dispatchEvent(new Event("explorer-git-refresh"));
          });
          break;
      }
    };
    window.addEventListener("workspace-command", command);
    return () => window.removeEventListener("workspace-command", command);
  });
  return (
    <section className="explorer" aria-label="Project files">
      <div
        className={`explorer-toolbar ${dropTarget === "root" ? "drop-target" : ""}`}
        role="toolbar"
        aria-label="File actions"
        data-file-drop="root"
        onDragOver={(event) => dragOver(event, null)}
        onDrop={(event) => dropEntry(event, null)}
        onDragLeave={() => setDropTarget(null)}
      >
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              aria-label="New file or folder"
              title={`Create in ${location}`}
              disabled={!project?.trusted}
            >
              <Plus size={14} />
              New
              <MenuArrow size={12} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="dock-menu explorer-menu" sideOffset={4}>
              <Menu.Item onSelect={() => void perform(() => create(false))}>
                New file…
              </Menu.Item>
              <Menu.Item onSelect={() => void perform(() => create(true))}>
                New folder…
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              aria-label="Selected file actions"
              title={
                selected
                  ? `Actions for ${selected.name}`
                  : "Select a file or folder"
              }
              disabled={!selected}
            >
              <Ellipsis size={14} />
              Actions
              <MenuArrow size={12} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="dock-menu explorer-menu" sideOffset={4}>
              {actionItems()}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <span className="header-spacer" />
        <button
          className="explorer-refresh"
          aria-label="Reveal active file in Explorer"
          title={
            editorEntry
              ? "Select the active editor file in Explorer"
              : "Open a file to reveal it in Explorer"
          }
          disabled={!editorEntry || revealBusy}
          aria-busy={revealBusy}
          onClick={() => void perform(revealActive)}
        >
          <Crosshair size={14} />
        </button>
        <button
          className="explorer-refresh"
          aria-label="Refresh files"
          title="Refresh files"
          onClick={() =>
            void perform(async () => {
              await load(null);
              window.dispatchEvent(new Event("explorer-git-refresh"));
            })
          }
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <Menu.Root
        open={context !== null}
        onOpenChange={(open) => {
          if (!open) setContext(null);
        }}
      >
        <Menu.Trigger asChild>
          <button
            className="explorer-context-anchor"
            aria-label="Context file actions"
            tabIndex={-1}
            style={{ left: context?.x ?? 0, top: context?.y ?? 0 }}
          />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="dock-menu explorer-menu"
            align="start"
            sideOffset={0}
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!document.querySelector('.dialog-content[role="dialog"]'))
                focusTree();
            }}
          >
            {actionItems(true)}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <VirtualList
        items={rows}
        onVisibleItemsChange={showEntries}
        revealIndex={
          revealId
            ? rows.findIndex((row) => row.entry.id === revealId)
            : undefined
        }
        onRevealComplete={revealComplete}
        label="Project tree"
        onContextMenu={({ entry }, point) => {
          cancelReveal();
          setSelected(entry);
          setContext(point);
        }}
        tree={{
          level: (r) => r.depth + 1,
          expanded: (r) =>
            r.entry.kind === "directory" ? expanded.has(r.entry.id) : undefined,
          expand: (r) =>
            void perform(async () => {
              await load(r.entry.id);
              setExpanded((old) => new Set(old).add(r.entry.id));
            }),
          collapse: (r) =>
            setExpanded((old) => {
              const next = new Set(old);
              next.delete(r.entry.id);
              return next;
            }),
          parent: (index) => {
            for (let i = index - 1; i >= 0; i--)
              if (rows[i].depth < rows[index].depth) return i;
            return index;
          },
          focus: (r) => {
            cancelReveal();
            setSelected(r.entry);
          },
        }}
        selected={(r) => r.entry.id === selected?.id}
        render={({ entry, depth }) => (
          <span
            className={`tree-label ${dropTarget === entry.id ? "drop-target" : ""}`}
            draggable={
              !!project?.trusted &&
              (entry.kind === "file" || entry.kind === "directory")
            }
            data-file-entry={entry.id}
            data-file-kind={entry.kind}
            data-git-status={decorations.get(entry.id)?.status}
            onDragStart={(event) => {
              if (!project) return;
              event.stopPropagation();
              dragging.current = entry;
              setSelected(entry);
              if ((event.target as HTMLElement).closest(".tree-toggle")) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "copyMove";
              event.dataTransfer.dropEffect = "move";
              event.dataTransfer.setData(
                fileDragMime,
                JSON.stringify({
                  scope: project.id,
                  id: entry.id,
                  kind: entry.kind,
                }),
              );
            }}
            onDragEnd={() => {
              dragging.current = null;
              setDropTarget(null);
              clearTimeout(hover.current);
            }}
            onDragOver={(event) => {
              if (entry.kind === "directory") dragOver(event, entry);
            }}
            onDragLeave={() => {
              setDropTarget(null);
              clearTimeout(hover.current);
            }}
            onDrop={(event) => {
              if (entry.kind === "directory") dropEntry(event, entry);
            }}
            style={{ paddingLeft: depth * 14 }}
            title={entry.path}
            onDoubleClick={() => {
              if (entry.kind === "directory")
                void perform(() => toggleFolder(entry));
            }}
          >
            {entry.kind === "directory" ? (
              <>
                <button
                  className="tree-toggle"
                  aria-label={`${expanded.has(entry.id) ? "Collapse" : "Expand"} ${entry.name}`}
                  tabIndex={-1}
                  onClick={(event) => {
                    event.stopPropagation();
                    void perform(() => toggleFolder(entry));
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  {expanded.has(entry.id) ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </button>
                <Folder size={14} />
              </>
            ) : (
              <>
                <span className="tree-indent" />
                <File size={14} />
              </>
            )}
            <span
              title={
                decorations.has(entry.id)
                  ? `${entry.path} — ${decorationLabel(decorations.get(entry.id)!)}`
                  : entry.path
              }
            >
              {entry.name}
            </span>
            {decorations.has(entry.id) &&
              gitLabels[decorations.get(entry.id)!.status].badge && (
                <small
                  className="tree-git-status"
                  title={decorationLabel(decorations.get(entry.id)!)}
                  aria-label={decorationLabel(decorations.get(entry.id)!)}
                >
                  {gitLabels[decorations.get(entry.id)!.status].badge}
                </small>
              )}
            {!["file", "directory"].includes(entry.kind) && (
              <small>{entry.kind}</small>
            )}
          </span>
        )}
        onSelect={({ entry }) => {
          cancelReveal();
          setSelected(entry);
          if (entry.kind !== "directory")
            void perform(() => loadDocument(entry.id));
        }}
      />
    </section>
  );
}

export default memo(Explorer);
