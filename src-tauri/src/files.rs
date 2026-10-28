use crate::{
    dto::Response,
    error::{AppError, Result},
    security,
    storage::Storage,
    workspace::Workspace,
};
#[cfg(not(windows))]
use cap_fs_ext::OpenOptionsFollowExt;
use cap_std::fs::Dir;
#[cfg(not(windows))]
use cap_std::fs::OpenOptions;
use std::{io::Read, path::Path};

impl Workspace {
    pub fn create(
        &mut self,
        parent: Option<&str>,
        name: &str,
        directory: bool,
    ) -> Result<Response> {
        security::name(name)?;
        let base = parent
            .map(|id| self.entry(id))
            .transpose()?
            .unwrap_or_default();
        let dir = security::directory(&self.dir, &base)?;
        let result = (|| -> Result<()> {
            #[cfg(windows)]
            crate::windows_fs::create(&dir, Path::new(name), directory)?;
            #[cfg(not(windows))]
            if directory {
                dir.create_dir(name)?;
            } else {
                let mut o = OpenOptions::new();
                o.write(true)
                    .create_new(true)
                    .follow(cap_fs_ext::FollowSymlinks::No);
                dir.open_with(name, &o)?.sync_all()?;
            }
            Ok(())
        })();
        result.map_err(|error| error.file_context("create", &base.join(name)))?;
        self.list(parent)
    }
    pub fn rename_entry(
        &mut self,
        entry: &str,
        parent: Option<&str>,
        name: &str,
    ) -> Result<Response> {
        security::name(name)?;
        self.rename_path(entry, parent, Path::new(name))
    }
    pub fn move_entry(&mut self, entry: &str, parent: Option<&str>) -> Result<Response> {
        let source = self.entry(entry)?;
        let name = source
            .file_name()
            .ok_or_else(|| AppError::new("unsafePath", "Project root cannot be moved"))?;
        self.rename_path(entry, parent, Path::new(name))
    }
    fn rename_path(&mut self, entry: &str, parent: Option<&str>, name: &Path) -> Result<Response> {
        security::relative(name)?;
        let source = self.entry(entry)?;
        if self
            .documents
            .iter()
            .any(|(id, _)| self.entries.get(id).is_some_and(|p| p.starts_with(&source)))
        {
            return Err(AppError::conflict(
                "Close open editors for this path before moving it",
            ));
        }
        let target_base = parent
            .map(|id| self.entry(id))
            .transpose()?
            .unwrap_or_default();
        if target_base.starts_with(&source) {
            return Err(AppError::new(
                "unsafePath",
                "A folder cannot be moved into itself or a descendant",
            ));
        }
        let (from, leaf) = security::parent(&self.dir, &source)?;
        let to = security::directory(&self.dir, &target_base)?;
        rename_noreplace(&from, &leaf, &to, name)
            .map_err(|error| error.file_context("rename or move", &target_base.join(name)))?;
        let target = target_base.join(name);
        let affected = self
            .entries
            .iter()
            .filter(|(_, p)| p.starts_with(&source))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in affected {
            self.documents.remove(&id);
            self.entries.remove(&id);
        }
        self.register(target);
        self.list(parent)
    }
    #[cfg(not(windows))]
    pub fn delete_entry(&mut self, entry: &str, storage: &Storage) -> Result<Response> {
        let path = self.entry(entry)?;
        if self
            .documents
            .iter()
            .any(|(id, _)| self.entries.get(id).is_some_and(|p| p.starts_with(&path)))
        {
            return Err(AppError::conflict(
                "Close open editors for this path before deleting",
            ));
        }
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let m = parent.symlink_metadata(&leaf)?;
        if m.is_dir() {
            self.recover_directory(&parent, &leaf, &path, storage)?;
        } else if m.is_file() {
            if m.len() > 20 * 1024 * 1024 {
                return Err(AppError::new(
                    "resourceLimit",
                    "File exceeds the recoverable-delete limit (20 MiB)",
                ));
            }
            let mut o = OpenOptions::new();
            o.read(true).follow(cap_fs_ext::FollowSymlinks::No);
            let mut f = parent.open_with(&leaf, &o)?.into_std();
            #[cfg(unix)]
            if !crate::documents::supported_metadata(&f)? {
                return Err(AppError::new(
                    "unsupported",
                    "Recoverable delete does not preserve this file's extended metadata. Use an appropriate native file tool.",
                ));
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                Some(f.metadata()?.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let mode = None;
            let mut bytes = Vec::new();
            (&mut f)
                .take(20 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 20 * 1024 * 1024 {
                return Err(AppError::limit());
            }
            let key = uuid::Uuid::new_v4().to_string();
            crate::storage::atomic(&storage.root.join(format!("trash-{key}.bin")), &bytes)?;
            storage.write(
                &format!("trash-{key}.json"),
                &Trash {
                    version: 1,
                    scope: self.project.id.clone(),
                    path: crate::documents::path_token(&path),
                    hash: Some(crate::documents::hash(&bytes)),
                    mode,
                    directory: None,
                },
            )?;
            if parent.read(&leaf)? != bytes {
                return Err(AppError::conflict(
                    "File changed before deletion; recovery copy kept and target retained",
                ));
            }
            parent.remove_file(&leaf)?;
        } else {
            return Err(AppError::new(
                "unsupported",
                "Links and special files cannot be deleted through this operation",
            ));
        }
        self.forget_deleted_path(&path);
        Ok(Response::Ok)
    }
    #[cfg(windows)]
    pub fn delete_entry(&mut self, entry: &str, storage: &Storage) -> Result<Response> {
        let path = self.entry(entry)?;
        if self
            .documents
            .keys()
            .any(|id| self.entries.get(id).is_some_and(|p| p.starts_with(&path)))
        {
            return Err(AppError::conflict(
                "Close open editors for this path before deleting",
            ));
        }
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        if crate::windows_fs::open_directory(&parent, &leaf).is_ok() {
            self.recover_directory(&parent, &leaf, &path, storage)?;
        } else {
            let mut file = crate::windows_fs::open_for_delete(&parent, &leaf)?;
            let backup = Dir::open_ambient_dir(&storage.root, cap_std::ambient_authority())?;
            let identity = crate::windows_fs::preserve_for_delete(&file, &parent, &backup)?;
            let mut bytes = Vec::new();
            (&mut file)
                .take(20 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 20 * 1024 * 1024 {
                return Err(AppError::limit());
            }
            let key = uuid::Uuid::new_v4().to_string();
            // Durable metadata precedes the atomic move. A crash before the
            // move leaves the original; after it, the whole original object
            // (including its security metadata) is in private recovery.
            storage.write(
                &format!("trash-{key}.json"),
                &Trash {
                    version: 1,
                    scope: self.project.id.clone(),
                    path: crate::documents::path_token(&path),
                    hash: Some(crate::documents::hash(&bytes)),
                    mode: None,
                    native_backup: Some(identity),
                    directory: None,
                },
            )?;
            crate::windows_fs::move_to_recovery(
                &file,
                &backup,
                Path::new(&format!("trash-{key}.bin")),
                &bytes,
            )?;
        }
        self.forget_deleted_path(&path);
        Ok(Response::Ok)
    }
    fn forget_deleted_path(&mut self, path: &Path) {
        self.entries.retain(|_, item| !item.starts_with(path));
    }
    fn recover_directory(
        &mut self,
        parent: &Dir,
        leaf: &Path,
        path: &Path,
        storage: &Storage,
    ) -> Result<()> {
        let source = security::directory(parent, leaf)?;
        let backup = Dir::open_ambient_dir(&storage.root, cap_std::ambient_authority())?;
        let identity = DirectoryIdentity::read(&source)?;
        if !identity.same_volume(&DirectoryIdentity::read(&backup)?) {
            return Err(AppError::new(
                "crossDevice",
                "This folder is on a different volume from private recovery. Nothing was deleted. Use your system file manager to move it to that volume’s Trash.",
            ));
        }
        if storage
            .root
            .canonicalize()?
            .starts_with(Path::new(&self.project.root).join(path))
        {
            return Err(AppError::new(
                "unsafePath",
                "This folder contains Workspace’s recovery data and cannot be deleted here.",
            ));
        }
        let key = uuid::Uuid::new_v4().to_string();
        let target = format!("trash-{key}.directory");
        // Persist intent before moving the whole object. No child enumeration,
        // byte copying or symlink traversal is needed, even for large trees.
        storage.write(
            &format!("trash-{key}.json"),
            &Trash {
                version: 2,
                scope: self.project.id.clone(),
                path: crate::documents::path_token(path),
                hash: None,
                mode: None,
                directory: Some(identity.clone()),
                #[cfg(windows)]
                native_backup: None,
            },
        )?;
        rename_noreplace(parent, leaf, &backup, Path::new(&target))
            .map_err(|error| error.file_context("delete", path))?;
        let retained = security::directory(&backup, Path::new(&target))?;
        if DirectoryIdentity::read(&retained)? != identity {
            return Err(AppError::new(
                "unknownOutcome",
                "The folder changed while being moved. The moved item was retained in private recovery. Refresh Explorer and inspect it before retrying.",
            ));
        }
        sync_directory_move(parent, &backup)?;
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct DirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    native: crate::windows_fs::Identity,
}
impl DirectoryIdentity {
    fn read(directory: &Dir) -> Result<Self> {
        #[cfg(unix)]
        {
            use cap_std::fs::MetadataExt;
            let metadata = directory.dir_metadata()?;
            Ok(Self {
                device: metadata.dev(),
                inode: metadata.ino(),
            })
        }
        #[cfg(windows)]
        {
            Ok(Self {
                native: crate::windows_fs::identity(directory)?,
            })
        }
    }
    fn same_volume(&self, other: &Self) -> bool {
        #[cfg(unix)]
        {
            self.device == other.device
        }
        #[cfg(windows)]
        {
            self.native.volume == other.native.volume
        }
    }
}
fn sync_directory_move(from: &Dir, to: &Dir) -> Result<()> {
    #[cfg(unix)]
    {
        let sync = |directory: &Dir| -> std::io::Result<()> {
            directory.try_clone()?.into_std_file().sync_all()
        };
        let original = sync(from);
        let recovery = sync(to);
        if original.is_err() || recovery.is_err() {
            return Err(AppError::new(
                "unknownOutcome",
                "The folder was moved but the filesystem could not confirm durability. Inspect the original location and private recovery before retrying.",
            ));
        }
    }
    #[cfg(windows)]
    let _ = (from, to); // Windows performs the existing handle-based native rename.
    Ok(())
}
pub fn rename_noreplace(from: &Dir, source: &Path, to: &Dir, target: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::fd::AsRawFd, os::unix::ffi::OsStrExt};
        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|_| AppError::new("unsafePath", "NUL path"))?;
        let target = CString::new(target.as_os_str().as_bytes())
            .map_err(|_| AppError::new("unsafePath", "NUL path"))?;
        #[cfg(target_os = "macos")]
        // SAFETY: directory FDs are owned live capabilities; CStrings are valid single leaf names.
        let result = unsafe {
            libc::renameatx_np(
                from.as_raw_fd(),
                source.as_ptr(),
                to.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        // SAFETY: directory FDs are owned live capabilities; CStrings are valid single leaf names.
        let result = unsafe {
            libc::renameat2(
                from.as_raw_fd(),
                source.as_ptr(),
                to.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        crate::windows_fs::rename_noreplace(from, source, to, target)
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Trash {
    version: u32,
    scope: String,
    path: String,
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    mode: Option<u32>,
    #[serde(default)]
    directory: Option<DirectoryIdentity>,
    #[cfg(windows)]
    #[serde(default)]
    native_backup: Option<crate::windows_fs::Identity>,
}
pub fn trash_list(scope: &str, storage: &Storage) -> Result<Response> {
    let mut items = Vec::new();
    let mut more = false;
    for entry in std::fs::read_dir(&storage.root)? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        if let Some(id) = name
            .strip_prefix("trash-")
            .and_then(|s| s.strip_suffix(".json"))
        {
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            if let Some(meta) = storage.read::<Trash>(&name)?.filter(|t| {
                t.scope == scope
                    && matches!((t.version, t.directory.is_some()), (1, false) | (2, true))
            }) {
                if meta.directory.is_some()
                    && !std::fs::symlink_metadata(
                        storage.root.join(format!("trash-{id}.directory")),
                    )
                    .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
                {
                    continue;
                }
                items.push(crate::dto::NamedItem {
                    id: id.into(),
                    label: security::display(&crate::documents::token_path(&meta.path)?),
                    detail: if meta.directory.is_some() {
                        "Recoverable deleted folder"
                    } else {
                        "Recoverable deleted file"
                    }
                    .into(),
                });
                if items.len() >= 1000 {
                    more = true;
                    break;
                }
            }
        }
    }
    items.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(Response::Items { items, more })
}
impl Workspace {
    pub fn trash_restore(&mut self, id: &str, storage: &Storage) -> Result<Response> {
        #[cfg(not(windows))]
        use std::io::Write;
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(AppError::new("scope", "Invalid deleted-item reference"));
        }
        let meta = storage
            .read::<Trash>(&format!("trash-{id}.json"))?
            .filter(|t| {
                t.scope == self.project.id
                    && matches!((t.version, t.directory.is_some()), (1, false) | (2, true))
            })
            .ok_or_else(|| AppError::new("notFound", "Deleted item not found in this project"))?;
        if let Some(identity) = &meta.directory {
            let path = crate::documents::token_path(&meta.path)?;
            let (parent, leaf) = security::parent(&self.dir, &path)?;
            let backup = Dir::open_ambient_dir(&storage.root, cap_std::ambient_authority())?;
            let source = format!("trash-{id}.directory");
            let retained = security::directory(&backup, Path::new(&source))?;
            if DirectoryIdentity::read(&retained)? != *identity {
                return Err(AppError::new(
                    "corruptState",
                    "Folder recovery identity changed. The retained folder was not moved.",
                ));
            }
            if !identity.same_volume(&DirectoryIdentity::read(&parent)?) {
                return Err(AppError::new(
                    "crossDevice",
                    "The original folder location is on a different volume. Recovery was retained; restore to the original volume.",
                ));
            }
            rename_noreplace(&backup, Path::new(&source), &parent, &leaf)
                .map_err(|error| error.file_context("restore", &path))?;
            sync_directory_move(&backup, &parent)?;
            self.register(path);
            return Ok(Response::Text { text: "Folder and all its contents restored without overwriting an existing destination.".into() });
        }
        let mut bytes = Vec::new();
        std::fs::File::open(storage.root.join(format!("trash-{id}.bin")))?
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 20 * 1024 * 1024
            || meta
                .hash
                .is_some_and(|hash| hash != crate::documents::hash(&bytes))
        {
            return Err(AppError::new(
                "corruptState",
                "Deleted-file recovery is corrupt; original copy retained",
            ));
        }
        let path = crate::documents::token_path(&meta.path)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        #[cfg(windows)]
        {
            let identity = meta.native_backup.ok_or_else(|| AppError::new("unsupported",
                "Legacy Windows recovery has no complete metadata identity; original recovery retained"))?;
            let backup = Dir::open_ambient_dir(&storage.root, cap_std::ambient_authority())?;
            let source =
                crate::windows_fs::open_read(&backup, Path::new(&format!("trash-{id}.bin")))?;
            crate::windows_fs::restore_copy(&source, &parent, &leaf, &identity, &bytes)
                .map_err(|error| error.file_context("restore", &path))?;
        }
        #[cfg(not(windows))]
        {
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(cap_fs_ext::FollowSymlinks::No);
            let mut restored = parent
                .open_with(&leaf, &options)
                .map_err(|error| AppError::from(error).file_context("restore", &path))?
                .into_std();
            let result = (|| -> Result<()> {
                restored.write_all(&bytes)?;
                #[cfg(unix)]
                if let Some(mode) = meta.mode {
                    use std::os::unix::fs::PermissionsExt;
                    restored.set_permissions(std::fs::Permissions::from_mode(mode & 0o777))?;
                }
                restored.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                return Err(AppError::new(
                    "unknownOutcome",
                    "Restore could not finish. Deleted-file recovery retained; inspect the destination before retrying",
                ));
            }
        }
        // Recovery stays available until the user confirms the restored file;
        // never remove its only copy after a partial write or uncertain sync.
        self.register(path);
        Ok(Response::Text{text:"Deleted file restored without overwriting an existing destination. Recovery copy retained.".into()})
    }
}
