//! Native-created, independently scoped project windows. No renderer-selected
//! labels, URLs or application-data roots are accepted.
use crate::{
    AppState, EventBus, Host,
    dto::{Request, Response, StreamEvent},
    error::{AppError, Result},
    preferences::Preferences,
    project_windows::ProjectWindows,
    storage::Storage,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub(crate) struct PendingWindows(Mutex<std::collections::VecDeque<Option<String>>>);
impl PendingWindows {
    fn push(&self, path: Option<String>) {
        if let Ok(mut pending) = self.0.lock() {
            if pending.len() < 32 {
                pending.push_back(path);
            }
        }
    }
    pub fn take_all(&self) -> Vec<Option<String>> {
        self.0
            .lock()
            .map(|mut p| p.drain(..).collect())
            .unwrap_or_default()
    }
}

pub(crate) struct Windows {
    root: PathBuf,
    pub preferences: Arc<Preferences>,
    pub projects: Arc<ProjectWindows>,
    recovery: Arc<Mutex<()>>,
    maintenance: Arc<AtomicBool>,
    sessions: Mutex<HashMap<String, Arc<AppState>>>,
    quitting: AtomicBool,
    pub exit_ready: AtomicBool,
    quit_target: Mutex<Option<String>>,
    retry_queued: AtomicBool,
}
impl Windows {
    pub fn new(root: PathBuf) -> Result<Self> {
        let seed = Host::new(root.clone())?;
        Ok(Self {
            root,
            preferences: Arc::new(Preferences::new(
                seed.settings.clone(),
                seed.startup_issue.clone(),
            )),
            projects: Default::default(),
            recovery: seed.storage.recovery_gate.clone(),
            maintenance: seed.maintenance.clone(),
            sessions: Default::default(),
            quitting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            quit_target: Mutex::new(None),
            retry_queued: AtomicBool::new(false),
        })
    }
    pub fn get(&self, label: &str) -> Result<Arc<AppState>> {
        crate::window_allowed(label)?;
        self.sessions
            .lock()
            .map_err(|_| AppError::new("internal", "Workspace windows unavailable"))?
            .get(label)
            .cloned()
            .filter(|s| !s.closing.load(Ordering::SeqCst))
            .ok_or_else(|| AppError::new("unauthorized", "This window has no workspace authority"))
    }
    fn register(&self, label: &str) -> Result<Arc<AppState>> {
        crate::window_allowed(label)?;
        if self.maintenance.load(Ordering::SeqCst) || self.quitting.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "workspaceBusy",
                "Finish closing or updating Workspace before opening another window",
            ));
        }
        let current = self.preferences.snapshot()?;
        let mut storage = Storage::new(self.root.clone())?;
        storage.recovery_gate = self.recovery.clone();
        let mut host = Host::with_settings(storage, current.settings, current.issue);
        host.preferences = Some(self.preferences.clone());
        host.preferences_generation = current.generation;
        host.project_owner = Some((self.projects.clone(), label.into()));
        host.maintenance = self.maintenance.clone();
        let closing = host.closing.clone();
        let state = Arc::new(AppState {
            media_store: host.media_store.clone(),
            terminals: host.terminals.clone(),
            terminal_context: host.terminal_context.clone(),
            maintenance: host.maintenance.clone(),
            host: Arc::new(Mutex::new(host)),
            bus: EventBus::new(),
            search: Arc::new(AtomicU32::new(0)),
            update: tokio::sync::Mutex::new(None),
            closing,
            close_requested: AtomicBool::new(false),
            decoration_worker: tokio::sync::Mutex::new(()),
            decoration_generation: AtomicU64::new(0),
            blame_workers: tokio::sync::Semaphore::new(2),
            preferences: self.preferences.clone(),
            files: Default::default(),
            launches: Default::default(),
        });
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::new("internal", "Workspace windows unavailable"))?;
        if self.maintenance.load(Ordering::SeqCst)
            || self.quitting.load(Ordering::SeqCst)
            || sessions.len() >= 32
            || sessions.contains_key(label)
        {
            return Err(AppError::limit());
        }
        sessions.insert(label.into(), state.clone());
        Ok(state)
    }
    pub fn count(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(usize::MAX)
    }
    pub fn begin_update(&self) -> Result<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::new("internal", "Workspace windows unavailable"))?;
        if self.quitting.load(Ordering::SeqCst) {
            return Err(AppError::new(
                "workspaceBusy",
                "Finish closing project windows before installing an update",
            ));
        }
        if sessions.len() > 1 {
            return Err(AppError::new(
                "workspaceBusy",
                "Close the other Workspace windows before installing an update",
            ));
        }
        self.maintenance
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                AppError::new(
                    "workspaceBusy",
                    "An application update is already in progress",
                )
            })?;
        Ok(())
    }
    pub fn all(&self) -> Result<Vec<(String, Arc<AppState>)>> {
        self.sessions
            .lock()
            .map(|s| {
                s.iter()
                    .map(|(label, state)| (label.clone(), state.clone()))
                    .collect()
            })
            .map_err(|_| AppError::new("internal", "Workspace windows unavailable"))
    }
    pub fn remove(&self, label: &str) {
        let state = self.sessions.lock().ok().and_then(|mut s| s.remove(label));
        if let Some(state) = state {
            state.closing.store(true, Ordering::SeqCst);
            state.search.fetch_add(1, Ordering::SeqCst);
            state.decoration_generation.fetch_add(1, Ordering::SeqCst);
            tauri::async_runtime::spawn_blocking(move || state.terminals.close_all());
        }
        self.projects.release(label);
        if let Ok(mut target) = self.quit_target.lock() {
            if target.as_deref() == Some(label) {
                *target = None;
            }
        }
    }
    pub fn cancel_close(&self) {
        self.quitting.store(false, Ordering::SeqCst);
        if let Ok(mut target) = self.quit_target.lock() {
            *target = None;
        }
    }
    /// Quit is sequential: never put simultaneous save/terminal decisions in
    /// several windows, and never terminate a project after another cancels.
    pub fn request_quit(&self, app: &tauri::AppHandle) {
        if self.maintenance.load(Ordering::SeqCst) {
            return;
        }
        self.quitting.store(true, Ordering::SeqCst);
        self.continue_quit(app);
    }
    pub fn continue_quit(&self, app: &tauri::AppHandle) {
        if !self.quitting.load(Ordering::SeqCst) {
            return;
        }
        let mut target = match self.quit_target.lock() {
            Ok(t) => t,
            Err(_) => return,
        };
        if let Some(label) = target.as_deref() {
            focus(app, label);
            return;
        }
        let Ok(mut sessions) = self.all() else {
            self.cancel_target(&mut target);
            return;
        };
        sessions.sort_by_key(|(label, _)| {
            (
                !app.get_webview_window(label)
                    .is_some_and(|w| w.is_focused().unwrap_or(false)),
                label.clone(),
            )
        });
        let next = sessions
            .into_iter()
            .find(|(_, state)| !state.closing.load(Ordering::SeqCst));
        let Some((label, state)) = next else {
            self.exit_ready.store(true, Ordering::SeqCst);
            drop(target);
            app.exit(0);
            return;
        };
        let Ok(context) = state.terminal_context.try_read() else {
            if self
                .retry_queued
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        let registry = handle.state::<Windows>();
                        registry.retry_queued.store(false, Ordering::SeqCst);
                        registry.continue_quit(&handle);
                    });
                });
            }
            return;
        };
        *target = Some(label.clone());
        if let Some(project) = &context.0 {
            state.close_requested.store(true, Ordering::SeqCst);
            state.bus.emit(StreamEvent::CloseRequested {
                scope: project.id.clone(),
            });
            focus(app, &label);
        } else if let Some(window) = app.get_webview_window(&label) {
            state.closing.store(true, Ordering::SeqCst);
            drop(context);
            drop(target);
            if window.destroy().is_err() {
                state.closing.store(false, Ordering::SeqCst);
                self.cancel_close();
            }
        }
    }
    fn cancel_target(&self, target: &mut Option<String>) {
        *target = None;
        self.quitting.store(false, Ordering::SeqCst);
    }
    pub fn exit_allowed(&self) -> bool {
        !self.maintenance.load(Ordering::SeqCst)
            && (self.exit_ready.load(Ordering::SeqCst) || self.count() == 0)
    }
}
pub(crate) fn state(app: &tauri::AppHandle, label: &str) -> Result<Arc<AppState>> {
    app.state::<Windows>().get(label)
}
pub(crate) fn focus(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub(crate) fn preferences_changed(app: &tauri::AppHandle) {
    if let Ok(snapshot) = app.state::<Windows>().preferences.snapshot() {
        let _ = app.emit("preferences-changed", snapshot.generation);
    }
}

pub(crate) fn create(
    app: &tauri::AppHandle,
    label: &str,
    path: Option<String>,
    offer: bool,
) -> Result<Response> {
    let windows = app.state::<Windows>();
    if let Some(path) = &path {
        if path.is_empty() || path.len() > 8192 || path.contains('\0') {
            return Err(AppError::new("input", "Choose an ordinary local folder"));
        }
        if let Some(owner) = windows.projects.owner(Path::new(path))? {
            focus(app, &owner);
            return Ok(Response::WindowOpened {
                window: Some(owner),
                existing: true,
            });
        }
    }
    let state = windows.register(label)?;
    let result = (|| {
        if let Some(path) = path {
            if offer {
                state.launches.push(path);
            } else {
                state
                    .host
                    .lock()
                    .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
                    .handle(
                        Request::OpenProject { path },
                        state.bus.clone(),
                        state.search.clone(),
                    )?;
            }
        }
        let mut config = app.config().app.windows[0].clone();
        config.label = label.into();
        if let Some(project) = &state
            .terminal_context
            .read()
            .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
            .0
        {
            config.title = format!("{} — Workspace", project.name);
        }
        if label != "main" {
            if let Some(previous) = app
                .webview_windows()
                .values()
                .find(|w| w.is_focused().unwrap_or(false))
            {
                if let (Ok(position), Ok(scale)) =
                    (previous.outer_position(), previous.scale_factor())
                {
                    let logical = position.to_logical::<f64>(scale);
                    config.x = Some(logical.x + 24.);
                    config.y = Some(logical.y + 24.);
                }
            }
        }
        tauri::WebviewWindowBuilder::from_config(app, &config)
            .map_err(|_| AppError::new("window", "Unable to prepare a Workspace window"))?
            .on_navigation(|url| crate::navigation_allowed(url, cfg!(debug_assertions)))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .build()
            .map_err(|_| AppError::new("window", "Unable to open a Workspace window"))?;
        preferences_changed(app);
        Ok(Response::WindowOpened {
            window: Some(label.into()),
            existing: false,
        })
    })();
    if result.is_err() {
        windows.remove(label);
    }
    result
}
pub(crate) async fn open(
    app: tauri::AppHandle,
    path: Option<String>,
    offer: bool,
) -> Result<Response> {
    tauri::async_runtime::spawn_blocking(move || {
        create(
            &app,
            &format!("workspace-{}", uuid::Uuid::new_v4()),
            path,
            offer,
        )
    })
    .await
    .map_err(|_| AppError::new("window", "Window creation was interrupted"))?
}
pub(crate) fn launch(app: &tauri::AppHandle, path: Option<String>) {
    let Some(registry) = app.try_state::<Windows>() else {
        app.state::<PendingWindows>().push(path);
        return;
    };
    // First folder-open launches reuse an empty welcome window; subsequent
    // projects get their own window. An explicit New Window always creates one.
    if let Some(path) = &path {
        if registry.count() == 1 {
            if let Ok(main) = registry.get("main") {
                if main
                    .terminal_context
                    .try_read()
                    .is_ok_and(|c| c.0.is_none())
                {
                    main.launches.push(path.clone());
                    let _ = app.emit_to("main", "folder-requested", ());
                    focus(app, "main");
                    return;
                }
            }
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open(app.clone(), path, true).await {
            tracing::warn!("Workspace window could not open: {}", error.message);
            let _ = app.emit("workspace-notice", error.message);
        }
    });
}
pub(crate) fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, Submenu};
    let menu = Menu::default(app)?;
    let mut found = false;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(file) = item {
            if file.text()? == "File" {
                file.prepend(&MenuItem::with_id(
                    app,
                    "workspace-new-window",
                    "New Window",
                    true,
                    None::<&str>,
                )?)?;
                found = true;
                break;
            }
        }
    }
    if !found {
        menu.prepend(&Submenu::with_items(
            app,
            "File",
            true,
            &[&MenuItem::with_id(
                app,
                "workspace-new-window",
                "New Window",
                true,
                None::<&str>,
            )?],
        )?)?;
    }
    let editor_items = [
        ("editor.softWrap", "Toggle Soft Wrap"),
        ("editor.lineNumbers", "Show / Hide Line Numbers"),
        ("editor.blame", "Show / Hide Git Blame"),
        ("preview.code", "Document: Code"),
        ("preview.split", "Document: Side by Side"),
        ("preview.rendered", "Document: Rendered"),
    ]
    .into_iter()
    .map(|(id, label)| MenuItem::with_id(app, id, label, true, None::<&str>))
    .collect::<tauri::Result<Vec<_>>>()?;
    let refs = editor_items
        .iter()
        .map(|item| item as &dyn tauri::menu::IsMenuItem<_>)
        .collect::<Vec<_>>();
    menu.append(&Submenu::with_items(app, "Editor", true, &refs)?)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "workspace-new-window" {
            launch(app, None);
        } else if event.id().as_ref().starts_with("editor.")
            || event.id().as_ref().starts_with("preview.")
        {
            if let Some(window) = app
                .webview_windows()
                .values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                let _ = app.emit_to(window.label(), "editor-view-command", event.id().as_ref());
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{documents::Recovery, dto::Project};
    const CHILD: &str = "workspace-00000000-0000-4000-8000-000000000001";
    fn command(state: &Arc<AppState>, request: Request) -> Result<Response> {
        state
            .host
            .lock()
            .unwrap()
            .handle(request, state.bus.clone(), state.search.clone())
    }
    fn open(state: &Arc<AppState>, root: &Path) -> Project {
        let Response::Project { project } = command(
            state,
            Request::OpenProject {
                path: root.to_string_lossy().into(),
            },
        )
        .unwrap() else {
            panic!()
        };
        project
    }
    fn roots(base: &Path) -> (PathBuf, PathBuf) {
        let a = base.join("a");
        let b = base.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        std::fs::write(a.join("file.txt"), "A").unwrap();
        std::fs::write(b.join("file.txt"), "B").unwrap();
        (a, b)
    }
    fn document(state: &Arc<AppState>, project: &Project) -> crate::dto::Document {
        let entry = state
            .host
            .lock()
            .unwrap()
            .workspace
            .as_mut()
            .unwrap()
            .register("file.txt".into());
        let Response::Document { document } = command(
            state,
            Request::OpenDocument {
                scope: project.id.clone(),
                entry,
            },
        )
        .unwrap() else {
            panic!()
        };
        document
    }
    #[test]
    fn only_registered_live_windows_can_use_scoped_services_or_os_offers() {
        let t = tempfile::tempdir().unwrap();
        let windows = Windows::new(t.path().join("data")).unwrap();
        assert!(windows.get("main").is_err());
        assert!(windows.get(CHILD).is_err());
        assert!(windows.register("remote").is_err());
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let token = a
            .files
            .offer(vec![t.path().join("explicit-drop.txt")])
            .unwrap();
        assert!(b.files.peek(&token).is_err());
        assert!(a.files.peek(&token).is_ok());
        windows.remove("main");
        assert!(windows.get("main").is_err());
        assert_eq!(
            command(&a, Request::Bootstrap).unwrap_err().code,
            "unauthorized"
        );
        assert!(command(&b, Request::Bootstrap).is_ok());
    }
    #[test]
    fn independent_projects_preserve_their_own_documents_recovery_and_authority() {
        let t = tempfile::tempdir().unwrap();
        let (ra, rb) = roots(t.path());
        let windows = Windows::new(t.path().join("data")).unwrap();
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let pa = open(&a, &ra);
        let pb = open(&b, &rb);
        assert_ne!(pa.id, pb.id);
        let da = document(&a, &pa);
        let db = document(&b, &pb);
        assert_ne!(da.id, db.id);
        for (state, project, doc, text) in
            [(&a, &pa, &da, "unsaved A"), (&b, &pb, &db, "unsaved B")]
        {
            command(
                state,
                Request::Checkpoint {
                    scope: project.id.clone(),
                    document: doc.id.clone(),
                    text: text.into(),
                    revision: 1,
                    baseline: doc.baseline.clone(),
                },
            )
            .unwrap();
        }
        assert!(
            command(
                &b,
                Request::List {
                    scope: pa.id.clone(),
                    parent: None
                }
            )
            .is_err()
        );
        let storage = &a.host.lock().unwrap().storage;
        assert_eq!(
            storage
                .read::<Recovery>(&format!("recovery-{}.json", da.id))
                .unwrap()
                .unwrap()
                .text,
            "unsaved A"
        );
        assert_eq!(
            storage
                .read::<Recovery>(&format!("recovery-{}.json", db.id))
                .unwrap()
                .unwrap()
                .text,
            "unsaved B"
        );
        assert_eq!(std::fs::read_to_string(ra.join("file.txt")).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(rb.join("file.txt")).unwrap(), "B");
    }
    #[test]
    fn duplicate_folders_and_moved_directory_aliases_do_not_take_another_windows_project() {
        let t = tempfile::tempdir().unwrap();
        let (ra, rb) = roots(t.path());
        let windows = Windows::new(t.path().join("data")).unwrap();
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let pa = open(&a, &ra);
        let pb = open(&b, &rb);
        assert_eq!(
            command(
                &b,
                Request::OpenProject {
                    path: ra.to_string_lossy().into()
                }
            )
            .unwrap_err()
            .code,
            "projectAlreadyOpen"
        );
        assert_eq!(
            b.terminal_context.read().unwrap().0.as_ref().unwrap().id,
            pb.id
        );
        let moved = t.path().join("a-moved");
        std::fs::rename(&ra, &moved).unwrap();
        assert_eq!(
            windows.projects.owner(&moved).unwrap().as_deref(),
            Some("main")
        );
        assert_eq!(
            command(
                &b,
                Request::OpenProject {
                    path: moved.to_string_lossy().into()
                }
            )
            .unwrap_err()
            .code,
            "projectAlreadyOpen"
        );
        assert_eq!(
            a.terminal_context.read().unwrap().0.as_ref().unwrap().id,
            pa.id
        );
        assert_eq!(windows.projects.owner(&rb).unwrap().as_deref(), Some(CHILD));
    }
    #[test]
    fn preference_updates_keep_all_recents_and_shared_trust_while_workers_are_independent() {
        let t = tempfile::tempdir().unwrap();
        let (ra, rb) = roots(t.path());
        let windows = Windows::new(t.path().join("data")).unwrap();
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads = [(a.clone(), ra), (b.clone(), rb)]
            .into_iter()
            .map(|(state, root)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    open(&state, &root)
                })
            })
            .collect::<Vec<_>>();
        let projects = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        command(
            &a,
            Request::Trust {
                scope: projects[0].id.clone(),
                trusted: true,
            },
        )
        .unwrap();
        let mut settings = windows.preferences.snapshot().unwrap().settings;
        settings.theme = "light".into();
        command(&b, Request::Settings { settings }).unwrap();
        let snapshot = windows.preferences.snapshot().unwrap();
        assert_eq!(snapshot.settings.theme, "light");
        assert_eq!(snapshot.settings.recent.len(), 2);
        assert!(
            snapshot
                .settings
                .recent
                .iter()
                .find(|p| p.id == projects[0].id)
                .unwrap()
                .trusted
        );
        let locked = a.host.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let other = b.clone();
        let scope = projects[1].id.clone();
        let worker = std::thread::spawn(move || {
            tx.send(
                command(
                    &other,
                    Request::List {
                        scope,
                        parent: None,
                    },
                )
                .is_ok(),
            )
            .unwrap()
        });
        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap());
        drop(locked);
        worker.join().unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn closing_one_windows_service_does_not_stop_another_windows_shell() {
        let t = tempfile::tempdir().unwrap();
        let (ra, rb) = roots(t.path());
        let windows = Windows::new(t.path().join("data")).unwrap();
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let pa = open(&a, &ra);
        let pb = open(&b, &rb);
        let mut settings = crate::workspace::default_settings();
        settings.shell = Some("/bin/sh".into());
        settings.shell_args = vec!["-s".into()];
        let (_ta, _) = a.terminals.open(&pa.id, &ra, 80, 24, &settings).unwrap();
        let (tb, token) = b.terminals.open(&pb.id, &rb, 80, 24, &settings).unwrap();
        windows.remove("main");
        b.terminals
            .write(
                &pb.id,
                &tb.id,
                &token,
                0,
                b"printf '__OTHER_WINDOW_ALIVE__\\n'\n".to_vec(),
            )
            .unwrap();
        let mut output = Vec::new();
        for _ in 0..30 {
            output.extend(b.terminals.read(&pb.id, &tb.id, &token).unwrap().data);
            if output.windows(22).any(|w| w == b"__OTHER_WINDOW_ALIVE__") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("__OTHER_WINDOW_ALIVE__"));
        assert_eq!(b.terminals.list(&pb.id).unwrap().len(), 1);
        b.terminals.close_all();
    }
    #[test]
    fn recovery_quota_is_shared_across_simultaneous_window_checkpoints() {
        let t = tempfile::tempdir().unwrap();
        let (ra, rb) = roots(t.path());
        let data = t.path().join("data");
        let windows = Windows::new(data.clone()).unwrap();
        let a = windows.register("main").unwrap();
        let b = windows.register(CHILD).unwrap();
        let pa = open(&a, &ra);
        let pb = open(&b, &rb);
        let da = document(&a, &pa);
        let db = document(&b, &pb);
        for n in 0..255 {
            std::fs::write(data.join(format!("recovery-fixture-{n}.json")), b"{}").unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let tasks = [(a, pa, da), (b, pb, db)]
            .into_iter()
            .map(|(state, project, doc)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    command(
                        &state,
                        Request::Checkpoint {
                            scope: project.id,
                            document: doc.id,
                            text: "unsaved".into(),
                            revision: 1,
                            baseline: doc.baseline,
                        },
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = tasks
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|r| r.as_ref().err())
                .next()
                .unwrap()
                .code,
            "recoveryQuota"
        );
        assert_eq!(
            std::fs::read_dir(data)
                .unwrap()
                .filter(|p| p
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("recovery-"))
                .count(),
            256
        );
    }
    #[test]
    fn update_and_quit_guards_block_new_windows_without_losing_existing_ones() {
        let t = tempfile::tempdir().unwrap();
        let windows = Windows::new(t.path().join("data")).unwrap();
        windows.register("main").unwrap();
        windows.register(CHILD).unwrap();
        assert!(windows.begin_update().is_err());
        windows.remove(CHILD);
        windows.begin_update().unwrap();
        assert!(windows.register(CHILD).is_err());
        windows.maintenance.store(false, Ordering::SeqCst);
        windows.quitting.store(true, Ordering::SeqCst);
        assert!(windows.register(CHILD).is_err());
        windows.cancel_close();
        assert!(windows.register(CHILD).is_ok());
        assert!(!windows.exit_allowed());
    }
}
