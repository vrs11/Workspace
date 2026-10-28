import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { ModalContent } from "../../shared/components/ModalContent";
import {
  GitBranch,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  Download,
  ChevronDown,
  ChevronRight,
  Plus,
  Archive,
  Info,
  X,
} from "lucide-react";
import { memo } from "react";
import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import type {
  GitStatus,
  Change,
  NamedItem,
  Entry,
} from "../../generated/protocol";
import { useApp, perform, notice } from "../../shared/state/store";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { ask } from "../../shared/components/Dialog";
import { VirtualList } from "../../shared/components/VirtualList";
import { loadDocument } from "../editor/models";
import { saveBeforeAction } from "../editor/autosave";
import { coalesceRefresh } from "../../shared/state/refresh";
export async function openDiff(entry: string, staged: boolean) {
  const project = useApp.getState().project;
  if (!project) return;
  const { diff } = await call(
    { type: "gitDiff", scope: project.id, entry, staged },
    "diff",
  );
  const id = `diff:${entry}:${staged}`;
  useApp.setState((s) => ({
    tabs: [
      ...s.tabs.filter((t) => t.id !== id),
      {
        id,
        kind: "diff",
        diff,
        staged,
        title: `${staged ? "Staged" : "Working"} · ${diff.path}`,
      },
    ],
    active: id,
  }));
}
async function prepareWorkingFiles() {
  await saveBeforeAction();
  return true;
}
function GitPanel({
  history = false,
  active = true,
}: {
  history?: boolean;
  active?: boolean;
}) {
  const project = useApp((s) => s.project);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [items, setItems] = useState<NamedItem[]>([]);
  const [listKind, setListKind] = useState("history");
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [output, setOutput] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [revisionRefs, setRevisionRefs] = useState("");
  const [revisionFiles, setRevisionFiles] = useState<Entry[]>([]);
  const refresh = useMemo(
    () =>
      coalesceRefresh(async () => {
        if (!project?.trusted) {
          setError(
            "Trust the project to run Git. File browsing remains available.",
          );
          return;
        }
        try {
          const r = await call(
            { type: "gitStatus", scope: project.id, repository: null },
            "gitStatus",
          );
          if (useApp.getState().project?.id !== project.id) return;
          setStatus(r.status);
          setError("");
        } catch (e) {
          if (useApp.getState().project?.id !== project.id) return;
          setStatus(null);
          setError(errorText(e));
        }
      }),
    [project],
  );
  useEffect(() => {
    if (!active) return;
    void refresh();
    const run = () => void refresh();
    window.addEventListener("workspace-refresh", run);
    return () => window.removeEventListener("workspace-refresh", run);
  }, [refresh, active]);
  const list = useCallback(
    async (kind: string, page = 0) => {
      if (!project?.trusted) return;
      const r = await call(
        { type: "gitList", scope: project.id, kind, offset: page },
        "items",
      );
      setItems((old) => (page === 0 ? r.items : [...old, ...r.items]));
      setOffset(page);
      setMore(r.more);
    },
    [project],
  );
  useEffect(() => {
    if (history) void perform(() => list(listKind));
  }, [history, list, listKind]);
  const [disabled, setDisabled] = useState(false);
  const pending = useRef(false);
  async function gitPerform(work: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setDisabled(true);
    try {
      await perform(async () => {
        await saveBeforeAction();
        await work();
      });
    } finally {
      pending.current = false;
      setDisabled(false);
    }
  }
  async function stage(c: Change, unstage: boolean) {
    if (!project) return;
    await rpc({ type: "gitStage", scope: project.id, entry: c.entry, unstage });
    await refresh();
  }
  const unstaged =
    status?.changes.filter((c) => c.worktree !== "." || c.index === "?") ?? [];
  const staged =
    status?.changes.filter((c) => ![".", "?"].includes(c.index)) ?? [];
  const [collapsed, setCollapsed] = useState({ working: false, staged: false });
  const [composing, setComposing] = useState(false);
  const [details, setDetails] = useState(false);
  const previousStaged = useRef(0);
  useEffect(() => {
    if (staged.length && !previousStaged.current) setComposing(true);
    if (!staged.length && previousStaged.current && !message.trim())
      setComposing(false);
    previousStaged.current = staged.length;
  }, [staged.length, message]);
  type Kind = "working" | "staged";
  type Row =
    | { type: "group"; kind: Kind; count: number }
    | { type: "file"; kind: Kind; change: Change };
  const groups: { kind: Kind; changes: Change[] }[] = [
    { kind: "working", changes: unstaged },
    { kind: "staged", changes: staged },
  ];
  const rows: Row[] = groups.flatMap(({ kind, changes }) =>
    changes.length
      ? [
          { type: "group" as const, kind, count: changes.length },
          ...(!collapsed[kind]
            ? changes.map((change) => ({ type: "file" as const, kind, change }))
            : []),
        ]
      : [],
  );
  const toggle = (kind: Kind) =>
    setCollapsed((old) => ({ ...old, [kind]: !old[kind] }));
  function showList(kind: string) {
    setListKind(kind);
    void gitPerform(() => list(kind));
  }
  async function network(operation: "fetch" | "pull" | "push") {
    if (!project || !status) return;
    if (operation === "pull" && !(await prepareWorkingFiles())) return;
    if (
      operation !== "fetch" &&
      !(await ask({
        title:
          operation === "push"
            ? "Push reviewed commits"
            : "Pull fast-forward only",
        description: `${status.branch} → ${status.upstream ?? "no upstream configured"}. Repository: ${status.root}`,
        choices: [operation === "push" ? "Push" : "Pull"],
      }))
    )
      return;
    if (operation === "push" && !status.upstream) {
      const { items: remotes } = await call(
        { type: "gitList", scope: project.id, kind: "remotes", offset: 0 },
        "items",
      );
      if (!remotes.length)
        throw new Error(
          "No named remote is configured. Add a remote to this repository before publishing.",
        );
      const remote = await ask({
        title: "Publish branch and set upstream",
        description: `Push ${status.branch} to the selected existing remote. No force push.`,
        choices: remotes.map((remote) => remote.id),
      });
      if (!remote) return;
      const result = await call(
        { type: "gitPublish", scope: project.id, remote },
        "text",
      );
      setOutput(result.text);
      notice(result.text);
      await refresh();
      return;
    }
    const result = await call(
      { type: "gitNetwork", scope: project.id, operation },
      "text",
    );
    setOutput(result.text);
    notice(result.text);
    await refresh();
  }
  async function newBranch() {
    if (!project) return;
    const name = await ask({
      title: "Create and switch branch",
      description:
        "No automatic stash or discard. Unsaved editors must be resolved first.",
      input: "",
    });
    if (!name || !(await prepareWorkingFiles())) return;
    await rpc({ type: "gitBranch", scope: project.id, name, create: true });
    await refresh();
  }
  async function saveStash() {
    if (!project) return;
    const text = await ask({
      title: "Save tracked changes to stash",
      description:
        "Stashes tracked staged/working changes. Untracked files are retained in the working directory.",
      input: "Workspace stash",
    });
    if (text === null || !(await prepareWorkingFiles())) return;
    const result = await call(
      {
        type: "gitStash",
        scope: project.id,
        operation: "save",
        id: null,
        message: text,
      },
      "text",
    );
    setOutput(result.text);
    await refresh();
    await list("stash");
    setListKind("stash");
  }
  async function stageAll() {
    if (
      await ask({
        title: "Stage all listed files",
        description: `${unstaged.length} files will be staged explicitly.`,
        choices: ["Stage all"],
      })
    )
      for (const change of unstaged) await stage(change, false);
  }
  async function commit() {
    if (!project || !status) return;
    if (
      !(await ask({
        title: "Review staged commit",
        description: `${staged.map((change) => change.path).join("\n")}\n\n${message}\n\nOnly the current reviewed index is committed.`,
        choices: ["Commit staged"],
      }))
    )
      return;
    const result = await call(
      {
        type: "gitCommit",
        scope: project.id,
        message,
        reviewed: status.stagedRevision,
      },
      "text",
    );
    setOutput(result.text);
    setMessage("");
    await refresh();
  }
  async function resolveConflict(change: Change) {
    if (!project) return;
    const result = await call(
      { type: "gitConflict", scope: project.id, entry: change.entry },
      "gitConflict",
    );
    await loadDocument(change.entry, false);
    const id = `git-conflict:${change.entry}`;
    useApp.setState((old) => ({
      tabs: [
        ...old.tabs.filter((tab) => tab.id !== id),
        {
          id,
          kind: "gitConflict",
          conflict: result.conflict,
          title: `Resolve: ${change.path}`,
        },
      ],
      active: id,
    }));
  }
  useEffect(() => {
    const command = (event: Event) => {
      if (!active) return;
      const id = (event as CustomEvent<string>).detail;
      if (!id.startsWith("git.")) return;
      event.preventDefault();
      if (!project?.trusted || disabled || !status) {
        notice("Trust the workspace and wait for an available Git repository.");
        return;
      }
      switch (id) {
        case "git.refresh":
          void refresh();
          break;
        case "git.fetch":
          void gitPerform(() => network("fetch"));
          break;
        case "git.pull":
          void gitPerform(() => network("pull"));
          break;
        case "git.push":
          void gitPerform(() => network("push"));
          break;
        case "git.branches":
          showList("branches");
          break;
        case "git.newBranch":
          void gitPerform(newBranch);
          break;
        case "git.stashes":
          showList("stash");
          break;
        case "git.saveStash":
          void gitPerform(saveStash);
          break;
        case "git.details":
          setDetails(true);
          break;
        case "git.commit":
          if (staged.length && message.trim()) void gitPerform(commit);
          else {
            setComposing(true);
            notice("Stage changes and enter a commit message first.");
          }
          break;
      }
    };
    window.addEventListener("workspace-command", command);
    return () => window.removeEventListener("workspace-command", command);
  });
  return (
    <section className="git-panel">
      <div
        className="git-toolbar"
        role="toolbar"
        aria-label="Repository actions"
      >
        <button
          className="git-branch"
          aria-label="Branches"
          title={
            status
              ? `${status.branch} → ${status.upstream ?? "No upstream"}\n${status.root}`
              : "Branches"
          }
          disabled={!status || disabled}
          onClick={() => showList("branches")}
        >
          <GitBranch size={14} />
          <span className="truncate">{status?.branch ?? "Repository"}</span>
        </button>
        <button
          className="git-icon"
          aria-label="Refresh Git"
          title="Refresh Git"
          disabled={disabled}
          onClick={() => void gitPerform(refresh)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="git-icon"
          aria-label="Fetch"
          title="Fetch"
          disabled={!status || disabled}
          onClick={() => void gitPerform(() => network("fetch"))}
        >
          <Download size={14} />
        </button>
        <button
          className="git-icon"
          aria-label="Pull"
          title="Pull (fast-forward only)"
          disabled={!status || disabled}
          onClick={() => void gitPerform(() => network("pull"))}
        >
          <ArrowDown size={14} />
        </button>
        <button
          className="git-icon"
          aria-label="Push"
          title="Push reviewed commits"
          disabled={!status || disabled}
          onClick={() => void gitPerform(() => network("push"))}
        >
          <ArrowUp size={14} />
        </button>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button
              className="git-icon"
              aria-label="Git actions"
              title="Git actions"
              disabled={!status || disabled}
            >
              <ChevronDown size={14} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="dock-menu git-menu" sideOffset={4}>
              <Menu.Item onSelect={() => showList("branches")}>
                <GitBranch size={14} />
                Branches
              </Menu.Item>
              <Menu.Item onSelect={() => void gitPerform(newBranch)}>
                <Plus size={14} />
                New branch
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={() => showList("stash")}>
                <Archive size={14} />
                Stashes
              </Menu.Item>
              <Menu.Item onSelect={() => void gitPerform(saveStash)}>
                <Archive size={14} />
                Save stash
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item onSelect={() => setDetails(true)}>
                <Info size={14} />
                Repository details
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {error && <div className="empty-state">{error}</div>}
      {!history && listKind === "history" && status && (
        <div className="changes-grid">
          {rows.length ? (
            <VirtualList<Row>
              items={rows}
              label="Repository changes"
              tree={{
                level: (row) => (row.type === "group" ? 1 : 2),
                expanded: (row) =>
                  row.type === "group" ? !collapsed[row.kind] : undefined,
                expand: (row) =>
                  row.type === "group" &&
                  setCollapsed((old) => ({ ...old, [row.kind]: false })),
                collapse: (row) =>
                  row.type === "group" &&
                  setCollapsed((old) => ({ ...old, [row.kind]: true })),
                parent: (index) => {
                  if (rows[index].type === "group") return index;
                  for (let before = index - 1; before >= 0; before--)
                    if (rows[before].type === "group") return before;
                  return index;
                },
              }}
              onSelect={(row) =>
                row.type === "group"
                  ? toggle(row.kind)
                  : void gitPerform(() =>
                      openDiff(row.change.entry, row.kind === "staged"),
                    )
              }
              render={(row) =>
                row.type === "group" ? (
                  <div className="git-change-group" data-git-group={row.kind}>
                    {collapsed[row.kind] ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <span>
                      {row.kind === "working" ? "Working changes" : "Staged"}
                    </span>
                    <span className="muted">{row.count}</span>
                    {row.kind === "working" && (
                      <button
                        disabled={disabled}
                        title="Stage all working changes"
                        onClick={(event) => {
                          event.stopPropagation();
                          void gitPerform(stageAll);
                        }}
                      >
                        Stage all
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    className="git-change-row"
                    data-git-kind={row.kind}
                    data-git-entry={row.change.entry}
                    title={row.change.path}
                  >
                    <span className="change-code">
                      {row.change.conflict
                        ? "Conflict"
                        : row.kind === "staged"
                          ? row.change.index
                          : row.change.worktree}
                    </span>
                    <span className="truncate">{row.change.path}</span>
                    <button
                      disabled={disabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        void gitPerform(() =>
                          stage(row.change, row.kind === "staged"),
                        );
                      }}
                    >
                      {row.kind === "staged" ? "Unstage" : "Stage"}
                    </button>
                    {row.change.conflict && (
                      <button
                        disabled={disabled}
                        onClick={(event) => {
                          event.stopPropagation();
                          void gitPerform(() => resolveConflict(row.change));
                        }}
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                )
              }
            />
          ) : (
            <div className="git-clean">No local changes</div>
          )}
          <div className={`commit-box ${composing ? "is-open" : ""}`}>
            <button
              className="commit-toggle"
              aria-expanded={composing}
              title="Review and commit staged changes"
              onClick={() => setComposing((old) => !old)}
            >
              {composing ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )}
              Commit{staged.length ? ` · ${staged.length}` : "…"}
            </button>
            {composing && (
              <>
                <label className="sr-only" htmlFor="commit-message">
                  Commit message
                </label>
                <textarea
                  id="commit-message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Commit message"
                />
                <button
                  className="primary"
                  title={`${status.author} · ${status.signing}. Hooks run normally. Commit does not push.`}
                  disabled={disabled || !message.trim() || !staged.length}
                  onClick={() => void gitPerform(commit)}
                >
                  Commit staged
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <Dialog.Root open={details} onOpenChange={setDetails}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <ModalContent className="dialog-content git-details">
            <Dialog.Title>Repository details</Dialog.Title>
            <Dialog.Description>
              Current repository, identity and commit policy.
            </Dialog.Description>
            <dl>
              <dt>Folder</dt>
              <dd>{status?.root}</dd>
              <dt>Branch</dt>
              <dd>{status?.branch}</dd>
              <dt>Upstream</dt>
              <dd>{status?.upstream ?? "No upstream"}</dd>
              <dt>Author</dt>
              <dd>{status?.author}</dd>
              <dt>Signing</dt>
              <dd>{status?.signing}</dd>
            </dl>
            <p>
              Hooks and configured signing run normally. Commit does not push.
            </p>
            <Dialog.Close asChild>
              <button
                className="dialog-close"
                aria-label="Close repository details"
                data-dialog-default
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </ModalContent>
        </Dialog.Portal>
      </Dialog.Root>
      {(history || listKind !== "history") && (
        <div className="history-area">
          {(listKind !== "history" || more) && (
            <div className="toolbar">
              {listKind !== "history" && <strong>{listKind}</strong>}
              {listKind !== "history" && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    setListKind("history");
                    if (history) void gitPerform(() => list("history"));
                  }}
                >
                  {history ? "History" : "Back to changes"}
                </button>
              )}
              {more && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    void gitPerform(() => list(listKind, offset + 100))
                  }
                >
                  Load older commits
                </button>
              )}
            </div>
          )}
          <VirtualList
            items={items}
            label="Repository history"
            selected={(item) => listKind === "history" && item.id === revision}
            render={(item) => (
              <div
                className="git-history-row"
                title={[item.label, item.detail.trim(), item.id]
                  .filter(Boolean)
                  .join("\n")}
              >
                <span className="git-history-subject truncate">
                  {listKind === "branches" ? item.id : item.label}
                </span>
                {(listKind === "branches"
                  ? item.label
                  : listKind === "history"
                    ? item.detail.trim()
                    : "") && (
                  <span className="git-history-refs truncate">
                    {listKind === "branches"
                      ? item.label
                      : item.detail.trim().replace(/^\((.*)\)$/, "$1")}
                  </span>
                )}
                <code>
                  {listKind === "history"
                    ? item.id.slice(0, 7)
                    : listKind === "stash"
                      ? item.id
                      : item.detail.slice(0, 7)}
                </code>
              </div>
            )}
            onSelect={(item) =>
              void gitPerform(async () => {
                if (!project) return;
                if (listKind === "branches") {
                  if (
                    await ask({
                      title: "Switch branch",
                      description: `Switch to ${item.id}. No implicit stash/discard.`,
                      choices: ["Switch"],
                    })
                  ) {
                    if (!(await prepareWorkingFiles())) return;
                    await rpc({
                      type: "gitBranch",
                      scope: project.id,
                      name: item.id,
                      create: false,
                    });
                    await refresh();
                    setListKind("history");
                  }
                } else if (listKind === "stash") {
                  const action = await ask({
                    title: item.id,
                    description: item.label,
                    choices: ["Inspect", "Apply", "Drop"],
                  });
                  if (action) {
                    if (action === "Apply" && !(await prepareWorkingFiles()))
                      return;
                    if (
                      action === "Drop" &&
                      !(await ask({
                        title: "Drop stash permanently",
                        description: item.id,
                        choices: ["Drop"],
                      }))
                    )
                      return;
                    const r = await call(
                      {
                        type: "gitStash",
                        scope: project.id,
                        operation: action.toLowerCase(),
                        id: item.id,
                        message: null,
                      },
                      "text",
                    );
                    setOutput(r.text);
                    await refresh();
                    await list("stash");
                  }
                } else {
                  const r = await call(
                    { type: "gitShow", scope: project.id, commit: item.id },
                    "text",
                  );
                  setRevision(item.id);
                  setRevisionRefs(item.detail.trim());
                  const files = await call(
                    {
                      type: "gitRevisionFiles",
                      scope: project.id,
                      commit: item.id,
                    },
                    "entries",
                  );
                  setRevisionFiles(files.entries);
                  setOutput(r.text);
                }
              })
            }
          />
        </div>
      )}
      {revision && (
        <div className="revision-files">
          <strong>Files changed in {revision.slice(0, 12)}</strong>
          {revisionFiles.map((file) => (
            <button
              key={file.id}
              disabled={disabled}
              onClick={() =>
                void gitPerform(async () => {
                  if (!project) return;
                  const { diff } = await call(
                    {
                      type: "gitRevisionDiff",
                      scope: project.id,
                      commit: revision,
                      entry: file.id,
                    },
                    "diff",
                  );
                  useApp.setState((s) => ({
                    tabs: [
                      ...s.tabs,
                      {
                        id: diff.id,
                        kind: "diff",
                        diff,
                        title: `History: ${file.path}`,
                        staged: false,
                      },
                    ],
                    active: diff.id,
                  }));
                })
              }
            >
              {file.path}
            </button>
          ))}
        </div>
      )}
      {output && (
        <details className="git-output">
          <summary>
            {history && revision
              ? "Commit details"
              : "Git output / conflict stages"}
          </summary>
          {history && revisionRefs && <p>{revisionRefs}</p>}
          <pre>{output}</pre>
        </details>
      )}
    </section>
  );
}

export default memo(GitPanel);
