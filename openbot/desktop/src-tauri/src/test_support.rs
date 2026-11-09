use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ROOT: AtomicU64 = AtomicU64::new(0);

/// Held by every test that binds or probes loopback ports, in every module. Tests run in
/// parallel, so one test's port could be taken by another between choosing it and using it.
/// A test that panics while holding it does not fail the others that wait for it.
#[allow(dead_code)] // The library's port tests use it; the binary shares this file.
static PORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[allow(dead_code)]
pub(crate) fn hold_ports() -> std::sync::MutexGuard<'static, ()> {
    PORT_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn temp_root(label: &str) -> PathBuf {
    let next = NEXT_TEMP_ROOT.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("openbot-{label}-{}-{next}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

/// The digest every fixture image is pinned to: the full 64 hex digits a release publishes.
pub(crate) fn fixture_digest() -> String {
    format!("sha256:{}", "a".repeat(64))
}

pub(crate) fn fixture_reference(image: &str) -> String {
    format!("ghcr.io/copilotkit/openbot-{image}@{}", fixture_digest())
}

/// Lay down what a finished fetch leaves: a manifest naming the stack's required images plus
/// `extra`, and the success stamp for the same version.
///
/// Resolution reads through the deployment's runtime boundary, which refuses a manifest without
/// a matching stamp, one that omits a required stack image, or one whose references are not
/// digest-pinned. A manifest alone is what an interrupted fetch leaves, not a release.
///
/// Shared by the library and the desktop binary: each names the deployment module `crate::deployment`.
pub(crate) fn installed_release<'a>(
    root: &std::path::Path,
    version: &str,
    extra: impl IntoIterator<Item = &'a str>,
) {
    let mut images = std::collections::BTreeMap::new();
    for name in crate::deployment::IMAGE_VARIABLES
        .iter()
        .map(|(published, _)| *published)
        .chain(extra)
    {
        images.insert(
            name.to_string(),
            crate::deployment::Image {
                reference: fixture_reference(name),
            },
        );
    }
    let manifest = crate::deployment::Images {
        version: version.to_string(),
        images,
    };
    std::fs::write(
        crate::deployment::images_path(root),
        serde_json::to_string(&manifest).unwrap(),
    )
    .expect("manifest is written");
    crate::deployment::record(root, version, false).expect("stamp is written");
}

/// Runtime PATH belongs to the scenario under test; the compiler and linker tools belong to
/// Cargo's build environment. Neither an inherited runtime RUSTC nor another test can replace it.
pub(crate) fn compile_fixture(source: &std::path::Path, binary: &std::path::Path) {
    let output = std::process::Command::new(env!("OPENBOT_TEST_RUSTC"))
        .env("PATH", env!("OPENBOT_TEST_TOOL_PATH"))
        // Source filenames can include executable suffixes, which are invalid crate names.
        .args(["--crate-name", "openbot_test_fixture"])
        .arg(source)
        .arg("-o")
        .arg(binary)
        .output()
        .expect("Cargo's Rust compiler should run for the native fixture");
    assert!(
        output.status.success(),
        "fixture did not compile: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Tests that replace the process environment run in their own exact-test child. The normal
/// parent suite stays parallel; unrelated HTTP, compiler, and ownership tests keep their PATH.
/// Return true in the parent after the child passes, so the caller can return immediately.
pub(crate) fn isolated_process(test: &str) -> bool {
    const MARKER: &str = "OPENBOT_ISOLATED_TEST";
    if std::env::var(MARKER).ok().as_deref() == Some(test) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(MARKER, test)
        .output()
        .expect("isolated test process should start");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "isolated test {test} failed or did not execute:\n{stdout}\n{stderr}"
    );
    true
}
