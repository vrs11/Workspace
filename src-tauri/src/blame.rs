//! Optional current-buffer annotations. Git runs without the workspace mutex.
use crate::{
    dto::{BlameCommit, BlameLine, GitBlame, Project, Response},
    error::{AppError, Result},
    git, security,
    workspace::Workspace,
};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const LINE_LIMIT: usize = 100_000;

pub struct BlameRead {
    pub project: Project,
    pub entry: String,
    pub path: PathBuf,
    pub parent_identity: String,
    exe: PathBuf,
    text: String,
}
impl Workspace {
    pub fn blame_read(&self, exe: &Path, entry: &str, text: String) -> Result<BlameRead> {
        if text.len() > TEXT_LIMIT || text.lines().count() > LINE_LIMIT {
            return Err(AppError::new(
                "resourceLimit",
                "Git blame supports files up to 2 MiB and 100,000 lines. Editing remains available.",
            ));
        }
        let document = self
            .documents
            .get(entry)
            .ok_or_else(|| AppError::new("scope", "Open the file before requesting Git blame"))?;
        if !["utf8", "utf8bom"].contains(&document.dto.encoding.as_str())
            || document.dto.readonly.as_deref().is_some_and(|reason| {
                reason.starts_with("Bounded preview:") || reason.starts_with("Long-line guard:")
            })
        {
            return Err(AppError::new(
                "blameUnavailable",
                "Git blame requires a complete UTF-8 text document",
            ));
        }
        let text = if document.dto.encoding == "utf8bom" {
            format!("\u{feff}{text}")
        } else {
            text
        };
        let path = self.entry(entry).map_err(|_| {
            AppError::new(
                "blameUnavailable",
                "Git blame is available for files inside the open project",
            )
        })?;
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        if !security::open_read(&parent, &leaf)?.metadata()?.is_file() {
            return Err(AppError::new(
                "unsupported",
                "Git blame requires a regular text file",
            ));
        }
        let parent_identity = security::identity_of_dir(
            &Path::new(&self.project.root).join(path.parent().unwrap_or(Path::new(""))),
            &parent,
        )?;
        Ok(BlameRead {
            project: self.project.clone(),
            entry: entry.into(),
            path,
            parent_identity,
            exe: exe.into(),
            text,
        })
    }
}
impl BlameRead {
    pub fn read(&self) -> Result<Response> {
        let directory =
            Path::new(&self.project.root).join(self.path.parent().unwrap_or(Path::new("")));
        let root = git::path_repository_root(&self.exe, &directory).map_err(|_| {
            AppError::new("blameUnavailable", "This file is not in a Git repository")
        })?;
        if !root.starts_with(&self.project.root) {
            return Err(AppError::new(
                "scope",
                "Open the Git repository root to annotate this file",
            ));
        }
        let absolute = Path::new(&self.project.root).join(&self.path);
        let path = absolute
            .strip_prefix(&root)
            .map_err(|_| AppError::new("scope", "File belongs to another repository"))?;
        let mut args: Vec<OsString> = [
            "-c",
            "blame.ignoreRevsFile=",
            "blame",
            "--porcelain",
            "--no-progress",
            "--no-textconv",
            "--contents",
            "-",
            "--",
        ]
        .iter()
        .map(Into::into)
        .collect();
        args.push(path.as_os_str().into());
        let output = git::command_with_timeout(
            &self.exe,
            &root,
            &args,
            Some(self.text.as_bytes()),
            Duration::from_secs(10),
        )
        .map_err(|error| {
            if error.code == "unknownOutcome" {
                AppError::new(
                    "blameUnavailable",
                    "Git blame took too long. Retry or keep editing without annotations.",
                )
            } else {
                error
            }
        })?;
        if !output.success {
            let error = String::from_utf8_lossy(&output.stderr);
            let message = if error.contains("no such path")
                || error.contains("no such ref")
                || error.contains("bad revision")
                || error.contains("bad object")
            {
                "This file has no committed history yet"
            } else {
                "Git could not annotate this file. Check repository access and try again."
            };
            return Err(AppError::new("blameUnavailable", message));
        }
        Ok(Response::GitBlame {
            blame: parse(&self.entry, &output.stdout)?,
        })
    }
}
fn clean(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}
fn parse(entry: &str, bytes: &[u8]) -> Result<GitBlame> {
    let malformed = || AppError::new("protocol", "Git returned incomplete blame annotations");
    let mut records = bytes.split(|b| *b == b'\n').peekable();
    let mut commits: Vec<BlameCommit> = Vec::new();
    let mut indexes: HashMap<String, u32> = HashMap::new();
    let mut lines = Vec::new();
    while let Some(header) = records.next() {
        if header.is_empty() && records.peek().is_none() {
            break;
        }
        let fields = std::str::from_utf8(header)
            .map_err(|_| malformed())?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if !(3..=4).contains(&fields.len())
            || ![40, 64].contains(&fields[0].len())
            || !fields[0].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(malformed());
        }
        let id = fields[0].to_string();
        let original_line: u32 = fields[1].parse().map_err(|_| malformed())?;
        let line: u32 = fields[2].parse().map_err(|_| malformed())?;
        if original_line == 0 || line as usize != lines.len() + 1 || lines.len() >= LINE_LIMIT {
            return Err(malformed());
        }
        let mut metadata = BlameCommit {
            id: id.clone(),
            author: String::new(),
            email: String::new(),
            timestamp: 0.,
            summary: String::new(),
        };
        let mut content = false;
        for record in records.by_ref() {
            if record.starts_with(b"\t") {
                content = true;
                break;
            }
            if let Some(value) = record.strip_prefix(b"author ") {
                metadata.author = clean(value, 512);
            }
            if let Some(value) = record.strip_prefix(b"author-mail ") {
                metadata.email = clean(value, 512).trim_matches(['<', '>']).into();
            }
            if let Some(value) = record.strip_prefix(b"author-time ") {
                metadata.timestamp = std::str::from_utf8(value)
                    .ok()
                    .and_then(|v| v.parse::<i64>().ok())
                    .ok_or_else(malformed)? as f64;
            }
            if let Some(value) = record.strip_prefix(b"summary ") {
                metadata.summary = clean(value, 2048);
            }
        }
        if !content {
            return Err(malformed());
        }
        let commit = if let Some(index) = indexes.get(&id) {
            *index
        } else {
            if metadata.author.is_empty() {
                return Err(malformed());
            }
            let index = commits.len() as u32;
            indexes.insert(id, index);
            commits.push(metadata);
            index
        };
        lines.push(BlameLine {
            line,
            original_line,
            commit,
        });
    }
    Ok(GitBlame {
        entry: entry.into(),
        commits,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn porcelain_reuses_commit_metadata_and_accepts_sha256() {
        let id = "a".repeat(64);
        let bytes = format!(
            "{id} 3 1 2\nauthor Example\nauthor-mail <example@example.invalid>\nauthor-time 123\nsummary Change\nfilename file\n\tfirst\n{id} 4 2\n\tsecond\n"
        );
        let result = parse("entry", bytes.as_bytes()).unwrap();
        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.lines.len(), 2);
        assert_eq!(result.commits[0].email, "example@example.invalid");
        assert_eq!(result.lines[1].original_line, 4);
    }
    #[test]
    fn refuses_incomplete_or_misnumbered_results() {
        for value in [
            format!("{} 1 1\nauthor A\n", "a".repeat(40)),
            format!("{} 1 2\nauthor A\n\ttext\n", "a".repeat(40)),
            "bad 1 1\n\ttext\n".into(),
        ] {
            assert!(parse("e", value.as_bytes()).is_err());
        }
        assert!(parse("e", b"").unwrap().lines.is_empty());
    }
}
