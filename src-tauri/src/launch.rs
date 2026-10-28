//! Folder requests from native launches are offers, never automatic mutations.
use std::{collections::VecDeque, path::Path, sync::Mutex};
#[derive(Default)]
pub struct LaunchRequests(Mutex<VecDeque<String>>);
pub fn folder_argument(args: &[String], cwd: &Path) -> Option<String> {
    let values = args.get(1..)?;
    let (value, literal) = match values {
        [value] => (value, false),
        [separator, value] if separator == "--" => (value, true),
        _ => return None,
    };
    if value.is_empty()
        || value.len() > 8192
        || value.contains('\0')
        || (!literal && value.starts_with('-'))
    {
        return None;
    }
    let path = Path::new(value);
    if !path.is_absolute() && !cwd.is_absolute() {
        return None;
    }
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    path.to_str()
        .filter(|path| path.len() <= 8192)
        .map(str::to_owned)
}
impl LaunchRequests {
    pub fn push(&self, path: String) {
        if let Ok(mut queue) = self.0.lock() {
            if queue.back() == Some(&path) {
                return;
            }
            if queue.len() == 8 {
                queue.pop_front();
            }
            queue.push_back(path);
        }
    }
    pub fn take(&self) -> Option<String> {
        self.0.lock().ok()?.pop_front()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_launch_is_literal_bounded_and_relative_to_the_callers_directory() {
        let root = std::env::current_dir().unwrap();
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            folder_argument(&args(&["app", "space 🌍"]), &root),
            Some(root.join("space 🌍").to_str().unwrap().into())
        );
        assert_eq!(
            folder_argument(&args(&["app", "--", "-folder"]), &root),
            Some(root.join("-folder").to_str().unwrap().into())
        );
        for values in [
            vec!["app"],
            vec!["app", "--flag"],
            vec!["app", "one", "two"],
            vec!["app", ""],
            vec!["app", "bad\0path"],
        ] {
            assert!(folder_argument(&args(&values), &root).is_none());
        }
        assert!(folder_argument(&vec!["app".into(), "x".repeat(8193)], &root).is_none());
    }
    #[test]
    fn launch_offers_are_consumed_once_and_never_replayed() {
        let requests = LaunchRequests::default();
        requests.push("one".into());
        requests.push("one".into());
        assert_eq!(requests.take().as_deref(), Some("one"));
        assert!(requests.take().is_none());
        for n in 0..100 {
            requests.push(n.to_string());
        }
        assert_eq!(requests.take().as_deref(), Some("92"));
        for _ in 0..7 {
            assert!(requests.take().is_some());
        }
        assert!(requests.take().is_none());
    }
}
