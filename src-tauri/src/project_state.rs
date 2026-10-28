//! Portable project geometry and relative file references. Trust, editor recovery,
//! preferences and live process identities remain in private application data.
use crate::{
    documents,
    dto::*,
    error::{AppError, Result},
    security,
    storage::Storage,
    workspace::{UiState, Workspace},
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
const LIMIT: u64 = 2 * 1024 * 1024;
const DIRECTORY: &str = ".agent-workspace";
const FILE: &str = "workspace.json";
fn platform() -> String {
    if cfg!(windows) { "windows" } else { "unix" }.into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub version: u32,
    pub platform: String,
    pub ui: UiState,
    pub terminal: TerminalLayout,
}
impl Default for State {
    fn default() -> Self {
        Self {
            version: 1,
            platform: platform(),
            ui: UiState::default(),
            terminal: TerminalLayout::default(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Cache {
    pub state: State,
    pub baseline: Option<String>,
    pub pending: bool,
    pub warning: Option<String>,
}
fn name(w: &Workspace) -> String {
    format!("project-state-{}.json", w.project.id)
}
fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn read(w: &Workspace) -> Result<Option<Vec<u8>>> {
    let dir = match security::directory(&w.dir, Path::new(DIRECTORY)) {
        Ok(d) => d,
        Err(e) if e.code == "notFound" => return Ok(None),
        Err(e) => return Err(e),
    };
    let (bytes, _) = match documents::read_file(&dir, Path::new(FILE), LIMIT + 1) {
        Ok(r) => r,
        Err(e) if e.code == "notFound" => return Ok(None),
        Err(e) => return Err(e),
    };
    if bytes.len() as u64 > LIMIT {
        return Err(AppError::limit());
    }
    Ok(Some(bytes))
}
fn retain(storage: &Storage, scope: &str, bytes: &[u8]) -> Result<()> {
    // Bytes may be invalid JSON: wrap them so private Storage can retain them.
    storage.write(
        &format!(
            "project-state-{scope}-retained-{}.json",
            uuid::Uuid::new_v4()
        ),
        &bytes,
    )
}
fn warning(error: &AppError) -> String {
    format!(
        "Project layout is saved in private application data because .agent-workspace/workspace.json could not be updated: {} Retry by changing the layout after resolving the folder permissions or reopening the project.",
        error.message
    )
}
pub fn ensure(w: &mut Workspace, storage: &Storage) -> Result<()> {
    if w.project_state.is_some() {
        return Ok(());
    }
    let cached: Option<Cache> = storage.read(&name(w))?;
    let (bytes, issue) = match read(w) {
        Ok(b) => (b, None),
        Err(e)
            if matches!(
                e.code.as_str(),
                "permissionDenied" | "readOnly" | "io" | "unsafePath" | "unsupported"
            ) =>
        {
            (None, Some(warning(&e)))
        }
        Err(e) => return Err(e),
    };
    let baseline = bytes.as_deref().map(hash);
    let mut state = if let Some(cache) = &cached {
        if cache.pending && (cache.baseline == baseline || issue.is_some()) {
            cache.state.clone()
        } else if let Some(bytes) = &bytes {
            parse(bytes, storage, &w.project.id)?
        } else {
            legacy(w, storage)?
        }
    } else if let Some(bytes) = &bytes {
        parse(bytes, storage, &w.project.id)?
    } else {
        legacy(w, storage)?
    };
    if state.platform != platform() {
        state.ui.tabs.clear();
        state.ui.active = None;
        state.ui.split = None;
        state.ui.view.expanded.clear();
        state.platform = platform();
    }
    // The project file never supplies session IDs. Only this scope's private
    // cache can attach existing sessions to an identical tab/pane identity.
    if let Some(cache) = &cached {
        for tab in &mut state.terminal.tabs {
            if let Some(saved) = cache.state.terminal.tabs.iter().find(|t| t.id == tab.id) {
                restore_sessions(&mut tab.root, &saved.root);
            }
        }
    }
    w.project_state = Some(Cache {
        state,
        baseline,
        pending: cached.as_ref().is_some_and(|c| c.pending),
        warning: issue,
    });
    Ok(())
}
fn parse(bytes: &[u8], storage: &Storage, scope: &str) -> Result<State> {
    let mut state:State=serde_json::from_slice(bytes).map_err(|_|{let _=retain(storage,scope,bytes);AppError::new("corruptState","Project workspace settings are damaged. A private copy was retained; reset the affected layout to recover.")})?;
    if state.version != 1 {
        return Err(AppError::new(
            "stateVersion",
            "Unsupported project workspace format; use a compatible application version.",
        ));
    }
    for tab in &mut state.terminal.tabs {
        clear_sessions(&mut tab.root);
    }
    Ok(state)
}
fn legacy(w: &Workspace, storage: &Storage) -> Result<State> {
    Ok(State {
        ui: storage
            .read(&format!("ui-{}.json", w.project.id))?
            .unwrap_or_default(),
        terminal: storage
            .read(&format!("terminal-layout-{}.json", w.project.id))?
            .unwrap_or_default(),
        ..State::default()
    })
}
fn restore_sessions(node: &mut TerminalNode, saved: &TerminalNode) {
    match node {
        TerminalNode::Pane { id, session } => {
            fn find(n: &TerminalNode, id: &str) -> Option<String> {
                match n {
                    TerminalNode::Pane { id: other, session } if other == id => session.clone(),
                    TerminalNode::Split { first, second, .. } => {
                        find(first, id).or_else(|| find(second, id))
                    }
                    _ => None,
                }
            }
            *session = find(saved, id);
        }
        TerminalNode::Split { first, second, .. } => {
            restore_sessions(first, saved);
            restore_sessions(second, saved);
        }
    }
}
fn clear_sessions(node: &mut TerminalNode) {
    match node {
        TerminalNode::Pane { session, .. } => *session = None,
        TerminalNode::Split { first, second, .. } => {
            clear_sessions(first);
            clear_sessions(second);
        }
    }
}
pub fn ui(w: &mut Workspace, storage: &Storage) -> Result<UiState> {
    ensure(w, storage)?;
    let ui = w.project_state.as_ref().unwrap().state.ui.clone();
    validate_ui(&ui)?;
    Ok(ui)
}
pub fn terminal(w: &mut Workspace, storage: &Storage) -> Result<TerminalLayout> {
    ensure(w, storage)?;
    let layout = w.project_state.as_ref().unwrap().state.terminal.clone();
    crate::terminal::validate_layout(&layout)?;
    Ok(layout)
}
pub fn validate_ui(ui: &UiState) -> Result<()> {
    if ui.version > 2 {
        return Err(AppError::new(
            "stateVersion",
            "Unsupported project UI format",
        ));
    }
    if ui.tabs.len() > 100
        || ui.layout.len() > 8
        || ui.view.expanded.len() > 512
        || ui
            .layout
            .iter()
            .any(|n| !n.is_finite() || !(0.0..=100.0).contains(n))
    {
        return Err(AppError::limit());
    }
    if let Some(dock) = &ui.dock {
        crate::dock::validate(dock)?;
    }
    for token in ui
        .tabs
        .iter()
        .chain(ui.active.iter())
        .chain(ui.split.iter())
        .chain(ui.view.expanded.iter())
    {
        documents::token_path(token)?;
    }
    Ok(())
}
fn already_persisted(w: &Workspace) -> bool {
    let Some(cache) = &w.project_state else {
        return false;
    };
    !cache.pending
        && cache.warning.is_none()
        && cache.baseline.is_some()
        && read(w).ok().flatten().as_deref().map(hash) == cache.baseline
}
pub fn save_ui(w: &mut Workspace, storage: &Storage, ui: UiState) -> Result<Option<String>> {
    ensure(w, storage)?;
    validate_ui(&ui)?;
    if w.project_state.as_ref().unwrap().state.ui == ui && already_persisted(w) {
        return Ok(None);
    }
    w.project_state.as_mut().unwrap().state.ui = ui;
    save(w, storage)
}
pub fn save_terminal(
    w: &mut Workspace,
    storage: &Storage,
    layout: TerminalLayout,
) -> Result<Option<String>> {
    ensure(w, storage)?;
    crate::terminal::validate_layout(&layout)?;
    if w.project_state.as_ref().unwrap().state.terminal == layout && already_persisted(w) {
        return Ok(None);
    }
    w.project_state.as_mut().unwrap().state.terminal = layout;
    save(w, storage)
}
fn create(dir: &Dir, leaf: &Path, bytes: &[u8]) -> Result<()> {
    let temp = std::path::PathBuf::from(format!(".workspace-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = cap_std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut f = dir.open_with(&temp, &options)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        crate::files::rename_noreplace(dir, &temp, dir, leaf)?;
        #[cfg(unix)]
        dir.try_clone()?.into_std_file().sync_all()?;
        Ok(())
    })();
    if dir.symlink_metadata(&temp).is_ok() {
        let _ = dir.remove_file(&temp);
    }
    result
}
fn write(w: &Workspace, cache: &Cache) -> Result<String> {
    match w.dir.create_dir(DIRECTORY) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let dir = security::directory(&w.dir, Path::new(DIRECTORY))?;
    if dir.symlink_metadata(".gitignore").is_err() {
        match create(&dir, Path::new(".gitignore"), b"*\n") {
            Ok(()) => {}
            Err(e) if e.code == "alreadyExists" => {}
            Err(e) => return Err(e),
        }
    }
    let mut portable = cache.state.clone();
    for tab in &mut portable.terminal.tabs {
        clear_sessions(&mut tab.root);
    }
    let bytes = serde_json::to_vec_pretty(&portable)?;
    if bytes.len() as u64 > LIMIT {
        return Err(AppError::limit());
    }
    match documents::read_file(&dir, Path::new(FILE), LIMIT + 1) {
        Ok((old, meta)) => {
            if old.len() as u64 > LIMIT || cache.baseline.as_deref() != Some(&hash(&old)) {
                return Err(AppError::conflict(
                    "Workspace settings changed outside this window. Reopen the project to load them; your current layout is retained privately.",
                ));
            }
            documents::atomic_replace(&dir, Path::new(FILE), &old, &bytes, &meta)?;
        }
        Err(e) if e.code == "notFound" => {
            if cache.baseline.is_some() {
                return Err(AppError::conflict(
                    "Project workspace settings were removed externally. Reopen the project before replacing them.",
                ));
            }
            create(&dir, Path::new(FILE), &bytes)?;
        }
        Err(e) => return Err(e),
    }
    Ok(hash(&bytes))
}
fn save(w: &mut Workspace, storage: &Storage) -> Result<Option<String>> {
    let mut cache = w.project_state.as_ref().unwrap().clone();
    cache.pending = true;
    // Checkpoint first, so a failed project write cannot discard this layout.
    storage.write(&name(w), &cache)?;
    cache.warning = if !w.project.trusted {
        Some("Restricted project: layout is saved privately. Trust this folder to save .agent-workspace/workspace.json.".into())
    } else {
        match write(w, &cache) {
            Ok(hash) => {
                cache.baseline = Some(hash);
                cache.pending = false;
                None
            }
            Err(e) => Some(warning(&e)),
        }
    };
    storage.write(&name(w), &cache)?;
    let warning = cache.warning.clone();
    w.project_state = Some(cache);
    Ok(warning)
}
pub fn repair(w: &mut Workspace, storage: &Storage, terminal: bool) -> Result<()> {
    // Preserve the original bytes even when decoding/schema validation failed.
    if let Ok(Some(bytes)) = read(w) {
        retain(storage, &w.project.id, &bytes)?;
    }
    if w.project_state.is_none() {
        let bytes = read(w).ok().flatten();
        let mut state = bytes
            .as_deref()
            .and_then(|b| serde_json::from_slice::<State>(b).ok())
            .filter(|s| s.version == 1)
            .unwrap_or_default();
        if terminal {
            state.terminal = TerminalLayout::default();
        } else {
            state.ui = UiState::default();
        }
        w.project_state = Some(Cache {
            state,
            baseline: bytes.as_deref().map(hash),
            pending: true,
            warning: None,
        });
    } else if terminal {
        w.project_state.as_mut().unwrap().state.terminal = TerminalLayout::default();
    } else {
        w.project_state.as_mut().unwrap().state.ui = UiState::default();
    }
    // Also retain and repair legacy originals, including their previous backup.
    if terminal {
        storage.repair(
            &format!("terminal-layout-{}.json", w.project.id),
            &TerminalLayout::default(),
        )?;
    } else {
        storage.repair(&format!("ui-{}.json", w.project.id), &UiState::default())?;
    }
    storage.repair(&name(w), w.project_state.as_ref().expect("repaired"))?;
    save(w, storage)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Workspace, Storage) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let mut w = Workspace::open(&root, &[]).unwrap();
        w.project.trusted = true;
        let storage = Storage::new(t.path().join("private")).unwrap();
        (t, w, storage)
    }
    fn layout() -> TerminalLayout {
        TerminalLayout {
            version: 1,
            tabs: vec![TerminalTab {
                id: "10000000-0000-4000-8000-000000000001".into(),
                title: "Shell".into(),
                root: TerminalNode::Pane {
                    id: "10000000-0000-4000-8000-000000000002".into(),
                    session: Some("10000000-0000-4000-8000-000000000003".into()),
                },
            }],
            active: Some("10000000-0000-4000-8000-000000000001".into()),
        }
    }
    #[test]
    fn migrates_legacy_and_merges_sections_without_exporting_processes_or_trust() {
        let (_t, mut w, s) = setup();
        let legacy = UiState {
            version: 2,
            tabs: vec![documents::path_token(Path::new("src/hello.ts"))],
            layout: vec![22.0, 78.0],
            ..UiState::default()
        };
        s.write(&format!("ui-{}.json", w.project.id), &legacy)
            .unwrap();
        assert_eq!(ui(&mut w, &s).unwrap().tabs, legacy.tabs);
        assert!(save_terminal(&mut w, &s, layout()).unwrap().is_none());
        let bytes = read(&w).unwrap().unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(!text.contains("10000000-0000-4000-8000-000000000003"));
        assert!(!text.contains("trusted"));
        assert!(!text.contains(&w.project.root));
        let portable: State = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(portable.ui.tabs, legacy.tabs);
        assert_eq!(
            std::fs::read_to_string(Path::new(&w.project.root).join(".agent-workspace/.gitignore"))
                .unwrap(),
            "*\n"
        );
        w.project_state = None;
        let restored = terminal(&mut w, &s).unwrap();
        assert!(
            matches!(&restored.tabs[0].root,TerminalNode::Pane{session:Some(id),..}if id=="10000000-0000-4000-8000-000000000003")
        );
        assert!(s.root.join(format!("ui-{}.json", w.project.id)).exists());
    }
    #[test]
    fn project_copy_restores_geometry_but_cannot_inherit_trust_or_live_sessions() {
        let (t, mut w, s) = setup();
        save_terminal(&mut w, &s, layout()).unwrap();
        let mut saved = ui(&mut w, &s).unwrap();
        saved.layout = vec![31.0, 69.0];
        save_ui(&mut w, &s, saved).unwrap();
        let copy = t.path().join("copy");
        std::fs::create_dir_all(copy.join(DIRECTORY)).unwrap();
        std::fs::copy(
            Path::new(&w.project.root).join(DIRECTORY).join(FILE),
            copy.join(DIRECTORY).join(FILE),
        )
        .unwrap();
        let mut other = Workspace::open(&copy, &[]).unwrap();
        assert!(!other.project.trusted);
        assert_ne!(other.project.id, w.project.id);
        assert_eq!(ui(&mut other, &s).unwrap().layout, vec![31.0, 69.0]);
        assert!(matches!(
            terminal(&mut other, &s).unwrap().tabs[0].root,
            TerminalNode::Pane { session: None, .. }
        ));
    }
    #[test]
    fn external_changes_win_on_reopen_while_current_layout_is_retained_privately() {
        let (_t, mut w, s) = setup();
        save_ui(
            &mut w,
            &s,
            UiState {
                layout: vec![20.0, 80.0],
                ..UiState::default()
            },
        )
        .unwrap();
        let path = Path::new(&w.project.root).join(DIRECTORY).join(FILE);
        let mut external: State = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        external.ui.layout = vec![40.0, 60.0];
        let bytes = serde_json::to_vec(&external).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let warning = save_ui(
            &mut w,
            &s,
            UiState {
                layout: vec![30.0, 70.0],
                ..UiState::default()
            },
        )
        .unwrap()
        .unwrap();
        assert!(warning.contains("changed outside"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            s.read::<Cache>(&name(&w)).unwrap().unwrap().state.ui.layout,
            vec![30.0, 70.0]
        );
        w.project_state = None;
        assert_eq!(ui(&mut w, &s).unwrap().layout, vec![40.0, 60.0]);
    }
    #[test]
    fn restricted_projects_never_create_metadata_and_recover_private_latest_state() {
        let (_t, mut w, s) = setup();
        w.project.trusted = false;
        assert!(
            save_ui(
                &mut w,
                &s,
                UiState {
                    layout: vec![27.0, 73.0],
                    ..UiState::default()
                }
            )
            .unwrap()
            .unwrap()
            .contains("Restricted")
        );
        assert!(!Path::new(&w.project.root).join(DIRECTORY).exists());
        w.project_state = None;
        assert_eq!(ui(&mut w, &s).unwrap().layout, vec![27.0, 73.0]);
    }
    #[test]
    fn corrupt_project_is_preserved_and_repair_does_not_remove_private_recovery() {
        let (_t, mut w, s) = setup();
        save_terminal(&mut w, &s, layout()).unwrap();
        let path = Path::new(&w.project.root).join(DIRECTORY).join(FILE);
        std::fs::write(&path, b"damaged project").unwrap();
        s.write("recovery-kept.json", &"unsaved text").unwrap();
        w.project_state = None;
        assert_eq!(ui(&mut w, &s).err().unwrap().code, "corruptState");
        assert_eq!(std::fs::read(&path).unwrap(), b"damaged project");
        repair(&mut w, &s, false).unwrap();
        assert!(ui(&mut w, &s).unwrap().tabs.is_empty());
        assert_eq!(
            s.read::<String>("recovery-kept.json").unwrap().unwrap(),
            "unsaved text"
        );
        assert!(std::fs::read_dir(&s.root).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains("-retained-")
        }));
    }
    #[test]
    fn invalid_relative_references_and_hidden_masks_are_rejected() {
        let ui = UiState {
            tabs: vec![documents::path_token(Path::new("../escape"))],
            ..UiState::default()
        };
        assert!(validate_ui(&ui).is_err());
        let dock = DockLayout {
            version: 2,
            root: Some(DockNode::Panel {
                panel: DockPanel::Editor,
            }),
            hidden: vec![DockPanel::Terminal],
        };
        assert!(crate::dock::validate(&dock).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_metadata_directory_cannot_write_outside_project() {
        let (t, mut w, s) = setup();
        let outside = t.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, Path::new(&w.project.root).join(DIRECTORY)).unwrap();
        assert!(
            save_ui(
                &mut w,
                &s,
                UiState {
                    layout: vec![33.0, 67.0],
                    ..UiState::default()
                }
            )
            .unwrap()
            .is_some()
        );
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
        w.project_state = None;
        assert_eq!(ui(&mut w, &s).unwrap().layout, vec![33.0, 67.0]);
    }
    #[cfg(unix)]
    #[test]
    fn read_only_project_metadata_retains_latest_layout_privately() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, mut w, s) = setup();
        let path = Path::new(&w.project.root).join(DIRECTORY);
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = save_ui(
            &mut w,
            &s,
            UiState {
                layout: vec![37.0, 63.0],
                ..UiState::default()
            },
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.unwrap().unwrap().contains("permissions"));
        assert!(!path.join(FILE).exists());
        w.project_state = None;
        assert_eq!(ui(&mut w, &s).unwrap().layout, vec![37.0, 63.0]);
    }
    #[test]
    fn explicit_repair_retains_a_corrupt_private_mirror_and_keeps_other_section() {
        let (_t, mut w, s) = setup();
        save_terminal(&mut w, &s, layout()).unwrap();
        std::fs::write(s.root.join(name(&w)), b"corrupt private cache").unwrap();
        w.project_state = None;
        assert!(ui(&mut w, &s).is_err());
        repair(&mut w, &s, false).unwrap();
        w.project_state = None;
        assert!(ui(&mut w, &s).unwrap().tabs.is_empty());
        assert_eq!(terminal(&mut w, &s).unwrap().tabs.len(), 1);
        assert!(std::fs::read_dir(&s.root).unwrap().any(|entry| {
            let entry = entry.unwrap();
            entry.file_name().to_string_lossy().contains(".retained-")
                && std::fs::read(entry.path()).unwrap() == b"corrupt private cache"
        }));
    }
    #[test]
    fn identical_metadata_writes_preserve_the_project_file_and_private_checkpoint() {
        let (_t, mut w, s) = setup();
        let ui = UiState {
            version: 2,
            layout: vec![25.0, 75.0],
            ..UiState::default()
        };
        save_ui(&mut w, &s, ui.clone()).unwrap();
        let project = Path::new(&w.project.root).join(DIRECTORY).join(FILE);
        let private = s.root.join(name(&w));
        let before = (
            std::fs::metadata(&project).unwrap().modified().unwrap(),
            std::fs::metadata(&private).unwrap().modified().unwrap(),
        );
        save_ui(&mut w, &s, ui).unwrap();
        save_terminal(&mut w, &s, TerminalLayout::default()).unwrap();
        assert_eq!(
            before,
            (
                std::fs::metadata(project).unwrap().modified().unwrap(),
                std::fs::metadata(private).unwrap().modified().unwrap()
            )
        );
    }
    #[test]
    fn identical_request_does_not_hide_external_workspace_changes() {
        let (_t, mut w, s) = setup();
        let ui = UiState {
            version: 2,
            layout: vec![25.0, 75.0],
            ..UiState::default()
        };
        save_ui(&mut w, &s, ui.clone()).unwrap();
        let project = Path::new(&w.project.root).join(DIRECTORY).join(FILE);
        std::fs::write(&project, b"externally changed").unwrap();
        assert!(save_ui(&mut w, &s, ui).unwrap().is_some());
        assert_eq!(std::fs::read(project).unwrap(), b"externally changed");
    }
}
