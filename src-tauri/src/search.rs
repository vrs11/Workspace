use crate::{
    dto::{Response, SearchMatch},
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
pub fn search(
    w: &mut Workspace,
    query: &str,
    names: bool,
    ignored: bool,
    regex: bool,
    generation: u32,
    cancel: Arc<AtomicU32>,
    bus: Option<Arc<crate::EventBus>>,
) -> Result<Response> {
    if query.is_empty() || query.len() > 1000 {
        return Err(AppError::new("input", "Search requires 1–1000 bytes"));
    }
    let matcher = grep_regex::RegexMatcherBuilder::new()
        .fixed_strings(!regex)
        .multi_line(true)
        .crlf(true)
        .line_terminator(Some(b'\n'))
        .build(query)
        .map_err(|e| AppError::new("input", format!("Invalid regular expression: {e}")))?;
    let name_pattern = if names && regex {
        Some(
            regex::RegexBuilder::new(query)
                .case_insensitive(true)
                .build()
                .map_err(|e| AppError::new("input", format!("Invalid regular expression: {e}")))?,
        )
    } else {
        None
    };
    let mut results = Vec::new();
    let start = Instant::now();
    let mut count = 0;
    let mut truncated = false;
    let mut delivered = 0;
    let walker = ignore::WalkBuilder::new(&w.project.root)
        .hidden(false)
        .git_ignore(!ignored)
        .git_exclude(!ignored)
        .ignore(!ignored)
        .follow_links(false)
        .filter_entry(|e| {
            ![".git", ".agent-workspace"]
                .iter()
                .any(|name| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        })
        .build();
    for entry in walker {
        if results.len() >= delivered + 50 {
            if let Some(bus) = &bus {
                bus.emit(crate::dto::StreamEvent::SearchBatch {
                    scope: w.project.id.clone(),
                    generation,
                    matches: results[delivered..].to_vec(),
                });
            }
            delivered = results.len();
        }
        if cancel.load(Ordering::SeqCst) != generation {
            return Err(AppError::new("cancelled", "Search cancelled"));
        }
        count += 1;
        if results.len() >= 1000 || count >= 100_000 || start.elapsed() > Duration::from_secs(10) {
            truncated = true;
            break;
        }
        let entry = entry.map_err(|_| {
            AppError::new("permissionDenied", "Some search paths could not be read")
        })?;
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(&w.project.root)
            .map_err(|_| AppError::new("scope", "Search escaped workspace"))?
            .to_path_buf();
        security::relative(&relative)?;
        let path = security::display(&relative);
        if names {
            if name_pattern.as_ref().map_or_else(
                || path.to_lowercase().contains(&query.to_lowercase()),
                |pattern| pattern.is_match(&path),
            ) {
                let id = w.register(relative);
                results.push(SearchMatch {
                    entry: id,
                    path,
                    line: 1,
                    text: String::new(),
                });
            }
            continue;
        }
        let (parent, leaf) = security::parent(&w.dir, &relative)?;
        let file = security::open_read(&parent, &leaf)?;
        let m = file.metadata()?;
        if !m.is_file() || m.len() > 20 * 1024 * 1024 {
            continue;
        }
        let mut matches = Vec::new();
        grep_searcher::SearcherBuilder::new()
            .line_number(true)
            .build()
            .search_reader(
                &matcher,
                file,
                grep_searcher::sinks::UTF8(|line, text| {
                    if cancel.load(Ordering::SeqCst) != generation {
                        return Ok(false);
                    }
                    if matches.len() + results.len() >= 1000 {
                        return Ok(false);
                    }
                    matches.push((line as u32, text.chars().take(512).collect::<String>()));
                    Ok(true)
                }),
            )
            .map_err(|_| {
                AppError::new(
                    "search",
                    "Search failed; unsupported encoding or file changed",
                )
            })?;
        if !matches.is_empty() {
            let id = w.register(relative);
            for (line, text) in matches {
                results.push(SearchMatch {
                    entry: id.clone(),
                    path: path.clone(),
                    line,
                    text,
                });
            }
        }
    }
    Ok(Response::Search {
        matches: results,
        generation,
        truncated,
    })
}

pub struct Replacement {
    files: Vec<(crate::dto::Document, String)>,
}
// Bound every append before allocation, including expanded capture references.
// Literal mode never interprets '$'. Regex mode follows Rust regex's $1/${name}/$$ syntax.
fn replace_bounded(
    pattern: &regex::Regex,
    text: &str,
    replacement: &str,
    expand: bool,
) -> Result<(String, usize)> {
    fn append(out: &mut String, part: &str) -> Result<()> {
        if out.len().saturating_add(part.len()) > 20 * 1024 * 1024 {
            return Err(AppError::limit());
        }
        out.push_str(part);
        Ok(())
    }
    let mut out = String::new();
    let mut end = 0;
    let mut count = 0;
    for captures in pattern.captures_iter(text) {
        count += 1;
        if count > 100_000 {
            return Err(AppError::limit());
        }
        let found = captures.get(0).expect("whole match");
        append(&mut out, &text[end..found.start()])?;
        end = found.end();
        if !expand {
            append(&mut out, replacement)?;
            continue;
        }
        let mut rest = replacement;
        while let Some(dollar) = rest.find('$') {
            append(&mut out, &rest[..dollar])?;
            rest = &rest[dollar + 1..];
            if let Some(tail) = rest.strip_prefix('$') {
                append(&mut out, "$")?;
                rest = tail;
                continue;
            }
            let reference = if let Some(braced) = rest.strip_prefix('{') {
                braced.find('}').map(|end| (&braced[..end], end + 2))
            } else {
                let end = rest
                    .bytes()
                    .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
                    .count();
                (end > 0).then_some((&rest[..end], end))
            };
            if let Some((name, consumed)) = reference {
                let value = name
                    .parse::<usize>()
                    .map_or_else(|_| captures.name(name), |index| captures.get(index));
                if let Some(value) = value {
                    append(&mut out, value.as_str())?;
                }
                rest = &rest[consumed..];
            } else {
                append(&mut out, "$")?;
            }
        }
        append(&mut out, rest)?;
    }
    append(&mut out, &text[end..])?;
    Ok((out, count))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_preserves_literal_dollars_and_expands_regex_captures() {
        let pattern = regex::Regex::new(r"(item)(?P<number>\d+)").unwrap();
        assert_eq!(
            replace_bounded(&pattern, "item12\r\nitem3", "${number}-$1-$$-$absent", true).unwrap(),
            ("12-item-$-\r\n3-item-$-".into(), 2)
        );
        assert_eq!(
            replace_bounded(&pattern, "item12", "$1", false).unwrap(),
            ("$1".into(), 1)
        );
        assert_eq!(
            replace_bounded(&regex::Regex::new(r"(?m)^").unwrap(), "a\nb", ">", true).unwrap(),
            (">a\n>b".into(), 2)
        );
    }
    #[test]
    fn capture_expansion_is_bounded_before_a_large_allocation() {
        let text = "x".repeat(1024 * 1024);
        let replacement = "$1".repeat(32);
        assert!(
            replace_bounded(
                &regex::Regex::new("(x+)").unwrap(),
                &text,
                &replacement,
                true
            )
            .is_err()
        );
    }
}
impl Workspace {
    pub fn replace_preview(
        &mut self,
        entries: Vec<String>,
        query: &str,
        replacement: &str,
        regex: bool,
        storage: &crate::storage::Storage,
    ) -> Result<Response> {
        use crate::dto::Diff;
        if query.is_empty()
            || query.len() > 1000
            || replacement.len() > 65536
            || entries.is_empty()
            || entries.len() > 100
        {
            return Err(AppError::limit());
        }
        let entries: std::collections::HashSet<_> = entries.into_iter().collect();
        let pattern = regex::RegexBuilder::new(&if regex {
            query.to_owned()
        } else {
            regex::escape(query)
        })
        .multi_line(true)
        .crlf(true)
        .build()
        .map_err(|e| AppError::new("input", format!("Invalid regular expression: {e}")))?;
        let mut files = Vec::new();
        let mut diffs = Vec::new();
        let mut occurrences = 0;
        let mut bytes = 0;
        for entry in entries {
            if self.documents.get(&entry).is_some_and(|d| d.dirty) {
                return Err(AppError::conflict(
                    "Save or discard unsaved files before previewing project replace",
                ));
            }
            let already_open = self.documents.contains_key(&entry);
            let Response::Document { document } = self.document_open(&entry, storage)? else {
                unreachable!()
            };
            if !already_open {
                self.documents.remove(&entry);
            }
            if document.readonly.is_some() || document.recovery.is_some() {
                return Err(AppError::new(
                    "unsupported",
                    format!(
                        "{} requires resolving read-only/recovery state before replacement",
                        document.path
                    ),
                ));
            }
            let (next, count) = replace_bounded(&pattern, &document.text, replacement, regex)?;
            if count == 0 {
                continue;
            }
            bytes += next.len() + document.text.len();
            if bytes > 20 * 1024 * 1024 {
                return Err(AppError::limit());
            }
            occurrences += count as u32;
            diffs.push(Diff {
                id: uuid::Uuid::new_v4().to_string(),
                entry: entry.clone(),
                path: document.path.clone(),
                base_label: "Reviewed disk".into(),
                next_label: "Replacement preview".into(),
                base: document.text.clone(),
                next: next.clone(),
                hunks: vec![],
                hunk_unavailable: Some(
                    "Project replacement preview; select files and apply from Search".into(),
                ),
            });
            files.push((document, next));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.replacements.clear();
        self.replacements.insert(id.clone(), Replacement { files });
        diffs.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Response::Replacement {
            id,
            files: diffs,
            occurrences,
        })
    }
    pub fn replace_apply(
        &mut self,
        preview: &str,
        entries: Vec<String>,
        storage: &crate::storage::Storage,
    ) -> Result<Response> {
        let plan = self
            .replacements
            .remove(preview)
            .ok_or_else(|| AppError::conflict("Replacement preview expired; preview again"))?;
        let selected: std::collections::HashSet<_> = entries.into_iter().collect();
        if selected.is_empty()
            || selected.len() > 100
            || selected
                .iter()
                .any(|id| !plan.files.iter().any(|(d, _)| d.id == *id))
        {
            return Err(AppError::new(
                "scope",
                "Select files from this replacement preview",
            ));
        }
        // Check every selected file before the first write. Per-file atomic saves
        // still revalidate at commit; external writers cannot be locked out.
        for (doc, _) in plan.files.iter().filter(|(d, _)| selected.contains(&d.id)) {
            if self.documents.get(&doc.id).is_some_and(|d| {
                d.dirty || d.dto.baseline != doc.baseline || d.checkpoint != doc.revision
            }) {
                return Err(AppError::conflict(
                    "Editor state changed after replacement preview; preview again",
                ));
            }
            let path = self.entry(&doc.entry)?;
            let (parent, leaf) = security::parent(&self.dir, &path)?;
            use std::io::Read;
            let mut bytes = Vec::new();
            security::open_read(&parent, &leaf)?
                .take(20 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if crate::documents::hash(&bytes) != doc.baseline {
                return Err(AppError::conflict(
                    "A file changed on disk after replacement preview; no files were replaced",
                ));
            }
        }
        let mut applied = 0;
        for (doc, next) in plan
            .files
            .into_iter()
            .filter(|(d, _)| selected.contains(&d.id))
        {
            let opened_for_save = !self.documents.contains_key(&doc.id);
            if opened_for_save {
                self.documents.insert(
                    doc.id.clone(),
                    crate::documents::DocumentState {
                        dto: doc.clone(),
                        dirty: false,
                        checkpoint: doc.revision,
                    },
                );
            }
            let saved = self.save(&doc.id, &next, doc.revision + 1, &doc.baseline, storage);
            if opened_for_save {
                self.documents.remove(&doc.id);
            }
            match saved {
                Ok(_) => applied += 1,
                Err(e) => {
                    return Ok(Response::Text {
                        text: format!(
                            "Replacement stopped after {applied} saved file(s). {}: {}. Review disk and retained editor recovery before continuing.",
                            doc.path, e.message
                        ),
                    });
                }
            }
        }
        Ok(Response::Text {
            text: format!(
                "Replaced text in {applied} selected file(s). Review changes before staging."
            ),
        })
    }
}
