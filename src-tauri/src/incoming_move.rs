//! Explicit OS offers moved with exclusive handle-relative renames; never copy/delete.
use crate::{
    dto::{Entry, Response},
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use cap_std::fs::Dir;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};
pub(crate) struct Source {
    pub(crate) parent: Dir,
    pub(crate) leaf: PathBuf,
    pub(crate) absolute: PathBuf,
    pub(crate) relative: Option<PathBuf>,
    pub(crate) kind: String,
}
pub struct IncomingMove {
    pub scope: String,
    project: crate::dto::Project,
    root: Dir,
    destination: Dir,
    base: PathBuf,
    sources: Vec<Source>,
    activity: Arc<AtomicU8>,
}
pub struct MoveResult {
    pub sources: Vec<PathBuf>,
    pub targets: Vec<PathBuf>,
    pub error: Option<AppError>,
}
impl Drop for IncomingMove {
    fn drop(&mut self) {
        self.activity.store(0, Ordering::SeqCst);
    }
}
pub(crate) fn source(path: &Path, root: &Path) -> Result<Source> {
    if !path.is_absolute() || path.as_os_str().len() > 8192 {
        return Err(AppError::new(
            "unsafePath",
            "Drop an ordinary local file or folder",
        ));
    }
    let leaf: PathBuf = path
        .file_name()
        .ok_or_else(|| AppError::new("unsafePath", "Filesystem roots cannot be moved"))?
        .into();
    security::relative(&leaf)?;
    if leaf
        .to_string_lossy()
        .eq_ignore_ascii_case(".agent-workspace")
    {
        return Err(AppError::new(
            "unsafePath",
            "Workspace settings cannot be moved by a file drop",
        ));
    }
    let parent_path = path.parent().ok_or_else(AppError::limit)?.canonicalize()?;
    if parent_path.components().any(|part| matches!(part, std::path::Component::Normal(name) if [".git", ".agent-workspace"].iter().any(|forbidden| name.to_string_lossy().eq_ignore_ascii_case(forbidden)))) { return Err(AppError::new("unsafePath", "Git and application metadata cannot be moved through Explorer")); }
    let parent = Dir::open_ambient_dir(&parent_path, cap_std::ambient_authority())?;
    let metadata = parent.symlink_metadata(&leaf)?;
    let kind = if metadata.file_type().is_symlink() {
        "link"
    } else if metadata.is_file() {
        "file"
    } else if metadata.is_dir() {
        "directory"
    } else {
        return Err(AppError::new(
            "unsupported",
            "Special devices cannot be moved into a project",
        ));
    };
    let absolute = parent_path.join(&leaf);
    if root.starts_with(&absolute) {
        return Err(AppError::new(
            "unsafePath",
            "The open project or a folder containing it cannot be moved into itself",
        ));
    }
    let relative = absolute.strip_prefix(root).ok().map(Path::to_path_buf);
    if let Some(relative) = &relative {
        security::relative(relative)?;
    }
    Ok(Source {
        parent,
        leaf,
        absolute,
        relative,
        kind: kind.into(),
    })
}
impl Workspace {
    pub fn inspect_dropped_move(&mut self, paths: &[PathBuf]) -> Result<Response> {
        self.authorize(&self.project.id, true, false)?;
        if paths.is_empty() || paths.len() > 100 {
            return Err(AppError::limit());
        }
        let mut entries = Vec::new();
        for path in paths {
            let source = source(path, Path::new(&self.project.root))?;
            let id = if let Some(relative) = &source.relative {
                self.register(relative.clone())
            } else {
                blake3::hash(
                    format!("{}:external:{:?}", self.project.id, source.absolute).as_bytes(),
                )
                .to_hex()
                .to_string()
            };
            entries.push(Entry {
                id,
                path: security::display(source.relative.as_deref().unwrap_or(&source.absolute)),
                name: security::display(&source.leaf),
                kind: source.kind,
            });
        }
        Ok(Response::Entries {
            entries,
            truncated: false,
        })
    }
    pub fn prepare_dropped_move(
        &self,
        paths: &[PathBuf],
        parent: Option<&str>,
    ) -> Result<IncomingMove> {
        self.authorize(&self.project.id, true, true)?;
        if paths.is_empty() || paths.len() > 100 {
            return Err(AppError::limit());
        }
        let base = parent
            .map(|id| self.entry(id))
            .transpose()?
            .unwrap_or_default();
        let destination = security::directory(&self.dir, &base)?;
        let mut parsed = paths
            .iter()
            .map(|path| source(path, Path::new(&self.project.root)))
            .collect::<Result<Vec<_>>>()?;
        let directories: Vec<_> = parsed
            .iter()
            .filter(|s| s.kind == "directory")
            .map(|s| s.absolute.clone())
            .collect();
        let mut seen = std::collections::HashSet::new();
        parsed.retain(|s| {
            seen.insert(s.absolute.clone())
                && !directories
                    .iter()
                    .any(|d| *d != s.absolute && s.absolute.starts_with(d))
        });
        let mut sources = Vec::<Source>::new();
        for source in parsed {
            let target = Path::new(&self.project.root).join(&base).join(&source.leaf);
            if target == source.absolute {
                continue;
            }
            if target.starts_with(&source.absolute) {
                return Err(AppError::new(
                    "unsafePath",
                    "A folder cannot be moved into itself",
                ));
            }
            if self.documents.values().any(|d| {
                Path::new(&self.project.root)
                    .join(&d.dto.path)
                    .starts_with(&source.absolute)
            }) || self.media.values().any(|m| {
                Path::new(&self.project.root)
                    .join(&m.info.path)
                    .starts_with(&source.absolute)
            }) {
                return Err(AppError::conflict(
                    "Close the source's editors and previews before moving it",
                ));
            }
            let exists = match destination.symlink_metadata(&source.leaf) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            };
            if sources.iter().any(|old| old.leaf == source.leaf) || exists {
                return Err(AppError::new(
                    "alreadyExists",
                    format!(
                        "“{}” already exists in the destination folder. Choose another folder.",
                        security::display(&source.leaf)
                    ),
                ));
            }
            #[cfg(unix)]
            {
                use cap_std::fs::MetadataExt;
                if source.parent.dir_metadata()?.dev() != destination.dir_metadata()?.dev() {
                    return Err(AppError::new(
                        "crossDevice",
                        "This drop crosses disks. No files were moved. Use the system file manager to move them between disks.",
                    ));
                }
            }
            #[cfg(windows)]
            if crate::windows_fs::identity(&source.parent)?.volume
                != crate::windows_fs::identity(&destination)?.volume
            {
                return Err(AppError::new(
                    "crossDevice",
                    "This drop crosses disks. No files were moved. Use the system file manager to move them between disks.",
                ));
            }
            sources.push(source);
        }
        // A selected directory already includes selected descendants.
        let directories: Vec<_> = sources
            .iter()
            .filter(|s| s.kind == "directory")
            .map(|s| s.absolute.clone())
            .collect();
        sources.retain(|s| {
            !directories
                .iter()
                .any(|d| *d != s.absolute && s.absolute.starts_with(d))
        });
        let root = self.dir.try_clone()?;
        self.activity
            .compare_exchange(0, 4, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AppError::new("workspaceBusy", "Another file operation is in progress"))?;
        Ok(IncomingMove {
            scope: self.project.id.clone(),
            project: self.project.clone(),
            root,
            destination,
            base,
            sources,
            activity: self.activity.clone(),
        })
    }
    pub fn finish_dropped_move(&mut self, result: &MoveResult) -> Result<Response> {
        for path in &result.sources {
            if let Ok(relative) = path.strip_prefix(&self.project.root) {
                self.entries.retain(|_, p| !p.starts_with(relative));
            }
            self.external_files
                .retain(|_, file| !file.path.starts_with(path));
        }
        let mut entries = Vec::new();
        for path in &result.targets {
            let (parent, leaf) = security::parent(&self.dir, path)?;
            let metadata = parent.symlink_metadata(&leaf)?;
            entries.push(Entry {
                id: self.register(path.clone()),
                path: security::display(path),
                name: security::display(&leaf),
                kind: if metadata.file_type().is_symlink() {
                    "link"
                } else if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
            });
        }
        Ok(Response::FileDrop {
            entries,
            errors: result
                .error
                .as_ref()
                .map(|e| {
                    format!(
                        "{} item(s) moved; remaining items were kept. {}",
                        result.targets.len(),
                        e.message
                    )
                })
                .into_iter()
                .collect(),
        })
    }
}
impl IncomingMove {
    pub fn execute(&self) -> MoveResult {
        let mut result = MoveResult {
            sources: vec![],
            targets: vec![],
            error: None,
        };
        for source in &self.sources {
            let moved = (|| -> Result<()> {
                if security::project_identity(&self.project)? != self.scope
                    || security::identity_of_dir(
                        Path::new(
                            self.project
                                .identity_root
                                .as_deref()
                                .unwrap_or(&self.project.root),
                        ),
                        &self.root,
                    )? != self.scope
                {
                    return Err(AppError::conflict(
                        "Project identity changed; remaining sources were retained",
                    ));
                }
                let source_parent = source.absolute.parent().ok_or_else(AppError::limit)?;
                if security::identity(source_parent)?
                    != security::identity_of_dir(source_parent, &source.parent)?
                {
                    return Err(AppError::conflict(
                        "A source folder moved or changed; remaining sources were retained",
                    ));
                }
                let fresh_destination = security::directory(&self.root, &self.base)?;
                let target_path = Path::new(&self.project.root).join(&self.base);
                if security::identity_of_dir(&target_path, &fresh_destination)?
                    != security::identity_of_dir(&target_path, &self.destination)?
                {
                    return Err(AppError::conflict(
                        "The destination folder moved or changed; remaining sources were retained",
                    ));
                }
                crate::files::rename_noreplace(
                    &source.parent,
                    &source.leaf,
                    &self.destination,
                    &source.leaf,
                )?;
                Ok(())
            })();
            if let Err(error) = moved {
                result.error = Some(error);
                break;
            }
            result.sources.push(source.absolute.clone());
            result.targets.push(self.base.join(&source.leaf));
            #[cfg(unix)]
            if source
                .parent
                .try_clone()
                .and_then(|d| d.into_std_file().sync_all())
                .is_err()
                || self
                    .destination
                    .try_clone()
                    .and_then(|d| d.into_std_file().sync_all())
                    .is_err()
            {
                result.error = Some(AppError::new(
                    "unknownOutcome",
                    "A move completed but durability could not be confirmed. Inspect both locations before retrying.",
                ));
                break;
            }
        }
        result
    }
}
