//! Offline verification with public upstream test vectors. Never download or
//! install a valid package, use private keys, or touch an application bundle.
use serde_json::{Value, json};
use tauri_plugin_updater::{Update, UpdaterExt};
fn vectors() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/update-signatures.json")).unwrap()
}
fn update(key: &str, signature: &str, version: &str, directory: &std::path::Path) -> Update {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    let product: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), product["plugins"]["updater"].clone());
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        // Offline signature verification also accepts a candidate equal to this
        // test context's version. Runtime update availability keeps its policy.
        .version_comparator(|_, _| true)
        .target("disposable-fixture")
        .executable_path(directory.join("app-that-does-not-exist"))
        .no_proxy()
        .configure_client(|_| panic!("Offline fixture attempted network access"))
        .endpoints(vec!["https://example.invalid/update".parse().unwrap()])
        .unwrap()
        .build()
        .unwrap();
    updater.restore_update(json!({
        "version":version, "notes":"Public verification fixture",
        "platforms": { "disposable-fixture": { "url":"https://example.invalid/package", "signature":signature } },
        // Endpoint metadata must never weaken the application's verifier.
        "config": { "requireSignedVersion":false }
    })).unwrap().unwrap()
}
#[test]
fn signed_payload_verifies_and_tampering_never_reaches_installation() {
    let temp = tempfile::tempdir().unwrap();
    let vectors = vectors();
    let update = update(
        vectors["public_key"].as_str().unwrap(),
        vectors["signature"].as_str().unwrap(),
        "2.0.0",
        temp.path(),
    );
    update.verify(b"test").unwrap();
    assert!(update.verify(b"tampered").is_err());
    assert!(update.install(b"tampered").is_err());
    assert_eq!(
        std::fs::read_dir(temp.path()).unwrap().count(),
        0,
        "Rejected bytes must not create an installer or staging files"
    );
}
#[test]
fn substituted_key_signature_and_announced_version_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let vectors = vectors();
    let key = vectors["public_key"].as_str().unwrap();
    let signature = vectors["signature"].as_str().unwrap();
    assert!(
        update(
            vectors["unversioned_public_key"].as_str().unwrap(),
            signature,
            "2.0.0",
            temp.path()
        )
        .verify(b"test")
        .is_err()
    );
    assert!(
        update(key, "invalid-signature", "2.0.0", temp.path())
            .verify(b"test")
            .is_err()
    );
    assert!(
        update(key, signature, "3.0.0", temp.path())
            .verify(b"test")
            .is_err()
    );
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}
#[test]
fn restored_unversioned_signature_cannot_disable_version_binding() {
    let temp = tempfile::tempdir().unwrap();
    let vectors = vectors();
    let update = update(
        vectors["unversioned_public_key"].as_str().unwrap(),
        vectors["unversioned_signature"].as_str().unwrap(),
        "2.0.0",
        temp.path(),
    );
    assert!(update.verify(b"test").is_err());
    assert!(update.install(b"test").is_err());
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}

/// Explicit protected-CI command only; ordinary offline tests need no release inputs.
#[test]
#[ignore = "requires actual protected-CI signed artifact manifest"]
fn protected_release_artifacts() {
    let manifest =
        std::env::var_os("AW_RELEASE_MANIFEST").expect("Missing signed artifact manifest");
    let manifest: Value = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    let artifacts = manifest["artifacts"].as_array().unwrap();
    assert!(!artifacts.is_empty());
    let temp = tempfile::tempdir().unwrap();
    for artifact in artifacts {
        let bytes = std::fs::read(artifact["path"].as_str().unwrap()).unwrap();
        assert!(!bytes.is_empty());
        let verifier = update(
            manifest["publicKey"].as_str().unwrap(),
            artifact["signature"].as_str().unwrap(),
            manifest["version"].as_str().unwrap(),
            temp.path(),
        );
        verifier
            .verify(&bytes)
            .expect("Release signature/version verification failed");
        let mut tampered = bytes;
        tampered[0] ^= 1;
        assert!(verifier.verify(&tampered).is_err());
    }
    assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
}
