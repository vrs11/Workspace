import { releasePreview, viewOperation } from "../workspace/viewResources";
import { useState, useRef, useEffect, useCallback, useId } from "react";
import type { SearchMatch, Diff, StreamEvent } from "../../generated/protocol";
import { call, rpc, errorText } from "../../shared/ipc/client";
import { useApp, perform, notice } from "../../shared/state/store";
import { VirtualList } from "../../shared/components/VirtualList";
import { loadDocument, models, reconcileDocuments } from "../editor/models";
import { ask } from "../../shared/components/Dialog";
let sequence = 1;
const nextGeneration = () => ++sequence;
export default function SearchPanel({
  names = false,
  onOpened,
  initialQuery = "",
}: {
  names?: boolean;
  onOpened?: () => void;
  initialQuery?: string;
}) {
  const project = useApp((s) => s.project);
  const [query, setQuery] = useState(initialQuery);
  const [activeResult, setActiveResult] = useState(0);
  const listId = useId();
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opening = useRef(0);
  const [ignored, setIgnored] = useState(false);
  const [regex, setRegex] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const generation = useRef(0);
  const streaming = useRef(false);
  useEffect(() => {
    const receive = (event: Event) => {
      const batch = (
        event as CustomEvent<Extract<StreamEvent, { type: "searchBatch" }>>
      ).detail;
      if (
        batch.scope === project?.id &&
        batch.generation === generation.current &&
        streaming.current
      )
        setResults((old) => [...old, ...batch.matches].slice(0, 1000));
    };
    window.addEventListener("search-batch", receive);
    return () => window.removeEventListener("search-batch", receive);
  }, [project?.id]);
  const [replacement, setReplacement] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    files: Diff[];
    occurrences: number;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const scope = project?.id,
      id = preview?.id;
    return () => {
      if (scope && id) releasePreview(scope, id);
    };
  }, [project?.id, preview?.id]);
  function invalidate() {
    const cancelled = generation.current;
    generation.current = nextGeneration();
    if (streaming.current && project)
      void perform(() =>
        rpc({ type: "cancelSearch", scope: project.id, generation: cancelled }),
      );
    streaming.current = false;
    setSearching(false);
    setResults([]);
    setActiveResult(0);
    setPreview(null);
    setError("");
  }
  const scope = project?.id;
  const runSearch = useCallback(() => {
    clearTimeout(debounce.current);
    if (!scope || !query) return;
    const id = nextGeneration();
    generation.current = id;
    streaming.current = true;
    setResults([]);
    setActiveResult(0);
    setPreview(null);
    setSearching(true);
    setError("");
    void perform(async () => {
      try {
        const r = await call(
          {
            type: "search",
            scope,
            query,
            names,
            ignored,
            regex,
            generation: id,
          },
          "search",
        );
        if (generation.current === r.generation) {
          streaming.current = false;
          setResults(r.matches);
          if (r.truncated)
            notice("Results capped by time/size limit. Narrow your search.");
        }
      } catch (error) {
        if (generation.current === id) setError(errorText(error));
      } finally {
        if (generation.current === id) {
          streaming.current = false;
          setSearching(false);
        }
      }
    });
  }, [scope, query, names, ignored, regex]);
  useEffect(() => {
    if (names && query) debounce.current = setTimeout(runSearch, 150);
    return () => clearTimeout(debounce.current);
  }, [names, query, runSearch]);
  useEffect(
    () => () => {
      const cancelled = generation.current;
      generation.current = nextGeneration();
      if (scope && streaming.current)
        void perform(() =>
          rpc({ type: "cancelSearch", scope, generation: cancelled }),
        );
      streaming.current = false;
    },
    [scope],
  );
  const openResult = (r: SearchMatch) =>
    void perform(async () => {
      const ticket = ++opening.current,
        searchGeneration = generation.current;
      useApp.getState().set({ navigate: { entry: r.entry, line: r.line } });
      await loadDocument(r.entry);
      if (ticket !== opening.current || generation.current !== searchGeneration)
        return;
      window.dispatchEvent(
        new CustomEvent("editor-focus", { detail: "primary" }),
      );
      const model = models.get(r.entry)?.model;
      if (model && !names) {
        const current = model.getLineContent(
          Math.min(r.line, model.getLineCount()),
        );
        if (
          regex
            ? !current.startsWith(r.text.replace(/\r?\n$/, ""))
            : !current.includes(query)
        )
          notice("Search result changed on disk; match may have moved.");
      }
      onOpened?.();
    });
  return (
    <section className={`search-panel${names ? " quick-files" : ""}`}>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (searching) return;
          const result = results[activeResult];
          if (names && result) openResult(result);
          else runSearch();
        }}
      >
        <label>
          {names ? "File name" : "Find in project"}
          <input
            autoFocus={names}
            onFocus={
              names ? (event) => event.currentTarget.select() : undefined
            }
            data-dialog-input={names ? "" : undefined}
            role={names ? "combobox" : undefined}
            aria-autocomplete={names ? "list" : undefined}
            aria-expanded={names ? results.length > 0 : undefined}
            aria-controls={names ? listId : undefined}
            aria-activedescendant={
              names && results.length ? `${listId}-${activeResult}` : undefined
            }
            value={query}
            onKeyDown={(event) => {
              if (
                !names ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                event.key === "Process" ||
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                !results.length
              )
                return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveResult((index) =>
                  Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  ),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat && !searching)
                  openResult(results[activeResult]);
              }
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              invalidate();
            }}
            placeholder={
              regex
                ? "Regular expression…"
                : names
                  ? "Quick open…"
                  : "Literal text…"
            }
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            aria-label="Use regular expression"
            checked={regex}
            onChange={(e) => {
              setRegex(e.target.checked);
              invalidate();
            }}
          />
          .* Regex
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={ignored}
            onChange={(e) => {
              setIgnored(e.target.checked);
              invalidate();
            }}
          />
          Include ignored
        </label>
        {!names && (
          <>
            <button
              type="button"
              disabled={!query || searching}
              onClick={runSearch}
            >
              Search
            </button>
            <button
              type="button"
              disabled={!searching}
              onClick={() => {
                streaming.current = false;
                const cancelled = generation.current;
                generation.current = nextGeneration();
                if (project)
                  void perform(() =>
                    rpc({
                      type: "cancelSearch",
                      scope: project.id,
                      generation: cancelled,
                    }),
                  );
                setSearching(false);
              }}
            >
              Cancel
            </button>
          </>
        )}
        <span role="status">
          {searching ? "Searching…" : `${results.length} matches`}
        </span>
      </form>
      {error && (
        <p className="search-error" role="alert">
          {error}
        </p>
      )}
      {!names && (
        <div className="replace-panel">
          <div className="toolbar">
            <label>
              Replace with
              <input
                aria-label="Replace with"
                value={replacement}
                onChange={(e) => {
                  setReplacement(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <button
              disabled={!project?.trusted || !results.length || searching}
              onClick={() =>
                void perform(async () => {
                  if (!project) return;
                  const entries = [...new Set(results.map((r) => r.entry))];
                  const r = await call(
                    {
                      type: "replacePreview",
                      scope: project.id,
                      entries,
                      query,
                      replacement,
                      regex,
                    },
                    "replacement",
                  );
                  setPreview(r);
                  setSelected(new Set(r.files.map((d) => d.entry)));
                })
              }
            >
              Preview replacement
            </button>
            {regex && (
              <small>
                Capture replacements: $1, {"${name}"}; $$ inserts $.
              </small>
            )}
          </div>
          {preview && (
            <div className="replace-preview">
              <p>
                {preview.occurrences} occurrences in {preview.files.length}{" "}
                file(s). Select files and review the visual diffs before
                applying.
              </p>
              {preview.files.map((diff) => (
                <div className="toolbar" key={diff.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(diff.entry)}
                      onChange={(e) =>
                        setSelected((old) => {
                          const next = new Set(old);
                          if (e.target.checked) next.add(diff.entry);
                          else next.delete(diff.entry);
                          return next;
                        })
                      }
                    />
                    {diff.path}
                  </label>
                  <button
                    onClick={() => {
                      const state = useApp.getState();
                      state.set({
                        tabs: [
                          ...state.tabs.filter((t) => t.id !== diff.id),
                          {
                            id: diff.id,
                            kind: "diff",
                            diff,
                            title: `Replace: ${diff.path}`,
                            staged: false,
                          },
                        ],
                        active: diff.id,
                      });
                    }}
                  >
                    Review replacement diff
                  </button>
                </div>
              ))}
              <button
                disabled={!selected.size}
                onClick={() =>
                  void perform(() => {
                    if (!project) return Promise.resolve();
                    const id = preview.id;
                    return viewOperation(project.id, id, async () => {
                      if (
                        !(await ask({
                          title: "Apply selected replacements",
                          description: `Save replacements to ${selected.size} selected file(s)? Each file is revision checked and saved atomically. A later conflict stops the batch and reports any files already saved.`,
                          choices: ["Apply replacements"],
                        }))
                      )
                        return;
                      const r = await call(
                        {
                          type: "replaceApply",
                          scope: project.id,
                          preview: id,
                          entries: [...selected],
                        },
                        "text",
                      );
                      setPreview((current) =>
                        current?.id === id ? null : current,
                      );
                      notice(r.text);
                      await reconcileDocuments();
                      window.dispatchEvent(new Event("workspace-refresh"));
                    });
                  })
                }
              >
                Apply selected replacements
              </button>
            </div>
          )}
        </div>
      )}
      <VirtualList
        items={results}
        label="Search results"
        fitContent={names}
        render={(r) => (
          <>
            <span className="truncate">
              {names ? r.path : `${r.path}:${r.line}`}
            </span>
            {!names && <code className="truncate muted">{r.text}</code>}
          </>
        )}
        id={listId}
        activeIndex={names ? activeResult : undefined}
        onActiveIndexChange={names ? setActiveResult : undefined}
        selected={
          names ? (result) => result === results[activeResult] : undefined
        }
        onSelect={openResult}
      />
    </section>
  );
}
