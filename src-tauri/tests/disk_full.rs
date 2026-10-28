//! Real ENOSPC, only on a separately mounted, size-checked disposable volume.
#[cfg(unix)]
#[test]
#[ignore = "requires the explicit disposable small-volume runner"]
fn full_volume_preserves_original_and_acknowledged_recovery_then_allows_retry() {
    use agent_workspace::{dto::Response, storage::Storage, workspace::Workspace};
    use std::{ffi::CString, io::Write, os::unix::ffi::OsStrExt};
    let volume = std::path::PathBuf::from(
        std::env::var_os("AW_FULL_VOLUME_FIXTURE").expect("Missing disposable volume"),
    );
    assert_eq!(
        std::fs::read(volume.join(".aw-disposable-full-volume")).unwrap(),
        b"disposable-disk-full-volume"
    );
    let path = CString::new(volume.as_os_str().as_bytes()).unwrap();
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    assert_eq!(
        unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) },
        0
    );
    let stats = unsafe { stats.assume_init() };
    let capacity = stats.f_blocks as u64 * stats.f_frsize as u64;
    assert!(
        (8 * 1024 * 1024..=64 * 1024 * 1024).contains(&capacity),
        "Refusing to fill a non-fixture filesystem"
    );
    let root = volume.join("workspace");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("a"), b"original").unwrap();
    let private = tempfile::tempdir().unwrap();
    let storage = Storage::new(private.path().join("private")).unwrap();
    let mut workspace = Workspace::open(&root, &[]).unwrap();
    workspace.project.trusted = true;
    let id = workspace.register("a".into());
    let Response::Document { document } = workspace.document_open(&id, &storage).unwrap() else {
        panic!()
    };
    let text = "unsaved\n".repeat(256 * 1024);
    workspace.checkpoint(&id, &text, 1, &storage).unwrap();
    let filler_path = volume.join("owned-space-filler");
    let mut filler = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&filler_path)
        .unwrap();
    let block = [0u8; 64 * 1024];
    let mut exhausted = false;
    for _ in 0..1024 {
        if let Err(error) = filler.write_all(&block) {
            assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
            exhausted = true;
            break;
        }
    }
    assert!(exhausted, "Fixture did not reach actual ENOSPC");
    drop(filler);
    assert!(
        workspace
            .save(&id, &text, 1, &document.baseline, &storage)
            .is_err()
    );
    assert_eq!(std::fs::read(root.join("a")).unwrap(), b"original");
    drop(workspace);
    let mut workspace = Workspace::open(&root, &[]).unwrap();
    workspace.project.trusted = true;
    let id = workspace.register("a".into());
    let Response::Document { document } = workspace.document_open(&id, &storage).unwrap() else {
        panic!()
    };
    assert_eq!(document.recovery.as_deref(), Some(text.as_str()));
    std::fs::remove_file(filler_path).unwrap();
    workspace
        .save(&id, &text, 1, &document.baseline, &storage)
        .unwrap();
    assert_eq!(std::fs::read_to_string(root.join("a")).unwrap(), text);
}
