use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root: String,
    pub name: String,
    pub trusted: bool,
    /// Original scope-hash path after a verified same-filesystem relocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub identity_root: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DockPanel {
    Explorer,
    Editor,
    EditorSecondary,
    Git,
    Terminal,
    Output,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum DockNode {
    Panel {
        panel: DockPanel,
    },
    Split {
        id: String,
        direction: DockDirection,
        ratio: f64,
        first: Box<DockNode>,
        second: Box<DockNode>,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DockDirection {
    Horizontal,
    Vertical,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DockLayout {
    pub version: u32,
    pub root: Option<DockNode>,
    #[serde(default)]
    pub hidden: Vec<DockPanel>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProjectView {
    pub explorer_search: bool,
    pub git_history: bool,
    pub expanded: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub git: Option<String>,
    pub theme: String,
    pub font_size: u32,
    pub recent: Vec<Project>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub shell_args: Vec<String>,
    #[serde(default = "terminal_font")]
    pub terminal_font_size: u32,
    #[serde(default = "terminal_scrollback")]
    pub terminal_scrollback: u32,
    #[serde(default = "enabled")]
    pub auto_save_idle: bool,
    #[serde(default = "auto_save_delay")]
    pub auto_save_delay: u32,
    #[serde(default = "enabled")]
    pub auto_save_on_focus_loss: bool,
    #[serde(default)]
    pub keybindings: std::collections::BTreeMap<String, Vec<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub entry: String,
    pub token: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub mime: String,
    #[ts(type = "number")]
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalNode {
    Pane {
        id: String,
        session: Option<String>,
    },
    Split {
        id: String,
        direction: String,
        ratio: f64,
        first: Box<TerminalNode>,
        second: Box<TerminalNode>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
pub struct TerminalTab {
    pub id: String,
    pub title: String,
    pub root: TerminalNode,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS, PartialEq)]
pub struct TerminalLayout {
    #[serde(default = "layout_version")]
    pub version: u32,
    pub tabs: Vec<TerminalTab>,
    pub active: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct GitConflict {
    pub entry: String,
    pub path: String,
    pub base: String,
    pub current: String,
    pub incoming: String,
    pub reviewed: String,
}
pub fn layout_version() -> u32 {
    1
}
impl Default for TerminalLayout {
    fn default() -> Self {
        Self {
            version: 1,
            tabs: vec![],
            active: None,
        }
    }
}
pub fn terminal_font() -> u32 {
    13
}
pub fn terminal_scrollback() -> u32 {
    5000
}
pub fn enabled() -> bool {
    true
}
pub fn auto_save_delay() -> u32 {
    15
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub scope: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalChunk {
    pub data: Vec<u8>,
    pub done: bool,
    pub info: TerminalInfo,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FilePathKind {
    Name,
    Project,
    Git,
    Absolute,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub entry: String,
    pub name: String,
    pub path: String,
    pub text: String,
    pub baseline: String,
    pub encoding: String,
    pub eol: String,
    pub readonly: Option<String>,
    pub size: f64,
    pub recovery: Option<String>,
    pub revision: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub entry: String,
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub original: Option<String>,
    pub conflict: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitFileStatus {
    Clean,
    Ignored,
    Untracked,
    Staged,
    Added,
    Renamed,
    Deleted,
    Modified,
    Conflict,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDecoration {
    pub entry: String,
    pub status: GitFileStatus,
    pub staged: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub changes: Vec<Change>,
    pub staged_revision: String,
    pub author: String,
    pub signing: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub id: String,
    pub entry: String,
    pub path: String,
    pub base_label: String,
    pub next_label: String,
    pub base: String,
    pub next: String,
    pub hunks: Vec<String>,
    pub hunk_unavailable: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct NamedItem {
    pub id: String,
    pub label: String,
    pub detail: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct SearchMatch {
    pub entry: String,
    pub path: String,
    pub line: u32,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    CloseRequested {
        scope: String,
    },
    Changed {
        scope: String,
        degraded: bool,
    },
    SearchBatch {
        scope: String,
        generation: u32,
        matches: Vec<SearchMatch>,
    },
    Credential {
        scope: String,
        request: String,
        prompt: String,
    },
}

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Bootstrap,
    TakeOpenRequest,
    RepairSettings {
        restore_backup: bool,
    },
    RepairLayout {
        scope: String,
        terminal: bool,
    },
    PickFolder,
    OpenProject {
        path: String,
    },
    RelocateProject {
        project: String,
        path: String,
    },
    Trust {
        scope: String,
        trusted: bool,
    },
    Settings {
        settings: Settings,
    },
    PickExecutable {
        tool: String,
    },
    CheckRuntime {
        tool: String,
    },
    List {
        scope: String,
        parent: Option<String>,
    },
    FilePath {
        scope: String,
        entry: String,
        kind: FilePathKind,
    },
    RevealEntry {
        scope: String,
        entry: String,
    },
    OpenFile {
        scope: String,
        entry: String,
    },
    CloseMedia {
        scope: String,
        token: String,
    },
    OpenDocument {
        scope: String,
        entry: String,
    },
    ReconcileDocument {
        scope: String,
        document: String,
    },
    FinishReconcile {
        scope: String,
        refresh: String,
        accept: bool,
    },
    Checkpoint {
        scope: String,
        document: String,
        text: String,
        revision: u32,
        baseline: String,
    },
    Save {
        scope: String,
        document: String,
        text: String,
        revision: u32,
        baseline: String,
    },
    Discard {
        scope: String,
        document: String,
    },
    DocumentCompare {
        scope: String,
        document: String,
    },
    ReviewDisk {
        scope: String,
        document: String,
        reviewed: String,
    },
    CloseDocument {
        scope: String,
        document: String,
    },
    Create {
        scope: String,
        parent: Option<String>,
        name: String,
        directory: bool,
    },
    Rename {
        scope: String,
        entry: String,
        parent: Option<String>,
        name: String,
    },
    MoveEntry {
        scope: String,
        entry: String,
        parent: Option<String>,
    },
    Delete {
        scope: String,
        entry: String,
    },
    Search {
        scope: String,
        query: String,
        names: bool,
        ignored: bool,
        #[serde(default)]
        regex: bool,
        generation: u32,
    },
    CancelSearch {
        scope: String,
        generation: u32,
    },
    ReleaseViews {
        scope: String,
        diffs: Vec<String>,
        previews: Vec<String>,
    },
    GitStatus {
        scope: String,
        repository: Option<String>,
    },
    GitDecorations {
        scope: String,
        entries: Vec<String>,
    },
    GitDiff {
        scope: String,
        entry: String,
        staged: bool,
    },
    GitStage {
        scope: String,
        entry: String,
        unstage: bool,
    },
    GitHunk {
        scope: String,
        diff: String,
        hunk: u32,
        unstage: bool,
    },
    GitCommit {
        scope: String,
        message: String,
        reviewed: String,
    },
    GitNetwork {
        scope: String,
        operation: String,
    },
    GitPublish {
        scope: String,
        remote: String,
    },
    GitShow {
        scope: String,
        commit: String,
    },
    OpenLink {
        url: String,
    },
    CredentialReply {
        scope: String,
        request: String,
        value: Option<String>,
    },
    GitList {
        scope: String,
        kind: String,
        offset: u32,
    },
    GitBranch {
        scope: String,
        name: String,
        create: bool,
    },
    GitStash {
        scope: String,
        operation: String,
        id: Option<String>,
        message: Option<String>,
    },
    GitConflict {
        scope: String,
        entry: String,
    },
    GitResolve {
        scope: String,
        entry: String,
        reviewed: String,
    },
    GitRevisionFiles {
        scope: String,
        commit: String,
    },
    GitRevisionDiff {
        scope: String,
        commit: String,
        entry: String,
    },
    TerminalOpen {
        scope: String,
        cols: u16,
        rows: u16,
    },
    TerminalList {
        scope: String,
    },
    TerminalAttach {
        scope: String,
        id: String,
    },
    TerminalRead {
        scope: String,
        id: String,
        token: String,
    },
    TerminalWrite {
        scope: String,
        id: String,
        token: String,
        sequence: u32,
        data: Vec<u8>,
    },
    TerminalResize {
        scope: String,
        id: String,
        token: String,
        cols: u16,
        rows: u16,
    },
    TerminalClose {
        scope: String,
        id: String,
    },
    UiRead {
        scope: String,
    },
    UiWrite {
        scope: String,
        tabs: Vec<String>,
        active: Option<String>,
        layout: Vec<f64>,
        #[serde(default)]
        split: Option<String>,
        #[serde(default)]
        #[ts(optional)]
        dock: Option<DockLayout>,
        #[serde(default)]
        #[ts(optional)]
        view: Option<ProjectView>,
    },
    Recoveries {
        scope: String,
    },
    TrashList {
        scope: String,
    },
    TrashRestore {
        scope: String,
        id: String,
    },
    ReplacePreview {
        scope: String,
        entries: Vec<String>,
        query: String,
        replacement: String,
        #[serde(default)]
        regex: bool,
    },
    ReplaceApply {
        scope: String,
        preview: String,
        entries: Vec<String>,
    },
    TerminalLayoutRead {
        scope: String,
    },
    TerminalLayoutWrite {
        scope: String,
        layout: TerminalLayout,
    },
    FinishClose,
    ClipboardRead,
    ClipboardWrite {
        text: String,
    },
    Diagnostics,
    StartupReady {
        visible: bool,
        painted: bool,
    },
    UpdateCheck,
    UpdateInstall,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Bootstrap {
        settings: Settings,
        project: Option<Project>,
        startup_issue: Option<String>,
    },
    Project {
        project: Project,
    },
    Entries {
        entries: Vec<Entry>,
        truncated: bool,
    },
    Media {
        media: Media,
    },
    Document {
        document: Document,
    },
    Reconciled {
        document: Document,
        refresh: Option<String>,
    },
    Saved {
        baseline: String,
        revision: u32,
    },
    GitStatus {
        status: GitStatus,
    },
    GitDecorations {
        decorations: Vec<GitDecoration>,
    },
    Diff {
        diff: Diff,
    },
    Items {
        items: Vec<NamedItem>,
        more: bool,
    },
    Search {
        matches: Vec<SearchMatch>,
        generation: u32,
        truncated: bool,
    },
    Text {
        text: String,
    },
    Terminal {
        info: TerminalInfo,
        token: String,
    },
    Terminals {
        terminals: Vec<TerminalInfo>,
    },
    TerminalData {
        chunk: TerminalChunk,
    },
    TerminalLayout {
        layout: TerminalLayout,
    },
    Ui {
        tabs: Vec<String>,
        active: Option<String>,
        layout: Vec<f64>,
        #[serde(default)]
        split: Option<String>,
        dock: Option<DockLayout>,
        view: ProjectView,
        persistence: Option<String>,
    },
    Persistence {
        warning: Option<String>,
    },
    GitConflict {
        conflict: GitConflict,
    },
    Replacement {
        id: String,
        files: Vec<Diff>,
        occurrences: u32,
    },
    Ok,
}

pub fn export_types() -> String {
    [
        Project::decl(),
        DockPanel::decl(),
        DockDirection::decl(),
        DockNode::decl(),
        DockLayout::decl(),
        ProjectView::decl(),
        Settings::decl(),
        Media::decl(),
        TerminalNode::decl(),
        TerminalTab::decl(),
        TerminalLayout::decl(),
        TerminalInfo::decl(),
        TerminalChunk::decl(),
        Entry::decl(),
        FilePathKind::decl(),
        Document::decl(),
        Change::decl(),
        GitFileStatus::decl(),
        GitDecoration::decl(),
        GitStatus::decl(),
        GitConflict::decl(),
        Diff::decl(),
        NamedItem::decl(),
        SearchMatch::decl(),
        StreamEvent::decl(),
        Request::decl(),
        Response::decl(),
        crate::error::AppError::decl(),
    ]
    .join("\n\n")
    .replace("type ", "export type ")
    .lines()
    .map(str::trim_end)
    .collect::<Vec<_>>()
    .join("\n")
        + "\n"
}
