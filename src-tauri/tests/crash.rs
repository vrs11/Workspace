#![cfg(feature = "native-fixtures")]
use agent_workspace::{documents::Recovery, dto::Response, storage::Storage, workspace::Workspace};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    time::Duration,
};
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[test]
fn abrupt_host_death_keeps_acknowledged_recovery_at_every_native_save_phase() {
    for phase in 0..=5 {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("disposable-fixture-marker"),
            b"agent-workspace-crash-fixture-v1",
        )
        .unwrap();
        std::fs::create_dir(temp.path().join("project")).unwrap();
        let file = temp.path().join("project/file.txt");
        std::fs::write(&file, b"original disk bytes\n").unwrap();
        let mut child = OwnedChild(
            Command::new(env!("CARGO_BIN_EXE_recovery-test-worker"))
                .arg(temp.path())
                .arg(phase.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = child.0.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send((result, line));
        });
        let (result, line) = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("Fixture must reach a durable acknowledgement before kill");
        result.unwrap();
        assert_eq!(line.trim(), "DURABLE_FIXTURE_ACK", "phase {phase}");
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        reader.join().unwrap();
        let expected: &[u8] = if phase < 4 {
            b"original disk bytes\n"
        } else {
            b"acknowledged local edit\n"
        };
        assert_eq!(std::fs::read(&file).unwrap(), expected, "phase {phase}");
        let storage = Storage::new(temp.path().join("data")).unwrap();
        let mut reopened = Workspace::open(&temp.path().join("project"), &[]).unwrap();
        let entry = reopened.register("file.txt".into());
        let retained: Option<Recovery> = storage.read(&format!("recovery-{entry}.json")).unwrap();
        if phase < 5 {
            assert_eq!(
                retained
                    .expect("Acknowledged recovery must survive actual process death")
                    .text,
                "acknowledged local edit\n"
            );
        } else {
            assert!(
                retained.is_none(),
                "Durably saved checkpoint should have been resolved"
            );
        }
        let Response::Document { document } = reopened.document_open(&entry, &storage).unwrap()
        else {
            panic!("Expected recovered document")
        };
        if phase < 5 {
            assert_eq!(
                document.recovery.as_deref(),
                Some("acknowledged local edit\n")
            );
            assert_eq!(
                document.text, "original disk bytes\n",
                "Retain the three-way comparison baseline"
            );
            if phase == 4 {
                assert!(
                    document.readonly.is_some(),
                    "Unacknowledged replacement requires explicit reconciliation"
                );
            }
        } else {
            assert_eq!(document.text, "acknowledged local edit\n");
        }
    }
}

#[cfg(unix)]
#[test]
fn host_death_during_git_keeps_editor_recovery_and_never_replays_the_commit() {
    use std::{os::unix::fs::PermissionsExt, path::Path, time::Instant};
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("disposable-fixture-marker"),
        b"agent-workspace-crash-fixture-v1",
    )
    .unwrap();
    let root = temp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let git = ["/usr/bin/git", "/usr/local/bin/git"]
        .into_iter()
        .find(|p| Path::new(p).is_file())
        .unwrap();
    let run = |args: &[&str]| {
        let result = Command::new(git)
            .current_dir(&root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap()
    };
    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Fixture"]);
    run(&["config", "user.email", "fixture@example.invalid"]);
    run(&["config", "commit.gpgsign", "false"]);
    run(&[
        "config",
        "core.hooksPath",
        root.join(".git/hooks").to_str().unwrap(),
    ]);
    std::fs::write(root.join("file.txt"), "original disk bytes\n").unwrap();
    std::fs::write(root.join("staged.txt"), "baseline\n").unwrap();
    run(&["add", "--all"]);
    run(&["commit", "-m", "baseline"]);
    let original = run(&["rev-parse", "HEAD"]);
    std::fs::write(root.join("staged.txt"), "reviewed Git change\n").unwrap();
    run(&["add", "--", "staged.txt"]);
    let hook = root.join(".git/hooks/pre-commit");
    std::fs::write(&hook, b"#!/bin/sh\nprintf ready > ../hook-entered\ni=0\nwhile [ ! -e ../release-hook ] && [ \"$i\" -lt 100 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = OwnedChild(
        Command::new(env!("CARGO_BIN_EXE_recovery-test-worker"))
            .arg(temp.path())
            .arg("git-commit")
            .env("AW_FIXTURE_GIT", git)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (tx, rx) = std::sync::mpsc::channel();
    let stdout = child.0.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        tx.send(line).unwrap();
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(15)).unwrap().trim(),
        "DURABLE_FIXTURE_ACK"
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while !temp.path().join("hook-entered").exists() {
        assert!(Instant::now() < deadline, "Git hook did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
    child.0.kill().unwrap();
    assert!(!child.0.wait().unwrap().success());
    reader.join().unwrap();
    // The already-started Git child may finish after host death. Never retry or
    // reset it; reconcile actual repository state with retained editor work.
    std::fs::write(temp.path().join("release-hook"), b"finish once").unwrap();
    while run(&["rev-parse", "HEAD"]) == original {
        assert!(
            Instant::now() < deadline,
            "In-flight commit did not reach its ref update"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let storage = Storage::new(temp.path().join("data")).unwrap();
    let mut reopened = Workspace::open(&root, &[]).unwrap();
    reopened.project.trusted = true;
    let entry = reopened.register("file.txt".into());
    let Response::Document { document } = reopened.document_open(&entry, &storage).unwrap() else {
        panic!()
    };
    assert_eq!(
        document.recovery.as_deref(),
        Some("acknowledged local edit\n")
    );
    assert_eq!(
        std::fs::read_to_string(root.join("file.txt")).unwrap(),
        "original disk bytes\n"
    );
    reopened.git_status(Path::new(git), None).unwrap();
    assert_eq!(run(&["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(run(&["show", "HEAD:staged.txt"]), "reviewed Git change\n");
}
