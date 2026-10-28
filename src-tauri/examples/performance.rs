use agent_workspace::{dto::Response, storage::Storage, workspace::Workspace};
use std::time::Instant;
fn main() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let content = "ordinary line of text\n".repeat(4000);
    std::fs::write(root.join("sample.txt"), &content).unwrap();
    let storage = Storage::new(tmp.path().join("data")).unwrap();
    let mut w = Workspace::open(&root, &[]).unwrap();
    let id = w.register("sample.txt".into());
    let mut timings = Vec::new();
    for _ in 0..100 {
        w.documents.clear();
        let t = Instant::now();
        assert!(matches!(
            w.document_open(&id, &storage).unwrap(),
            Response::Document { .. }
        ));
        timings.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    timings.sort_by(f64::total_cmp);
    let tree = root.join("tree");
    std::fs::create_dir(&tree).unwrap();
    let prepare = Instant::now();
    for i in 0..100 {
        let dir = tree.join(format!("group-{i:03}"));
        std::fs::create_dir(&dir).unwrap();
        for j in 0..1000 {
            std::fs::File::create(dir.join(format!("file-{j:04}.txt"))).unwrap();
        }
    }
    let generated_ms = prepare.elapsed().as_secs_f64() * 1000.0;
    let tree_id = w.register("tree".into());
    let t = Instant::now();
    let Response::Entries { entries, truncated } = w.list(Some(&tree_id)).unwrap() else {
        panic!()
    };
    assert_eq!(entries.len(), 100);
    assert!(!truncated);
    let lazy_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{}",
        serde_json::json!({"profile":"native backend development fixture; not production UI budget","fileBytes":content.len(),"runs":100,"openP50Ms":timings[49],"openP95Ms":timings[94],"treeFiles":100000,"treeGenerationMs":generated_ms,"treeLazyListMs":lazy_ms,"mountedRows":"UI not measured","releaseBudgets":"UNVERIFIED"})
    );
}
