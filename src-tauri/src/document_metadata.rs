//! Bounded, session-only review of metadata that an atomic text save cannot copy.
//! Approval is tied to file identity/change time and the supported small values.
//! Unsupported values (including large resource forks) are never loaded/copied.
use crate::{
    dto::MetadataWarning,
    error::{AppError, Result},
};
use std::{
    ffi::OsString,
    fs::File,
    os::unix::{ffi::OsStrExt, fs::MetadataExt},
};
use xattr::FileExt;

// These small attributes can be copied and verified during atomic replacement.
// MACL is normal OS metadata on files handed between Finder and applications;
// it must not become a read-only/loss warning merely because a file was dragged.
const PRESERVED_ATTRIBUTE_LIMIT: usize = 64 * 1024;
pub(crate) fn can_preserve(file: &File, key: &std::ffi::OsStr) -> Result<bool> {
    let known =
        key == "com.apple.provenance" || (cfg!(target_os = "macos") && key == "com.apple.macl");
    if !known {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    return Ok(attribute_size(file, key)? <= PRESERVED_ATTRIBUTE_LIMIT);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file;
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
fn attribute_size(file: &File, key: &std::ffi::OsStr) -> Result<usize> {
    use std::os::fd::AsRawFd;
    let key = std::ffi::CString::new(key.as_bytes()).map_err(|_| AppError::limit())?;
    let size = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            key.as_ptr(),
            std::ptr::null_mut(),
            0,
            0,
            0,
        )
    };
    if size < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(size as usize)
}
pub(crate) fn read_preserved(file: &File, key: &std::ffi::OsStr) -> Result<Vec<u8>> {
    if !can_preserve(file, key)? {
        return Err(changed());
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // Bound before allocating. A value that grows concurrently fails the
        // descriptor read instead of allocating an unbounded attribute value.
        let size = attribute_size(file, key)?;
        if size > PRESERVED_ATTRIBUTE_LIMIT {
            return Err(changed());
        }
        let key = std::ffi::CString::new(key.as_bytes()).map_err(|_| AppError::limit())?;
        let mut value = vec![0; size];
        let read = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                key.as_ptr(),
                value.as_mut_ptr().cast(),
                size,
                0,
                0,
            )
        };
        if read < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if read as usize > value.len() {
            return Err(changed());
        }
        value.truncate(read as usize);
        Ok(value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let value = file.get_xattr(key)?.ok_or_else(changed)?;
        if value.len() > PRESERVED_ATTRIBUTE_LIMIT {
            return Err(changed());
        }
        Ok(value)
    }
}

pub(crate) struct Review {
    pub token: String,
    keys: Vec<OsString>,
    acl: bool,
}
pub(crate) fn changed() -> AppError {
    AppError::new(
        "metadataChanged",
        "File metadata changed. Review what cannot be preserved before saving again.",
    )
}
fn identity(file: &File) -> Result<Vec<u8>> {
    let m = file.metadata()?;
    Ok([
        m.dev() as i128,
        m.ino() as i128,
        m.ctime() as i128,
        m.ctime_nsec() as i128,
        m.mtime() as i128,
        m.mtime_nsec() as i128,
        m.size() as i128,
        m.nlink() as i128,
        m.mode() as i128,
        m.uid() as i128,
        m.gid() as i128,
    ]
    .into_iter()
    .flat_map(i128::to_le_bytes)
    .collect())
}
pub(crate) fn inspect(file: &File) -> Result<Review> {
    let before = identity(file)?;
    let mut keys = Vec::new();
    let mut preserved = Vec::new();
    let mut total = 0;
    for key in file.list_xattr()? {
        if can_preserve(file, &key)? {
            preserved.push(key);
            continue;
        }
        total += key.as_bytes().len();
        if keys.len() >= 256 || total > 65536 {
            return Err(AppError::limit());
        }
        keys.push(key);
    }
    keys.sort();
    preserved.sort();
    let acl = has_acl(file)?;
    let mut hash = blake3::Hasher::new();
    hash.update(&before);
    hash.update(&[u8::from(acl)]);
    for key in &keys {
        hash.update(&(key.as_bytes().len() as u64).to_le_bytes());
        hash.update(key.as_bytes());
    }
    // Also detect OS-managed MACL/provenance updates if a writer changes an
    // attribute without advancing the ordinary file timestamps. Only these two
    // known, small values are read, each bounded before allocation.
    for key in &preserved {
        hash.update(&(key.as_bytes().len() as u64).to_le_bytes());
        hash.update(key.as_bytes());
        let value = read_preserved(file, key)?;
        hash.update(&(value.len() as u64).to_le_bytes());
        hash.update(&value);
    }
    if before != identity(file)? {
        return Err(changed());
    }
    Ok(Review {
        token: hash.finalize().to_hex().to_string(),
        keys,
        acl,
    })
}
impl Review {
    pub fn warning(&self) -> Option<MetadataWarning> {
        if self.keys.is_empty() && !self.acl {
            return None;
        }
        let mut items: Vec<String> = self
            .keys
            .iter()
            .map(|k| {
                // Escape invisible/control bytes rather than displaying misleading labels.
                let name: String = k
                    .to_string_lossy()
                    .chars()
                    .flat_map(char::escape_debug)
                    .collect();
                match name.as_str() {
                    "com.apple.metadata:_kMDItemUserTags" => format!("Finder tags ({name})"),
                    "com.apple.FinderInfo" => format!("Finder information ({name})"),
                    "com.apple.ResourceFork" => {
                        format!("Resource fork: additional file data ({name})")
                    }
                    "com.apple.quarantine" => format!("Download quarantine information ({name})"),
                    _ => name,
                }
            })
            .collect();
        if self.acl {
            items.push("Custom access rules (ACL)".into());
        }
        Some(MetadataWarning {
            review: self.token.clone(),
            items,
            accepted: false,
        })
    }
    pub fn matches(&self, file: &File) -> Result<()> {
        if inspect(file)?.token != self.token {
            return Err(changed());
        }
        Ok(())
    }
    /// Only the new temporary file is stripped. Never modify the original file
    /// until the normal checked, durable atomic replacement succeeds.
    pub fn prepare_replacement(&self, file: &File) -> Result<()> {
        let inherited = inspect(file)?;
        for key in inherited.keys {
            if !self.keys.contains(&key) {
                return Err(changed());
            }
            file.remove_xattr(key)?;
        }
        if inherited.acl {
            if !self.acl {
                return Err(changed());
            }
            clear_acl(file)?;
        }
        if inspect(file)?.warning().is_some() {
            return Err(changed());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::fd::AsRawFd;
    unsafe extern "C" {
        fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
        fn acl_get_entry(
            acl: *mut libc::c_void,
            index: libc::c_int,
            entry: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_init(count: libc::c_int) -> *mut libc::c_void;
        fn acl_set_fd(fd: libc::c_int, acl: *mut libc::c_void) -> libc::c_int;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    pub fn has_acl(file: &File) -> Result<bool> {
        let acl = unsafe { acl_get_fd(file.as_raw_fd()) };
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ENOENT) {
                Ok(false)
            } else {
                Err(error.into())
            };
        }
        let mut entry = std::ptr::null_mut();
        let status = unsafe { acl_get_entry(acl, 0, &mut entry) };
        let error = std::io::Error::last_os_error();
        unsafe {
            acl_free(acl);
        }
        if status == 0 {
            return Ok(true);
        }
        if error.raw_os_error() != Some(libc::EINVAL) {
            return Err(error.into());
        }
        Ok(false)
    }
    pub fn clear_acl(file: &File) -> Result<()> {
        let acl = unsafe { acl_init(0) };
        if acl.is_null() {
            return Err(std::io::Error::last_os_error().into());
        }
        let status = unsafe { acl_set_fd(file.as_raw_fd(), acl) };
        let error = std::io::Error::last_os_error();
        unsafe {
            acl_free(acl);
        }
        if status != 0 {
            return Err(error.into());
        }
        Ok(())
    }
}
#[cfg(target_os = "macos")]
use macos::{clear_acl, has_acl};
// Other Unix ACLs are represented by the enumerated extended attributes.
#[cfg(not(target_os = "macos"))]
fn has_acl(_: &File) -> Result<bool> {
    Ok(false)
}
#[cfg(not(target_os = "macos"))]
fn clear_acl(_: &File) -> Result<()> {
    Err(AppError::new(
        "unsupported",
        "ACL replacement is unavailable",
    ))
}
