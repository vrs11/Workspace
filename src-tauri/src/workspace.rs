use crate::{
    documents::DocumentState,
    dto::*,
    error::{AppError, Result},
    security,
    storage::Storage,
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU32},
    },
};

pub struct Workspace {
    pub project: Project,
    pub project_state: Option<crate::project_state::Cache>,
    pub dir: Dir,
    pub entries: HashMap<String, PathBuf>,
    pub documents: HashMap<String, DocumentState>,
    pub external_files: HashMap<String, crate::external_files::ExternalFile>,
    pub media: crate::media::Previews,
    pub refreshes: HashMap<String, crate::documents::RefreshSnapshot>,
    pub activity: Arc<AtomicU8>,
    pub search_generation: Arc<AtomicU32>,
    pub repository: Option<PathBuf>,
    pub diffs: HashMap<String, crate::git::DiffSnapshot>,
    pub replacements: HashMap<String, crate::search::Replacement>,
    pub(crate) delete_reviews: crate::files::DeleteReviews,
}
impl Workspace {
    pub fn open(path: &Path, recent: &[Project]) -> Result<Self> {
        let root = path.canonicalize()?;
        if !root.is_dir() {
            return Err(AppError::new("notFound", "Choose an existing local folder"));
        }
        let dir = Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        let id = security::identity_of_dir(&root, &dir)?;
        if security::identity(&root)? != id {
            return Err(AppError::conflict(
                "Project identity changed while opening; reopen the folder",
            ));
        }
        let mut project = Project {
            id: id.clone(),
            root: root
                .to_str()
                .ok_or_else(|| {
                    AppError::new(
                        "unsupported",
                        "Non-UTF-8 project roots require native platform verification",
                    )
                })?
                .into(),
            name: root
                .file_name()
                .map(|s| s.to_string_lossy().into())
                .unwrap_or_else(|| "/".into()),
            trusted: false,
            identity_root: None,
        };
        for saved in recent.iter().filter(|p| p.root == project.root) {
            let origin = Path::new(saved.identity_root.as_deref().unwrap_or(&saved.root));
            if security::identity_of_dir(origin, &dir)? == saved.id {
                project.id = saved.id.clone();
                project.trusted = saved.trusted;
                project.identity_root = saved.identity_root.clone();
                break;
            }
        }
        if security::project_identity(&project)? != project.id {
            return Err(AppError::conflict(
                "Project identity changed while opening; reopen the folder",
            ));
        }
        Ok(Self {
            project,
            project_state: None,
            dir,
            entries: HashMap::new(),
            documents: HashMap::new(),
            external_files: HashMap::new(),
            media: HashMap::new(),
            refreshes: HashMap::new(),
            activity: Arc::new(AtomicU8::new(0)),
            search_generation: Arc::new(AtomicU32::new(0)),
            repository: None,
            diffs: HashMap::new(),
            replacements: HashMap::new(),
            delete_reviews: Default::default(),
        })
    }
    pub fn relocated(path: &Path, previous: &Project) -> Result<Self> {
        let mut next = Self::open(path, &[])?;
        let origin = previous.identity_root.as_deref().unwrap_or(&previous.root);
        if security::identity_of_dir(Path::new(origin), &next.dir)? != previous.id {
            return Err(AppError::new(
                "projectIdentity",
                "The selected folder has a different filesystem identity. Existing layout and unsaved recovery were retained. Locate the original folder, or open this folder separately as a new project.",
            ));
        }
        next.project.id = previous.id.clone();
        next.project.trusted = previous.trusted;
        next.project.identity_root = Some(origin.into());
        if security::project_identity(&next.project)? != previous.id {
            return Err(AppError::conflict(
                "Project identity changed during relocation; state retained",
            ));
        }
        Ok(next)
    }
    pub fn authorize(&self, scope: &str, trusted: bool, mutation: bool) -> Result<()> {
        if self.project.id != scope || security::project_identity(&self.project)? != scope {
            return Err(AppError::new(
                "scope",
                "Workspace identity changed; reopen the folder",
            ));
        }
        if trusted && !self.project.trusted {
            return Err(AppError::new(
                "untrusted",
                "Trust this folder before executing tools or saving changes",
            ));
        }
        if mutation && self.activity.load(std::sync::atomic::Ordering::SeqCst) != 0 {
            return Err(AppError::new(
                "workspaceBusy",
                "Another file operation or application update is in progress; wait before changing project state",
            ));
        }
        Ok(())
    }
    pub fn register(&mut self, path: PathBuf) -> String {
        let id = blake3::hash(format!("{}:{:?}", self.project.id, path).as_bytes())
            .to_hex()
            .to_string();
        self.entries.insert(id.clone(), path);
        id
    }
    pub fn entry(&self, id: &str) -> Result<PathBuf> {
        self.entries
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("scope", "Unknown file entry; refresh the project"))
    }
    pub fn list(&mut self, parent: Option<&str>) -> Result<Response> {
        let base = match parent {
            Some(id) => self.entry(id)?,
            None => PathBuf::new(),
        };
        let dir = security::directory(&self.dir, &base)?;
        let mut out = Vec::new();
        #[cfg(windows)]
        let (items, truncated) = crate::windows_fs::entries(&dir, 10_000)?;
        #[cfg(windows)]
        for (name, kind) in items {
            if name
                .to_string_lossy()
                .eq_ignore_ascii_case(".agent-workspace")
            {
                continue;
            }
            let path = base.join(&name);
            let id = self.register(path.clone());
            out.push(Entry {
                id,
                name: security::display(Path::new(&name)),
                path: security::display(&path),
                kind: kind.into(),
            });
        }
        #[cfg(not(windows))]
        let mut truncated = false;
        #[cfg(not(windows))]
        for e in dir.entries()? {
            let e = e?;
            if [".git", ".agent-workspace"]
                .iter()
                .any(|name| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
            {
                continue;
            }
            if out.len() >= 10_000 {
                truncated = true;
                break;
            }
            let path = base.join(e.file_name());
            let kind = e.file_type()?;
            let kind = if kind.is_symlink() {
                "link"
            } else if kind.is_dir() {
                "directory"
            } else if kind.is_file() {
                "file"
            } else {
                "special"
            };
            let id = self.register(path.clone());
            out.push(Entry {
                id,
                name: security::display(Path::new(&e.file_name())),
                path: security::display(&path),
                kind: kind.into(),
            });
        }
        out.sort_by(|a, b| {
            (a.kind != "directory", a.name.to_lowercase())
                .cmp(&(b.kind != "directory", b.name.to_lowercase()))
        });
        Ok(Response::Entries {
            entries: out,
            truncated,
        })
    }
    pub fn release_views(&mut self, diffs: &[String], previews: &[String]) -> Result<Response> {
        if diffs.len() > 100
            || previews.len() > 100
            || diffs
                .iter()
                .chain(previews)
                .any(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err(AppError::limit());
        }
        for id in diffs {
            self.diffs.remove(id);
        }
        for id in previews {
            self.replacements.remove(id);
        }
        Ok(Response::Ok)
    }
    pub fn dirty(&self) -> bool {
        self.documents.values().any(|d| d.dirty)
    }
}
#[derive(Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct UiState {
    pub version: u32,
    pub tabs: Vec<String>,
    pub active: Option<String>,
    pub layout: Vec<f64>,
    #[serde(default)]
    pub split: Option<String>,
    #[serde(default)]
    pub dock: Option<DockLayout>,
    #[serde(default)]
    pub view: ProjectView,
}

pub fn default_settings() -> Settings {
    fn installed(tool: &str) -> Option<String> {
        let mut dirs = vec!["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
        if cfg!(windows) {
            dirs = vec!["C:\\Program Files\\Git\\cmd"];
        }
        dirs.into_iter()
            .map(|d| Path::new(d).join(tool))
            .find(|p| security::executable(&p.to_string_lossy()).is_ok())
            .map(|p| p.to_string_lossy().into())
    }
    Settings {
        version: 2,
        git: installed(if cfg!(windows) { "git.exe" } else { "git" }),
        theme: "dark".into(),
        font_size: 14,
        recent: vec![],
        shell: None,
        shell_args: vec![],
        terminal_font_size: 13,
        terminal_scrollback: 5000,
        auto_save_idle: true,
        auto_save_delay: 15,
        auto_save_on_focus_loss: true,
        keybindings: Default::default(),
    }
}
pub fn load_settings(storage: &Storage) -> Result<Settings> {
    let mut s: Settings = storage
        .read("settings.json")?
        .unwrap_or_else(default_settings);
    validate_settings(&s)?;
    if s.version == 1 {
        s.version = 2;
        storage.write("settings.json", &s)?;
    }
    Ok(s)
}
pub fn validate_keybindings(s: &Settings) -> bool {
    s.keybindings.len() <= 2048
        && s.keybindings.iter().all(|(id, keys)| {
            !id.is_empty()
                && id.len() <= 200
                && id.is_ascii()
                && !id.contains(char::is_control)
                && keys.len() <= 4
                && keys.iter().all(|key| {
                    !key.is_empty()
                        && key.len() <= 160
                        && key.is_ascii()
                        && !key.contains(char::is_control)
                })
        })
}
fn validate_settings(s: &Settings) -> Result<()> {
    if !validate_keybindings(s) {
        return Err(AppError::new(
            "stateVersion",
            "Invalid keyboard shortcut settings; original preferences retained",
        ));
    }
    if !(1..=2).contains(&s.version)
        || !["light", "dark"].contains(&s.theme.as_str())
        || !(10..=32).contains(&s.font_size)
        || s.recent.len() > 50
        || !(10..=32).contains(&s.terminal_font_size)
        || !(100..=50000).contains(&s.terminal_scrollback)
        || !(1..=300).contains(&s.auto_save_delay)
        || s.shell_args.len() > 32
        || s.shell_args
            .iter()
            .any(|a| a.len() > 4096 || a.contains('\0'))
        || s.recent.iter().any(|p| {
            p.identity_root.as_ref().is_some_and(|origin| {
                origin.len() > 8192
                    || origin.contains('\0')
                    || !Path::new(origin).is_absolute()
                    || p.id.len() != 64
                    || !p.id.bytes().all(|b| b.is_ascii_hexdigit())
            })
        })
    {
        return Err(AppError::new(
            "stateVersion",
            "Unsupported settings version or values; original state retained",
        ));
    }
    Ok(())
}
pub fn repair_settings(storage: &Storage, restore_backup: bool) -> Result<Settings> {
    let mut s = if restore_backup {
        storage.read::<Settings>("settings.bak")?.ok_or_else(|| {
            AppError::new("notFound", "No previous settings backup is available; use Reset preferences or restore a private backup")
        })?
    } else {
        default_settings()
    };
    validate_settings(&s)?;
    s.version = 2;
    storage.repair("settings.json", &s)?;
    Ok(s)
}
