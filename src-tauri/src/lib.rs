pub mod blame;
pub mod credentials;
pub mod dock;
#[cfg(unix)]
mod document_metadata;
pub mod document_preview;
pub mod documents;
pub mod dto;
pub mod error;
pub mod external_files;
pub mod file_clipboard;
pub mod file_copy;
pub mod file_paths;
pub mod file_transfer;
pub mod files;
pub mod git;
pub mod incoming_move;
#[cfg(windows)]
pub mod job;
pub mod launch;
#[cfg(target_os = "macos")]
mod macos_lifecycle;
pub mod media;
mod preferences;
pub mod process;
pub mod project_state;
mod project_windows;
pub mod search;
pub mod security;
pub mod storage;
pub mod terminal;
pub mod updates;
mod windows;
#[cfg(windows)]
pub mod windows_fs;
pub mod workspace;

use dto::*;
use error::{AppError, Result};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};
use tauri::{Manager, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use workspace::{UiState, Workspace};
static PROCESS_STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub struct EventBus {
    tx: std::sync::mpsc::SyncSender<StreamEvent>,
    target: Arc<Mutex<Option<(String, Channel<StreamEvent>)>>>,
    pub credentials: credentials::Pending,
}
impl EventBus {
    pub fn new() -> Arc<Self> {
        let (tx, rx) = std::sync::mpsc::sync_channel(128);
        let target: Arc<Mutex<Option<(String, Channel<StreamEvent>)>>> = Arc::new(Mutex::new(None));
        let sink = target.clone();
        std::thread::spawn(move || {
            while let Ok(event) = rx.recv() {
                if let Ok(t) = sink.lock() {
                    if let Some((scope, channel)) = &*t {
                        let event_scope = match &event {
                            StreamEvent::CloseRequested { scope }
                            | StreamEvent::SearchBatch { scope, .. }
                            | StreamEvent::Changed { scope, .. }
                            | StreamEvent::Credential { scope, .. } => scope,
                        };
                        if scope == event_scope {
                            let _ = channel.send(event);
                        }
                    }
                }
            }
        });
        Arc::new(Self {
            tx,
            target,
            credentials: Arc::new(Mutex::new(std::collections::HashMap::new())),
        })
    }
    pub fn emit(&self, event: StreamEvent) {
        if self.tx.try_send(event).is_err() {
            tracing::warn!("Native event queue overflow; focus reconciliation required");
        }
    }
    pub fn emit_wait(&self, event: StreamEvent) -> bool {
        self.tx.send(event).is_ok()
    }
}
struct MaintenanceGuard(Arc<AtomicBool>);
impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
pub struct Host {
    pub storage: storage::Storage,
    pub media_store: Arc<Mutex<std::collections::HashMap<String, (String, media::Preview)>>>,
    pub settings: Settings,
    pub workspace: Option<Workspace>,
    pub terminals: Arc<terminal::TerminalService>,
    pub terminal_context: Arc<RwLock<(Option<Project>, Settings)>>,
    pub maintenance: Arc<AtomicBool>,
    pub startup_issue: Option<String>,
    startup_ready_ms: Option<u64>,
    startup_visible: Option<bool>,
    watcher: Option<notify::RecommendedWatcher>,
    preferences: Option<Arc<preferences::Preferences>>,
    preferences_generation: u64,
    project_owner: Option<(Arc<project_windows::ProjectWindows>, String)>,
    closing: Arc<AtomicBool>,
}
pub struct AppState {
    pub media_store: Arc<Mutex<std::collections::HashMap<String, (String, media::Preview)>>>,
    pub host: Arc<Mutex<Host>>,
    pub bus: Arc<EventBus>,
    pub terminals: Arc<terminal::TerminalService>,
    pub terminal_context: Arc<RwLock<(Option<Project>, Settings)>>,
    pub maintenance: Arc<AtomicBool>,
    pub search: Arc<AtomicU32>,
    pub update: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    pub closing: Arc<AtomicBool>,
    pub close_requested: AtomicBool,
    pub decoration_worker: tokio::sync::Mutex<()>,
    pub decoration_generation: AtomicU64,
    pub blame_workers: tokio::sync::Semaphore,
    pub(crate) preferences: Arc<preferences::Preferences>,
    pub(crate) files: file_transfer::FileTransfers,
    pub(crate) launches: launch::LaunchRequests,
}
// Copy capabilities/paths under the host lock, then release it before any Git
// process. Revalidate authority before publishing; file operations never wait on
// a decoration scan. This helper is also exercised with a deliberately blocked Git.
fn read_decorations(host: &Arc<Mutex<Host>>, scope: &str, entries: &[String]) -> Result<Response> {
    let job = {
        let mut host = host
            .lock()
            .map_err(|_| AppError::new("internal", "Host unavailable"))?;
        let exe = host.tool("git")?;
        host.project(scope, true, false)?
            .decoration_read(&exe, entries)?
    };
    let response = job.read()?;
    let mut host = host
        .lock()
        .map_err(|_| AppError::new("internal", "Host unavailable"))?;
    let workspace = host.project(scope, true, false)?;
    if workspace
        .repository
        .as_deref()
        .unwrap_or(Path::new(&workspace.project.root))
        != job
            .repository
            .as_deref()
            .unwrap_or(Path::new(&job.project.root))
    {
        return Err(AppError::new("scope", "Selected repository changed"));
    }
    Ok(response)
}
fn read_blame(host: &Arc<Mutex<Host>>, scope: &str, entry: &str, text: String) -> Result<Response> {
    let job = {
        let mut host = host
            .lock()
            .map_err(|_| AppError::new("internal", "Host unavailable"))?;
        let exe = host.tool("git")?;
        host.project(scope, true, false)?
            .blame_read(&exe, entry, text)?
    };
    let response = job.read()?;
    let mut host = host
        .lock()
        .map_err(|_| AppError::new("internal", "Host unavailable"))?;
    let workspace = host.project(scope, true, false)?;
    if workspace.entry(entry)? != job.path || !workspace.documents.contains_key(entry) {
        return Err(AppError::new("scope", "Blame's document changed or closed"));
    }
    let (parent, _) = security::parent(&workspace.dir, &job.path)?;
    if security::identity_of_dir(
        &Path::new(&workspace.project.root).join(job.path.parent().unwrap_or(Path::new(""))),
        &parent,
    )? != job.parent_identity
    {
        return Err(AppError::new(
            "scope",
            "Blame's parent folder changed; reopen the file",
        ));
    }
    Ok(response)
}
fn read_file_path(
    host: &Arc<Mutex<Host>>,
    scope: &str,
    entry: &str,
    kind: FilePathKind,
) -> Result<Response> {
    let job = {
        let mut host = host
            .lock()
            .map_err(|_| AppError::new("internal", "Host unavailable"))?;
        host.project(scope, kind == FilePathKind::Git, false)?;
        let git = if kind == FilePathKind::Git {
            Some(host.tool("git")?)
        } else {
            None
        };
        host.project(scope, false, false)?
            .path_read(entry, kind, git)?
    };
    let text = job.read()?;
    let mut host = host
        .lock()
        .map_err(|_| AppError::new("internal", "Host unavailable"))?;
    let workspace = host.project(scope, kind == FilePathKind::Git, false)?;
    if workspace.project.root != job.project.root || workspace.document_path(entry)? != job.path {
        return Err(AppError::new(
            "scope",
            "The file moved while copying its path",
        ));
    }
    Ok(Response::Text { text })
}
impl Host {
    pub fn new(root: PathBuf) -> Result<Self> {
        let storage = storage::Storage::new(root)?;
        let (settings, startup_issue) = match workspace::load_settings(&storage) {
            Ok(settings) => (settings, None),
            Err(error) if ["corruptState", "stateVersion", "resourceLimit"].contains(&error.code.as_str()) => (
                workspace::default_settings(),
                Some("Saved preferences could not be loaded. Restore a validated previous backup or reset preferences. Existing editor checkpoints and retained state copies will be kept.".into()),
            ),
            Err(error) => return Err(error),
        };
        Ok(Self::with_settings(storage, settings, startup_issue))
    }
    fn with_settings(
        storage: storage::Storage,
        settings: Settings,
        startup_issue: Option<String>,
    ) -> Self {
        Self {
            storage,
            media_store: Default::default(),
            terminal_context: Arc::new(RwLock::new((None, settings.clone()))),
            maintenance: Arc::new(AtomicBool::new(false)),
            settings,
            startup_issue,
            startup_ready_ms: None,
            startup_visible: None,
            workspace: None,
            terminals: Arc::new(terminal::TerminalService::default()),
            watcher: None,
            preferences: None,
            preferences_generation: 0,
            project_owner: None,
            closing: Arc::new(AtomicBool::new(false)),
        }
    }
    fn with_preferences<T>(
        &mut self,
        write: bool,
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let shared = self.preferences.clone();
        let _guard = if write {
            shared
                .as_ref()
                .map(|p| {
                    p.gate
                        .lock()
                        .map_err(|_| AppError::new("internal", "Preferences unavailable"))
                })
                .transpose()?
        } else {
            None
        };
        if let Some(shared) = &shared {
            if let Some(current) = shared.changed_since(self.preferences_generation)? {
                self.settings = current.settings;
                self.startup_issue = current.issue;
                self.preferences_generation = current.generation;
                *self
                    .terminal_context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))? = (
                    self.workspace.as_ref().map(|w| w.project.clone()),
                    self.settings.clone(),
                );
            }
        }
        let result = operation(self);
        if write && result.is_ok() {
            if let Some(shared) = &shared {
                self.preferences_generation =
                    shared.publish(self.settings.clone(), self.startup_issue.clone())?;
            }
        }
        if write && result.is_err() {
            if let Some(shared) = &shared {
                let previous = shared.snapshot()?;
                self.settings = previous.settings;
                self.startup_issue = previous.issue;
                if let Some(workspace) = &mut self.workspace {
                    workspace.project.trusted = self
                        .settings
                        .recent
                        .iter()
                        .find(|p| p.id == workspace.project.id)
                        .is_some_and(|p| p.trusted);
                }
                *self
                    .terminal_context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))? = (
                    self.workspace.as_ref().map(|w| w.project.clone()),
                    self.settings.clone(),
                );
            }
        }
        result
    }
    fn configure_git(&mut self, executable: String) -> Result<Response> {
        self.with_preferences(true, |host| {
            if host.startup_issue.is_some() {
                return Err(AppError::new(
                    "repairRequired",
                    "Repair preferences before configuring tools",
                ));
            }
            host.settings.git = Some(executable);
            host.storage.write("settings.json", &host.settings)?;
            *host
                .terminal_context
                .write()
                .map_err(|_| AppError::new("internal", "Workspace unavailable"))? = (
                host.workspace.as_ref().map(|w| w.project.clone()),
                host.settings.clone(),
            );
            Ok(Response::Bootstrap {
                settings: host.settings.clone(),
                project: host.workspace.as_ref().map(|w| w.project.clone()),
                startup_issue: None,
            })
        })
    }
    pub fn project(
        &mut self,
        scope: &str,
        trusted: bool,
        mutation: bool,
    ) -> Result<&mut Workspace> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "unauthorized",
                "This workspace window is closed",
            ));
        }
        let w = self
            .workspace
            .as_mut()
            .ok_or_else(|| AppError::new("notFound", "Open a folder first"))?;
        w.authorize(scope, trusted, mutation)?;
        Ok(w)
    }
    pub fn tool(&self, tool: &str) -> Result<PathBuf> {
        let path = match tool {
            "git" => &self.settings.git,
            _ => return Err(AppError::new("scope", "Unknown executable")),
        };
        security::executable(path.as_deref().ok_or_else(|| {
            AppError::new(
                "missingExecutable",
                format!("{tool} is not configured; locate it in Settings"),
            )
        })?)
    }
    fn settings_with_project(&self, project: &Project) -> Settings {
        let mut settings = self.settings.clone();
        settings.recent.retain(|p| p.id != project.id);
        settings.recent.insert(0, project.clone());
        settings.recent.truncate(30);
        settings
    }
    fn relevant_watch_event(root: &Path, event: &notify::Event) -> bool {
        if event.need_rescan() {
            return true;
        }
        if matches!(event.kind, notify::EventKind::Access(_)) {
            return false;
        }
        // Workspace metadata is checked independently on read/write. Its own
        // atomic saves must not invalidate editor files or spawn Git scans.
        event.paths.is_empty()
            || !event.paths.iter().all(|path| {
                path.strip_prefix(root)
                    .ok()
                    .and_then(|relative| relative.components().next())
                    .is_some_and(|part| {
                        part.as_os_str()
                            .to_string_lossy()
                            .eq_ignore_ascii_case(".agent-workspace")
                    })
            })
    }
    fn watch_project(
        project: &Project,
        bus: Arc<EventBus>,
    ) -> Result<Option<notify::RecommendedWatcher>> {
        use notify::Watcher;
        let scope = project.id.clone();
        let root = PathBuf::from(&project.root);
        let last = Arc::new(Mutex::new(
            std::time::Instant::now() - std::time::Duration::from_secs(1),
        ));
        let mut watcher = notify::recommended_watcher(
            move |event: std::result::Result<notify::Event, notify::Error>| {
                if event
                    .as_ref()
                    .is_ok_and(|e| !Self::relevant_watch_event(&root, e))
                {
                    return;
                }
                if let Ok(mut last) = last.lock() {
                    if last.elapsed() > std::time::Duration::from_millis(300) {
                        *last = std::time::Instant::now();
                        bus.emit(StreamEvent::Changed {
                            scope: scope.clone(),
                            degraded: event.is_err(),
                        });
                    }
                }
            },
        )
        .map_err(|_| AppError::new("watcher", "Watcher setup failed; use explicit refresh"))?;
        if watcher
            .watch(Path::new(&project.root), notify::RecursiveMode::Recursive)
            .is_ok()
        {
            Ok(Some(watcher))
        } else {
            tracing::warn!("Watch unavailable; focus and explicit refresh remain active");
            Ok(None)
        }
    }
    fn handle(
        &mut self,
        request: Request,
        bus: Arc<EventBus>,
        cancel: Arc<AtomicU32>,
    ) -> Result<Response> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "unauthorized",
                "This workspace window is closed",
            ));
        }
        let write = matches!(
            &request,
            Request::Settings { .. }
                | Request::EditorOptions { .. }
                | Request::Trust { .. }
                | Request::OpenProject { .. }
                | Request::RelocateProject { .. }
                | Request::RepairSettings { .. }
        );
        self.with_preferences(write, |host| host.handle_inner(request, bus, cancel))
    }
    fn handle_inner(
        &mut self,
        request: Request,
        bus: Arc<EventBus>,
        cancel: Arc<AtomicU32>,
    ) -> Result<Response> {
        if self.maintenance.load(Ordering::SeqCst)
            && !matches!(
                request,
                Request::Bootstrap | Request::Diagnostics | Request::StartupReady { .. }
            )
        {
            return Err(AppError::new(
                "workspaceBusy",
                "A verified application update is in progress",
            ));
        }
        match request {
            Request::Bootstrap => Ok(Response::Bootstrap {
                settings: self.settings.clone(),
                project: self.workspace.as_ref().map(|w| w.project.clone()),
                startup_issue: self.startup_issue.clone(),
            }),
            Request::RepairSettings { restore_backup } => {
                if self.startup_issue.is_none() || self.workspace.is_some() {
                    return Err(AppError::new(
                        "scope",
                        "Preference repair is available only during startup recovery",
                    ));
                }
                let settings = workspace::repair_settings(&self.storage, restore_backup)?;
                self.settings = settings.clone();
                *self
                    .terminal_context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))? =
                    (None, settings.clone());
                self.startup_issue = None;
                Ok(Response::Bootstrap {
                    settings,
                    project: None,
                    startup_issue: None,
                })
            }
            _ if self.startup_issue.is_some() => Err(AppError::new(
                "repairRequired",
                "Repair preferences before opening a workspace",
            )),
            Request::OpenProject { path } => {
                let context = self.terminal_context.clone();
                let mut context = context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                if self.workspace.as_ref().is_some_and(Workspace::dirty) {
                    return Err(AppError::conflict(
                        "Save or discard unsaved buffers before switching projects",
                    ));
                }
                if self
                    .workspace
                    .as_ref()
                    .is_some_and(|w| w.activity.load(Ordering::SeqCst) != 0)
                {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "An application update is in progress",
                    ));
                }
                if !self.terminals.is_empty() {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "Close project terminals before switching folders",
                    ));
                }
                let w = Workspace::open(Path::new(&path), &self.settings.recent)?;
                let reservation = self
                    .project_owner
                    .as_ref()
                    .map(|(owners, label)| owners.reserve(label, &w.dir))
                    .transpose()?;
                let project = w.project.clone();
                let settings = self.settings_with_project(&project);
                let watcher = Self::watch_project(&project, bus)?;
                self.storage.write("settings.json", &settings)?;
                self.settings = settings;
                self.watcher = watcher;
                self.media_store
                    .lock()
                    .map_err(|_| AppError::new("internal", "Preview unavailable"))?
                    .clear();
                self.workspace = Some(w);
                if let Some(reservation) = reservation {
                    reservation.commit();
                }
                *context = (Some(project.clone()), self.settings.clone());
                Ok(Response::Project { project })
            }
            Request::RelocateProject { project: id, path } => {
                let previous = self
                    .settings
                    .recent
                    .iter()
                    .find(|p| p.id == id)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::new("scope", "Choose a recorded project to relocate")
                    })?;
                let same = self.workspace.as_ref().is_some_and(|w| w.project.id == id);
                if self
                    .workspace
                    .as_ref()
                    .is_some_and(|w| w.activity.load(Ordering::SeqCst) != 0)
                {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "Wait for the active project operation before locating a folder",
                    ));
                }
                if !same
                    && (self.workspace.as_ref().is_some_and(Workspace::dirty)
                        || !self.terminals.is_empty())
                {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "Save/discard files and close terminals before switching to another project",
                    ));
                }
                let mut next = Workspace::relocated(Path::new(&path), &previous)?;
                let reservation = self
                    .project_owner
                    .as_ref()
                    .map(|(owners, label)| owners.reserve(label, &next.dir))
                    .transpose()?;
                if same {
                    next.project.trusted = self
                        .workspace
                        .as_ref()
                        .expect("same project")
                        .project
                        .trusted;
                }
                let project = next.project.clone();
                let settings = self.settings_with_project(&project);
                let watcher = Self::watch_project(&project, bus)?;
                let context = self.terminal_context.clone();
                let mut context = context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                // Persist the additive binding before changing live authority. No
                // recovery/layout record is renamed, rewritten, or deleted.
                self.storage.write("settings.json", &settings)?;
                if same {
                    let current = self.workspace.as_mut().expect("same project");
                    current.project = project.clone();
                    current.dir = next.dir;
                    current.repository = None;
                    current.diffs.clear();
                    current.replacements.clear();
                    current.search_generation.fetch_add(1, Ordering::SeqCst);
                } else {
                    self.workspace = Some(next);
                }
                cancel.fetch_add(1, Ordering::SeqCst);
                if let Some(reservation) = reservation {
                    reservation.commit();
                }
                self.settings = settings;
                self.watcher = watcher;
                *context = (Some(project.clone()), self.settings.clone());
                Ok(Response::Project { project })
            }
            Request::Trust { scope, trusted } => {
                let context = self.terminal_context.clone();
                let mut context = context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                let w = self.project(&scope, false, false)?;
                w.project.trusted = trusted;
                let project = w.project.clone();
                for p in &mut self.settings.recent {
                    if p.id == scope {
                        p.trusted = trusted;
                    }
                }
                self.storage.write("settings.json", &self.settings)?;
                *context = (Some(project.clone()), self.settings.clone());
                Ok(Response::Project { project })
            }
            Request::EditorOptions {
                soft_wrap,
                line_numbers,
            } => {
                let mut settings = self.settings.clone();
                if let Some(value) = soft_wrap {
                    settings.editor_soft_wrap = value;
                }
                if let Some(value) = line_numbers {
                    settings.editor_line_numbers = value;
                }
                self.handle_inner(Request::Settings { settings }, bus, cancel)
            }
            Request::Settings { mut settings } => {
                if !workspace::validate_keybindings(&settings)
                    || settings.version != 2
                    || !["dark", "light"].contains(&settings.theme.as_str())
                    || !(10..=32).contains(&settings.font_size)
                    || !(10..=32).contains(&settings.terminal_font_size)
                    || !(100..=50000).contains(&settings.terminal_scrollback)
                    || !(1..=300).contains(&settings.auto_save_delay)
                    || settings.shell_args.len() > 32
                    || settings
                        .shell_args
                        .iter()
                        .any(|a| a.len() > 4096 || a.contains('\0'))
                {
                    return Err(AppError::new("input", "Invalid settings"));
                }
                for p in [&settings.git, &settings.shell].into_iter().flatten() {
                    security::executable(p)?;
                }
                settings.recent = self.settings.recent.clone();
                self.storage.write("settings.json", &settings)?;
                self.settings = settings.clone();
                *self
                    .terminal_context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))? = (
                    self.workspace.as_ref().map(|w| w.project.clone()),
                    settings.clone(),
                );
                Ok(Response::Bootstrap {
                    settings,
                    project: self.workspace.as_ref().map(|w| w.project.clone()),
                    startup_issue: None,
                })
            }
            Request::CheckRuntime { tool } => {
                let exe = self.tool(&tool)?;
                let out = process::run(
                    &exe,
                    Path::new(&self.storage.root),
                    &["--version".as_ref()],
                    None,
                    std::time::Duration::from_secs(10),
                )?;
                if !out.success {
                    return Err(AppError::new("runtime", "Version check failed"));
                }
                Ok(Response::Text {
                    text: String::from_utf8_lossy(&out.stdout)
                        .chars()
                        .take(1024)
                        .collect(),
                })
            }
            Request::List { scope, parent } => {
                self.project(&scope, false, false)?.list(parent.as_deref())
            }
            Request::RevealEntry { scope, entry } => {
                self.project(&scope, false, false)?.reveal_entry(&entry)
            }
            Request::FilePath { scope, entry, kind } => {
                // Real IPC uses the detached read branch. Preserve trust/scope
                // checks for direct host callers without running Git under this lock.
                self.project(&scope, kind == FilePathKind::Git, false)?
                    .entry(&entry)?;
                Err(AppError::new(
                    "internal",
                    "File paths require the read dispatcher",
                ))
            }
            Request::ReconcileDocument { scope, document } => {
                self.project(&scope, false, false)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .reconcile_document(&document, &self.storage)
            }
            Request::FinishReconcile {
                scope,
                refresh,
                accept,
            } => self
                .project(&scope, false, false)?
                .finish_reconcile(&refresh, accept),
            Request::CopyFiles { .. }
            | Request::PasteFiles { .. }
            | Request::StartFileDrag { .. }
            | Request::OpenDroppedFiles { .. }
            | Request::MoveDroppedFiles { .. }
            | Request::InspectDroppedMove { .. } => Err(AppError::new(
                "scope",
                "Native file transfer requires an OS offer or gesture",
            )),
            Request::OpenFile { scope, entry } => {
                self.project(&scope, false, false)?.document_path(&entry)?;
                // Text buffers/recovery outrank extension-based previews. This
                // also reaches document recovery when the original SVG is gone.
                let existing = self
                    .workspace
                    .as_ref()
                    .expect("validated")
                    .documents
                    .contains_key(&entry);
                let recovery = self
                    .storage
                    .root
                    .join(format!("recovery-{entry}.json"))
                    .exists();
                let media = if existing || recovery {
                    None
                } else {
                    self.project(&scope, false, false)?.media_open(&entry)?
                };
                if let Some(media) = media {
                    let preview =
                        self.workspace.as_ref().expect("validated").media[&media.token].clone();
                    let mut store = self
                        .media_store
                        .lock()
                        .map_err(|_| AppError::new("internal", "Preview unavailable"))?;
                    if store.len() >= 64
                        && !store.values().any(|(_, value)| value.info.entry == entry)
                    {
                        self.workspace
                            .as_mut()
                            .expect("validated")
                            .media
                            .remove(&media.token);
                        return Err(AppError::new(
                            "resourceLimit",
                            "Close a media tab before opening another preview (64 open previews).",
                        ));
                    }
                    store.retain(|_, (_, value)| value.embedded || value.info.entry != entry);
                    store.insert(media.token.clone(), (scope, preview));
                    return Ok(Response::Media { media });
                }
                self.project(&scope, false, false)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .document_open(&entry, &self.storage)
            }
            Request::CloseMedia { scope, token } => {
                self.project(&scope, false, false)?.media.remove(&token);
                self.media_store
                    .lock()
                    .map_err(|_| AppError::new("internal", "Preview unavailable"))?
                    .remove(&token);
                Ok(Response::Ok)
            }
            Request::PreviewLink {
                scope,
                document,
                href,
            } => {
                let entry = self
                    .project(&scope, false, false)?
                    .preview_link(&document, &href)?;
                Ok(Response::Entries {
                    entries: vec![entry],
                    truncated: false,
                })
            }
            Request::PreviewImage {
                scope,
                document,
                href,
            } => {
                let media = self
                    .project(&scope, false, false)?
                    .preview_image(&document, &href)?;
                let preview =
                    self.workspace.as_ref().expect("validated").media[&media.token].clone();
                let mut store = self
                    .media_store
                    .lock()
                    .map_err(|_| AppError::new("internal", "Preview unavailable"))?;
                if store.len() >= 64 {
                    self.workspace
                        .as_mut()
                        .expect("validated")
                        .media
                        .remove(&media.token);
                    return Err(AppError::limit());
                }
                store.insert(media.token.clone(), (scope, preview));
                Ok(Response::Media { media })
            }
            Request::OpenDocument { scope, entry } => {
                self.project(&scope, false, false)?
                    .refreshes
                    .retain(|_, r| r.document != entry);
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .document_open(&entry, &self.storage)
            }
            Request::Checkpoint {
                scope,
                document,
                text,
                revision,
                baseline,
            } => {
                let w = self.project(&scope, false, false)?;
                if !w
                    .documents
                    .get(&document)
                    .is_some_and(|d| d.dto.baseline == baseline)
                {
                    return Err(AppError::conflict(
                        "Checkpoint baseline changed; unsaved editor text retained",
                    ));
                }
                self.workspace.as_mut().expect("validated").checkpoint(
                    &document,
                    &text,
                    revision,
                    &self.storage,
                )
            }
            Request::ReviewMetadata { scope, document } => self
                .project(&scope, false, false)?
                .review_metadata(&document),
            Request::AllowMetadataLoss {
                scope,
                document,
                review,
            } => self
                .project(&scope, true, true)?
                .allow_metadata_loss(&document, &review),
            Request::Save {
                scope,
                document,
                text,
                revision,
                baseline,
            } => {
                self.project(&scope, true, true)?;
                self.workspace.as_mut().expect("validated").save(
                    &document,
                    &text,
                    revision,
                    &baseline,
                    &self.storage,
                )
            }
            Request::Discard { scope, document } => {
                self.project(&scope, false, false)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .discard(&document, &self.storage)
            }
            Request::DocumentCompare { scope, document } => {
                self.project(&scope, false, false)?.compare(&document)
            }
            Request::ReviewDisk {
                scope,
                document,
                reviewed,
            } => {
                self.project(&scope, true, true)?;
                self.workspace.as_mut().expect("validated").review_disk(
                    &document,
                    &reviewed,
                    &self.storage,
                )
            }
            Request::CloseDocument { scope, document } => {
                let w = self.project(&scope, false, false)?;
                if w.documents.get(&document).is_some_and(|d| d.dirty) {
                    return Err(AppError::conflict(
                        "Unsaved buffer; save or discard before closing",
                    ));
                }
                w.documents.remove(&document);
                w.refreshes.retain(|_, r| r.document != document);
                Ok(Response::Ok)
            }
            Request::Create {
                scope,
                parent,
                name,
                directory,
            } => self
                .project(&scope, true, true)?
                .create(parent.as_deref(), &name, directory),
            Request::MoveEntry {
                scope,
                entry,
                parent,
            } => self
                .project(&scope, true, true)?
                .move_entry(&entry, parent.as_deref()),
            Request::Rename {
                scope,
                entry,
                parent,
                name,
            } => self
                .project(&scope, true, true)?
                .rename_entry(&entry, parent.as_deref(), &name),
            Request::Delete { scope, entry } => {
                self.project(&scope, true, true)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .delete_entry(&entry, &self.storage)
            }
            Request::ReviewDelete { scope, entry } => {
                self.project(&scope, true, true)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .review_delete(&entry, &self.storage)
            }
            Request::DeletePermanently {
                scope,
                entry,
                review,
            } => {
                self.project(&scope, true, true)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .delete_permanently(&entry, &review, &self.storage)
            }
            Request::Search {
                scope,
                query,
                names,
                ignored,
                regex,
                generation,
            } => search::search(
                self.project(&scope, false, false)?,
                &query,
                names,
                ignored,
                regex,
                generation,
                cancel,
                Some(bus),
            ),
            Request::ReleaseViews {
                scope,
                diffs,
                previews,
            } => self
                .project(&scope, false, false)?
                .release_views(&diffs, &previews),
            Request::GitStatus { scope, repository } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_status(&exe, repository.as_deref())
            }
            Request::GitDecorations { scope, entries } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_decorations(&exe, &entries)
            }
            Request::GitBlame { scope, entry, text } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .blame_read(&exe, &entry, text)?
                    .read()
            }
            Request::GitDiff {
                scope,
                entry,
                staged,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_diff(&exe, &entry, staged)
            }
            Request::GitStage {
                scope,
                entry,
                unstage,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, true)?
                    .git_stage(&exe, &entry, unstage)
            }
            Request::GitHunk {
                scope,
                diff,
                hunk,
                unstage,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, true)?
                    .git_hunk(&exe, &diff, hunk, unstage)
            }
            Request::GitCommit {
                scope,
                message,
                reviewed,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, true)?
                    .git_commit(&exe, &message, &reviewed)
            }
            Request::GitNetwork { scope, operation } => {
                let exe = self.tool("git")?;
                let w = self.project(&scope, true, true)?;
                if operation == "pull" && w.dirty() {
                    return Err(AppError::conflict("Save or discard buffers before pull"));
                }
                let session = credentials::CredentialSession::new(
                    scope,
                    bus.clone(),
                    bus.credentials.clone(),
                )?;
                w.git_network_auth(&exe, &operation, &session.environment)
            }
            Request::GitPublish { scope, remote } => {
                let exe = self.tool("git")?;
                let w = self.project(&scope, true, true)?;
                let session = credentials::CredentialSession::new(
                    scope,
                    bus.clone(),
                    bus.credentials.clone(),
                )?;
                w.git_publish(&exe, &remote, &session.environment)
            }
            Request::GitShow { scope, commit } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?.git_show(&exe, &commit)
            }
            Request::GitList {
                scope,
                kind,
                offset,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_list(&exe, &kind, offset)
            }
            Request::GitBranch {
                scope,
                name,
                create,
            } => {
                let exe = self.tool("git")?;
                let w = self.project(&scope, true, true)?;
                if w.dirty() {
                    return Err(AppError::conflict(
                        "Save or discard buffers before switching branches",
                    ));
                }
                w.git_branch(&exe, &name, create)
            }
            Request::GitStash {
                scope,
                operation,
                id,
                message,
            } => {
                let exe = self.tool("git")?;
                let w = self.project(&scope, true, true)?;
                if w.dirty() {
                    return Err(AppError::conflict(
                        "Save/discard buffers before stash operations",
                    ));
                }
                w.git_stash(&exe, &operation, id.as_deref(), message.as_deref())
            }
            Request::GitResolve {
                scope,
                entry,
                reviewed,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, true)?
                    .git_resolve(&exe, &entry, &reviewed)
            }
            Request::GitRevisionFiles { scope, commit } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_revision_files(&exe, &commit)
            }
            Request::GitRevisionDiff {
                scope,
                commit,
                entry,
            } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_revision_diff(&exe, &commit, &entry)
            }
            Request::GitConflict { scope, entry } => {
                let exe = self.tool("git")?;
                self.project(&scope, true, false)?
                    .git_conflict(&exe, &entry)
            }
            Request::TerminalOpen { .. }
            | Request::TerminalList { .. }
            | Request::TerminalAttach { .. }
            | Request::TerminalRead { .. }
            | Request::TerminalWrite { .. }
            | Request::TerminalResize { .. }
            | Request::TerminalClose { .. }
            | Request::FinishClose
            | Request::ClipboardHasFiles
            | Request::ClipboardRead
            | Request::ClipboardWrite { .. } => Err(AppError::new(
                "internal",
                "Terminal requests require their independent service",
            )),
            Request::ReplacePreview {
                scope,
                entries,
                query,
                replacement,
                regex,
            } => {
                self.project(&scope, true, false)?;
                self.workspace.as_mut().expect("validated").replace_preview(
                    entries,
                    &query,
                    &replacement,
                    regex,
                    &self.storage,
                )
            }
            Request::ReplaceApply {
                scope,
                preview,
                entries,
            } => {
                self.project(&scope, true, true)?;
                self.workspace.as_mut().expect("validated").replace_apply(
                    &preview,
                    entries,
                    &self.storage,
                )
            }
            Request::TerminalLayoutRead { scope } => {
                self.project(&scope, false, false)?;
                let layout = project_state::terminal(
                    self.workspace.as_mut().expect("validated"),
                    &self.storage,
                )?;
                Ok(Response::TerminalLayout { layout })
            }
            Request::RepairLayout { scope, terminal } => {
                self.project(&scope, false, false)?;
                project_state::repair(
                    self.workspace.as_mut().expect("validated"),
                    &self.storage,
                    terminal,
                )?;
                Ok(Response::Ok)
            }
            Request::TerminalLayoutWrite { scope, layout } => {
                self.project(&scope, false, false)?;
                let warning = project_state::save_terminal(
                    self.workspace.as_mut().expect("validated"),
                    &self.storage,
                    layout,
                )?;
                Ok(Response::Persistence { warning })
            }
            Request::UiRead { scope } => {
                self.project(&scope, false, false)?;
                self.workspace.as_mut().expect("validated").project_state = None;
                let ui =
                    project_state::ui(self.workspace.as_mut().expect("validated"), &self.storage)?;
                let external = self
                    .storage
                    .read::<external_files::ExternalUi>(&format!("external-ui-{scope}.json"))?
                    .unwrap_or_default();
                if external.version > 1 || external.tabs.len() > 100 {
                    return Err(AppError::new(
                        "stateVersion",
                        "External file tab state is unsupported; recovery is retained.",
                    ));
                }
                let w = self.workspace.as_mut().expect("validated");
                let mut external_active = None;
                let mut external_split = None;
                let mut external_tabs = Vec::new();
                for path in &external.tabs {
                    // Missing files are left out of layout; acknowledged recovery stays private.
                    if let Ok(entry) = w.register_dropped_file(path) {
                        if Some(path) == external.active.as_ref() {
                            external_active = Some(entry.id.clone());
                        }
                        if Some(path) == external.split.as_ref() {
                            external_split = Some(entry.id.clone());
                        }
                        external_tabs.push(entry.id);
                    }
                }
                let mut tabs = ui
                    .tabs
                    .iter()
                    .map(|p| documents::token_path(p).map(|p| w.register(p)))
                    .collect::<Result<Vec<_>>>()?;
                tabs.extend(external_tabs);
                // Renderer reload/layout repair must neither orphan dirty
                // native records nor leave invisible clean editor references.
                for (id, document) in &w.documents {
                    if document.dirty && !tabs.contains(id) {
                        tabs.push(id.clone());
                    }
                }
                w.documents.retain(|id, d| d.dirty || tabs.contains(id));
                w.refreshes
                    .retain(|_, r| w.documents.contains_key(&r.document));
                let active = ui
                    .active
                    .map(|p| documents::token_path(&p).map(|p| w.register(p)))
                    .transpose()?;
                let mut view = ui.view;
                view.expanded = view
                    .expanded
                    .iter()
                    .map(|p| documents::token_path(p).map(|p| w.register(p)))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Response::Ui {
                    view,
                    persistence: w.project_state.as_ref().and_then(|c| c.warning.clone()),
                    dock: ui.dock,
                    tabs,
                    active: external_active.or(active),
                    layout: ui.layout,
                    split: external_split.or(ui
                        .split
                        .map(|p| documents::token_path(&p).map(|p| w.register(p)))
                        .transpose()?),
                })
            }
            Request::UiWrite {
                scope,
                tabs,
                active,
                layout,
                split,
                dock,
                view,
            } => {
                if tabs.len() > 100
                    || layout.len() > 8
                    || layout
                        .iter()
                        .any(|n| !n.is_finite() || *n < 0.0 || *n > 100.0)
                {
                    return Err(AppError::limit());
                }
                if let Some(dock) = &dock {
                    dock::validate(dock)?;
                }
                let w = self.project(&scope, false, false)?;
                let mut view = view.unwrap_or_default();
                if view.expanded.len() > 512 {
                    return Err(AppError::limit());
                }
                view.expanded = view
                    .expanded
                    .iter()
                    .map(|id| w.entry(id).map(|p| documents::path_token(&p)))
                    .collect::<Result<Vec<_>>>()?;
                let external = w.external_ui(&tabs, &active, &split);
                let ui = UiState {
                    view,
                    version: 2,
                    dock,
                    tabs: tabs
                        .iter()
                        .filter(|id| !w.external_files.contains_key(*id))
                        .map(|id| w.entry(id).map(|p| documents::path_token(&p)))
                        .collect::<Result<Vec<_>>>()?,
                    active: active
                        .filter(|id| !w.external_files.contains_key(id))
                        .map(|id| w.entry(&id).map(|p| documents::path_token(&p)))
                        .transpose()?,
                    layout,
                    split: split
                        .filter(|id| !w.external_files.contains_key(id))
                        .map(|id| w.entry(&id).map(|p| documents::path_token(&p)))
                        .transpose()?,
                };
                let external_name = format!("external-ui-{scope}.json");
                let previous = self
                    .storage
                    .read::<external_files::ExternalUi>(&external_name)?;
                if previous.as_ref() != Some(&external)
                    && (previous.is_some() || !external.tabs.is_empty())
                {
                    self.storage.write(&external_name, &external)?;
                }
                let keep: std::collections::HashSet<_> = tabs.iter().cloned().collect();
                let w = self.workspace.as_mut().expect("validated");
                w.external_files.retain(|id, _| {
                    keep.contains(id)
                        || w.documents.contains_key(id)
                        || w.media.values().any(|preview| preview.info.entry == *id)
                });
                let warning = project_state::save_ui(
                    self.workspace.as_mut().expect("validated"),
                    &self.storage,
                    ui,
                )?;
                Ok(Response::Persistence { warning })
            }
            Request::TrashList { scope } => {
                self.project(&scope, false, false)?;
                files::trash_list(&scope, &self.storage)
            }
            Request::TrashRestore { scope, id } => {
                self.project(&scope, true, true)?;
                self.workspace
                    .as_mut()
                    .expect("validated")
                    .trash_restore(&id, &self.storage)
            }
            Request::Recoveries { scope } => {
                self.project(&scope, false, false)?;
                let mut items = Vec::new();
                for e in std::fs::read_dir(&self.storage.root)? {
                    let e = e?;
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    if !name.starts_with("recovery-") || !name.ends_with(".json") {
                        continue;
                    }
                    if let Some(r) = self.storage.read::<documents::Recovery>(&name)? {
                        if r.scope == scope {
                            if let Some(path) = r.external.as_ref() {
                                let entry = self
                                    .workspace
                                    .as_mut()
                                    .expect("validated")
                                    .register_external_recovery(path, &r.entry)?;
                                if entry.id != r.entry {
                                    return Err(AppError::new(
                                        "scope",
                                        "External recovery identity mismatch",
                                    ));
                                }
                                items.push(NamedItem {
                                    id: entry.id,
                                    label: entry.path,
                                    detail: format!(
                                        "External file · acknowledged checkpoint {}",
                                        r.revision
                                    ),
                                });
                                continue;
                            }
                            let p = documents::token_path(&r.path)?;
                            let id = self
                                .workspace
                                .as_mut()
                                .expect("validated")
                                .register(p.clone());
                            items.push(NamedItem {
                                id,
                                label: security::display(&p),
                                detail: format!("Acknowledged checkpoint {}", r.revision),
                            });
                        }
                    }
                }
                Ok(Response::Items { items, more: false })
            }
            Request::StartupReady { visible, painted } => {
                if self.startup_ready_ms.is_none() {
                    if let Some(started) = PROCESS_STARTED.get() {
                        let elapsed = started.elapsed().as_millis() as u64;
                        self.startup_ready_ms = Some(elapsed);
                        self.startup_visible = Some(visible && painted);
                        // Aggregate diagnostics only: no paths, input, buffers
                        // or credentials. Also usable by normal-build profiling.
                        eprintln!(
                            "AW_METRIC startup_ready_ms={elapsed} pid={} visible={visible} painted={painted}",
                            std::process::id()
                        );
                    }
                }
                Ok(Response::Ok)
            }
            Request::Diagnostics => Ok(Response::Text {
                text: format!(
                    "Workspace 0.1.0\nOS: {} / {}\nProject open: {}\nNative terminals: {}\nStartup UI ready (ms): {:?}\nStartup view visible: {:?}\nNo file contents, recovery buffers, credentials or terminal transcripts included.\nCopy this preview explicitly to share it.",
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    self.workspace.is_some(),
                    self.terminals.len(),
                    self.startup_ready_ms,
                    self.startup_visible
                ),
            }),
            _ => Err(AppError::new(
                "scope",
                "Operation requires asynchronous service",
            )),
        }
    }
}

fn window_allowed(label: &str) -> Result<()> {
    if label != "main"
        && !label
            .strip_prefix("workspace-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        Err(AppError::new(
            "unauthorized",
            "This window has no workspace authority",
        ))
    } else {
        Ok(())
    }
}
fn navigation_allowed(url: &tauri::Url, development: bool) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None) => {
            true
        }
        ("http", Some("127.0.0.1"), Some(1420)) => development,
        _ => false,
    }
}
#[tauri::command]
async fn subscribe(
    window: tauri::WebviewWindow,
    scope: String,
    channel: Channel<StreamEvent>,
) -> Result<()> {
    let state = windows::state(window.app_handle(), window.label())?;
    state
        .host
        .lock()
        .map_err(|_| AppError::new("internal", "Host unavailable"))?
        .project(&scope, false, false)?;
    *state
        .bus
        .target
        .lock()
        .map_err(|_| AppError::new("internal", "Stream unavailable"))? = Some((scope, channel));
    if state.close_requested.load(Ordering::SeqCst) {
        if let Some(project) = &state
            .terminal_context
            .read()
            .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
            .0
        {
            state.bus.emit(StreamEvent::CloseRequested {
                scope: project.id.clone(),
            });
        }
    }
    Ok(())
}

#[tauri::command]
async fn dispatch(window: tauri::WebviewWindow, request: Request) -> Result<Response> {
    let state = windows::state(window.app_handle(), window.label())?;
    if state.maintenance.load(Ordering::SeqCst)
        && !matches!(
            request,
            Request::Bootstrap
                | Request::Diagnostics
                | Request::StartupReady { .. }
                | Request::TerminalRead { .. }
                | Request::TerminalResize { .. }
                | Request::TerminalClose { .. }
                | Request::ClipboardHasFiles
                | Request::ClipboardRead
                | Request::ClipboardWrite { .. }
                | Request::CancelClose
        )
    {
        return Err(AppError::new(
            "workspaceBusy",
            "A verified application update is in progress",
        ));
    }
    match request {
        Request::Bootstrap => {
            let preferences = state.preferences.snapshot()?;
            let context = state
                .terminal_context
                .read()
                .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
            Ok(Response::Bootstrap {
                settings: preferences.settings,
                project: context.0.clone(),
                startup_issue: preferences.issue,
            })
        }
        Request::NewWindow { path } => {
            windows::open(window.app_handle().clone(), path, false).await
        }
        Request::QuitApplication => {
            window.app_handle().exit(0);
            Ok(Response::Ok)
        }
        Request::FocusProjectWindow { path } => {
            if path.len() > 8192 || path.contains('\0') {
                return Err(AppError::limit());
            }
            let registry = window.state::<windows::Windows>();
            let owner = match registry.projects.owner(Path::new(&path)) {
                Ok(owner) => owner,
                Err(e) if e.code == "notFound" => None,
                Err(e) => return Err(e),
            };
            if let Some(owner) = &owner {
                windows::focus(window.app_handle(), owner);
            }
            Ok(Response::WindowOpened {
                existing: owner.is_some(),
                window: owner,
            })
        }
        Request::CancelClose => {
            state.close_requested.store(false, Ordering::SeqCst);
            window.state::<windows::Windows>().cancel_close();
            Ok(Response::Ok)
        }
        Request::InspectDroppedMove { scope, offer } => {
            let paths = state.files.peek(&offer)?;
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || {
                host.lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .project(&scope, true, false)?
                    .inspect_dropped_move(&paths)
            })
            .await
            .map_err(|_| AppError::new("internal", "Drop preview failed"))?
        }
        Request::MoveDroppedFiles {
            scope,
            offer,
            parent,
        } => {
            let paths = state.files.take(&offer)?;
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let job = host
                    .lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .project(&scope, true, true)?
                    .prepare_dropped_move(&paths, parent.as_deref())?;
                let result = job.execute();
                let response = host
                    .lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .project(&scope, true, false)?
                    .finish_dropped_move(&result);
                drop(job);
                response
            })
            .await
            .map_err(|_| AppError::new("internal", "File move failed"))?
        }
        Request::CopyFiles { scope, entries } => {
            let host = state.host.clone();
            let paths = tauri::async_runtime::spawn_blocking(move || {
                host.lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .project(&scope, false, false)?
                    .clipboard_paths(&entries)
            })
            .await
            .map_err(|_| AppError::new("internal", "File copy worker failed"))??;
            file_clipboard::write(window.app_handle().clone(), paths).await?;
            Ok(Response::Ok)
        }
        Request::PasteFiles { scope, parent } => {
            state
                .host
                .lock()
                .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                .project(&scope, true, true)?;
            // Read only in response to the user's explicit Paste. Absolute paths
            // originate in the OS clipboard, never in a renderer request.
            let paths = file_clipboard::read(window.app_handle().clone()).await?;
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let job = {
                    let mut current = host
                        .lock()
                        .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                    let storage = current.storage.root.clone();
                    current.project(&scope, true, true)?.prepare_file_copy(
                        &paths,
                        parent.as_deref(),
                        &storage,
                    )?
                };
                Ok(job.execute(|job, stage| {
                    let mut current = host
                        .lock()
                        .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                    job.publish(current.project(&scope, true, true)?, stage)
                }))
            })
            .await
            .map_err(|_| AppError::new("internal", "Pasting files failed"))?
        }
        Request::StartFileDrag { scope, entries } => {
            file_transfer::start_drag(window, scope, entries).await
        }
        Request::OpenDroppedFiles { scope, offer } => {
            let paths = state.files.take(&offer)?;
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || {
                host.lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .project(&scope, false, false)?
                    .dropped_files(&paths)
            })
            .await
            .map_err(|_| AppError::new("internal", "File drop worker failed"))?
        }
        Request::FilePath { scope, entry, kind } => {
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || {
                read_file_path(&host, &scope, &entry, kind)
            })
            .await
            .map_err(|_| AppError::new("internal", "Path worker failed"))?
        }
        Request::GitDecorations { scope, entries } => {
            let generation = state
                .decoration_generation
                .fetch_add(1, Ordering::SeqCst)
                .wrapping_add(1);
            let _worker = state.decoration_worker.lock().await;
            if state.decoration_generation.load(Ordering::SeqCst) != generation {
                return Err(AppError::new("cancelled", "Superseded color refresh"));
            }
            let host = state.host.clone();
            let response = tauri::async_runtime::spawn_blocking(move || {
                read_decorations(&host, &scope, &entries)
            })
            .await
            .map_err(|_| AppError::new("internal", "Color worker failed"))??;
            if state.decoration_generation.load(Ordering::SeqCst) != generation {
                return Err(AppError::new("cancelled", "Superseded color refresh"));
            }
            Ok(response)
        }
        Request::GitBlame { scope, entry, text } => {
            let _permit = state.blame_workers.try_acquire().map_err(|_| {
                AppError::new(
                    "workspaceBusy",
                    "Other blame annotations are loading; try again shortly",
                )
            })?;
            let host = state.host.clone();
            tauri::async_runtime::spawn_blocking(move || read_blame(&host, &scope, &entry, text))
                .await
                .map_err(|_| AppError::new("internal", "Git blame worker failed"))?
        }
        Request::TakeOpenRequest => Ok(Response::Text {
            text: state.launches.take().unwrap_or_default(),
        }),
        Request::FinishClose => {
            let h = state
                .host
                .lock()
                .map_err(|_| AppError::new("internal", "Host unavailable"))?;
            let _context = state
                .terminal_context
                .write()
                .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
            if !h.terminals.is_empty()
                || h.workspace
                    .as_ref()
                    .is_some_and(|w| w.dirty() || w.activity.load(Ordering::SeqCst) != 0)
            {
                return Err(AppError::conflict(
                    "Resolve unsaved files and terminals before quitting",
                ));
            }
            state.closing.store(true, Ordering::SeqCst);
            if window.destroy().is_err() {
                state.closing.store(false, Ordering::SeqCst);
                return Err(AppError::new("window", "Unable to close window"));
            }
            Ok(Response::Ok)
        }
        Request::ClipboardHasFiles => Ok(Response::ClipboardFiles {
            available: file_clipboard::has_files(window.app_handle().clone()).await?,
        }),
        Request::ClipboardRead => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = window.app_handle().clipboard().read_text().map_err(|_| {
                AppError::new("clipboard", "Unable to read text from the clipboard")
            })?;
            if text.len() > 1024 * 1024 {
                return Err(AppError::limit());
            }
            Ok(Response::Text { text })
        }
        Request::ClipboardWrite { text } => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            if text.len() > 1024 * 1024 {
                return Err(AppError::limit());
            }
            window
                .app_handle()
                .clipboard()
                .write_text(text)
                .map_err(|_| AppError::new("clipboard", "Unable to write text to the clipboard"))?;
            Ok(Response::Ok)
        }
        request @ (Request::TerminalOpen { .. }
        | Request::TerminalList { .. }
        | Request::TerminalAttach { .. }
        | Request::TerminalRead { .. }
        | Request::TerminalWrite { .. }
        | Request::TerminalResize { .. }
        | Request::TerminalClose { .. }) => {
            let context = state.terminal_context.clone();
            let preferences = state.preferences.clone();
            let closing = state.closing.clone();
            let terminals = state.terminals.clone();
            let maintenance = state.maintenance.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let context = context
                    .read()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                let scope = match &request {
                    Request::TerminalOpen { scope, .. }
                    | Request::TerminalList { scope }
                    | Request::TerminalAttach { scope, .. }
                    | Request::TerminalRead { scope, .. }
                    | Request::TerminalWrite { scope, .. }
                    | Request::TerminalResize { scope, .. }
                    | Request::TerminalClose { scope, .. } => scope,
                    _ => unreachable!(),
                };
                if closing.load(Ordering::SeqCst) {
                    return Err(AppError::new(
                        "unauthorized",
                        "This workspace window is closed",
                    ));
                }
                let project = context
                    .0
                    .as_ref()
                    .filter(|p| p.id == *scope)
                    .ok_or_else(|| AppError::new("scope", "Terminal workspace changed"))?;
                if matches!(
                    request,
                    Request::TerminalOpen { .. } | Request::TerminalWrite { .. }
                ) && maintenance.load(Ordering::SeqCst)
                {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "An application update is in progress",
                    ));
                }
                if matches!(
                    request,
                    Request::TerminalOpen { .. } | Request::TerminalWrite { .. }
                ) {
                    if !project.trusted {
                        return Err(AppError::new(
                            "untrusted",
                            "Trust this folder before using terminal input",
                        ));
                    }
                    if security::project_identity(project)? != *scope {
                        return Err(AppError::new("scope", "Workspace identity changed"));
                    }
                }
                match request {
                    Request::TerminalOpen { scope, cols, rows } => {
                        let (info, token) = terminals.open(
                            &scope,
                            Path::new(&project.root),
                            cols,
                            rows,
                            &preferences.snapshot()?.settings,
                        )?;
                        Ok(Response::Terminal { info, token })
                    }
                    Request::TerminalList { scope } => Ok(Response::Terminals {
                        terminals: terminals.list(&scope)?,
                    }),
                    Request::TerminalAttach { scope, id } => {
                        let (info, token) = terminals.attach(&scope, &id)?;
                        Ok(Response::Terminal { info, token })
                    }
                    Request::TerminalRead { scope, id, token } => {
                        // A long-poll must never delay project/trust changes.
                        drop(context);
                        Ok(Response::TerminalData {
                            chunk: terminals.read(&scope, &id, &token)?,
                        })
                    }
                    Request::TerminalWrite {
                        scope,
                        id,
                        token,
                        sequence,
                        data,
                    } => {
                        terminals.write(&scope, &id, &token, sequence, data)?;
                        Ok(Response::Ok)
                    }
                    Request::TerminalResize {
                        scope,
                        id,
                        token,
                        cols,
                        rows,
                    } => {
                        terminals.resize(&scope, &id, &token, cols, rows)?;
                        Ok(Response::Ok)
                    }
                    Request::TerminalClose { scope, id } => {
                        terminals.close(&scope, &id)?;
                        Ok(Response::Ok)
                    }
                    _ => unreachable!(),
                }
            })
            .await
            .map_err(|_| AppError::new("internal", "Terminal worker failed"))?
        }
        Request::UpdateCheck => {
            let (response, update) = updates::check(window.app_handle()).await?;
            *state.update.lock().await = update;
            Ok(response)
        }
        Request::UpdateInstall => {
            if window.state::<windows::Windows>().count() > 1 {
                return Err(AppError::new(
                    "workspaceBusy",
                    "Close the other Workspace windows before installing an update",
                ));
            }
            let (gate, _maintenance_guard) = {
                let h = state
                    .host
                    .lock()
                    .map_err(|_| AppError::new("internal", "Host unavailable"))?;
                let _context = state
                    .terminal_context
                    .write()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                if !h.terminals.is_empty()
                    || h.workspace
                        .as_ref()
                        .is_some_and(|w| w.dirty() || w.activity.load(Ordering::SeqCst) != 0)
                {
                    return Err(AppError::new(
                        "workspaceBusy",
                        "Save/discard all buffers, and close terminals before installing an update",
                    ));
                }
                window.state::<windows::Windows>().begin_update()?;
                let maintenance_guard = MaintenanceGuard(state.maintenance.clone());
                let activity = h.workspace.as_ref().map(|w| {
                    w.activity.store(3, Ordering::SeqCst);
                    w.activity.clone()
                });
                (activity, maintenance_guard)
            };
            let result = match state.update.lock().await.take() {
                Some(update) => updates::install(update).await,
                None => Err(AppError::new(
                    "unavailable",
                    "Check for a signed update first",
                )),
            };
            if let Some(g) = gate {
                g.store(0, Ordering::SeqCst);
            }
            result
        }
        Request::OpenLink { url } => {
            let parsed =
                tauri::Url::parse(&url).map_err(|_| AppError::new("unsafeLink", "Invalid link"))?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.host_str().is_none()
            {
                return Err(AppError::new(
                    "unsafeLink",
                    "Only explicit HTTPS links without credentials may open externally",
                ));
            }
            #[cfg(target_os = "macos")]
            let (exe, args) = ("/usr/bin/open", vec![url]);
            #[cfg(target_os = "linux")]
            let (exe, args) = ("/usr/bin/xdg-open", vec![url]);
            #[cfg(windows)]
            let (exe, args) = (
                "C:\\Windows\\System32\\rundll32.exe",
                vec!["url.dll,FileProtocolHandler".into(), url],
            );
            let out = tauri::async_runtime::spawn_blocking(move || {
                process::run(
                    Path::new(exe),
                    Path::new(if cfg!(windows) { "C:\\" } else { "/" }),
                    &args.iter().map(|s| s.as_ref()).collect::<Vec<_>>(),
                    None,
                    std::time::Duration::from_secs(10),
                )
            })
            .await
            .map_err(|_| AppError::new("internal", "Browser opener failed"))??;
            if !out.success {
                return Err(AppError::new(
                    "browser",
                    "Could not open the system browser",
                ));
            }
            Ok(Response::Ok)
        }
        Request::CredentialReply {
            scope,
            request,
            value,
        } => {
            credentials::reply(&state.bus.credentials, &scope, &request, value)?;
            Ok(Response::Ok)
        }
        Request::PickFolder => {
            let dialog = window.app_handle().dialog().file().set_parent(&window);
            let path = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
                .await
                .map_err(|_| AppError::new("internal", "Folder dialog failed"))?
                .ok_or_else(|| AppError::new("cancelled", "Folder selection cancelled"))?
                .into_path()
                .map_err(|_| AppError::new("unsupported", "Local folder required"))?;
            Ok(Response::Text {
                text: path.to_string_lossy().into(),
            })
        }
        Request::PickExecutable { tool } => {
            if tool != "git" {
                return Err(AppError::new("scope", "Unknown tool"));
            }
            let dialog = window.app_handle().dialog().file().set_parent(&window);
            let path = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
                .await
                .map_err(|_| AppError::new("internal", "Executable dialog failed"))?
                .ok_or_else(|| AppError::new("cancelled", "Executable selection cancelled"))?
                .into_path()
                .map_err(|_| AppError::new("unsupported", "Local executable required"))?;
            let exe = security::executable(&path.to_string_lossy())?;
            let mut host = state
                .host
                .lock()
                .map_err(|_| AppError::new("internal", "Host unavailable"))?;
            let result = host.configure_git(exe.to_string_lossy().into());
            if result.is_ok() {
                windows::preferences_changed(window.app_handle());
            }
            result
        }
        Request::CancelSearch { scope, generation } => {
            let context = state
                .terminal_context
                .read()
                .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
            if !context.0.as_ref().is_some_and(|p| p.id == scope) {
                return Err(AppError::new("scope", "Search workspace changed"));
            }
            let _ = state.search.compare_exchange(
                generation,
                generation.wrapping_add(1),
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            Ok(Response::Ok)
        }
        request => {
            if let Request::Search {
                scope, generation, ..
            } = &request
            {
                let context = state
                    .terminal_context
                    .read()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?;
                if !context.0.as_ref().is_some_and(|p| p.id == *scope) {
                    return Err(AppError::new("scope", "Search workspace changed"));
                }
                state.search.store(*generation, Ordering::SeqCst);
            }
            let return_window = matches!(&request, Request::OpenProject { .. });
            let open_path = match &request {
                Request::OpenProject { path } | Request::RelocateProject { path, .. } => {
                    Some(path.clone())
                }
                _ => None,
            };
            let changed_preferences = matches!(
                &request,
                Request::Settings { .. }
                    | Request::EditorOptions { .. }
                    | Request::Trust { .. }
                    | Request::OpenProject { .. }
                    | Request::RelocateProject { .. }
                    | Request::RepairSettings { .. }
            );
            let h = state.host.clone();
            let bus = state.bus.clone();
            let cancel = state.search.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                h.lock()
                    .map_err(|_| AppError::new("internal", "Host unavailable"))?
                    .handle(request, bus, cancel)
            })
            .await
            .map_err(|_| AppError::new("internal", "Native worker failed"))?;
            if result
                .as_ref()
                .is_err_and(|e| e.code == "projectAlreadyOpen")
            {
                if let Some(path) = open_path {
                    if let Some(owner) = window
                        .state::<windows::Windows>()
                        .projects
                        .owner(Path::new(&path))?
                    {
                        windows::focus(window.app_handle(), &owner);
                        if return_window {
                            return Ok(Response::WindowOpened {
                                window: Some(owner),
                                existing: true,
                            });
                        }
                    }
                }
            }
            if let Ok(Response::Project { project }) = &result {
                let _ = window.set_title(&format!("{} — Workspace", project.name));
            }
            if changed_preferences && result.is_ok() {
                windows::preferences_changed(window.app_handle());
            }
            result
        }
    }
}
pub fn run() {
    let _ = PROCESS_STARTED.set(std::time::Instant::now());
    eprintln!("AW_METRIC process_started pid={}", std::process::id());
    let initial_folder = std::env::args_os()
        .map(|s| s.into_string())
        .collect::<std::result::Result<Vec<_>, _>>()
        .ok()
        .and_then(|args| {
            std::env::current_dir()
                .ok()
                .and_then(|cwd| launch::folder_argument(&args, &cwd))
        });
    let builder = tauri::Builder::default()
        .manage(windows::PendingWindows::default())
        .register_asynchronous_uri_scheme_protocol("workspace-media", media::protocol)
        .on_webview_event(file_transfer::webview_event)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "desktop-test")]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());
    builder
        .setup(move |app| {
            let data_root = app.path().app_data_dir()?;
            #[cfg(feature = "desktop-test")]
            let data_root = std::env::var_os("AW_APP_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(data_root);
            app.manage(windows::Windows::new(data_root)?);
            #[cfg(target_os = "macos")]
            macos_lifecycle::install(app.handle())?;
            windows::install_menu(app.handle())?;
            windows::create(app.handle(), "main", initial_folder, true)?;
            for path in app.state::<windows::PendingWindows>().take_all() {
                windows::launch(app.handle(), path);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(event) = event {
                file_transfer::window_event(window, event);
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let registry = window.state::<windows::Windows>();
                registry.remove(window.label());
                if registry.count() == 0 && registry.exit_allowed() {
                    window.app_handle().exit(0);
                } else {
                    registry.continue_quit(window.app_handle());
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let Ok(state) = windows::state(window.app_handle(), window.label()) else {
                    return;
                };
                if state.maintenance.load(Ordering::SeqCst) {
                    api.prevent_close();
                    return;
                }
                match state.terminal_context.try_read() {
                    Ok(context) => {
                        if let Some(project) = &context.0 {
                            api.prevent_close();
                            state.close_requested.store(true, Ordering::SeqCst);
                            state.bus.emit(StreamEvent::CloseRequested {
                                scope: project.id.clone(),
                            });
                        }
                    }
                    Err(_) => api.prevent_close(),
                };
            }
        })
        .invoke_handler(tauri::generate_handler![dispatch, subscribe])
        .build(tauri::generate_context!())
        .expect("Unable to build native app")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(path) = path.to_str().filter(|p| p.len() <= 8192) {
                            windows::launch(app, Some(path.into()));
                        }
                    }
                }
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                let registry = app.state::<windows::Windows>();
                if !registry.exit_allowed() {
                    api.prevent_exit();
                    if code.is_some() {
                        registry.request_quit(app);
                    }
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                for (_, state) in app.state::<windows::Windows>().all().unwrap_or_default() {
                    state.terminals.close_all();
                }
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_view_options_patch_preferences_without_replacing_other_fields() {
        let temp = tempfile::tempdir().unwrap();
        let mut host = Host::new(temp.path().join("data")).unwrap();
        host.settings.font_size = 19;
        host.settings
            .keybindings
            .insert("app.save".into(), vec!["Ctrl+S".into()]);
        let bus = EventBus::new();
        let cancel = Arc::new(AtomicU32::new(0));
        host.handle(
            Request::EditorOptions {
                soft_wrap: Some(true),
                line_numbers: None,
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        host.handle(
            Request::EditorOptions {
                soft_wrap: None,
                line_numbers: Some(false),
            },
            bus,
            cancel,
        )
        .unwrap();
        let settings = workspace::load_settings(&host.storage).unwrap();
        assert!(settings.editor_soft_wrap);
        assert!(!settings.editor_line_numbers);
        assert_eq!(settings.font_size, 19);
        assert_eq!(settings.keybindings["app.save"], vec!["Ctrl+S"]);
    }
    #[cfg(unix)]
    #[test]
    fn delayed_blame_does_not_hold_the_host_lock_and_rechecks_trust() {
        use std::{
            os::unix::fs::PermissionsExt,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let exe = ["/usr/bin/git", "/usr/local/bin/git"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .unwrap();
        let checked = |args: &[&str]| {
            git::checked(
                Path::new(exe),
                &root,
                &args.iter().map(Into::into).collect::<Vec<_>>(),
                None,
            )
            .unwrap()
        };
        checked(&["init"]);
        checked(&["config", "user.name", "Fixture"]);
        checked(&["config", "user.email", "fixture@example.invalid"]);
        checked(&["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("file"), "line\n").unwrap();
        checked(&["add", "file"]);
        checked(&["commit", "-m", "base"]);
        let marker = temp.path().join("started");
        let release = temp.path().join("release");
        let wrapper = temp.path().join("git-wrapper");
        let quote =
            |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
        std::fs::write(&wrapper, format!("#!/bin/sh\nfor arg in \"$@\"; do\n if [ \"$arg\" = blame ]; then\n  : > {}\n  while [ ! -e {} ]; do /bin/sleep 0.01; done\n fi\ndone\nexec {} \"$@\"\n", quote(&marker), quote(&release), quote(Path::new(exe)))).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut host = Host::new(temp.path().join("data")).unwrap();
        let mut workspace = Workspace::open(&root, &[]).unwrap();
        workspace.project.trusted = true;
        let scope = workspace.project.id.clone();
        let entry = workspace.register("file".into());
        workspace.document_open(&entry, &host.storage).unwrap();
        host.workspace = Some(workspace);
        host.settings.git = Some(wrapper.to_str().unwrap().into());
        let host = Arc::new(Mutex::new(host));
        let worker_host = host.clone();
        struct Release(PathBuf);
        impl Drop for Release {
            fn drop(&mut self) {
                let _ = std::fs::write(&self.0, "release");
            }
        }
        let cleanup = Release(release.clone());
        let worker =
            std::thread::spawn(move || read_blame(&worker_host, &scope, &entry, "line\n".into()));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(marker.exists(), "Git must reach the blocked blame command");
        {
            let mut host = host.try_lock().expect("Blame must release the host mutex");
            let workspace = host.workspace.as_mut().unwrap();
            assert!(matches!(
                workspace.list(None).unwrap(),
                Response::Entries { .. }
            ));
            workspace.project.trusted = false;
        }
        drop(cleanup);
        assert_eq!(worker.join().unwrap().unwrap_err().code, "untrusted");
    }
    #[cfg(unix)]
    #[test]
    fn delayed_git_colors_leave_file_listing_unlocked_and_recheck_trust() {
        use std::{
            os::unix::fs::PermissionsExt,
            time::{Duration, Instant},
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let git = ["/usr/bin/git", "/usr/local/bin/git"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .unwrap();
        assert!(
            std::process::Command::new(git)
                .arg("init")
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success()
        );
        std::fs::write(root.join("a.txt"), "visible").unwrap();
        std::fs::write(root.join("b.txt"), "offscreen").unwrap();
        let marker = temp.path().join("git-started");
        let release = temp.path().join("git-release");
        let argument_log = temp.path().join("git-arguments");
        let wrapper = temp.path().join("git-wrapper");
        let quote =
            |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
        std::fs::write(&wrapper, format!("#!/bin/sh\nfor arg in \"$@\"; do\n if [ \"$arg\" = status ]; then\n  printf '%s\\0' \"$@\" > {}\n  : > {}\n  while [ ! -e {} ]; do /bin/sleep 0.01; done\n fi\ndone\nexec {} \"$@\"\n", quote(&argument_log), quote(&marker), quote(&release), quote(Path::new(git)))).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut host = Host::new(temp.path().join("data")).unwrap();
        let mut workspace = Workspace::open(&root, &[]).unwrap();
        workspace.project.trusted = true;
        let scope = workspace.project.id.clone();
        let entry = workspace.register("a.txt".into());
        host.workspace = Some(workspace);
        host.settings.git = Some(wrapper.to_str().unwrap().into());
        let host = Arc::new(Mutex::new(host));
        let worker_host = host.clone();
        struct Release(PathBuf);
        impl Drop for Release {
            fn drop(&mut self) {
                let _ = std::fs::write(&self.0, "release");
            }
        }
        let cleanup = Release(release.clone());
        let worker = std::thread::spawn(move || read_decorations(&worker_host, &scope, &[entry]));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            marker.exists(),
            "The real Git status read must be blocked in the fixture"
        );
        {
            let mut host = host
                .try_lock()
                .expect("Git colors must not retain the workspace lock");
            let workspace = host.workspace.as_mut().unwrap();
            let Response::Entries { entries, .. } = workspace.list(None).unwrap() else {
                panic!("Expected file list")
            };
            assert!(entries.iter().any(|entry| entry.name == "b.txt"));
            workspace.project.trusted = false;
        }
        let arguments = std::fs::read(&argument_log).unwrap();
        assert!(
            arguments.ends_with(b"--\0a.txt\0"),
            "Status must be limited to viewport paths"
        );
        assert!(!arguments.windows(5).any(|part| part == b"b.txt"));
        drop(cleanup);
        assert_eq!(worker.join().unwrap().unwrap_err().code, "untrusted");
    }
    fn repair_request(host: &mut Host, restore_backup: bool) -> Result<Response> {
        host.handle(
            Request::RepairSettings { restore_backup },
            EventBus::new(),
            Arc::new(AtomicU32::new(0)),
        )
    }
    #[test]
    fn startup_repairs_valid_backup_without_touching_recovery_or_opening_project() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = storage::Storage::new(tmp.path().into()).unwrap();
        let mut settings = workspace::default_settings();
        settings.theme = "light".into();
        storage.write("settings.json", &settings).unwrap();
        storage
            .write("settings.json", &workspace::default_settings())
            .unwrap();
        std::fs::write(tmp.path().join("settings.json"), b"damaged").unwrap();
        std::fs::write(
            tmp.path().join("recovery-fixture.json"),
            b"private checkpoint",
        )
        .unwrap();
        let mut host = Host::new(tmp.path().into()).unwrap();
        assert!(host.startup_issue.is_some());
        let blocked = host
            .handle(
                Request::OpenProject {
                    path: tmp.path().to_string_lossy().into(),
                },
                EventBus::new(),
                Arc::new(AtomicU32::new(0)),
            )
            .unwrap_err();
        assert_eq!(blocked.code, "repairRequired");
        repair_request(&mut host, true).unwrap();
        assert_eq!(host.settings.theme, "light");
        assert!(host.startup_issue.is_none() && host.workspace.is_none());
        assert_eq!(
            std::fs::read(tmp.path().join("recovery-fixture.json")).unwrap(),
            b"private checkpoint"
        );
        assert_eq!(
            storage
                .read::<Settings>("settings.bak")
                .unwrap()
                .unwrap()
                .theme,
            "light"
        );
        assert!(std::fs::read_dir(tmp.path()).unwrap().any(|e| {
            let e = e.unwrap();
            e.file_name()
                .to_string_lossy()
                .starts_with("settings.retained-")
                && std::fs::read(e.path()).unwrap() == b"damaged"
        }));
        assert!(
            Host::new(tmp.path().into())
                .unwrap()
                .startup_issue
                .is_none()
        );
        assert!(repair_request(&mut host, false).is_err());
    }
    #[test]
    fn invalid_backup_does_not_replace_state_and_explicit_reset_retains_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("settings.json"), b"damaged").unwrap();
        std::fs::write(tmp.path().join("settings.bak"), b"also damaged").unwrap();
        let mut host = Host::new(tmp.path().into()).unwrap();
        assert!(repair_request(&mut host, true).is_err());
        assert_eq!(
            std::fs::read(tmp.path().join("settings.json")).unwrap(),
            b"damaged"
        );
        repair_request(&mut host, false).unwrap();
        assert_eq!(host.settings.version, 2);
        assert!(host.settings.recent.is_empty());
        assert_eq!(
            std::fs::read(tmp.path().join("settings.bak")).unwrap(),
            b"also damaged"
        );
    }
    #[test]
    fn layout_repair_is_scoped_and_preserves_original_and_recovery() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let mut host = Host::new(tmp.path().join("data")).unwrap();
        let bus = EventBus::new();
        let cancel = Arc::new(AtomicU32::new(0));
        let Response::Project { project } = host
            .handle(
                Request::OpenProject {
                    path: root.to_string_lossy().into(),
                },
                bus.clone(),
                cancel.clone(),
            )
            .unwrap()
        else {
            panic!("project")
        };
        let (clean, dirty) = {
            std::fs::write(root.join("clean.txt"), "clean").unwrap();
            std::fs::write(root.join("dirty.txt"), "baseline").unwrap();
            let w = host.workspace.as_mut().unwrap();
            let clean = w.register("clean.txt".into());
            let dirty = w.register("dirty.txt".into());
            w.document_open(&clean, &host.storage).unwrap();
            w.document_open(&dirty, &host.storage).unwrap();
            w.checkpoint(&dirty, "unsaved text", 1, &host.storage)
                .unwrap();
            (clean, dirty)
        };
        let name = format!("ui-{}.json", project.id);
        std::fs::write(host.storage.root.join(&name), b"broken layout").unwrap();
        std::fs::write(
            host.storage.root.join("recovery-kept.json"),
            b"private text",
        )
        .unwrap();
        assert!(
            host.handle(
                Request::RepairLayout {
                    scope: "other".into(),
                    terminal: false
                },
                bus.clone(),
                cancel.clone()
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(host.storage.root.join(&name)).unwrap(),
            b"broken layout"
        );
        host.handle(
            Request::RepairLayout {
                scope: project.id.clone(),
                terminal: false,
            },
            bus,
            cancel,
        )
        .unwrap();
        assert!(host.storage.read::<UiState>(&name).unwrap().is_some());
        let Response::Ui { tabs, .. } = host
            .handle(
                Request::UiRead { scope: project.id },
                EventBus::new(),
                Arc::new(AtomicU32::new(0)),
            )
            .unwrap()
        else {
            panic!("UI")
        };
        assert_eq!(tabs, vec![dirty.clone()]);
        assert!(
            !host
                .workspace
                .as_ref()
                .unwrap()
                .documents
                .contains_key(&clean)
        );
        assert!(
            host.workspace
                .as_ref()
                .unwrap()
                .documents
                .get(&dirty)
                .unwrap()
                .dirty
        );
        assert_eq!(
            std::fs::read(host.storage.root.join("recovery-kept.json")).unwrap(),
            b"private text"
        );
        assert!(std::fs::read_dir(&host.storage.root).unwrap().any(|e| {
            let e = e.unwrap();
            e.file_name().to_string_lossy().contains(".retained-")
                && std::fs::read(e.path()).unwrap() == b"broken layout"
        }));
    }
    #[test]
    fn watcher_skips_only_app_metadata_and_keeps_real_files_git_and_mixed_events() {
        use notify::{Event, EventKind};
        let root = Path::new("/fixture");
        let event = |paths: Vec<&str>| {
            let mut e = Event::new(EventKind::Any);
            e.paths = paths.into_iter().map(PathBuf::from).collect();
            e
        };
        assert!(!Host::relevant_watch_event(
            root,
            &event(vec!["/fixture/.agent-workspace/workspace.json"])
        ));
        assert!(Host::relevant_watch_event(
            root,
            &event(vec!["/fixture/.agent-workspace/workspace.json"])
                .set_flag(notify::event::Flag::Rescan)
        ));
        assert!(Host::relevant_watch_event(
            root,
            &event(vec!["/fixture/src/a.ts"])
        ));
        assert!(Host::relevant_watch_event(
            root,
            &event(vec!["/fixture/.git/index"])
        ));
        assert!(Host::relevant_watch_event(
            root,
            &event(vec![
                "/fixture/.agent-workspace/workspace.json",
                "/fixture/a.ts"
            ])
        ));
        assert!(Host::relevant_watch_event(root, &event(vec![])));
        assert!(Host::relevant_watch_event(
            root,
            &event(vec!["/other/.agent-workspace/workspace.json"])
        ));
    }
    #[test]
    fn wrong_window_denied() {
        assert!(super::window_allowed("remote").is_err());
        assert!(super::window_allowed("main").is_ok());
    }
    #[test]
    fn media_extension_never_hides_recovered_text_or_deleted_original() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let data = temp.path().join("app");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("drawing.svg"), "<svg>original</svg>").unwrap();
        let bus = EventBus::new();
        let cancel = Arc::new(AtomicU32::new(0));
        let mut host = Host::new(data.clone()).unwrap();
        host.handle(
            Request::OpenProject {
                path: root.to_string_lossy().into(),
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        let scope = host.workspace.as_ref().unwrap().project.id.clone();
        host.handle(
            Request::Trust {
                scope: scope.clone(),
                trusted: true,
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        let entry = host
            .workspace
            .as_mut()
            .unwrap()
            .register("drawing.svg".into());
        assert!(matches!(
            host.handle(
                Request::OpenFile {
                    scope: scope.clone(),
                    entry: entry.clone()
                },
                bus.clone(),
                cancel.clone()
            )
            .unwrap(),
            Response::Media { .. }
        ));
        let Response::Document { document } = host
            .handle(
                Request::OpenDocument {
                    scope: scope.clone(),
                    entry: entry.clone(),
                },
                bus.clone(),
                cancel.clone(),
            )
            .unwrap()
        else {
            panic!("document")
        };
        host.handle(
            Request::Checkpoint {
                scope: scope.clone(),
                document: entry.clone(),
                text: "<svg>unsaved</svg>".into(),
                revision: 1,
                baseline: document.baseline,
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        drop(host);
        let mut host = Host::new(data).unwrap();
        host.handle(
            Request::OpenProject {
                path: root.to_string_lossy().into(),
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        assert_eq!(
            host.workspace
                .as_mut()
                .unwrap()
                .register("drawing.svg".into()),
            entry
        );
        let Response::Document { document } = host
            .handle(
                Request::OpenFile {
                    scope: scope.clone(),
                    entry: entry.clone(),
                },
                bus.clone(),
                cancel.clone(),
            )
            .unwrap()
        else {
            panic!("recovery must outrank preview")
        };
        assert_eq!(document.recovery.as_deref(), Some("<svg>unsaved</svg>"));
        assert_eq!(
            std::fs::read_to_string(root.join("drawing.svg")).unwrap(),
            "<svg>original</svg>"
        );
        std::fs::remove_file(root.join("drawing.svg")).unwrap();
        let Response::Document { document } = host
            .handle(Request::OpenFile { scope, entry }, bus, cancel)
            .unwrap()
        else {
            panic!("deleted original recovery")
        };
        assert_eq!(document.recovery.as_deref(), Some("<svg>unsaved</svg>"));
        assert!(
            document
                .readonly
                .unwrap()
                .contains("original file is unavailable")
        );
    }
    #[test]
    fn privileged_navigation_requires_the_exact_bundled_origin() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(navigation_allowed(&url.parse().unwrap(), false), "{url}");
        }
        for url in [
            "https://example.invalid/",
            "https://tauri.localhost.evil.invalid/",
            "http://tauri.localhost:4445/",
            "tauri://localhost:4445/",
            "tauri://user@localhost/",
            "https://user:secret@tauri.localhost/",
            "file:///etc/passwd",
            "data:text/html,untrusted",
            "javascript:alert(1)",
            "http://127.0.0.1:1420/",
            "http://localhost:1420/",
        ] {
            assert!(!navigation_allowed(&url.parse().unwrap(), false), "{url}");
        }
        assert!(navigation_allowed(
            &"http://127.0.0.1:1420/".parse().unwrap(),
            true
        ));
        assert!(!navigation_allowed(
            &"http://127.0.0.1:4445/".parse().unwrap(),
            true
        ));
    }

    #[test]
    fn diagnostics_exclude_source_recovery_arguments_and_private_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("private-project-name");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("secret-file"), "SOURCE_SECRET_CANARY").unwrap();
        let mut host = Host::new(tmp.path().join("private-data-name")).unwrap();
        host.settings.shell_args = vec!["ARGUMENT_SECRET_CANARY".into()];
        let mut workspace = Workspace::open(&root, &[]).unwrap();
        let entry = workspace.register("secret-file".into());
        workspace.document_open(&entry, &host.storage).unwrap();
        workspace
            .checkpoint(&entry, "RECOVERY_SECRET_CANARY", 1, &host.storage)
            .unwrap();
        host.workspace = Some(workspace);
        let Response::Text { text } = host
            .handle(
                Request::Diagnostics,
                EventBus::new(),
                Arc::new(AtomicU32::new(0)),
            )
            .unwrap()
        else {
            panic!()
        };
        for secret in [
            "SOURCE_SECRET_CANARY",
            "ARGUMENT_SECRET_CANARY",
            "RECOVERY_SECRET_CANARY",
            "private-project-name",
            "private-data-name",
            "secret-file",
        ] {
            assert!(!text.contains(secret), "Diagnostics exposed {secret}");
        }
        assert!(text.contains("Project open: true"));
        assert!(text.contains("Native terminals: 0"));
    }

    #[test]
    fn stale_scope_and_restricted_requests_cannot_read_or_mutate_registered_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file"), "unchanged").unwrap();
        let mut host = Host::new(tmp.path().join("data")).unwrap();
        let bus = EventBus::new();
        let cancel = Arc::new(AtomicU32::new(0));
        host.handle(
            Request::OpenProject {
                path: root.to_str().unwrap().into(),
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        let workspace = host.workspace.as_mut().unwrap();
        let scope = workspace.project.id.clone();
        let entry = workspace.register("file".into());
        for request in [
            Request::List {
                scope: "stale".into(),
                parent: None,
            },
            Request::RevealEntry {
                scope: "stale".into(),
                entry: entry.clone(),
            },
            Request::FilePath {
                scope: "stale".into(),
                entry: entry.clone(),
                kind: FilePathKind::Absolute,
            },
            Request::OpenFile {
                scope: "stale".into(),
                entry: entry.clone(),
            },
            Request::OpenDocument {
                scope: scope.clone(),
                entry: "../../outside".into(),
            },
            Request::Create {
                scope: "stale".into(),
                parent: None,
                name: "created".into(),
                directory: false,
            },
        ] {
            assert_eq!(
                host.handle(request, bus.clone(), cancel.clone())
                    .unwrap_err()
                    .code,
                "scope"
            );
        }
        for request in [
            Request::Create {
                scope: scope.clone(),
                parent: None,
                name: "created".into(),
                directory: false,
            },
            Request::Save {
                scope: scope.clone(),
                document: entry.clone(),
                text: "replacement".into(),
                revision: 1,
                baseline: "unknown".into(),
            },
            Request::GitStatus {
                scope: scope.clone(),
                repository: None,
            },
            Request::GitDecorations {
                scope: scope.clone(),
                entries: vec![entry.clone()],
            },
            Request::FilePath {
                scope,
                entry,
                kind: FilePathKind::Git,
            },
        ] {
            assert_eq!(
                host.handle(request, bus.clone(), cancel.clone())
                    .unwrap_err()
                    .code,
                "untrusted"
            );
        }
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"unchanged");
        assert!(!root.join("created").exists());
        assert!(host.terminals.is_empty());
    }
    #[test]
    fn external_tabs_restore_privately_without_absolute_paths_in_project_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        let mut host = Host::new(tmp.path().join("app-data")).unwrap();
        let bus = EventBus::new();
        let cancel = Arc::new(AtomicU32::new(0));
        let Response::Project { project } = host
            .handle(
                Request::OpenProject {
                    path: root.to_str().unwrap().into(),
                },
                bus.clone(),
                cancel.clone(),
            )
            .unwrap()
        else {
            panic!()
        };
        host.workspace.as_mut().unwrap().project.trusted = true;
        let entry = host
            .workspace
            .as_mut()
            .unwrap()
            .register_dropped_file(&outside)
            .unwrap();
        host.handle(
            Request::UiWrite {
                scope: project.id.clone(),
                tabs: vec![entry.id.clone()],
                active: Some(entry.id.clone()),
                split: Some(entry.id.clone()),
                layout: vec![20., 80.],
                dock: None,
                view: None,
            },
            bus.clone(),
            cancel.clone(),
        )
        .unwrap();
        let portable: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join(".agent-workspace/workspace.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(portable["ui"]["tabs"], serde_json::json!([]));
        assert!(portable["ui"]["active"].is_null());
        assert!(portable["ui"]["split"].is_null());
        assert!(!portable.to_string().contains("outside.txt"));
        host.workspace = Some(Workspace::open(&root, &[]).unwrap());
        let Response::Ui {
            tabs,
            active,
            split,
            ..
        } = host
            .handle(
                Request::UiRead {
                    scope: project.id.clone(),
                },
                bus.clone(),
                cancel.clone(),
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(tabs, vec![entry.id.clone()]);
        assert_eq!(active, Some(entry.id.clone()));
        assert_eq!(split, Some(entry.id.clone()));
        host.handle(
            Request::UiWrite {
                scope: project.id.clone(),
                tabs: vec![],
                active: None,
                split: None,
                layout: vec![20., 80.],
                dock: None,
                view: None,
            },
            bus,
            cancel,
        )
        .unwrap();
        assert!(host.workspace.as_ref().unwrap().external_files.is_empty());
        assert!(
            host.storage
                .read::<external_files::ExternalUi>(&format!("external-ui-{}.json", project.id))
                .unwrap()
                .unwrap()
                .tabs
                .is_empty()
        );
    }
}
