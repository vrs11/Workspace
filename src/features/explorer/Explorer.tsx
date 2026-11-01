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
import { useApp, perform, notice, reportError } from "../../shared/state/store";
import {
  prepareRenamedBranch,
  applyRenamedBranch,
  renamedIds,
} from "./renameTree";
import { armFileDrag, startFileDrag, type FileDrop } from "./fileDrag";
import {
  selectEntries,
  selectionRoots,
  type TreeSelection,
  type SelectionGesture,
} from "./selection";
import { errorText } from "../../shared/ipc/client";
import { VirtualList } from "../../shared/components/VirtualList";
import { ask } from "../../shared/components/Dialog";
import { FilePathMenuItems } from "../../shared/components/FilePathMenu";
import { activeFileEntry, tabEntry } from "../../shared/fileTargets";
import { closeAffectedEntry } from "./closeAffected";
import { deleteEntry } from "./deleteEntry";
import { useFilePasteAvailability } from "./useFilePasteAvailability";
import { shortcutLabel } from "../../shared/keymap";
import { useDockVisible } from "../workspace/DockWorkspace";
import {
  useGitDecorations,
  gitLabels,
  decorationLabel,
} from "./gitDecorations";
import { loadDocument, settleModelLoads } from "../editor/models";
function isOpenFile(entry: string) {
  const state = useApp.getState();
  return (
    !!state.docs[entry] ||
    state.tabs.some((tab) => tab.kind === "media" && tab.entry === entry)
  );
}
function Explorer({ active = true }: { active?: boolean }) {
  const visible = useDockVisible();
  const project = useApp((s) => s.project);
  const filePaste = useFilePasteAvailability(
    !!project?.trusted && active && visible,
    project?.id,
  );
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
  const revealScroll = useRef(true);
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
  const [selected, setPrimary] = useState<Entry | null>(null);
  const [selection, setSelection] = useState<TreeSelection>({
    ids: new Set(),
    anchor: null,
  });
  const userSelection = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setSelected = (entry: Entry | null) => {
    setPrimary(entry);
    const next = {
      ids: new Set(entry ? [entry.id] : []),
      anchor: entry?.id ?? null,
    };
    selectionRef.current = next;
    setSelection(next);
  };
  const pending = useRef(false);
  const loadEpoch = useRef(0);
  const renameOwner = useRef<symbol | null>(null);
  const renamingTree = useRef(false);
  const cancelArm = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoverTarget = useRef<string | null>(null);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(hover.current);
      cancelArm.current?.();
    },
    [],
  );
  const load = useCallback(
    async (parent: string | null) => {
      if (
        !project ||
        renamingTree.current ||
        useApp.getState().project?.id !== project.id
      )
        return false;
      const epoch = loadEpoch.current;
      const current = () =>
        epoch === loadEpoch.current &&
        useApp.getState().project?.id === project.id;
      let r;
      try {
        r = await call({ type: "list", scope: project.id, parent }, "entries");
      } catch (error) {
        if (!current()) return false;
        throw error;
      }
      if (!current()) return false;
      setChildren((c) => ({ ...c, [parent ?? "root"]: r.entries }));
      if (r.truncated)
        useApp.getState().set({
          notice:
            "Directory display capped at 10,000 entries. Use Quick open to narrow results.",
        });
      return true;
    },
    [project?.id],
  );
  useEffect(() => {
    const epoch = ++loadEpoch.current;
    renameOwner.current = null;
    renamingTree.current = false;
    pending.current = false;
    setChildren({});
    cancelArm.current?.();
    setSelected(null);
    void perform(async () => {
      if (!(await load(null))) return;
      for (const id of expandedRef.current) {
        if (loadEpoch.current !== epoch) return;
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
    const refresh = (event: Event) =>
      void perform(async () => {
        try {
          const epoch = loadEpoch.current;
          if (!(await load(null))) return;
          for (const id of expandedRef.current) {
            if (loadEpoch.current !== epoch || renamingTree.current) return;
            if (!(await load(id))) return;
          }
        } catch (error) {
          if (
            event instanceof CustomEvent &&
            event.detail === "rename-complete"
          )
            reportError(error, {
              prefix:
                "Renamed successfully, but Explorer could not fully refresh. ",
            });
          else throw error;
        }
      });
    window.addEventListener("workspace-refresh", refresh);
    return () => {
      loadEpoch.current++;
      renameOwner.current = null;
      window.removeEventListener("workspace-refresh", refresh);
    };
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
  const rowEntries = useMemo(() => rows.map((row) => row.entry), [rows]);
  const selectedEntries = entries.filter((entry) =>
    selection.ids.has(entry.id),
  );
  function select(entry: Entry, gesture: SelectionGesture) {
    userSelection.current++;
    cancelReveal();
    const next = selectEntries(
      selectionRef.current,
      rowEntries,
      entry.id,
      gesture,
    );
    selectionRef.current = next;
    setSelection(next);
    setPrimary(
      next.ids.has(entry.id)
        ? entry
        : (entries.find((item) => next.ids.has(item.id)) ?? null),
    );
  }
  const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
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
    revealScroll.current = true;
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
      revealScroll.current = true;
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
    if (!project || !selected || pending.current) return;
    const scope = project.id;
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
      if (selectedEntries.length > 1) {
        await moveEntries(
          selectedEntries,
          entries.find((entry) => entry.id === target) ?? null,
        );
        return;
      }
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
    if (!name || useApp.getState().project?.id !== scope) return;
    if (!move && name === selected.name) return;
    const owner = Symbol("rename");
    renameOwner.current = owner;
    pending.current = true;
    const current = () =>
      renameOwner.current === owner && useApp.getState().project?.id === scope;
    let requested = false;
    let renamed = false;
    try {
      await settleModelLoads();
      if (!current()) return;
      const reopen = isOpenFile(selected.id);
      if (!(await closeAffected(selected)) || !current()) return;
      cancelReveal();
      renamingTree.current = true;
      loadEpoch.current++;
      const cached = childrenRef.current;
      requested = true;
      const result = await call(
        { type: "rename", scope, entry: selected.id, parent: target, name },
        "entries",
      );
      renamed = true;
      if (!current()) return;
      const moved = result.entries.find((entry) => entry.name === name);
      const update = await prepareRenamedBranch(
        cached,
        selected,
        moved,
        target,
        result.entries,
        async (parent) =>
          (await call({ type: "list", scope, parent }, "entries")).entries,
        current,
      );
      if (!update || !current()) return;
      childrenRef.current = applyRenamedBranch(childrenRef.current, update);
      setChildren((old) => applyRenamedBranch(old, update));
      if ([...expandedRef.current].some((id) => update.removed.has(id)))
        setExpanded((old) => {
          const next = renamedIds(old, update);
          expandedRef.current = next;
          return next;
        });
      const ids = renamedIds(selectionRef.current.ids, update);
      const previousAnchor = selectionRef.current.anchor;
      const anchor = previousAnchor
        ? (update.replacements.get(previousAnchor)?.id ?? previousAnchor)
        : null;
      const selection = {
        ids,
        anchor:
          anchor && ids.has(anchor)
            ? anchor
            : (ids.values().next().value ?? null),
      };
      selectionRef.current = selection;
      setSelection(selection);
      setPrimary((old) =>
        old
          ? (update.replacements.get(old.id) ??
            (update.removed.has(old.id) ? null : old))
          : old,
      );
      const tree = document.querySelector<HTMLElement>(
        '.explorer [aria-label="Project tree"]',
      );
      if (tree && document.activeElement === tree) {
        const focused = document
          .getElementById(tree.getAttribute("aria-activedescendant") ?? "")
          ?.querySelector<HTMLElement>("[data-file-entry]")?.dataset.fileEntry;
        const replacement = focused
          ? update.replacements.get(focused)
          : undefined;
        if (replacement) {
          revealScroll.current = false;
          setRevealId(replacement.id);
        }
      }
      if (update.errors.length)
        reportError(update.errors[0], {
          prefix:
            "Renamed successfully, but some expanded folders could not refresh. ",
        });
      else if (!moved)
        notice(
          "Renamed successfully. The item is outside this directory's listing limit; use Quick open to locate it.",
        );
      if (reopen && selected.kind === "file" && moved && current())
        await loadDocument(moved.id);
    } finally {
      if (renameOwner.current === owner) {
        renameOwner.current = null;
        renamingTree.current = false;
        pending.current = false;
        loadEpoch.current++;
        if (requested && useApp.getState().project?.id === scope)
          window.dispatchEvent(
            new CustomEvent("workspace-refresh", {
              detail: renamed ? "rename-complete" : null,
            }),
          );
      }
    }
  }
  function pruneEntries(targets: Entry[]) {
    const separator = navigator.platform.includes("Win") ? "\\" : "/";
    const removed = new Set(
      Object.values(childrenRef.current)
        .flat()
        .filter((entry) =>
          targets.some(
            (target) =>
              entry.id === target.id ||
              (target.kind === "directory" &&
                entry.path.startsWith(target.path + separator)),
          ),
        )
        .map((entry) => entry.id),
    );
    setChildren((old) =>
      Object.fromEntries(
        Object.entries(old)
          .filter(([parent]) => !removed.has(parent))
          .map(([parent, entries]) => [
            parent,
            entries.filter((entry) => !removed.has(entry.id)),
          ]),
      ),
    );
    setExpanded((old) => new Set([...old].filter((id) => !removed.has(id))));
    const ids = new Set(
      [...selectionRef.current.ids].filter((id) => !removed.has(id)),
    );
    const next = {
      ids,
      anchor: ids.has(selectionRef.current.anchor ?? "")
        ? selectionRef.current.anchor
        : (ids.values().next().value ?? null),
    };
    selectionRef.current = next;
    setSelection(next);
    setPrimary((old) => (old && !removed.has(old.id) ? old : null));
  }
  async function moveEntries(sources: Entry[], destination: Entry | null) {
    if (!project || pending.current) return;
    const scope = project.id,
      parent = destination?.id ?? null;
    if (!project.trusted)
      throw new Error("Trust the workspace before moving files.");
    const separator = navigator.platform.includes("Win") ? "\\" : "/";
    const targets = selectionRoots(sources).filter(
      (entry) => (parents.get(entry.id) ?? "root") !== (parent ?? "root"),
    );
    if (!targets.length) return;
    if (
      targets.some(
        (entry) =>
          entry.id === parent ||
          (entry.kind === "directory" &&
            destination?.path.startsWith(entry.path + separator)),
      )
    )
      throw new Error("A folder cannot be moved inside itself.");
    pending.current = true;
    const completed: Entry[] = [];
    try {
      // Check every collision before closing editors or moving the first item.
      const { entries: existing } = await call(
        { type: "list", scope, parent },
        "entries",
      );
      const names = new Set(existing.map((entry) => entry.name));
      for (const target of targets) {
        if (names.has(target.name))
          throw {
            code: "alreadyExists",
            message: `“${destination ? destination.path + separator : ""}${target.name}” already exists in the destination folder. Choose another folder.`,
          };
        names.add(target.name);
      }
      await settleModelLoads();
      const open = new Set(
        targets
          .filter((target) => isOpenFile(target.id))
          .map((target) => target.id),
      );
      for (const target of targets)
        if (!(await closeAffectedEntry(scope, target))) return;
      for (const target of targets) {
        if (useApp.getState().project?.id !== scope) return;
        const result = await call(
          { type: "moveEntry", scope, entry: target.id, parent },
          "entries",
        );
        completed.push(target);
        pruneEntries([target]);
        const moved = result.entries.find(
          (entry) => entry.name === target.name,
        );
        if (open.has(target.id) && target.kind === "file" && moved)
          await loadDocument(moved.id);
      }
      if (destination) setExpanded((old) => new Set(old).add(destination.id));
      notice(
        `${completed.length} item${completed.length === 1 ? "" : "s"} moved.`,
      );
    } catch (error) {
      if (!completed.length) throw error;
      throw Object.assign(
        new Error(
          `${completed.length} item(s) moved; remaining items were kept. ${errorText(error)}`,
        ),
        typeof error === "object" && error !== null ? error : {},
        {
          message: `${completed.length} item(s) moved; remaining items were kept. ${errorText(error)}`,
        },
      );
    } finally {
      pending.current = false;
      if (completed.length && useApp.getState().project?.id === scope)
        window.dispatchEvent(new Event("workspace-refresh"));
    }
  }
  async function copyFiles() {
    if (!project || pending.current) return;
    const targets = selectionRoots(selectedEntries),
      scope = project.id;
    if (!targets.length) return;
    pending.current = true;
    try {
      await rpc({
        type: "copyFiles",
        scope,
        entries: targets.map((entry) => entry.id),
      });
      if (useApp.getState().project?.id === scope)
        notice(`${targets.length} item(s) copied to the system clipboard.`);
    } finally {
      pending.current = false;
    }
  }
  async function pasteFiles() {
    if (!project || pending.current) return;
    const scope = project.id,
      destination = parent,
      ticket = userSelection.current;
    pending.current = true;
    try {
      if (
        !(await filePaste.refresh()) ||
        useApp.getState().project?.id !== scope
      )
        return;

      const result = await call(
        { type: "pasteFiles", scope, parent: destination },
        "fileDrop",
      );
      if (useApp.getState().project?.id !== scope) return;
      await load(destination);
      if (useApp.getState().project?.id !== scope) return;
      if (destination) setExpanded((old) => new Set(old).add(destination));
      if (ticket === userSelection.current && result.entries.length) {
        const next = {
          ids: new Set(result.entries.map((entry) => entry.id)),
          anchor: result.entries[0].id,
        };
        selectionRef.current = next;
        setSelection(next);
        setPrimary(result.entries.at(-1) ?? null);
      }
      notice(
        result.errors.length
          ? result.errors.join("\n")
          : `${result.entries.length} item(s) pasted. Originals were kept.`,
      );
      if (result.entries.length)
        window.dispatchEvent(new Event("workspace-refresh"));
    } finally {
      pending.current = false;
    }
  }
  async function removeSelected() {
    if (!project || pending.current) return;
    const targets = selectionRoots(selectedEntries),
      scope = project.id;
    if (!targets.length) return;
    pending.current = true;
    const completed: Entry[] = [];
    let permanent = 0;
    try {
      const folder = targets.length === 1 && targets[0].kind === "directory";
      if (
        !(await ask({
          returnFocus: document.querySelector<HTMLElement>(
            '.explorer [aria-label="Project tree"]',
          ),
          title:
            targets.length > 1
              ? `Delete ${targets.length} items?`
              : folder
                ? "Delete folder and its contents?"
                : "Delete file?",
          description: `${targets
            .slice(0, 12)
            .map((target) => `“${target.path}”`)
            .join(
              "\n",
            )}${targets.length > 12 ? `\n…and ${targets.length - 12} more items.` : ""}\nItems are retained in private recovery when possible. If recovery is unavailable, you can confirm permanent deletion separately.`,
          choices: ["Delete"],
        }))
      )
        return;
      // Resolve all dirty-buffer decisions before deleting anything.
      for (const target of targets)
        if (!(await closeAffectedEntry(scope, target))) return;
      for (const target of targets) {
        if (useApp.getState().project?.id !== scope) return;
        const result = await deleteEntry(scope, target);
        if (useApp.getState().project?.id !== scope) return;
        if (!result) {
          if (completed.length)
            notice(
              `${completed.length} item(s) deleted; remaining items were kept.`,
            );
          return;
        }
        if (result === "permanent") permanent++;
        completed.push(target);
        pruneEntries([target]);
      }
      notice(
        permanent
          ? `${completed.length} item(s) deleted; ${permanent} permanently.${permanent < completed.length ? " The other items remain in private recovery." : ""}`
          : `${completed.length === 1 ? (folder ? "Folder and its contents moved to private recovery." : "File deleted.") : `${completed.length} items deleted.`} Use Restore deleted file or folder to restore them.`,
      );
    } catch (error) {
      if (!completed.length) throw error;
      throw new Error(
        `${completed.length} item(s) deleted; remaining items were kept. ${errorText(error)}`,
        { cause: error },
      );
    } finally {
      pending.current = false;
      if (completed.length && useApp.getState().project?.id === scope)
        window.dispatchEvent(new Event("workspace-refresh"));
    }
  }
  useEffect(() => {
    const targetEntry = (target: Element | null) => {
      if (!target?.closest(".explorer")) return undefined;
      const row = target.closest<HTMLElement>("[data-file-entry]");
      if (!row)
        return target.closest(".explorer-toolbar, .virtual-list")
          ? null
          : undefined;
      const entry = entries.find((entry) => entry.id === row.dataset.fileEntry);
      if (!entry) return undefined;
      if (entry.kind === "directory") return entry;
      const parentId = parents.get(entry.id);
      return !parentId || parentId === "root"
        ? null
        : entries.find((entry) => entry.id === parentId);
    };
    const hoverFiles = (event: Event) => {
      const detail = (event as CustomEvent<FileDrop>).detail;
      const destination =
        detail.drag && detail.drag.scope !== project?.id
          ? undefined
          : targetEntry(detail.target);
      const id = destination === undefined ? null : (destination?.id ?? "root");
      setDropTarget(id);
      if (hoverTarget.current === id) return;
      hoverTarget.current = id;
      clearTimeout(hover.current);
      if (destination && !expandedRef.current.has(destination.id))
        hover.current = setTimeout(
          () =>
            void perform(async () => {
              if (useApp.getState().project?.id !== project?.id) return;
              await load(destination.id);
              setExpanded((old) => new Set(old).add(destination.id));
            }),
          650,
        );
    };
    const dropFiles = (event: Event) => {
      const detail = (event as CustomEvent<FileDrop>).detail;
      const destination = targetEntry(detail.target);
      if (destination === undefined) return;
      clearTimeout(hover.current);
      setDropTarget(null);
      if (detail.drag && detail.drag.scope === project?.id)
        void perform(() => moveEntries(detail.drag!.entries, destination));
      else if (detail.offer && project)
        void perform(async () => {
          if (pending.current) return;
          pending.current = true;
          const scope = project.id,
            selectionTicket = userSelection.current;
          try {
            const preview = await call(
              { type: "inspectDroppedMove", scope, offer: detail.offer! },
              "entries",
            );
            const parent = destination?.id ?? null;
            const existing = await call(
              { type: "list", scope, parent },
              "entries",
            );
            for (const entry of selectionRoots(preview.entries))
              if (
                existing.entries.some(
                  (item) => item.name === entry.name && item.id !== entry.id,
                )
              )
                throw {
                  code: "alreadyExists",
                  message: `“${entry.name}” already exists in the destination folder. Choose another folder.`,
                };
            for (const entry of selectionRoots(preview.entries))
              if (!(await closeAffectedEntry(scope, entry))) return;
            const result = await call(
              {
                type: "moveDroppedFiles",
                scope,
                offer: detail.offer!,
                parent: destination?.id ?? null,
              },
              "fileDrop",
            );
            if (useApp.getState().project?.id !== scope) return;
            if (destination)
              setExpanded((old) => new Set(old).add(destination.id));
            const next = {
              ids: new Set(result.entries.map((entry) => entry.id)),
              anchor: result.entries[0]?.id ?? null,
            };
            if (
              selectionTicket === userSelection.current &&
              result.entries.length
            ) {
              selectionRef.current = next;
              setSelection(next);
              setPrimary(result.entries.at(-1) ?? null);
            }
            notice(
              result.errors.length
                ? result.errors.join("\n")
                : `${result.entries.length} item(s) moved into the project.`,
            );
          } finally {
            pending.current = false;
            if (useApp.getState().project?.id === scope)
              window.dispatchEvent(new Event("workspace-refresh"));
          }
        });
    };
    window.addEventListener("workspace-file-hover", hoverFiles);
    window.addEventListener("workspace-file-drop", dropFiles);
    return () => {
      window.removeEventListener("workspace-file-hover", hoverFiles);
      window.removeEventListener("workspace-file-drop", dropFiles);
    };
  });
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
      if (await load(entry.id))
        setExpanded((old) => new Set(old).add(entry.id));
    }
  }
  useEffect(() => {
    if (context) void filePaste.refresh();
  }, [context, filePaste.refresh]);
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
        disabled={!selectedEntries.length}
        onSelect={() => void perform(copyFiles)}
        title={shortcutLabel("explorer.copy")}
      >
        Copy
      </Menu.Item>
      <Menu.Item
        disabled={!project?.trusted || !filePaste.available}
        onSelect={() => void perform(pasteFiles)}
        title={shortcutLabel("explorer.paste")}
      >
        Paste
      </Menu.Item>
      <Menu.Separator />
      <Menu.Item
        disabled={selectedEntries.length !== 1 || !project?.trusted}
        onSelect={() => void perform(() => rename(false))}
      >
        Rename…
      </Menu.Item>
      <Menu.Item
        disabled={!selectedEntries.length || !project?.trusted}
        onSelect={() => void perform(() => rename(true))}
      >
        Move to folder…
      </Menu.Item>
      <Menu.Item
        disabled={!selectedEntries.length || !project?.trusted}
        onSelect={() => void perform(removeSelected)}
      >
        Delete…
      </Menu.Item>
      <Menu.Separator />
      <FilePathMenuItems
        entry={selectedEntries.length === 1 ? (selected?.id ?? null) : null}
      />
      <Menu.Separator />
      <Menu.Item
        disabled={
          selectedEntries.length !== 1 ||
          !selected ||
          selected.kind !== "directory" ||
          !project?.trusted
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
      if (
        !project?.trusted &&
        !["explorer.refresh", "explorer.copy"].includes(id)
      ) {
        notice("Trust the workspace before changing files.");
        return;
      }
      switch (id) {
        case "explorer.copy":
          void perform(copyFiles);
          break;
        case "explorer.paste":
          void perform(pasteFiles);
          break;
        case "explorer.newFile":
          void perform(() => create(false));
          break;
        case "explorer.newFolder":
          void perform(() => create(true));
          break;
        case "explorer.rename":
          if (selectedEntries.length === 1) void perform(() => rename(false));
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
    <section
      className="explorer"
      aria-label="Project files"
      onContextMenu={(event) => {
        if (
          (event.target as HTMLElement).closest(
            '[role="treeitem"], [role="menu"]',
          )
        )
          return;
        event.preventDefault();
        setSelected(null);
        setContext({ x: event.clientX, y: event.clientY });
      }}
      onCopy={(event) => {
        if (
          (event.target as HTMLElement).closest(
            "input, textarea, [contenteditable=true]",
          )
        )
          return;
        event.preventDefault();
        void perform(copyFiles);
      }}
      onPaste={(event) => {
        if (
          (event.target as HTMLElement).closest(
            "input, textarea, [contenteditable=true]",
          )
        )
          return;
        event.preventDefault();
        void perform(pasteFiles);
      }}
    >
      <div
        className={`explorer-toolbar ${dropTarget === "root" ? "drop-target" : ""}`}
        role="toolbar"
        aria-label="File actions"
        data-file-drop="root"
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
        <Menu.Root
          onOpenChange={(open) => {
            if (open) void filePaste.refresh();
          }}
        >
          <Menu.Trigger asChild>
            <button
              aria-label="Selected file actions"
              title={
                selected
                  ? `Actions for ${selected.name}`
                  : "File actions and paste into project root"
              }
              disabled={!project}
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
        multiple
        onSelectAll={() => {
          userSelection.current++;
          const next = {
            ids: new Set(rowEntries.map((entry) => entry.id)),
            anchor: selectionRef.current.anchor ?? rowEntries[0]?.id ?? null,
          };
          selectionRef.current = next;
          setSelection(next);
          if (!selected) setPrimary(rowEntries[0] ?? null);
        }}
        items={rows}
        onVisibleItemsChange={showEntries}
        revealIndex={
          revealId
            ? rows.findIndex((row) => row.entry.id === revealId)
            : undefined
        }
        revealScroll={revealScroll.current}
        onRevealComplete={revealComplete}
        label="Project tree"
        onContextMenu={({ entry }, point) => {
          userSelection.current++;
          cancelReveal();
          if (!selectionRef.current.ids.has(entry.id)) setSelected(entry);
          setPrimary(entry);
          setContext(point);
        }}
        tree={{
          level: (r) => r.depth + 1,
          expanded: (r) =>
            r.entry.kind === "directory" ? expanded.has(r.entry.id) : undefined,
          expand: (r) =>
            void perform(async () => {
              if (await load(r.entry.id))
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
          focus: (r, event) => {
            if (!event.metaKey && !event.ctrlKey) select(r.entry, event);
          },
        }}
        selected={(r) => selection.ids.has(r.entry.id)}
        onDoubleClick={({ entry }, event) => {
          if (
            suppressClick.current ||
            event.shiftKey ||
            event.metaKey ||
            event.ctrlKey
          )
            return;
          if (entry.kind === "directory")
            void perform(() => toggleFolder(entry));
          else void perform(() => loadDocument(entry.id));
        }}
        render={({ entry, depth }) => (
          <span
            className={`tree-label ${dropTarget === entry.id ? "drop-target" : ""}`}
            data-file-entry={entry.id}
            data-file-kind={entry.kind}
            data-git-status={decorations.get(entry.id)?.status}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                (event.target as HTMLElement).closest(".tree-toggle")
              )
                return;
              suppressClick.current = false;
              cancelArm.current?.();
              if (
                !selectionRef.current.ids.has(entry.id) &&
                !event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey
              )
                select(entry, plain);
              const scope = project?.id;
              if (!scope || !["file", "directory"].includes(entry.kind)) return;
              // Freeze the pressed selection: refreshes or a late drop response
              // must not change which files cross the native drag threshold.
              const sources = selectionRoots(
                selectionRef.current.ids.has(entry.id)
                  ? Object.values(childrenRef.current)
                      .flat()
                      .filter((item) => selectionRef.current.ids.has(item.id))
                  : [entry],
              );
              cancelArm.current = armFileDrag(event.nativeEvent, () => {
                suppressClick.current = true;
                void perform(() => startFileDrag(scope, sources));
              });
            }}
            style={{ paddingLeft: depth * 14 }}
            title={entry.path}
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
        onSelect={({ entry }, event) => {
          if (suppressClick.current && event.type === "click") {
            suppressClick.current = false;
            return;
          }
          select(entry, event);
          if (
            event.type === "keydown" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            entry.kind !== "directory"
          )
            void perform(() => loadDocument(entry.id));
        }}
      />
    </section>
  );
}

export default memo(Explorer);
