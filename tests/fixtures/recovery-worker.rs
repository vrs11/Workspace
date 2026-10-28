//! Separately built disposable fixture executable, never an application mode.
use agent_workspace::{documents, dto::Response, security, storage::Storage, workspace::Workspace};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
fn hold() -> ! {
    println!("DURABLE_FIXTURE_ACK");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    assert_eq!(args.len(), 3, "Expected disposable fixture and phase");
    let base = PathBuf::from(&args[1]);
    assert_eq!(
        std::fs::read(base.join("disposable-fixture-marker")).unwrap(),
        b"agent-workspace-crash-fixture-v1"
    );
    let git_commit = args[2] == "git-commit";
    let phase: u8 = if git_commit {
        0
    } else {
        args[2].to_str().unwrap().parse().unwrap()
    };
    assert!(phase <= 5);
    let storage = Storage::new(base.join("data")).unwrap();
    let mut workspace = Workspace::open(&base.join("project"), &[]).unwrap();
    workspace.project.trusted = true;
    let entry = workspace.register("file.txt".into());
    let Response::Document { document } = workspace.document_open(&entry, &storage).unwrap() else {
        panic!("Expected real document")
    };
    workspace
        .checkpoint(
            &document.id,
            "acknowledged local edit\n",
            document.revision + 1,
            &storage,
        )
        .unwrap();
    if git_commit {
        let git = security::executable(&std::env::var("AW_FIXTURE_GIT").unwrap()).unwrap();
        let Response::GitStatus { status } = workspace.git_status(&git, None).unwrap() else {
            panic!()
        };
        println!("DURABLE_FIXTURE_ACK");
        std::io::stdout().flush().unwrap();
        workspace
            .git_commit(&git, "in-flight fixture commit", &status.staged_revision)
            .unwrap();
        panic!("Fixture host must be killed while its hook is pending");
    }
    if phase == 0 {
        hold();
    }
    if phase == 5 {
        workspace
            .save(
                &document.id,
                "acknowledged local edit\n",
                document.revision + 1,
                &document.baseline,
                &storage,
            )
            .unwrap();
        hold();
    }
    let (parent, leaf) = security::parent(&workspace.dir, Path::new("file.txt")).unwrap();
    let file = security::open_read(&parent, &leaf).unwrap();
    #[cfg(unix)]
    let metadata = file.metadata().unwrap();
    #[cfg(windows)]
    let metadata = documents::FileMetadata {
        standard: file.metadata().unwrap(),
        identity: agent_workspace::windows_fs::identity(&file).unwrap(),
    };
    documents::atomic_replace_with_hook(
        &parent,
        &leaf,
        b"original disk bytes\n",
        b"acknowledged local edit\n",
        &metadata,
        |point| {
            if point == phase {
                hold();
            }
            Ok(())
        },
    )
    .unwrap();
    panic!("Fixture failed to reach its native save phase");
}
