use crate::{
    dto::{Document, Response},
    error::{AppError, Result},
    security,
    storage::Storage,
    workspace::Workspace,
};
#[cfg(unix)]
use cap_fs_ext::OpenOptionsFollowExt;
use cap_std::fs::Dir;
#[cfg(unix)]
use cap_std::fs::OpenOptions;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::io::Write;
use std::{io::Read, path::Path};

#[cfg(not(windows))]
pub type FileMetadata = std::fs::Metadata;
#[cfg(windows)]
pub struct FileMetadata {
    pub standard: std::fs::Metadata,
    pub identity: crate::windows_fs::Identity,
}
#[cfg(windows)]
impl std::ops::Deref for FileMetadata {
    type Target = std::fs::Metadata;
    fn deref(&self) -> &Self::Target {
        &self.standard
    }
}

const EDIT_LIMIT: u64 = 20 * 1024 * 1024;
const PREVIEW_LIMIT: u64 = 64 * 1024;
#[cfg(test)]
thread_local! { static SAVE_FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
fn fault(phase: u8) -> Result<()> {
    #[cfg(test)]
    if SAVE_FAULT.with(|f| f.get()) == phase {
        return Err(AppError::new(
            if phase == 4 {
                "unknownOutcome"
            } else {
                "diskFull"
            },
            "Injected save failure; recovery must remain intact",
        ));
    }
    let _ = phase;
    Ok(())
}
#[derive(Clone)]
pub struct DocumentState {
    pub dto: Document,
    pub dirty: bool,
    pub checkpoint: u32,
}
pub struct RefreshSnapshot {
    pub document: String,
    before: DocumentState,
    after: String,
}
#[derive(Serialize, Deserialize)]
pub struct Recovery {
    pub version: u32,
    pub scope: String,
    pub entry: String,
    pub path: String,
    pub text: String,
    pub baseline: String,
    pub baseline_text: String,
    pub revision: u32,
}
pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
pub fn path_token(path: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}
pub fn token_path(token: &str) -> Result<std::path::PathBuf> {
    if !token.is_ascii() || token.len() > 65536 || token.len() % 2 != 0 {
        return Err(AppError::new("unsafePath", "Invalid path reference"));
    }
    let bytes: std::result::Result<Vec<u8>, _> = (0..token.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&token[i..i + 2], 16))
        .collect();
    let bytes = bytes.map_err(|_| AppError::new("unsafePath", "Invalid path reference"))?;
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let path: std::path::PathBuf = std::ffi::OsString::from_vec(bytes).into();
        security::relative(&path)?;
        Ok(path)
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        if bytes.len() % 2 != 0 {
            return Err(AppError::new("unsafePath", "Invalid path reference"));
        }
        let wide: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let path: std::path::PathBuf = std::ffi::OsString::from_wide(&wide).into();
        security::relative(&path)?;
        Ok(path)
    }
}
pub(crate) fn read_file(dir: &Dir, leaf: &Path, limit: u64) -> Result<(Vec<u8>, FileMetadata)> {
    let mut f = security::open_read(dir, leaf)?;
    let m = f.metadata()?;
    if !m.is_file() {
        return Err(AppError::new(
            "unsupported",
            "Only ordinary files can be opened",
        ));
    }
    let mut bytes = Vec::new();
    (&mut f).take(limit).read_to_end(&mut bytes)?;
    #[cfg(windows)]
    let m = FileMetadata {
        standard: m,
        identity: crate::windows_fs::identity(&f)?,
    };
    Ok((bytes, m))
}
fn decode(bytes: &[u8]) -> Result<(String, String)> {
    let (encoding, body) = if bytes.starts_with(&[0xff, 0xfe]) {
        ("utf16le", &bytes[2..])
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        ("utf16be", &bytes[2..])
    } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        ("utf8bom", &bytes[3..])
    } else {
        ("utf8", bytes)
    };
    let text = if encoding.starts_with("utf16") {
        if body.len() % 2 != 0 {
            return Err(AppError::new("encoding", "Invalid UTF-16 byte length"));
        }
        let words: Vec<u16> = body
            .chunks_exact(2)
            .map(|b| {
                if encoding == "utf16le" {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        String::from_utf16(&words)
            .map_err(|_| AppError::new("encoding", "Invalid UTF-16 sequence"))?
    } else {
        String::from_utf8(body.to_vec()).map_err(|_| {
            AppError::new("encoding", "Invalid UTF-8; no lossy editing is permitted")
        })?
    };
    if text.contains('\0') {
        return Err(AppError::new("encoding", "Binary file"));
    }
    Ok((text, encoding.into()))
}
fn eol(text: &str) -> String {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let cr = text.matches('\r').count();
    if cr > crlf || (crlf > 0 && lf > crlf) {
        "mixed"
    } else if crlf > 0 {
        "CRLF"
    } else {
        "LF"
    }
    .into()
}
fn encode(text: &str, encoding: &str) -> Vec<u8> {
    match encoding {
        "utf16le" => [
            vec![0xff, 0xfe],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat(),
        "utf16be" => [
            vec![0xfe, 0xff],
            text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
        ]
        .concat(),
        "utf8bom" => [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
        _ => text.as_bytes().to_vec(),
    }
}
impl Workspace {
    pub fn document_open(&mut self, entry: &str, storage: &Storage) -> Result<Response> {
        let path = self.entry(entry)?;
        match self.document_open_disk(entry, storage) {
            Ok(response) => Ok(response),
            Err(error) => {
                let Some(recovery) = storage
                    .read::<Recovery>(&format!("recovery-{entry}.json"))?
                    .filter(|r| r.scope == self.project.id && r.entry == entry && r.version == 1)
                else {
                    return Err(error);
                };
                if recovery.text.len() as u64 > EDIT_LIMIT {
                    return Err(AppError::limit());
                }
                let dto = Document {
                    id: entry.into(), entry: entry.into(),
                    name: security::display(path.file_name().map(Path::new).unwrap_or(&path)),
                    path: security::display(&path),
                    eol: eol(&recovery.text), encoding: "utf8".into(),
                    size: recovery.text.len() as f64,
                    text: recovery.baseline_text,
                    baseline: recovery.baseline,
                    recovery: Some(recovery.text), revision: recovery.revision,
                    readonly: Some("Recovery preview: the original file is unavailable. Save a UTF-8 copy to a new file; the acknowledged checkpoint remains retained.".into()),
                };
                self.documents.insert(
                    entry.into(),
                    DocumentState {
                        dto: dto.clone(),
                        dirty: true,
                        checkpoint: dto.revision,
                    },
                );
                Ok(Response::Document { document: dto })
            }
        }
    }
    fn document_open_disk(&mut self, entry: &str, storage: &Storage) -> Result<Response> {
        let path = self.entry(entry)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let m = security::open_read(&parent, &leaf)?.metadata()?;
        if !m.is_file() || m.file_type().is_symlink() {
            return Err(AppError::new(
                "unsupported",
                "Links and special files require a separately authorized scope",
            ));
        }
        let limit = if m.len() > EDIT_LIMIT {
            PREVIEW_LIMIT
        } else {
            EDIT_LIMIT + 1
        };
        let (bytes, meta) = read_file(&parent, &leaf, limit)?;
        let mut readonly = if meta.len() > EDIT_LIMIT {
            Some("Bounded preview: file exceeds 20 MiB".into())
        } else {
            None
        };
        let (mut text, encoding) = match decode(&bytes) {
            Ok(v) => v,
            Err(e) => {
                readonly = Some(e.message);
                (
                    bytes
                        .iter()
                        .take(4096)
                        .map(|b| format!("{b:02x} "))
                        .collect(),
                    "binary".into(),
                )
            }
        };
        let eol = eol(&text);
        if eol == "mixed" {
            readonly = Some("Mixed EOL: read-only to preserve original bytes".into());
        }
        if text.lines().any(|l| l.len() > 1024 * 1024) {
            readonly = Some("Long-line guard: read-only preview of the first 64 KiB. Open this file in an external tool for its complete content.".into());
            // Do not hand a multi-megabyte single line to Monaco merely to
            // discover it is read-only. Baseline hashing still uses all bytes;
            // the original file and reported size remain unchanged.
            let mut end = text.len().min(PREVIEW_LIMIT as usize);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.nlink() > 1 {
                readonly =
                    Some("Hard-linked file: safe metadata replacement is unsupported".into());
            }
            let mut options = OpenOptions::new();
            options.read(true).follow(cap_fs_ext::FollowSymlinks::No);
            let file = parent.open_with(&leaf, &options)?.into_std();
            if !supported_metadata(&file)? {
                readonly = Some("Extended file metadata: replacement not supported".into());
            }
        }
        #[cfg(windows)]
        {
            let file = crate::windows_fs::open_read(&parent, &leaf)?;
            match crate::windows_fs::supported_metadata(&file) {
                Ok(true) => {}
                Ok(false) | Err(_) => {
                    readonly = Some(
                        "Windows metadata cannot be preserved safely: read-only preview".into(),
                    )
                }
            }
        }
        let baseline = hash(&bytes);
        if let Some(current) = self.documents.get(entry) {
            if current.dirty {
                let mut dto = current.dto.clone();
                if let Some(recovery) = storage
                    .read::<Recovery>(&format!("recovery-{entry}.json"))?
                    .filter(|r| r.scope == self.project.id)
                {
                    dto.recovery = Some(recovery.text);
                    dto.revision = recovery.revision;
                }
                if baseline != dto.baseline {
                    dto.readonly = Some("External change conflicts with unsaved edits. Compare disk before keeping either version.".into());
                }
                return Ok(Response::Document { document: dto });
            }
        }
        let recovered: Option<Recovery> = storage.read(&format!("recovery-{entry}.json"))?;
        let recovery = recovered
            .as_ref()
            .filter(|r| r.scope == self.project.id)
            .map(|r| r.text.clone());
        let revision = recovered
            .as_ref()
            .map(|r| r.revision)
            .unwrap_or(0)
            .max(self.documents.get(entry).map(|d| d.checkpoint).unwrap_or(0));
        let (text, baseline) = if let Some(r) =
            recovered.as_ref().filter(|r| r.scope == self.project.id)
        {
            if r.baseline != baseline {
                readonly=Some("External change conflicts with recovered edits. Compare all versions before saving.".into());
            }
            (r.baseline_text.clone(), r.baseline.clone())
        } else {
            (text, baseline)
        };
        let dto = Document {
            id: entry.into(),
            entry: entry.into(),
            name: security::display(&leaf),
            path: security::display(&path),
            text,
            baseline,
            encoding,
            eol,
            readonly,
            size: meta.len() as f64,
            recovery,
            revision,
        };
        self.documents.insert(
            entry.into(),
            DocumentState {
                dto: dto.clone(),
                dirty: dto.recovery.is_some(),
                checkpoint: revision,
            },
        );
        Ok(Response::Document { document: dto })
    }
    pub fn reconcile_document(&mut self, id: &str, storage: &Storage) -> Result<Response> {
        let before = self
            .documents
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("notFound", "Document is closed"))?;
        let Response::Document { document } = self.document_open(id, storage)? else {
            unreachable!()
        };
        if before.dirty {
            return Ok(Response::Reconciled {
                document,
                refresh: None,
            });
        }
        self.refreshes.retain(|_, r| r.document != id);
        let refresh = uuid::Uuid::new_v4().to_string();
        if self.refreshes.len() >= 128 {
            self.documents.insert(id.into(), before);
            return Err(AppError::limit());
        }
        self.refreshes.insert(
            refresh.clone(),
            RefreshSnapshot {
                document: id.into(),
                before,
                after: document.baseline.clone(),
            },
        );
        Ok(Response::Reconciled {
            document,
            refresh: Some(refresh),
        })
    }
    pub fn finish_reconcile(&mut self, refresh: &str, accept: bool) -> Result<Response> {
        let snapshot = self
            .refreshes
            .remove(refresh)
            .ok_or_else(|| AppError::conflict("Refresh snapshot expired"))?;
        if !accept {
            let current = self
                .documents
                .get(&snapshot.document)
                .ok_or_else(|| AppError::new("notFound", "Document is closed"))?;
            if current.dirty
                || current.dto.baseline != snapshot.after
                || current.checkpoint != snapshot.before.checkpoint
            {
                return Err(AppError::conflict(
                    "Editor state changed after refresh; current buffer and recovery retained",
                ));
            }
            self.documents.insert(snapshot.document, snapshot.before);
        }
        Ok(Response::Ok)
    }
    pub fn checkpoint(
        &mut self,
        id: &str,
        text: &str,
        revision: u32,
        storage: &Storage,
    ) -> Result<Response> {
        if text.len() as u64 > EDIT_LIMIT {
            return Err(AppError::limit());
        }
        let path = self.entry(id)?;
        let d = self
            .documents
            .get_mut(id)
            .ok_or_else(|| AppError::new("notFound", "Document is closed"))?;
        if revision < d.checkpoint {
            return Err(AppError::conflict("Stale editor checkpoint"));
        }
        if revision == d.checkpoint {
            let expected = if d.dirty {
                storage
                    .read::<Recovery>(&format!("recovery-{id}.json"))?
                    .map(|r| r.text)
            } else {
                Some(d.dto.text.clone())
            };
            if expected.as_deref() != Some(text) {
                return Err(AppError::conflict(
                    "A different editor checkpoint already owns this revision",
                ));
            }
            return Ok(Response::Saved {
                baseline: d.dto.baseline.clone(),
                revision,
            });
        }
        if d.dto.readonly.is_some() {
            return Err(AppError::new("unsupported", "This document is read-only"));
        }
        if text == d.dto.text {
            remove_recovery(storage, id)?;
            d.dirty = false;
            d.checkpoint = revision;
            d.dto.revision = revision;
            return Ok(Response::Saved {
                baseline: d.dto.baseline.clone(),
                revision,
            });
        }
        // Keep baseline for explicit three-version reconciliation.
        let r = Recovery {
            version: 1,
            scope: self.project.id.clone(),
            entry: id.into(),
            path: path_token(&path),
            text: text.into(),
            baseline: d.dto.baseline.clone(),
            baseline_text: d.dto.text.clone(),
            revision,
        };
        storage.recovery_budget(&format!("recovery-{id}.json"), &r)?;
        storage.write(&format!("recovery-{id}.json"), &r)?;
        d.dirty = text != d.dto.text;
        d.checkpoint = revision;
        d.dto.revision = revision;
        Ok(Response::Saved {
            baseline: d.dto.baseline.clone(),
            revision,
        })
    }
    pub fn save(
        &mut self,
        id: &str,
        text: &str,
        revision: u32,
        baseline: &str,
        storage: &Storage,
    ) -> Result<Response> {
        self.authorize(&self.project.id, true, true)?;
        let d = self
            .documents
            .get(id)
            .ok_or_else(|| AppError::new("notFound", "Document is closed"))?;
        if d.dto.readonly.is_some() {
            return Err(AppError::new("unsupported", "This document is read-only"));
        }
        if baseline != d.dto.baseline || revision < d.checkpoint {
            return Err(AppError::conflict("Stale editor revision"));
        }
        let encoding = d.dto.encoding.clone();
        let path = self.entry(id)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let (old, meta) = read_file(&parent, &leaf, EDIT_LIMIT + 1)?;
        if meta.permissions().readonly() {
            return Err(AppError::new(
                "permissionDenied",
                "File is marked read-only",
            ));
        }
        if hash(&old) != baseline {
            return Err(AppError::conflict(
                "Disk changed. Recovery retained; review baseline, local buffer and disk before saving.",
            ));
        }
        self.checkpoint(id, text, revision, storage)?;
        let bytes = encode(text, &encoding);
        atomic_replace(&parent, &leaf, &old, &bytes, &meta)?;
        let d = self
            .documents
            .get_mut(id)
            .expect("document retained under workspace mutex");
        d.dto.baseline = hash(&bytes);
        d.dto.text = text.into();
        d.dto.revision = revision;
        d.dto.recovery = None;
        d.dirty = false;
        // Retain last durable checkpoint until successfully replaced; then remove primary and backup.
        remove_recovery(storage, id)?;
        Ok(Response::Saved {
            baseline: d.dto.baseline.clone(),
            revision,
        })
    }
    pub fn discard(&mut self, id: &str, storage: &Storage) -> Result<Response> {
        remove_recovery(storage, id)?;
        self.documents.remove(id);
        self.document_open(id, storage)
    }
    pub fn compare(&mut self, id: &str) -> Result<Response> {
        let path = self.entry(id)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let (bytes, _) = read_file(&parent, &leaf, EDIT_LIMIT + 1)?;
        if bytes.len() as u64 > EDIT_LIMIT {
            return Err(AppError::limit());
        }
        let (disk, _) = decode(&bytes)?;
        let d = self
            .documents
            .get(id)
            .ok_or_else(|| AppError::new("notFound", "Document is closed"))?;
        Ok(Response::Diff{diff:crate::dto::Diff{id:hash(&bytes),entry:id.into(),path:security::display(&path),base_label:"Loaded baseline".into(),next_label:"Current disk".into(),base:d.dto.text.clone(),next:disk,hunks:vec![],hunk_unavailable:Some("Conflict comparison; editor buffer remains editable below. Explicitly review before replacing disk.".into())}})
    }
    pub fn review_disk(&mut self, id: &str, reviewed: &str, storage: &Storage) -> Result<Response> {
        self.authorize(&self.project.id, true, true)?;
        let path = self.entry(id)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let (bytes, _) = read_file(&parent, &leaf, EDIT_LIMIT + 1)?;
        if hash(&bytes) != reviewed {
            return Err(AppError::conflict(
                "Disk changed again since comparison; review the new version",
            ));
        }
        let (text, encoding) = decode(&bytes)?;
        let old = self
            .documents
            .remove(id)
            .ok_or_else(|| AppError::new("notFound", "Document closed"))?;
        // Re-open checks metadata and encoding without allowing a stale recovery baseline to override the reviewed disk.
        let mut dto = old.dto.clone();
        dto.text = text;
        dto.baseline = reviewed.into();
        dto.encoding = encoding;
        if dto
            .readonly
            .as_ref()
            .is_some_and(|s| s.starts_with("External change"))
        {
            dto.readonly = None;
        }
        self.documents.insert(
            id.into(),
            DocumentState {
                dto,
                dirty: old.dirty,
                checkpoint: old.checkpoint,
            },
        );
        if let Some(mut r) = storage.read::<Recovery>(&format!("recovery-{id}.json"))? {
            r.baseline = reviewed.into();
            r.baseline_text = self.documents[id].dto.text.clone();
            storage.write(&format!("recovery-{id}.json"), &r)?;
        }
        Ok(Response::Saved {
            baseline: reviewed.into(),
            revision: old.checkpoint,
        })
    }
}
fn remove_recovery(storage: &Storage, id: &str) -> Result<()> {
    for suffix in ["json", "bak"] {
        let p = storage.root.join(format!("recovery-{id}.{suffix}"));
        match std::fs::remove_file(p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub fn atomic_replace(
    parent: &Dir,
    leaf: &Path,
    expected: &[u8],
    bytes: &[u8],
    metadata: &FileMetadata,
) -> Result<()> {
    atomic_replace_with_hook(parent, leaf, expected, bytes, metadata, fault)
}
/// Native durability-phase hook for deterministic process-death fixtures.
/// The application always supplies its ordinary no-op/fault-test hook; this is
/// a Rust API only, never an IPC capability or environment-controlled switch.
pub fn atomic_replace_with_hook(
    parent: &Dir,
    leaf: &Path,
    expected: &[u8],
    bytes: &[u8],
    metadata: &FileMetadata,
    hook: impl Fn(u8) -> Result<()>,
) -> Result<()> {
    #[cfg(windows)]
    {
        crate::windows_fs::atomic_replace(parent, leaf, expected, bytes, &metadata.identity, hook)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(AppError::new("unsupported", "Hard-linked save refused"));
        }
        let tmp =
            std::path::PathBuf::from(format!(".agent-workspace-save-{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut options = OpenOptions::new();
            options
                .write(true)
                .create_new(true)
                .follow(cap_fs_ext::FollowSymlinks::No);
            let mut f = parent.open_with(&tmp, &options)?.into_std();
            hook(1)?;
            f.write_all(bytes)?;
            f.set_permissions(metadata.permissions())?;
            use xattr::FileExt;
            let mut opts = OpenOptions::new();
            opts.read(true).follow(cap_fs_ext::FollowSymlinks::No);
            let original = parent.open_with(leaf, &opts)?.into_std();
            if !supported_metadata(&original)? || !supported_metadata(&f)? {
                return Err(AppError::new(
                    "unsupported",
                    "Unsupported metadata appeared while saving",
                ));
            }
            for key in original.list_xattr()? {
                if key != "com.apple.provenance" {
                    return Err(AppError::new(
                        "unsupported",
                        "Unsupported metadata appeared while saving",
                    ));
                }
                if let Some(value) = original.get_xattr(&key)? {
                    if f.get_xattr(&key)?.as_ref() != Some(&value) {
                        f.set_xattr(&key, &value)?;
                    }
                }
            }
            let new_meta = f.metadata()?;
            if new_meta.uid() != metadata.uid() || new_meta.gid() != metadata.gid() {
                return Err(AppError::new(
                    "unsupported",
                    "Replacement would change file ownership",
                ));
            }
            f.sync_all()?;
            hook(2)?;
            let (current, m) = read_file(parent, leaf, EDIT_LIMIT + 1)?;
            if current != expected
                || m.ino() != metadata.ino()
                || m.dev() != metadata.dev()
                || m.nlink() != 1
            {
                return Err(AppError::conflict(
                    "Destination changed while saving; original retained",
                ));
            }
            hook(3)?;
            parent.rename(&tmp, parent, leaf)?;
            hook(4)?;
            parent.try_clone()?.into_std_file().sync_all().map_err(|_| AppError::new("unknownOutcome", "Replacement completed but directory durability was not acknowledged; recovery retained"))?;
            let (saved, _) = read_file(parent, leaf, EDIT_LIMIT + 1)?;
            if saved != bytes {
                return Err(AppError::new(
                    "unknownOutcome",
                    "Another writer changed the saved file; recovery retained",
                ));
            }
            Ok(())
        })();
        if parent.symlink_metadata(&tmp).is_ok() {
            parent.remove_file(&tmp)?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoding_roundtrips() {
        for enc in ["utf8", "utf8bom", "utf16le", "utf16be"] {
            let b = encode("hello\r\n🌍", enc);
            let (s, e) = decode(&b).unwrap();
            assert_eq!(e, enc);
            assert_eq!(s, "hello\r\n🌍");
            assert_eq!(encode(&s, &e), b);
        }
        assert!(decode(&[0xff]).is_err());
        assert!(decode(&[0xff, 0xfe, 0]).is_err());
        assert_eq!(eol("a\r\nb\nc"), "mixed");
    }
    #[cfg(unix)]
    #[test]
    fn saves_reject_stale_and_preserve_mode() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let s = Storage::new(t.path().join("data")).unwrap();
        let root = t.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("file"), b"old").unwrap();
        std::fs::set_permissions(root.join("file"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let mut w = Workspace::open(&root, &[]).unwrap();
        w.project.trusted = true;
        let id = w.register("file".into());
        w.document_open(&id, &s).unwrap();
        w.checkpoint(&id, "mine", 1, &s).unwrap();
        std::fs::write(root.join("file"), b"external").unwrap();
        assert!(w.save(&id, "mine", 1, &hash(b"old"), &s).is_err());
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"external");
        assert!(
            s.read::<Recovery>(&format!("recovery-{id}.json"))
                .unwrap()
                .is_some()
        );
        std::fs::write(root.join("file"), b"old").unwrap();
        w.save(&id, "mine", 1, &hash(b"old"), &s).unwrap();
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"mine");
        assert_eq!(
            root.join("file").metadata().unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    #[cfg(unix)]
    #[test]
    fn invalid_utf8_name_roundtrip() {
        use std::os::unix::ffi::OsStringExt;
        let p = std::path::PathBuf::from(std::ffi::OsString::from_vec(vec![0xff, 0x61]));
        assert_eq!(token_path(&path_token(&p)).unwrap(), p);
    }
    #[cfg(any(unix, windows))]
    #[test]
    fn save_failures_retain_original_or_report_uncertain_and_keep_checkpoint() {
        for phase in 1..=4 {
            let t = tempfile::tempdir().unwrap();
            let root = t.path().join("project");
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("file"), b"original").unwrap();
            let storage = Storage::new(t.path().join("data")).unwrap();
            let mut w = Workspace::open(&root, &[]).unwrap();
            w.project.trusted = true;
            let id = w.register("file".into());
            w.document_open(&id, &storage).unwrap();
            SAVE_FAULT.with(|f| f.set(phase));
            let result = w.save(&id, "mine", 1, &hash(b"original"), &storage);
            SAVE_FAULT.with(|f| f.set(0));
            let error = result.unwrap_err();
            assert_eq!(
                std::fs::read(root.join("file")).unwrap(),
                if phase == 4 {
                    b"mine".to_vec()
                } else {
                    b"original".to_vec()
                }
            );
            if phase == 4 {
                assert_eq!(error.code, "unknownOutcome");
            }
            let r: Recovery = storage
                .read(&format!("recovery-{id}.json"))
                .unwrap()
                .unwrap();
            assert_eq!(r.text, "mine");
            assert_eq!(r.revision, 1);
        }
    }
    #[test]
    fn hostile_path_tokens_never_panic() {
        for token in ["🌍", "éé", "not-hex", "0", "00"] {
            assert!(token_path(token).is_err());
        }
    }
}

#[cfg(unix)]
pub(crate) fn supported_metadata(file: &std::fs::File) -> Result<bool> {
    use xattr::FileExt;
    if file.list_xattr()?.any(|key| key != "com.apple.provenance") {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
            fn acl_get_entry(
                acl: *mut libc::c_void,
                entry_id: libc::c_int,
                entry: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_free(obj: *mut libc::c_void) -> libc::c_int;
        }
        // macOS ACLs are not exposed by listxattr. Empty ACLs have no first
        // entry (EINVAL); nonempty ACLs stay read-only rather than being lost.
        let acl = unsafe { acl_get_fd(file.as_raw_fd()) };
        if acl.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(true);
            }
            return Err(error.into());
        }
        let mut entry = std::ptr::null_mut();
        let status = unsafe { acl_get_entry(acl, 0, &mut entry) };
        let error = std::io::Error::last_os_error();
        unsafe {
            acl_free(acl);
        }
        if status == 0 {
            return Ok(false);
        }
        if error.raw_os_error() != Some(libc::EINVAL) {
            return Err(error.into());
        }
    }
    Ok(true)
}
