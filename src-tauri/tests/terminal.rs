#![cfg(unix)]
use agent_workspace::{terminal::TerminalService, workspace::default_settings};
use std::{
    path::Path,
    time::{Duration, Instant},
};
fn open(
    service: &TerminalService,
    root: &Path,
    script: &str,
) -> (agent_workspace::dto::TerminalInfo, String) {
    let mut settings = default_settings();
    settings.shell = Some("/bin/sh".into());
    settings.shell_args = vec!["-c".into(), script.into()];
    service.open("fixture", root, 80, 24, &settings).unwrap()
}
fn read_all(service: &TerminalService, id: &str, token: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut data = Vec::new();
    loop {
        assert!(Instant::now() < deadline, "PTY did not finish");
        let chunk = service.read("fixture", id, token).unwrap();
        data.extend(chunk.data);
        if chunk.done {
            return data;
        }
    }
}
#[test]
fn preserves_raw_bytes_exit_status_and_attachment_authority() {
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    let (info, token) = open(
        &service,
        root.path(),
        "printf '\\033[31m\\360\\237\\232\\200\\033[0m'; exit 42",
    );
    let (_, new_token) = service.attach("fixture", &info.id).unwrap();
    assert_eq!(
        service.read("fixture", &info.id, &token).unwrap_err().code,
        "staleAttachment"
    );
    assert_eq!(
        service
            .read("other", &info.id, &new_token)
            .unwrap_err()
            .code,
        "scope"
    );
    assert_eq!(
        read_all(&service, &info.id, &new_token),
        b"\x1b[31m\xf0\x9f\x9a\x80\x1b[0m"
    );
    let status = service.list("fixture").unwrap().pop().unwrap();
    assert_eq!(status.exit_code, Some(42));
    assert!(status.exited);
    service.close("fixture", &info.id).unwrap();
    assert!(service.is_empty());
}
#[test]
fn bounded_large_output_is_lossless_and_close_unblocks_a_full_ring() {
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    let (info, token) = open(
        &service,
        root.path(),
        "head -c 2097152 /dev/zero | tr '\\000' X",
    );
    std::thread::sleep(Duration::from_millis(200));
    let output = read_all(&service, &info.id, &token);
    assert_eq!(output.len(), 2097152);
    assert!(output.iter().all(|b| *b == b'X'));
    service.close("fixture", &info.id).unwrap();
    let (info, _) = open(
        &service,
        root.path(),
        "trap '' HUP TERM; while :; do printf 'lots of output'; done",
    );
    std::thread::sleep(Duration::from_millis(200));
    let started = Instant::now();
    service.close("fixture", &info.id).unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
}
#[test]
fn ordered_stdin_resize_and_ctrl_c_reach_a_real_foreground_program() {
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    let (info, token) = open(
        &service,
        root.path(),
        "trap 'printf INTERRUPTED; exit 23' INT; stty -echo; printf READY; read value; printf 'VALUE:%s:' \"$value\"; stty size; while :; do sleep 1; done",
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    while !output.windows(5).any(|w| w == b"READY") {
        assert!(Instant::now() < deadline);
        output.extend(service.read("fixture", &info.id, &token).unwrap().data);
    }
    service
        .resize("fixture", &info.id, &token, 123, 37)
        .unwrap();
    assert!(service.resize("fixture", &info.id, &token, 0, 0).is_err());
    service
        .write("fixture", &info.id, &token, 0, b"hello\n".to_vec())
        .unwrap();
    assert_eq!(
        service
            .write("fixture", &info.id, &token, 0, b"duplicate\n".to_vec())
            .unwrap_err()
            .code,
        "sequence"
    );
    while !output.windows(6).any(|w| w == b"37 123") {
        assert!(Instant::now() < deadline);
        output.extend(service.read("fixture", &info.id, &token).unwrap().data);
    }
    service
        .write("fixture", &info.id, &token, 1, vec![3])
        .unwrap();
    output.extend(read_all(&service, &info.id, &token));
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("VALUE:hello:"), "{text}");
    assert!(text.contains("INTERRUPTED"), "{text}");
    assert!(!text.contains("duplicate"));
    assert_eq!(service.list("fixture").unwrap()[0].exit_code, Some(23));
    service.close("fixture", &info.id).unwrap();
}
#[test]
fn explicit_close_cleans_foreground_and_background_groups() {
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    let (info, _) = open(
        &service,
        root.path(),
        "set -m; sh -c 'trap \"\" HUP TERM; echo $$ > background.pid; while :; do sleep 1; done' & echo $$ > shell.pid; trap '' HUP TERM; while :; do sleep 1; done",
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("background.pid").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let pids = ["shell.pid", "background.pid"].map(|name| {
        std::fs::read_to_string(root.path().join(name))
            .unwrap()
            .trim()
            .parse::<i32>()
            .unwrap()
    });
    service.close("fixture", &info.id).unwrap();
    for pid in pids {
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "owned process {pid} survived close"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
#[test]
fn one_hundred_terminal_lifecycles_release_native_descriptors_and_threads() {
    fn count_files(path: &str) -> Option<usize> {
        std::fs::read_dir(path).ok().map(|r| r.count())
    }
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    // Warm up native PTY/std runtime lazy initialization before comparing FDs.
    let (info, token) = open(&service, root.path(), "printf WARMUP");
    read_all(&service, &info.id, &token);
    service.close("fixture", &info.id).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let before = count_files(if cfg!(target_os = "macos") {
        "/dev/fd"
    } else {
        "/proc/self/fd"
    });
    for i in 0..100 {
        let (info, token) = open(&service, root.path(), &format!("printf CYCLE_{i}"));
        assert_eq!(
            read_all(&service, &info.id, &token),
            format!("CYCLE_{i}").as_bytes()
        );
        service.close("fixture", &info.id).unwrap();
        assert!(service.is_empty());
    }
    std::thread::sleep(Duration::from_millis(500));
    let after = count_files(if cfg!(target_os = "macos") {
        "/dev/fd"
    } else {
        "/proc/self/fd"
    });
    if let (Some(before), Some(after)) = (before, after) {
        assert!(
            after <= before + 4,
            "PTY descriptors leaked: {before} -> {after}"
        );
    }
}

#[test]
fn idle_reads_sleep_without_polling_but_wake_immediately_for_output_and_exit() {
    let root = tempfile::tempdir().unwrap();
    let service = TerminalService::default();
    let (info, token) = open(&service, root.path(), "sleep 2; printf wake");
    let start = Instant::now();
    let first = service.read("fixture", &info.id, &token).unwrap();
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(1500),
        "Idle read polled before any data/status event: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(4),
        "Output notification was delayed: {elapsed:?}"
    );
    let mut all = first.data;
    if !first.done {
        all.extend(read_all(&service, &info.id, &token));
    }
    assert_eq!(all, b"wake");
    service.close("fixture", &info.id).unwrap();
}
