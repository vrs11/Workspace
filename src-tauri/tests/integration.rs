use agent_workspace::{dto::Response, storage::Storage, workspace::Workspace};
use std::{
    path::{Path, PathBuf},
    process::Command,
};
struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    git: PathBuf,
    storage: Storage,
    w: Workspace,
}
fn git_path() -> PathBuf {
    [
        "/usr/local/bin/git",
        "/usr/bin/git",
        "C:\\Program Files\\Git\\cmd\\git.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .expect("Installed Git required for integration tests")
}
fn run(exe: &Path, root: &Path, args: &[&str]) -> String {
    let o = Command::new(exe)
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .output()
        .unwrap();
    assert!(
        o.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8_lossy(&o.stdout).into()
}
impl Fixture {
    fn new() -> Self {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("project space 🌍");
        std::fs::create_dir(&root).unwrap();
        let git = git_path();
        run(&git, &root, &["init", "-b", "main"]);
        run(&git, &root, &["config", "user.name", "Fixture"]);
        run(
            &git,
            &root,
            &["config", "user.email", "fixture@example.invalid"],
        );
        run(&git, &root, &["config", "commit.gpgsign", "false"]);
        let storage = Storage::new(t.path().join("app")).unwrap();
        let mut w = Workspace::open(&root, &[]).unwrap();
        w.project.trusted = true;
        Self {
            _tmp: t,
            root,
            git,
            storage,
            w,
        }
    }
    fn write(&self, path: &str, text: &str) {
        std::fs::write(self.root.join(path), text).unwrap();
    }
    fn commit(&self) {
        run(&self.git, &self.root, &["add", "--all"]);
        run(&self.git, &self.root, &["commit", "-m", "base"]);
    }
}
#[test]
fn partial_stage_preserves_existing_index_and_working_edits() {
    let mut f = Fixture::new();
    let base = (0..40).map(|n| format!("line {n}\n")).collect::<String>();
    f.write("file", &base);
    f.write("other", "base\n");
    f.commit();
    f.write("other", "existing staged\n");
    run(&f.git, &f.root, &["add", "--", "other"]);
    let edited = base
        .replace("line 2\n", "first edit\n")
        .replace("line 30\n", "second edit\n");
    f.write("file", &edited);
    let id = f.w.register("file".into());
    let Response::Diff { diff } = f.w.git_diff(&f.git, &id, false).unwrap() else {
        panic!()
    };
    assert_eq!(diff.hunks.len(), 2);
    assert!(diff.hunk_unavailable.is_none());
    f.w.git_hunk(&f.git, &diff.id, 0, false).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        edited
    );
    let index = run(&f.git, &f.root, &["show", ":file"]);
    assert!(index.contains("first edit"));
    assert!(!index.contains("second edit"));
    assert_eq!(
        run(&f.git, &f.root, &["show", ":other"]),
        "existing staged\n"
    );
    assert!(f.w.git_hunk(&f.git, &diff.id, 0, false).is_err());
    let Response::Diff { diff } = f.w.git_diff(&f.git, &id, true).unwrap() else {
        panic!()
    };
    f.w.git_hunk(&f.git, &diff.id, 0, true).unwrap();
    assert_eq!(run(&f.git, &f.root, &["show", ":file"]), base);
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        edited
    );
}
#[test]
fn adversarial_names_literal_staging_and_unborn_unstage() {
    let mut f = Fixture::new();
    for name in ["-leading", ":(glob)*", "new\nline", "quote'\"", "你好"] {
        f.write(name, "data");
    }
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    assert_eq!(status.changes.len(), 5);
    let selected = status
        .changes
        .iter()
        .find(|c| c.path == ":(glob)*")
        .unwrap();
    f.w.git_stage(&f.git, &selected.entry, false).unwrap();
    let cached = run(&f.git, &f.root, &["diff", "--cached", "--name-only"]);
    assert_eq!(cached.trim(), ":(glob)*");
    f.w.git_stage(&f.git, &selected.entry, true).unwrap();
    assert!(run(&f.git, &f.root, &["diff", "--cached", "--name-only"]).is_empty());
}
#[test]
fn stale_commit_and_index_lock_fail_without_fallback() {
    let mut f = Fixture::new();
    f.write("a", "base");
    f.commit();
    f.write("a", "one");
    let id = f.w.register("a".into());
    f.w.git_stage(&f.git, &id, false).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    f.write("a", "two");
    f.w.git_stage(&f.git, &id, false).unwrap();
    assert!(
        f.w.git_commit(&f.git, "change", &status.staged_revision)
            .is_err()
    );
    std::fs::write(f.root.join(".git/index.lock"), b"external lock").unwrap();
    assert!(f.w.git_stage(&f.git, &id, false).is_err());
    assert_eq!(
        std::fs::read(f.root.join(".git/index.lock")).unwrap(),
        b"external lock"
    );
}
#[test]
fn gui_service_commit_and_push_to_disposable_bare_remote() {
    let mut f = Fixture::new();
    f.write("a", "base");
    f.commit();
    let remote = f._tmp.path().join("remote.git");
    run(
        &f.git,
        f._tmp.path(),
        &["init", "--bare", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["push", "--set-upstream", "origin", "main"],
    );
    let id = f.w.register("a".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    f.w.save(&id, "manual edit", 1, &document.baseline, &f.storage)
        .unwrap();
    f.w.git_stage(&f.git, &id, false).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    f.w.git_commit(&f.git, "manual GUI service change", &status.staged_revision)
        .unwrap();
    f.w.git_network(&f.git, "push").unwrap();
    assert_eq!(run(&f.git, &remote, &["show", "main:a"]), "manual edit");
}
#[cfg(unix)]
#[test]
fn failing_hook_is_not_bypassed() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("a", "base");
    f.commit();
    f.write("a", "changed");
    let id = f.w.register("a".into());
    f.w.git_stage(&f.git, &id, false).unwrap();
    let hook = f.root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, b"#!/bin/sh\necho hook-failed >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    assert!(
        f.w.git_commit(&f.git, "must fail", &status.staged_revision)
            .is_err()
    );
    assert_eq!(
        run(&f.git, &f.root, &["rev-list", "--count", "HEAD"]).trim(),
        "1"
    );
}
#[test]
fn worktree_and_sha256_status() {
    let f = Fixture::new();
    f.write("a", "base");
    f.commit();
    let linked = f._tmp.path().join("linked");
    run(
        &f.git,
        &f.root,
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );
    let mut w = Workspace::open(&linked, &[]).unwrap();
    w.project.trusted = true;
    let Response::GitStatus { status } = w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    assert_eq!(status.branch, "(detached)");
    let sha = f._tmp.path().join("sha256");
    std::fs::create_dir(&sha).unwrap();
    run(&f.git, &sha, &["init", "--object-format=sha256"]);
    let mut w = Workspace::open(&sha, &[]).unwrap();
    w.project.trusted = true;
    assert!(w.git_status(&f.git, None).is_ok());
}
#[test]
fn huge_preview_and_invalid_encoding_are_not_writable() {
    let mut f = Fixture::new();
    let large = std::fs::File::create(f.root.join("huge")).unwrap();
    large.set_len(3 * 1024 * 1024 * 1024).unwrap();
    let id = f.w.register("huge".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(document.readonly.is_some());
    assert!(document.text.len() < 256 * 1024);
    assert!(
        f.w.save(&id, "oops", 1, &document.baseline, &f.storage)
            .is_err()
    );
    std::fs::write(f.root.join("invalid"), [0xff, 0x12]).unwrap();
    let id = f.w.register("invalid".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(document.readonly.is_some());
}
#[cfg(unix)]
#[test]
fn symlink_swap_and_hardlinks_are_refused() {
    let mut f = Fixture::new();
    f.write("a", "original");
    let id = f.w.register("a".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    let outside = f._tmp.path().join("outside");
    std::fs::write(&outside, "outside").unwrap();
    std::fs::remove_file(f.root.join("a")).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("a")).unwrap();
    assert!(
        f.w.save(&id, "evil", 1, &document.baseline, &f.storage)
            .is_err()
    );
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "outside");
    f.write("hard", "original");
    std::fs::hard_link(f.root.join("hard"), f.root.join("second")).unwrap();
    let id = f.w.register("hard".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(document.readonly.unwrap().contains("Hard-linked"));
}
#[test]
fn acknowledged_recovery_survives_workspace_recreation() {
    let mut f = Fixture::new();
    f.write("a", "disk");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "unsaved", 7, &f.storage).unwrap();
    drop(f.w);
    let mut w = Workspace::open(&f.root, &[]).unwrap();
    let id = w.register("a".into());
    let Response::Document { document } = w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.recovery.as_deref(), Some("unsaved"));
    assert_eq!(document.revision, 7);
    assert_eq!(std::fs::read_to_string(f.root.join("a")).unwrap(), "disk");
}
#[test]
fn project_replace_requires_selected_reviewed_revisions_and_keeps_other_files() {
    let mut f = Fixture::new();
    f.write("a.txt", "match match\r\n");
    f.write("b.txt", "match\n");
    let a = f.w.register("a.txt".into());
    let b = f.w.register("b.txt".into());
    let Response::Replacement {
        id,
        files,
        occurrences,
    } =
        f.w.replace_preview(
            vec![a.clone(), b.clone()],
            "match",
            "changed",
            false,
            &f.storage,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(occurrences, 3);
    assert_eq!(files.len(), 2);
    f.w.replace_apply(&id, vec![a.clone()], &f.storage).unwrap();
    assert_eq!(
        std::fs::read(f.root.join("a.txt")).unwrap(),
        b"changed changed\r\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "match\n"
    );
    let Response::Replacement { id, .. } =
        f.w.replace_preview(
            vec![a.clone(), b.clone()],
            "match",
            "bad",
            false,
            &f.storage,
        )
        .unwrap()
    else {
        panic!()
    };
    f.write("b.txt", "external");
    assert!(f.w.replace_apply(&id, vec![b.clone()], &f.storage).is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("b.txt")).unwrap(),
        "external"
    );
    assert!(
        !f.w.documents.contains_key(&a),
        "Preview/apply must not leave hidden open documents"
    );
    f.w.document_open(&a, &f.storage).unwrap();
    f.w.checkpoint(&a, "unsaved", 2, &f.storage).unwrap();
    assert!(
        f.w.replace_preview(vec![a], "changed", "bad", false, &f.storage)
            .is_err()
    );
}
#[test]
fn renderer_reload_reads_the_acknowledged_current_dirty_buffer() {
    let mut f = Fixture::new();
    f.write("a", "disk");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "unsaved", 8, &f.storage).unwrap();
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.recovery.as_deref(), Some("unsaved"));
    assert_eq!(document.revision, 8);
}
#[cfg(target_os = "macos")]
#[test]
fn macos_acl_is_never_silently_removed_by_save() {
    let mut f = Fixture::new();
    f.write("acl", "secret");
    let output = Command::new("/bin/chmod")
        .args(["+a", "everyone deny delete"])
        .arg(f.root.join("acl"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let id = f.w.register("acl".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(document.readonly.is_some());
    assert!(
        f.w.save(&id, "changed", 1, &document.baseline, &f.storage)
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("acl")).unwrap(),
        "secret"
    );
    let output = Command::new("/bin/chmod")
        .arg("-N")
        .arg(f.root.join("acl"))
        .output()
        .unwrap();
    assert!(output.status.success());
}
#[test]
fn legacy_settings_migrate_without_ai_fields_or_loss_of_unrelated_preferences() {
    let t = tempfile::tempdir().unwrap();
    let storage = Storage::new(t.path().into()).unwrap();
    storage.write("settings.json",&serde_json::json!({"version":1,"git":null,"codex":"/legacy/tool","theme":"light","fontSize":19,"recent":[]})).unwrap();
    let settings = agent_workspace::workspace::load_settings(&storage).unwrap();
    assert_eq!(settings.version, 2);
    assert_eq!(settings.font_size, 19);
    assert_eq!(settings.theme, "light");
    assert_eq!(settings.terminal_scrollback, 5000);
    assert!(settings.auto_save_idle);
    assert!(settings.auto_save_on_focus_loss);
    assert_eq!(settings.auto_save_delay, 15);
    let raw = std::fs::read_to_string(t.path().join("settings.json")).unwrap();
    assert!(!raw.contains("codex"));
    assert!(t.path().join("settings.bak").exists());
}
#[test]
fn recoverable_delete_restores_bytes_without_overwriting_new_work() {
    let mut f = Fixture::new();
    f.write("deleted.txt", "retained bytes");
    let id = f.w.register("deleted.txt".into());
    f.w.delete_entry(&id, &f.storage).unwrap();
    assert!(!f.root.join("deleted.txt").exists());
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&f.w.project.id, &f.storage).unwrap()
    else {
        panic!()
    };
    assert_eq!(items.len(), 1);
    f.write("deleted.txt", "new work");
    assert!(f.w.trash_restore(&items[0].id, &f.storage).is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("deleted.txt")).unwrap(),
        "new work"
    );
    std::fs::remove_file(f.root.join("deleted.txt")).unwrap();
    f.w.trash_restore(&items[0].id, &f.storage).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("deleted.txt")).unwrap(),
        "retained bytes"
    );
}
#[test]
fn nonempty_folder_delete_and_restore_preserve_the_whole_tree() {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = Fixture::new();
    let folder = "folder space 🌍";
    std::fs::create_dir_all(f.root.join(folder).join("nested/empty")).unwrap();
    std::fs::write(f.root.join(folder).join("nested/binary"), [0, 255, 128, 10]).unwrap();
    std::fs::write(f.root.join(folder).join(".hidden"), "keep hidden").unwrap();
    let mut large = std::fs::File::create(f.root.join(folder).join("large.bin")).unwrap();
    large.set_len(24 * 1024 * 1024).unwrap();
    large.seek(SeekFrom::End(-4)).unwrap();
    large.write_all(b"tail").unwrap();
    drop(large);
    let root_id = f.w.register(folder.into());
    let child = f.w.register(Path::new(folder).join("nested/binary"));
    let outside = f.w.register("unrelated".into());
    f.w.delete_entry(&root_id, &f.storage).unwrap();
    assert!(!f.root.join(folder).exists());
    assert!(f.w.entry(&root_id).is_err() && f.w.entry(&child).is_err());
    assert!(f.w.entry(&outside).is_ok());
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&f.w.project.id, &f.storage).unwrap()
    else {
        panic!("Expected recovery list")
    };
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].label, folder);
    assert!(items[0].detail.contains("folder"));
    let mut reopened = Workspace::open(&f.root, &[]).unwrap();
    reopened.project.trusted = true;
    reopened.trash_restore(&items[0].id, &f.storage).unwrap();
    assert_eq!(
        std::fs::read(f.root.join(folder).join("nested/binary")).unwrap(),
        [0, 255, 128, 10]
    );
    assert!(f.root.join(folder).join("nested/empty").is_dir());
    assert_eq!(
        std::fs::read_to_string(f.root.join(folder).join(".hidden")).unwrap(),
        "keep hidden"
    );
    assert_eq!(
        std::fs::metadata(f.root.join(folder).join("large.bin"))
            .unwrap()
            .len(),
        24 * 1024 * 1024
    );
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&reopened.project.id, &f.storage).unwrap()
    else {
        panic!()
    };
    assert!(
        items.is_empty(),
        "Restored folder must not remain as a ghost recovery choice"
    );
}
#[cfg(unix)]
#[test]
fn folder_recovery_preserves_links_permissions_and_extended_metadata() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let mut f = Fixture::new();
    std::fs::create_dir(f.root.join("tree")).unwrap();
    std::fs::create_dir(f.root.join("tree/unreadable-child")).unwrap();
    std::fs::set_permissions(
        f.root.join("tree/unreadable-child"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    std::fs::write(f.root.join("tree/executable"), "keep").unwrap();
    std::fs::set_permissions(
        f.root.join("tree/executable"),
        std::fs::Permissions::from_mode(0o751),
    )
    .unwrap();
    std::fs::hard_link(
        f.root.join("tree/executable"),
        f.root.join("tree/hard-link"),
    )
    .unwrap();
    let outside = f._tmp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("untouched"), "outside bytes").unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("tree/outside-link")).unwrap();
    xattr::set(
        f.root.join("tree/executable"),
        "user.workspace-test",
        b"metadata",
    )
    .unwrap();
    let original = std::fs::metadata(f.root.join("tree/executable")).unwrap();
    let root_inode = std::fs::metadata(f.root.join("tree")).unwrap().ino();
    let id = f.w.register("tree".into());
    f.w.delete_entry(&id, &f.storage).unwrap();
    assert_eq!(
        std::fs::read_to_string(outside.join("untouched")).unwrap(),
        "outside bytes"
    );
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&f.w.project.id, &f.storage).unwrap()
    else {
        panic!()
    };
    f.w.trash_restore(&items[0].id, &f.storage).unwrap();
    let restored = std::fs::metadata(f.root.join("tree/executable")).unwrap();
    assert_eq!(
        std::fs::metadata(f.root.join("tree/unreadable-child"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o000
    );
    std::fs::set_permissions(
        f.root.join("tree/unreadable-child"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert_eq!(restored.ino(), original.ino());
    assert_eq!(
        std::fs::metadata(f.root.join("tree")).unwrap().ino(),
        root_inode
    );
    assert_eq!(restored.permissions().mode() & 0o777, 0o751);
    assert_eq!(
        std::fs::metadata(f.root.join("tree/hard-link"))
            .unwrap()
            .ino(),
        restored.ino()
    );
    assert_eq!(
        xattr::get(f.root.join("tree/executable"), "user.workspace-test")
            .unwrap()
            .unwrap(),
        b"metadata"
    );
    assert_eq!(
        std::fs::read_link(f.root.join("tree/outside-link")).unwrap(),
        outside
    );
}
#[test]
fn folder_restore_refuses_existing_destinations_and_other_project_scopes() {
    let mut f = Fixture::new();
    std::fs::create_dir_all(f.root.join("tree/child")).unwrap();
    f.write("tree/child/file", "original");
    let id = f.w.register("tree".into());
    f.w.delete_entry(&id, &f.storage).unwrap();
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&f.w.project.id, &f.storage).unwrap()
    else {
        panic!()
    };
    std::fs::create_dir(f.root.join("tree")).unwrap();
    f.write("tree/new", "new work");
    assert!(f.w.trash_restore(&items[0].id, &f.storage).is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("tree/new")).unwrap(),
        "new work"
    );
    let other_root = f._tmp.path().join("other");
    std::fs::create_dir(&other_root).unwrap();
    let mut other = Workspace::open(&other_root, &[]).unwrap();
    assert!(other.trash_restore(&items[0].id, &f.storage).is_err());
    std::fs::remove_file(f.root.join("tree/new")).unwrap();
    std::fs::remove_dir(f.root.join("tree")).unwrap();
    f.w.trash_restore(&items[0].id, &f.storage).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("tree/child/file")).unwrap(),
        "original"
    );
}
#[test]
fn folder_delete_refuses_open_descendants_and_failed_recovery_without_touching_contents() {
    let mut f = Fixture::new();
    std::fs::create_dir(f.root.join("tree")).unwrap();
    f.write("tree/file", "keep");
    let folder = f.w.register("tree".into());
    let file = f.w.register("tree/file".into());
    f.w.document_open(&file, &f.storage).unwrap();
    assert_eq!(
        f.w.delete_entry(&folder, &f.storage).unwrap_err().code,
        "conflict"
    );
    f.w.documents.clear();
    let bad_path = f._tmp.path().join("not-a-directory");
    std::fs::write(&bad_path, "keep recovery marker").unwrap();
    let bad_storage = Storage { root: bad_path };
    assert!(f.w.delete_entry(&folder, &bad_storage).is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("tree/file")).unwrap(),
        "keep"
    );
    let inside = Storage::new(f.root.join("tree/private-recovery")).unwrap();
    assert_eq!(
        f.w.delete_entry(&folder, &inside).unwrap_err().code,
        "unsafePath"
    );
    assert!(f.root.join("tree/file").exists());
    let root = f.w.register(PathBuf::new());
    assert!(f.w.delete_entry(&root, &f.storage).is_err());
}
#[cfg(unix)]
#[test]
fn folder_delete_and_restore_do_not_traverse_symlink_parents_or_trusted_recovery_paths() {
    let mut f = Fixture::new();
    let outside = f._tmp.path().join("outside-tree");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("keep"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("link")).unwrap();
    let unsafe_id = f.w.register("link/keep".into());
    assert!(f.w.delete_entry(&unsafe_id, &f.storage).is_err());
    std::fs::create_dir(f.root.join("tree")).unwrap();
    f.write("tree/file", "inside");
    let id = f.w.register("tree".into());
    f.w.delete_entry(&id, &f.storage).unwrap();
    let Response::Items { items, .. } =
        agent_workspace::files::trash_list(&f.w.project.id, &f.storage).unwrap()
    else {
        panic!()
    };
    let meta_path = f.storage.root.join(format!("trash-{}.json", items[0].id));
    let mut meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
    let original = meta["path"].clone();
    meta["path"] = agent_workspace::documents::path_token(Path::new("link/escape")).into();
    std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    assert!(f.w.trash_restore(&items[0].id, &f.storage).is_err());
    assert!(!outside.join("escape").exists());
    assert_eq!(
        std::fs::read_to_string(outside.join("keep")).unwrap(),
        "outside"
    );
    meta["path"] = original;
    std::fs::write(&meta_path, serde_json::to_vec(&meta).unwrap()).unwrap();
    f.w.trash_restore(&items[0].id, &f.storage).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("tree/file")).unwrap(),
        "inside"
    );
}
#[test]
fn native_search_handles_ignore_rules_binary_files_and_cancellation() {
    use std::sync::{Arc, atomic::AtomicU32};
    let mut f = Fixture::new();
    f.write(".gitignore", "ignored.txt\n");
    f.write("found.txt", "needle\n");
    f.write("ignored.txt", "needle\n");
    std::fs::write(f.root.join("binary"), [0xff, 0x00]).unwrap();
    let generation = Arc::new(AtomicU32::new(4));
    let Response::Search { matches, .. } = agent_workspace::search::search(
        &mut f.w,
        "needle",
        false,
        false,
        false,
        4,
        generation.clone(),
        None,
    )
    .unwrap() else {
        panic!()
    };
    assert!(matches.iter().any(|m| m.path == "found.txt"));
    assert!(!matches.iter().any(|m| m.path == "ignored.txt"));
    let Response::Search { matches, .. } = agent_workspace::search::search(
        &mut f.w,
        "needle",
        false,
        true,
        false,
        4,
        generation.clone(),
        None,
    )
    .unwrap() else {
        panic!()
    };
    assert!(matches.iter().any(|m| m.path == "ignored.txt"));
    assert_eq!(
        agent_workspace::search::search(
            &mut f.w, "needle", false, false, false, 3, generation, None
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
}
#[test]
fn checkpoint_revisions_do_not_reset_after_undo_or_renderer_reload() {
    let mut f = Fixture::new();
    f.write("a", "disk");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "unsaved", 8, &f.storage).unwrap();
    assert!(f.w.checkpoint(&id, "different", 8, &f.storage).is_err());
    f.w.checkpoint(&id, "disk", 9, &f.storage).unwrap();
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.revision, 9);
    assert_eq!(document.recovery, None);
    assert!(f.w.checkpoint(&id, "stale", 8, &f.storage).is_err());
    f.w.checkpoint(&id, "current", 10, &f.storage).unwrap();
}
#[test]
fn graphical_conflict_stages_are_exact_and_resolution_checks_reviewed_index() {
    let mut f = Fixture::new();
    f.write("conflict.txt", "base\n");
    run(&f.git, &f.root, &["add", "conflict.txt"]);
    run(&f.git, &f.root, &["commit", "-m", "base"]);
    run(&f.git, &f.root, &["checkout", "-b", "incoming"]);
    f.write("conflict.txt", "incoming\n");
    run(&f.git, &f.root, &["commit", "-am", "incoming"]);
    run(&f.git, &f.root, &["checkout", "main"]);
    f.write("conflict.txt", "current\n");
    run(&f.git, &f.root, &["commit", "-am", "current"]);
    assert!(
        !Command::new(&f.git)
            .current_dir(&f.root)
            .args(["merge", "incoming"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let id = f.w.register("conflict.txt".into());
    let Response::GitConflict { conflict } = f.w.git_conflict(&f.git, &id).unwrap() else {
        panic!()
    };
    assert_eq!(conflict.base, "base\n");
    assert_eq!(conflict.current, "current\n");
    assert_eq!(conflict.incoming, "incoming\n");
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    f.w.save(&id, "reviewed result\n", 1, &document.baseline, &f.storage)
        .unwrap();
    assert!(f.w.git_resolve(&f.git, &id, "stale").is_err());
    f.w.git_resolve(&f.git, &id, &conflict.reviewed).unwrap();
    assert_eq!(
        run(&f.git, &f.root, &["show", ":conflict.txt"]),
        "reviewed result\n"
    );
    assert!(run(&f.git, &f.root, &["ls-files", "-u"]).is_empty());
}
#[test]
fn history_compares_root_commit_and_deleted_file_without_touching_worktree() {
    let mut f = Fixture::new();
    f.write("history.txt", "historical\n");
    run(&f.git, &f.root, &["add", "history.txt"]);
    run(&f.git, &f.root, &["commit", "-m", "root"]);
    let first = run(&f.git, &f.root, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let Response::Entries { entries, .. } = f.w.git_revision_files(&f.git, &first).unwrap() else {
        panic!()
    };
    let file = entries.iter().find(|e| e.path == "history.txt").unwrap();
    let Response::Diff { diff } = f.w.git_revision_diff(&f.git, &first, &file.id).unwrap() else {
        panic!()
    };
    assert_eq!(diff.base, "");
    assert_eq!(diff.next, "historical\n");
    std::fs::remove_file(f.root.join("history.txt")).unwrap();
    run(&f.git, &f.root, &["commit", "-am", "deleted"]);
    let next = run(&f.git, &f.root, &["rev-parse", "HEAD"])
        .trim()
        .to_string();
    let Response::Diff { diff } = f.w.git_revision_diff(&f.git, &next, &file.id).unwrap() else {
        panic!()
    };
    assert_eq!(diff.base, "historical\n");
    assert_eq!(diff.next, "");
    assert!(!f.root.join("history.txt").exists());
}
#[test]
fn recovery_quota_retains_last_acknowledged_text_and_allows_retry_after_freeing_space() {
    let mut f = Fixture::new();
    f.write("a", "disk");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "acknowledged", 1, &f.storage).unwrap();
    let reserved = f.storage.root.join("recovery-retained.bak");
    std::fs::File::create(&reserved)
        .unwrap()
        .set_len(256 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        f.w.checkpoint(&id, "new unacknowledged", 2, &f.storage)
            .unwrap_err()
            .code,
        "recoveryQuota"
    );
    let r = f
        .storage
        .read::<agent_workspace::documents::Recovery>(&format!("recovery-{id}.json"))
        .unwrap()
        .unwrap();
    assert_eq!(r.text, "acknowledged");
    assert_eq!(r.revision, 1);
    f.w.checkpoint(&id, "acknowledged", 1, &f.storage).unwrap();
    std::fs::remove_file(reserved).unwrap();
    f.w.checkpoint(&id, "new unacknowledged", 2, &f.storage)
        .unwrap();
}
#[test]
fn case_only_rename_changes_the_native_name_without_overwriting_another_file() {
    let mut f = Fixture::new();
    f.write("Case.txt", "bytes");
    let id = f.w.register("Case.txt".into());
    f.w.rename_entry(&id, None, "case.txt").unwrap();
    assert!(
        std::fs::read_dir(&f.root)
            .unwrap()
            .any(|e| e.unwrap().file_name() == "case.txt")
    );
    f.write("other.txt", "other");
    let id = f.w.register("case.txt".into());
    assert!(f.w.rename_entry(&id, None, "other.txt").is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("other.txt")).unwrap(),
        "other"
    );
}
#[test]
fn typed_edits_during_clean_refresh_keep_the_original_baseline_and_recovery() {
    let mut f = Fixture::new();
    f.write("a", "original");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    let old = f.w.documents[&id].dto.baseline.clone();
    f.write("a", "external");
    let Response::Reconciled {
        document,
        refresh: Some(refresh),
    } = f.w.reconcile_document(&id, &f.storage).unwrap()
    else {
        panic!()
    };
    assert_eq!(document.text, "external");
    f.w.finish_reconcile(&refresh, false).unwrap();
    assert_eq!(f.w.documents[&id].dto.baseline, old);
    f.w.checkpoint(&id, "typed during refresh", 1, &f.storage)
        .unwrap();
    let r = f
        .storage
        .read::<agent_workspace::documents::Recovery>(&format!("recovery-{id}.json"))
        .unwrap()
        .unwrap();
    assert_eq!(r.baseline_text, "original");
    assert_eq!(r.text, "typed during refresh");
    assert_eq!(
        std::fs::read_to_string(f.root.join("a")).unwrap(),
        "external"
    );
    assert!(!f.w.refreshes.contains_key(&refresh));
}
#[test]
fn refresh_rejection_cannot_overwrite_newer_acknowledged_work() {
    let mut f = Fixture::new();
    f.write("a", "original");
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.write("a", "external");
    let Response::Reconciled {
        refresh: Some(refresh),
        ..
    } = f.w.reconcile_document(&id, &f.storage).unwrap()
    else {
        panic!()
    };
    f.w.checkpoint(&id, "newer acknowledged work", 1, &f.storage)
        .unwrap();
    assert!(f.w.finish_reconcile(&refresh, false).is_err());
    assert!(f.w.documents[&id].dirty);
    let r = f
        .storage
        .read::<agent_workspace::documents::Recovery>(&format!("recovery-{id}.json"))
        .unwrap()
        .unwrap();
    assert_eq!(r.text, "newer acknowledged work");
}

#[test]
fn deleted_original_still_opens_acknowledged_recovery_after_host_restart() {
    let mut f = Fixture::new();
    std::fs::write(f.root.join("missing.txt"), "baseline").unwrap();
    let id = f.w.register("missing.txt".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "private unsaved 🌍\n", 1, &f.storage)
        .unwrap();
    std::fs::remove_file(f.root.join("missing.txt")).unwrap();
    let mut reopened = Workspace::open(&f.root, &[]).unwrap();
    let restored_id = reopened.register("missing.txt".into());
    assert_eq!(restored_id, id);
    let Response::Document { document } = reopened.document_open(&id, &f.storage).unwrap() else {
        panic!("recovery")
    };
    assert_eq!(document.recovery.as_deref(), Some("private unsaved 🌍\n"));
    assert!(document.readonly.unwrap().starts_with("Recovery preview"));
    assert!(!f.root.join("missing.txt").exists());
    assert!(f.storage.root.join(format!("recovery-{id}.json")).exists());
}

#[test]
fn plain_folder_restricted_and_replaced_project_cannot_mutate() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plain 🌍 folder");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a"), "original").unwrap();
    let storage = Storage::new(temp.path().join("private")).unwrap();
    let mut w = Workspace::open(&root, &[]).unwrap();
    let id = w.register("a".into());
    let Response::Document { document } = w.document_open(&id, &storage).unwrap() else {
        panic!()
    };
    assert!(
        w.save(&id, "restricted", 1, &document.baseline, &storage)
            .is_err()
    );
    assert!(w.git_status(&git_path(), None).is_err());
    w.project.trusted = true;
    w.save(&id, "saved without Git", 1, &document.baseline, &storage)
        .unwrap();
    let Response::Document { document } = w.document_open(&id, &storage).unwrap() else {
        panic!()
    };
    w.checkpoint(&id, "acknowledged", 2, &storage).unwrap();
    let old = temp.path().join("renamed original");
    std::fs::rename(&root, &old).unwrap();
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a"), "replacement project").unwrap();
    assert!(
        w.save(&id, "must not redirect", 2, &document.baseline, &storage)
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(root.join("a")).unwrap(),
        "replacement project"
    );
    assert_eq!(
        std::fs::read_to_string(old.join("a")).unwrap(),
        "saved without Git"
    );
    assert!(
        storage
            .read::<serde_json::Value>(&format!("recovery-{id}.json"))
            .unwrap()
            .is_some()
    );
}

#[test]
fn missing_identity_and_signing_failure_preserve_reviewed_index_and_head() {
    let mut f = Fixture::new();
    f.write("a", "base");
    f.commit();
    let head = run(&f.git, &f.root, &["rev-parse", "HEAD"]);
    f.write("a", "reviewed change");
    let id = f.w.register("a".into());
    f.w.git_stage(&f.git, &id, false).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    run(&f.git, &f.root, &["config", "user.name", ""]);
    assert!(
        f.w.git_commit(&f.git, "missing identity", &status.staged_revision)
            .is_err()
    );
    run(&f.git, &f.root, &["config", "user.name", "Fixture"]);
    run(&f.git, &f.root, &["config", "commit.gpgsign", "true"]);
    let absent = f._tmp.path().join("signer-that-does-not-exist");
    run(
        &f.git,
        &f.root,
        &["config", "gpg.program", absent.to_str().unwrap()],
    );
    assert!(
        f.w.git_commit(&f.git, "signing must fail", &status.staged_revision)
            .is_err()
    );
    assert_eq!(run(&f.git, &f.root, &["rev-parse", "HEAD"]), head);
    assert_eq!(run(&f.git, &f.root, &["show", ":a"]), "reviewed change");
    let Response::GitStatus { status: after } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    assert_eq!(after.staged_revision, status.staged_revision);
}

#[test]
fn rejected_push_and_divergent_pull_never_force_or_merge() {
    let mut f = Fixture::new();
    f.write("a", "base");
    f.commit();
    let initial = run(&f.git, &f.root, &["rev-parse", "HEAD"]);
    assert!(f.w.git_network(&f.git, "push").is_err()); // No upstream.
    let remote = f._tmp.path().join("remote.git");
    run(
        &f.git,
        f._tmp.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["push", "--set-upstream", "origin", "main"],
    );
    let peer = f._tmp.path().join("peer");
    run(
        &f.git,
        f._tmp.path(),
        &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
    );
    run(&f.git, &peer, &["config", "user.name", "Peer Fixture"]);
    run(
        &f.git,
        &peer,
        &["config", "user.email", "peer@example.invalid"],
    );
    run(&f.git, &peer, &["config", "commit.gpgsign", "false"]);
    std::fs::write(peer.join("peer"), "remote change").unwrap();
    run(&f.git, &peer, &["add", "peer"]);
    run(&f.git, &peer, &["commit", "-m", "remote advances"]);
    run(&f.git, &peer, &["push"]);
    let remote_head = run(&f.git, &remote, &["rev-parse", "main"]);
    f.write("a", "local diverges");
    f.commit();
    let local_head = run(&f.git, &f.root, &["rev-parse", "HEAD"]);
    assert_ne!(initial, local_head);
    let index = run(&f.git, &f.root, &["write-tree"]);
    assert!(f.w.git_network(&f.git, "push").is_err());
    assert!(f.w.git_network(&f.git, "pull").is_err());
    assert_eq!(run(&f.git, &f.root, &["rev-parse", "HEAD"]), local_head);
    assert_eq!(run(&f.git, &remote, &["rev-parse", "main"]), remote_head);
    assert_eq!(run(&f.git, &f.root, &["write-tree"]), index);
    assert_eq!(
        std::fs::read_to_string(f.root.join("a")).unwrap(),
        "local diverges"
    );
    assert!(!f.root.join(".git/MERGE_HEAD").exists());
}

#[cfg(unix)]
#[test]
fn unwritable_parent_keeps_original_and_acknowledged_checkpoint() {
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(
        unsafe { libc::geteuid() },
        0,
        "Permission fixture requires an unprivileged test user"
    );
    let mut f = Fixture::new();
    std::fs::create_dir(f.root.join("locked")).unwrap();
    f.write("locked/a", "original");
    let id = f.w.register("locked/a".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    f.w.checkpoint(&id, "acknowledged", 1, &f.storage).unwrap();
    std::fs::set_permissions(
        f.root.join("locked"),
        std::fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    let result =
        f.w.save(&id, "acknowledged", 1, &document.baseline, &f.storage);
    std::fs::set_permissions(
        f.root.join("locked"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("locked/a")).unwrap(),
        "original"
    );
    drop(f.w);
    let mut w = Workspace::open(&f.root, &[]).unwrap();
    let id = w.register("locked/a".into());
    let Response::Document { document } = w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.recovery.as_deref(), Some("acknowledged"));
}

#[test]
fn verified_project_relocation_keeps_scope_recovery_and_layout_through_restart() {
    let mut f = Fixture::new();
    f.write("a", "disk original");
    let previous = f.w.project.clone();
    let id = f.w.register("a".into());
    f.w.document_open(&id, &f.storage).unwrap();
    f.w.checkpoint(&id, "acknowledged before move", 9, &f.storage)
        .unwrap();
    let recovery = std::fs::read(f.storage.root.join(format!("recovery-{id}.json"))).unwrap();
    let ui = serde_json::json!({"version":1,"tabs":[agent_workspace::documents::path_token(Path::new("a"))],"active":null,"split":null,"layout":[22,78,68,32]});
    f.storage
        .write(&format!("ui-{}.json", previous.id), &ui)
        .unwrap();
    let moved = f._tmp.path().join("renamed project 🌍");
    std::fs::rename(&f.root, &moved).unwrap();
    assert!(f.w.authorize(&previous.id, true, true).is_err());
    let mut relocated = Workspace::relocated(&moved, &previous).unwrap();
    assert_eq!(relocated.project.id, previous.id);
    assert_eq!(relocated.register("a".into()), id);
    relocated.authorize(&previous.id, true, true).unwrap();
    let Response::Document { document } = relocated.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(
        document.recovery.as_deref(),
        Some("acknowledged before move")
    );
    assert_eq!(
        std::fs::read(f.storage.root.join(format!("recovery-{id}.json"))).unwrap(),
        recovery
    );
    assert_eq!(
        f.storage
            .read::<serde_json::Value>(&format!("ui-{}.json", previous.id))
            .unwrap()
            .unwrap(),
        ui
    );
    let mut settings = agent_workspace::workspace::default_settings();
    settings.recent = vec![relocated.project.clone()];
    f.storage.write("settings.json", &settings).unwrap();
    let loaded = agent_workspace::workspace::load_settings(&f.storage).unwrap();
    let mut reopened = Workspace::open(&moved, &loaded.recent).unwrap();
    assert_eq!(reopened.project.id, previous.id);
    assert!(reopened.project.trusted);
    let id = reopened.register("a".into());
    let Response::Document { document } = reopened.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    reopened
        .save(
            &id,
            "acknowledged before move",
            9,
            &document.baseline,
            &f.storage,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(moved.join("a")).unwrap(),
        "acknowledged before move"
    );
    let second = f._tmp.path().join("moved again");
    std::fs::rename(&moved, &second).unwrap();
    let again = Workspace::relocated(&second, &reopened.project).unwrap();
    assert_eq!(again.project.id, previous.id);
    assert_eq!(
        again.project.identity_root.as_deref(),
        Some(previous.root.as_str())
    );
}

#[test]
fn unrelated_same_name_folder_cannot_inherit_relocation_state_or_trust() {
    let f = Fixture::new();
    let previous = f.w.project.clone();
    let parent = f._tmp.path().join("different parent");
    std::fs::create_dir(&parent).unwrap();
    let unrelated = parent.join(f.root.file_name().unwrap());
    std::fs::create_dir(&unrelated).unwrap();
    assert!(Workspace::relocated(&unrelated, &previous).is_err());
    let opened = Workspace::open(&unrelated, &[previous]).unwrap();
    assert!(!opened.project.trusted);
    assert_ne!(opened.project.id, f.w.project.id);
}

#[test]
fn native_drag_moves_are_exclusive_and_refuse_self_or_descendant_destinations() {
    let mut f = Fixture::new();
    f.write("a", "source bytes");
    std::fs::create_dir_all(f.root.join("destination/child")).unwrap();
    f.write("destination/a", "existing bytes");
    let source = f.w.register("a".into());
    let destination = f.w.register("destination".into());
    assert!(f.w.move_entry(&source, Some(&destination)).is_err());
    assert_eq!(
        std::fs::read_to_string(f.root.join("a")).unwrap(),
        "source bytes"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("destination/a")).unwrap(),
        "existing bytes"
    );
    let child = f.w.register("destination/child".into());
    assert!(f.w.move_entry(&destination, Some(&child)).is_err());
    assert!(f.w.move_entry(&destination, Some(&destination)).is_err());
    f.w.move_entry(&source, Some(&child)).unwrap();
    assert!(!f.root.join("a").exists());
    assert_eq!(
        std::fs::read_to_string(f.root.join("destination/child/a")).unwrap(),
        "source bytes"
    );
}

#[cfg(unix)]
#[test]
fn native_drag_move_preserves_native_file_name_bytes_and_executable_mode() {
    use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
    let mut f = Fixture::new();
    // macOS's mounted filesystem rejects this byte sequence at creation. Linux
    // runs the raw-byte case; macOS exercises a native non-ASCII name instead.
    let name = if cfg!(target_os = "macos") {
        std::ffi::OsString::from("name-🌍")
    } else {
        std::ffi::OsString::from_vec(b"name-\xff".to_vec())
    };
    std::fs::write(f.root.join(&name), b"exact bytes").unwrap();
    std::fs::set_permissions(f.root.join(&name), std::fs::Permissions::from_mode(0o751)).unwrap();
    std::fs::create_dir(f.root.join("target")).unwrap();
    let id = f.w.register(PathBuf::from(&name));
    let target = f.w.register("target".into());
    f.w.move_entry(&id, Some(&target)).unwrap();
    let moved = f.root.join("target").join(&name);
    assert_eq!(std::fs::read(&moved).unwrap(), b"exact bytes");
    assert_eq!(
        std::fs::metadata(moved).unwrap().permissions().mode() & 0o777,
        0o751
    );
    assert!(!f.root.join(name).exists());
}

#[test]
fn file_action_conflicts_identify_the_name_and_preserve_existing_bytes() {
    let mut f = Fixture::new();
    f.write("existing.ts", "keep existing");
    let error = f.w.create(None, "existing.ts", false).unwrap_err();
    assert_eq!(error.code, "alreadyExists");
    assert!(error.message.contains("existing.ts"));
    assert!(error.message.contains("Choose a different"));
    assert_eq!(
        std::fs::read_to_string(f.root.join("existing.ts")).unwrap(),
        "keep existing"
    );
    std::fs::create_dir(f.root.join("folder")).unwrap();
    let error = f.w.create(None, "folder", true).unwrap_err();
    assert_eq!(error.code, "alreadyExists");
    assert!(error.message.contains("folder"));
    f.write("source.ts", "keep source");
    let id = f.w.register("source.ts".into());
    let error = f.w.rename_entry(&id, None, "existing.ts").unwrap_err();
    assert_eq!(error.code, "alreadyExists");
    assert!(error.message.contains("existing.ts"));
    assert_eq!(
        std::fs::read_to_string(f.root.join("source.ts")).unwrap(),
        "keep source"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("existing.ts")).unwrap(),
        "keep existing"
    );
}

#[test]
fn regex_project_and_filename_search_and_capture_replacement_use_real_files() {
    use std::sync::{Arc, atomic::AtomicU32};
    let mut f = Fixture::new();
    f.write("found.txt", "item12\r\nitem3\r\nno match\r\n");
    f.write("other.txt", "other\n");
    let generation = Arc::new(AtomicU32::new(1));
    let Response::Search { matches, .. } = agent_workspace::search::search(
        &mut f.w,
        r"^item\d+$",
        false,
        false,
        true,
        1,
        generation.clone(),
        None,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0].line, 1);
    let entry = matches[0].entry.clone();
    let Response::Search { matches, .. } = agent_workspace::search::search(
        &mut f.w,
        r"^found\.txt$",
        true,
        false,
        true,
        1,
        generation.clone(),
        None,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "found.txt");
    assert_eq!(
        agent_workspace::search::search(&mut f.w, "[", false, false, true, 1, generation, None)
            .unwrap_err()
            .code,
        "input"
    );
    let original = std::fs::read(f.root.join("found.txt")).unwrap();
    assert!(
        f.w.replace_preview(vec![entry.clone()], "[", "oops", true, &f.storage)
            .is_err()
    );
    assert_eq!(std::fs::read(f.root.join("found.txt")).unwrap(), original);
    let Response::Replacement {
        id,
        files,
        occurrences,
    } =
        f.w.replace_preview(
            vec![entry.clone()],
            r"item(?P<number>\d+)",
            "value-${number}-$$",
            true,
            &f.storage,
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(occurrences, 2);
    assert_eq!(files[0].next, "value-12-$\r\nvalue-3-$\r\nno match\r\n");
    f.w.replace_apply(&id, vec![entry], &f.storage).unwrap();
    assert_eq!(
        std::fs::read(f.root.join("found.txt")).unwrap(),
        b"value-12-$\r\nvalue-3-$\r\nno match\r\n"
    );
}

#[test]
fn media_previews_are_read_only_scoped_bounded_and_no_follow() {
    let mut f = Fixture::new();
    f.write("preview.mp4", "0123456789");
    let id = f.w.register(PathBuf::from("preview.mp4"));
    let info = f.w.media_open(&id).unwrap().unwrap();
    let preview = f.w.media[&info.token].clone();
    let request = tauri::http::Request::builder()
        .header("Range", "bytes=3-5")
        .body(vec![])
        .unwrap();
    assert_eq!(
        agent_workspace::media::read(&preview, &request).body(),
        b"345"
    );
    assert_eq!(
        std::fs::read(f.root.join("preview.mp4")).unwrap(),
        b"0123456789"
    );
    assert!(f.w.media_open("not-an-entry").is_err());
    let next = f.w.media_open(&id).unwrap().unwrap();
    assert!(!f.w.media.contains_key(&info.token));
    assert!(f.w.media.contains_key(&next.token));
    let oversized = std::fs::File::create(f.root.join("huge.png")).unwrap();
    oversized.set_len(33 * 1024 * 1024).unwrap();
    let huge = f.w.register(PathBuf::from("huge.png"));
    assert_eq!(f.w.media_open(&huge).unwrap_err().code, "resourceLimit");
    #[cfg(unix)]
    {
        let outside = f._tmp.path().join("outside.png");
        std::fs::write(&outside, b"private").unwrap();
        std::os::unix::fs::symlink(outside, f.root.join("link.png")).unwrap();
        let link = f.w.register(PathBuf::from("link.png"));
        assert!(f.w.media_open(&link).is_err());
    }
}
#[test]
fn shortcut_settings_migrate_persist_and_reject_unbounded_values() {
    let t = tempfile::tempdir().unwrap();
    let storage = Storage::new(t.path().into()).unwrap();
    let mut raw = serde_json::to_value(agent_workspace::workspace::default_settings()).unwrap();
    raw.as_object_mut().unwrap().remove("keybindings");
    storage.write("settings.json", &raw).unwrap();
    let mut settings = agent_workspace::workspace::load_settings(&storage).unwrap();
    assert!(settings.keybindings.is_empty());
    settings
        .keybindings
        .insert("app.save".into(), vec!["Ctrl+K Ctrl+S".into()]);
    storage.write("settings.json", &settings).unwrap();
    assert_eq!(
        agent_workspace::workspace::load_settings(&storage)
            .unwrap()
            .keybindings["app.save"],
        vec!["Ctrl+K Ctrl+S"]
    );
    settings
        .keybindings
        .insert("bad".into(), vec!["X".repeat(161)]);
    assert!(!agent_workspace::workspace::validate_keybindings(&settings));
    storage.write("settings.json", &settings).unwrap();
    assert_eq!(
        agent_workspace::workspace::load_settings(&storage)
            .unwrap_err()
            .code,
        "stateVersion"
    );
    assert!(storage.root.join("settings.json").exists());
}

#[test]
fn abandoned_view_snapshots_release_memory_without_touching_files_index_or_recovery() {
    let mut f = Fixture::new();
    let original = (0..4000)
        .map(|n| format!("old line {n} payload\n"))
        .collect::<String>();
    f.write("large.txt", &original);
    f.write("dirty.txt", "base\n");
    f.write("replace.txt", "hello\n");
    f.commit();
    let edited = original.replace("old line", "new line");
    f.write("large.txt", &edited);
    let entry = f.w.register("large.txt".into());
    let dirty = f.w.register("dirty.txt".into());
    let replacement = f.w.register("replace.txt".into());
    f.w.document_open(&dirty, &f.storage).unwrap();
    f.w.checkpoint(&dirty, "unsaved private text", 1, &f.storage)
        .unwrap();
    let mut ids = Vec::new();
    for _ in 0..8 {
        let Response::Diff { diff } = f.w.git_diff(&f.git, &entry, false).unwrap() else {
            panic!("diff")
        };
        assert!(
            diff.hunks
                .iter()
                .all(|header| header.starts_with("@@") && header.len() < 200)
        );
        ids.push(diff.id);
    }
    let retained: usize =
        f.w.diffs
            .values()
            .map(|s| s.full.len() + s.parts.iter().map(Vec::len).sum::<usize>())
            .sum();
    assert!(retained > 2_000_000);
    assert!(f.w.release_views(&["not-a-snapshot".into()], &[]).is_err());
    assert_eq!(f.w.diffs.len(), 8);
    f.w.release_views(&ids[..7], &[]).unwrap();
    assert_eq!(f.w.diffs.len(), 1);
    assert!(f.w.dirty());
    f.w.git_hunk(&f.git, &ids[7], 0, false).unwrap();
    assert_eq!(run(&f.git, &f.root, &["show", ":large.txt"]), edited);
    f.w.release_views(&ids[7..], &[]).unwrap();
    assert!(f.w.diffs.is_empty());
    let Response::Replacement { id, .. } =
        f.w.replace_preview(vec![replacement], "hello", "changed", false, &f.storage)
            .unwrap()
    else {
        panic!("preview")
    };
    f.w.release_views(&[], &[id]).unwrap();
    assert!(f.w.replacements.is_empty());
    assert!(f.w.dirty());
    assert_eq!(
        std::fs::read_to_string(f.root.join("replace.txt")).unwrap(),
        "hello\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("large.txt")).unwrap(),
        edited
    );
    assert!(
        f.storage
            .root
            .join(format!("recovery-{dirty}.json"))
            .exists()
    );
}

#[cfg(unix)]
#[test]
fn successful_hook_that_changes_the_reviewed_tree_is_reported_without_retry_or_reset() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("file", "base\n");
    f.commit();
    f.write("file", "reviewed\n");
    let id = f.w.register("file".into());
    f.w.git_stage(&f.git, &id, false).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    let hook = f.root.join(".git/hooks/pre-commit");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf 'hook content\\n' > file\n'{}' add -- file\n",
            f.git.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let Response::Text { text } =
        f.w.git_commit(&f.git, "reviewed commit", &status.staged_revision)
            .unwrap()
    else {
        panic!()
    };
    assert!(text.contains("differs from the reviewed"), "{text}");
    assert_eq!(
        run(&f.git, &f.root, &["show", "HEAD:file"]),
        "hook content\n"
    );
    assert_eq!(
        run(&f.git, &f.root, &["rev-list", "--count", "HEAD"]).trim(),
        "2"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        "hook content\n"
    );
}

#[cfg(unix)]
#[test]
fn push_with_lost_remote_acknowledgement_reports_uncertainty_without_repeating_it() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("file", "base\n");
    f.commit();
    let remote = f._tmp.path().join("remote.git");
    run(
        &f.git,
        f._tmp.path(),
        &["init", "--bare", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(
        &f.git,
        &f.root,
        &["push", "--set-upstream", "origin", "main"],
    );
    f.write("file", "new commit\n");
    f.commit();
    let wrapper = f._tmp.path().join("receive-with-lost-ack");
    let calls = f._tmp.path().join("receive-calls");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\n'{}' receive-pack \"$@\"\nexit 75\n",
            calls.display(),
            f.git.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    // Trusted repository configuration selects this disposable local transport.
    run(
        &f.git,
        &f.root,
        &[
            "config",
            "remote.origin.receivepack",
            wrapper.to_str().unwrap(),
        ],
    );
    let before = run(&f.git, &f.root, &["rev-parse", "HEAD"]);
    let error = f.w.git_network(&f.git, "push").unwrap_err();
    assert_eq!(error.code, "gitNetwork");
    assert!(
        error
            .message
            .contains("Inspect remote/local state before retrying")
    );
    assert_eq!(
        run(&f.git, &remote, &["rev-parse", "refs/heads/main"]),
        before
    );
    assert_eq!(
        std::fs::read(&calls).unwrap(),
        b"x",
        "Never replay a push with an uncertain acknowledgement"
    );
    assert_eq!(run(&f.git, &f.root, &["rev-parse", "HEAD"]), before);
}

#[test]
fn binary_rename_and_delete_use_exact_file_staging_without_invented_hunks() {
    let mut f = Fixture::new();
    std::fs::write(f.root.join("binary"), [0, 0xff, 1, 0, 0xfe]).unwrap();
    f.write("old name", "rename contents\n");
    f.write("deleted", "delete contents\n");
    f.commit();
    let bytes = [0, 0xff, 2, 0, 0xfd];
    std::fs::write(f.root.join("binary"), bytes).unwrap();
    let binary = f.w.register("binary".into());
    let Response::Diff { diff } = f.w.git_diff(&f.git, &binary, false).unwrap() else {
        panic!()
    };
    assert!(diff.hunks.is_empty() && diff.hunk_unavailable.is_some());
    f.w.git_stage(&f.git, &binary, false).unwrap();
    let indexed = Command::new(&f.git)
        .current_dir(&f.root)
        .args(["show", ":binary"])
        .output()
        .unwrap();
    assert!(indexed.status.success());
    assert_eq!(indexed.stdout, bytes);
    std::fs::rename(f.root.join("old name"), f.root.join("new name")).unwrap();
    std::fs::remove_file(f.root.join("deleted")).unwrap();
    for path in ["old name", "new name", "deleted"] {
        let id = f.w.register(path.into());
        f.w.git_stage(&f.git, &id, false).unwrap();
    }
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    assert!(
        status
            .changes
            .iter()
            .any(|c| c.path == "new name" && c.original.as_deref() == Some("old name"))
    );
    assert!(
        status
            .changes
            .iter()
            .any(|c| c.path == "deleted" && c.index == "D")
    );
    assert_eq!(
        run(&f.git, &f.root, &["show", ":new name"]),
        "rename contents\n"
    );
    assert!(std::fs::read(f.root.join("binary")).unwrap() == bytes);
}

#[cfg(unix)]
#[test]
fn mode_only_staging_preserves_working_bytes_and_does_not_offer_a_text_hunk() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("script", "#!/bin/sh\nexit 0\n");
    f.commit();
    run(&f.git, &f.root, &["config", "core.filemode", "true"]);
    std::fs::set_permissions(
        f.root.join("script"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let id = f.w.register("script".into());
    let Response::Diff { diff } = f.w.git_diff(&f.git, &id, false).unwrap() else {
        panic!()
    };
    assert!(diff.hunks.is_empty() && diff.hunk_unavailable.is_some());
    f.w.git_stage(&f.git, &id, false).unwrap();
    assert!(run(&f.git, &f.root, &["ls-files", "--stage", "script"]).starts_with("100755"));
    assert_eq!(
        std::fs::read_to_string(f.root.join("script")).unwrap(),
        "#!/bin/sh\nexit 0\n"
    );
}

#[test]
fn nested_repository_selection_never_aggregates_the_parent_index() {
    let mut f = Fixture::new();
    f.write("parent", "base\n");
    f.commit();
    let nested = f.root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    run(&f.git, &nested, &["init", "-b", "child"]);
    std::fs::write(nested.join("child"), "child work\n").unwrap();
    f.write("parent", "parent work\n");
    let selected = f.w.register("nested".into());
    let Response::GitStatus { status } = f.w.git_status(&f.git, Some(&selected)).unwrap() else {
        panic!()
    };
    assert_eq!(status.branch, "child");
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "child");
    let entry = status.changes[0].entry.clone();
    f.w.git_stage(&f.git, &entry, false).unwrap();
    assert_eq!(run(&f.git, &nested, &["show", ":child"]), "child work\n");
    assert_eq!(run(&f.git, &f.root, &["show", ":parent"]), "base\n");
}

#[test]
fn submodule_selection_uses_its_git_file_and_keeps_the_superproject_index() {
    let mut f = Fixture::new();
    f.write("parent", "parent\n");
    f.commit();
    let sub = f._tmp.path().join("sub-source");
    std::fs::create_dir(&sub).unwrap();
    run(&f.git, &sub, &["init", "-b", "main"]);
    run(&f.git, &sub, &["config", "user.name", "Fixture"]);
    run(
        &f.git,
        &sub,
        &["config", "user.email", "fixture@example.invalid"],
    );
    run(&f.git, &sub, &["config", "commit.gpgsign", "false"]);
    std::fs::write(sub.join("child"), "base\n").unwrap();
    run(&f.git, &sub, &["add", "child"]);
    run(&f.git, &sub, &["commit", "-m", "base"]);
    run(
        &f.git,
        &f.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            sub.to_str().unwrap(),
            "module",
        ],
    );
    f.commit();
    let parent_index = run(&f.git, &f.root, &["ls-files", "--stage"]);
    assert!(f.root.join("module/.git").is_file());
    std::fs::write(f.root.join("module/child"), "submodule work\n").unwrap();
    let selected = f.w.register("module".into());
    let Response::GitStatus { status } = f.w.git_status(&f.git, Some(&selected)).unwrap() else {
        panic!()
    };
    assert_eq!(status.changes.len(), 1);
    assert_eq!(status.changes[0].path, "child");
    f.w.git_stage(&f.git, &status.changes[0].entry, false)
        .unwrap();
    assert_eq!(
        run(&f.git, &f.root.join("module"), &["show", ":child"]),
        "submodule work\n"
    );
    assert_eq!(run(&f.git, &f.root, &["ls-files", "--stage"]), parent_index);
}

#[test]
fn missed_watch_events_and_external_rename_cannot_overwrite_a_replacement() {
    let mut f = Fixture::new();
    f.write("file", "baseline\n");
    let id = f.w.register("file".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    f.w.checkpoint(&id, "local acknowledged\n", 1, &f.storage)
        .unwrap();
    std::fs::rename(f.root.join("file"), f.root.join("external renamed")).unwrap();
    f.write("file", "replacement from external writer\n");
    // No watcher event or refresh is delivered before the save.
    assert_eq!(
        f.w.save(
            &id,
            "local acknowledged\n",
            1,
            &document.baseline,
            &f.storage
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        "replacement from external writer\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("external renamed")).unwrap(),
        "baseline\n"
    );
    let mut reopened = Workspace::open(&f.root, &[]).unwrap();
    reopened.register("file".into());
    let Response::Document { document } = reopened.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.recovery.as_deref(), Some("local acknowledged\n"));
}

#[test]
fn cancellation_storms_and_long_lines_keep_buffers_bounded_and_files_unchanged() {
    use std::sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    };
    let mut f = Fixture::new();
    f.write("file", "needle\n");
    let cancel = Arc::new(AtomicU32::new(0));
    for generation in 1..=200 {
        cancel.store(generation + 1, Ordering::SeqCst);
        let error = agent_workspace::search::search(
            &mut f.w,
            "needle",
            false,
            false,
            false,
            generation,
            cancel.clone(),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }
    let path = f.root.join("long-line");
    let mut file = std::fs::File::create(&path).unwrap();
    use std::io::Write;
    for _ in 0..20 {
        file.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
    }
    file.sync_all().unwrap();
    let id = f.w.register("long-line".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(
        document
            .readonly
            .as_deref()
            .is_some_and(|r| r.contains("Long-line"))
    );
    assert!(document.text.len() <= 64 * 1024);
    assert_eq!(document.size, (20 * 1024 * 1024) as f64);
    assert!(
        f.w.save(&id, "replacement", 1, &document.baseline, &f.storage)
            .is_err()
    );
    assert_eq!(std::fs::metadata(&path).unwrap().len(), 20 * 1024 * 1024);
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        "needle\n"
    );
    assert!(f.w.replacements.is_empty() && f.w.diffs.is_empty());
}

#[cfg(unix)]
#[test]
fn automatic_git_inspection_does_not_execute_a_repository_fsmonitor() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("file", "base\n");
    f.commit();
    let marker = f.root.join("monitor-called");
    let hook = f._tmp.path().join("fsmonitor");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\nprintf '\\0'\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    run(
        &f.git,
        &f.root,
        &["config", "core.fsmonitor", hook.to_str().unwrap()],
    );
    f.w.git_status(&f.git, None).unwrap();
    let id = f.w.register("file".into());
    f.w.git_diff(&f.git, &id, false).unwrap();
    assert!(
        !marker.exists(),
        "Automatic inspection executed project configuration"
    );
    // Positive control: the configured hook is executable by normal Git.
    run(&f.git, &f.root, &["status", "--porcelain"]);
    assert!(marker.exists());
}

#[test]
fn hundred_thousand_commit_history_is_paged_without_loading_every_commit() {
    use std::io::Write;
    let mut f = Fixture::new();
    f.write("file", "base\n");
    f.commit();
    let parent = run(&f.git, &f.root, &["rev-parse", "HEAD"]);
    let mut importer = Command::new(&f.git)
        .current_dir(&f.root)
        .args(["fast-import", "--quiet"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = std::io::BufWriter::new(importer.stdin.take().unwrap());
    for n in 0..100_000 {
        let subject = format!("synthetic history {n:06}");
        writeln!(input, "commit refs/heads/main\ncommitter Fixture <fixture@example.invalid> {} +0000\ndata {}\n{}", 1_700_000_000 + n, subject.len(), subject).unwrap();
        if n == 0 {
            writeln!(input, "from {}", parent.trim()).unwrap();
        }
        writeln!(input).unwrap();
    }
    input.flush().unwrap();
    drop(input);
    let result = importer.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let Response::Items { items, more } = f.w.git_list(&f.git, "history", 0).unwrap() else {
        panic!()
    };
    assert_eq!(items.len(), 100);
    assert!(more);
    assert_eq!(items[0].label, "synthetic history 099999");
    let Response::Items { items, more } = f.w.git_list(&f.git, "history", 99_950).unwrap() else {
        panic!()
    };
    assert_eq!(items.len(), 51);
    assert!(!more);
    assert_eq!(items.last().unwrap().label, "base");
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        "base\n"
    );
    assert!(f.w.documents.is_empty() && f.w.diffs.is_empty());
}

#[cfg(unix)]
#[test]
fn hook_working_edits_are_retained_without_a_false_committed_tree_warning() {
    use std::os::unix::fs::PermissionsExt;
    let mut f = Fixture::new();
    f.write("file", "base\n");
    f.commit();
    f.write("file", "reviewed\n");
    let id = f.w.register("file".into());
    f.w.git_stage(&f.git, &id, false).unwrap();
    let Response::GitStatus { status } = f.w.git_status(&f.git, None).unwrap() else {
        panic!()
    };
    let hook = f.root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nprintf 'unstaged hook edit\\n' > file\n").unwrap();
    std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let Response::Text { text } =
        f.w.git_commit(&f.git, "reviewed", &status.staged_revision)
            .unwrap()
    else {
        panic!()
    };
    assert!(!text.contains("differs from the reviewed"));
    assert_eq!(run(&f.git, &f.root, &["show", "HEAD:file"]), "reviewed\n");
    assert_eq!(
        std::fs::read_to_string(f.root.join("file")).unwrap(),
        "unstaged hook edit\n"
    );
}

#[test]
fn long_line_preview_stops_at_a_utf8_boundary_without_changing_the_baseline() {
    let mut f = Fixture::new();
    let original = format!("aa{}", "€".repeat(400_000));
    f.write("unicode-line", &original);
    let id = f.w.register("unicode-line".into());
    let Response::Document { document } = f.w.document_open(&id, &f.storage).unwrap() else {
        panic!()
    };
    assert!(
        document
            .readonly
            .as_deref()
            .is_some_and(|r| r.contains("Long-line"))
    );
    assert!(document.text.len() <= 64 * 1024 && original.starts_with(&document.text));
    assert_eq!(
        document.baseline,
        agent_workspace::documents::hash(original.as_bytes())
    );
    assert_eq!(
        std::fs::read_to_string(f.root.join("unicode-line")).unwrap(),
        original
    );
}

fn explorer_statuses(f: &mut Fixture, paths: &[&str]) -> Vec<agent_workspace::dto::GitDecoration> {
    let entries = paths
        .iter()
        .map(|path| f.w.register(PathBuf::from(path)))
        .collect::<Vec<_>>();
    match f.w.git_decorations(&f.git, &entries).unwrap() {
        Response::GitDecorations { decorations } => decorations,
        _ => panic!("Expected Git decorations"),
    }
}

#[test]
fn explorer_git_colors_cover_real_states_ignored_negations_and_folder_rollups() {
    use agent_workspace::dto::GitFileStatus::*;
    let mut f = Fixture::new();
    std::fs::create_dir_all(f.root.join("src/deleted")).unwrap();
    std::fs::create_dir(f.root.join("cache")).unwrap();
    f.write(".gitignore", "cache/\nignored-folder/\n*.log\n!keep.log\n");
    for name in [
        "clean.txt",
        "src/modified.txt",
        "staged.txt",
        "mixed.txt",
        "old.txt",
        "src/deleted/gone.txt",
        "keep.log",
    ] {
        f.write(name, "original\n");
    }
    f.write("cache/tracked.log", "force added\n");
    run(&f.git, &f.root, &["add", "."]);
    run(&f.git, &f.root, &["add", "-f", "cache/tracked.log"]);
    run(&f.git, &f.root, &["commit", "-m", "baseline"]);
    f.write("src/modified.txt", "modified\n");
    f.write("staged.txt", "staged\n");
    f.write("mixed.txt", "staged\n");
    f.write("added.txt", "added\n");
    run(
        &f.git,
        &f.root,
        &["add", "staged.txt", "mixed.txt", "added.txt"],
    );
    f.write("mixed.txt", "newer working edit\n");
    run(&f.git, &f.root, &["mv", "old.txt", "renamed.txt"]);
    std::fs::remove_file(f.root.join("src/deleted/gone.txt")).unwrap();
    std::fs::create_dir(f.root.join("ignored-folder")).unwrap();
    f.write("ignored-folder/child.txt", "ignored\n");
    f.write("cache/ignored.txt", "ignored\n");
    f.write("ignored.log", "ignored\n");
    f.write("untracked.txt", "untracked\n");
    std::fs::create_dir(f.root.join("new-folder")).unwrap();
    f.write("new-folder/child.txt", "new\n");
    let paths = [
        "clean.txt",
        "src/modified.txt",
        "src",
        "src/deleted",
        "staged.txt",
        "mixed.txt",
        "added.txt",
        "renamed.txt",
        "untracked.txt",
        "new-folder",
        "new-folder/child.txt",
        "cache",
        "cache/ignored.txt",
        "cache/tracked.log",
        "ignored.log",
        "keep.log",
        "ignored-folder",
        "ignored-folder/child.txt",
    ];
    let result = explorer_statuses(&mut f, &paths);
    assert_eq!(
        result.iter().map(|d| d.status).collect::<Vec<_>>(),
        vec![
            Clean, Modified, Modified, Deleted, Staged, Modified, Added, Renamed, Untracked,
            Untracked, Untracked, Clean, Ignored, Clean, Ignored, Clean, Ignored, Ignored
        ]
    );
    assert!(result[4].staged && result[5].staged && result[6].staged && result[7].staged);
    assert!(!result[0].staged && !result[8].staged);
    f.write(
        "cache/tracked.log",
        "changed tracked file inside ignored folder\n",
    );
    let result = explorer_statuses(&mut f, &["cache", "cache/tracked.log", "cache/ignored.txt"]);
    assert_eq!(
        result.iter().map(|d| d.status).collect::<Vec<_>>(),
        vec![Modified, Modified, Ignored]
    );
    run(&f.git, &f.root, &["add", "src/modified.txt"]);
    assert_eq!(
        explorer_statuses(&mut f, &["src/modified.txt"])[0].status,
        Staged
    );
    run(
        &f.git,
        &f.root,
        &["restore", "--staged", "src/modified.txt"],
    );
    assert_eq!(
        explorer_statuses(&mut f, &["src/modified.txt"])[0].status,
        Modified
    );
}

#[test]
fn explorer_git_colors_prioritize_conflicts_and_use_literal_filename_bytes() {
    use agent_workspace::dto::GitFileStatus::*;
    let mut f = Fixture::new();
    std::fs::create_dir(f.root.join("folder")).unwrap();
    f.write("folder/conflict.txt", "base\n");
    run(&f.git, &f.root, &["add", "."]);
    run(&f.git, &f.root, &["commit", "-m", "base"]);
    run(&f.git, &f.root, &["checkout", "-b", "other"]);
    f.write("folder/conflict.txt", "other\n");
    run(&f.git, &f.root, &["commit", "-am", "other"]);
    run(&f.git, &f.root, &["checkout", "main"]);
    f.write("folder/conflict.txt", "main\n");
    run(&f.git, &f.root, &["commit", "-am", "main"]);
    assert!(
        !Command::new(&f.git)
            .current_dir(&f.root)
            .args(["merge", "other"])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" }
            )
            .output()
            .unwrap()
            .status
            .success()
    );
    f.write("-leading.txt", "literal\n");
    let literal = if cfg!(windows) {
        "literal [glob] file.txt"
    } else {
        ":(glob)file\nname.txt"
    };
    f.write(literal, "literal\n");
    let results = explorer_statuses(
        &mut f,
        &["folder", "folder/conflict.txt", "-leading.txt", literal],
    );
    assert_eq!(
        results.iter().map(|d| d.status).collect::<Vec<_>>(),
        vec![Conflict, Conflict, Untracked, Untracked]
    );
}

#[test]
fn explorer_git_colors_refuse_unknown_ids_and_do_not_escape_selected_repository() {
    let mut f = Fixture::new();
    assert_eq!(
        f.w.git_decorations(&f.git, &["unknown".into()])
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        f.w.git_decorations(&f.git, &vec!["unknown".into(); 10_001])
            .unwrap_err()
            .code,
        "resourceLimit"
    );
    std::fs::create_dir(f.root.join("nested")).unwrap();
    run(&f.git, &f.root.join("nested"), &["init", "-b", "main"]);
    f.write("outside.txt", "outer\n");
    f.write("nested/inside.txt", "inner\n");
    let nested = f.w.register(PathBuf::from("nested"));
    f.w.git_root(&f.git, Some(&nested)).unwrap();
    assert_eq!(
        explorer_statuses(&mut f, &["outside.txt", "nested/inside.txt"]).len(),
        1
    );
    let nested = Workspace::open(&f.root.join("nested"), &[]).unwrap();
    // Plain subfolders must not silently operate on a repository above the workspace.
    std::fs::create_dir(f.root.join("plain")).unwrap();
    let mut plain = Workspace::open(&f.root.join("plain"), &[]).unwrap();
    let id = plain.register(PathBuf::from("file"));
    assert_eq!(
        plain.git_decorations(&f.git, &[id]).unwrap_err().code,
        "scope"
    );
    drop(nested);
}

#[cfg(unix)]
#[test]
fn explorer_git_colors_keep_native_filename_bytes_distinct() {
    use agent_workspace::dto::GitFileStatus::*;
    use std::os::unix::ffi::OsStringExt;
    let mut f = Fixture::new();
    f.write(".gitignore", "*.log\n");
    // APFS rejects invalid UTF-8. Linux exercises raw bytes; macOS retains
    // native Unicode/newline names instead, matching the existing FS fixtures.
    let names = if cfg!(target_os = "macos") {
        [
            std::ffi::OsString::from("bad_🌍\n.log"),
            std::ffi::OsString::from("bad_🌏\n.txt"),
        ]
    } else {
        [
            std::ffi::OsString::from_vec(b"bad_\xff.log".to_vec()),
            std::ffi::OsString::from_vec(b"bad_\xfe.txt".to_vec()),
        ]
    };
    let ids = names
        .iter()
        .map(|name| {
            std::fs::write(f.root.join(name), b"bytes\n").unwrap();
            f.w.register(PathBuf::from(name))
        })
        .collect::<Vec<_>>();
    let Response::GitDecorations { decorations } = f.w.git_decorations(&f.git, &ids).unwrap()
    else {
        panic!("Expected decorations")
    };
    assert_ne!(decorations[0].entry, decorations[1].entry);
    assert_eq!(decorations[0].status, Ignored);
    assert_eq!(decorations[1].status, Untracked);
}

#[test]
fn file_path_actions_use_exact_native_names_and_each_requested_root() {
    use agent_workspace::dto::FilePathKind as Kind;
    let mut f = Fixture::new();
    std::fs::create_dir_all(f.root.join("nested/dir space")).unwrap();
    run(&f.git, &f.root.join("nested"), &["init", "-b", "main"]);
    let relative = PathBuf::from("nested")
        .join("dir space")
        .join("file 🌍.txt");
    std::fs::write(f.root.join(&relative), "bytes").unwrap();
    let entry = f.w.register(relative.clone());
    let selected = f.w.git_root(&f.git, None).unwrap();
    let read = |workspace: &Workspace, kind| {
        workspace
            .path_read(&entry, kind, Some(f.git.clone()))
            .unwrap()
            .read()
            .unwrap()
    };
    assert_eq!(read(&f.w, Kind::Name), "file 🌍.txt");
    assert_eq!(read(&f.w, Kind::Project), relative.to_str().unwrap());
    assert_eq!(
        read(&f.w, Kind::Git),
        Path::new("dir space").join("file 🌍.txt").to_str().unwrap()
    );
    assert_eq!(
        read(&f.w, Kind::Absolute),
        Path::new(&f.w.project.root)
            .join(&relative)
            .to_str()
            .unwrap()
    );
    assert_eq!(f.w.repository, Some(selected));
    let folder = f.w.register("nested".into());
    assert_eq!(
        f.w.path_read(&folder, Kind::Git, Some(f.git.clone()))
            .unwrap()
            .read()
            .unwrap(),
        "."
    );
    let mut subfolder = Workspace::open(&f.root.join("nested/dir space"), &[]).unwrap();
    subfolder.project.trusted = true;
    let id = subfolder.register("file 🌍.txt".into());
    assert_eq!(
        subfolder
            .path_read(&id, Kind::Project, None)
            .unwrap()
            .read()
            .unwrap(),
        "file 🌍.txt"
    );
    assert_eq!(
        subfolder
            .path_read(&id, Kind::Git, Some(f.git.clone()))
            .unwrap()
            .read()
            .unwrap(),
        Path::new("dir space").join("file 🌍.txt").to_str().unwrap()
    );
}

#[test]
fn file_path_and_reveal_actions_preserve_restricted_browsing_and_scope() {
    use agent_workspace::dto::FilePathKind as Kind;
    let mut f = Fixture::new();
    std::fs::create_dir_all(f.root.join("one/two")).unwrap();
    f.write("one/two/file.txt", "data");
    let id = f.w.register(Path::new("one/two/file.txt").into());
    f.w.project.trusted = false;
    assert_eq!(
        f.w.path_read(&id, Kind::Name, None)
            .unwrap()
            .read()
            .unwrap(),
        "file.txt"
    );
    assert_eq!(
        f.w.path_read(&id, Kind::Project, None)
            .unwrap()
            .read()
            .unwrap(),
        Path::new("one/two/file.txt").to_str().unwrap()
    );
    assert_eq!(
        f.w.path_read(&id, Kind::Git, Some(f.git.clone()))
            .err()
            .unwrap()
            .code,
        "untrusted"
    );
    let Response::Entries { entries, .. } = f.w.reveal_entry(&id).unwrap() else {
        panic!("Expected reveal chain")
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        vec!["one", "two", "file.txt"]
    );
    assert!(entries[..2].iter().all(|entry| entry.kind == "directory"));
    assert_eq!(entries[2].id, id);
    assert_eq!(f.w.reveal_entry("unknown").unwrap_err().code, "scope");
    assert_eq!(
        f.w.path_read("unknown", Kind::Absolute, None)
            .err()
            .unwrap()
            .code,
        "scope"
    );
    std::fs::remove_file(f.root.join("one/two/file.txt")).unwrap();
    assert!(f.w.reveal_entry(&id).is_err());
    assert_eq!(
        f.w.path_read(&id, Kind::Name, None)
            .unwrap()
            .read()
            .unwrap(),
        "file.txt"
    );
}

#[cfg(unix)]
#[test]
fn file_path_and_reveal_actions_do_not_follow_outside_links() {
    use agent_workspace::dto::FilePathKind as Kind;
    let mut f = Fixture::new();
    let outside = f._tmp.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("file.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("escape")).unwrap();
    let id = f.w.register("escape/file.txt".into());
    assert!(f.w.reveal_entry(&id).is_err());
    assert!(f.w.path_read(&id, Kind::Git, Some(f.git.clone())).is_err());
    let link = f.w.register("escape".into());
    assert_eq!(
        f.w.path_read(&link, Kind::Absolute, None)
            .unwrap()
            .read()
            .unwrap(),
        Path::new(&f.w.project.root)
            .join("escape")
            .to_str()
            .unwrap()
    );
    let Response::Entries { entries, .. } = f.w.reveal_entry(&link).unwrap() else {
        panic!("Expected link")
    };
    assert_eq!(entries[0].kind, "link");
    assert_eq!(
        f.w.path_read(&link, Kind::Git, Some(f.git.clone()))
            .unwrap()
            .read()
            .unwrap(),
        "escape"
    );
}
