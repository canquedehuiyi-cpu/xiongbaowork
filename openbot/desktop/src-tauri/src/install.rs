//! Installing an engine, instead of telling somebody to go and get one.
//!
//! The person this app is for does not have a package manager, has never heard of Podman, and is
//! not going to read a release page. Every sentence that begins "install ..." is a step where an
//! install stops for good, so the engine is fetched and installed here.
//!
//! Two things are fetched, not one, and the second is the one that gets forgotten. Podman ships no
//! Compose implementation: `podman compose` looks for an external provider on PATH and, finding
//! none, answers with seven errors naming `docker-compose`. So a machine with a freshly installed
//! Podman still cannot raise the stack. Compose is a single static binary, which is why it can be
//! placed rather than installed.
//!
//! **Nothing fetched here is run unverified.** These files are executed, so each is pinned to the
//! digest of the release this was tested against, and a mismatch is refused rather than run.
//! Fetching a checksum from the same server that served the file would prove nothing.
//!
//! The three platforms install differently and only one of them is unattended:
//!
//! - **Windows.** The MSI is a per-user install, so it needs no elevation and lands in the profile
//!   of whoever runs it. That is also the trap: run from a service or an elevated helper it lands
//!   in `C:\Windows\system32\config\systemprofile`, where the person's own session cannot see it.
//!   Measured, on Windows Server 2022, by installing it from a service and then watching the app
//!   report no engine while `podman.exe` sat on disk. It has to run as them, which is where the app
//!   already runs.
//! - **macOS.** The package writes to `/opt/podman` and needs administrator rights, so the person
//!   sees one standard macOS authorization prompt. There is no way around that prompt and no reason
//!   to want one: it is the same dialog every other installer raises.
//! - **Linux.** Podman there is not a binary but a set of them (`conmon`, `crun`, `netavark`,
//!   `slirp4netns`), wired to the distribution's own paths, so downloading one file would produce
//!   something that runs nothing. The distribution's package manager installs it, through
//!   `pkexec`, which raises that desktop's own authorization prompt.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::engine::{self, Engine};
use crate::problem::Problem;

/// The releases this was tested against.
///
/// Pinned for the reason the deployment pins image digests: a version is what somebody hopes is
/// there, a digest is what was run. Moving these means re-recording the digests below.
pub const PODMAN: &str = "6.1.1";
pub const COMPOSE: &str = "5.5.1";
/// Keep aligned with the repository's packageManager and container runtime.
pub const BUN: &str = "1.3.14";

/// A file to fetch and the digest it has to have.
#[derive(Debug, PartialEq, Eq)]
pub struct Download {
    pub url: String,
    pub sha256: &'static str,
    /// What to call it on disk. Named rather than taken from the URL so a redirect cannot choose
    /// the filename.
    pub file: &'static str,
}

/// The Podman installer for this machine, or why there is not one.
///
/// The Intel Mac case is real and not hypothetical: Podman 6.1.1 publishes `arm64` only. Answering
/// with the arm64 package there would install something that cannot run, so it says so instead.
pub fn podman_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "podman-installer-windows-amd64.msi",
            "91d0e8ea0846c0151d531c88c329bb2729387231e4d1e42306a8e3ae9d09fc8a",
        ),
        ("windows", "aarch64") => (
            "podman-installer-windows-arm64.msi",
            "8ededac563c3b96abe55560f3379962ff59fd8bda1a185ed221891cb6ccf5cba",
        ),
        ("macos", "aarch64") => (
            "podman-installer-macos-arm64.pkg",
            "9c7b90b406681e5458d69cdb1164a589f7c9b214cab1ca6705fe375876491c09",
        ),
        ("macos", _) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on an Intel Mac. Install Podman \
                 Desktop or Docker Desktop, then start OpenBot again.",
                format!("Podman {PODMAN} publishes an arm64 package only"),
            ))
        }
        ("linux", _) => {
            return Err(Problem::plain(
                "On Linux the engine comes from the distribution's own packages.",
            ))
        }
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the container engine on this kind of computer.",
                format!("no Podman installer for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!(
            "https://github.com/podman-container-tools/podman/releases/download/v{PODMAN}/{file}"
        ),
        sha256,
        file,
    })
}

/// The Compose provider for this machine.
///
/// One static binary on every platform, which is the whole reason this can be placed beside the
/// engine rather than installed into the system.
pub fn compose_download() -> Result<Download, Problem> {
    let (file, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "docker-compose-windows-x86_64.exe",
            "a3c0c73033eaede90210345d0cc2233edf4fab8fe0282a91dad8fd8436809d2f",
        ),
        ("windows", "aarch64") => (
            "docker-compose-windows-aarch64.exe",
            "4bbb5d1ecc75bde1a9ca4afac43f5907c0d3bd0f88c7f00bf481ee7c8c1737be",
        ),
        ("macos", "x86_64") => (
            "docker-compose-darwin-x86_64",
            "a264d61e824bf08a78867e59cdf32eb09f0aee9ecdf9f6ebfa43f76dc52880f1",
        ),
        ("macos", "aarch64") => (
            "docker-compose-darwin-aarch64",
            "998735c9b6fe68a4f05895e6ea73d71ad06f9fc7046383ad89e47346781b6af5",
        ),
        ("linux", "x86_64") => (
            "docker-compose-linux-x86_64",
            "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576",
        ),
        ("linux", "aarch64") => (
            "docker-compose-linux-aarch64",
            "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7",
        ),
        (os, arch) => {
            return Err(Problem::with(
                "OpenBot cannot install the piece that runs the containers on this kind of \
                 computer.",
                format!("no Compose build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/docker/compose/releases/download/v{COMPOSE}/{file}"),
        sha256,
        file,
    })
}

/// Fetch to `into`, refusing anything whose digest is not the pinned one.
///
/// A file already there with the right digest is kept, so a retry after a failed install is not a
/// second download. A file already there with the wrong one is replaced: that is a half-written
/// download far more often than it is an attack, and either way it must not be run.
fn fetch_verified(download: &Download, into: &Path) -> Result<PathBuf, Problem> {
    let path = into.join(download.file);
    if let Ok(existing) = std::fs::read(&path) {
        if digest_of(&existing) == download.sha256 {
            return Ok(path);
        }
    }

    let body = crate::deployment::get(&download.url).map_err(|error| {
        Problem::with(
            "OpenBot could not download the software it needs to run. Check the internet \
             connection and try again.",
            format!("{}: {error}", download.url),
        )
    })?;

    let got = digest_of(&body);
    if got != download.sha256 {
        return Err(Problem::with(
            "What OpenBot downloaded is not what it was expecting, so it has not been run. Try \
             again.",
            format!(
                "{} from {}: expected sha256 {}, got {got}",
                download.file, download.url, download.sha256
            ),
        ));
    }

    std::fs::create_dir_all(into).map_err(|error| unwritable(into, &error.to_string()))?;
    std::fs::write(&path, &body).map_err(|error| unwritable(&path, &error.to_string()))?;
    Ok(path)
}

/// One sentence for every "could not write here", because the person's fix is the same each time.
fn unwritable(path: &Path, error: &str) -> Problem {
    Problem::with(
        "OpenBot could not save the software it downloaded. Check there is free disk space and \
         try again.",
        format!("{}: {error}", path.display()),
    )
}

fn digest_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A fresh account has no developer tools. Acquire the host runtime as that user,
/// without changing PATH or requiring an administrator. Existing installations remain usable.
pub fn ensure_bun(cache: &Path, existing: Option<PathBuf>) -> Result<PathBuf, Problem> {
    let into = ordinary_absolute(&crate::acquire::download_dir(cache).join(format!("bun-{BUN}")))?;
    let target = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    ensure_bun_selected(existing, &target, verify_bun, || install_bun(cache))
}

fn ensure_bun_with(
    existing: Option<PathBuf>,
    install: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    match existing {
        Some(path) if verify_bun(&path).is_ok() => Ok(path),
        _ => install(),
    }
}

fn bun_download(os: &str, arch: &str) -> Result<Download, Problem> {
    // Official bun-v1.3.14/SHASUMS256.txt. The baseline x64 build also supports older CPUs.
    let (file, sha256) = match (os, arch) {
        ("windows", "x86_64") => (
            "bun-windows-x64-baseline.zip",
            "538f9c846355d9e847b2671bc00c47da4229a0befb24df3282b739770f3b475f",
        ),
        ("windows", "aarch64") => (
            "bun-windows-aarch64.zip",
            "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953",
        ),
        ("macos", "x86_64") => (
            "bun-darwin-x64-baseline.zip",
            "3e35ad6f53971a9834bf9e6786e2adf72b5f1921cc9a9c5fde073d2972944076",
        ),
        ("macos", "aarch64") => (
            "bun-darwin-aarch64.zip",
            "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
        ),
        ("linux", "x86_64") => (
            "bun-linux-x64-baseline.zip",
            "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
        ),
        ("linux", "aarch64") => (
            "bun-linux-aarch64.zip",
            "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
        ),
        _ => {
            return Err(Problem::with(
                "OpenBot cannot install its app runtime on this kind of computer.",
                format!("no Bun {BUN} build for {os} on {arch}"),
            ))
        }
    };
    Ok(Download {
        url: format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}"),
        sha256,
        file,
    })
}

fn install_bun(cache: &Path) -> Result<PathBuf, Problem> {
    let download = bun_download(std::env::consts::OS, std::env::consts::ARCH)?;
    let entry = format!(
        "{}/bun{}",
        download.file.trim_end_matches(".zip"),
        std::env::consts::EXE_SUFFIX,
    );
    let into = crate::acquire::download_dir(cache).join(format!("bun-{BUN}"));
    repair_managed_bun(&into, &download, &entry, &mut NativeBunRepair)
}

// Managed Bun repair assumes a user-controlled cache, not a hostile same-UID
// directory replacer. Metadata checks are not an atomic directory-handle CAS.
fn managed_error(detail: impl Into<String>) -> Problem {
    Problem::with("OpenBot could not safely repair its local runtime. Return to Install and try again.", detail)
}

fn ordinary_absolute(path: &Path) -> Result<PathBuf, Problem> {
    let path = if path.is_absolute() { path.to_path_buf() } else {
        std::env::current_dir().map_err(|e| managed_error(e.to_string()))?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => return Err(managed_error("A runtime locator contains '..'; its ownership is unclear.")),
            std::path::Component::CurDir => {},
            component => normalized.push(component.as_os_str()),
        }
    }
    if !normalized.is_absolute() { return Err(managed_error("A runtime locator is not an absolute ordinary path")); }
    Ok(normalized)
}

fn reparse_or_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 { return true; }
    }
    false
}

fn guarded_directories(path: &Path, create: bool) -> Result<(), Problem> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_)) { continue; }
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
                std::fs::create_dir(&current).map_err(|e| managed_error(format!("Could not create {}: {e}", current.display())))?;
                std::fs::symlink_metadata(&current).map_err(|e| managed_error(e.to_string()))?
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(managed_error(format!("Could not inspect {}: {e}", current.display()))),
        };
        if reparse_or_link(&metadata) || !metadata.is_dir() {
            return Err(managed_error(format!("Managed runtime directory is a link, reparse point or non-directory: {}", current.display())));
        }
    }
    Ok(())
}

fn guarded_regular(path: &Path) -> Result<Option<std::fs::Metadata>, Problem> {
    guarded_directories(path.parent().ok_or_else(|| managed_error("Runtime path has no parent"))?, false)?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !reparse_or_link(&metadata) && metadata.is_file() => Ok(Some(metadata)),
        Ok(_) => Err(managed_error(format!("Managed runtime entry is a link, reparse point or special file: {}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(managed_error(format!("Could not inspect {}: {e}", path.display()))),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BunIdentity {
    digest: String,
    length: u64,
    modified: std::time::SystemTime,
    readonly: bool,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    created: u64,
}

fn bun_identity(path: &Path) -> Result<Option<BunIdentity>, Problem> {
    use std::io::Read;
    let Some(before) = guarded_regular(path)? else { return Ok(None); };
    let mut file = std::fs::File::open(path).map_err(|e| managed_error(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| managed_error(e.to_string()))?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|e| managed_error(e.to_string()))?;
    let modified = before.modified().map_err(|e| managed_error(e.to_string()))?;
    if before.len() != after.len() || modified != after.modified().map_err(|e| managed_error(e.to_string()))? {
        return Err(managed_error("Runtime entry changed during inspection"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return Err(managed_error("Runtime entry changed during inspection"));
        }
    }
    Ok(Some(BunIdentity {
        digest: format!("{:x}", hash.finalize()), length: after.len(), modified,
        readonly: after.permissions().readonly(),
        #[cfg(unix)] device: { use std::os::unix::fs::MetadataExt; after.dev() },
        #[cfg(unix)] inode: { use std::os::unix::fs::MetadataExt; after.ino() },
        #[cfg(windows)] created: { use std::os::windows::fs::MetadataExt; after.creation_time() },
    }))
}

fn same_bun(path: &Path, expected: &BunIdentity) -> Result<bool, Problem> {
    Ok(bun_identity(path)?.as_ref() == Some(expected))
}

fn locator_has_link(path: &Path) -> Result<bool, Problem> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_)) { continue; }
        let metadata = std::fs::symlink_metadata(&current)
            .map_err(|e| managed_error(format!("Could not classify runtime locator: {e}")))?;
        if reparse_or_link(&metadata) { return Ok(true); }
    }
    Ok(false)
}

#[derive(Debug, PartialEq, Eq)]
enum ExistingBunLocator { Managed, External, ManagedAlias }

fn same_bun_locator(left: &Path, right: &Path) -> Result<bool, Problem> {
    #[cfg(windows)]
    {
        // Compare ordinary spellings, without following the managed entry.
        // canonicalize may add a verbatim prefix; ASCII case is not path identity
        // on Windows. Non-UTF8/unresolved spellings remain a classification error.
        fn key(path: &Path) -> Result<String, Problem> {
            let text = path.to_str().ok_or_else(|| managed_error("Runtime locator spelling is not classifiable"))?;
            let text = text.strip_prefix("\\\\?\\").unwrap_or(text);
            let ordinary = if let Some(unc) = text.strip_prefix("UNC\\") { format!("\\\\{unc}") } else { text.to_string() };
            Ok(ordinary.to_ascii_lowercase())
        }
        Ok(key(left)? == key(right)?)
    }
    #[cfg(not(windows))]
    { Ok(left == right) }
}

// Preserve raw link components: the bounded walker checks every preceding
// locator (including managed entries and links) BEFORE consuming ParentDir.
// User-supplied ordinary locators still reject '..'.
fn link_locator(path: &Path) -> Result<PathBuf, Problem> {
    if !path.is_absolute() { return Err(managed_error("Linked runtime locator is not absolute")); }
    Ok(path.to_path_buf())
}

fn classify_existing_bun(existing: &Path, target: &Path) -> Result<ExistingBunLocator, Problem> {
    classify_bun_candidate(existing, target)?
        .ok_or_else(|| managed_error("The selected runtime locator does not exist"))
}

// Missing candidates are distinct from unreadable, ambiguous or managed aliases.
// This same bounded walker serves passive search and the existing direct API.
fn classify_bun_candidate(existing: &Path, target: &Path) -> Result<Option<ExistingBunLocator>, Problem> {
    let mut pending = ordinary_absolute(existing)?;
    if same_bun_locator(&pending, target)? { return Ok(Some(ExistingBunLocator::Managed)); }
    let mut followed_link = false;
    let mut hops = 0usize;
    let mut inspected = 0usize;
    loop {
        let components: Vec<_> = pending.components().collect();
        let mut current = PathBuf::new();
        let mut replacement = None;
        for (index, component) in components.iter().enumerate() {
            inspected += 1;
            if inspected > 4096 { return Err(managed_error("Runtime locator classification exceeds its component bound")); }
            match component {
                std::path::Component::ParentDir => {
                    // The preceding component has already passed the managed/link
                    // checks below. Never erase it before observing its identity.
                    if !matches!(current.components().next_back(), Some(std::path::Component::Normal(_))) || !current.pop() {
                        return Err(managed_error("Linked runtime locator leaves its root"));
                    }
                    continue;
                },
                std::path::Component::CurDir => continue,
                component => current.push(component.as_os_str()),
            }
            if matches!(component, std::path::Component::Prefix(_)) { continue; }
            // Stop BEFORE following even an unhealthy managed entry. Comparing
            // canonical(target) would reverse a managed link into a good external.
            if same_bun_locator(&current, target)? {
                return Ok(Some(if followed_link { ExistingBunLocator::ManagedAlias } else { ExistingBunLocator::Managed }));
            }
            let metadata = match std::fs::symlink_metadata(&current) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !followed_link => return Ok(None),
                Err(error) => return Err(managed_error(format!("Could not classify external runtime locator: {error}"))),
            };
            if reparse_or_link(&metadata) {
                hops += 1;
                if hops > 32 { return Err(managed_error("Runtime locator classification exceeds its link bound")); }
                let link = std::fs::read_link(&current)
                    .map_err(|e| managed_error(format!("Could not classify runtime link/reparse locator: {e}")))?;
                let mut next = if link.is_absolute() { link } else {
                    current.parent().ok_or_else(|| managed_error("Linked runtime locator has no parent"))?.join(link)
                };
                for rest in &components[index + 1..] { next.push(rest.as_os_str()); }
                replacement = Some(link_locator(&next)?);
                followed_link = true;
                break;
            }
        }
        if let Some(next) = replacement { pending = next; continue; }
        // Keep the existing canonicalization-failure refusal. This only resolves
        // the external locator; unrelated managed directories are never inspected.
        let resolved = std::fs::canonicalize(existing)
            .map_err(|e| managed_error(format!("Could not establish the external runtime locator: {e}")))?;
        let resolved = ordinary_absolute(&resolved)?;
        if same_bun_locator(&resolved, target)? {
            return Ok(Some(if followed_link { ExistingBunLocator::ManagedAlias } else { ExistingBunLocator::Managed }));
        }
        if !same_bun_locator(&resolved, &current)? {
            return Err(managed_error("Runtime locator has an unresolved non-ordinary alias"));
        }
        return Ok(Some(ExistingBunLocator::External));
    }
}

fn ensure_bun_selected(
    existing: Option<PathBuf>, target: &Path,
    verify: impl FnOnce(&Path) -> Result<(), Problem>,
    install: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    if let Some(existing) = existing {
        match classify_existing_bun(&existing, target)? {
            ExistingBunLocator::Managed => {
                guarded_regular(target)?;
                return install();
            },
            ExistingBunLocator::ManagedAlias => return Err(managed_error("An external runtime alias points at the managed locator; use the direct managed installation instead.")),
            ExistingBunLocator::External => {
                if verify(&existing).is_ok() { return Ok(existing); }
            },
        }
    }
    // Managed preflight belongs to the selected installation path, not to
    // independent external reuse. The repair coordinator performs that preflight.
    install()
}

// New explicit-Install entry; keep ensure_bun's existing public interface.
// PATH/home/cwd are captured by the caller without launching any process.
pub fn ensure_bun_from_search(
    cache: &Path,
    path: Option<&std::ffi::OsStr>,
    home: Option<&Path>,
    cwd: &Path,
) -> Result<PathBuf, Problem> {
    let into = ordinary_absolute(&crate::acquire::download_dir(cache).join(format!("bun-{BUN}")))?;
    let target = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    ensure_bun_from_search_with(path, home, cwd, &target, probe_bun_candidate, || install_bun(cache))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BunCandidateProbe {
    Supported,
    // Failed spawn or a non-zero exit permits PATH -> HOME fallback.
    Failed,
    // A successful process with a different version must select managed repair.
    Unsupported,
}

fn probe_bun_candidate(binary: &Path) -> BunCandidateProbe {
    match crate::quiet::command(binary).arg("--version").output() {
        Err(_) => BunCandidateProbe::Failed,
        Ok(output) if !output.status.success() => BunCandidateProbe::Failed,
        Ok(output) if String::from_utf8_lossy(&output.stdout).trim() == BUN => BunCandidateProbe::Supported,
        Ok(_) => BunCandidateProbe::Unsupported,
    }
}

// Retain relative PATH components, including link evidence, when making the
// locator absolute. The classifier, not discovery, adjudicates '..'/aliases.
fn search_locator(cwd: &Path, path: &Path) -> Result<PathBuf, Problem> {
    if !cwd.is_absolute() { return Err(managed_error("Runtime search cwd must be absolute")); }
    Ok(if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) })
}

fn passive_bun_candidate(
    candidate: PathBuf, target: &Path,
) -> Result<Option<(PathBuf, ExistingBunLocator)>, Problem> {
    match classify_bun_candidate(&candidate, target)? {
        None => Ok(None),
        Some(ExistingBunLocator::External) => {
            // Classification has already observed every link/managed boundary.
            // Refuse special files/directories rather than attempt a process.
            let metadata = std::fs::metadata(&candidate)
                .map_err(|error| managed_error(format!("Could not inspect classified runtime candidate: {error}")))?;
            if !metadata.is_file() { return Err(managed_error("External runtime candidate is not a regular file")); }
            Ok(Some((candidate, ExistingBunLocator::External)))
        },
        Some(ExistingBunLocator::Managed) => match guarded_regular(&candidate)? {
            // Passive search must distinguish an absent exact managed entry
            // from a found candidate, so a later PATH entry remains eligible.
            None => Ok(None),
            Some(_) => Ok(Some((candidate, ExistingBunLocator::Managed))),
        },
        Some(kind) => Ok(Some((candidate, kind))),
    }
}

fn selected_bun_candidate(
    candidate: (PathBuf, ExistingBunLocator), target: &Path,
    probe: &mut impl FnMut(&Path) -> BunCandidateProbe,
) -> Result<(Option<PathBuf>, bool), Problem> {
    match candidate {
        (_, ExistingBunLocator::ManagedAlias) => Err(managed_error("An external runtime alias points at the managed locator; use the direct managed installation instead.")),
        (_, ExistingBunLocator::Managed) => {
            guarded_regular(target)?;
            Ok((None, false)) // Direct managed entry goes through guarded repair/reuse.
        },
        (locator, ExistingBunLocator::External) => match probe(&locator) {
            BunCandidateProbe::Supported => Ok((Some(locator), false)),
            BunCandidateProbe::Failed => Ok((None, true)),
            BunCandidateProbe::Unsupported => Ok((None, false)),
        },
    }
}

// Production coordinator plus real passive resolver. Only process probing and
// managed acquisition are injected for inline CPU fixture definitions.
fn ensure_bun_from_search_with(
    path: Option<&std::ffi::OsStr>, home: Option<&Path>, cwd: &Path,
    target: &Path, mut probe: impl FnMut(&Path) -> BunCandidateProbe,
    acquire: impl FnOnce() -> Result<PathBuf, Problem>,
) -> Result<PathBuf, Problem> {
    if let Some(path) = path {
        for directory in std::env::split_paths(path) {
            let locator = search_locator(cwd, &directory.join(if cfg!(windows) { "bun.exe" } else { "bun" }))?;
            if let Some(candidate) = passive_bun_candidate(locator, target)? {
                let (supported, fallback) = selected_bun_candidate(candidate, target, &mut probe)?;
                if let Some(locator) = supported { return Ok(locator); }
                if !fallback { return acquire(); }
                break; // First located PATH candidate failed; retain HOME fallback order.
            }
        }
    }
    if let Some(home) = home {
        for relative in [".bun/bin/bun", ".bun/bin/bun.exe"] {
            let locator = search_locator(cwd, &home.join(relative))?;
            if let Some(candidate) = passive_bun_candidate(locator, target)? {
                let (supported, _) = selected_bun_candidate(candidate, target, &mut probe)?;
                return match supported { Some(locator) => Ok(locator), None => acquire() };
            }
        }
    }
    acquire()
}

trait BunRepairOps {
    fn archive(&mut self, download: &Download, into: &Path, work: &Path) -> Result<PathBuf, Problem> {
        guarded_bun_archive(download, into, work)
    }
    fn extract(&mut self, archive: &Path, stage: &Path, entry: &str) -> Result<(), Problem> {
        extract_bun(archive, stage, entry)
    }
    fn verify(&mut self, binary: &Path) -> Result<(), Problem> { verify_bun(binary) }
    fn quarantine(&mut self, source: &Path, target: &Path) -> std::io::Result<()> { std::fs::rename(source, target) }
    fn link(&mut self, source: &Path, target: &Path) -> std::io::Result<()> { std::fs::hard_link(source, target) }
    fn remove(&mut self, path: &Path) -> std::io::Result<()> { std::fs::remove_file(path) }
}
struct NativeBunRepair;
impl BunRepairOps for NativeBunRepair {}

fn guarded_bun_archive(download: &Download, into: &Path, work: &Path) -> Result<PathBuf, Problem> {
    use std::io::Write;
    let cached = into.join(download.file);
    if guarded_regular(&cached)?.is_some() {
        let bytes = std::fs::read(&cached).map_err(|e| managed_error(e.to_string()))?;
        if digest_of(&bytes) == download.sha256 { return Ok(cached); }
    }
    let bytes = crate::deployment::get(&download.url).map_err(managed_error)?;
    if digest_of(&bytes) != download.sha256 { return Err(managed_error("The managed runtime archive does not match its pinned digest")); }
    let archive = work.join("archive.zip");
    if guarded_regular(&archive)?.is_some() { return Err(managed_error("The private archive path is already occupied")); }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&archive).map_err(|e| managed_error(e.to_string()))?;
    file.write_all(&bytes).and_then(|()| file.sync_all()).map_err(|e| managed_error(e.to_string()))?;
    Ok(archive)
}

fn remove_owned(ops: &mut impl BunRepairOps, path: &Path, expected: &BunIdentity) -> Result<(), Problem> {
    if !same_bun(path, expected)? { return Err(managed_error(format!("Owned runtime cleanup identity changed: {}", path.display()))); }
    ops.remove(path).map_err(|e| managed_error(format!("Could not clean owned runtime entry {}: {e}", path.display())))
}

struct BunPublication {
    binary: PathBuf,
    stage: Option<(PathBuf, BunIdentity)>,
    recovery: Option<PathBuf>,
}

fn finish_bun_publication(publication: BunPublication, ops: &mut impl BunRepairOps) -> Result<PathBuf, Problem> {
    if let Some((stage, identity)) = publication.stage {
        // Final target check is after owned-lock cleanup. Unknown publication
        // keeps the independent staged link and quarantine for recovery.
        if !same_bun(&publication.binary, &identity)? {
            return Err(managed_error(format!("Final published identity is unknown; recovery retained at {}", publication.recovery.as_ref().unwrap().display())));
        }
        guarded_regular(&publication.binary)?.ok_or_else(|| managed_error("Published runtime disappeared"))?;
        ops.verify(&publication.binary).map_err(|p| managed_error(format!("{}; recovery retained at {}", p.detail.unwrap_or(p.said), publication.recovery.as_ref().unwrap().display())))?;
        if !same_bun(&publication.binary, &identity)? {
            return Err(managed_error("Runtime changed during its final verification; staging and quarantine retained"));
        }
        // No target deletion or overwrite follows this observation. Failure to
        // unlink our temporary alias returns Err and never rolls back a healthy target.
        remove_owned(ops, &stage, &identity)?;
    }
    Ok(publication.binary)
}

fn repair_managed_bun(
    into: &Path, download: &Download, entry: &str, ops: &mut impl BunRepairOps,
) -> Result<PathBuf, Problem> {
    let into = ordinary_absolute(into)?;
    guarded_directories(&into, true)?;
    let binary = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    guarded_regular(&into.join(download.file))?;
    if guarded_regular(&binary)?.is_some() && ops.verify(&binary).is_ok() { return Ok(binary); }
    let lock_path = into.join("bun.repair.lock");
    // create_new never follows an existing lock symlink or guesses a stale lock.
    let lock = std::fs::OpenOptions::new().write(true).create_new(true).open(&lock_path)
        .map_err(|e| managed_error(format!("Managed runtime repair is busy or cannot acquire its lock: {e}")))?;
    let lock_identity = match bun_identity(&lock_path) {
        Ok(Some(identity)) => identity,
        _ => { drop(lock); return Err(managed_error(format!("Owned lock identity is unknown; preserved at {}", lock_path.display()))); }
    };
    let result = repair_locked_bun(&into, &binary, download, entry, ops);
    drop(lock);
    let cleanup = remove_owned(ops, &lock_path, &lock_identity);
    match (result, cleanup) {
        (Ok(publication), Ok(())) => finish_bun_publication(publication, ops),
        (Err(error), Ok(())) => Err(error),
        (result, Err(cleanup)) => Err(managed_error(format!("{}; {}", result.err().map(|p| p.detail.unwrap_or(p.said)).unwrap_or_else(|| "The healthy published target was retained".into()), cleanup.detail.unwrap_or(cleanup.said)))),
    }
}

fn repair_locked_bun(
    into: &Path, binary: &Path, download: &Download, entry: &str, ops: &mut impl BunRepairOps,
) -> Result<BunPublication, Problem> {
    // Recheck after acquiring the cross-process repair lock.
    let old = bun_identity(binary)?;
    if old.is_some() && ops.verify(binary).is_ok() {
        return Ok(BunPublication { binary: binary.to_path_buf(), stage: None, recovery: None });
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let work = into.join(format!("bun.repair-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir(&work).map_err(|e| managed_error(format!("Could not exclusively create repair staging: {e}")))?;
    guarded_directories(&work, false)?;
    let stage = work.join(format!("bun.stage{}", std::env::consts::EXE_SUFFIX));
    let quarantine = work.join(format!("bun.previous{}", std::env::consts::EXE_SUFFIX));
    let prepared = (|| {
        let archive = ops.archive(download, into, &work)?;
        guarded_regular(&archive)?.ok_or_else(|| managed_error("The verified archive is missing"))?;
        // Check even injected archive providers: extraction never gets unverified bytes.
        let bytes = std::fs::read(&archive).map_err(|e| managed_error(e.to_string()))?;
        if digest_of(&bytes) != download.sha256 { return Err(managed_error("The runtime archive digest is wrong")); }
        if guarded_regular(&stage)?.is_some() { return Err(managed_error("The private staging target is occupied")); }
        ops.extract(&archive, &stage, entry)?;
        guarded_regular(&stage)?.ok_or_else(|| managed_error("The staged runtime is missing"))?;
        ops.verify(&stage)?;
        bun_identity(&stage)?.ok_or_else(|| managed_error("The verified staged runtime disappeared"))
    })();
    let staged = match prepared {
        Ok(identity) => identity,
        Err(error) => return Err(managed_error(format!("{}; old target was not published over; private staging retained at {}", error.detail.unwrap_or(error.said), work.display()))),
    };
    guarded_directories(into, false)?;
    if bun_identity(binary)? != old { return Err(managed_error(format!("Target changed before publication; staging retained at {}", work.display()))); }
    if let Some(old) = &old {
        if guarded_regular(&quarantine)?.is_some() { return Err(managed_error("The private quarantine is occupied")); }
        ops.quarantine(binary, &quarantine).map_err(|e| managed_error(format!("Could not quarantine old runtime; no publish attempted: {e}; recovery directory {}", work.display())))?;
        if !same_bun(&quarantine, old)? { return Err(managed_error(format!("Quarantine identity is unknown; retained at {}", work.display()))); }
    }
    if let Err(error) = ops.link(&stage, binary) {
        let recovery = (|| {
            if guarded_regular(binary)?.is_some() { return Ok("target exists; it was neither overwritten nor removed".to_string()); }
            let Some(old) = &old else { return Ok("fresh target remains absent".into()); };
            if !same_bun(&quarantine, old)? { return Err(managed_error("quarantine identity changed; no rollback attempted")); }
            ops.link(&quarantine, binary).map_err(|e| managed_error(format!("create-only rollback failed: {e}")))?;
            if !same_bun(binary, old)? { return Err(managed_error("rollback target identity is unknown")); }
            Ok("known bad old runtime restored for explicit retry, not success".into())
        })();
        return Err(managed_error(format!("Create-only runtime publication failed: {error}; {}; staging/quarantine retained at {}", recovery.unwrap_or_else(|p: Problem| p.detail.unwrap_or(p.said)), work.display())));
    }
    // The target must still be exactly our staged file before reporting success.
    if !same_bun(binary, &staged)? { return Err(managed_error(format!("Published runtime identity is unknown; retained at {}", work.display()))); }
    // The successful repair keeps quarantine and private archive as recovery evidence.
    // Final target verification and owned stage-alias cleanup happen only after
    // owned-lock cleanup; a lock-cleanup failure retains the staged recovery link.
    Ok(BunPublication { binary: binary.to_path_buf(), stage: Some((stage, staged)), recovery: Some(work) })
}

fn install_bun_with(
    into: &Path,
    download: &Download,
    extract: impl FnOnce(&Path, &Path) -> Result<(), Problem>,
    verify: impl Fn(&Path) -> Result<(), Problem>,
) -> Result<PathBuf, Problem> {
    let binary = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
    if binary.is_file() {
        verify(&binary)?;
        return Ok(binary);
    }
    let archive = fetch_verified(download, into)?;
    let staged = into.join(format!("bun.download{}", std::env::consts::EXE_SUFFIX));
    let result = extract(&archive, &staged)
        .and_then(|()| verify(&staged))
        .and_then(|()| {
            std::fs::rename(&staged, &binary)
                .map_err(|error| unwritable(&binary, &error.to_string()))
        });
    if let Err(mut problem) = result {
        if let Err(error) = std::fs::remove_file(&staged) {
            if error.kind() != std::io::ErrorKind::NotFound {
                problem.detail = Some(format!(
                    "{}; could not remove incomplete runtime {}: {error}",
                    problem.detail.as_deref().unwrap_or(&problem.said),
                    staged.display(),
                ));
            }
        }
        return Err(problem);
    }
    Ok(binary)
}

fn extract_bun(archive: &Path, target: &Path, entry: &str) -> Result<(), Problem> {
    let unpack_error = |error: &dyn std::fmt::Display| {
        Problem::with(
            "OpenBot could not unpack its app runtime. Try again.",
            format!("{} entry {entry}: {error}", archive.display()),
        )
    };

    // Only the named executable is copied to our chosen staging path. Archive paths never
    // choose output locations, and installation needs no external archive utility or shell.
    let file = std::fs::File::open(archive).map_err(|error| unpack_error(&error))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| unpack_error(&error))?;
    let mut executable = zip.by_name(entry).map_err(|error| unpack_error(&error))?;
    let mut file =
        std::fs::File::create(target).map_err(|error| unwritable(target, &error.to_string()))?;
    std::io::copy(&mut executable, &mut file).map_err(|error| unpack_error(&error))?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| unwritable(target, &error.to_string()))?;
    }
    Ok(())
}

pub(crate) fn verify_bun(binary: &Path) -> Result<(), Problem> {
    let output = crate::quiet::command(binary)
        .arg("--version")
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start its app runtime.",
                format!("{}: {error}", binary.display()),
            )
        })?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != BUN {
        return Err(Problem::with(
            "OpenBot could not verify its app runtime.",
            format!(
                "{} --version: {}; expected {BUN}; stdout: {}; stderr: {}",
                binary.display(),
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        ));
    }
    Ok(())
}

/// Put the engine on this machine, and a Compose it can run.
///
/// Both halves, in that order, because the second is invisible until the first has succeeded and
/// somebody presses Start. Answers with the sentence for the step row, or a failure in both
/// registers.
pub fn install_engine(cache: &Path) -> Result<String, Problem> {
    install_engine_observed(cache, |_| {})
}

/// Observe an actual Podman installer invocation, excluding existing engines and Compose repair.
pub fn install_engine_observed(
    cache: &Path,
    installed: impl FnMut(bool),
) -> Result<String, Problem> {
    install_engine_with(cache, installed, install_podman, place_compose)
}

fn install_engine_with(
    cache: &Path,
    mut installed: impl FnMut(bool),
    install_podman: impl FnOnce(&Path) -> Result<(), Problem>,
    place_compose: impl FnOnce(&Path) -> Result<String, Problem>,
) -> Result<String, Problem> {
    let into = crate::acquire::download_dir(cache);

    // engine_ready can start an installed Podman machine, but cannot start Docker. A stopped
    // Docker CLI must not skip installing the Podman that preparation will then try to run.
    if engine::program(Engine::Podman).is_some()
        || engine::Address::new(Engine::Docker, None).responds()
    {
        return place_compose(&into);
    }

    let result = install_podman(&into);
    installed(result.is_ok());
    result?;

    // Installed is not found. The MSI extends the *user's* PATH and this process was started with
    // the old one, so the engine is looked for where the installer puts it rather than on PATH. If
    // that lookup fails the install genuinely did nothing, and saying so beats a later screen
    // reporting no engine on a machine that has just installed one.
    if engine::program(Engine::Podman).is_none() {
        return Err(Problem::with(
            "OpenBot installed the container engine, but cannot find it afterwards. Install \
             Podman Desktop and start OpenBot again.",
            format!(
                "the {PODMAN} installer reported success; podman is on neither PATH nor any \
                 install location this platform uses"
            ),
        ));
    }

    place_compose(&into)?;
    Ok(format!("Podman {PODMAN} and Compose {COMPOSE} installed."))
}

/// Place the Compose provider where the engine will find it, unless something already provides one.
///
/// Nothing is placed when Compose already answers. Docker Desktop ships a provider, and a Linux
/// machine may have `docker-compose-v2` from its own packages; putting a second one in front of
/// either is a version somebody did not choose.
fn place_compose(into: &Path) -> Result<String, Problem> {
    if crate::acquire::address().composes() {
        return Ok("Compose is already here.".into());
    }

    let download = compose_download()?;
    let staged = fetch_verified(&download, into)?;

    let bin = engine::tools_dir_under(into);
    std::fs::create_dir_all(&bin).map_err(|error| unwritable(&bin, &error.to_string()))?;

    // The name matters: Podman looks up a provider called `docker-compose`, so a binary called
    // whatever the release asset was called is a provider nothing finds.
    let named = bin.join(compose_provider_name());
    std::fs::copy(&staged, &named).map_err(|error| unwritable(&named, &error.to_string()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| {
                Problem::with(
                    "OpenBot could not finish installing the piece that runs the containers.",
                    format!("chmod 755 {}: {error}", named.display()),
                )
            },
        )?;
    }

    Ok(format!("Compose {COMPOSE} installed."))
}

/// The filename Podman looks a provider up by.
pub fn compose_provider_name() -> &'static str {
    if cfg!(windows) {
        "docker-compose.exe"
    } else {
        "docker-compose"
    }
}

#[cfg(target_os = "windows")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let msi = fetch_verified(&download, into)?;
    let log = into.join("podman-install.log");
    install_podman_msi(&msi, &log, msiexec)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn install_podman_msi(
    msi: &Path,
    log: &Path,
    mut run: impl FnMut(&[&str], &Path, &Path) -> Result<(), MsiexecFailure>,
) -> Result<(), Problem> {
    match run(&["/i"], msi, log) {
        Ok(()) => return Ok(()),
        // 1603 is "fatal error during installation", which is what Windows says when a product it
        // still believes is installed cannot be repaired. Measured on a machine where a previous
        // Podman had been removed by deleting its folder: the registration survived, so `/i`
        // became a reconfigure, and the reconfigure had no source to read from. Somebody who once
        // uninstalled Podman by dragging it to the bin arrives here.
        Err(MsiexecFailure::Exit(1603)) => {}
        Err(error) => return Err(installer_stopped("/i", msi, error, log)),
    }

    // Remove the registration, then install cleanly. `/x` does not need the original source, so
    // it succeeds where the repair could not. If cleanup itself fails, retrying `/i` only hides the
    // step that left the broken registration behind.
    run(&["/x"], msi, log).map_err(|error| installer_stopped("/x", msi, error, log))?;
    run(&["/i"], msi, log).map_err(|error| installer_stopped("/i", msi, error, log))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum MsiexecFailure {
    Exit(i32),
    Start(String),
}

/// Run msiexec quietly and answer with its exit code when it is not success.
///
/// `/qn` and not `/passive`: a progress bar somebody cannot cancel is worse than the app's own
/// step, which says what is happening and can be retried. The log is kept because msiexec's exit
/// code alone does not say which action failed, and it is what turned 1603 into a diagnosis.
#[cfg(target_os = "windows")]
fn msiexec(verb: &[&str], msi: &Path, log: &Path) -> Result<(), MsiexecFailure> {
    let output = crate::quiet::command("msiexec")
        .args(verb)
        .arg(msi)
        .args(["/qn", "/norestart", "/l*v"])
        .arg(log)
        .output()
        .map_err(|error| MsiexecFailure::Start(error.to_string()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(MsiexecFailure::Exit(output.status.code().unwrap_or(-1)))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn installer_stopped(verb: &str, msi: &Path, failure: MsiexecFailure, log: &Path) -> Problem {
    match failure {
        MsiexecFailure::Start(error) => Problem::with(
            "OpenBot could not start the installer for the software it needs. Try again.",
            format!(
                "msiexec {verb} {} could not start: {error}; intended log path is {}",
                msi.display(),
                log.display()
            ),
        ),
        MsiexecFailure::Exit(code) => Problem::with(
            if code == 1625 {
                // ERROR_INSTALL_PACKAGE_REJECTED requires an administrator to resolve policy.
                // https://learn.microsoft.com/en-us/windows/win32/msi/error-codes
                "Windows policy blocks installing Podman, the container engine OpenBot needs. \
                 Ask an administrator to allow the installation or install Podman for your \
                 account, then try again."
            } else {
                "Installing the software OpenBot needs did not finish. Try again."
            },
            format!(
                "msiexec {verb} {} stopped with exit code {code}; its log is at {}",
                msi.display(),
                log.display()
            ),
        ),
    }
}

#[cfg(target_os = "macos")]
fn install_podman(into: &Path) -> Result<(), Problem> {
    let download = podman_download()?;
    let pkg = fetch_verified(&download, into)?;

    // The package writes to `/opt/podman`, which needs administrator rights. `do shell script ...
    // with administrator privileges` is how macOS asks for them: the person sees the standard
    // authorization dialog, and no password passes through this process.
    let script = format!(
        "do shell script \"/usr/sbin/installer -pkg {} -target /\" with administrator privileges",
        applescript_shell_arg(&pkg)
    );
    let output = crate::quiet::command("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("osascript: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    let said = crate::quiet::said(&output.stderr);
    // -128 is AppleScript's "user cancelled", which is a decision rather than a failure.
    if said.contains("-128") {
        return Err(Problem::plain(
            "The install was cancelled, so OpenBot does not have the software it needs yet. Press \
             Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        said,
    ))
}

/// A path that has to survive being a shell word inside an AppleScript string.
///
/// Two layers, applied in this order: single-quote it for the shell, then escape what AppleScript
/// treats as special in the double-quoted string that carries it.
#[cfg(target_os = "macos")]
fn applescript_shell_arg(path: &Path) -> String {
    let quoted = format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
    quoted.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn install_podman(_into: &Path) -> Result<(), Problem> {
    let (manager, args) = linux_package_manager().ok_or_else(|| {
        Problem::with(
            "OpenBot cannot install the software it needs on this system. Install the `podman` \
             package, then start OpenBot again.",
            "no apt-get, dnf, zypper or pacman in /usr/bin",
        )
    })?;

    // `pkexec` rather than `sudo`: sudo on a desktop with no terminal has nowhere to ask for a
    // password, and pkexec raises the desktop's own authorization dialog.
    let output = crate::quiet::command("pkexec")
        .arg(manager)
        .args(args)
        .arg("podman")
        .output()
        .map_err(|error| {
            Problem::with(
                "OpenBot could not start the installer for the software it needs.",
                format!("pkexec {manager}: {error}"),
            )
        })?;

    if output.status.success() {
        return Ok(());
    }
    // pkexec's own refusal. 126 is "not authorized", 127 is "dialog dismissed", and neither is a
    // package manager that failed.
    if matches!(output.status.code(), Some(126) | Some(127)) {
        return Err(Problem::plain(
            "The install was not allowed, so OpenBot does not have the software it needs yet. \
             Press Start to try again.",
        ));
    }
    Err(Problem::with(
        "Installing the software OpenBot needs did not finish. Try again.",
        crate::quiet::said(&output.stderr),
    ))
}

/// The package manager this distribution uses, and the words for "install without asking".
#[cfg(target_os = "linux")]
fn linux_package_manager() -> Option<(&'static str, &'static [&'static str])> {
    for (binary, args) in [
        ("apt-get", &["install", "-y"] as &[&str]),
        ("dnf", &["install", "-y"]),
        ("zypper", &["--non-interactive", "install"]),
        ("pacman", &["-S", "--noconfirm"]),
    ] {
        if Path::new("/usr/bin").join(binary).exists() {
            return Some((binary, args));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_root;

    #[test]
    #[cfg(windows)]
    fn a_stopped_docker_does_not_skip_the_podman_needed_for_setup() {
        if crate::test_support::isolated_process(
            "install::tests::a_stopped_docker_does_not_skip_the_podman_needed_for_setup",
        ) {
            return;
        }
        let root = temp_root("stopped-docker-install");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let source = root.join("engine.rs");
        std::fs::write(
            &source,
            r#"fn main() {
                if std::env::var_os("OPENBOT_TEST_DOCKER_RUNNING").is_none() {
                    std::process::exit(1);
                }
                println!("1.44");
            }"#,
        )
        .unwrap();
        crate::test_support::compile_fixture(&source, &bin.join("docker.exe"));
        std::env::set_var("PATH", &bin);
        std::env::set_var("LOCALAPPDATA", root.join("Local"));
        std::env::set_var("ProgramFiles", root.join("Program Files"));
        std::env::remove_var("OPENBOT_TEST_DOCKER_RUNNING");

        let found = engine::detect();
        assert_eq!(found.engine, Some(Engine::Docker));
        assert!(!found.responding);
        assert!(engine::program(Engine::Podman).is_none());
        let mut observed = Vec::new();
        let result = install_engine_with(
            &root,
            |success| observed.push(success),
            |_| {
                // Installation supplies the engine that engine_ready will create/start.
                std::fs::copy(bin.join("docker.exe"), bin.join("podman.exe")).unwrap();
                Ok(())
            },
            |_| Ok("Compose placed".into()),
        );
        result.expect("setup should install its missing Podman");
        assert_eq!(observed, [true], "the Podman installer must run");
        assert!(engine::program(Engine::Podman).is_some());

        // A responding Docker still supplies the engine; never install a replacement.
        std::fs::remove_file(bin.join("podman.exe")).unwrap();
        std::env::set_var("OPENBOT_TEST_DOCKER_RUNNING", "1");
        assert!(engine::detect().responding);
        let result = install_engine_with(
            &root,
            |_| panic!("no Podman installation should be observed"),
            |_| panic!("responding Docker must be reused"),
            |_| Ok("Compose placed".into()),
        );
        assert_eq!(result.unwrap(), "Compose placed");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Every platform this app runs on has a Compose build, or the stack cannot be raised there.
    #[test]
    fn this_platform_has_a_compose_build() {
        let download = compose_download().expect("every supported platform has a Compose build");
        assert!(download.url.ends_with(download.file), "{download:?}");
    }

    #[test]
    fn every_pinned_digest_is_a_lowercase_sha256() {
        // The table is written by hand from each release's own checksums, and a digest with a typo
        // in it fails on somebody else's machine at install time rather than here.
        for download in [
            compose_download(),
            podman_download(),
            bun_download("windows", "x86_64"),
            bun_download("windows", "aarch64"),
            bun_download("macos", "x86_64"),
            bun_download("macos", "aarch64"),
            bun_download("linux", "x86_64"),
            bun_download("linux", "aarch64"),
        ]
        .into_iter()
        .flatten()
        {
            assert_eq!(download.sha256.len(), 64, "{download:?}");
            assert!(
                download
                    .sha256
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "{download:?}"
            );
        }
    }

    /// The digest is compared, not merely computed. This is the check that stops a wrong file being
    /// executed, so it is asserted against a published vector rather than trusted.
    #[test]
    fn the_digest_is_a_real_sha256() {
        assert_eq!(
            digest_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn a_file_whose_digest_is_wrong_is_never_returned_to_be_run() {
        let dir = temp_root("digest");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("already-here"), b"not the pinned bytes").unwrap();

        let wrong = Download {
            // Unreachable on purpose: reaching it would mean the file on disk was accepted.
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            file: "already-here",
        };
        let refused = fetch_verified(&wrong, &dir).expect_err("a wrong digest must be refused");
        // Either half is acceptable here; what is not is a sentence that names a digest at the
        // person, or a detail that has thrown the evidence away.
        assert!(!refused.said.contains("sha256"), "{refused:?}");
        assert!(refused.detail.is_some(), "{refused:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file already present with the pinned digest is not fetched again. The URL does not
    /// resolve, so a fetch would fail rather than quietly succeed.
    #[test]
    fn a_file_already_here_with_the_right_digest_is_kept() {
        let dir = temp_root("kept");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kept"), b"abc").unwrap();

        let pinned = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            file: "kept",
        };
        let path = fetch_verified(&pinned, &dir).expect("the file already here should be kept");
        assert_eq!(path, dir.join("kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cached_bun_archive(name: &str) -> (PathBuf, Download) {
        let dir = temp_root(name);
        std::fs::create_dir_all(&dir).unwrap();
        let download = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            file: "bun.zip",
        };
        std::fs::write(dir.join(download.file), b"abc").unwrap();
        (dir, download)
    }

    fn bun_zip_fixture(name: &str) -> (PathBuf, Download) {
        use base64::Engine as _;

        // A deflated ZIP containing bun-fixture/bun, a /bin/sh script printing 1.3.14,
        // and an unrelated traversal entry that must never be extracted. Fixed bytes keep
        // digest verification and real decompression in this offline regression.
        let bytes = base64::engine::general_purpose::STANDARD.decode(
            "UEsDBBQAAAAIAAAAIVwlsF+1HgAAABwAAAAPAAAAYnVuLWZpeHR1cmUvYnVuU1bUT8rM0y/O4CooyswrSVNQN9Qz1jM0iclT5wIAUEsDBBQAAAAIAAAAIVw6VdAHFwAAABUAAAANAAAALi4vdW5leHBlY3RlZMstLS5RyMsvUUhKVUitKClKTC5JTQEAUEsBAhQDFAAAAAgAAAAhXCWwX7UeAAAAHAAAAA8AAAAAAAAAAAAAAIABAAAAAGJ1bi1maXh0dXJlL2J1blBLAQIUAxQAAAAIAAAAIVw6VdAHFwAAABUAAAANAAAAAAAAAAAAAACAAUsAAAAuLi91bmV4cGVjdGVkUEsFBgAAAAACAAIAeAAAAI0AAAAAAA==",
        ).unwrap();
        let root = temp_root(name);
        std::fs::create_dir_all(&root).unwrap();
        let download = Download {
            url: "http://127.0.0.1:1/never-reached".into(),
            sha256: "afeced1e41e23b9a5a7c63fb917f68ee663a3735f02fe717cf859be06b1e29b6",
            file: "bun-fixture.zip",
        };
        std::fs::write(root.join(download.file), bytes).unwrap();
        (root, download)
    }

    #[test]
    fn linux_runtime_downloads_are_pinned_for_both_supported_architectures() {
        for (arch, file, sha256) in [
            (
                "x86_64",
                "bun-linux-x64-baseline.zip",
                "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
            ),
            (
                "aarch64",
                "bun-linux-aarch64.zip",
                "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
            ),
        ] {
            let download = bun_download("linux", arch).unwrap();
            assert_eq!(download.file, file);
            assert_eq!(download.sha256, sha256);
            assert_eq!(
                download.url,
                format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}")
            );
        }
        assert!(bun_download("linux", "unsupported").is_err());
    }

    #[test]
    fn macos_runtime_downloads_are_pinned_for_both_supported_architectures() {
        for (arch, file) in [
            ("aarch64", "bun-darwin-aarch64.zip"),
            ("x86_64", "bun-darwin-x64-baseline.zip"),
        ] {
            let download = bun_download("macos", arch).unwrap();
            assert_eq!(download.file, file);
            assert_eq!(
                download.url,
                format!("https://github.com/oven-sh/bun/releases/download/bun-v{BUN}/{file}")
            );
        }
        assert!(bun_download("macos", "unsupported").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn bun_installation_works_without_developer_tools() {
        if crate::test_support::isolated_process(
            "install::tests::bun_installation_works_without_developer_tools",
        ) {
            return;
        }
        std::env::set_var("PATH", "/openbot-no-developer-tools");
        let (root, download) = bun_zip_fixture("bun user's fresh account");
        let binary = ensure_bun_with(None, || {
            install_bun_with(
                &root,
                &download,
                |archive, target| extract_bun(archive, target, "bun-fixture/bun"),
                verify_bun,
            )
        })
        .unwrap();
        assert_eq!(binary, root.join("bun"));
        verify_bun(&binary).unwrap();
        assert!(!root.join("bun.download").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bun_extraction_only_writes_the_expected_file() {
        let (root, download) = bun_zip_fixture("bun extraction paths");
        let into = root.join("installed");
        std::fs::create_dir(&into).unwrap();
        let target = into.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        let archive = fetch_verified(&download, &root).unwrap();
        extract_bun(&archive, &target, "bun-fixture/bun").unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"#!/bin/sh\nprintf '1.3.14\\n'\n"
        );
        assert_eq!(std::fs::read_dir(&into).unwrap().count(), 1);
        assert!(!root.join("unexpected").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_bun_archive_entry_is_not_published_or_run() {
        let (root, download) = bun_zip_fixture("bun missing entry");
        let failure = install_bun_with(
            &root,
            &download,
            |archive, target| extract_bun(archive, target, "missing/bun"),
            |_| panic!("a missing archive entry must not be run"),
        )
        .unwrap_err();
        assert!(failure.detail.unwrap().contains("missing/bun"));
        assert!(!root
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!root
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_fresh_account_acquires_bun_before_returning_its_executable() {
        let (dir, download) = cached_bun_archive("bun-fresh-account");
        let binary = ensure_bun_with(None, || {
            install_bun_with(
                &dir,
                &download,
                |archive, target| {
                    assert_eq!(std::fs::read(archive).unwrap(), b"abc");
                    assert!(!dir
                        .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
                        .exists());
                    std::fs::write(target, b"executable").unwrap();
                    Ok(())
                },
                |target| {
                    assert_eq!(std::fs::read(target).unwrap(), b"executable");
                    assert!(
                        !dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX))
                            .exists(),
                        "verify before publishing"
                    );
                    Ok(())
                },
            )
        })
        .unwrap();
        assert_eq!(
            binary,
            dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX))
        );
        assert_eq!(std::fs::read(binary).unwrap(), b"executable");
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_existing_bun_does_not_trigger_installation() {
        let root = temp_root("existing-pinned-bun");
        let existing = runtime_version_fixture(&root, BUN);
        assert_eq!(
            ensure_bun_with(Some(existing.clone()), || panic!("already installed")).unwrap(),
            existing
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn runtime_version_fixture(root: &Path, version: &str) -> PathBuf {
        std::fs::create_dir_all(root).unwrap();
        let source = root.join("runtime.rs");
        std::fs::write(&source, format!("fn main() {{ assert_eq!(std::env::args().nth(1).as_deref(), Some(\"--version\")); println!({version:?}); }}")).unwrap();
        let binary = root.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        crate::test_support::compile_fixture(&source, &binary);
        binary
    }

    #[test]
    fn unsupported_existing_bun_acquires_pinned_runtime_without_changing_user_binary() {
        let root = temp_root("unsupported-existing-bun");
        let existing = runtime_version_fixture(&root.join("user"), "1.2.15");
        let pinned = runtime_version_fixture(&root.join("openbot"), BUN);
        let before = std::fs::read(&existing).unwrap();
        let chosen = ensure_bun_with(Some(existing.clone()), || Ok(pinned.clone())).unwrap();
        assert_eq!(
            chosen, pinned,
            "an incompatible user runtime must not be selected"
        );
        assert_eq!(
            std::fs::read(existing).unwrap(),
            before,
            "the user's runtime is untouched"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_acquired_bun_is_checked_and_reused_without_extracting_again() {
        let (dir, download) = cached_bun_archive("bun-reuse");
        let binary = dir.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&binary, b"installed").unwrap();
        std::fs::remove_file(dir.join(download.file)).unwrap();
        let result = install_bun_with(
            &dir,
            &download,
            |_, _| panic!("must not replace the installed runtime"),
            |target| {
                assert_eq!(target, binary);
                Ok(())
            },
        );
        assert_eq!(result.unwrap(), binary);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bun_extraction_failure_keeps_the_diagnostic_and_publishes_nothing() {
        let (dir, download) = cached_bun_archive("bun-extraction-failure");
        let failure = Problem::with("could not unpack", "PowerShell exit 1: access denied");
        let result = install_bun_with(
            &dir,
            &download,
            |_, target| {
                std::fs::write(target, b"partially extracted executable").unwrap();
                Err(failure.clone())
            },
            |_| panic!("failed extraction must not be executed"),
        );
        assert_eq!(result, Err(failure));
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bun_that_cannot_run_is_not_published_and_its_failure_is_preserved() {
        let (dir, download) = cached_bun_archive("bun-probe-failure");
        let failure = Problem::with("could not start", "bun --version exited 1");
        let result = ensure_bun_with(None, || {
            install_bun_with(
                &dir,
                &download,
                |_, target| {
                    std::fs::write(target, b"broken executable").unwrap();
                    Ok(())
                },
                |_| Err(failure.clone()),
            )
        });
        assert_eq!(result, Err(failure));
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        assert!(!dir
            .join(format!("bun.download{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unverified_bun_archive_is_never_extracted_or_run() {
        let (dir, download) = cached_bun_archive("bun-wrong-digest");
        std::fs::write(dir.join(download.file), b"corrupt archive").unwrap();
        let result = install_bun_with(
            &dir,
            &download,
            |_, _| panic!("an unverified archive must not be extracted"),
            |_| panic!("an unverified runtime must not be run"),
        );
        assert!(result.unwrap_err().detail.is_some());
        assert!(!dir
            .join(format!("bun{}", std::env::consts::EXE_SUFFIX))
            .exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Podman publishes an `arm64` package only, so an Intel Mac has to be told rather than handed
    /// a package that cannot run. The message names what to do instead.
    #[test]
    #[cfg(target_os = "macos")]
    fn an_intel_mac_is_told_rather_than_handed_a_package_that_cannot_run() {
        if std::env::consts::ARCH == "x86_64" {
            let refused = podman_download().expect_err("there is no Intel package");
            assert!(refused.said.contains("Podman Desktop"), "{refused:?}");
            assert!(
                refused.detail.is_some_and(|d| d.contains("arm64")),
                "the developer half should name why"
            );
        } else {
            let download = podman_download().expect("Apple silicon has a package");
            assert!(download.file.contains("arm64"), "{download:?}");
        }
    }

    fn synthetic_msi_paths(name: &str) -> (PathBuf, PathBuf) {
        let dir = temp_root(name);
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("podman.msi"), dir.join("podman-install.log"))
    }

    #[test]
    fn windows_msi_cleanup_failure_stops_before_retry() {
        let (msi, log) = synthetic_msi_paths("msi-cleanup-fails");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            match calls.len() {
                1 => Err(MsiexecFailure::Exit(1603)),
                2 => Err(MsiexecFailure::Exit(1619)),
                _ => panic!("cleanup failure must stop before retrying install"),
            }
        });

        let problem = result.expect_err("cleanup failure must be reported");
        assert_eq!(calls, ["/i", "/x"]);
        let detail = problem
            .detail
            .expect("developer detail keeps msiexec evidence");
        assert!(detail.contains("msiexec /x"), "{detail}");
        assert!(detail.contains("exit code 1619"), "{detail}");
        assert!(detail.contains(&log.display().to_string()), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_spawn_failure_is_not_reported_as_exit_code_minus_one() {
        let (msi, log) = synthetic_msi_paths("msi-spawn-fails");
        let result = install_podman_msi(&msi, &log, |_verb, _msi, _log| {
            Err(MsiexecFailure::Start("program not found".into()))
        });

        let problem = result.expect_err("spawn failure must be reported");
        assert!(problem.said.contains("could not start"), "{problem:?}");
        let detail = problem
            .detail
            .expect("developer detail keeps spawn evidence");
        assert!(
            detail.contains("could not start: program not found"),
            "{detail}"
        );
        assert!(!detail.contains("exit code -1"), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_1603_recovery_removes_registration_then_retries_install() {
        let (msi, log) = synthetic_msi_paths("msi-recovery-succeeds");
        let mut calls = Vec::new();
        install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            match calls.len() {
                1 => Err(MsiexecFailure::Exit(1603)),
                2 | 3 => Ok(()),
                _ => panic!("unexpected extra msiexec call"),
            }
        })
        .expect("cleanup and retry should recover the broken registration");

        assert_eq!(calls, ["/i", "/x", "/i"]);
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_non_recovery_install_failure_stops_without_cleanup() {
        let (msi, log) = synthetic_msi_paths("msi-install-fails");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            Err(MsiexecFailure::Exit(1619))
        });

        let problem = result.expect_err("non-1603 install failure must be reported");
        assert_eq!(calls, ["/i"]);
        let detail = problem
            .detail
            .expect("developer detail keeps exit evidence");
        assert!(detail.contains("msiexec /i"), "{detail}");
        assert!(detail.contains("exit code 1619"), "{detail}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    fn windows_msi_policy_rejection_needs_administrator_action_before_retry() {
        let (msi, log) = synthetic_msi_paths("msi-policy-rejected");
        let mut calls = Vec::new();
        let result = install_podman_msi(&msi, &log, |verb, _msi, _log| {
            calls.push(verb[0].to_string());
            Err(MsiexecFailure::Exit(1625))
        });

        let problem = result.expect_err("policy rejection must be reported");
        assert_eq!(
            calls,
            ["/i"],
            "policy rejection must not trigger another attempt"
        );
        assert_eq!(
            problem.said,
            "Windows policy blocks installing Podman, the container engine \
            OpenBot needs. Ask an administrator to allow the installation or install Podman for \
            your account, then try again."
        );
        assert_eq!(
            problem.detail,
            Some(format!(
                "msiexec /i {} stopped with exit code 1625; its log is at {}",
                msi.display(),
                log.display(),
            )),
        );
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    #[test]
    #[cfg(unix)]
    fn windows_msi_recovery_uses_actual_child_process_boundary() {
        let (msi, log) = synthetic_msi_paths("msi-process-boundary");
        let fake = msi.parent().unwrap().join("fake-msiexec.sh");
        let calls = msi.parent().unwrap().join("calls.txt");
        let script = format!(
            r#"#!/bin/sh
set -eu
echo "$1|$2|$3|$4|$5|$6" >> '{}'
case "$1" in
  /i)
    count=$(grep -c '^/i|' '{}' 2>/dev/null || true)
    if [ "$count" = 1 ]; then echo MSI_EXIT=1603; exit 67; fi
    exit 0
    ;;
  /x) exit 0 ;;
  *) exit 99 ;;
esac
"#,
            calls.display(),
            calls.display()
        );
        std::fs::write(&fake, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        install_podman_msi(&msi, &log, |verb, msi, log| {
            let output = std::process::Command::new(&fake)
                .args(verb)
                .arg(msi)
                .args(["/qn", "/norestart", "/l*v"])
                .arg(log)
                .output()
                .map_err(|error| MsiexecFailure::Start(error.to_string()))?;
            if output.status.success() {
                Ok(())
            } else {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Unix test processes cannot return Windows Installer's 1603 directly: exit
                // statuses are truncated to 8 bits. The fake executable writes the intended
                // Windows code so this process-boundary proof can still exercise the production
                // recovery branch.
                let code = stdout
                    .trim()
                    .strip_prefix("MSI_EXIT=")
                    .and_then(|value| value.parse::<i32>().ok())
                    .unwrap_or_else(|| output.status.code().unwrap_or(-1));
                Err(MsiexecFailure::Exit(code))
            }
        })
        .expect("the fake executable should exercise the production recovery order");

        let calls = std::fs::read_to_string(&calls).unwrap();
        assert!(
            calls.contains(&format!(
                "/i|{}|/qn|/norestart|/l*v|{}",
                msi.display(),
                log.display()
            )),
            "{calls}"
        );
        assert!(
            calls.contains(&format!(
                "/x|{}|/qn|/norestart|/l*v|{}",
                msi.display(),
                log.display()
            )),
            "{calls}"
        );
        assert_eq!(calls.lines().count(), 3, "{calls}");
        let _ = std::fs::remove_dir_all(msi.parent().unwrap());
    }

    /// Podman looks a provider up by name, so this one is not negotiable.
    #[test]
    fn the_compose_provider_is_named_what_the_engine_looks_for() {
        assert_eq!(
            compose_provider_name(),
            if cfg!(windows) {
                "docker-compose.exe"
            } else {
                "docker-compose"
            }
        );
    }

    /// A path with a space in it is where naive quoting breaks, and the app's own cache directory
    /// on Windows and macOS both have one.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_path_with_a_space_survives_both_layers_of_quoting() {
        let quoted = applescript_shell_arg(Path::new("/Users/a b/Application Support/x.pkg"));
        assert!(quoted.starts_with('\''), "{quoted}");
        assert!(quoted.contains("Application Support"), "{quoted}");
        assert!(!quoted.contains("\\\""), "{quoted}");
    }
    // These exercise the real managed coordinator and real temporary files. The
    // verifier/extractor fault fixture is not native Windows or a real Bun proof.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum RepairFault { None, Archive, Extract, VerifyStage, Quarantine, Publish, Rollback, LaterTarget, StageCleanup, LockCleanup, PublishAckLost, UnsupportedLink, FinalTargetChange, StageSymlink, QuarantineChange, RollbackArrival }
    struct RepairFixtureOps {
        fault: RepairFault,
        archive_calls: usize,
        extract_calls: usize,
        verify_calls: usize,
        link_calls: usize,
        real_zip: bool,
    }
    impl RepairFixtureOps {
        fn new(fault: RepairFault) -> Self {
            Self { fault, archive_calls: 0, extract_calls: 0, verify_calls: 0, link_calls: 0, real_zip: false }
        }
    }
    impl BunRepairOps for RepairFixtureOps {
        fn archive(&mut self, download: &Download, into: &Path, _work: &Path) -> Result<PathBuf, Problem> {
            self.archive_calls += 1;
            if self.fault == RepairFault::Archive { return Err(managed_error("injected download failure")); }
            // No fixture network path: the coordinator still checks its pinned digest.
            Ok(into.join(download.file))
        }
        fn extract(&mut self, archive: &Path, stage: &Path, entry: &str) -> Result<(), Problem> {
            self.extract_calls += 1;
            if self.fault == RepairFault::Extract {
                std::fs::write(stage, b"partial-stage").unwrap();
                return Err(managed_error("injected extraction failure"));
            }
            if self.fault == RepairFault::StageSymlink {
                #[cfg(unix)]
                { std::os::unix::fs::symlink(stage.parent().unwrap().parent().unwrap().join("protected-stage-target"), stage).unwrap(); return Ok(()); }
                #[cfg(not(unix))]
                { return Err(managed_error("this fixture requires Unix symlink support")); }
            }
            if self.real_zip { return extract_bun(archive, stage, entry); }
            std::fs::write(stage, b"healthy-runtime").map_err(|e| managed_error(e.to_string()))
        }
        fn verify(&mut self, path: &Path) -> Result<(), Problem> {
            self.verify_calls += 1;
            if self.fault == RepairFault::StageSymlink && path.file_name().unwrap().to_string_lossy().starts_with("bun.stage") {
                panic!("linked staged runtime must never reach verification");
            }
            if self.fault == RepairFault::VerifyStage && path.file_name().unwrap().to_string_lossy().starts_with("bun.stage") {
                return Err(managed_error("injected stage verification failure"));
            }
            match std::fs::read(path) {
                Ok(bytes) if bytes == b"healthy-runtime" || bytes == b"#!/bin/sh\nprintf '1.3.14\\n'\n" => Ok(()),
                _ => Err(managed_error("fixture runtime is not healthy")),
            }
        }
        fn quarantine(&mut self, source: &Path, target: &Path) -> std::io::Result<()> {
            if self.fault == RepairFault::Quarantine { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected occupied/readonly rename")); }
            std::fs::rename(source, target)
        }
        fn link(&mut self, source: &Path, target: &Path) -> std::io::Result<()> {
            self.link_calls += 1;
            if self.fault == RepairFault::UnsupportedLink {
                return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "injected no hard-link support"));
            }
            if self.link_calls == 1 && self.fault == RepairFault::QuarantineChange {
                let previous = source.parent().unwrap().join(format!("bun.previous{}", std::env::consts::EXE_SUFFIX));
                std::fs::rename(&previous, source.parent().unwrap().join("retained-original"))?;
                std::fs::write(previous, b"changed-quarantine")?;
                return Err(std::io::Error::other("injected quarantine identity change"));
            }
            if self.link_calls == 1 && self.fault == RepairFault::RollbackArrival {
                return Err(std::io::Error::other("injected publish failure"));
            }
            if self.link_calls == 2 && self.fault == RepairFault::RollbackArrival {
                std::fs::write(target, b"late-at-rollback")?;
                return std::fs::hard_link(source, target);
            }
            if self.link_calls == 1 && self.fault == RepairFault::PublishAckLost {
                std::fs::hard_link(source, target)?;
                return Err(std::io::Error::other("injected publish response loss"));
            }
            if self.link_calls == 1 && self.fault == RepairFault::LaterTarget {
                std::fs::write(target, b"later-owner-target")?;
                return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "injected later target"));
            }
            if self.link_calls == 1 && matches!(self.fault, RepairFault::Publish | RepairFault::Rollback)
                || self.link_calls == 2 && self.fault == RepairFault::Rollback
            { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected create-only failure")); }
            std::fs::hard_link(source, target)
        }
        fn remove(&mut self, path: &Path) -> std::io::Result<()> {
            let name = path.file_name().unwrap().to_string_lossy();
            if self.fault == RepairFault::StageCleanup && name.starts_with("bun.stage")
                || self.fault == RepairFault::LockCleanup && name == "bun.repair.lock"
            { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "injected owned cleanup failure")); }
            std::fs::remove_file(path)?;
            if self.fault == RepairFault::FinalTargetChange && name == "bun.repair.lock" {
                let target = path.parent().unwrap().join(format!("bun{}", std::env::consts::EXE_SUFFIX));
                std::fs::rename(&target, path.parent().unwrap().join("published-moved-by-fixture"))?;
                std::fs::write(target, b"later-final-target")?;
            }
            Ok(())
        }
    }
    fn repair_fixture(label: &str) -> (PathBuf, Download, PathBuf) {
        let (root, download) = cached_bun_archive(label);
        let root = std::fs::canonicalize(root).unwrap();
        let binary = root.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&binary, b"bad-old-runtime").unwrap();
        (root, download, binary)
    }
    fn previous_runtime(root: &Path) -> PathBuf {
        std::fs::read_dir(root).unwrap().map(|e| e.unwrap().path())
            .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("bun.repair-") && p.join(format!("bun.previous{}", std::env::consts::EXE_SUFFIX)).is_file())
            .unwrap().join(format!("bun.previous{}", std::env::consts::EXE_SUFFIX))
    }

    #[test]
    fn managed_bad_runtime_is_repaired_once_then_verified_reuse_has_zero_acquisition() {
        let (root, download, binary) = repair_fixture("managed-repair-reuse");
        let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert_eq!(repair_managed_bun(&root, &download, "fixture", &mut ops).unwrap(), binary);
        assert_eq!(std::fs::read(&binary).unwrap(), b"healthy-runtime");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        assert_eq!((ops.archive_calls, ops.extract_calls, ops.link_calls), (1, 1, 1));
        assert!(!root.join("bun.repair.lock").exists());
        let mut again = RepairFixtureOps::new(RepairFault::Archive);
        assert_eq!(repair_managed_bun(&root, &download, "fixture", &mut again).unwrap(), binary);
        assert_eq!((again.archive_calls, again.extract_calls, again.link_calls), (0, 0, 0));
        assert_eq!(again.verify_calls, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_download_extract_or_stage_verify_failure_preserves_old_entry_bytes_and_mode() {
        for (label, fault) in [("download", RepairFault::Archive), ("extract", RepairFault::Extract), ("verify", RepairFault::VerifyStage)] {
            let (root, download, binary) = repair_fixture(&format!("managed-prepublish-{label}"));
            let old = bun_identity(&binary).unwrap();
            let mut ops = RepairFixtureOps::new(fault);
            assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
            assert_eq!(bun_identity(&binary).unwrap(), old);
            assert_eq!(ops.link_calls, 0);
            assert!(!root.join("bun.repair.lock").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn managed_wrong_archive_hash_is_refused_before_extract_and_preserves_old_target() {
        let (root, download, binary) = repair_fixture("managed-hash");
        std::fs::write(root.join(download.file), b"wrong hash").unwrap();
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.extract_calls, 0); assert_eq!(bun_identity(&binary).unwrap(), old);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_missing_real_zip_entry_cannot_publish_over_old_target() {
        let (root, download) = bun_zip_fixture("managed-real-zip-missing");
        let root = std::fs::canonicalize(root).unwrap();
        let binary = root.join(format!("bun{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&binary, b"bad-old-runtime").unwrap();
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::None); ops.real_zip = true;
        assert!(repair_managed_bun(&root, &download, "missing/bun", &mut ops).is_err());
        assert_eq!(ops.link_calls, 0); assert_eq!(bun_identity(&binary).unwrap(), old);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_quarantine_rename_failure_never_publishes_or_removes_old_target() {
        let (root, download, binary) = repair_fixture("managed-rename-failure");
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::Quarantine);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 0); assert_eq!(bun_identity(&binary).unwrap(), old);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_failed_publication_restores_known_bad_old_file_but_still_returns_error() {
        let (root, download, binary) = repair_fixture("managed-rollback-success");
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::Publish);
        let error = repair_managed_bun(&root, &download, "fixture", &mut ops).unwrap_err();
        assert!(error.detail.unwrap().contains("known bad old runtime restored"));
        assert_eq!(ops.link_calls, 2); assert_eq!(bun_identity(&binary).unwrap(), old);
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_failed_rollback_leaves_recoverable_quarantine_and_reports_error() {
        let (root, download, binary) = repair_fixture("managed-rollback-failure");
        let mut ops = RepairFixtureOps::new(RepairFault::Rollback);
        let error = repair_managed_bun(&root, &download, "fixture", &mut ops).unwrap_err();
        assert!(error.detail.unwrap().contains("rollback failed")); assert_eq!(ops.link_calls, 2);
        assert!(!binary.exists()); assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_later_target_is_not_overwritten_deleted_or_rolled_back_over() {
        let (root, download, binary) = repair_fixture("managed-later-target");
        let mut ops = RepairFixtureOps::new(RepairFault::LaterTarget);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 1); assert_eq!(std::fs::read(binary).unwrap(), b"later-owner-target");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_publication_ack_loss_keeps_published_file_and_quarantine_but_is_not_success() {
        let (root, download, binary) = repair_fixture("managed-publish-unknown");
        let mut ops = RepairFixtureOps::new(RepairFault::PublishAckLost);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 1); assert_eq!(std::fs::read(binary).unwrap(), b"healthy-runtime");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_busy_lock_is_not_guessed_stale_or_removed() {
        let (root, download, binary) = repair_fixture("managed-busy");
        std::fs::write(root.join("bun.repair.lock"), b"owned-by-another-attempt").unwrap();
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.archive_calls, 0); assert_eq!(bun_identity(&binary).unwrap(), old);
        assert_eq!(std::fs::read(root.join("bun.repair.lock")).unwrap(), b"owned-by-another-attempt");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_owned_cleanup_failures_return_error_without_deleting_healthy_published_target() {
        for (label, fault) in [("stage", RepairFault::StageCleanup), ("lock", RepairFault::LockCleanup)] {
            let (root, download, binary) = repair_fixture(&format!("managed-cleanup-{label}"));
            let mut ops = RepairFixtureOps::new(fault);
            assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
            assert_eq!(std::fs::read(binary).unwrap(), b"healthy-runtime");
            assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
            if fault == RepairFault::LockCleanup { assert!(root.join("bun.repair.lock").exists()); }
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn managed_same_direct_locator_repairs_while_independent_bad_external_entry_is_untouched() {
        let (root, download, binary) = repair_fixture("managed-external-boundary");
        let external = root.join("external-bun"); std::fs::write(&external, b"old-user-runtime").unwrap();
        let protected = bun_identity(&external).unwrap();
        let mut ops = RepairFixtureOps::new(RepairFault::None);
        let result = ensure_bun_selected(Some(external.clone()), &binary, |_| Err(managed_error("unsupported external version")), || repair_managed_bun(&root, &download, "fixture", &mut ops));
        assert_eq!(result.unwrap(), binary); assert_eq!(bun_identity(&external).unwrap(), protected);
        std::fs::write(&binary, b"bad-old-runtime").unwrap();
        let mut again = RepairFixtureOps::new(RepairFault::None);
        let result = ensure_bun_selected(Some(root.join(".").join(binary.file_name().unwrap())), &binary, |_| panic!("direct managed entry must use guarded verification"), || repair_managed_bun(&root, &download, "fixture", &mut again));
        assert_eq!(result.unwrap(), binary);
        assert_eq!(bun_identity(&external).unwrap(), protected);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_healthy_external_runtime_is_returned_without_acquisition() {
        let (root, _download, binary) = repair_fixture("managed-healthy-external");
        let external = root.join("external-bun"); std::fs::write(&external, b"healthy-user-runtime").unwrap();
        let old = bun_identity(&external).unwrap();
        assert_eq!(ensure_bun_selected(Some(external.clone()), &binary, |_| Ok(()), || panic!("external runtime must not install")).unwrap(), external);
        assert_eq!(bun_identity(&external).unwrap(), old);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_external_hardlink_preserves_old_inode_when_managed_entry_is_replaced() {
        let (root, download, binary) = repair_fixture("managed-external-hardlink");
        let external = root.join("external-hardlink"); std::fs::hard_link(&binary, &external).unwrap();
        let old = bun_identity(&external).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::None);
        ensure_bun_selected(Some(external.clone()), &binary, |_| Err(managed_error("bad old external")), || repair_managed_bun(&root, &download, "fixture", &mut ops)).unwrap();
        assert_eq!(bun_identity(&external).unwrap(), old);
        assert_eq!(std::fs::read(binary).unwrap(), b"healthy-runtime");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn managed_target_archive_and_parent_links_are_refused_before_managed_verifier() {
        use std::os::unix::fs::symlink;
        for entry in ["target", "archive", "parent"] {
            let (root, download, binary) = repair_fixture(&format!("managed-link-{entry}"));
            let protected = root.join("protected"); std::fs::write(&protected, b"do-not-execute-or-write").unwrap();
            let into = if entry == "parent" {
                let parent = root.join("linked-parent"); symlink(&root, &parent).unwrap(); parent
            } else {
                let target = if entry == "target" { binary.clone() } else { root.join(download.file) };
                std::fs::remove_file(&target).unwrap(); symlink(&protected, target).unwrap(); root.clone()
            };
            let mut ops = RepairFixtureOps::new(RepairFault::None);
            assert!(repair_managed_bun(&into, &download, "fixture", &mut ops).is_err());
            assert_eq!(ops.verify_calls, 0); assert_eq!(ops.archive_calls, 0);
            assert_eq!(std::fs::read(protected).unwrap(), b"do-not-execute-or-write");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    #[cfg(unix)]
    fn external_symlink_to_managed_locator_is_rejected_without_verifying_it() {
        let (root, _download, binary) = repair_fixture("managed-external-link");
        let alias = root.join("alias"); std::os::unix::fs::symlink(&binary, &alias).unwrap();
        assert!(ensure_bun_selected(Some(alias), &binary, |_| panic!("alias must not execute managed binary"), || panic!("alias must not mutate managed binary")).is_err());
        assert_eq!(std::fs::read(binary).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires Windows symlink privilege; source definition is not native OS evidence"]
    fn windows_managed_reparse_entry_is_rejected_before_verification() {
        use std::os::windows::fs::{symlink_file, MetadataExt};
        let (root, download, binary) = repair_fixture("managed-windows-reparse");
        let protected = root.join("protected"); std::fs::write(&protected, b"protected").unwrap();
        std::fs::remove_file(&binary).unwrap(); symlink_file(&protected, &binary).unwrap();
        assert_ne!(std::fs::symlink_metadata(&binary).unwrap().file_attributes() & 0x400, 0);
        let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.verify_calls, 0); assert_eq!(std::fs::read(protected).unwrap(), b"protected");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_unsupported_hard_link_never_falls_back_to_overwriting_copy_or_rename() {
        let (root, download, binary) = repair_fixture("managed-link-unsupported");
        let mut ops = RepairFixtureOps::new(RepairFault::UnsupportedLink);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 2);
        assert!(!binary.exists());
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_final_target_change_returns_error_and_keeps_staged_and_old_recovery_links() {
        let (root, download, binary) = repair_fixture("managed-final-target-change");
        let mut ops = RepairFixtureOps::new(RepairFault::FinalTargetChange);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(std::fs::read(binary).unwrap(), b"later-final-target");
        let previous = previous_runtime(&root);
        let stage = previous.parent().unwrap().join(format!("bun.stage{}", std::env::consts::EXE_SUFFIX));
        assert_eq!(std::fs::read(stage).unwrap(), b"healthy-runtime");
        assert_eq!(std::fs::read(previous).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_directory_target_and_parent_traversal_are_not_absence_or_external_ownership() {
        let (root, download, binary) = repair_fixture("managed-special-target");
        std::fs::remove_file(&binary).unwrap(); std::fs::create_dir(&binary).unwrap();
        let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.verify_calls, 0);
        assert!(ordinary_absolute(&root.join("child/../bun")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn managed_staged_link_is_refused_before_the_staged_verifier_runs() {
        let (root, download, binary) = repair_fixture("managed-stage-link");
        let protected = root.join("protected-stage-target"); std::fs::write(&protected, b"protected-stage").unwrap();
        let old = bun_identity(&binary).unwrap(); let mut ops = RepairFixtureOps::new(RepairFault::StageSymlink);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 0); assert_eq!(bun_identity(&binary).unwrap(), old);
        assert_eq!(std::fs::read(protected).unwrap(), b"protected-stage");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_changed_quarantine_identity_is_not_used_for_rollback() {
        let (root, download, binary) = repair_fixture("managed-quarantine-change");
        let mut ops = RepairFixtureOps::new(RepairFault::QuarantineChange);
        let error = repair_managed_bun(&root, &download, "fixture", &mut ops).unwrap_err();
        assert!(error.detail.unwrap().contains("quarantine identity changed"));
        assert_eq!(ops.link_calls, 1); assert!(!binary.exists());
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"changed-quarantine");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_rollback_target_arrival_is_not_overwritten_by_create_only_restore() {
        let (root, download, binary) = repair_fixture("managed-rollback-arrival");
        let mut ops = RepairFixtureOps::new(RepairFault::RollbackArrival);
        assert!(repair_managed_bun(&root, &download, "fixture", &mut ops).is_err());
        assert_eq!(ops.link_calls, 2); assert_eq!(std::fs::read(binary).unwrap(), b"late-at-rollback");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[derive(Debug, PartialEq, Eq)]
    struct SelectionEntry {
        directory: bool,
        file: bool,
        link: bool,
        link_target: Option<PathBuf>,
        length: u64,
        readonly: bool,
        #[cfg(unix)] mode: u32,
        #[cfg(windows)] attributes: u32,
    }
    fn selection_entry(path: &Path) -> SelectionEntry {
        let metadata = std::fs::symlink_metadata(path).unwrap();
        SelectionEntry {
            directory: metadata.is_dir(), file: metadata.is_file(), link: metadata.file_type().is_symlink(),
            link_target: std::fs::read_link(path).ok(), length: metadata.len(), readonly: metadata.permissions().readonly(),
            #[cfg(unix)] mode: { use std::os::unix::fs::PermissionsExt; metadata.permissions().mode() },
            #[cfg(windows)] attributes: { use std::os::windows::fs::MetadataExt; metadata.file_attributes() },
        }
    }
    fn assert_independent_external_reused(existing: &Path, managed: &Path) {
        let before_external = selection_entry(existing);
        let before_managed = selection_entry(managed);
        let bytes = std::fs::read(existing).unwrap();
        let verify_calls = std::cell::Cell::new(0usize);
        let install_calls = std::cell::Cell::new(0usize);
        let selected = ensure_bun_selected(Some(existing.to_path_buf()), managed, |actual| {
            verify_calls.set(verify_calls.get() + 1);
            assert_eq!(actual, existing);
            assert_eq!(std::fs::read(actual).unwrap(), bytes);
            Ok(())
        }, || {
            install_calls.set(install_calls.get() + 1);
            Err(managed_error("independent external must not acquire/install"))
        }).unwrap();
        assert_eq!(selected, existing);
        assert_eq!(verify_calls.get(), 1);
        assert_eq!(install_calls.get(), 0);
        assert_eq!(std::fs::read(existing).unwrap(), bytes);
        assert_eq!(selection_entry(existing), before_external);
        assert_eq!(selection_entry(managed), before_managed);
    }

    #[test]
    fn healthy_external_reuse_is_independent_of_a_directory_at_managed_target() {
        let (root, _download, managed) = repair_fixture("selection-managed-directory");
        std::fs::remove_file(&managed).unwrap(); std::fs::create_dir(&managed).unwrap();
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        assert_independent_external_reused(&external, &managed);
        assert_eq!(std::fs::read_dir(&managed).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn healthy_external_reuse_is_independent_of_a_managed_target_symlink() {
        let (root, _download, managed) = repair_fixture("selection-managed-link");
        let protected = root.join("managed-link-referent"); std::fs::write(&protected, b"unchanged-managed-referent").unwrap();
        let before_referent = selection_entry(&protected);
        std::fs::remove_file(&managed).unwrap(); std::os::unix::fs::symlink(&protected, &managed).unwrap();
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        assert_independent_external_reused(&external, &managed);
        assert_eq!(std::fs::read(&protected).unwrap(), b"unchanged-managed-referent");
        assert_eq!(selection_entry(&protected), before_referent);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn managed_symlink_back_to_healthy_external_does_not_make_external_managed() {
        let (root, _download, managed) = repair_fixture("selection-managed-reverse-link");
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        std::fs::remove_file(&managed).unwrap(); std::os::unix::fs::symlink(&external, &managed).unwrap();
        assert_independent_external_reused(&external, &managed);
        assert_eq!(std::fs::read_link(&managed).unwrap(), external);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires Windows symlink privilege; not native runtime evidence"]
    fn healthy_external_reuse_ignores_unrelated_or_reverse_managed_reparse_entry() {
        use std::os::windows::fs::{symlink_file, MetadataExt};
        for reverse in [false, true] {
            let (root, _download, managed) = repair_fixture(if reverse { "selection-windows-reverse" } else { "selection-windows-reparse" });
            let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
            let referent = if reverse { external.clone() } else { root.join("other-referent") };
            if !reverse { std::fs::write(&referent, b"unchanged-referent").unwrap(); }
            let referent_bytes = std::fs::read(&referent).unwrap(); let referent_entry = selection_entry(&referent);
            std::fs::remove_file(&managed).unwrap(); symlink_file(&referent, &managed).unwrap();
            assert_ne!(std::fs::symlink_metadata(&managed).unwrap().file_attributes() & 0x400, 0);
            assert_independent_external_reused(&external, &managed);
            assert_eq!(std::fs::read(&referent).unwrap(), referent_bytes);
            assert_eq!(selection_entry(&referent), referent_entry);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn direct_managed_selection_preflights_before_any_verifier_or_installer() {
        let (root, _download, managed) = repair_fixture("selection-direct-managed-directory");
        std::fs::remove_file(&managed).unwrap(); std::fs::create_dir(&managed).unwrap();
        let before = selection_entry(&managed);
        assert!(ensure_bun_selected(Some(managed.clone()), &managed,
            |_| panic!("managed directory must not reach external verifier"),
            || panic!("managed directory must fail preflight before installer")).is_err());
        assert_eq!(selection_entry(&managed), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn relative_external_alias_to_managed_is_rejected_even_if_managed_links_to_external() {
        let (root, _download, managed) = repair_fixture("selection-forward-alias-reverse-managed");
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        std::fs::remove_file(&managed).unwrap(); std::os::unix::fs::symlink(&external, &managed).unwrap();
        let links = root.join("aliases"); std::fs::create_dir(&links).unwrap();
        let alias = links.join("runtime"); std::os::unix::fs::symlink(Path::new("..").join(managed.file_name().unwrap()), &alias).unwrap();
        let before_alias = selection_entry(&alias); let before_managed = selection_entry(&managed);
        assert!(ensure_bun_selected(Some(alias.clone()), &managed,
            |_| panic!("alias into managed locator must not execute"),
            || panic!("alias into managed locator must not install")).is_err());
        assert_eq!(selection_entry(&alias), before_alias); assert_eq!(selection_entry(&managed), before_managed);
        assert_eq!(std::fs::read(external).unwrap(), b"healthy-external");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn independent_external_link_still_uses_readonly_verifier_with_unrelated_bad_managed_target() {
        let (root, _download, managed) = repair_fixture("selection-independent-external-link");
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        let alias = root.join("external-alias"); std::os::unix::fs::symlink(&external, &alias).unwrap();
        std::fs::remove_file(&managed).unwrap(); std::fs::create_dir(&managed).unwrap();
        assert_independent_external_reused(&alias, &managed);
        assert_eq!(std::fs::read(external).unwrap(), b"healthy-external");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn healthy_external_reuse_does_not_inspect_an_unrelated_non_directory_managed_ancestor() {
        let (root, _download, _old_managed) = repair_fixture("selection-managed-bad-ancestor");
        let blocked = root.join("blocked-ancestor"); std::fs::write(&blocked, b"unrelated-managed-ancestor").unwrap();
        let managed = blocked.join("bun");
        let external = root.join("external-healthy"); std::fs::write(&external, b"healthy-external").unwrap();
        let before_external = selection_entry(&external); let before_blocked = selection_entry(&blocked);
        let calls = std::cell::Cell::new(0usize);
        let selected = ensure_bun_selected(Some(external.clone()), &managed, |actual| {
            calls.set(calls.get() + 1);
            assert_eq!(std::fs::read(actual).unwrap(), b"healthy-external"); Ok(())
        }, || panic!("independent external must not inspect/acquire managed installation")).unwrap();
        assert_eq!(selected, external); assert_eq!(calls.get(), 1);
        assert_eq!(selection_entry(&external), before_external); assert_eq!(selection_entry(&blocked), before_blocked);
        assert_eq!(std::fs::read(blocked).unwrap(), b"unrelated-managed-ancestor");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn alias_entering_managed_before_parent_dir_is_rejected_without_execution() {
        let (root, _download, managed) = repair_fixture("selection-managed-before-parent");
        let subdir = root.join("subdir"); std::fs::create_dir(&subdir).unwrap();
        let external = root.join("external"); std::fs::write(&external, b"healthy-external").unwrap();
        std::fs::remove_file(&managed).unwrap(); std::os::unix::fs::symlink(&subdir, &managed).unwrap();
        let alias = root.join("alias");
        let raw = PathBuf::from(managed.file_name().unwrap()).join("..").join("external");
        std::os::unix::fs::symlink(&raw, &alias).unwrap();
        assert_eq!(std::fs::canonicalize(&alias).unwrap(), external);
        let paths = [&managed, &subdir, &external, &alias];
        let before: Vec<_> = paths.iter().map(|p| selection_entry(p)).collect();
        let bytes = std::fs::read(&external).unwrap();
        let verifier = std::cell::Cell::new(0usize); let installer = std::cell::Cell::new(0usize);
        assert!(ensure_bun_selected(Some(alias.clone()), &managed, |_| {
            verifier.set(verifier.get() + 1); Ok(())
        }, || {
            installer.set(installer.get() + 1); Err(managed_error("unexpected install"))
        }).is_err());
        assert_eq!(verifier.get(), 0); assert_eq!(installer.get(), 0);
        assert_eq!(paths.iter().map(|p| selection_entry(p)).collect::<Vec<_>>(), before);
        assert_eq!(std::fs::read(&external).unwrap(), bytes);
        assert_eq!(std::fs::read_link(&alias).unwrap(), raw);
        assert_eq!(std::fs::read_link(&managed).unwrap(), subdir);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn ordinary_directory_parent_alias_remains_a_readonly_external_selection() {
        let (root, _download, managed) = repair_fixture("selection-ordinary-before-parent");
        let subdir = root.join("subdir"); std::fs::create_dir(&subdir).unwrap();
        let external = root.join("external"); std::fs::write(&external, b"healthy-external").unwrap();
        let alias = root.join("alias"); let raw = Path::new("subdir").join("..").join("external");
        std::os::unix::fs::symlink(&raw, &alias).unwrap();
        let before_subdir = selection_entry(&subdir); let before_external = selection_entry(&external);
        assert_eq!(std::fs::canonicalize(&alias).unwrap(), external);
        assert_independent_external_reused(&alias, &managed);
        assert_eq!(selection_entry(&subdir), before_subdir); assert_eq!(selection_entry(&external), before_external);
        assert_eq!(std::fs::read(&external).unwrap(), b"healthy-external");
        assert_eq!(std::fs::read_link(&alias).unwrap(), raw);
        std::fs::remove_dir_all(root).unwrap();
    }

    // F2c: the same search coordinator called by ensure_bun_from_search and
    // main's actual Install helper. No ambient PATH/HOME mutation in fixtures.
    fn search_fixture_candidate(root: &Path, directory: &str, bytes: &[u8]) -> PathBuf {
        let directory = root.join(directory); std::fs::create_dir_all(&directory).unwrap();
        let candidate = directory.join(if cfg!(windows) { "bun.exe" } else { "bun" });
        std::fs::write(&candidate, bytes).unwrap(); candidate
    }
    fn fixture_search_path(directory: &Path) -> std::ffi::OsString {
        std::env::join_paths([directory]).unwrap()
    }

    #[test]
    fn install_search_reuses_exact_classified_healthy_external_once_without_acquiring() {
        let (root, _download, target) = repair_fixture("search-supported-path");
        let candidate = search_fixture_candidate(&root, "path-bin", b"healthy-external");
        let path = fixture_search_path(candidate.parent().unwrap());
        let before_external = selection_entry(&candidate); let before_target = selection_entry(&target);
        let probes = std::cell::Cell::new(0); let acquires = std::cell::Cell::new(0);
        let result = ensure_bun_from_search_with(Some(&path), None, &root, &target, |actual| {
            probes.set(probes.get() + 1); assert_eq!(actual, candidate.as_path());
            assert_eq!(std::fs::read(actual).unwrap(), b"healthy-external"); BunCandidateProbe::Supported
        }, || { acquires.set(acquires.get() + 1); Err(managed_error("must reuse")) }).unwrap();
        assert_eq!(result, candidate); assert_eq!(probes.get(), 1); assert_eq!(acquires.get(), 0);
        assert_eq!(selection_entry(&candidate), before_external); assert_eq!(selection_entry(&target), before_target);
        assert_eq!(std::fs::read(&candidate).unwrap(), b"healthy-external"); assert_eq!(std::fs::read(&target).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_failed_path_probe_falls_back_to_first_home_candidate() {
        let (root, _download, target) = repair_fixture("search-failed-path-home");
        let candidate = search_fixture_candidate(&root, "path-bin", b"failed-path");
        let home = root.join("home"); let home_candidate = search_fixture_candidate(&home, ".bun/bin", b"healthy-home");
        // HOME's existing order is bun before bun.exe, independent of PATH's platform filename.
        let first_home = home.join(".bun/bin/bun"); std::fs::write(&first_home, b"healthy-home").unwrap();
        let path = fixture_search_path(candidate.parent().unwrap()); let mut probes = Vec::new();
        let result = ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target, |actual| {
            probes.push(actual.to_path_buf()); if actual == candidate.as_path() { BunCandidateProbe::Failed } else {
                assert_eq!(actual, first_home.as_path()); BunCandidateProbe::Supported
            }
        }, || panic!("healthy HOME must be reused")).unwrap();
        assert_eq!(result, first_home); assert_eq!(probes, [candidate.clone(), first_home]);
        assert_eq!(std::fs::read(candidate).unwrap(), b"failed-path"); assert_eq!(std::fs::read(home_candidate).unwrap(), b"healthy-home");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_successful_unsupported_path_uses_managed_instead_of_home() {
        let (root, _download, target) = repair_fixture("search-unsupported-path");
        let candidate = search_fixture_candidate(&root, "path-bin", b"unsupported-path");
        let home = root.join("home"); search_fixture_candidate(&home, ".bun/bin", b"healthy-home");
        let path = fixture_search_path(candidate.parent().unwrap()); let probes = std::cell::Cell::new(0); let acquires = std::cell::Cell::new(0);
        let result = ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target, |actual| {
            probes.set(probes.get() + 1); assert_eq!(actual, candidate.as_path()); BunCandidateProbe::Unsupported
        }, || { acquires.set(acquires.get() + 1); Ok(target.clone()) }).unwrap();
        assert_eq!(result, target); assert_eq!(probes.get(), 1); assert_eq!(acquires.get(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_missing_path_candidate_passively_uses_home_without_probe() {
        let (root, _download, target) = repair_fixture("search-missing-path-home");
        let home = root.join("home"); let candidate = home.join(".bun/bin/bun");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap(); std::fs::write(&candidate, b"home").unwrap();
        let path = fixture_search_path(&root.join("absent-path")); let probes = std::cell::Cell::new(0);
        assert_eq!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target, |actual| {
            probes.set(probes.get() + 1); assert_eq!(actual, candidate.as_path()); BunCandidateProbe::Supported
        }, || panic!("HOME is present")).unwrap(), candidate);
        assert_eq!(probes.get(), 1); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_no_candidates_acquires_once_without_any_probe() {
        let (root, _download, target) = repair_fixture("search-no-candidates"); let acquires = std::cell::Cell::new(0);
        let path = fixture_search_path(&root.join("absent"));
        assert_eq!(ensure_bun_from_search_with(Some(&path), Some(&root.join("missing-home")), &root, &target,
            |_| panic!("absent entries are not processes"), || { acquires.set(acquires.get() + 1); Ok(target.clone()) }).unwrap(), target);
        assert_eq!(acquires.get(), 1); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_relative_path_keeps_the_exact_absolute_locator_for_probe() {
        let (root, _download, target) = repair_fixture("search-relative-path");
        let candidate = search_fixture_candidate(&root, "path-bin", b"relative");
        let path = fixture_search_path(Path::new("path-bin")); let probes = std::cell::Cell::new(0);
        assert_eq!(ensure_bun_from_search_with(Some(&path), None, &root, &target, |actual| {
            probes.set(probes.get() + 1); assert_eq!(actual, candidate.as_path()); BunCandidateProbe::Supported
        }, || panic!("relative external must be reusable")).unwrap(), candidate);
        assert_eq!(probes.get(), 1); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_direct_managed_file_uses_guarded_coordinator_without_external_probe() {
        let (root, download, target) = repair_fixture("search-direct-managed-repair");
        let path = fixture_search_path(&root); let acquires = std::cell::Cell::new(0); let mut ops = RepairFixtureOps::new(RepairFault::None);
        assert_eq!(ensure_bun_from_search_with(Some(&path), None, &root, &target,
            |_| panic!("direct managed must not reach external probe"), || {
                acquires.set(acquires.get() + 1); repair_managed_bun(&root, &download, "fixture", &mut ops)
            }).unwrap(), target);
        assert_eq!(acquires.get(), 1); assert_eq!(std::fs::read(&target).unwrap(), b"healthy-runtime");
        assert_eq!(std::fs::read(previous_runtime(&root)).unwrap(), b"bad-old-runtime");
        let mut again = RepairFixtureOps::new(RepairFault::None);
        ensure_bun_from_search_with(Some(&path), None, &root, &target,
            |_| panic!("managed reuse remains guarded"), || repair_managed_bun(&root, &download, "fixture", &mut again)).unwrap();
        assert_eq!(again.archive_calls, 0); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_search_managed_link_is_rejected_before_probe_acquire_or_home_fallback() {
        let (root, _download, target) = repair_fixture("search-direct-managed-link");
        let external = root.join("external"); std::fs::write(&external, b"healthy").unwrap();
        std::fs::remove_file(&target).unwrap(); std::os::unix::fs::symlink(&external, &target).unwrap();
        let home = root.join("home"); search_fixture_candidate(&home, ".bun/bin", b"home");
        let before = selection_entry(&target); let external_before = selection_entry(&external); let path = fixture_search_path(&root);
        let probes = std::cell::Cell::new(0); let acquires = std::cell::Cell::new(0);
        assert!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target, |_| {
            probes.set(probes.get() + 1); BunCandidateProbe::Supported
        }, || { acquires.set(acquires.get() + 1); Ok(target.clone()) }).is_err());
        assert_eq!(probes.get(), 0); assert_eq!(acquires.get(), 0); assert_eq!(selection_entry(&target), before);
        assert_eq!(selection_entry(&external), external_before); assert_eq!(std::fs::read_link(&target).unwrap(), external);
        assert_eq!(std::fs::read(&external).unwrap(), b"healthy"); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_search_external_alias_to_managed_never_probes_or_falls_back_to_home() {
        let (root, _download, target) = repair_fixture("search-managed-alias");
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap(); let alias = bin.join("bun");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let home = root.join("home"); search_fixture_candidate(&home, ".bun/bin", b"home");
        let before_alias = selection_entry(&alias); let before_target = selection_entry(&target); let path = fixture_search_path(&bin);
        let probes = std::cell::Cell::new(0); let acquires = std::cell::Cell::new(0);
        assert!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target, |_| {
            probes.set(probes.get() + 1); BunCandidateProbe::Supported
        }, || { acquires.set(acquires.get() + 1); Ok(target.clone()) }).is_err());
        assert_eq!(probes.get(), 0); assert_eq!(acquires.get(), 0);
        assert_eq!(selection_entry(&alias), before_alias); assert_eq!(selection_entry(&target), before_target);
        assert_eq!(std::fs::read_link(&alias).unwrap(), target); assert_eq!(std::fs::read(&target).unwrap(), b"bad-old-runtime");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_search_relative_path_alias_retains_managed_boundary_evidence() {
        let (root, _download, target) = repair_fixture("search-relative-managed-alias");
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap();
        let alias = bin.join("bun"); let raw = Path::new("..").join(target.file_name().unwrap());
        std::os::unix::fs::symlink(&raw, &alias).unwrap(); let path = fixture_search_path(Path::new("path-bin"));
        let before = selection_entry(&alias);
        assert!(ensure_bun_from_search_with(Some(&path), None, &root, &target,
            |_| panic!("raw relative alias must be classified before probe"), || panic!("alias cannot acquire")).is_err());
        assert_eq!(selection_entry(&alias), before); assert_eq!(std::fs::read_link(&alias).unwrap(), raw);
        assert_eq!(std::fs::read(&target).unwrap(), b"bad-old-runtime"); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_search_dangling_external_link_is_unknown_not_absent_or_home_eligible() {
        let (root, _download, target) = repair_fixture("search-dangling-alias");
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap();
        let alias = bin.join("bun"); std::os::unix::fs::symlink(root.join("absent"), &alias).unwrap();
        let path = fixture_search_path(&bin); let home = root.join("home"); search_fixture_candidate(&home, ".bun/bin", b"home");
        let before = selection_entry(&alias);
        assert!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target,
            |_| panic!("unresolved link must not execute"), || panic!("unknown link must not acquire")).is_err());
        assert_eq!(selection_entry(&alias), before); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_search_metadata_error_and_special_candidate_do_not_mean_absent() {
        let (root, _download, target) = repair_fixture("search-metadata-error");
        let not_directory = root.join("not-directory"); std::fs::write(&not_directory, b"unchanged").unwrap();
        let home = root.join("home"); search_fixture_candidate(&home, ".bun/bin", b"home");
        let path = fixture_search_path(&not_directory);
        assert!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target,
            |_| panic!("metadata failure must not execute"), || panic!("metadata failure must not acquire")).is_err());
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(bin.join(if cfg!(windows) { "bun.exe" } else { "bun" })).unwrap();
        let path = fixture_search_path(&bin);
        assert!(ensure_bun_from_search_with(Some(&path), Some(&home), &root, &target,
            |_| panic!("directory must not execute"), || panic!("special candidate must not acquire")).is_err());
        assert_eq!(std::fs::read(not_directory).unwrap(), b"unchanged"); std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(windows)]
    #[ignore = "requires Windows symlink privilege; definitions are not native evidence"]
    fn install_search_windows_managed_reparse_and_alias_refuse_before_process() {
        use std::os::windows::fs::{symlink_file, MetadataExt};
        let (root, _download, target) = repair_fixture("search-windows-reparse");
        let external = root.join("external.exe"); std::fs::write(&external, b"healthy-external").unwrap();
        std::fs::remove_file(&target).unwrap(); symlink_file(&external, &target).unwrap();
        assert_ne!(std::fs::symlink_metadata(&target).unwrap().file_attributes() & 0x400, 0);
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap(); let alias = bin.join("bun.exe"); symlink_file(&target, &alias).unwrap();
        let before_target = selection_entry(&target); let before_alias = selection_entry(&alias);
        for directory in [&root, &bin] {
            let path = fixture_search_path(directory); let probes = std::cell::Cell::new(0); let acquires = std::cell::Cell::new(0);
            assert!(ensure_bun_from_search_with(Some(&path), None, &root, &target, |_| {
                probes.set(probes.get() + 1); BunCandidateProbe::Supported
            }, || { acquires.set(acquires.get() + 1); Ok(target.clone()) }).is_err());
            assert_eq!(probes.get(), 0); assert_eq!(acquires.get(), 0);
        }
        assert_eq!(selection_entry(&target), before_target); assert_eq!(selection_entry(&alias), before_alias);
        assert_eq!(std::fs::read_link(&target).unwrap(), external); assert_eq!(std::fs::read(&external).unwrap(), b"healthy-external");
        std::fs::remove_dir_all(root).unwrap();
    }

    // These two definitions call the exact public entry used by main's
    // installation_bun (not only the injected coordinator). POSIX fixtures only.
    #[test]
    #[cfg(unix)]
    fn install_public_search_rejects_managed_marker_alias_before_any_process() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _download, _old_target) = repair_fixture("search-public-marker-alias");
        let into = ordinary_absolute(&crate::acquire::download_dir(&root).join(format!("bun-{BUN}"))).unwrap();
        std::fs::create_dir_all(&into).unwrap(); let target = into.join("bun");
        let external = root.join("marker-runtime");
        std::fs::write(&external, b"#!/bin/sh\nprintf entered >> \"$0.marker\"\nprintf '1.3.14\\n'\n").unwrap();
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&external, &target).unwrap();
        let bin = root.join("path-bin"); std::fs::create_dir(&bin).unwrap(); let alias = bin.join("bun");
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        let target_before = selection_entry(&target); let alias_before = selection_entry(&alias);
        let external_before = selection_entry(&external); let original = std::fs::read(&external).unwrap();
        let path = fixture_search_path(&bin);
        assert!(ensure_bun_from_search(&root, Some(&path), None, &root).is_err());
        assert!(!bin.join("bun.marker").exists()); assert!(!into.join("bun.marker").exists()); assert!(!root.join("marker-runtime.marker").exists());
        assert_eq!(selection_entry(&target), target_before); assert_eq!(selection_entry(&alias), alias_before);
        assert_eq!(selection_entry(&external), external_before); assert_eq!(std::fs::read(&external).unwrap(), original);
        assert_eq!(std::fs::read_link(&target).unwrap(), external); assert_eq!(std::fs::read_link(&alias).unwrap(), target);
        // No repair work/archive/quarantine or success target could have appeared.
        assert_eq!(std::fs::read_dir(&into).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_public_search_probes_exact_external_marker_once_without_managed_creation() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _download, _old_target) = repair_fixture("search-public-external-marker");
        let external = search_fixture_candidate(&root, "path-bin", b"#!/bin/sh\nprintf entered >> \"$0.marker\"\nprintf '1.3.14\\n'\n");
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o700)).unwrap();
        let before = selection_entry(&external); let bytes = std::fs::read(&external).unwrap();
        let path = fixture_search_path(external.parent().unwrap());
        let into = crate::acquire::download_dir(&root).join(format!("bun-{BUN}"));
        assert!(!into.exists());
        assert_eq!(ensure_bun_from_search(&root, Some(&path), None, &root).unwrap(), external);
        assert_eq!(std::fs::read(external.with_file_name("bun.marker")).unwrap(), b"entered");
        assert!(!into.exists()); assert_eq!(selection_entry(&external), before); assert_eq!(std::fs::read(&external).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_public_search_skips_absent_exact_managed_candidate_for_later_external() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _download, old_fixture) = repair_fixture("search-absent-managed-first");
        let into = ordinary_absolute(&crate::acquire::download_dir(&root).join(format!("bun-{BUN}"))).unwrap();
        std::fs::create_dir_all(&into).unwrap(); let target = into.join("bun");
        assert!(!target.exists()); assert_eq!(std::fs::read_dir(&into).unwrap().count(), 0);
        let external = search_fixture_candidate(&root, "later-external", b"#!/bin/sh\nprintf entered >> \"$0.marker\"\nprintf '1.3.14\\n'\n");
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o700)).unwrap();
        let before_external = selection_entry(&external); let bytes = std::fs::read(&external).unwrap();
        let before_into = selection_entry(&into); let before_old = selection_entry(&old_fixture);
        let path = std::env::join_paths([into.as_path(), external.parent().unwrap()]).unwrap();
        // Exact production entry used by main's installation_bun: real passive
        // resolver/selector/native probe. No injected successful acquisition.
        assert_eq!(ensure_bun_from_search(&root, Some(&path), None, &root).unwrap(), external);
        // A single marker means only the later external locator was probed once.
        assert_eq!(std::fs::read(external.with_file_name("bun.marker")).unwrap(), b"entered");
        assert!(!target.exists()); assert_eq!(std::fs::read_dir(&into).unwrap().count(), 0);
        assert_eq!(selection_entry(&into), before_into); assert_eq!(selection_entry(&external), before_external);
        assert_eq!(selection_entry(&old_fixture), before_old); assert_eq!(std::fs::read(&external).unwrap(), bytes);
        assert_eq!(std::fs::read(&old_fixture).unwrap(), b"bad-old-runtime");
        // Managed acquisition returns the managed target and creates repair
        // entries; neither can satisfy these exact-path/empty-directory checks.
        std::fs::remove_dir_all(root).unwrap();
    }

}
