# Workspace

A local desktop workspace using Tauri 2, React, Monaco, installed Git and native PTY terminals. There is no built-in AI integration. Codex CLI, Claude Code and other installed programs run as ordinary user-entered terminal commands, with their own authentication and configuration.

Open a folder, trust it, edit or run a command, inspect visual diffs, stage selected files or Git hunks, review staged changes, commit, and push separately through graphical controls. Git controls do not depend on the terminal. Changes and History share the Git title row. The branch button opens branches; the compact icons refresh/fetch/pull/push, with names in their tooltips. The ⌄ menu contains New branch, Stashes, Save stash and Repository details (path, upstream, author and signing). Working/Staged groups appear only when nonempty and can collapse in a shared file tree. Staging opens the commit composer; its header collapses it without clearing the draft. Commit and push remain separate. Hooks, signing and credential helpers remain active; pull is fast-forward-only.

Image previews zoom with the scroll wheel around the pointer; drag the image to pan, or choose Fit to reset. Raster 100% maps one source pixel to one display pixel, including Retina displays. Smooth scaling is the default; Source pixels preserves original pixels while enlarging and is available in Image rendering. SVG is rendered at its target layout size for vector sharpness. Panels remember their positions and sizes when hidden/reopened. Use the panel × to hide it and Workspace layout to show it again. Each trusted writable project stores its workspace arrangement, tab references, explorer expansion/views and terminal geometry in `.agent-workspace/workspace.json`; the directory ignores its own contents in Git. Folder switches and quit flush pending layout changes. Restricted/read-only folders retain a private fallback and show a notice. Global preferences, trust and unsaved editor recovery remain in private app data. Project settings never contain terminal commands, transcripts or live process IDs.

Explorer supports Cmd/Ctrl-click to select individual items, Shift-click for a
range, and Cmd/Ctrl+A for all visible rows. Drag a selection into a project
folder to move it, or out to a file manager to move the saved files. Drop files/folders from
the OS into Explorer to move them into the project; editor drops open in place.
Existing destinations are never overwritten. Explorer moves across disks are
refused without changing the sources; use the system file manager for those. Delete confirms the selected files and folders and keeps recovery copies.
Dropping local files onto the editor opens them in place, including files outside
the project. External tab references and recovery remain in private app data.

## Build and validate

Pinned tools: Node 24.22.1, pnpm 10.22.0 and Rust 1.99.1. Install the [Tauri native prerequisites](https://v2.tauri.app/start/prerequisites/). Run commands from the repository root. `source scripts/env.sh` selects repository-local tools when available and applies the configured macOS deployment target. No CLI AI program, account or inference is required to build or test.

```sh
source scripts/env.sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm test:rust
pnpm test:integration
pnpm test:terminal
pnpm test:crash
pnpm test:updates
pnpm test:release
pnpm check:generated
pnpm desktop:build
pnpm test:desktop
pnpm test:desktop:stability
pnpm test:desktop:repair
pnpm test:desktop:launch
pnpm test:desktop:docking
pnpm test:desktop:interaction
pnpm test:desktop:explorer
pnpm test:desktop:editor
pnpm test:desktop:views
pnpm test:desktop:pointer
pnpm test:desktop:features
pnpm test:perf
pnpm check:licenses
pnpm test:security
pnpm check:security
pnpm check:vendor
pnpm test:vendor
pnpm build
pnpm check:release-boundary
```

`pnpm dev` starts desktop development. `pnpm build` creates an **optimized, unsigned development package**. `desktop:build` creates a separate test executable in `artifacts/desktop-test`, containing an embedded WebDriver and test app-data override. Never distribute that executable. Ordinary and test frontend assets use separate `dist` and `dist-desktop-test` directories. Tests use their own application identity and disposable data; leave existing user apps running. Native desktop tests run one at a time and use disposable repositories and a local bare remote. No implementation remote is pushed.

Optimized measurements use `pnpm test:perf:desktop` for normal-process startup/all-WebKit resources, and `pnpm desktop:build:perf` then `pnpm test:desktop:perf` for actual editor/input paint. Run these and all GUI suites sequentially. An active visible desktop is required for foreground acceptance; hidden views are recorded as blocked. `pnpm test:disk-full` tests actual ENOSPC on a disposable macOS volume. Linux native prerequisites support `pnpm test:glib`; `pnpm check:windows-api` checks APIs with official Zig 0.17.0 and the Windows GNU Rust target, without executing Windows code.

Dependency directories (`node_modules/`, `vendor/`), compiler outputs, caches,
packages and test artifacts are ignored. Installation and native command wrappers
reconstruct the required local dependency patches from pinned,
checksum-verified upstream archives. Git is a build prerequisite. For direct Cargo
commands, run `pnpm prepare:vendor` and `pnpm prepare:licenses` first. Lockfiles,
patch inputs and application assets remain tracked. Dependency notices, the SBOM
and required source archives are generated into ignored `artifacts/legal/` and
included in app packages; they are not stored in the source tree.

## Using the workspace

Use **Editor view options** beside the editor tabs, or right-click a visible
line number, to toggle **Soft wrap**, **Show line numbers** and **Git blame**.
The native **Editor** menu and command palette provide the same controls.
Wrap and line-number preferences persist and apply to split editors and diffs.
When line numbers are hidden, use a menu to restore them. Blame annotates the
current buffer in a trusted Git project, marks unsaved lines as Uncommitted, and
shows author, date, commit and original line details when selected. It runs only
when enabled; files without committed history show an explanation.

Markdown, HTML, CSV and TSV files offer **Code**, **Side by side** and
**Rendered** buttons. Previews update from unsaved text, retaining editor undo
and selection across mode changes. Markdown supports tables, task lists and
fenced code; CSV/TSV support quoted fields and embedded newlines. HTML previews
show static document content. Scripts, forms and document-supplied styles do not
run. Local image references and file links stay inside the open project; remote
images are not loaded, and HTTPS links open only when clicked. Rendering is
limited to 1 MiB of source, 25,000 elements and 16 local images; table previews
support up to 10,000 rows and 256 columns. Larger files remain available in Code.

Syntax highlighting detects the complete bundled Monaco language registry (92 modes in the current build): TypeScript/JavaScript and JSX/TSX, HTML/CSS/SCSS, Java/Kotlin, Python, Go, Rust, C/C++/C#, PHP, Ruby, Swift, SQL, JSON/YAML, shell and common configuration formats. Dockerfile and Makefile work without extensions; TOML has its own grammar. Vue/Svelte/Astro use HTML/template highlighting. Select a language in the status bar for an unknown extension. Diffs use the same detection. This is syntax support, not a bundled language-server/build/debug system.

Open an image, video or audio file from Files or Quick open to preview it in an editor tab. Images offer Fit/50/100/200% zoom; SVG can also **Open as code**. Audio/video offer native play/pause, volume and seeking without autoplay. Space, arrows and M control the focused player; image fit/zoom and these bindings are configurable. Reload preview reads the current file. Supported extensions include PNG/JPEG/GIF/WebP/AVIF/BMP/ICO/SVG/TIFF, MP4/MOV/WebM/OGV/MKV and MP3/WAV/M4A/AAC/OGG/Opus/FLAC/AIFF; actual codec support depends on the installed system WebView. Decode failures explain the next step and preserve bytes. Images are limited to 32 MiB; large audio/video use bounded range reads instead of loading the entire file. Preview URLs are scoped, temporary and revoked on close/project switch.

**Settings → Keyboard shortcuts** lists workspace, terminal, explorer, Git, media and the complete bundled editor keymap. Search by action, key or command ID. Edit or record a binding, add alternatives separated by `;`, use two-step chords such as `Ctrl+K Ctrl+S`, or leave it empty to unassign. Restore individual/all defaults. Platform defaults are populated; editor actions without upstream defaults show Unassigned. Contextual editor conditions remain active. Changes persist and apply immediately without resetting models or terminals. Raw PTY control keys and IME/AltGraph input stay with the program.

When idle or focus-loss autosave is enabled, the normal toolbar Save button is hidden. The Save and Save All shortcuts and command-palette actions remain available. Error Retry and explicit conflict/recovery decisions stay visible.

The macOS `com.apple.macl` attribute is preserved during saves, including after
moving a file out of and back into the workspace. On macOS and Unix, files with
other metadata that cannot be preserved open read-only.
Choose **Edit anyway…** to review the affected metadata, then **Accept loss and
edit** to permit its removal when this file is saved (including autosave). Cancel
keeps it read-only. Approval applies only to the open file and expires if its
metadata changes; the warning disappears immediately after approval. Content
conflicts and other read-only restrictions remain protected.

Folders begin restricted: browsing and read-only inspection are available; saves, Git and new shell execution require explicit trust. Trust is tied to native folder identity. Settings locates an absolute Git executable independently of PATH. Git is separately installed and never downloaded by this app.

The default layout has Explorer on the left, a vertical Git pane on the right, and a dedicated Terminal below the editor. Drag a pane header onto an edge target, or use its three-dot menu to dock left/right/top/bottom or beside another pane. Explorer, both editor groups, Git, Terminal and Output can all move and resize. The Workspace layout button shows hidden panes and resets positions. Visible panes, their positions and divider sizes are saved per project. Moving a pane preserves the editor and running PTYs. Hovering a divider shows its resize cursor locally. A drag keeps that cursor only until release or cancellation (including Escape or app focus loss); ordinary editor text selection remains independent.

Use **New** for a file/folder and **Actions** for Rename, Move, Delete or selecting a Git repository. Right-click an entry or press Shift+F10 for its context menu. Click a folder arrow to expand/collapse it; double-clicking the folder also toggles it. New items are created in the selected folder or the selected file’s parent; a new file opens for editing. Duplicate names remain in the dialog for correction, with no overwrite.

In Explorer, single-click to select a file and double-click to open it. Enter
opens the focused file. Selection and dragging leave closed files closed.

Right-click an editor tab to close it, the tabs to its left/right, or the other
tabs. Unsaved changes retain the normal Save/Discard/Cancel decision; Cancel
stops the remaining closes. Both tab and Explorer context menus offer **Copy file
name** and **Copy file path → From project root / From Git root / Absolute path**.
Git-relative paths use the repository containing that item, including nested
repositories, and require a trusted project with Git configured. The crosshair
button in Explorer reveals the active editor file, expanding its ancestors and
scrolling to the selected entry without opening another editor.

Deleting a folder moves it and all its contents into private recovery without
copying the tree or following links inside it. Open files keep their
Save/Discard/Cancel decisions. Use **Command palette → Restore deleted file or
folder** to restore the complete folder without overwriting an existing path.
This recoverable move requires the folder and app data to be on the same volume;
use the system Trash for folders on other volumes.

In a trusted Git project, Explorer colors modified files blue, added files green,
untracked files brown, staged changes teal, renames purple, conflicts/deletions red
and ignored files gray. Unchanged files keep the normal color. Folders reflect
changes inside them; small status badges and tooltips explain the colors. Unsaved
edits to tracked files turn blue immediately. These indicators work with Git hidden.

Use Files and Search inside Explorer; Quick open remains a popup. Drag a file or folder onto another folder, or onto PROJECT FILES for the root. Hover over a closed folder to expand it. Moves never overwrite an existing destination; dirty editors offer Save, Discard or Cancel. Drag a file onto either editor to open it. Actions → Move to folder remains available for keyboard use.

The editor shares one Monaco text model between views, with dirty indicators, undo/redo, find/replace, line navigation, save-all, and acknowledged private recovery checkpoints. Ordinary edits autosave after 15 seconds of inactivity, when switching apps or entering Terminal, and before file/project close, quit and explicit Git operations. Settings → Autosave controls the idle/focus triggers and idle interval. Cmd/Ctrl+S still saves manually. Autosave preserves undo and newer typing; conflicting/recovered/read-only buffers wait for review. Save failures leave a visible warning and Retry save, without overwriting another writer's changes. File moves/deletes and running-terminal termination retain their explicit decisions.

Use Alt+Shift+click to add/remove individual carets, or document Find → Select all matches as cursors to edit every match, including regex matches. On macOS, Ctrl+G adds the next occurrence, Cmd+Ctrl+G selects all and Ctrl+Shift+G deselects the last. Windows/Linux use Alt+J, Ctrl+Alt+Shift+J and Alt+Shift+J. Escape returns to one caret. The same find controls work in side-by-side and inline diffs; use Edit file to change the working file.

Explorer Search and Quick open support literal or regex queries. Content search uses Rust regex syntax, with invalid patterns shown inline. Regex replacement supports $1, ${name} and $$; project replacements require file selection and visual diff preview, and changed revisions are refused. An unrelated process can still race the final filesystem replacement; no unconditional compare-and-swap is claimed.

Press Shift twice quickly to open Quick open using selected text from the editor,
diff, terminal or ordinary text. File results update as you type; ↑/↓ selects a
file, Enter opens it and Escape closes the picker. Double Shift is its only default shortcut.
Configure or disable Double Shift as `Shift Shift` in Keyboard shortcuts. Holding
Shift or using it with other keys does not open the picker.

Warning/choice dialogs focus the default button. Arrow keys move between enabled
buttons, Enter activates the focused one and Escape cancels. Text inputs keep
normal caret arrows and Enter submits their value. Already-running non-cancellable
operations keep their existing submission guard.

If the original project folder moves on the same volume, choose Locate when opening its missing recent entry, or use Locate moved project folder in the command palette. The native folder identity must match; an unrelated folder or copy is refused. Verified relocation preserves scope, trust, recovery, layout and live editor/PTY sessions. Cross-volume moves require a new project scope.

Choose **File → New Window** or use **Cmd+Option+Shift+N / Ctrl+Alt+Shift+N** to open another project window. The shortcut is configurable in Settings. Opening a folder from an existing project offers **New window** (the default) or **This window**. Each window has independent editors, panels and terminals; opening a folder already in use focuses its window. Preferences and recent projects are shared. Closing a window saves/reviews its files and jobs; quitting reviews all remaining project windows in turn. Updates require closing other windows first.

Launching the executable with a folder path (or `-- <folder>` for a leading hyphen) offers it in a separate project window, reusing an empty welcome window when available. Relative paths use the caller’s working directory. macOS Open With folder events use the same offer. Pending trust/save/credential dialogs finish first; replacing a project in the same window still requires explicit dirty-file and terminal decisions.

Open Terminal and press **+** for a new shell. Tabs and controls share the single title row. The **⌄ Terminal actions** menu contains Split right/down, Maximize/Restore, Rename, Select all, Copy/Paste and Terminate/Close. Press **× beside a terminal tab** to close that tab and all its splits, after confirming termination of its owned sessions. Other tabs keep running. A split’s close button appears on hover or keyboard focus; Close tab and the selected-pane termination action also remain in the menu. The tool-window × hides Terminal and keeps sessions running. Double-click the active tab to rename it; use arrow keys in the tab strip to switch tabs. Each tab or split has an independent native PTY. Drag split dividers to resize. Search opens with the magnifier or Cmd+F on macOS / Ctrl+Shift+F elsewhere; Enter and Shift+Enter find next/previous, and Escape closes search and returns typing to the shell. Search overlays the content and never takes a permanent row. Ended-session status appears only when relevant. Closing an owned session still confirms termination of any remaining jobs. Configure a shell's absolute path, argument lines, font and scrollback in Settings. The default shell follows COMSPEC on Windows and SHELL or the account's configured shell on Unix. macOS starts the default shell as a login shell so GUI launches load your normal shell profile and CLI PATH. An explicit shell/argument configuration is used exactly as entered. Commands execute only when you type or paste them.

Ctrl+C/D/Z, arrows, function keys and ordinary TUI input go to the terminal. Use Cmd+C/V on macOS or Ctrl+Shift+C/V elsewhere for clipboard operations. Multiline paste sends directly without a warning and respects the program's bracketed-paste mode; the 1 MiB paste/input bound remains. Terminal escape sequences cannot write the application clipboard. A renderer reload reattaches owned PTYs; a host restart restores pane layout with ended-session placeholders and never restarts commands. Terminal transcripts and copied program histories are not persisted. Your shell may maintain its own history normally.

Terminal programs use your OS permissions and can access outside the opened folder. Their external file changes are checked by the same revision/conflict path as other external writers. No app-managed agent mode blocks editing or Git. Termination stops owned PTY jobs; deliberately detached descendants can escape an owned OS session and must be managed normally.

## Recovery, diagnostics and release state

The OS application-data directory contains versioned settings, UI references, private editor recovery and recoverable-delete data. Recovery can contain secrets: protect this directory and never attach it wholesale to a support report. Editor checkpoints have a 256 MiB / 256-file quota, including backup footprint. A quota or write failure is visible; unresolved recovery is never silently pruned. The UI distinguishes the last acknowledged checkpoint from more recent typing; a crash can lose unacknowledged keystrokes.

Corrupt preferences open a repair screen. Restore a validated previous backup or explicitly reset preferences; both choices retain the original, previous backup and editor checkpoints. Damaged editor and terminal layouts have separate explicit reset actions. Terminal layout reset reattaches owned sessions without starting or replaying commands. Keep retained files private when repairing manually. Use the platform application-data directory for this application; its exact location depends on the operating system and installation. Windows project operations now use native directory handles and NTFS metadata-preserving replacement. Unsupported metadata and cross-volume recoverable deletion refuse changes; native Windows verification remains a release gate.

Diagnostics are explicitly previewed and copied; they exclude file buffers, recovery text, credentials and terminal output. Review anything you share. Errors explain the affected item and next step. Open **Details** for the code/operation ID, and **Copy reference** to copy those identifiers. Name errors stay inline without discarding input; error references contain no file buffers, clipboard contents or terminal output.

Workspace is the product name. Existing `agent-workspace` binary/package identifiers, app-data identity and `.agent-workspace/workspace.json` paths stay compatible with earlier builds, preserving preferences, trust, recovery and project state.


Native macOS Quit (including ⌘Q) uses the same save and owned-terminal decisions
as window close, and waits behind pending trust/save/credential questions. A failed
save keeps the acknowledged buffer available; cancellation keeps the shell alive.
An OS logout/restart may need retrying after those decisions complete.

Packages include dependency attributions, original source archives required by
their licenses, complete Rust standard-library notices and the SBOM. These build
resources are generated automatically and checked by `pnpm check:licenses` and
`pnpm check:package-resources <resource-directory>`.
