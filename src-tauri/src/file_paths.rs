use crate::{
    dto::*,
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use std::path::{Path, PathBuf};

pub struct PathRead {
    pub project: Project,
    pub path: PathBuf,
    kind: FilePathKind,
    git: Option<PathBuf>,
    directory: PathBuf,
}
fn text(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        AppError::new(
            "encoding",
            "This filename contains bytes that cannot be copied as clipboard text",
        )
    })
}
impl PathRead {
    pub fn read(&self) -> Result<String> {
        match self.kind {
            FilePathKind::Name => {
                text(Path::new(self.path.file_name().ok_or_else(|| {
                    AppError::new("scope", "No file name for this entry")
                })?))
            }
            FilePathKind::Project => text(&self.path),
            FilePathKind::Absolute => text(&Path::new(&self.project.root).join(&self.path)),
            FilePathKind::Git => {
                let root = crate::git::path_repository_root(
                    self.git.as_deref().ok_or_else(|| {
                        AppError::new("runtime", "Configure Git to copy a Git-relative path")
                    })?,
                    &self.directory,
                )?;
                let absolute = Path::new(&self.project.root).join(&self.path);
                let relative = absolute.strip_prefix(root).map_err(|_| {
                    AppError::new("scope", "The item is outside this Git repository")
                })?;
                text(if relative.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    relative
                })
            }
        }
    }
}
impl Workspace {
    pub fn path_read(
        &self,
        entry: &str,
        kind: FilePathKind,
        git: Option<PathBuf>,
    ) -> Result<PathRead> {
        self.authorize(&self.project.id, kind == FilePathKind::Git, false)?;
        let path = self.entry(entry)?;
        security::relative(&path)?;
        let mut directory =
            Path::new(&self.project.root).join(path.parent().unwrap_or(Path::new("")));
        if kind == FilePathKind::Git {
            let (parent, leaf) = security::parent(&self.dir, &path)?;
            match parent.symlink_metadata(&leaf) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    security::directory(&self.dir, &path)?;
                    directory = Path::new(&self.project.root).join(&path);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(PathRead {
            project: self.project.clone(),
            path,
            kind,
            git,
            directory,
        })
    }
    /// Return only the registered root-to-item chain; never scan descendants.
    pub fn reveal_entry(&mut self, entry: &str) -> Result<Response> {
        let path = self.entry(entry)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let metadata = parent
            .symlink_metadata(&leaf)
            .map_err(|error| AppError::from(error).file_context("locate", &path))?;
        let mut chain = path
            .ancestors()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect::<Vec<_>>();
        if chain.len() > 256 {
            return Err(AppError::limit());
        }
        chain.reverse();
        let mut entries = Vec::with_capacity(chain.len());
        for item in chain {
            let kind = if item != path || metadata.is_dir() {
                "directory"
            } else if metadata.file_type().is_symlink() {
                "link"
            } else if metadata.is_file() {
                "file"
            } else {
                "special"
            };
            let id = self.register(item.clone());
            entries.push(Entry {
                id,
                name: security::display(Path::new(item.file_name().unwrap())),
                path: security::display(&item),
                kind: kind.into(),
            });
        }
        Ok(Response::Entries {
            entries,
            truncated: false,
        })
    }
}
