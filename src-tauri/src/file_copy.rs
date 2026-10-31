//! Copies are staged privately and published exclusively through scoped directory
//! handles. Sources are never removed, even after partial success or failure.
use crate::{
    dto::{Entry, Response},
    error::{AppError, Result},
    incoming_move::{Source, source},
    security,
    workspace::Workspace,
};
use cap_std::fs::Dir;
use std::path::{Path, PathBuf};

struct CopySource {
    source: Source,
    fingerprint: String,
}
pub struct FileCopy {
    scope: String,
    root: Dir,
    project: crate::dto::Project,
    destination: Dir,
    staging: Dir,
    base: PathBuf,
    sources: Vec<CopySource>,
}
pub struct StagedCopy {
    directory: Dir,
    parent: Dir,
    name: PathBuf,
    source: usize,
}
impl Drop for StagedCopy {
    fn drop(&mut self) {
        let _ = self.parent.remove_dir_all(&self.name);
    }
}
impl Workspace {
    pub fn prepare_file_copy(
        &self,
        paths: &[PathBuf],
        parent: Option<&str>,
        storage_root: &Path,
    ) -> Result<FileCopy> {
        self.authorize(&self.project.id, true, true)?;
        if paths.is_empty() || paths.len() > 100 {
            return Err(AppError::new(
                "clipboard",
                "Copy between 1 and 100 files or folders at a time.",
            ));
        }
        let base = parent
            .map(|id| self.entry(id))
            .transpose()?
            .unwrap_or_default();
        let destination = security::directory(&self.dir, &base)?;
        // Reuse private recovery storage only as a temporary parent on the
        // destination volume. Ordinary copies never enter the watched project.
        let staging = Dir::open_ambient_dir(storage_root, cap_std::ambient_authority())
            .ok()
            .filter(|private| same_volume(private, &destination).unwrap_or(false))
            .unwrap_or(destination.try_clone()?);
        let parsed = paths
            .iter()
            .map(|path| source(path, Path::new(&self.project.root)))
            .collect::<Result<Vec<_>>>()?;
        let directories = parsed
            .iter()
            .filter(|s| s.kind == "directory")
            .map(|s| s.absolute.clone())
            .collect::<Vec<_>>();
        let mut seen = std::collections::HashSet::new();
        let mut sources = Vec::new();
        for item in parsed {
            if !seen.insert(item.absolute.clone())
                || directories
                    .iter()
                    .any(|dir| *dir != item.absolute && item.absolute.starts_with(dir))
            {
                continue;
            }
            if item.kind == "directory"
                && Path::new(&self.project.root)
                    .join(&base)
                    .starts_with(&item.absolute)
            {
                return Err(AppError::new(
                    "unsafePath",
                    "A folder cannot be pasted into itself or one of its subfolders.",
                ));
            }
            let (fingerprint, _) = copy_fingerprint(&item.parent, &item.leaf)?;
            sources.push(CopySource {
                source: item,
                fingerprint,
            });
        }
        Ok(FileCopy {
            scope: self.project.id.clone(),
            project: self.project.clone(),
            root: self.dir.try_clone()?,
            destination,
            staging,
            base,
            sources,
        })
    }
}
impl FileCopy {
    /// Expensive copying runs outside the host mutex. Only publication needs the
    /// current host's trust/scope and short filesystem mutation lock.
    pub fn execute(
        &self,
        mut publish: impl FnMut(&Self, &StagedCopy) -> Result<(Entry, Option<AppError>)>,
    ) -> Response {
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        for source in 0..self.sources.len() {
            let result = self.stage(source).and_then(|stage| publish(self, &stage));
            match result {
                Ok((entry, warning)) => {
                    entries.push(entry);
                    if let Some(warning) = warning {
                        errors.push(warning.message);
                        break;
                    }
                }
                Err(error) => {
                    errors.push(format!(
                        "{} item(s) copied; remaining originals were kept. {}",
                        entries.len(),
                        error.message
                    ));
                    break;
                }
            }
        }
        Response::FileDrop { entries, errors }
    }
    fn stage(&self, index: usize) -> Result<StagedCopy> {
        let source = &self.sources[index];
        self.check_destination()?;
        let name: PathBuf = format!(".workspace-copy-{}", uuid::Uuid::new_v4()).into();
        self.staging.create_dir(&name)?;
        let directory = security::directory(&self.staging, &name)?;
        let stage = StagedCopy {
            directory,
            parent: self.staging.try_clone()?,
            name,
            source: index,
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            stage
                .directory
                .try_clone()?
                .into_std_file()
                .set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
        self.check_source(source)?;
        copy_object(
            &source.source.parent,
            &source.source.leaf,
            &stage.directory,
            Path::new("payload"),
            0,
        )
        .map_err(|error| error.file_context("copy", &source.source.leaf))?;
        self.check_source(source)?;
        Ok(stage)
    }
    fn check_source(&self, source: &CopySource) -> Result<()> {
        let parent = source
            .source
            .absolute
            .parent()
            .ok_or_else(AppError::limit)?;
        if security::identity(parent)? != security::identity_of_dir(parent, &source.source.parent)?
            || copy_fingerprint(&source.source.parent, &source.source.leaf)?.0 != source.fingerprint
        {
            return Err(AppError::conflict(
                "A copied source changed. Originals were kept; copy the current version again.",
            ));
        }
        Ok(())
    }
    fn check_destination(&self) -> Result<()> {
        let origin = Path::new(
            self.project
                .identity_root
                .as_deref()
                .unwrap_or(&self.project.root),
        );
        if security::project_identity(&self.project)? != self.scope
            || security::identity_of_dir(origin, &self.root)? != self.scope
        {
            return Err(AppError::conflict(
                "The project moved or changed; the copy was not published.",
            ));
        }
        let fresh = security::directory(&self.root, &self.base)?;
        let absolute = Path::new(&self.project.root).join(&self.base);
        if security::identity_of_dir(&absolute, &fresh)?
            != security::identity_of_dir(&absolute, &self.destination)?
        {
            return Err(AppError::conflict(
                "The destination folder moved or changed; the copy was not published.",
            ));
        }
        Ok(())
    }
    pub fn publish(
        &self,
        workspace: &mut Workspace,
        stage: &StagedCopy,
    ) -> Result<(Entry, Option<AppError>)> {
        workspace.authorize(&self.scope, true, true)?;
        self.check_destination()?;
        let source = &self.sources[stage.source];
        self.check_source(source)?;
        for number in 0..1000 {
            let name = copy_name(
                &source.source.leaf,
                number,
                source.source.kind == "directory",
            );
            match crate::files::rename_noreplace(
                &stage.directory,
                Path::new("payload"),
                &self.destination,
                &name,
            ) {
                Err(error) if error.code == "alreadyExists" => continue,
                Err(error) => return Err(error.file_context("paste", &self.base.join(&name))),
                Ok(()) => {
                    let path = self.base.join(&name);
                    let entry = Entry {
                        id: workspace.register(path.clone()),
                        path: security::display(&path),
                        name: security::display(&name),
                        kind: source.source.kind.clone(),
                    };
                    #[cfg(unix)]
                    let warning = self.destination.try_clone().and_then(|d| d.into_std_file().sync_all()).err().map(|_| AppError::new("unknownOutcome", "The copy was created, but durability could not be confirmed. Inspect it before pasting again."));
                    #[cfg(not(unix))]
                    let warning = None;
                    return Ok((entry, warning));
                }
            }
        }
        Err(AppError::new(
            "alreadyExists",
            "Too many files have this copy name. Rename an existing copy or choose another folder.",
        ))
    }
}
fn same_volume(a: &Dir, b: &Dir) -> Result<bool> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(a.dir_metadata()?.dev() == b.dir_metadata()?.dev())
    }
    #[cfg(windows)]
    {
        Ok(crate::windows_fs::identity(a)?.volume == crate::windows_fs::identity(b)?.volume)
    }
}
fn copy_fingerprint(parent: &Dir, leaf: &Path) -> Result<(String, bool)> {
    #[cfg(not(windows))]
    {
        crate::files::entry_fingerprint(parent, leaf)
    }
    #[cfg(windows)]
    {
        let metadata = parent.symlink_metadata(leaf)?;
        let identity = if metadata.is_dir() {
            crate::windows_fs::identity(&crate::windows_fs::open_directory(parent, leaf)?)?
        } else {
            crate::windows_fs::identity(&crate::windows_fs::open_read(parent, leaf)?)?
        };
        Ok((
            format!(
                "{:?}:{:?}:{:?}:{}:{:?}",
                identity.id,
                metadata.modified().ok(),
                metadata.created().ok(),
                metadata.len(),
                metadata.permissions()
            ),
            metadata.is_dir(),
        ))
    }
}
fn copy_name(original: &Path, number: usize, directory: bool) -> PathBuf {
    if number == 0 {
        return original.into();
    }
    let mut name = if directory {
        original.as_os_str()
    } else {
        original.file_stem().unwrap_or(original.as_os_str())
    }
    .to_os_string();
    name.push(if number == 1 {
        " copy".into()
    } else {
        format!(" copy {number}")
    });
    if let Some(extension) = original.extension().filter(|_| !directory) {
        name.push(".");
        name.push(extension);
    }
    name.into()
}
#[cfg(target_os = "macos")]
fn copy_object(from: &Dir, source: &Path, to: &Dir, target: &Path, depth: usize) -> Result<()> {
    use cap_fs_ext::OpenOptionsFollowExt;
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    if depth > 128 {
        return Err(AppError::new(
            "resourceLimit",
            "This folder tree exceeds the supported copy depth.",
        ));
    }
    let before = copy_fingerprint(from, source)?;
    let metadata = from.symlink_metadata(source)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        let src = security::directory(from, source)?;
        to.create_dir(target)?;
        let dst = security::directory(to, target)?;
        for child in src.entries()? {
            let name = child?.file_name();
            copy_object(&src, Path::new(&name), &dst, Path::new(&name), depth + 1)?;
        }
        native_copy_metadata(
            &src.try_clone()?.into_std_file(),
            &dst.try_clone()?.into_std_file(),
            libc::COPYFILE_METADATA,
        )?;
        dst.try_clone()?.into_std_file().sync_all()?;
    } else if metadata.is_file() {
        let src = security::open_read(from, source)?;
        let name = CString::new(target.as_os_str().as_bytes())
            .map_err(|_| AppError::new("unsafePath", "Invalid native filename"))?;
        unsafe extern "C" {
            fn fclonefileat(
                source: libc::c_int,
                destination: libc::c_int,
                name: *const libc::c_char,
                flags: u32,
            ) -> libc::c_int;
        }
        // SAFETY: owned live FDs and a NUL-terminated single leaf; clone creates
        // a new inode exclusively. It cannot follow an existing destination.
        let cloned =
            unsafe { fclonefileat(src.as_raw_fd(), to.as_raw_fd(), name.as_ptr(), 0x0004) } == 0;
        if !cloned {
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(
                    libc::ENOTSUP
                        | libc::EINVAL
                        | libc::EXDEV
                        | libc::ENOSYS
                        | libc::EPERM
                        | libc::EACCES
                )
            ) {
                return Err(error.into());
            }
            let mut options = cap_std::fs::OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(cap_fs_ext::FollowSymlinks::No);
            let dst = to.open_with(target, &options)?.into_std();
            native_copy_metadata(&src, &dst, libc::COPYFILE_METADATA | libc::COPYFILE_DATA)?;
            dst.sync_all()?;
        } else {
            let dst = security::open_read(to, target)?;
            native_copy_metadata(&src, &dst, libc::COPYFILE_METADATA)?;
            dst.sync_all()?;
        }
    } else if metadata.file_type().is_symlink() {
        to.symlink_contents(from.read_link_contents(source)?, target)?;
        let link = |parent: &Dir, leaf: &Path| -> Result<std::fs::File> {
            let name = CString::new(leaf.as_os_str().as_bytes())
                .map_err(|_| AppError::new("unsafePath", "Invalid native filename"))?;
            // SAFETY: pinned parent FD and one validated native component.
            // O_SYMLINK opens the link itself without following it. Combining it
            // with O_NOFOLLOW is rejected by macOS; verify the returned type.
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC | libc::O_SYMLINK,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            if !file.metadata()?.file_type().is_symlink() {
                return Err(AppError::conflict("A link changed during copying."));
            }
            Ok(file)
        };
        native_copy_metadata(
            &link(from, source)?,
            &link(to, target)?,
            libc::COPYFILE_METADATA,
        )?;
    } else {
        return Err(AppError::new(
            "unsupported",
            "Special devices cannot be copied through Explorer.",
        ));
    }
    if copy_fingerprint(from, source)? != before {
        return Err(AppError::conflict(
            "A source changed during copying. Originals were kept.",
        ));
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn native_copy_metadata(
    source: &std::fs::File,
    destination: &std::fs::File,
    flags: libc::copyfile_flags_t,
) -> Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: live owned descriptors; null state selects Apple's defaults.
    if unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            flags,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn copy_object(from: &Dir, source: &Path, to: &Dir, target: &Path, depth: usize) -> Result<()> {
    if depth > 128 {
        return Err(AppError::new(
            "resourceLimit",
            "This folder tree exceeds the supported copy depth.",
        ));
    }
    let metadata = from.symlink_metadata(source)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        to.create_dir(target)?;
        let src = security::directory(from, source)?;
        let dst = security::directory(to, target)?;
        for child in src.entries()? {
            let name = child?.file_name();
            copy_object(&src, Path::new(&name), &dst, Path::new(&name), depth + 1)?;
        }
        #[cfg(unix)]
        copy_metadata(
            &src.try_clone()?.into_std_file(),
            &dst.try_clone()?.into_std_file(),
        )?;
        #[cfg(windows)]
        crate::windows_fs::copy_directory_metadata(from, source, to, target)?;
    } else if metadata.is_file() {
        let mut src = security::open_read(from, source)?;
        #[cfg(windows)]
        {
            return crate::windows_fs::copy_file(&src, to, target);
        }
        #[cfg(unix)]
        {
            use cap_fs_ext::OpenOptionsFollowExt;
            let mut options = cap_std::fs::OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(cap_fs_ext::FollowSymlinks::No);
            let mut dst = to.open_with(target, &options)?.into_std();
            std::io::copy(&mut src, &mut dst)?;
            copy_metadata(&src, &dst)?;
            dst.sync_all()?;
        }
    } else if metadata.file_type().is_symlink() {
        #[cfg(unix)]
        {
            to.symlink_contents(from.read_link_contents(source)?, target)?;
        }
        #[cfg(windows)]
        return Err(AppError::new(
            "unsupported",
            "Windows links cannot be copied through Explorer.",
        ));
    } else {
        return Err(AppError::new(
            "unsupported",
            "Special devices cannot be copied through Explorer.",
        ));
    }
    Ok(())
}
#[cfg(all(unix, not(target_os = "macos")))]
fn copy_metadata(source: &std::fs::File, destination: &std::fs::File) -> Result<()> {
    use xattr::FileExt;
    for name in source.list_xattr()? {
        if let Some(value) = source.get_xattr(&name)? {
            destination.set_xattr(&name, &value)?;
        }
    }
    destination.set_permissions(source.metadata()?.permissions())?;
    destination.set_times(
        std::fs::FileTimes::new()
            .set_accessed(source.metadata()?.accessed()?)
            .set_modified(source.metadata()?.modified()?),
    )?;
    Ok(())
}
