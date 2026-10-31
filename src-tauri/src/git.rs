use crate::{
    documents::hash,
    dto::*,
    error::{AppError, Result},
    process, security,
    workspace::Workspace,
};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct DiffSnapshot {
    pub entry: String,
    pub staged: bool,
    pub full: Vec<u8>,
    pub parts: Vec<Vec<u8>>,
    pub signature: String,
    pub supported: bool,
}
fn os(bytes: &[u8]) -> Result<OsString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        Ok(OsString::from_vec(bytes.into()))
    }
    #[cfg(not(unix))]
    {
        Ok(String::from_utf8(bytes.into())
            .map_err(|_| AppError::new("encoding", "Unsupported filename encoding"))?
            .into())
    }
}
pub fn command(
    exe: &Path,
    root: &Path,
    args: &[OsString],
    input: Option<&[u8]>,
) -> Result<process::Output> {
    command_with_timeout(exe, root, args, input, Duration::from_secs(120))
}
pub(crate) fn command_with_timeout(
    exe: &Path,
    root: &Path,
    args: &[OsString],
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<process::Output> {
    let mut base: Vec<OsString> = [
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.pager=cat",
        "-c",
        "diff.external=",
    ]
    .iter()
    .map(Into::into)
    .collect();
    base.extend_from_slice(args);
    process::run(
        exe,
        root,
        &base.iter().map(OsString::as_os_str).collect::<Vec<_>>(),
        input,
        timeout,
    )
}
pub fn checked(
    exe: &Path,
    root: &Path,
    args: &[OsString],
    input: Option<&[u8]>,
) -> Result<Vec<u8>> {
    let out = command(exe, root, args, input)?;
    if !out.success {
        let message = String::from_utf8_lossy(&out.stderr);
        let code = if message.contains("index.lock") {
            "repositoryBusy"
        } else if message.contains("Authentication")
            || message.contains("terminal prompts disabled")
        {
            "authenticationRequired"
        } else {
            "git"
        };
        return Err(AppError::new(
            code,
            format!(
                "Git operation failed. {}",
                redact(&message.chars().take(4096).collect::<String>())
            ),
        ));
    }
    Ok(out.stdout)
}
fn redact(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            if word.contains("://") || word.contains("token=") {
                "[remote redacted]"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(Into::into).collect()
}
pub fn path_repository_root(exe: &Path, directory: &Path) -> Result<PathBuf> {
    let output = command_with_timeout(
        exe,
        directory,
        &args(&["rev-parse", "--show-toplevel"]),
        None,
        Duration::from_secs(10),
    )?;
    if !output.success {
        return Err(AppError::new(
            "notRepository",
            "This item is not in a Git repository. Copy its project-relative or absolute path instead.",
        ));
    }
    Ok(PathBuf::from(os(output
        .stdout
        .strip_suffix(b"\n")
        .unwrap_or(&output.stdout))?)
    .canonicalize()?)
}
pub struct ParsedChange {
    pub path: OsString,
    pub original: Option<OsString>,
    pub index: String,
    pub worktree: String,
    pub conflict: bool,
}
pub fn parse_status(bytes: &[u8]) -> Result<(String, Option<String>, Vec<ParsedChange>)> {
    let mut iter = bytes.split(|b| *b == 0);
    let mut branch = "unborn".to_string();
    let mut upstream = None;
    let mut changes = Vec::new();
    while let Some(row) = iter.next() {
        if row.is_empty() {
            continue;
        }
        if let Some(v) = row.strip_prefix(b"# branch.head ") {
            branch = String::from_utf8_lossy(v).into();
            continue;
        }
        if let Some(v) = row.strip_prefix(b"# branch.upstream ") {
            upstream = Some(String::from_utf8_lossy(v).into());
            continue;
        }
        if row[0] == b'#' {
            continue;
        }
        if row.starts_with(b"? ") {
            if changes.len() >= 100_000 {
                return Err(AppError::limit());
            }
            changes.push(ParsedChange {
                path: os(&row[2..])?,
                original: None,
                index: "?".into(),
                worktree: "?".into(),
                conflict: false,
            });
            continue;
        }
        if row.starts_with(b"! ") {
            continue;
        }
        let count = match row[0] {
            b'1' => 9,
            b'2' => 10,
            b'u' => 11,
            _ => return Err(AppError::new("protocol", "Unknown Git status record")),
        };
        let parts: Vec<_> = row.splitn(count, |b| *b == b' ').collect();
        if parts.len() != count || parts[1].len() != 2 || parts[count - 1].is_empty() {
            return Err(AppError::new("protocol", "Malformed Git status record"));
        }
        let original = if row[0] == b'2' {
            Some(os(iter.next().filter(|p| !p.is_empty()).ok_or_else(
                || AppError::new("protocol", "Truncated rename record"),
            )?)?)
        } else {
            None
        };
        changes.push(ParsedChange {
            path: os(parts[count - 1])?,
            original,
            index: String::from_utf8_lossy(&parts[1][0..1]).into(),
            worktree: String::from_utf8_lossy(&parts[1][1..2]).into(),
            conflict: row[0] == b'u',
        });
        if changes.len() > 100_000 {
            return Err(AppError::limit());
        }
    }
    Ok((branch, upstream, changes))
}
/// A read-only, scoped snapshot of the requested viewport paths. No workspace
/// mutex or live Workspace reference is retained while Git executes.
pub struct DecorationRead {
    pub project: Project,
    pub repository: Option<PathBuf>,
    exe: PathBuf,
    paths: Vec<(String, PathBuf)>,
}
impl DecorationRead {
    fn checked(&self, root: &Path, arguments: &[OsString]) -> Result<Vec<u8>> {
        let output =
            command_with_timeout(&self.exe, root, arguments, None, Duration::from_secs(10))?;
        if !output.success {
            return Err(AppError::new(
                "git",
                "Git colors are unavailable; file browsing remains available",
            ));
        }
        Ok(output.stdout)
    }
    pub fn read(&self) -> Result<Response> {
        if self.paths.is_empty() {
            return Ok(Response::GitDecorations {
                decorations: Vec::new(),
            });
        }
        let candidate = self
            .repository
            .as_deref()
            .unwrap_or(Path::new(&self.project.root));
        let output = self.checked(candidate, &args(&["rev-parse", "--show-toplevel"]))?;
        let root =
            PathBuf::from(os(output.strip_suffix(b"\n").unwrap_or(&output))?).canonicalize()?;
        if !root.starts_with(Path::new(&self.project.root)) {
            return Err(AppError::new(
                "scope",
                "Repository is outside the opened folder",
            ));
        }
        let mut queries = Vec::new();
        let mut input = Vec::new();
        for (id, path) in &self.paths {
            let absolute = Path::new(&self.project.root).join(path);
            let Ok(relative) = absolute.strip_prefix(&root) else {
                continue;
            };
            // check-ignore rejects pathspec magic; ./ keeps even :(glob) names literal.
            let query = Path::new(".").join(relative);
            input.extend_from_slice(query.as_os_str().as_encoded_bytes());
            input.push(0);
            queries.push((id, relative.to_path_buf()));
        }
        if queries.is_empty() {
            return Ok(Response::GitDecorations {
                decorations: Vec::new(),
            });
        }
        let ignored_output = command_with_timeout(
            &self.exe,
            &root,
            &args(&["--no-literal-pathspecs", "check-ignore", "--stdin", "-z"]),
            Some(&input),
            Duration::from_secs(10),
        )?;
        if !ignored_output.success && ignored_output.exit_code != Some(1) {
            return Err(AppError::new("git", "Could not read Git ignore rules"));
        }
        let ignored = ignored_output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|row| !row.is_empty())
            .map(|row| {
                os(row).map(|name| {
                    let path = PathBuf::from(name);
                    path.strip_prefix(".").unwrap_or(&path).to_path_buf()
                })
            })
            .collect::<Result<HashSet<_>>>()?;
        // Do not walk ignored build/cache folders or run an unrestricted status.
        // Git inspects only the visible, nonignored literal pathspecs. A visible
        // folder may still aggregate changes beneath that folder.
        let mut arguments = args(&[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=normal",
            "--",
        ]);
        let status_options = arguments.len();
        for (_, path) in &queries {
            if !ignored.contains(path) {
                arguments.push(if path.as_os_str().is_empty() {
                    ".".into()
                } else {
                    path.as_os_str().to_owned()
                });
            }
        }
        let mut states: HashMap<PathBuf, (GitFileStatus, bool)> = HashMap::new();
        let mut untracked = HashSet::new();
        if arguments.len() > status_options {
            let (_, _, changes) = parse_status(&self.checked(&root, &arguments)?)?;
            for change in changes {
                let path = PathBuf::from(&change.path);
                security::relative(&path)?;
                let staged = ![".", "?"].contains(&change.index.as_str());
                let state = if change.conflict {
                    GitFileStatus::Conflict
                } else if change.worktree == "D" || change.index == "D" {
                    GitFileStatus::Deleted
                } else if change.index == "?" {
                    GitFileStatus::Untracked
                } else if change.worktree != "." {
                    GitFileStatus::Modified
                } else if change.index == "R" {
                    GitFileStatus::Renamed
                } else if change.index == "A" {
                    GitFileStatus::Added
                } else {
                    GitFileStatus::Staged
                };
                if state == GitFileStatus::Untracked {
                    untracked.insert(path.clone());
                }
                for ancestor in path.ancestors() {
                    let item = states
                        .entry(ancestor.to_path_buf())
                        .or_insert((state, staged));
                    item.0 = item.0.max(state);
                    item.1 |= staged;
                    if states.len() > 100_000 {
                        return Err(AppError::limit());
                    }
                }
            }
        }
        // A rename whose old name is offscreen appears as Added in path-limited
        // status. Consult only the staged index for that case; never widen the
        // worktree scan to the whole repository to recover its original name.
        if states
            .values()
            .any(|(state, _)| *state == GitFileStatus::Added)
        {
            let renamed = self.checked(
                &root,
                &args(&[
                    "diff",
                    "--cached",
                    "--name-status",
                    "-z",
                    "--find-renames",
                    "--diff-filter=R",
                    "--no-ext-diff",
                    "--no-textconv",
                ]),
            )?;
            let mut rows = renamed
                .split(|byte| *byte == 0)
                .filter(|row| !row.is_empty());
            while let Some(kind) = rows.next() {
                if kind.first() != Some(&b'R') {
                    return Err(AppError::new("protocol", "Unexpected staged rename record"));
                }
                let _old = rows
                    .next()
                    .ok_or_else(|| AppError::new("protocol", "Truncated staged rename"))?;
                let path = PathBuf::from(os(rows
                    .next()
                    .ok_or_else(|| AppError::new("protocol", "Truncated staged rename"))?)?);
                security::relative(&path)?;
                if states
                    .get(&path)
                    .is_some_and(|(state, _)| *state == GitFileStatus::Added)
                {
                    for ancestor in path.ancestors() {
                        if let Some((state, _)) = states.get_mut(ancestor) {
                            *state = (*state).max(GitFileStatus::Renamed);
                        }
                    }
                }
            }
        }
        let decorations = queries
            .into_iter()
            .map(|(id, path)| {
                let (mut status, staged) = states.get(&path).copied().unwrap_or_else(|| {
                    if path
                        .ancestors()
                        .any(|ancestor| untracked.contains(ancestor))
                    {
                        (GitFileStatus::Untracked, false)
                    } else {
                        (GitFileStatus::Clean, false)
                    }
                });
                if ignored.contains(&path) && status <= GitFileStatus::Untracked {
                    status = GitFileStatus::Ignored;
                }
                GitDecoration {
                    entry: id.clone(),
                    status,
                    staged,
                }
            })
            .collect();
        Ok(Response::GitDecorations { decorations })
    }
}
impl Workspace {
    pub fn decoration_read(&self, exe: &Path, entries: &[String]) -> Result<DecorationRead> {
        if entries.len() > 512 {
            return Err(AppError::limit());
        }
        let paths = entries
            .iter()
            .map(|id| self.entry(id).map(|path| (id.clone(), path)))
            .collect::<Result<Vec<_>>>()?;
        Ok(DecorationRead {
            project: self.project.clone(),
            repository: self.repository.clone(),
            exe: exe.to_path_buf(),
            paths,
        })
    }
    pub fn git_decorations(&mut self, exe: &Path, entries: &[String]) -> Result<Response> {
        self.decoration_read(exe, entries)?.read()
    }
    pub fn git_root(&mut self, exe: &Path, selected: Option<&str>) -> Result<PathBuf> {
        let candidate = if let Some(id) = selected {
            Path::new(&self.project.root).join(self.entry(id)?)
        } else {
            self.repository
                .clone()
                .unwrap_or_else(|| PathBuf::from(&self.project.root))
        };
        let out = checked(
            exe,
            &candidate,
            &args(&["rev-parse", "--show-toplevel"]),
            None,
        )?;
        let raw = out.strip_suffix(b"\n").unwrap_or(&out);
        let root = PathBuf::from(os(raw)?).canonicalize()?;
        if !root.starts_with(Path::new(&self.project.root)) {
            return Err(AppError::new(
                "scope",
                "Repository root lies above this folder; open that repository root explicitly",
            ));
        }
        // rev-parse works for normal, unborn, linked worktree, nested and submodule checkouts.
        checked(
            exe,
            &root,
            &args(&["rev-parse", "--absolute-git-dir", "--git-common-dir"]),
            None,
        )?;
        self.repository = Some(root.clone());
        Ok(root)
    }
    fn git_path(&self, root: &Path, entry: &str) -> Result<PathBuf> {
        Path::new(&self.project.root)
            .join(self.entry(entry)?)
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .map_err(|_| AppError::new("scope", "File belongs to another repository"))
    }
    fn staged_revision(&self, exe: &Path, root: &Path) -> Result<String> {
        Ok(hash(&checked(
            exe,
            root,
            &args(&[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--binary",
                "--full-index",
            ]),
            None,
        )?))
    }
    pub fn git_status(&mut self, exe: &Path, selected: Option<&str>) -> Result<Response> {
        let root = self.git_root(exe, selected)?;
        let out = checked(
            exe,
            &root,
            &args(&[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=normal",
            ]),
            None,
        )?;
        let (branch, upstream, parsed) = parse_status(&out)?;
        let mut changes = Vec::new();
        for c in parsed {
            let path = root
                .join(&c.path)
                .strip_prefix(&self.project.root)
                .map(Path::to_path_buf)
                .map_err(|_| AppError::new("scope", "Change outside project"))?;
            security::relative(&path)?;
            let entry = self.register(path);
            changes.push(Change {
                entry,
                path: security::display(Path::new(&c.path)),
                index: c.index,
                worktree: c.worktree,
                original: c.original.map(|p| security::display(Path::new(&p))),
                conflict: c.conflict,
            });
        }
        let author = command(exe, &root, &args(&["var", "GIT_AUTHOR_IDENT"]), None)?;
        let author = if author.success {
            String::from_utf8_lossy(&author.stdout)
                .split('>')
                .next()
                .map(|s| format!("{s}>"))
                .unwrap_or_default()
        } else {
            "Author identity missing; configure user.name and user.email before committing".into()
        };
        let signing = command(
            exe,
            &root,
            &args(&["config", "--get", "commit.gpgsign"]),
            None,
        )?;
        let signing = if signing.success
            && ["true", "yes", "on", "1"].contains(&String::from_utf8_lossy(&signing.stdout).trim())
        {
            "Commit signing enabled; configured signer must be available"
        } else {
            "Commit signing disabled by Git configuration"
        }
        .to_string();
        Ok(Response::GitStatus {
            status: GitStatus {
                root: security::display(&root),
                branch,
                upstream,
                changes,
                staged_revision: self.staged_revision(exe, &root)?,
                author,
                signing,
            },
        })
    }
    fn raw_diff(&self, exe: &Path, root: &Path, path: &Path, staged: bool) -> Result<Vec<u8>> {
        let mut a = args(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--full-index",
            "--no-renames",
            "--unified=3",
        ]);
        if staged {
            a.push("--cached".into());
        }
        a.push("--".into());
        a.push(path.as_os_str().into());
        checked(exe, root, &a, None)
    }
    fn object(&self, exe: &Path, root: &Path, prefix: &str, path: &Path) -> Result<Vec<u8>> {
        let mut spec = OsString::from(prefix);
        spec.push(path.as_os_str());
        let out = command(exe, root, &["show".into(), spec], None)?;
        if out.success {
            Ok(out.stdout)
        } else {
            Ok(Vec::new())
        }
    }
    pub fn git_diff(&mut self, exe: &Path, entry: &str, staged: bool) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let path = self.git_path(&root, entry)?;
        let raw = self.raw_diff(exe, &root, &path, staged)?;
        let base = self.object(exe, &root, if staged { "HEAD:" } else { ":" }, &path)?;
        let next = if staged {
            self.object(exe, &root, ":", &path)?
        } else {
            let rel = self.entry(entry)?;
            let (parent, leaf) = security::parent(&self.dir, &rel)?;
            if let Ok(file) = security::open_read(&parent, &leaf) {
                let m = file.metadata()?;
                if m.is_file() && m.len() <= 20 * 1024 * 1024 {
                    let mut bytes = Vec::new();
                    use std::io::Read;
                    file.take(20 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
                    if bytes.len() > 20 * 1024 * 1024 {
                        return Err(AppError::limit());
                    }
                    bytes
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        };
        let text = std::str::from_utf8(&raw).ok();
        let mut unavailable = None;
        let attrs = checked(
            exe,
            &root,
            &[
                "check-attr".into(),
                "-z".into(),
                "filter".into(),
                "working-tree-encoding".into(),
                "diff".into(),
                "--".into(),
                path.as_os_str().into(),
            ],
            None,
        )?;
        let custom = attrs
            .split(|b| *b == 0)
            .collect::<Vec<_>>()
            .chunks(3)
            .any(|p| p.len() == 3 && p[2] != b"unspecified" && p[2] != b"unset");
        let parts = if let Some(text) = text.as_ref() {
            split_hunks(text)
        } else {
            Vec::new()
        };
        if raw.windows(16).any(|b| b == b"GIT binary patch")
            || base.contains(&0)
            || next.contains(&0)
            || std::str::from_utf8(&base).is_err()
            || std::str::from_utf8(&next).is_err()
        {
            unavailable = Some("Binary or unsupported encoding; use file staging".into());
        }
        if custom {
            unavailable = Some("Custom attributes/filters require exact whole-file staging".into());
        }
        if parts.is_empty() {
            unavailable = Some(
                "No independently stageable text hunks (untracked, mode-only or metadata change)"
                    .into(),
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        let hunks = parts
            .iter()
            // The renderer only uses hunk count/index. Keep the exact patch
            // native; do not duplicate its body across IPC and renderer tabs.
            .map(|b| {
                String::from_utf8_lossy(b)
                    .lines()
                    .find(|line| line.starts_with("@@"))
                    .unwrap_or("Git hunk")
                    .to_owned()
            })
            .collect();
        if self.diffs.len() >= 32 {
            self.diffs.clear();
        }
        self.diffs.insert(
            id.clone(),
            DiffSnapshot {
                entry: entry.into(),
                staged,
                signature: hash(&raw),
                full: raw,
                parts,
                supported: unavailable.is_none(),
            },
        );
        Ok(Response::Diff {
            diff: Diff {
                id,
                entry: entry.into(),
                path: security::display(&path),
                base_label: if staged { "HEAD" } else { "Index" }.into(),
                next_label: if staged { "Index" } else { "Working file" }.into(),
                base: String::from_utf8(base)
                    .unwrap_or_else(|_| "Binary / unsupported encoding".into()),
                next: String::from_utf8(next)
                    .unwrap_or_else(|_| "Binary / unsupported encoding".into()),
                hunks,
                hunk_unavailable: unavailable,
            },
        })
    }
    pub fn git_stage(&mut self, exe: &Path, entry: &str, unstage: bool) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let path = self.git_path(&root, entry)?;
        let mut a = if unstage {
            if command(exe, &root, &args(&["rev-parse", "--verify", "HEAD"]), None)?.success {
                args(&["restore", "--staged", "--"])
            } else {
                args(&["rm", "--cached", "--ignore-unmatch", "--"])
            }
        } else {
            args(&["add", "--"])
        };
        a.push(path.into_os_string());
        checked(exe, &root, &a, None)?;
        self.git_status(exe, None)
    }
    pub fn git_hunk(&mut self, exe: &Path, id: &str, hunk: u32, unstage: bool) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let snap = self
            .diffs
            .get(id)
            .ok_or_else(|| AppError::conflict("Diff expired; select the hunk again"))?;
        if snap.staged != unstage {
            return Err(AppError::conflict("Wrong diff base for staging"));
        }
        if !snap.supported {
            return Err(AppError::new(
                "unsupported",
                "This diff supports exact file-level staging only",
            ));
        }
        let path = self.git_path(&root, &snap.entry)?;
        if hash(&self.raw_diff(exe, &root, &path, snap.staged)?) != snap.signature {
            return Err(AppError::conflict("Stale hunk; refresh and select again"));
        }
        let patch = snap
            .parts
            .get(hunk as usize)
            .ok_or_else(|| AppError::new("scope", "Unknown hunk"))?;
        let mut a = args(&["apply", "--cached", "--whitespace=nowarn"]);
        if unstage {
            a.push("--reverse".into());
        }
        a.push("--check".into());
        checked(exe, &root, &a, Some(patch))?;
        a.pop();
        checked(exe, &root, &a, Some(patch))?;
        self.git_status(exe, None)
    }
    pub fn git_commit(&mut self, exe: &Path, message: &str, reviewed: &str) -> Result<Response> {
        if message.trim().is_empty() || message.len() > 65536 {
            return Err(AppError::new("input", "Enter a commit message"));
        }
        let root = self.git_root(exe, None)?;
        if self.staged_revision(exe, &root)? != reviewed {
            return Err(AppError::conflict(
                "Staged content changed; review it again before committing",
            ));
        }
        // Capture the complete index tree, including unchanged paths. Hooks and
        // other clients retain their normal authority; after committing, compare
        // what actually landed rather than claiming the preflight was a lock.
        let expected_tree = checked(exe, &root, &args(&["write-tree"]), None)?;
        if self.staged_revision(exe, &root)? != reviewed {
            return Err(AppError::conflict(
                "Staged content changed; review it again before committing",
            ));
        }
        checked(
            exe,
            &root,
            &args(&["commit", "--file=-"]),
            Some(message.as_bytes()),
        )?;
        let commit = checked(
            exe,
            &root,
            &args(&["log", "-1", "--format=%H%x00%T%x00%s"]),
            None,
        )?;
        let mut fields = commit.splitn(3, |b| *b == 0);
        let id = fields.next().unwrap_or_default();
        let actual_tree = fields.next().unwrap_or_default();
        let subject = fields.next().unwrap_or_default();
        let changed = actual_tree != expected_tree.strip_suffix(b"\n").unwrap_or(&expected_tree);
        Ok(Response::Text {
            text: format!(
                "Committed {}\n{}. Hooks/signing were enabled. {}",
                String::from_utf8_lossy(id),
                String::from_utf8_lossy(subject).trim_end(),
                if changed {
                    "Warning: the committed tree differs from the reviewed staged content. A hook or another Git client changed it. Inspect History before pushing. This commit was not retried or reset."
                } else {
                    "Review resulting commit in History."
                }
            ),
        })
    }
    pub fn git_network(&mut self, exe: &Path, operation: &str) -> Result<Response> {
        self.git_network_auth(exe, operation, &[])
    }
    pub fn git_network_auth(
        &mut self,
        exe: &Path,
        operation: &str,
        environment: &[(String, String)],
    ) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let a = match operation {
            "fetch" => args(&["fetch", "--progress"]),
            "pull" => args(&["pull", "--ff-only", "--progress"]),
            "push" => args(&["push", "--progress"]),
            _ => return Err(AppError::new("scope", "Unsupported network operation")),
        };
        let refs = a.iter().map(OsString::as_os_str).collect::<Vec<_>>();
        let out = process::run_with_env(
            exe,
            &root,
            &refs,
            None,
            Duration::from_secs(120),
            environment,
        )?;
        if !out.success {
            return Err(AppError::new(
                "gitNetwork",
                format!(
                    "{operation} did not complete successfully. Inspect remote/local state before retrying. {}",
                    redact(
                        &String::from_utf8_lossy(&out.stderr)
                            .chars()
                            .take(4096)
                            .collect::<String>()
                    )
                ),
            ));
        }
        Ok(Response::Text {
            text: format!(
                "{operation} completed. {}",
                redact(&String::from_utf8_lossy(&out.stdout))
            ),
        })
    }
    pub fn git_list(&mut self, exe: &Path, kind: &str, offset: u32) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        if kind == "remotes" {
            let out = checked(exe, &root, &args(&["remote"]), None)?;
            let items = String::from_utf8_lossy(&out)
                .lines()
                .map(|s| NamedItem {
                    id: s.into(),
                    label: s.into(),
                    detail: String::new(),
                })
                .collect();
            return Ok(Response::Items { items, more: false });
        }
        let a = match kind {
            "branches" => args(&[
                "for-each-ref",
                "--format=%(refname:short)%00%(upstream:short)%00%(objectname)",
                "refs/heads/",
            ]),
            "history" => args(&[
                "log",
                "--format=%H%x00%s%x00%d",
                "-n",
                "100",
                &format!("--skip={offset}"),
            ]),
            "stash" => args(&["stash", "list", "--format=%gd%x00%s%x00%H"]),
            _ => return Err(AppError::new("scope", "Unsupported list operation")),
        };
        let out = checked(exe, &root, &a, None)?;
        let items = String::from_utf8_lossy(&out)
            .lines()
            .map(|l| {
                let mut p = l.splitn(3, '\0');
                NamedItem {
                    id: p.next().unwrap_or("").into(),
                    label: p.next().unwrap_or("").into(),
                    detail: p.next().unwrap_or("").into(),
                }
            })
            .collect::<Vec<_>>();
        let more = items.len() == 100;
        Ok(Response::Items { items, more })
    }
    pub fn git_branch(&mut self, exe: &Path, name: &str, create: bool) -> Result<Response> {
        if name.starts_with('-') || name.len() > 255 {
            return Err(AppError::new("input", "Invalid branch name"));
        }
        let root = self.git_root(exe, None)?;
        checked(
            exe,
            &root,
            &args(&["check-ref-format", "--branch", name]),
            None,
        )?;
        let a = if create {
            args(&["switch", "-c", name])
        } else {
            args(&["switch", name])
        };
        checked(exe, &root, &a, None)?;
        self.git_status(exe, None)
    }
    pub fn git_publish(
        &mut self,
        exe: &Path,
        remote: &str,
        environment: &[(String, String)],
    ) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let remotes = checked(exe, &root, &args(&["remote"]), None)?;
        if !String::from_utf8_lossy(&remotes)
            .lines()
            .any(|r| r == remote)
        {
            return Err(AppError::new("scope", "Select an existing named remote"));
        }
        let branch = checked(
            exe,
            &root,
            &args(&["symbolic-ref", "--quiet", "--short", "HEAD"]),
            None,
        )?;
        let branch = String::from_utf8(branch)
            .map_err(|_| AppError::new("encoding", "Unsupported branch encoding"))?;
        let branch = branch.trim();
        let a = args(&["push", "--progress", "--set-upstream", "--", remote, branch]);
        let out = process::run_with_env(
            exe,
            &root,
            &a.iter().map(OsString::as_os_str).collect::<Vec<_>>(),
            None,
            Duration::from_secs(120),
            environment,
        )?;
        if !out.success {
            return Err(AppError::new(
                "gitNetwork",
                format!(
                    "Push was not acknowledged as successful. Inspect remote state before retrying. {}",
                    redact(&String::from_utf8_lossy(&out.stderr))
                ),
            ));
        }
        Ok(Response::Text {
            text: format!("Pushed {branch} to {remote} and set its upstream"),
        })
    }
    pub fn git_show(&mut self, exe: &Path, commit: &str) -> Result<Response> {
        if !(4..=64).contains(&commit.len()) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::new("input", "Invalid commit object ID"));
        }
        let root = self.git_root(exe, None)?;
        let out = checked(
            exe,
            &root,
            &args(&[
                "show",
                "--format=fuller",
                "--stat",
                "--patch",
                "--no-ext-diff",
                "--no-textconv",
                commit,
                "--",
            ]),
            None,
        )?;
        Ok(Response::Text {
            text: String::from_utf8(out).map_err(|_| {
                AppError::new("encoding", "Commit contains unsupported display bytes")
            })?,
        })
    }
    pub fn git_stash(
        &mut self,
        exe: &Path,
        operation: &str,
        id: Option<&str>,
        message: Option<&str>,
    ) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let id = id.unwrap_or("stash@{0}");
        if !id.starts_with("stash@{")
            || !id.ends_with('}')
            || !id[7..id.len() - 1].bytes().all(|b| b.is_ascii_digit())
        {
            return Err(AppError::new("input", "Invalid stash reference"));
        }
        let a = match operation {
            "save" => args(&["stash", "push", "-m", message.unwrap_or("Workspace stash")]),
            "apply" => args(&["stash", "apply", id]),
            "drop" => args(&["stash", "drop", id]),
            "inspect" => args(&[
                "stash",
                "show",
                "--patch",
                "--no-ext-diff",
                "--no-textconv",
                id,
            ]),
            _ => return Err(AppError::new("scope", "Unsupported stash operation")),
        };
        Ok(Response::Text {
            text: String::from_utf8_lossy(&checked(exe, &root, &a, None)?).into(),
        })
    }
    pub fn git_conflict(&mut self, exe: &Path, entry: &str) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        let p = self.git_path(&root, entry)?;
        let base = self.object(exe, &root, ":1:", &p)?;
        let current = self.object(exe, &root, ":2:", &p)?;
        let incoming = self.object(exe, &root, ":3:", &p)?;
        fn text(bytes: Vec<u8>) -> Result<String> {
            String::from_utf8(bytes).map_err(|_|AppError::new("encoding","Conflict stage is not valid UTF-8; resolve this file with a suitable external tool"))
        }
        Ok(Response::GitConflict {
            conflict: GitConflict {
                entry: entry.into(),
                path: security::display(&p),
                base: text(base)?,
                current: text(current)?,
                incoming: text(incoming)?,
                reviewed: self.staged_revision(exe, &root)?,
            },
        })
    }
}
impl Workspace {
    pub fn git_resolve(&mut self, exe: &Path, entry: &str, reviewed: &str) -> Result<Response> {
        let root = self.git_root(exe, None)?;
        if self.staged_revision(exe, &root)? != reviewed {
            return Err(AppError::conflict(
                "Index changed since conflict review. Reopen the conflict before staging.",
            ));
        }
        if self.documents.get(entry).is_some_and(|d| d.dirty) {
            return Err(AppError::conflict(
                "Save the reviewed resolution before staging",
            ));
        }
        self.git_stage(exe, entry, false)
    }
    pub fn git_revision_files(&mut self, exe: &Path, commit: &str) -> Result<Response> {
        validate_commit(commit)?;
        let root = self.git_root(exe, None)?;
        let paths = checked(
            exe,
            &root,
            &args(&[
                "diff-tree",
                "--root",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                commit,
                "--",
            ]),
            None,
        )?;
        let mut entries = Vec::new();
        let mut truncated = false;
        for bytes in paths.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            if entries.len() >= 1000 {
                truncated = true;
                break;
            }
            let p = PathBuf::from(os(bytes)?);
            security::relative(&p)?;
            let path = root
                .join(&p)
                .strip_prefix(&self.project.root)
                .map_err(|_| AppError::new("scope", "Historical file outside workspace"))?
                .to_path_buf();
            let id = self.register(path);
            entries.push(Entry {
                id,
                name: security::display(&p),
                path: security::display(&p),
                kind: "file".into(),
            });
        }
        Ok(Response::Entries { entries, truncated })
    }
    pub fn git_revision_diff(&mut self, exe: &Path, commit: &str, entry: &str) -> Result<Response> {
        validate_commit(commit)?;
        let root = self.git_root(exe, None)?;
        let path = self.git_path(&root, entry)?;
        let parent = command(
            exe,
            &root,
            &args(&["rev-parse", "--verify", &format!("{commit}^1")]),
            None,
        )?;
        let parent = if parent.success {
            String::from_utf8_lossy(&parent.stdout).trim().to_string()
        } else {
            String::new()
        };
        let base = if parent.is_empty() {
            Vec::new()
        } else {
            self.object(exe, &root, &format!("{parent}:"), &path)?
        };
        let next = self.object(exe, &root, &format!("{commit}:"), &path)?;
        if base.len() + next.len() > 20 * 1024 * 1024 || base.contains(&0) || next.contains(&0) {
            return Err(AppError::new(
                "unsupported",
                "Historical binary/large-file comparison is not editable; inspect with a suitable external tool",
            ));
        }
        let base = String::from_utf8(base)
            .map_err(|_| AppError::new("encoding", "Historical text is not valid UTF-8"))?;
        let next = String::from_utf8(next)
            .map_err(|_| AppError::new("encoding", "Historical text is not valid UTF-8"))?;
        Ok(Response::Diff {
            diff: Diff {
                id: uuid::Uuid::new_v4().to_string(),
                entry: entry.into(),
                path: security::display(&path),
                base_label: if parent.is_empty() {
                    "Empty tree".into()
                } else {
                    parent[..12].into()
                },
                next_label: commit[..commit.len().min(12)].into(),
                base,
                next,
                hunks: vec![],
                hunk_unavailable: Some(
                    "Historical comparison. Stage working changes separately.".into(),
                ),
            },
        })
    }
}
fn validate_commit(commit: &str) -> Result<()> {
    if !(4..=64).contains(&commit.len()) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::new("input", "Invalid commit object ID"));
    }
    Ok(())
}
pub fn split_hunks(text: &str) -> Vec<Vec<u8>> {
    let Some(start) = text.find("\n@@ ").map(|i| i + 1) else {
        return vec![];
    };
    let header = &text[..start];
    let mut result = Vec::new();
    let mut current = String::new();
    for line in text[start..].split_inclusive('\n') {
        if line.starts_with("@@ ") && !current.is_empty() {
            result.push(format!("{header}{current}").into_bytes());
            current.clear();
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        result.push(format!("{header}{current}").into_bytes());
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_rename_and_newline() {
        let b=b"# branch.head main\0? :(glob)a\nb\01 RM N... 100644 100644 100644 abc def ordinary\02 R. N... 100644 100644 100644 abc def R100 new name\0old\nname\0";
        let (_, _, c) = parse_status(b).unwrap();
        assert_eq!(c.len(), 3);
        assert_eq!(c[2].original, Some(OsString::from("old\nname")));
    }
    #[test]
    fn truncated_refused() {
        assert!(parse_status(b"2 R. N... 1 1 1 a b R100 new\0").is_err());
    }
    proptest::proptest! {#[test]fn arbitrary_status_never_panics(b in proptest::collection::vec(proptest::num::u8::ANY,0..4096)){let _=parse_status(&b);}}
}
