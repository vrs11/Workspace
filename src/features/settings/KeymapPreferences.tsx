import { useEffect, useState, useRef } from "react";
import { doubleShiftGesture } from "../../shared/doubleShift";
import { useApp, perform, notice } from "../../shared/state/store";
import { call } from "../../shared/ipc/client";
import {
  normalizeShortcut,
  shortcutStroke,
  type Shortcut,
} from "../../shared/keymap";

export default function KeymapPreferences() {
  const settings = useApp((s) => s.settings)!;
  const [catalog, setCatalog] = useState<Shortcut[]>([]);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Shortcut | null>(null);
  const [value, setValue] = useState("");
  const [recording, setRecording] = useState(false);
  const shiftRecorder = useRef(doubleShiftGesture());
  useEffect(() => {
    let disposed = false;
    void import("../editor/monaco")
      .then(() => import("../editor/keymap"))
      .then(({ shortcutCatalog }) => {
        if (!disposed) setCatalog(shortcutCatalog());
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(String(error));
      });
    return () => {
      disposed = true;
    };
  }, []);
  const effective = (row: Shortcut) =>
    settings.keybindings?.[row.id] ?? row.defaults;
  const filtered = catalog.filter((row) =>
    `${row.scope} ${row.label} ${row.id} ${effective(row).join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const edit = (row: Shortcut) => {
    setEditing(row);
    setValue(effective(row).join("; "));
    setFailure("");
    setRecording(false);
  };
  async function save(reset = false) {
    if (!editing) return;
    try {
      const keys = reset
        ? editing.defaults
        : value.trim()
          ? value.split(";").map((key) => normalizeShortcut(key))
          : [];
      if (keys.length > 4)
        throw new Error("Use at most four shortcuts per action.");
      const { monaco } = await import("../editor/monaco");
      const { encodeShortcut } = await import("../editor/keymap");
      for (const key of keys) {
        if (key === "Shift Shift") {
          if (editing.scope !== "Workspace")
            throw new Error(
              "Double Shift is a workspace gesture. Choose a regular shortcut for this action.",
            );
          continue;
        }
        encodeShortcut(monaco, key);
        const first = key.split(" ")[0];
        if (
          editing.scope !== "Editor" &&
          !/^(Ctrl|Meta|Alt)\+/.test(first) &&
          !/^F\d{1,2}$/.test(first) &&
          !["Explorer", "Media"].includes(editing.scope)
        )
          throw new Error(
            "Workspace and terminal shortcuts need Ctrl, Meta or Alt, or a function key, to preserve ordinary typing.",
          );
        if (editing.scope === "Terminal" && /^Ctrl\+[CDZ]$/.test(first))
          throw new Error(
            "Ctrl+C, Ctrl+D and Ctrl+Z belong to the terminal program. Choose another shortcut.",
          );
      }
      const conflicts = catalog.filter(
        (row) =>
          row.id !== editing.id &&
          keys.some((key) =>
            effective(row).some((other) => {
              const candidate = normalizeShortcut(other);
              return (
                key === candidate ||
                key.startsWith(candidate + " ") ||
                candidate.startsWith(key + " ")
              );
            }),
          ) &&
          ((row.scope === editing.scope && editing.scope !== "Editor") ||
            ((row.scope === "Workspace" || editing.scope === "Workspace") &&
              row.scope !== "Terminal" &&
              editing.scope !== "Terminal")),
      );
      if (conflicts.length)
        throw new Error(
          `Already assigned to ${conflicts.map((row) => row.label).join(", ")}. Clear or change those shortcuts first.`,
        );
      await perform(async () => {
        const current = useApp.getState().settings!;
        const keybindings = { ...current.keybindings };
        if (reset) delete keybindings[editing.id];
        else keybindings[editing.id] = keys;
        const result = await call(
          { type: "settings", settings: { ...current, keybindings } },
          "bootstrap",
        );
        useApp.getState().set({ settings: result.settings });
        setEditing(null);
        notice("Keyboard shortcuts saved.");
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <fieldset className="keymap-preferences">
      <legend>Keyboard shortcuts</legend>
      <p>
        Workspace, terminal and the full bundled editor keymap. Defaults follow
        your platform. Actions without a built-in binding show Unassigned.
        Editor context conditions remain active; program-specific terminal keys
        stay with the program.
      </p>
      <div className="toolbar">
        <input
          aria-label="Search keyboard shortcuts"
          placeholder="Search actions, keys or command IDs…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <button
          onClick={() =>
            void perform(async () => {
              const current = useApp.getState().settings!;
              const result = await call(
                { type: "settings", settings: { ...current, keybindings: {} } },
                "bootstrap",
              );
              useApp.getState().set({ settings: result.settings });
              setEditing(null);
              setFailure("");
              notice("Default keyboard shortcuts restored.");
            })
          }
        >
          Restore all defaults
        </button>
      </div>
      {failure && (
        <p role="alert" className="keymap-error">
          {failure}
        </p>
      )}
      {editing && (
        <div className="keymap-editor">
          <strong>
            {editing.scope} · {editing.label}
          </strong>
          <code>{editing.id}</code>
          <label>
            Shortcut for {editing.label}
            <input
              aria-label={`Shortcut for ${editing.label}`}
              data-keymap-recorder
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                if (!recording || e.nativeEvent.isComposing) return;
                shiftRecorder.current.accept(e.nativeEvent);
                e.preventDefault();
                e.stopPropagation();
                if (e.key === "Escape") {
                  setRecording(false);
                  return;
                }
                const stroke = shortcutStroke(e.nativeEvent);
                if (stroke) {
                  setValue(stroke);
                  setRecording(false);
                }
              }}
              onKeyUp={(e) => {
                if (recording && shiftRecorder.current.accept(e.nativeEvent)) {
                  e.preventDefault();
                  setValue("Shift Shift");
                  setRecording(false);
                }
              }}
            />
          </label>
          <small>
            Separate alternatives with ; and chord steps with a space, for
            example Ctrl+K Ctrl+C. Leave empty to unassign. Meta is Command on
            macOS. Use Shift Shift for a double tap in workspace actions.
          </small>
          <small>
            Default: {editing.defaults.join("; ") || "Unassigned"}
            {editing.when && ` · Context: ${editing.when}`}
          </small>
          <div className="toolbar">
            <button
              onClick={(e) => {
                shiftRecorder.current.reset();
                setRecording(true);
                e.currentTarget
                  .closest(".keymap-editor")!
                  .querySelector<HTMLInputElement>("input")!
                  .focus();
              }}
            >
              {recording ? "Press shortcut…" : "Record shortcut"}
            </button>
            <button onClick={() => void save()}>Apply shortcut</button>
            <button onClick={() => void save(true)}>Restore default</button>
            <button
              onClick={() => {
                setEditing(null);
                setFailure("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div
        className="keymap-table"
        role="table"
        aria-label="Keyboard shortcut bindings"
      >
        {filtered.slice(page * 40, (page + 1) * 40).map((row) => (
          <div role="row" key={row.id} data-command-id={row.id}>
            <span role="cell" title={row.id}>
              {row.scope} · {row.label}
            </span>
            <kbd
              role="cell"
              title={`Default: ${row.defaults.join("; ") || "Unassigned"}`}
            >
              {effective(row).join("; ") || "Unassigned"}
            </kbd>
            <button
              aria-label={`Edit shortcut ${row.label}`}
              onClick={() => edit(row)}
            >
              Edit
            </button>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <small>{filtered.length} actions</small>
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous shortcuts
        </button>
        <span>
          {page + 1} / {Math.max(1, Math.ceil(filtered.length / 40))}
        </span>
        <button
          disabled={(page + 1) * 40 >= filtered.length}
          onClick={() => setPage(page + 1)}
        >
          Next shortcuts
        </button>
      </div>
    </fieldset>
  );
}
