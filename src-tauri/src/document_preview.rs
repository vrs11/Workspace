//! Resolve explicit document links without granting arbitrary path authority.
use crate::{
    dto::{Entry, Media},
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use std::path::{Path, PathBuf};

fn relative_target(base: &Path, href: &str) -> Result<PathBuf> {
    let invalid = || AppError::new("scope", "Preview links must stay inside the open project");
    if href.is_empty() || href.len() > 4096 {
        return Err(invalid());
    }
    let raw = href.split(['?', '#']).next().unwrap_or_default().as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let a = raw
                .get(index + 1)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or_else(invalid)?;
            let b = raw
                .get(index + 2)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or_else(invalid)?;
            bytes.push((a * 16 + b) as u8);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    let decoded = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    if decoded.is_empty() || decoded.starts_with('/') || decoded.contains(['\\', ':', '\0']) {
        return Err(invalid());
    }
    let mut result = base.parent().unwrap_or(Path::new("")).to_path_buf();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if !result.pop() {
                    return Err(invalid());
                }
            }
            other => result.push(other),
        }
    }
    security::relative(&result)?;
    Ok(result)
}
impl Workspace {
    pub fn preview_link(&mut self, document: &str, href: &str) -> Result<Entry> {
        if !self.documents.contains_key(document) {
            return Err(AppError::new(
                "scope",
                "The preview's document is no longer open",
            ));
        }
        let source = self.entry(document).map_err(|_| {
            AppError::new(
                "scope",
                "Local preview links require a document inside the open project",
            )
        })?;
        let path = relative_target(&source, href)?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        if !security::open_read(&parent, &leaf)?.metadata()?.is_file() {
            return Err(AppError::new(
                "unsupported",
                "Only regular files can be opened from a preview",
            ));
        }
        let id = self.register(path.clone());
        Ok(Entry {
            id,
            name: security::display(&leaf),
            path: security::display(&path),
            kind: "file".into(),
        })
    }
    pub fn preview_image(&mut self, document: &str, href: &str) -> Result<Media> {
        let registered = self.entries.len();
        let entry = self.preview_link(document, href)?;
        let result = self.embedded_image(&entry.id);
        // Embedded media owns a pinned read handle, not an Explorer entry.
        // Editing image references must not accumulate a hidden file index.
        if self.entries.len() > registered {
            self.entries.remove(&entry.id);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_links_decode_and_remain_scoped() {
        assert_eq!(
            relative_target(Path::new("docs/readme.md"), "../images/a%20b.png#part").unwrap(),
            PathBuf::from("images/a b.png")
        );
        for href in [
            "../../outside",
            "/absolute",
            "file:///tmp/file",
            "https://example.invalid",
            "%2fetc/passwd",
            "%2e%2e/%2e%2e/file",
            "../.git/config",
            "a%00b",
            "a\\b",
            "%zz",
        ] {
            assert!(
                relative_target(Path::new("docs/file.md"), href).is_err(),
                "{href}"
            );
        }
    }
}
