use crate::error::{AppError, Result};
#[cfg(not(windows))]
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use std::path::{Component, Path, PathBuf};

pub fn relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(AppError::new("unsafePath", "NUL path refused"));
    }
    for component in path.components() {
        match component {
            Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git") => {
                #[cfg(windows)]
                {
                    let text = name.to_string_lossy();
                    let upper = text.to_uppercase();
                    if text.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c))
                        || text.ends_with(['.', ' '])
                        || [
                            "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2",
                            "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2",
                            "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
                        ]
                        .contains(&upper.split('.').next().unwrap_or(""))
                    {
                        return Err(AppError::new("unsafePath", "Unsupported Windows path"));
                    }
                }
            }
            _ => {
                return Err(AppError::new(
                    "unsafePath",
                    "Path traversal or Git metadata access refused",
                ));
            }
        }
    }
    Ok(())
}
pub fn name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 255
        || value.contains(['/', '\\', '\0'])
        || value == "."
        || value == ".."
        || value.eq_ignore_ascii_case(".git")
    {
        return Err(AppError::new("unsafePath", "Enter one ordinary file name"));
    }
    relative(Path::new(value))
}
pub fn parent(root: &Dir, path: &Path) -> Result<(Dir, PathBuf)> {
    relative(path)?;
    let leaf = path
        .file_name()
        .ok_or_else(|| AppError::new("unsafePath", "Root cannot be modified"))?;
    Ok((
        directory(root, path.parent().unwrap_or(Path::new("")))?,
        leaf.into(),
    ))
}
pub fn directory(root: &Dir, path: &Path) -> Result<Dir> {
    relative(path)?;
    let mut dir = root.try_clone()?;
    for component in path.components() {
        #[cfg(not(windows))]
        {
            dir = dir.open_dir_nofollow(component.as_os_str())?;
        }
        #[cfg(windows)]
        {
            dir = crate::windows_fs::open_directory(&dir, Path::new(component.as_os_str()))?;
        }
    }
    Ok(dir)
}
pub fn open_read(parent: &Dir, leaf: &Path) -> Result<std::fs::File> {
    #[cfg(windows)]
    {
        crate::windows_fs::open_read(parent, leaf)
    }
    #[cfg(not(windows))]
    {
        use cap_fs_ext::OpenOptionsFollowExt;
        let mut options = cap_std::fs::OpenOptions::new();
        options.read(true).follow(cap_fs_ext::FollowSymlinks::No);
        Ok(parent.open_with(leaf, &options)?.into_std())
    }
}
pub fn display(path: &Path) -> String {
    match path.to_str() {
        Some(s) => s.into(),
        None => format!(
            "{} [non-UTF-8]",
            path.as_os_str().to_string_lossy().escape_default()
        ),
    }
}
pub fn identity(path: &Path) -> Result<String> {
    let canonical = path.canonicalize()?;
    let dir = Dir::open_ambient_dir(&canonical, cap_std::ambient_authority())?;
    identity_of_dir(&canonical, &dir)
}
pub fn project_identity(project: &crate::dto::Project) -> Result<String> {
    let canonical = Path::new(&project.root).canonicalize()?;
    let dir = Dir::open_ambient_dir(&canonical, cap_std::ambient_authority())?;
    identity_of_dir(
        project
            .identity_root
            .as_deref()
            .map(Path::new)
            .unwrap_or(&canonical),
        &dir,
    )
}
pub fn identity_of_dir(canonical: &Path, dir: &Dir) -> Result<String> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let m = dir.dir_metadata()?;
        Ok(
            blake3::hash(format!("{:?}:{}:{}", canonical, m.dev(), m.ino()).as_bytes())
                .to_hex()
                .to_string(),
        )
    }
    #[cfg(windows)]
    {
        let native = crate::windows_fs::identity(dir)?;
        Ok(
            blake3::hash(format!("{:?}:{}:{:?}", canonical, native.volume, native.id).as_bytes())
                .to_hex()
                .to_string(),
        )
    }
}
pub fn executable(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::new(
            "missingExecutable",
            "Locate an absolute installed executable in Settings",
        ));
    }
    let path = path.canonicalize()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.metadata()?.permissions().mode() & 0o111 == 0 {
            return Err(AppError::new(
                "missingExecutable",
                "Selected file is not executable",
            ));
        }
    }
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_paths() {
        for p in [
            "../a",
            "/etc/passwd",
            "a/../b",
            ".git/config",
            "a/.git/index",
        ] {
            assert!(relative(Path::new(p)).is_err(), "{p}");
        }
        for n in ["", "..", "a/b", "a\\b", ".git", "a\0b"] {
            assert!(name(n).is_err());
        }
        for p in ["-file", "space name", "你好"] {
            assert!(relative(Path::new(p)).is_ok());
        }
        #[cfg(unix)]
        assert!(relative(Path::new(":(glob)file")).is_ok());
        #[cfg(unix)]
        assert!(relative(Path::new("a\nb")).is_ok());
        #[cfg(windows)]
        for p in [
            "file:stream",
            "CON",
            "nul.txt",
            "COM1",
            "LPT9.log",
            "trailing.",
            "trailing ",
            "a\nb",
            "wild*card",
            "question?",
            "pipe|file",
        ] {
            assert!(relative(Path::new(p)).is_err(), "{p}");
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlink_parent_refused() {
        let t = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/tmp", t.path().join("outside")).unwrap();
        let d = Dir::open_ambient_dir(t.path(), cap_std::ambient_authority()).unwrap();
        assert!(parent(&d, Path::new("outside/file")).is_err());
    }
    proptest::proptest! { #[test] fn names_cannot_escape(s in ".{0,200}") { if name(&s).is_ok() { proptest::prop_assert!(Path::new(&s).components().count() == 1); } } }
}
