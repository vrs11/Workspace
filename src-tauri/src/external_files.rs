//! Explicitly dropped files have file-only capabilities, never Explorer/Git authority.
use crate::{
    dto::{Entry, Response},
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub struct ExternalFile {
    pub path: PathBuf,
    parent: Option<Dir>,
    identity: String,
}
#[derive(Default, PartialEq, Serialize, Deserialize)]
pub struct ExternalUi {
    pub version: u32,
    pub tabs: Vec<PathBuf>,
    pub active: Option<PathBuf>,
    pub split: Option<PathBuf>,
}
impl Workspace {
    pub fn register_dropped_file(&mut self, path: &Path) -> Result<Entry> {
        if !path.is_absolute() || path.as_os_str().len() > 8192 {
            return Err(AppError::new("unsafePath", "Drop an ordinary local file."));
        }
        // Resolve the containing directory only. Never silently follow the final link.
        let leaf = PathBuf::from(path.file_name().ok_or_else(|| {
            AppError::new(
                "unsupported",
                "Drop files into the editor; open folders with Open folder.",
            )
        })?);
        security::relative(&leaf)?;
        let root = path.parent().ok_or_else(AppError::limit)?.canonicalize()?;
        let parent = Dir::open_ambient_dir(&root, cap_std::ambient_authority())?;
        if root.components().any(|c| matches!(c, std::path::Component::Normal(name) if name.to_string_lossy().eq_ignore_ascii_case(".git") || name.to_string_lossy().eq_ignore_ascii_case(".agent-workspace"))) { return Err(AppError::new("unsafePath", "Application and Git metadata cannot be edited as dropped files.")); }
        let metadata = parent.symlink_metadata(&leaf)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::new(
                "unsupported",
                "Only ordinary local files can be dropped into the editor. Use Open folder for a folder.",
            ));
        }
        // Reuse the existing entry/model when this is a project file.
        let absolute = root.join(&leaf);
        if let Ok(relative) = absolute.strip_prefix(&self.project.root) {
            security::relative(relative)?;
            let _ = security::parent(&self.dir, relative)?;
            let path = relative.to_path_buf();
            let id = self.register(path.clone());
            return Ok(Entry {
                id,
                name: security::display(&leaf),
                path: security::display(&path),
                kind: "file".into(),
            });
        }
        if absolute.to_str().is_none() {
            return Err(AppError::new(
                "unsupported",
                "This external filename cannot be represented by the native drag service.",
            ));
        }
        let id = blake3::hash(format!("{}:external:{absolute:?}", self.project.id).as_bytes())
            .to_hex()
            .to_string();
        if !self.external_files.contains_key(&id) && self.external_files.len() >= 100 {
            return Err(AppError::new(
                "resourceLimit",
                "Close an external file before opening another (100 files).",
            ));
        }
        let identity = security::identity_of_dir(&root, &parent)?;
        if security::identity(&root)? != identity {
            return Err(AppError::conflict(
                "The file's folder changed while opening.",
            ));
        }
        self.external_files.insert(
            id.clone(),
            ExternalFile {
                path: absolute.clone(),
                parent: Some(parent),
                identity,
            },
        );
        Ok(Entry {
            id,
            name: security::display(&leaf),
            path: security::display(&absolute),
            kind: "file".into(),
        })
    }
    pub fn register_external_recovery(&mut self, path: &Path, expected: &str) -> Result<Entry> {
        if !path.is_absolute() || path.as_os_str().len() > 8192 || path.to_str().is_none() {
            return Err(AppError::new(
                "unsafePath",
                "Invalid external recovery reference",
            ));
        }
        let id = blake3::hash(format!("{}:external:{path:?}", self.project.id).as_bytes())
            .to_hex()
            .to_string();
        if id != expected {
            return Err(AppError::new(
                "scope",
                "External recovery identity mismatch",
            ));
        }
        if let Ok(entry) = self.register_dropped_file(path) {
            return Ok(entry);
        }
        if self.external_files.len() >= 100 && !self.external_files.contains_key(&id) {
            return Err(AppError::limit());
        }
        self.external_files
            .entry(id.clone())
            .or_insert(ExternalFile {
                path: path.into(),
                parent: None,
                identity: String::new(),
            });
        Ok(Entry {
            id,
            name: security::display(Path::new(path.file_name().ok_or_else(AppError::limit)?)),
            path: security::display(path),
            kind: "file".into(),
        })
    }
    pub fn external_ui(
        &self,
        tabs: &[String],
        active: &Option<String>,
        split: &Option<String>,
    ) -> ExternalUi {
        let path = |id: &String| self.external_files.get(id).map(|file| file.path.clone());
        ExternalUi {
            version: 1,
            tabs: tabs.iter().filter_map(path).collect(),
            active: active.as_ref().and_then(path),
            split: split.as_ref().and_then(path),
        }
    }
    pub fn document_path(&self, id: &str) -> Result<PathBuf> {
        match self.external_files.get(id) {
            Some(file) => Ok(file.path.clone()),
            None => self.entry(id),
        }
    }
    pub fn document_parent(&self, id: &str) -> Result<(Dir, PathBuf)> {
        if let Some(file) = self.external_files.get(id) {
            let parent = file.parent.as_ref().ok_or_else(|| {
                AppError::new(
                    "notFound",
                    "The original external file is unavailable; recovery is retained.",
                )
            })?;
            let parent_path = file.path.parent().ok_or_else(AppError::limit)?;
            if security::identity(parent_path)? != file.identity
                || security::identity_of_dir(parent_path, parent)? != file.identity
            {
                return Err(AppError::conflict(
                    "The external file's folder moved or changed. Reopen the file; unsaved recovery is retained.",
                ));
            }
            return Ok((
                parent.try_clone()?,
                file.path.file_name().ok_or_else(AppError::limit)?.into(),
            ));
        }
        security::parent(&self.dir, &self.entry(id)?)
    }
    pub fn dropped_files(&mut self, paths: &[PathBuf]) -> Result<Response> {
        if paths.is_empty() || paths.len() > 100 {
            return Err(AppError::limit());
        }
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        for path in paths {
            match self.register_dropped_file(path) {
                Ok(entry) if !entries.iter().any(|e: &Entry| e.id == entry.id) => {
                    entries.push(entry)
                }
                Ok(_) => {}
                Err(error) => errors.push(format!(
                    "{}: {}",
                    security::display(path.file_name().map(Path::new).unwrap_or(path)),
                    error.message
                )),
            }
        }
        Ok(Response::FileDrop { entries, errors })
    }
    pub fn drag_paths(&self, ids: &[String]) -> Result<Vec<PathBuf>> {
        self.authorize(&self.project.id, false, false)?;
        if ids.is_empty() || ids.len() > 100 {
            return Err(AppError::limit());
        }
        ids.iter()
            .map(|id| {
                let path = self.document_path(id)?;
                let (parent, leaf) = self.document_parent(id)?;
                let metadata = parent.symlink_metadata(&leaf)?;
                if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
                    return Err(AppError::new(
                        "unsupported",
                        "Only ordinary files and folders can be dragged.",
                    ));
                }
                let absolute = Path::new(&self.project.root).join(path);
                if absolute.to_str().is_none() {
                    return Err(AppError::new(
                        "encoding",
                        "This filename cannot be passed to the operating system drag service.",
                    ));
                }
                Ok(absolute)
            })
            .collect()
    }
}
