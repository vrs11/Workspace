use crate::error::{AppError, Result};
use atomic_write_file::AtomicWriteFile;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub struct Storage {
    pub root: PathBuf,
}
impl Storage {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { root })
    }
    pub fn read<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let path = self.root.join(name);
        if !path.exists() {
            return Ok(None);
        }
        let f = std::fs::File::open(&path)?;
        if f.metadata()?.len() > 64 * 1024 * 1024 {
            return Err(AppError::limit());
        }
        match serde_json::from_reader(f) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                let backup = path.with_extension(format!("corrupt-{}", uuid::Uuid::new_v4()));
                std::fs::copy(&path, backup)?;
                Err(AppError::new(
                    "corruptState",
                    "State is corrupt. A recoverable copy was retained; inspect application data before resetting.",
                ))
            }
        }
    }
    pub fn recovery_budget<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let next = serde_json::to_vec(value)?.len() as u64;
        let backup = Path::new(name)
            .with_extension("bak")
            .to_string_lossy()
            .to_string();
        let mut total = next
            + std::fs::metadata(self.root.join(name))
                .map(|m| m.len())
                .unwrap_or(0);
        let mut count = 1;
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let file = entry.file_name();
            let file = file.to_string_lossy();
            if file.starts_with("recovery-")
                && (file.ends_with(".json") || file.ends_with(".bak"))
                && file != name
                && file != backup
            {
                total = total.saturating_add(entry.metadata()?.len());
                if file.ends_with(".json") {
                    count += 1;
                }
            }
        }
        if total > 256 * 1024 * 1024 || count > 256 {
            return Err(AppError::new(
                "recoveryQuota",
                "Recovery quota reached (256 MiB / 256 files). Existing unsaved checkpoints were retained. Save or explicitly discard checkpointed files to free space, then retry.",
            ));
        }
        Ok(())
    }
    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let path = self.root.join(name);
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(AppError::limit());
        }
        if path.exists() {
            // Validate current state before replacing it; preserve last known good.
            let _: serde_json::Value = self
                .read(name)?
                .ok_or_else(|| AppError::new("notFound", "State disappeared"))?;
            atomic(&path.with_extension("bak"), &std::fs::read(&path)?)?;
        }
        atomic(&path, &bytes)
    }
    pub fn repair<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        let path = self.root.join(name);
        for (original, label) in [
            (path.clone(), "retained"),
            (path.with_extension("bak"), "backup-retained"),
        ] {
            if original.exists() {
                let retained =
                    path.with_extension(format!("{label}-{}.json", uuid::Uuid::new_v4()));
                let mut source = std::fs::File::open(original)?;
                let mut copy = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(retained)?;
                std::io::copy(&mut source, &mut copy)?;
                copy.sync_all()?;
            }
        }
        // Only explicit repair bypasses validation of current JSON; both the
        // damaged original and the previous backup remain available.
        atomic(&path, &serde_json::to_vec(value)?)
    }
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = AtomicWriteFile::open(path)?;
    file.write_all(bytes)?;
    file.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corruption_is_retained() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Storage::new(tmp.path().into()).unwrap();
        std::fs::write(tmp.path().join("state.json"), b"broken").unwrap();
        assert!(s.read::<serde_json::Value>("state.json").is_err());
        assert_eq!(
            std::fs::read(tmp.path().join("state.json")).unwrap(),
            b"broken"
        );
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 2);
    }
    #[test]
    fn atomic_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Storage::new(tmp.path().into()).unwrap();
        s.write("state.json", &vec![1]).unwrap();
        s.write("state.json", &vec![2]).unwrap();
        assert_eq!(s.read::<Vec<u32>>("state.json").unwrap(), Some(vec![2]));
        assert_eq!(s.read::<Vec<u32>>("state.bak").unwrap(), Some(vec![1]));
    }
}
