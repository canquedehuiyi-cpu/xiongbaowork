//! Putting the deployment on disk, which is not what the installer carries.
//!
//! The installer stays small: a Tauri binary and nothing else. What it needs to run a deployment is
//! fetched on first run and kept beside it, at a version this app records: `docker-compose.yml` and
//! the image list for the containers (see `LAYOUT`). Everything else runs from the release's images,
//! the server, the app, the worker, the computer, their migrations and the tenant package included.
//!
//! What is fetched is the release's own source tarball, at a tag. Not `main`: an app that pulls
//! whatever is on a branch this morning is not a version anybody can be given, and the images the
//! stack runs are pinned per release, so the tree that names them has to be pinned too.

#[path = "release_transaction.rs"]
mod release_transaction;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Written beside the deployment so the app can tell what it already put there.
const STAMP: &str = ".openbot-deployment";

/// The release asset that says which images this version runs.
///
/// Kept beside the deployment because the tree does not contain it: `docker-compose.yml` names
/// `openbot-supervisor:latest` and friends as defaults, which are local build names that exist on a
/// developer's machine and nowhere else. A desktop install has never built anything, so without
/// this file Compose asks Docker Hub for images that are not there and reports a denial, which
/// reads as an authentication problem and is not one.
const IMAGES: &str = "container-images.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Installed {
    pub version: String,
    /// The top-level entries this app laid out. A stamp written before this existed reads as
    /// empty, which never matches, so that deployment is laid out again.
    #[serde(default)]
    pub layout: Vec<String>,
    /// Whether the version was chosen on purpose rather than followed. A stamp written before
    /// pinning existed reads as unpinned.
    #[serde(default)]
    pub pinned: bool,
}

/// The tarball GitHub publishes for a tag.
///
/// A release asset rather than a branch, and https rather than git, so nothing needs a git client
/// or credentials to get a deployment.
pub fn tarball_url(version: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/archive/refs/tags/{version}.tar.gz")
}

/// Where the release publishes its image manifest.
pub fn images_url(version: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/releases/download/{version}/{IMAGES}")
}

pub fn images_path(root: &Path) -> PathBuf {
    root.join(IMAGES)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Image {
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Images {
    pub version: String,
    pub images: BTreeMap<String, Image>,
}

/// The Compose variable each published image answers to.
///
/// A published name on the left, a Compose variable on the right, because the two vocabularies are
/// different and neither is going to change to suit the other.
pub const IMAGE_VARIABLES: [(&str, &str); 5] = [
    ("server", "SERVER_IMAGE"),
    ("supervisor", "SUPERVISOR_IMAGE"),
    ("agent-computer", "COMPUTER_IMAGE"),
    ("agent-bot", "BOT_IMAGE"),
    ("agent-langgraph", "LANGGRAPH_IMAGE"),
];

/// Read the manifest laid down beside the deployment and turn it into Compose variables.
///
/// Digests, not tags. A tag can be moved to point at a different image after the version that was
/// tested; a digest is the image that was tested.
pub fn image_variables(root: &Path) -> Result<Vec<(String, String)>, String> {
    pin(&read_images(root)?)
}

/// One published image's reference, digest-pinned, from the manifest beside the deployment.
///
/// Every image reference comes from here, whether Compose reads it or the shell runs it directly.
/// The alternative was a name built from a version, and an engine given an unqualified name looks
/// it up on Docker Hub: `openbot-agent-langgraph-agui:v0.0.8` became
/// `docker.io/library/openbot-agent-langgraph-agui`, and the person was shown "requested access to
/// the resource is denied", which reads as a credentials problem and is not one.
///
/// An image this release does not publish is named as that. It is the honest answer and the
/// actionable one: the alternative is somebody debugging registry permissions for an image that
/// was never pushed.
pub fn reference(root: &Path, published: &str) -> Result<String, String> {
    let manifest = read_images(root)?;
    manifest
        .images
        .get(published)
        .map(|image| image.reference.clone())
        .ok_or_else(|| format!("OpenBot {} does not include {published}.", manifest.version))
}

/// Format validation is not publisher authentication or registry authorization.
fn valid_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the release version is empty or contains whitespace/control characters".into());
    }
    Ok(())
}

/// One shared grammar for required and directly referenced extra images.
/// Accept repository[:tag]@sha256:<64 lowercase hex>, including registry ports.
fn validate_reference(reference: &str) -> Result<(), String> {
    let invalid = || "the image reference is not a digest-pinned repository".to_string();
    if !reference.is_ascii()
        || reference.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        || reference.chars().any(|c| matches!(c, '?' | '#' | '\\'))
    {
        return Err(invalid());
    }
    let (named, digest) = reference.split_once('@').ok_or_else(invalid)?;
    if named.is_empty() || digest.contains('@') {
        return Err(invalid());
    }
    let hex = digest.strip_prefix("sha256:").ok_or_else(invalid)?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(invalid());
    }
    let last_slash = named.rfind('/');
    let last_colon = named.rfind(':');
    let repository = match last_colon {
        Some(colon) if last_slash.map_or(true, |slash| colon > slash) => {
            let tag = &named[colon + 1..];
            if tag.is_empty()
                || tag.len() > 128
                || !tag.as_bytes()[0].is_ascii_alphanumeric() && tag.as_bytes()[0] != b'_'
                || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                return Err(invalid());
            }
            &named[..colon]
        }
        _ => named,
    };
    let components: Vec<&str> = repository.split('/').collect();
    for (index, component) in components.iter().enumerate() {
        let registry = index == 0 && components.len() > 1
            && (component.chars().any(|c| matches!(c, '.' | ':'))
                || component.bytes().any(|b| b.is_ascii_uppercase())
                || *component == "localhost");
        if !(if registry { valid_registry(component) } else { valid_repository_component(component) }) {
            return Err(invalid());
        }
    }
    Ok(())
}

// Distribution repository components: lowercase alphanumeric groups separated
// by one dot, one/two underscores, or one/more hyphens. Never normalize input.
fn valid_repository_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        while i < bytes.len() && alnum(bytes[i]) { i += 1; }
        if i == start { return false; }
        if i == bytes.len() { return true; }
        match bytes[i] {
            b'.' => i += 1,
            b'_' => {
                i += 1;
                if i < bytes.len() && bytes[i] == b'_' { i += 1; }
            }
            b'-' => while i < bytes.len() && bytes[i] == b'-' { i += 1; },
            _ => return false,
        }
        if i == bytes.len() { return false; }
    }
    false
}

fn valid_registry(registry: &str) -> bool {
    let port_ok = |port: &str| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit());
    if let Some(ipv6) = registry.strip_prefix('[') {
        let Some((address, suffix)) = ipv6.split_once(']') else { return false; };
        return address.parse::<std::net::Ipv6Addr>().is_ok()
            && (suffix.is_empty() || suffix.strip_prefix(':').is_some_and(port_ok));
    }
    let host = if let Some((host, port)) = registry.split_once(':') {
        if !port_ok(port) { return false; }
        host
    } else { registry };
    host.split('.').all(|label| {
        !label.is_empty()
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

/// The two runtime readers share the same trusted stamp/manifest boundary.
/// Do not use installed(): it intentionally treats broken stamps as a fetch hint.
fn read_images(root: &Path) -> Result<Images, String> {
    let stamp = std::fs::read_to_string(stamp_path(root))
        .map_err(|_| "the installed release stamp cannot be read".to_string())?;
    let installed: Installed = serde_json::from_str(&stamp)
        .map_err(|_| "the installed release stamp is not readable JSON".to_string())?;
    valid_version(&installed.version)?;
    let body = std::fs::read(images_path(root))
        .map_err(|_| format!("{IMAGES} cannot be read"))?;
    checked_images(&body, &installed.version)
}

fn checked_images(body: &[u8], expected: &str) -> Result<Images, String> {
    valid_version(expected)?;
    let manifest: Images = serde_json::from_slice(body)
        .map_err(|_| format!("{IMAGES} is not readable JSON"))?;
    pin(&manifest)?;
    if manifest.version != expected {
        return Err("the image manifest version does not match the fixed release".into());
    }
    Ok(manifest)
}

/// Every image the stack runs, or a failure that names the one that is missing.
///
/// Refusing a partial manifest rather than filling the gaps from Compose's defaults: a stack that
/// runs four published images and one local build is neither the released version nor a build, and
/// the difference would only show up as behaviour nobody can reproduce.
pub fn pin(manifest: &Images) -> Result<Vec<(String, String)>, String> {
    valid_version(&manifest.version)?;
    for image in manifest.images.values() {
        validate_reference(&image.reference)?;
    }
    let mut pinned = Vec::new();
    for (published, variable) in IMAGE_VARIABLES {
        let image = manifest.images.get(published).ok_or_else(|| {
            format!(
                "{IMAGES} for {} names no {published} image.",
                manifest.version
            )
        })?;
        pinned.push((variable.to_string(), image.reference.clone()));
    }
    Ok(pinned)
}

/// The release a build was pinned to, compiled into the binary.
///
/// `images` is the manifest text exactly as it was at build time, so what gets laid down on disk
/// is the manifest that was tested and not a re-serialisation of it. `commit` is the source the
/// release was cut from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pin {
    pub version: String,
    pub commit: String,
    pub images: &'static str,
}

/// Build a [`Pin`] from manifest text and a commit, taking the version from the manifest.
///
/// Unreadable text is an error rather than a pin with no version: a build that cannot say which
/// release it is has nothing to be pinned to.
pub fn pin_from(images: &'static str, commit: &str) -> Result<Pin, String> {
    let manifest: Images = serde_json::from_str(images)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    Ok(Pin {
        version: manifest.version,
        commit: commit.to_string(),
        images,
    })
}

/// The release this build was pinned to, or `None` for an ordinary build.
///
/// Only a build made with `OPENBOT_PINNED_DEPLOYMENT` set carries a pin; build.rs decides that and
/// the compiler removes the other branch, so an ordinary build has no manifest inside it.
#[cfg(openbot_pinned)]
pub fn pinned() -> Option<Pin> {
    Some(
        pin_from(
            include_str!(concat!(env!("OUT_DIR"), "/pinned-images.json")),
            env!("OPENBOT_PINNED_COMMIT"),
        )
        .expect("the manifest this build was pinned to is readable; rebuild with a valid OPENBOT_PINNED_DEPLOYMENT"),
    )
}

/// The release this build was pinned to, or `None` for an ordinary build.
#[cfg(not(openbot_pinned))]
pub fn pinned() -> Option<Pin> {
    None
}

pub fn stamp_path(root: &Path) -> PathBuf {
    root.join(STAMP)
}

/// What version is already there, if any.
pub fn installed(root: &Path) -> Option<Installed> {
    std::fs::read_to_string(stamp_path(root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub fn record(root: &Path, version: &str, pinned: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let stamp = Installed {
        version: version.to_string(),
        layout: layout(),
        pinned,
    };
    std::fs::write(
        stamp_path(root),
        serde_json::to_string(&stamp).unwrap_or_default(),
    )
}

/// Whether anything needs fetching.
///
/// Answered from the stamp rather than by looking for files, so a half-extracted directory from an
/// interrupted download is replaced rather than trusted: the stamp is written last, and its absence
/// means the fetch did not finish.
///
/// The image manifest is the one exception. A deployment laid down by an app that predates it has a
/// stamp that matches and no manifest, and re-fetching is a better answer than an error about a
/// file the person has never heard of.
///
/// So is a stamp that laid out less than this app needs. An app that left a file out wrote a stamp
/// that still matches its version, and Repair would otherwise keep the gap forever. A stamp that
/// laid out more (an app that copied whole folders, `agent-computer` and `shared` among them) covers
/// what this app needs, and is not fetched again for that.
pub fn needs_fetch(root: &Path, wanted: &str) -> bool {
    if !images_path(root).exists() {
        return true;
    }
    match installed(root) {
        Some(found) => {
            found.version != wanted || !covers(&found.layout) || predates_containers(root)
        }
        None => true,
    }
}

/// Whether a stamp's recorded layout includes every path this app lays out: the path itself, or a
/// folder it is in.
fn covers(recorded: &[String]) -> bool {
    LAYOUT.iter().all(|path| {
        recorded
            .iter()
            .any(|entry| *path == entry || path.starts_with(&format!("{entry}/")))
    })
}

/// Whether the deployment on disk is a release from before OpenBot's server and worker were
/// Compose services.
///
/// Such a release ran both as Bun processes on the host, and this app no longer starts those. Its
/// Compose file has no `server` or `worker` to raise, and its server image has no worker in it, so
/// keeping its pin would leave an installation that used to start unable to. Answered from the
/// Compose file because that is what is missing; an unreadable or absent file is a damaged
/// deployment, not an old one, and the ordinary repair of the pinned version covers it.
pub fn predates_containers(root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(root.join("docker-compose.yml")) else {
        return false;
    };
    let services = compose_services(&text);
    !(services.contains(&"server") && services.contains(&"worker"))
}

/// The service names in a Compose file, read line by line.
///
/// Not a YAML parser, and not meant to be one: it reads the shape `docker-compose.yml` in this
/// repository has always had, a top-level `services:` with each service two spaces in. That is the
/// only file this is ever pointed at, and it is enough to tell whether a service is declared.
fn compose_services(text: &str) -> Vec<&str> {
    let mut in_services = false;
    let mut services = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') {
            in_services = line.starts_with("services:");
            continue;
        }
        let Some(entry) = line.strip_prefix("  ").filter(|_| in_services) else {
            continue;
        };
        if entry.starts_with(' ') {
            continue;
        }
        if let Some((name, _)) = entry.split_once(':') {
            services.push(name.trim().trim_matches(|c| c == '"' || c == '\''));
        }
    }
    services
}

/// What this app lays out, in a fixed order, as recorded in the stamp.
fn layout() -> Vec<String> {
    let mut entries: Vec<String> = LAYOUT.iter().map(|entry| entry.to_string()).collect();
    entries.sort();
    entries
}

/// Everything a deployment runs from on this machine, out of the release's source tarball.
///
/// The containers need only the Compose file (and `.env`, `.openbot/` and `.langchain/`, which are
/// the installation's own): every container runs from an image the release pins by digest, the
/// server's migrations and the tenant package (`examples/`) included. So no `server`, `app`,
/// `worker`, `toolkit`, `scripts` or `patches` is laid out, and nothing installs their packages.
///
/// Nothing runs from source on the host either. Earlier versions laid out `agent-computer` and the
/// `shared` files it imports, for a browser of the person's own they ran on the desktop beside the
/// server; the person's browser is on the one computer now, shown in the OpenBot window. A stamp that
/// laid those out still covers this layout ([`needs_fetch`]), and Start's upgrade takes the files
/// away with the previous version (`upgrade::KEPT`).
pub const LAYOUT: [&str; 1] = ["docker-compose.yml"];

// M3: upstream v1.0.0 replaced these with `LAYOUT`. The fork's staged release admission
// (`admission_selected`) still selects a release bundle's top-level entries by them; they no longer
// describe what is laid out live.
/// The top-level entries a staged release bundle is checked for.
const REQUIRED: [&str; 4] = ["docker-compose.yml", "server", "app", "worker"];

/// The rest of what a staged release bundle may carry, which is not what it is checked for.
const ALSO_COPIED: [&str; 8] = [
    "shared",
    "toolkit",
    "examples",
    "package.json",
    "bun.lock",
    "scripts",
    "tsconfig.base.json",
    "bunfig.toml",
];

/// Legacy entry has no checked stage context and can never mutate a deployment.
/// Real Install acquisition uses main's explicit context and fetch_staged below.
pub fn fetch(root: &Path, version: &str) -> Result<(), String> {
    let _ = root;
    valid_version(version)?;
    Err("PUBLICATION_UNAVAILABLE: UNVERIFIED_PUBLICATION_CONTEXT".into())
}

/// Downloads the URL it is given. A parameter so laying out real archives can run without a network.
pub type Download<'a> = &'a dyn Fn(&str) -> Result<Vec<u8>, String>;

/// [`fetch`], downloading through `get`.
///
/// M3: upstream v1.0.0 lays the tag's tarball out in place here, for Install and for Start's
/// upgrade (`upgrade.rs`). This fork never lays an unverified download out over a deployment (see
/// [`fetch`] and [`fetch_staged`]), so this fails closed the same way and downloads nothing: an
/// upgrade's lay-out step fails and the upgrade keeps the previous release.
pub fn fetch_with(root: &Path, version: &str, get: Download) -> Result<(), String> {
    let _ = get;
    fetch(root, version)
}

/// The tarball GitHub publishes for a commit.
///
/// A pinned build's release was cut from a commit, not a tag that could be moved.
pub fn commit_tarball_url(commit: &str) -> String {
    format!("https://github.com/CopilotKit/OpenBot/archive/{commit}.tar.gz")
}

/// Lay out the commit a pinned build was cut from, with the images the build was compiled with.
///
/// M3: upstream v1.0.0 downloads the commit's archive and unpacks it in place. That archive has no
/// digest to check against, so in this fork a pinned build fails closed like [`fetch`]; the pin's
/// manifest is still checked first, so a broken pin says so.
pub fn fetch_pinned(root: &Path, pin: &Pin) -> Result<(), String> {
    let _ = root;
    let manifest: Images = serde_json::from_str(pin.images)
        .map_err(|error| format!("{IMAGES} is not readable: {error}"))?;
    self::pin(&manifest)?;
    Err("PUBLICATION_UNAVAILABLE: UNVERIFIED_PUBLICATION_CONTEXT".into())
}

/// Where an archive entry may be written under `root`, or `None` when it is not
/// part of a deployment.
///
/// The traversal is refused here rather than after the fact. `Path::join`
/// followed by `starts_with` compares components and does not resolve `..`, so
/// `root.join("app/../../elsewhere")` starts with `root` and still lands outside
/// it -- which made the check that was there read as a guard without being one.
/// Every component of a path inside the tree is an ordinary name, so anything
/// else (`..`, an absolute path, a Windows drive prefix) is refused outright.
fn destination_in(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    // GitHub wraps everything in one directory named for the tag. Strip it, so the deployment
    // lands at `root` rather than at `root/OpenBot-0.0.7`.
    let mut parts = path.components();
    parts.next();
    let relative: PathBuf = parts.collect();
    if relative.as_os_str().is_empty() {
        return Ok(None);
    }

    // Nothing outside `root`, whatever the archive says. A tarball is somebody else's file.
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!(
            "the download tried to write outside {}: {}",
            root.display(),
            path.display()
        ));
    }

    // Only what a deployment needs. The rest of the tree is a place to develop, not to run.
    let names: Vec<String> = relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    let path = names.join("/");
    let wanted = LAYOUT
        .iter()
        .any(|kept| path == *kept || path.starts_with(&format!("{kept}/")));
    if !wanted {
        return Ok(None);
    }

    Ok(Some(root.join(&relative)))
}

/// Lay the tarball's deployment files out under `root`.
///
/// Historical private decoder retained for its original fixture tests only.
/// No production caller remains; it is not a fallback from fetch/fetch_staged.
fn unpack(root: &Path, body: &[u8]) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(body);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("the download is not readable: {error}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("could not read the download: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("could not read a path in the download: {error}"))?
            .into_owned();

        let Some(destination) = destination_in(root, &path)? else {
            continue;
        };
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not make {}: {error}", parent.display()))?;
        }
        entry
            .unpack(&destination)
            .map_err(|error| format!("could not write {}: {error}", destination.display()))?;
    }

    Ok(())
}

/// Fetch the image manifest and check it before anything depends on it.
///
/// Parsed here rather than at start-up so a release missing an image fails while the person is
/// still looking at a screen that says what is being fetched, not later inside Compose's output.
fn fetch_images(root: &Path, version: &str) -> Result<(), String> {
    valid_version(version)?;
    let body = get(&images_url(version))
        .map_err(|error| format!("could not fetch the image list for {version}: {error}"))?;
    save_images(root, version, &body)
}

/// Validate the entire response before touching the existing manifest. The fetcher
/// records its success stamp only after this returns Ok; unpack is still in-place.
fn save_images(root: &Path, requested: &str, body: &[u8]) -> Result<(), String> {
    checked_images(body, requested)?;
    std::fs::write(images_path(root), body)
        .map_err(|error| format!("could not write {IMAGES}: {error}"))
}

/**
Fetch a URL into memory, trying again when the connection fails or the download stalls.

Shared with `install.rs`, which fetches the engine's installers through it and then checks their
digests, and with the release lookup. One client, one user agent, one set of TLS defaults, one way
to download.

NO LIMIT ON THE WHOLE DOWNLOAD, ONLY ON SILENCE. A download that keeps arriving is never cut off,
however slow the line. One that stops is: connecting may take `CONNECT_TIMEOUT`, and after that
nothing may go `STALL_TIMEOUT` without a byte arriving, whether that is the server's answer or the
next piece of the body. Without that, a download GitHub stops sending would wait forever.

TRIED AGAIN, WAITING LONGER EACH TIME. One connection cut part-way through Bun's download used to
fail the whole Start, though the same download finished in under three seconds a minute later. And
on 2026-11-08 the Desktop's first update after an install asked GitHub for the commit's archive and
got no answer for 30 seconds, three times running; it gave up after its third attempt, about a
minute and a half in, and the update was put back. Opening OpenBot again two minutes later
downloaded the same archive in two seconds. So a failure that says nothing about the file is tried
again, `RETRY_DELAYS` apart, for about four minutes at worst: the server could not be reached, sent
nothing for the stall window, did not send the whole body, or answered 5xx or 429. Any other
answer, a 404 in particular, means the file is not there, and is reported at once: the release
lookups depend on seeing that promptly.

A later attempt downloads the whole file again. GitHub answers a byte range of a commit's archive
with the whole archive (200, no Accept-Ranges), so there is nothing to resume from, and `install.rs`
still checks the digest of the copy that is kept.

FROM downloads.copilotkit.ai FIRST. A GitHub download that downloads.copilotkit.ai keeps a copy of
(`mirrored`) is asked of it first, once, and of GitHub, as above, only when that fails.
*/
pub fn get(url: &str) -> Result<Vec<u8>, String> {
    if let Some(copy) = mirrored(url) {
        match get_from_mirror(&copy) {
            Ok(body) => return Ok(body),
            Err(error) => log::warn!("[download] {error}; downloading {url} instead"),
        }
    }
    get_with(url, STALL_TIMEOUT, WAITS)
}

/// The host that keeps a copy of what this app downloads from GitHub: CloudFront over an S3 bucket,
/// which answers 403 for a file it does not have. See `image_mirror` for the images.
pub const DOWNLOADS: &str = "https://downloads.copilotkit.ai";

/// Where downloads.copilotkit.ai keeps its copy of a GitHub download, for the downloads it copies:
/// OpenBot's release assets and a tag's source archive (kept with the release, as
/// `releases/<tag>/<tag>.tar.gz`), and the Podman and Compose builds `install.rs` installs, each
/// under the same version and file name. `None` for anything else, a commit's archive included.
pub fn mirrored(url: &str) -> Option<String> {
    if let Some(tag) = url
        .strip_prefix("https://github.com/CopilotKit/OpenBot/archive/refs/tags/")
        .and_then(|rest| rest.strip_suffix(".tar.gz"))
    {
        return (!tag.is_empty() && !tag.contains('/'))
            .then(|| format!("{DOWNLOADS}/releases/{tag}/{tag}.tar.gz"));
    }
    const COPIES: [(&str, &str); 3] = [
        (
            "https://github.com/CopilotKit/OpenBot/releases/download/",
            "releases/",
        ),
        (
            "https://github.com/podman-container-tools/podman/releases/download/",
            "tools/podman/",
        ),
        (
            "https://github.com/docker/compose/releases/download/",
            "tools/compose/",
        ),
    ];
    COPIES.iter().find_map(|(github, copy)| {
        let rest = url.strip_prefix(github)?;
        (rest.contains('/') && !rest.ends_with('/')).then(|| format!("{DOWNLOADS}/{copy}{rest}"))
    })
}

/// One try at a copy on downloads.copilotkit.ai, with no retries: when it fails, GitHub is asked.
pub fn get_from_mirror(url: &str) -> Result<Vec<u8>, String> {
    get_waiting(url, STALL_TIMEOUT)
        .map_err(|(Failed::ForNow(error) | Failed::ForGood(error))| error)
}

/// The waits `get` makes between attempts: `RETRY_DELAYS`, and in this crate's tests the same
/// number of attempts with no wait, since a test that downloads from an address nobody answers on
/// would otherwise sit through a minute of them.
#[cfg(not(test))]
const WAITS: &[std::time::Duration] = &RETRY_DELAYS;
#[cfg(test)]
const WAITS: &[std::time::Duration] = &[std::time::Duration::ZERO; RETRY_DELAYS.len()];

/// How long connecting to the server may take, before anything is asked of it.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// How long a download may go without receiving anything, its answer included, before this attempt
/// is given up.
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The waits before each attempt after the first, doubling: six attempts in all. A server that
/// never answers is given up after 6 x 30 s of silence and 62 s of waiting, a little over four
/// minutes. On 2026-11-08 the download that worked came 3 minutes 38 seconds after the first
/// attempt; these attempts reach past that.
const RETRY_DELAYS: [std::time::Duration; 5] = [
    std::time::Duration::from_secs(2),
    std::time::Duration::from_secs(4),
    std::time::Duration::from_secs(8),
    std::time::Duration::from_secs(16),
    std::time::Duration::from_secs(32),
];

/// `get`, with one attempt more than there are `delays`, waiting each delay in turn before trying
/// again. Each retry is written to the log, and the last error says how many attempts were made,
/// so Technical details shows it tried again.
fn get_with(
    url: &str,
    stall: std::time::Duration,
    delays: &[std::time::Duration],
) -> Result<Vec<u8>, String> {
    let mut attempts = 1;
    loop {
        match get_waiting(url, stall) {
            Ok(body) => return Ok(body),
            Err(Failed::ForGood(error)) => return Err(error),
            Err(Failed::ForNow(error)) => match delays.get(attempts - 1) {
                Some(delay) => {
                    log::warn!(
                        "[download] attempt {attempts} of {}: {error}; trying again in {}",
                        delays.len() + 1,
                        said(*delay)
                    );
                    std::thread::sleep(*delay);
                    attempts += 1;
                }
                None if attempts == 1 => return Err(error),
                None => return Err(format!("{error} ({attempts} attempts)")),
            },
        }
    }
}

/// Why one attempt at a download failed, and so whether another could succeed.
enum Failed {
    /// The connection or the server failed; the same request may work in a moment.
    ForNow(String),
    /// The server answered that it will not give the file.
    ForGood(String),
}

/// A duration as Technical details says it: "30 s", "300 ms".
fn said(duration: std::time::Duration) -> String {
    if duration.as_millis().is_multiple_of(1000) {
        format!("{} s", duration.as_secs())
    } else {
        format!("{} ms", duration.as_millis())
    }
}

/// Whether an error from the client is its timeout, said or carried inside an `io::Error`.
fn timed_out(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut source = Some(error);
    while let Some(error) = source {
        if error
            .downcast_ref::<reqwest::Error>()
            .is_some_and(reqwest::Error::is_timeout)
        {
            return true;
        }
        // An `io::Error`'s `source()` skips the error it carries, so that one is looked at here.
        if let Some(error) = error.downcast_ref::<std::io::Error>() {
            if error.kind() == std::io::ErrorKind::TimedOut {
                return true;
            }
            if let Some(inner) = error.get_ref() {
                if timed_out(inner) {
                    return true;
                }
            }
        }
        source = error.source();
    }
    false
}

/**
One attempt at `get`, giving up when connecting takes longer than `CONNECT_TIMEOUT` or nothing
arrives for `stall`.

READ AS A STREAM, NOT WITH `bytes()`. The blocking client's timeout bounds waiting for the answer and
each read on a stream, but `bytes()` waits for the whole body within it, and reports running out of
time as "error decoding response body". So any download that took longer than 30 seconds failed,
however steadily it was arriving: Bun's 30 MB on a connection under about 1 MB/s, every time. Read
as a stream, the timeout is the stall window and nothing else.
*/
fn get_waiting(url: &str, stall: std::time::Duration) -> Result<Vec<u8>, Failed> {
    use std::io::Read;
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("openbot-desktop")
        .connect_timeout(CONNECT_TIMEOUT.min(stall))
        .timeout(stall)
        .build()
        .map_err(|error| Failed::ForGood(format!("could not prepare the download: {error}")))?
        .get(url)
        .send()
        .map_err(|error| {
            Failed::ForNow(if timed_out(&error) && !error.is_connect() {
                format!("{url} sent nothing for {}", said(stall))
            } else {
                format!("could not reach {url}: {error}")
            })
        })?;
    let status = response.status();
    if !status.is_success() {
        let error = format!("{url} answered {status}");
        return Err(
            if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                Failed::ForNow(error)
            } else {
                Failed::ForGood(error)
            },
        );
    }
    let mut body = Vec::new();
    response.read_to_end(&mut body).map_err(|error| {
        Failed::ForNow(if timed_out(&error) {
            format!(
                "the download did not finish: nothing arrived for {} after {} bytes",
                said(stall),
                body.len()
            )
        } else {
            format!("the download did not finish: {error}")
        })
    })?;
    Ok(body)
}

// F4a internal in-memory admission, NOT WIRED to fetch/unpack or live state.
// This conservative bundle policy is not a final vendor compatibility promise.
#[derive(Clone, Copy, Debug)]
struct AdmissionLimits {
    max_entries: usize,
    max_total_uncompressed: usize, // all actual entry payload, selected or excluded
    max_tar_bytes: usize, // all decompressed headers/payload/padding/footer
    max_entry_bytes: usize,
    max_path_bytes: usize,
    max_source_bytes: usize,
    max_images_bytes: usize,
}

impl AdmissionLimits {
    fn validate(&self) -> Result<(), String> {
        let values = [self.max_entries, self.max_total_uncompressed, self.max_entry_bytes,
            self.max_path_bytes, self.max_source_bytes, self.max_images_bytes, self.max_tar_bytes];
        if values.iter().any(|value| *value == 0 || *value == usize::MAX) {
            return Err("admission limits must be explicit positive bounded values".into());
        }
        if self.max_entry_bytes > self.max_total_uncompressed || self.max_path_bytes > self.max_total_uncompressed {
            return Err("admission entry/path limits exceed the total uncompressed bound".into());
        }
        if self.max_total_uncompressed > self.max_tar_bytes {
            return Err("admission payload cap exceeds the full tar byte cap".into());
        }
        self.max_entries.checked_mul(self.max_path_bytes)
            .ok_or_else(|| "admission inventory limit arithmetic overflow".to_string())?;
        Ok(())
    }

    fn check_inputs(&self, source: &[u8], images: &[u8]) -> Result<(), String> {
        self.validate()?;
        if source.len() > self.max_source_bytes || images.len() > self.max_images_bytes {
            return Err("admission buffered input exceeds its explicit cap".into());
        }
        Ok(())
    }
}

// Separate actual full-tar and actual payload counters. Header declarations
// are preflight bounds only; successful admission also reconciles actual reads.
struct AdmissionBudget {
    limits: AdmissionLimits,
    entries: usize,
    tar: usize,
    total: usize,
    entry: usize,
}

impl AdmissionBudget {
    fn new(limits: AdmissionLimits) -> Result<Self, String> {
        limits.validate()?;
        Ok(Self { limits, entries: 0, tar: 0, total: 0, entry: 0 })
    }

    fn read_tar(&mut self, actual_bytes: usize) -> Result<(), String> {
        let next = self.tar.checked_add(actual_bytes).ok_or("admission tar byte count overflow")?;
        if next > self.limits.max_tar_bytes { return Err("admission tar bytes exceed cap".into()); }
        self.tar = next;
        Ok(())
    }

    fn begin_entry(&mut self) -> Result<(), String> {
        let next = self.entries.checked_add(1).ok_or("admission entry count overflow")?;
        if next > self.limits.max_entries { return Err("admission entry count exceeds cap".into()); }
        self.entries = next;
        self.entry = 0;
        Ok(())
    }

    fn read_uncompressed(&mut self, actual_bytes: usize) -> Result<(), String> {
        let next = self.total.checked_add(actual_bytes).ok_or("admission uncompressed count overflow")?;
        if next > self.limits.max_total_uncompressed { return Err("admission uncompressed bytes exceed cap".into()); }
        self.total = next;
        Ok(())
    }

    fn read_entry_payload(&mut self, actual_bytes: usize) -> Result<(), String> {
        if self.entries == 0 { return Err("admission payload has no current entry".into()); }
        let next = self.entry.checked_add(actual_bytes).ok_or("admission entry byte count overflow")?;
        if next > self.limits.max_entry_bytes { return Err("admission entry bytes exceed cap".into()); }
        self.entry = next;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AdmissionKind { Regular, Directory }

struct AdmissionRequirement<'a> {
    path: &'a str,
    kind: AdmissionKind,
}

// A strict portable INTERNAL naming subset; no filesystem canonicalization,
// Windows CAS, or official-release compatibility assertion is implied.
fn admission_path(path: &str, directory: bool, max_bytes: usize) -> Result<String, String> {
    if max_bytes == 0 || max_bytes == usize::MAX || path.is_empty() || path.len() > max_bytes {
        return Err("admission path is empty or exceeds its explicit cap".into());
    }
    if !path.is_ascii() || path.bytes().any(|b| b < 0x20 || b == 0x7f || matches!(b, b'\\' | b':' | b'<' | b'>' | b'"' | b'|' | b'?' | b'*')) {
        return Err("admission path is outside the portable ASCII subset".into());
    }
    let normalized = if directory { path.strip_suffix('/').unwrap_or(path) } else { path };
    if normalized.is_empty() { return Err("admission path has no ordinary component".into()); }
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." || component.ends_with(' ') || component.ends_with('.') {
            return Err("admission path contains a non-ordinary component".into());
        }
        let stem = component.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
        let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'0'..=b'9'));
        if device { return Err("admission path uses a reserved Windows basename".into()); }
    }
    Ok(normalized.to_string())
}

fn admission_selected(relative: &str) -> bool {
    relative.split('/').next().is_some_and(|first| REQUIRED.contains(&first) || ALSO_COPIED.contains(&first))
}

// Syntax and selection checks; admit_release_bundle separately requires actual
// archive inventory hits with exactly the requested regular/directory kind.
fn admission_requirements(
    requirements: &[AdmissionRequirement<'_>], limits: AdmissionLimits,
) -> Result<std::collections::BTreeMap<String, AdmissionKind>, String> {
    limits.validate()?;
    if requirements.is_empty() || requirements.len() > limits.max_entries {
        return Err("admission requirements must be nonempty and bounded".into());
    }
    let mut result = std::collections::BTreeMap::new();
    let mut folded = std::collections::BTreeSet::new();
    for requirement in requirements {
        let path = admission_path(requirement.path, requirement.kind == AdmissionKind::Directory, limits.max_path_bytes)?;
        if !admission_selected(&path) { return Err("admission requirement is outside the selectable release paths".into()); }
        let (first, nested) = path.split_once('/').map_or((path.as_str(), false), |(first, _)| (first, true));
        let directory_root = matches!(first, "server" | "app" | "worker" | "shared" | "examples" | "scripts");
        if (!directory_root && (nested || requirement.kind != AdmissionKind::Regular))
            || (directory_root && !nested && requirement.kind != AdmissionKind::Directory) {
            return Err("admission requirement conflicts with a release root's file/directory shape".into());
        }
        if !folded.insert(path.to_ascii_lowercase()) || result.insert(path, requirement.kind).is_some() {
            return Err("admission requirements duplicate or collide by case".into());
        }
    }
    for (path, _) in &result {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if result.get(prefix) == Some(&AdmissionKind::Regular) {
                return Err("admission requirement has a regular-file parent".into());
            }
            parent = prefix;
        }
    }
    Ok(result)
}

// This is explicitly NOT AdmittedBundle. It proves buffered-input bounds,
// strict image metadata and requirement syntax, not archive validity/content.
struct AdmissionPreconditions {
    images: Images,
    requirements: std::collections::BTreeMap<String, AdmissionKind>,
}

fn admission_preconditions(
    source_bytes: &[u8], images_bytes: &[u8], expected_version: &str,
    limits: AdmissionLimits, requirements: &[AdmissionRequirement<'_>],
) -> Result<AdmissionPreconditions, String> {
    limits.check_inputs(source_bytes, images_bytes)?;
    let requirements = admission_requirements(requirements, limits)?;
    let images = checked_images(images_bytes, expected_version)?;
    Ok(AdmissionPreconditions { images, requirements })
}

#[derive(Clone, Debug)]
struct AdmittedEntry {
    archive_path: String,
    relative: Option<String>,
    kind: AdmissionKind,
    selected: bool,
    bytes: usize,
}

#[derive(Debug)]
struct AdmittedBundle {
    version: String,
    wrapper: String,
    images: Images,
    files: BTreeMap<String, Vec<u8>>,
    directories: Vec<String>,
    inventory: Vec<AdmittedEntry>,
    selected: Vec<String>,
    excluded: Vec<String>,
    tar_bytes: usize,
    payload_bytes: usize,
}

struct PhysicalAdmissionEntry {
    header_offset: usize,
    file_offset: usize,
    size: usize,
    raw_type: u8,
    inventory: AdmittedEntry,
}

struct AdmissionNode {
    spelling: String,
    kind: AdmissionKind,
    explicit: bool,
}

struct PhysicalAdmission {
    wrapper: String,
    entries: Vec<PhysicalAdmissionEntry>,
    directories: Vec<String>,
    payload_bytes: usize,
}

fn admission_string_field(field: &[u8]) -> Result<&[u8], String> {
    let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
    if field[end..].iter().any(|b| *b != 0) {
        return Err("admission raw name/prefix has hidden bytes after NUL".into());
    }
    Ok(&field[..end])
}

// Inspect raw name/prefix/type/format BEFORE path interpretation. GNU ordinary
// headers are rejected as well as all GNU/PAX extension entry typeflags.
fn admission_raw_header(block: &[u8; 512], limits: AdmissionLimits)
    -> Result<(String, AdmissionKind, usize), String>
{
    let kind = match block[156] {
        0 | b'0' => AdmissionKind::Regular,
        b'5' => AdmissionKind::Directory,
        _ => return Err("admission rejects non-regular/non-directory raw typeflag".into()),
    };
    let ustar = &block[257..263] == b"ustar\0" && &block[263..265] == b"00";
    let v7 = block[257..].iter().all(|b| *b == 0);
    if !ustar && !v7 { return Err("admission rejects GNU or unknown header format".into()); }
    if block[157..257].iter().any(|b| *b != 0) {
        return Err("admission ordinary header has link metadata".into());
    }
    if ustar && block[500..].iter().any(|b| *b != 0) {
        return Err("admission USTAR reserved padding is nonzero".into());
    }
    let name = admission_string_field(&block[..100])?;
    let prefix = if ustar { admission_string_field(&block[345..500])? } else { &[] };
    if name.is_empty() { return Err("admission raw pathname is empty".into()); }
    let length = prefix.len().checked_add(usize::from(!prefix.is_empty()))
        .and_then(|n| n.checked_add(name.len())).ok_or("admission raw pathname overflow")?;
    if length > limits.max_path_bytes { return Err("admission raw pathname exceeds cap".into()); }
    let mut bytes = Vec::new();
    bytes.try_reserve(length).map_err(|_| "admission pathname allocation refused")?;
    if !prefix.is_empty() { bytes.extend_from_slice(prefix); bytes.push(b'/'); }
    bytes.extend_from_slice(name);
    let raw_path = String::from_utf8(bytes).map_err(|_| "admission pathname is not ASCII UTF8")?;
    admission_path(&raw_path, kind == AdmissionKind::Directory, limits.max_path_bytes)?;
    let mut header = tar::Header::new_old();
    header.as_mut_bytes().copy_from_slice(block);
    let sum: u32 = block[..148].iter().chain(block[156..].iter()).map(|b| u32::from(*b)).sum::<u32>() + 8 * 32;
    if header.cksum().map_err(|_| "admission invalid checksum field")? != sum {
        return Err("admission physical header checksum mismatch".into());
    }
    let size = usize::try_from(header.entry_size().map_err(|_| "admission invalid declared entry size")?)
        .map_err(|_| "admission declared entry size does not fit platform")?;
    if size > limits.max_entry_bytes { return Err("admission declared entry size exceeds cap".into()); }
    if kind == AdmissionKind::Directory && size != 0 {
        return Err("admission directory payload must be empty".into());
    }
    Ok((raw_path, kind, size))
}

fn admission_insert_node(nodes: &mut BTreeMap<String, AdmissionNode>, path: &str, kind: AdmissionKind)
    -> Result<(), String>
{
    let mut prefix = String::new();
    let components: Vec<_> = path.split('/').collect();
    for (index, component) in components.iter().enumerate() {
        if index != 0 { prefix.push('/'); }
        prefix.push_str(component);
        let final_component = index + 1 == components.len();
        let node_kind = if final_component { kind } else { AdmissionKind::Directory };
        let folded = prefix.to_ascii_lowercase();
        if let Some(previous) = nodes.get_mut(&folded) {
            if previous.spelling != prefix { return Err("admission path case collision".into()); }
            if !final_component {
                if previous.kind != AdmissionKind::Directory { return Err("admission file-parent conflict".into()); }
            } else {
                if previous.explicit || previous.kind != node_kind || node_kind == AdmissionKind::Regular {
                    return Err("admission duplicate path/directory or file-parent conflict".into());
                }
                previous.explicit = true;
            }
        } else {
            nodes.insert(folded, AdmissionNode { spelling: prefix.clone(), kind: node_kind, explicit: final_component });
        }
    }
    Ok(())
}

fn admission_selected_shape(relative: &str, kind: AdmissionKind) -> Result<(), String> {
    let (first, nested) = relative.split_once('/').map_or((relative, false), |(a, _)| (a, true));
    let directory_root = matches!(first, "server" | "app" | "worker" | "shared" | "examples" | "scripts");
    if (!directory_root && (nested || kind != AdmissionKind::Regular))
        || (directory_root && !nested && kind != AdmissionKind::Directory) {
        return Err("admission archive conflicts with selectable root shape".into());
    }
    Ok(())
}

// Independent physical layout gate: no default tar EOF/zero-block shortcuts.
fn admission_physical_tar(bytes: &[u8], limits: AdmissionLimits) -> Result<PhysicalAdmission, String> {
    if bytes.len() > limits.max_tar_bytes || bytes.len() < 1024 || bytes.len() % 512 != 0 {
        return Err("admission tar is over cap, short or unaligned".into());
    }
    let mut offset = 0usize;
    let mut entries = Vec::new();
    let mut nodes = BTreeMap::new();
    let mut wrapper: Option<String> = None;
    let mut payload_bytes = 0usize;
    let mut terminated = false;
    while offset < bytes.len() {
        let header_end = offset.checked_add(512).ok_or("admission header offset overflow")?;
        let header_bytes = bytes.get(offset..header_end).ok_or("admission short physical header")?;
        if header_bytes.iter().all(|b| *b == 0) {
            let tail = bytes.get(offset..).ok_or("admission invalid footer offset")?;
            if tail.len() < 1024 || tail.iter().any(|b| *b != 0) {
                return Err("admission requires two zero footer blocks and only zero tar remainder".into());
            }
            terminated = true;
            break;
        }
        let next_count = entries.len().checked_add(1).ok_or("admission physical entry count overflow")?;
        if next_count > limits.max_entries { return Err("admission physical entry count exceeds cap".into()); }
        let mut block = [0u8; 512]; block.copy_from_slice(header_bytes);
        let (raw_path, kind, size) = admission_raw_header(&block, limits)?;
        let normalized = admission_path(&raw_path, kind == AdmissionKind::Directory, limits.max_path_bytes)?;
        let (first, relative) = match normalized.split_once('/') {
            Some((first, relative)) => (first, Some(relative.to_string())),
            None => {
                if kind != AdmissionKind::Directory { return Err("admission wrapper must be a directory".into()); }
                (normalized.as_str(), None)
            },
        };
        match &wrapper {
            Some(expected) if expected != first => return Err("admission has multiple archive wrappers".into()),
            None => wrapper = Some(first.to_string()),
            _ => {},
        }
        admission_insert_node(&mut nodes, &normalized, kind)?;
        let selected = relative.as_deref().is_some_and(admission_selected);
        if selected { admission_selected_shape(relative.as_deref().ok_or("admission missing selected path")?, kind)?; }
        let payload_end = header_end.checked_add(size).ok_or("admission physical payload end overflow")?;
        let next = payload_end.checked_add(511).ok_or("admission padding offset overflow")? & !511usize;
        let padding = bytes.get(payload_end..next).ok_or("admission short payload/padding")?;
        if padding.iter().any(|b| *b != 0) { return Err("admission nonzero payload padding".into()); }
        // This slice check also rejects a declared payload beyond the buffer.
        bytes.get(header_end..payload_end).ok_or("admission short physical payload")?;
        payload_bytes = payload_bytes.checked_add(size).ok_or("admission physical payload count overflow")?;
        if payload_bytes > limits.max_total_uncompressed { return Err("admission physical payload exceeds cap".into()); }
        entries.try_reserve(1).map_err(|_| "admission inventory allocation refused")?;
        entries.push(PhysicalAdmissionEntry { header_offset: offset, file_offset: header_end, size,
            raw_type: block[156], inventory: AdmittedEntry { archive_path: raw_path, relative, kind, selected, bytes: size } });
        offset = next;
    }
    if !terminated { return Err("admission tar has no complete footer".into()); }
    let wrapper = wrapper.ok_or("admission archive has no ordinary wrapper/entries")?;
    let prefix = format!("{wrapper}/");
    let mut directories = Vec::new();
    for node in nodes.values() {
        if node.kind == AdmissionKind::Directory {
            if let Some(relative) = node.spelling.strip_prefix(&prefix) {
                if admission_selected(relative) { directories.push(relative.to_string()); }
            }
        }
    }
    directories.sort();
    Ok(PhysicalAdmission { wrapper, entries, directories, payload_bytes })
}

// The real decoder and focused recording reader use this same read boundary.
// A full allowance still performs a nonempty one-byte real EOF/footer probe.
fn admission_read_tar_chunk<R: std::io::Read>(
    reader: &mut R, buffer: &mut [u8], budget: &mut AdmissionBudget,
) -> Result<usize, String> {
    let remaining = budget.limits.max_tar_bytes.checked_sub(budget.tar)
        .ok_or("admission tar counter exceeds its cap")?;
    let probe = remaining.checked_add(1).ok_or("admission tar remaining probe overflow")?;
    let requested = buffer.len().min(probe);
    if requested == 0 { return Err("admission tar read requires a nonempty buffer".into()); }
    let read = reader.read(&mut buffer[..requested])
        .map_err(|_| "admission gzip body/footer/CRC/ISIZE error")?;
    if read > requested { return Err("admission reader exceeded requested slice".into()); }
    if read != 0 { budget.read_tar(read)?; }
    Ok(read)
}

// Full candidate validator only: consumes bytes, no filesystem/process/network
// access and no live/ready/stamp capability. Existing fetch/unpack do not call it.
fn admit_release_bundle(
    source_bytes: &[u8], images_bytes: &[u8], expected_version: &str,
    limits: AdmissionLimits, requirements: &[AdmissionRequirement<'_>],
) -> Result<AdmittedBundle, String> {
    use std::io::Read;
    let preconditions = admission_preconditions(source_bytes, images_bytes, expected_version, limits, requirements)?;
    let mut gzip = flate2::bufread::GzDecoder::new(std::io::Cursor::new(source_bytes));
    let mut decoded = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut tar_budget = AdmissionBudget::new(limits)?;
    loop {
        // No take(cap) or zero-length EOF: first decoder error is terminal.
        let read = admission_read_tar_chunk(&mut gzip, &mut buffer, &mut tar_budget)?;
        if read == 0 { break; }
        decoded.try_reserve(read).map_err(|_| "admission tar allocation refused")?;
        decoded.extend_from_slice(&buffer[..read]);
    }
    let consumed = gzip.into_inner().position();
    if consumed != u64::try_from(source_bytes.len()).map_err(|_| "admission compressed size overflow")? {
        return Err("admission rejects second gzip member or compressed trailing bytes".into());
    }
    if tar_budget.tar != decoded.len() { return Err("admission tar byte counter mismatch".into()); }
    let physical = admission_physical_tar(&decoded, limits)?;
    let mut archive = tar::Archive::new(decoded.as_slice());
    let mut raw_entries = archive.entries().map_err(|_| "admission tar iterator error")?.raw(true);
    let mut payload_budget = AdmissionBudget::new(limits)?;
    let mut files = BTreeMap::new();
    for expected in &physical.entries {
        let mut entry = raw_entries.next().ok_or("admission raw iterator omitted a physical entry")?
            .map_err(|_| "admission raw entry error")?;
        payload_budget.begin_entry()?;
        {
            let header = entry.header();
            let raw_header = decoded.get(expected.header_offset..expected.file_offset).ok_or("admission header bounds changed")?;
            if &header.as_bytes()[..] != raw_header || header.as_bytes()[156] != expected.raw_type
                || usize::try_from(entry.raw_header_position()).map_err(|_| "admission raw header offset overflow")? != expected.header_offset
                || usize::try_from(entry.raw_file_position()).map_err(|_| "admission raw file offset overflow")? != expected.file_offset
                || usize::try_from(entry.size()).map_err(|_| "admission raw size overflow")? != expected.size {
                return Err("admission physical/raw header-position-type-size mismatch".into());
            }
            let raw_name = header.path_bytes();
            if raw_name.as_ref() != expected.inventory.archive_path.as_bytes()
                || (expected.inventory.kind == AdmissionKind::Regular && !header.entry_type().is_file())
                || (expected.inventory.kind == AdmissionKind::Directory && !header.entry_type().is_dir()) {
                return Err("admission physical/raw path or kind mismatch".into());
            }
        }
        let mut actual = 0usize;
        let mut retained = Vec::new();
        loop {
            let read = entry.read(&mut buffer).map_err(|_| "admission entry payload read error")?;
            if read == 0 { break; }
            payload_budget.read_entry_payload(read)?;
            payload_budget.read_uncompressed(read)?;
            let next = actual.checked_add(read).ok_or("admission actual payload offset overflow")?;
            if next > expected.size { return Err("admission entry read beyond declared length".into()); }
            let begin = expected.file_offset.checked_add(actual).ok_or("admission payload compare overflow")?;
            let end = expected.file_offset.checked_add(next).ok_or("admission payload compare overflow")?;
            if decoded.get(begin..end) != Some(&buffer[..read]) { return Err("admission raw/physical payload mismatch".into()); }
            if expected.inventory.selected && expected.inventory.kind == AdmissionKind::Regular {
                retained.try_reserve(read).map_err(|_| "admission selected payload allocation refused")?;
                retained.extend_from_slice(&buffer[..read]);
            }
            actual = next;
        }
        if actual != expected.size { return Err("admission actual payload shorter than declared length".into()); }
        if expected.inventory.selected && expected.inventory.kind == AdmissionKind::Regular {
            let path = expected.inventory.relative.as_ref().ok_or("admission selected file has no relative path")?;
            if files.insert(path.clone(), retained).is_some() { return Err("admission duplicate selected file".into()); }
        }
    }
    if raw_entries.next().is_some() { return Err("admission raw iterator has unaccounted entry/error".into()); }
    if payload_budget.entries != physical.entries.len() || payload_budget.total != physical.payload_bytes {
        return Err("admission raw/physical entry or payload total mismatch".into());
    }
    for (path, required_kind) in &preconditions.requirements {
        let found = physical.entries.iter().any(|entry| entry.inventory.relative.as_ref() == Some(path)
            && entry.inventory.kind == *required_kind && entry.inventory.selected);
        if !found { return Err(format!("admission required archive entry missing or wrong kind: {path}")); }
    }
    let inventory: Vec<_> = physical.entries.iter().map(|entry| entry.inventory.clone()).collect();
    let selected = inventory.iter().filter(|e| e.selected).map(|e| e.archive_path.clone()).collect();
    let excluded = inventory.iter().filter(|e| !e.selected).map(|e| e.archive_path.clone()).collect();
    Ok(AdmittedBundle { version: expected_version.to_string(), wrapper: physical.wrapper,
        images: preconditions.images, files, directories: physical.directories, inventory, selected, excluded,
        tar_bytes: decoded.len(), payload_bytes: payload_budget.total })
}

// F4b1 staging only. No publisher, live-root lock, adoption or recovery authority.
const PUBLICATION_UNAVAILABLE: &str = "PUBLICATION_UNAVAILABLE";

fn stage_limits() -> AdmissionLimits {
    AdmissionLimits { max_entries: 20000, max_total_uncompressed: 96 * 1024 * 1024,
        max_tar_bytes: 128 * 1024 * 1024, max_entry_bytes: 16 * 1024 * 1024,
        max_path_bytes: 512, max_source_bytes: 32 * 1024 * 1024, max_images_bytes: 2 * 1024 * 1024 }
}
fn stage_requirements() -> Vec<AdmissionRequirement<'static>> {
    let mut requirements: Vec<_> = ["docker-compose.yml", "package.json", "bun.lock", "tsconfig.base.json",
        "server/package.json", "app/package.json", "worker/package.json"].into_iter()
        .map(|path| AdmissionRequirement { path, kind: AdmissionKind::Regular }).collect();
    requirements.extend(["server", "app", "worker"].into_iter()
        .map(|path| AdmissionRequirement { path, kind: AdmissionKind::Directory }));
    requirements
}

fn stage_read_bounded<R: std::io::Read>(reader: &mut R, cap: usize,
    current: &mut impl FnMut() -> Result<(), String>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new(); let mut buffer = [0u8; 8192];
    loop {
        current()?;
        let remaining = cap.checked_sub(bytes.len()).ok_or("STAGE_READ_LIMIT")?;
        let requested = buffer.len().min(remaining.checked_add(1).ok_or("STAGE_READ_OVERFLOW")?);
        let read = reader.read(&mut buffer[..requested]).map_err(|_| "STAGE_READ_ERROR")?;
        if read == 0 { return Ok(bytes); }
        let count = bytes.len().checked_add(read).ok_or("STAGE_READ_OVERFLOW")?;
        if read > requested || count > cap { return Err("STAGE_READ_LIMIT".into()); }
        bytes.try_reserve(read).map_err(|_| "STAGE_READ_ALLOCATION")?;
        bytes.extend_from_slice(&buffer[..read]);
    }
}
fn stage_get(url: &str, cap: usize, current: &mut impl FnMut() -> Result<(), String>) -> Result<Vec<u8>, String> {
    current()?;
    let mut response = reqwest::blocking::Client::builder().user_agent("openbot-desktop")
        .build().map_err(|_| "STAGE_HTTP_CLIENT")?.get(url).send().map_err(|_| "STAGE_HTTP_REQUEST")?;
    stage_response_body(response.status().is_success(), &mut response, cap, current)
}
fn stage_response_body<R: std::io::Read>(successful: bool, response: &mut R, cap: usize,
    current: &mut impl FnMut() -> Result<(), String>) -> Result<Vec<u8>, String> {
    if !successful { return Err("STAGE_HTTP_STATUS".into()); }
    stage_read_bounded(response, cap, current)
}
fn stage_sha(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new(); hash.update(bytes); let digest = hash.finalize();
    let mut result = [0u8; 32]; result.copy_from_slice(&digest); result
}

// Fields cannot be supplied by JSON/Path tags. Constructor may reject platforms.
pub struct StageContext {
    live: PathBuf,
    parent_path: PathBuf,
    #[cfg(unix)] app_config_path: PathBuf,
    #[cfg(unix)] namespace_identity: std::cell::Cell<Option<StageIdentity>>,
    #[cfg(unix)] parent: std::fs::File,
    #[cfg(unix)] parent_identity: StageIdentity,
    #[cfg(unix)] live_identity: Option<StageIdentity>,
}
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StageIdentity { device: u64, inode: u64 }
#[cfg(unix)]
fn stage_identity(metadata: &std::fs::Metadata) -> StageIdentity {
    use std::os::unix::fs::MetadataExt;
    StageIdentity { device: metadata.dev(), inode: metadata.ino() }
}
#[cfg(unix)]
fn stage_ordinary_absolute(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.components().any(|part| !matches!(part,
        std::path::Component::RootDir | std::path::Component::Normal(_))) {
        return Err("STAGE_ORDINARY_ABSOLUTE_REQUIRED".into());
    }
    Ok(())
}
#[cfg(unix)]
fn stage_directory_metadata(metadata: &std::fs::Metadata, private: bool, ancestor: bool) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("STAGE_DIRECTORY_IDENTITY".into()); }
    stage_owner_mode(metadata.uid(), unsafe { libc::geteuid() }, metadata.mode(), private, ancestor)
}
#[cfg(unix)]
fn stage_owner_mode(owner: u32, user: u32, mode: u32, private: bool, ancestor: bool) -> Result<(), String> {
    if owner != user && (!ancestor || owner != 0) { return Err("STAGE_DIRECTORY_IDENTITY".into()); }
    let sticky_system_ancestor = ancestor && owner == 0 && mode & 0o1000 != 0;
    if mode & 0o022 != 0 && !sticky_system_ancestor { return Err("STAGE_UNSAFE_PARENT_MODE".into()); }
    if private && (owner != user || mode & 0o077 != 0) { return Err("STAGE_PRIVATE_DIRECTORY_REQUIRED".into()); }
    Ok(())
}
#[cfg(unix)]
fn stage_sync_directory(file: &std::fs::File) -> Result<(), String> {
    file.sync_all().map_err(|_| "STAGE_DIRECTORY_DURABILITY_UNSUPPORTED".into())
}
#[cfg(unix)]
fn stage_open_dir(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
        .open(path).map_err(|_| "STAGE_DIRECTORY_OPEN".into())
}
#[cfg(unix)]
fn stage_ancestry(path: &Path) -> Result<Option<StageIdentity>, String> {
    stage_ordinary_absolute(path)?;
    let components: Vec<_> = path.components().collect(); let mut at = PathBuf::new(); let mut absent = false;
    for (index, part) in components.iter().enumerate() {
        at.push(part.as_os_str());
        if absent { continue; }
        let metadata = match std::fs::symlink_metadata(&at) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => { absent = true; continue; },
            Err(_) => return Err("STAGE_PARENT_METADATA".into()),
        };
        stage_directory_metadata(&metadata, false, index + 1 != components.len())?;
    }
    if absent { Ok(None) } else { Ok(Some(stage_identity(&std::fs::symlink_metadata(path).map_err(|_| "STAGE_PARENT_METADATA")?))) }
}

pub fn prepare_stage_context(live: &Path, app_config: &Path, parent_path: &Path) -> Result<StageContext, String> {
    #[cfg(not(unix))]
    { let _ = (live, app_config, parent_path); Err("STAGE_NATIVE_IDENTITY_OR_DIRECTORY_DURABILITY_UNSUPPORTED".into()) }
    #[cfg(unix)]
    {
        stage_ordinary_absolute(live)?; stage_ordinary_absolute(app_config)?; stage_ordinary_absolute(parent_path)?;
        if parent_path != app_config.join("release-staging-v1") || parent_path.starts_with(live) || live.starts_with(parent_path) {
            return Err("STAGE_LIVE_OVERLAP_OR_UNAUTHORIZED_PARENT".into());
        }
        let live_identity = stage_ancestry(live)?;
        // Check all already-existing stage ancestors against live identity BEFORE creating.
        for ancestor in parent_path.ancestors() {
            match std::fs::symlink_metadata(ancestor) {
                Ok(metadata) => {
                    stage_directory_metadata(&metadata, false, ancestor != parent_path)?;
                    if live_identity == Some(stage_identity(&metadata)) { return Err("STAGE_PHYSICAL_LIVE_OVERLAP".into()); }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => return Err("STAGE_PARENT_METADATA".into()),
            }
        }
        let parent_identity = stage_ancestry(app_config)?.ok_or("STAGE_APP_CONFIG_MISSING")?;
        let namespace_identity = stage_ancestry(parent_path)?;
        if namespace_identity.is_some() {
            stage_directory_metadata(&std::fs::symlink_metadata(parent_path).map_err(|_| "STAGE_PARENT_METADATA")?, true, false)?;
            let held_namespace = stage_open_dir(parent_path)?;
            if Some(stage_identity(&held_namespace.metadata().map_err(|_| "STAGE_PARENT_METADATA")?)) != namespace_identity {
                return Err("STAGE_PARENT_CHANGED".into());
            }
            stage_sync_directory(&held_namespace)?;
        }
        let parent = stage_open_dir(app_config)?;
        if stage_identity(&parent.metadata().map_err(|_| "STAGE_PARENT_METADATA")?) != parent_identity {
            return Err("STAGE_PARENT_CHANGED".into());
        }
        // Constructor never creates directories. Missing app config is failclosed.
        // Verify support on the held physical parent BEFORE HTTP or stage creation.
        stage_sync_directory(&parent)?;
        Ok(StageContext { live: live.to_path_buf(), parent_path: parent_path.to_path_buf(),
            app_config_path: app_config.to_path_buf(), namespace_identity: std::cell::Cell::new(namespace_identity),
            parent_identity, parent, live_identity })
    }
}
#[cfg(unix)]
fn stage_context_current(context: &StageContext) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(&context.app_config_path).map_err(|_| "STAGE_PARENT_METADATA")?;
    stage_directory_metadata(&metadata, false, false)?;
    if stage_identity(&metadata) != context.parent_identity
        || stage_identity(&context.parent.metadata().map_err(|_| "STAGE_PARENT_METADATA")?) != context.parent_identity
        || stage_ancestry(&context.live)? != context.live_identity {
        return Err("STAGE_CONTEXT_CHANGED".into());
    }
    let actual_namespace = stage_ancestry(&context.parent_path)?;
    if actual_namespace != context.namespace_identity.get() { return Err("STAGE_CONTEXT_CHANGED".into()); }
    if actual_namespace.is_some() {
        stage_directory_metadata(&std::fs::symlink_metadata(&context.parent_path).map_err(|_| "STAGE_PARENT_METADATA")?, true, false)?;
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct StageRecord { path: String, kind: u8, size: u64, hash: [u8; 32] }
fn stage_records(bundle: &AdmittedBundle, images: &[u8]) -> Result<Vec<StageRecord>, String> {
    let mut records = Vec::new();
    for directory in &bundle.directories {
        admission_path(directory, false, stage_limits().max_path_bytes)?;
        records.push(StageRecord { path: directory.clone(), kind: 2, size: 0, hash: [0; 32] });
    }
    for (path, bytes) in &bundle.files {
        admission_path(path, false, stage_limits().max_path_bytes)?;
        records.push(StageRecord { path: path.clone(), kind: 1, size: u64::try_from(bytes.len()).map_err(|_| "STAGE_SIZE_OVERFLOW")?, hash: stage_sha(bytes) });
    }
    records.push(StageRecord { path: IMAGES.to_string(), kind: 1,
        size: u64::try_from(images.len()).map_err(|_| "STAGE_SIZE_OVERFLOW")?, hash: stage_sha(images) });
    if records.len() > stage_limits().max_entries { return Err("STAGE_PLAN_COUNT_LIMIT".into()); }
    records.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    if records.windows(2).any(|pair| pair[0].path == pair[1].path) { return Err("STAGE_DUPLICATE_PLAN".into()); }
    Ok(records)
}
fn stage_seal(version: &str, records: &[StageRecord], source_hash: [u8; 32], images_hash: [u8; 32]) -> Result<Vec<u8>, String> {
    valid_version(version)?;
    let version_length = u32::try_from(version.len()).map_err(|_| "STAGE_VERSION_LENGTH_OVERFLOW")?;
    u32::try_from(records.len()).map_err(|_| "STAGE_COUNT_OVERFLOW")?;
    let mut length = b"openbot.release-stage.v1\0".len().checked_add(12)
        .and_then(|n| n.checked_add(version.len())).and_then(|n| n.checked_add(96)).ok_or("STAGE_SEAL_LENGTH_OVERFLOW")?;
    for record in records {
        u32::try_from(record.path.len()).map_err(|_| "STAGE_PATH_LENGTH_OVERFLOW")?;
        length = length.checked_add(45).and_then(|n| n.checked_add(record.path.len())).ok_or("STAGE_SEAL_LENGTH_OVERFLOW")?;
    }
    let mut bytes = Vec::new(); bytes.try_reserve(length).map_err(|_| "STAGE_SEAL_ALLOCATION")?;
    bytes.extend_from_slice(b"openbot.release-stage.v1\0"); bytes.extend_from_slice(&1u32.to_be_bytes());
    bytes.extend_from_slice(&version_length.to_be_bytes()); bytes.extend_from_slice(version.as_bytes());
    bytes.extend_from_slice(&u32::try_from(records.len()).map_err(|_| "STAGE_COUNT_OVERFLOW")?.to_be_bytes());
    let mut previous: Option<&str> = None;
    for record in records {
        admission_path(&record.path, false, stage_limits().max_path_bytes)?;
        if previous.is_some_and(|path| path.as_bytes() >= record.path.as_bytes())
            || !matches!(record.kind, 1 | 2) || (record.kind == 2 && (record.size != 0 || record.hash != [0; 32])) {
            return Err("STAGE_INVALID_SEAL_INVENTORY".into());
        }
        previous = Some(&record.path); bytes.push(record.kind);
        bytes.extend_from_slice(&u32::try_from(record.path.len()).map_err(|_| "STAGE_PATH_LENGTH_OVERFLOW")?.to_be_bytes());
        bytes.extend_from_slice(record.path.as_bytes()); bytes.extend_from_slice(&record.size.to_be_bytes()); bytes.extend_from_slice(&record.hash);
    }
    bytes.extend_from_slice(&source_hash); bytes.extend_from_slice(&images_hash);
    let digest = stage_sha(&bytes); bytes.extend_from_slice(&digest);
    if bytes.len() != length { return Err("STAGE_SEAL_LENGTH_MISMATCH".into()); }
    Ok(bytes)
}
#[cfg(unix)]
fn stage_file_metadata(metadata: &std::fs::Metadata) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 { return Err("STAGE_PRIVATE_REGULAR_REQUIRED".into()); }
    Ok(())
}
#[cfg(unix)]
fn stage_new_file(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW)
        .open(path).map_err(|_| "STAGE_CREATE_ONLY_FILE".into())
}
#[cfg(unix)]
fn stage_write_file(path: &Path, bytes: &[u8]) -> Result<StageIdentity, String> {
    use std::io::Write;
    stage_write_file_with(path, bytes, |file, bytes| {
        file.write_all(bytes).map_err(|_| "STAGE_WRITE_ERROR")?;
        file.sync_all().map_err(|_| "STAGE_FILE_SYNC_ERROR".into())
    })
}
#[cfg(unix)]
fn stage_write_file_with(path: &Path, bytes: &[u8], write_sync: impl FnOnce(&mut std::fs::File, &[u8]) -> Result<(), String>) -> Result<StageIdentity, String> {
    let mut file = stage_new_file(path)?; write_sync(&mut file, bytes)?;
    let metadata = file.metadata().map_err(|_| "STAGE_FILE_METADATA")?; stage_file_metadata(&metadata)?;
    Ok(stage_identity(&metadata))
}
#[cfg(unix)]
fn stage_reopen(path: &Path, identity: StageIdentity, cap: usize, current: &mut impl FnMut() -> Result<(), String>) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "STAGE_REOPEN_METADATA")?; stage_file_metadata(&metadata)?;
    if stage_identity(&metadata) != identity { return Err("STAGE_REOPEN_IDENTITY".into()); }
    let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| "STAGE_REOPEN_ERROR")?;
    let before = file.metadata().map_err(|_| "STAGE_REOPEN_METADATA")?; stage_file_metadata(&before)?;
    if stage_identity(&before) != identity { return Err("STAGE_REOPEN_IDENTITY".into()); }
    let bytes = stage_read_bounded(&mut file, cap, current)?;
    let after = file.metadata().map_err(|_| "STAGE_REOPEN_METADATA")?;
    let path_after = std::fs::symlink_metadata(path).map_err(|_| "STAGE_REOPEN_METADATA")?;
    stage_file_metadata(&after)?; stage_file_metadata(&path_after)?;
    if stage_identity(&after) != identity || stage_identity(&path_after) != identity || before.len() != after.len()
        || usize::try_from(after.len()).map_err(|_| "STAGE_SIZE_OVERFLOW")? != bytes.len() {
        return Err("STAGE_REOPEN_CHANGED".into());
    }
    Ok(bytes)
}
#[cfg(unix)]
fn stage_verify_inventory(stage: &Path, records: &[StageRecord], identities: &BTreeMap<String, StageIdentity>,
    sealed: bool, current: &mut impl FnMut() -> Result<(), String>) -> Result<Vec<StageRecord>, String> {
    let expected: BTreeMap<_, _> = records.iter().map(|r| (r.path.as_str(), r)).collect();
    let mut visited = std::collections::BTreeSet::new(); let mut pending = vec![(stage.to_path_buf(), String::new())];
    let mut actual = Vec::new(); let mut count = 0usize;
    while let Some((directory, prefix)) = pending.pop() {
        current()?;
        for item in std::fs::read_dir(directory).map_err(|_| "STAGE_INVENTORY_READ")? {
            current()?; count = count.checked_add(1).ok_or("STAGE_COUNT_OVERFLOW")?;
            if count > records.len().checked_add(if sealed { 2 } else { 1 }).ok_or("STAGE_COUNT_OVERFLOW")? {
                return Err("STAGE_EXTRA_ENTRY".into());
            }
            let item = item.map_err(|_| "STAGE_INVENTORY_READ")?;
            let name = item.file_name().into_string().map_err(|_| "STAGE_EXTRA_ENTRY")?;
            let path = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if prefix.is_empty() && (path == ".attempt.lock" || (sealed && path == "stage.seal")) { continue; }
            let record = expected.get(path.as_str()).ok_or("STAGE_EXTRA_ENTRY")?;
            if !visited.insert(path.clone()) { return Err("STAGE_DUPLICATE_ENTRY".into()); }
            let identity = *identities.get(&path).ok_or("STAGE_MISSING_IDENTITY")?;
            let metadata = std::fs::symlink_metadata(item.path()).map_err(|_| "STAGE_INVENTORY_METADATA")?;
            if stage_identity(&metadata) != identity { return Err("STAGE_REOPEN_IDENTITY".into()); }
            let hash = if record.kind == 2 {
                stage_directory_metadata(&metadata, true, false)?; pending.push((item.path(), path.clone())); [0; 32]
            } else {
                let bytes = stage_reopen(&item.path(), identity, usize::try_from(record.size).map_err(|_| "STAGE_SIZE_OVERFLOW")?, current)?;
                if u64::try_from(bytes.len()).map_err(|_| "STAGE_SIZE_OVERFLOW")? != record.size { return Err("STAGE_REOPEN_LENGTH".into()); }
                stage_sha(&bytes)
            };
            if hash != record.hash { return Err("STAGE_REOPEN_HASH".into()); }
            actual.push(StageRecord { path, kind: record.kind, size: record.size, hash });
        }
    }
    if visited.len() != records.len() { return Err("STAGE_MISSING_ENTRY".into()); }
    actual.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes())); Ok(actual)
}

#[cfg(unix)]
fn stage_bundle(context: &StageContext, bundle: &AdmittedBundle, source_hash: [u8; 32], images: &[u8],
    current: &mut impl FnMut() -> Result<(), String>, name: &str) -> Result<PathBuf, String> {
    stage_bundle_with_sync(context, bundle, source_hash, images, current, name, &mut stage_sync_directory)
}
#[cfg(unix)]
fn stage_bundle_with_sync(context: &StageContext, bundle: &AdmittedBundle, source_hash: [u8; 32], images: &[u8],
    current: &mut impl FnMut() -> Result<(), String>, name: &str,
    sync_directory: &mut impl FnMut(&std::fs::File) -> Result<(), String>) -> Result<PathBuf, String> {
    use std::os::unix::{fs::DirBuilderExt, io::AsRawFd};
    current()?; stage_context_current(context)?;
    if name.len() != 38 || !name.starts_with("stage-") || !name[6..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("STAGE_ATTEMPT_NAME".into());
    }
    if context.namespace_identity.get().is_none() {
        // This is reached only AFTER complete admission. No existing namespace is adopted on collision.
        std::fs::DirBuilder::new().mode(0o700).create(&context.parent_path).map_err(|_| "STAGE_CREATE_ONLY_NAMESPACE")?;
        let metadata = std::fs::symlink_metadata(&context.parent_path).map_err(|_| "STAGE_PARENT_METADATA")?;
        stage_directory_metadata(&metadata, true, false)?;
        context.namespace_identity.set(Some(stage_identity(&metadata)));
        stage_sync_directory(&context.parent)?;
    }
    let namespace_handle = stage_open_dir(&context.parent_path)?;
    if Some(stage_identity(&namespace_handle.metadata().map_err(|_| "STAGE_PARENT_METADATA")?)) != context.namespace_identity.get() {
        return Err("STAGE_CONTEXT_CHANGED".into());
    }
    stage_sync_directory(&namespace_handle)?;
    let stage = context.parent_path.join(name);
    std::fs::DirBuilder::new().mode(0o700).create(&stage).map_err(|_| "STAGE_CREATE_ONLY_ATTEMPT")?;
    // From here any failure retains this attempt, never removes an ambiguous alias.
    let stage_handle = stage_open_dir(&stage)?;
    let stage_id = stage_identity(&stage_handle.metadata().map_err(|_| "STAGE_DIRECTORY_METADATA")?);
    let lock = stage_new_file(&stage.join(".attempt.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { return Err("STAGE_ATTEMPT_LOCK".into()); }
    lock.sync_all().map_err(|_| "STAGE_FILE_SYNC_ERROR")?;
    let lock_id = stage_identity(&lock.metadata().map_err(|_| "STAGE_LOCK_METADATA")?);
    let records = stage_records(bundle, images)?; let mut identities = BTreeMap::new();
    let mut directories = bundle.directories.clone(); directories.sort_by_key(|p| (p.split('/').count(), p.clone()));
    for relative in &directories {
        current()?; stage_context_current(context)?;
        let path = stage.join(relative); std::fs::DirBuilder::new().mode(0o700).create(&path).map_err(|_| "STAGE_CREATE_ONLY_DIRECTORY")?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "STAGE_DIRECTORY_METADATA")?; stage_directory_metadata(&metadata, true, false)?;
        identities.insert(relative.clone(), stage_identity(&metadata));
    }
    for (relative, bytes) in &bundle.files {
        current()?; stage_context_current(context)?;
        let identity = stage_write_file(&stage.join(relative), bytes)?; identities.insert(relative.clone(), identity);
    }
    current()?; stage_context_current(context)?;
    identities.insert(IMAGES.to_string(), stage_write_file(&stage.join(IMAGES), images)?);
    for directory in directories.iter().rev() { sync_directory(&stage_open_dir(&stage.join(directory))?)?; }
    let actual = stage_verify_inventory(&stage, &records, &identities, false, current)?;
    current()?; stage_context_current(context)?;
    let seal = stage_seal(&bundle.version, &actual, source_hash, stage_sha(images))?;
    let seal_id = stage_write_file(&stage.join("stage.seal"), &seal)?;
    sync_directory(&stage_handle)?;
    sync_directory(&namespace_handle)?;
    sync_directory(&context.parent)?;
    let actual = stage_verify_inventory(&stage, &records, &identities, true, current)?;
    let expected_seal = stage_seal(&bundle.version, &actual, source_hash, stage_sha(images))?;
    if stage_reopen(&stage.join("stage.seal"), seal_id, expected_seal.len(), current)? != expected_seal
        || stage_identity(&std::fs::symlink_metadata(&stage).map_err(|_| "STAGE_DIRECTORY_METADATA")?) != stage_id {
        return Err("STAGE_SEAL_CHANGED".into());
    }
    let lock_meta = std::fs::symlink_metadata(stage.join(".attempt.lock")).map_err(|_| "STAGE_LOCK_METADATA")?;
    stage_file_metadata(&lock_meta)?;
    if stage_identity(&lock_meta) != lock_id { return Err("STAGE_LOCK_CHANGED".into()); }
    current()?; stage_context_current(context)?;
    // Held lock is released by handle drop; inode and sealed attempt retained.
    drop(lock); Ok(stage)
}

pub fn fetch_staged(context: &StageContext, version: &str,
    mut current: impl FnMut() -> Result<(), String>) -> Result<(), String> {
    #[cfg(not(unix))]
    { let _ = (context, version, &mut current); Err("STAGE_NATIVE_IDENTITY_OR_DIRECTORY_DURABILITY_UNSUPPORTED".into()) }
    #[cfg(unix)]
    {
        current()?; stage_context_current(context)?; valid_version(version)?;
        let limits = stage_limits();
        let source = stage_get(&tarball_url(version), limits.max_source_bytes, &mut current)?;
        let images = stage_get(&images_url(version), limits.max_images_bytes, &mut current)?;
        stage_received(context, version, &source, &images, &mut current)
    }
}
#[cfg(unix)]
fn stage_received(context: &StageContext, version: &str, source: &[u8], images: &[u8],
    current: &mut impl FnMut() -> Result<(), String>) -> Result<(), String> {
    current()?; stage_context_current(context)?;
    let bundle = admit_release_bundle(source, images, version, stage_limits(), &stage_requirements())?;
    let name = format!("stage-{:032x}", rand::random::<u128>());
    let _retained = stage_bundle(context, &bundle, stage_sha(source), images, current, &name)
        .map_err(|reason| format!("{reason}; attempt={name}; outcome=UNKNOWN"))?;
    Err(format!("{PUBLICATION_UNAVAILABLE}; sealed_attempt={name}"))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_copy_downloads_copilotkit_ai_keeps_of_each_github_download() {
        assert_eq!(
            mirrored(&images_url("v0.3.4")).as_deref(),
            Some("https://downloads.copilotkit.ai/releases/v0.3.4/container-images.json")
        );
        for (download, tool) in [
            (crate::install::podman_download(), "podman"),
            (crate::install::compose_download(), "compose"),
        ] {
            // Only the builds for this kind of computer are named.
            let Ok(download) = download else { continue };
            let version = download.url.split('/').rev().nth(1).unwrap().to_string();
            assert_eq!(
                mirrored(&download.url),
                Some(format!(
                    "https://downloads.copilotkit.ai/tools/{tool}/{version}/{}",
                    download.file
                ))
            );
        }
        // A tag's source archive is kept with its release.
        assert_eq!(
            mirrored(&tarball_url("v0.3.3")).as_deref(),
            Some("https://downloads.copilotkit.ai/releases/v0.3.3/v0.3.3.tar.gz")
        );
        // A commit's archive, the release lookup and other repositories stay on GitHub.
        for github in [
            commit_tarball_url("0123456789abcdef"),
            "https://github.com/CopilotKit/OpenBot/archive/refs/tags/.tar.gz".to_string(),
            "https://github.com/someone/OpenBot/archive/refs/tags/v0.3.4.tar.gz".to_string(),
            "https://api.github.com/repos/CopilotKit/OpenBot/releases/latest".to_string(),
            "https://github.com/someone/OpenBot/releases/download/v0.3.4/container-images.json"
                .to_string(),
            "https://github.com/CopilotKit/OpenBot/releases/download/".to_string(),
        ] {
            assert_eq!(mirrored(&github), None, "{github}");
        }
    }

    /// A server that sends `chunks` pieces of `body`, `gap` apart, then closes.
    fn dripping(chunks: usize, gap: std::time::Duration) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let served = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let length = chunks * 4;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            for _ in 0..chunks {
                std::thread::sleep(gap);
                if stream.write_all(b"data").is_err() {
                    return;
                }
                let _ = stream.flush();
            }
        });
        (url, served)
    }

    #[test]
    fn a_download_that_keeps_arriving_finishes_however_long_it_takes() {
        // Six pieces 300 ms apart take 1.8 s in all, longer than the 1 s allowed between pieces.
        // `bytes()` gave up here with "error decoding response body"; a stream does not.
        let (url, served) = dripping(6, std::time::Duration::from_millis(300));
        let body = get_with(&url, std::time::Duration::from_secs(1), &[]).unwrap();
        assert_eq!(body, b"data".repeat(6));
        served.join().unwrap();
    }

    #[test]
    fn a_download_that_stalls_is_given_up() {
        let (url, served) = dripping(2, std::time::Duration::from_millis(1500));
        let error = get_with(&url, std::time::Duration::from_millis(500), &[]).unwrap_err();
        assert!(error.starts_with("the download did not finish"), "{error}");
        served.join().unwrap();
    }

    /// What one connection to `scripted` gets.
    #[derive(Clone, Copy)]
    enum Reply {
        /// The whole body.
        Whole,
        /// Half the promised body, then the connection is closed.
        Cut,
        /// This status and nothing else.
        Status(u16),
        /// The headers and half the body, then nothing more, with the connection left open: a
        /// download that stops arriving.
        StallPartWay,
        /// Nothing at all, not even the headers, with the connection left open: GitHub's archive
        /// for a commit when it does not answer.
        StallBeforeAnswering,
    }

    /// A server that answers its connections with `replies` in order, repeating the last one, and
    /// counts them. It is left running; the test process ends it.
    fn scripted(replies: Vec<Reply>) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        use std::sync::atomic::Ordering;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/file", listener.local_addr().unwrap());
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = count.clone();
        std::thread::spawn(move || {
            // Stalled connections are kept open here, so the client sees silence and not a close.
            let mut stalled = Vec::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let index = counted.fetch_add(1, Ordering::SeqCst);
                let reply = replies[index.min(replies.len() - 1)];
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let (status, sent) = match reply {
                    Reply::Whole => (200, &b"datadata"[..]),
                    Reply::Cut | Reply::StallPartWay => (200, &b"data"[..]),
                    Reply::Status(code) => (code, &b"datadata"[..]),
                    Reply::StallBeforeAnswering => {
                        stalled.push(stream);
                        continue;
                    }
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: 8\r\nconnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(sent);
                let _ = stream.flush();
                if matches!(reply, Reply::StallPartWay) {
                    stalled.push(stream);
                }
            }
        });
        (url, count)
    }

    const NO_WAIT: [std::time::Duration; 2] = [std::time::Duration::ZERO; 2];

    fn get_quickly(url: &str) -> Result<Vec<u8>, String> {
        get_with(url, std::time::Duration::from_secs(5), &NO_WAIT)
    }

    fn connections(count: &std::sync::atomic::AtomicUsize) -> usize {
        count.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn a_download_cut_off_once_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Cut, Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn a_download_cut_off_every_time_is_given_up_after_every_attempt() {
        let (url, count) = scripted(vec![Reply::Cut]);
        let error = get_patiently(&url, std::time::Duration::from_secs(5)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert!(error.starts_with("the download did not finish"), "{error}");
        assert!(
            error.ends_with(&format!("({attempts} attempts)")),
            "{error}"
        );
        assert_eq!(connections(&count), attempts);
    }

    /// `get` with every wait between attempts cut to nothing, but as many attempts as it makes for
    /// real, and `stall` as the time it waits for the next byte.
    fn get_patiently(url: &str, stall: std::time::Duration) -> Result<Vec<u8>, String> {
        get_with(url, stall, &[std::time::Duration::ZERO; RETRY_DELAYS.len()])
    }

    /// The Desktop's first update after an install, 2026-11-08: GitHub sent nothing for the
    /// commit's archive for 30 seconds three times running, the download gave up after its third
    /// attempt, and the update was put back. Opening OpenBot again two minutes later downloaded it
    /// in two seconds. A download that stalls is given up after the stall window and tried again,
    /// for long enough to outlast that.
    #[test]
    fn a_download_that_stalls_part_way_is_tried_again_until_it_arrives() {
        let stall = std::time::Duration::from_millis(300);
        let (url, count) = scripted(vec![
            Reply::StallPartWay,
            Reply::StallPartWay,
            Reply::StallPartWay,
            Reply::Whole,
        ]);
        let started = std::time::Instant::now();
        assert_eq!(get_patiently(&url, stall).unwrap(), b"datadata");
        assert_eq!(connections(&count), 4);
        // Each stalled attempt was given up after the stall window, not left hanging.
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(5), "{took:?}");
    }

    #[test]
    fn a_server_that_sends_nothing_is_tried_again_until_it_answers() {
        let (url, count) = scripted(vec![
            Reply::StallBeforeAnswering,
            Reply::StallBeforeAnswering,
            Reply::StallBeforeAnswering,
            Reply::Whole,
        ]);
        let body = get_patiently(&url, std::time::Duration::from_millis(300)).unwrap();
        assert_eq!(body, b"datadata");
        assert_eq!(connections(&count), 4);
    }

    #[test]
    fn a_server_that_never_answers_is_given_up_with_what_happened() {
        let (url, count) = scripted(vec![Reply::StallBeforeAnswering]);
        let error = get_patiently(&url, std::time::Duration::from_millis(200)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert_eq!(
            error,
            format!("{url} sent nothing for 200 ms ({attempts} attempts)")
        );
        assert_eq!(connections(&count), attempts);
    }

    #[test]
    fn a_download_that_stalls_every_time_is_given_up() {
        let (url, count) = scripted(vec![Reply::StallPartWay]);
        let error = get_patiently(&url, std::time::Duration::from_millis(200)).unwrap_err();
        let attempts = RETRY_DELAYS.len() + 1;
        assert_eq!(
            error,
            format!(
                "the download did not finish: nothing arrived for 200 ms after 4 bytes \
                 ({attempts} attempts)"
            )
        );
        assert_eq!(connections(&count), attempts);
    }

    #[test]
    fn a_missing_file_is_reported_at_once() {
        let (url, count) = scripted(vec![Reply::Status(404), Reply::Whole]);
        let error = get_quickly(&url).unwrap_err();
        assert_eq!(error, format!("{url} answered 404 Not Found"));
        assert_eq!(connections(&count), 1);
    }

    #[test]
    fn a_server_error_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Status(503), Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn being_asked_to_slow_down_is_tried_again() {
        let (url, count) = scripted(vec![Reply::Status(429), Reply::Whole]);
        assert_eq!(get_quickly(&url).unwrap(), b"datadata");
        assert_eq!(connections(&count), 2);
    }

    #[test]
    fn this_repositorys_compose_file_runs_the_server_and_worker_as_services() {
        let text = include_str!("../../../docker-compose.yml");
        let services = compose_services(text);
        for name in ["postgres", "supervisor", "server", "worker"] {
            assert!(services.contains(&name), "{name} not in {services:?}");
        }
    }

    #[test]
    fn a_release_whose_server_ran_on_the_host_is_fetched_again_at_its_own_version() {
        let root = crate::test_support::temp_root("deployment-host-server");
        std::fs::create_dir_all(&root).unwrap();
        // The shape of every release before the server moved into Compose: services, none of them
        // OpenBot's own, and one commented-out line that must not count.
        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres:\n    image: postgres\n  # server: on the host\n  supervisor:\n    \
             environment:\n      server: x\nvolumes:\n  worker:\n",
        )
        .unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        record(&root, "v0.0.15", false).unwrap();
        assert!(predates_containers(&root));
        assert!(needs_fetch(&root, "v0.0.15"));

        std::fs::write(
            root.join("docker-compose.yml"),
            "services:\n  postgres: {}\n  server:\n    profiles: [\"openbot\"]\n  worker:\n    \
             profiles: [\"openbot\"]\n",
        )
        .unwrap();
        assert!(!predates_containers(&root));
        assert!(!needs_fetch(&root, "v0.0.15"));

        std::fs::remove_file(root.join("docker-compose.yml")).unwrap();
        assert!(
            !predates_containers(&root),
            "a missing file is damage, not age"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn manifest(names: &[&str]) -> Images {
        Images {
            version: "v0.0.7".into(),
            images: names
                .iter()
                .map(|name| {
                    (
                        (*name).to_string(),
                        Image {
                            reference: format!("ghcr.io/copilotkit/openbot-{name}@sha256:{}", "a".repeat(64)),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn a_pin_takes_its_version_from_the_manifest_and_keeps_the_text_as_it_was() {
        let text: &'static str = r#"{ "version": "v0.0.9",  "images": {} }"#;
        let pin = pin_from(text, "0123456789abcdef0123456789abcdef01234567").unwrap();
        assert_eq!(pin.version, "v0.0.9");
        assert_eq!(pin.commit, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(pin.images, text);
    }

    #[test]
    fn a_manifest_that_cannot_be_read_is_not_a_pin() {
        let error = pin_from("not json", "abc").unwrap_err();
        assert!(error.contains("is not readable"), "{error}");
    }

    #[cfg(not(openbot_pinned))]
    #[test]
    fn an_ordinary_build_is_not_pinned() {
        assert_eq!(pinned(), None);
    }

    #[test]
    fn a_deployment_without_an_image_manifest_is_fetched_again_rather_than_refused() {
        let dir = std::env::temp_dir().join(format!("openbot-manifest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(images_path(&dir));
        record(&dir, "v0.0.7", false).unwrap();

        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a matching stamp is not enough when the images are not named"
        );

        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A GitHub tag tarball, with every path given its own body.
    fn release_tarball(top: &str, paths: &[(&str, &str)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tarball = tar::Builder::new(encoder);
        for (path, body) in paths {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tarball
                .append_data(&mut header, format!("{top}/{path}"), body.as_bytes())
                .unwrap();
        }
        tarball.into_inner().unwrap().finish().unwrap()
    }

    /// Every path in `LAYOUT` as a file in a tarball, and the rest of a release's tree beside them.
    fn whole_release(top: &str) -> Vec<u8> {
        let mut paths: Vec<(String, String)> = LAYOUT
            .iter()
            .map(|entry| match *entry {
                "docker-compose.yml" => (
                    entry.to_string(),
                    "services:\n  server: {}\n  worker: {}\n".to_string(),
                ),
                _ => (entry.to_string(), format!("release {entry}")),
            })
            .collect();
        for rest in [
            "server/src/index.ts",
            "app/package.json",
            "worker/src/index.ts",
            "toolkit/package.json",
            "examples/fintech/package.json",
            "scripts/start.sh",
            "patches/x.patch",
            "package.json",
            "bun.lock",
            "shared/harnesses.json",
            "shared/openbot-browser.ts",
            "agent-computer/package.json",
            "agent-computer/src/index.ts",
            "extension/package.json",
        ] {
            paths.push((rest.into(), format!("release {rest}")));
        }
        let borrowed: Vec<(&str, &str)> = paths
            .iter()
            .map(|(path, body)| (path.as_str(), body.as_str()))
            .collect();
        release_tarball(top, &borrowed)
    }

    /// The containers run from images, so a deployment lays out the Compose file and nothing of the
    /// server, the app, the worker, the computer or the root workspace. Nor the browser earlier
    /// versions ran on the person's desktop: the person's browser is on the one computer now.
    #[test]
    fn only_the_compose_file_is_laid_out() {
        let root = crate::test_support::temp_root("deployment-layout");
        std::fs::create_dir_all(&root).unwrap();
        unpack(&root, &whole_release("OpenBot-0.3.1")).unwrap();
        for entry in LAYOUT {
            assert!(root.join(entry).exists(), "{entry} is not laid out");
        }
        for left in [
            "server",
            "app",
            "worker",
            "toolkit",
            "examples",
            "scripts",
            "patches",
            "package.json",
            "bun.lock",
            "shared",
            "agent-computer",
            "extension",
        ] {
            assert!(!root.join(left).exists(), "{left} is laid out");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// An installation laid out by an app that copied whole folders (`agent-computer`, `shared`)
    /// already has everything this app lays out, so it is not fetched again for the new layout.
    #[test]
    fn an_installation_laid_out_with_whole_folders_is_not_laid_out_again() {
        let root = crate::test_support::temp_root("deployment-whole-folders");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        let earlier = [
            "agent-computer",
            "app",
            "bun.lock",
            "bunfig.toml",
            "docker-compose.yml",
            "examples",
            "extension",
            "package.json",
            "patches",
            "scripts",
            "server",
            "shared",
            "toolkit",
            "tsconfig.base.json",
            "worker",
        ];
        std::fs::write(
            stamp_path(&root),
            serde_json::json!({ "version": "v0.3.0", "layout": earlier }).to_string(),
        )
        .unwrap();
        assert!(!needs_fetch(&root, "v0.3.0"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// M3: upstream's `fetch_with` lays a release out in place (Install's re-lay-out of an older
    /// layout, and the move of a host-server release to the latest one). This fork refuses any
    /// unverified in-place lay-out, so it downloads nothing and leaves the deployment as it was.
    #[test]
    fn fetch_with_fails_closed_without_downloading_or_touching_the_deployment() {
        let root = crate::test_support::temp_root("deployment-fetch-with-closed");
        std::fs::create_dir_all(&root).unwrap();
        let compose = "services:\n  postgres: {}\n  supervisor: {}\n";
        std::fs::write(root.join("docker-compose.yml"), compose).unwrap();
        std::fs::write(images_path(&root), "{}").unwrap();
        std::fs::write(root.join(".env"), "KEY_ENCRYPTION_KEY=customer-key\n").unwrap();
        record(&root, "v0.0.15", false).unwrap();
        let get = |url: &str| -> Result<Vec<u8>, String> { panic!("nothing is downloaded: {url}") };
        for version in ["v0.0.15", "v0.0.16"] {
            let error = fetch_with(&root, version, &get).unwrap_err();
            assert!(error.starts_with(PUBLICATION_UNAVAILABLE), "{error}");
        }
        assert_eq!(installed(&root).unwrap().version, "v0.0.15");
        assert_eq!(std::fs::read_to_string(root.join("docker-compose.yml")).unwrap(), compose);
        assert_eq!(std::fs::read_to_string(images_path(&root)).unwrap(), "{}");
        assert_eq!(
            std::fs::read_to_string(root.join(".env")).unwrap(),
            "KEY_ENCRYPTION_KEY=customer-key\n"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn every_service_compose_can_run_is_pinned_to_a_published_digest() {
        let published: Vec<&str> = IMAGE_VARIABLES.iter().map(|(name, _)| *name).collect();
        let pinned = pin(&manifest(&published)).expect("a complete manifest pins");
        assert_eq!(pinned.len(), IMAGE_VARIABLES.len());
        for ((published, variable), (actual_variable, reference)) in IMAGE_VARIABLES.iter().zip(&pinned) {
            assert_eq!(actual_variable, variable);
            assert_eq!(reference, &format!("ghcr.io/copilotkit/openbot-{published}@sha256:{}", "a".repeat(64)));
            assert!(
                reference.contains("@sha256:"),
                "a tag is not a version: {reference}"
            );
        }
    }

    fn complete_manifest() -> Images {
        manifest(&IMAGE_VARIABLES.map(|(name, _)| name))
    }

    fn manifest_bytes(manifest: &Images) -> Vec<u8> {
        serde_json::to_vec(manifest).unwrap()
    }

    fn assert_readers_refuse(root: &Path) {
        assert!(image_variables(root).is_err(), "variables must fail closed");
        assert!(reference(root, "server").is_err(), "direct lookup must fail closed");
    }

    #[test]
    fn every_required_image_rejects_each_unpinned_or_malformed_reference() {
        let hex = "a".repeat(64);
        let invalid = [
            String::new(), "repo:latest".into(), format!("@sha256:{hex}"),
            format!("repo@sha256:{}", "a".repeat(63)),
            format!("repo@sha256:{}", "a".repeat(65)),
            format!("repo@sha256:{}", "A".repeat(64)),
            format!("repo@sha256:{}", "g".repeat(64)),
            format!("repo@sha512:{hex}"), format!("repo@@sha256:{hex}"),
            format!("repo@sha256:{hex}@extra"), format!(" repo@sha256:{hex}"),
            format!("repo@sha256:{hex} "), format!("repo@sha256:{hex}\n"),
            format!("re\tpo@sha256:{hex}"), format!("repo@sha256:{hex}\0"),
            format!("https://registry/repo@sha256:{hex}"),
            format!("repo?query@sha256:{hex}"), format!("repo#fragment@sha256:{hex}"),
            format!("repo/@sha256:{hex}"), format!("repo:@sha256:{hex}"),
            format!("registry:bad/repo@sha256:{hex}"),
            format!("repo...name@sha256:{hex}"), format!("repo___name@sha256:{hex}"),
            format!("registry.example/Uppercase@sha256:{hex}"),
            format!("registry.example//repo@sha256:{hex}"),
        ];
        for (name, _) in IMAGE_VARIABLES {
            for bad in &invalid {
                let mut value = complete_manifest();
                value.images.get_mut(name).unwrap().reference = bad.clone();
                assert!(pin(&value).is_err(), "{name}: {bad:?}");
            }
        }
    }

    #[test]
    fn registry_port_and_optional_tag_keep_the_actual_digest_pin() {
        for prefix in ["repo", "repo:tag", "registry.example:5000/team/repo", "registry.example:5000/team/repo:tag_1.2-3", "[::1]:5000/team/repo:tag", "registry.example/team/repo__name--part:tag"] {
            let mut value = complete_manifest();
            let wanted = format!("{prefix}@sha256:{}", "0123456789abcdef".repeat(4));
            value.images.get_mut("server").unwrap().reference = wanted.clone();
            assert_eq!(pin(&value).unwrap()[0].1, wanted);
        }
    }

    #[test]
    fn uppercase_single_label_registry_preserves_original_text_through_save_and_readers() {
        let root = scratch("uppercase-registry");
        let mut value = complete_manifest();
        let wanted = format!("REGISTRY/team/repo:tag@sha256:{}", "a".repeat(64));
        value.images.get_mut("server").unwrap().reference = wanted.clone();
        assert_eq!(pin(&value).unwrap()[0].1, wanted);
        record(&root, &value.version, false).unwrap();
        save_images(&root, &value.version, &manifest_bytes(&value)).unwrap();
        assert_eq!(image_variables(&root).unwrap()[0].1, wanted);
        assert_eq!(reference(&root, "server").unwrap(), wanted);
        assert_eq!(read_images(&root).unwrap().images["server"].reference, wanted);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn every_required_name_is_required_even_when_extra_images_exist() {
        for (missing, _) in IMAGE_VARIABLES {
            let mut value = complete_manifest();
            value.images.insert("extra".into(), value.images["server"].clone());
            value.images.remove(missing);
            assert!(pin(&value).unwrap_err().contains(missing));
        }
    }

    #[test]
    fn strict_readers_allow_same_version_offline_and_valid_extra_direct_reference() {
        let root = scratch("strict-offline");
        let mut value = complete_manifest();
        let extra = format!("localhost:5000/extra:release@sha256:{}", "b".repeat(64));
        value.images.insert("additional-published-name".into(), Image { reference: extra.clone() });
        record(&root, &value.version, false).unwrap();
        save_images(&root, &value.version, &manifest_bytes(&value)).unwrap();
        assert_eq!(image_variables(&root).unwrap(), pin(&value).unwrap());
        assert_eq!(reference(&root, "additional-published-name").unwrap(), extra);
        assert!(reference(&root, "unpublished").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_invalid_extra_entry_blocks_both_readers_even_for_a_valid_required_entry() {
        let root = scratch("strict-extra");
        let mut value = complete_manifest();
        value.images.insert("extra".into(), Image { reference: "repo:latest".into() });
        record(&root, &value.version, false).unwrap();
        std::fs::write(images_path(&root), manifest_bytes(&value)).unwrap();
        assert_readers_refuse(&root);
        assert!(reference(&root, "extra").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_readers_refuse_missing_bad_or_invalid_version_stamp() {
        let root = scratch("strict-stamp");
        let value = complete_manifest();
        std::fs::write(images_path(&root), manifest_bytes(&value)).unwrap();
        assert_readers_refuse(&root);
        for stamp in ["not json".to_string(), "{}".into(), serde_json::json!({"version":""}).to_string(), serde_json::json!({"version":"v0.0.7 "}).to_string(), serde_json::json!({"version":"v0.0.7\0"}).to_string()] {
            std::fs::write(stamp_path(&root), stamp).unwrap();
            assert_readers_refuse(&root);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_readers_refuse_missing_bad_wrong_version_or_bad_reference_manifest() {
        let root = scratch("strict-manifest");
        record(&root, "v0.0.7", false).unwrap();
        assert_readers_refuse(&root);
        for body in [b"not json".as_slice(), b"{}"] {
            std::fs::write(images_path(&root), body).unwrap();
            assert_readers_refuse(&root);
        }
        let mut value = complete_manifest(); value.version = "0.0.7".into();
        std::fs::write(images_path(&root), manifest_bytes(&value)).unwrap();
        assert_readers_refuse(&root);
        value.version = "v0.0.7".into();
        for (name, _) in IMAGE_VARIABLES {
            let mut bad = value.clone(); bad.images.get_mut(name).unwrap().reference = "repo:latest".into();
            std::fs::write(images_path(&root), manifest_bytes(&bad)).unwrap();
            assert_readers_refuse(&root);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn release_versions_are_exact_nonempty_original_text_without_whitespace_or_controls() {
        let root = scratch("strict-version");
        for version in ["", " v0.0.7", "v0.0.7 ", "v0.0.7\n", "v0.0.7\0", "v0.0.7\u{2003}"] {
            let mut value = complete_manifest(); value.version = version.into();
            assert!(pin(&value).is_err());
            assert!(save_images(&root, version, &manifest_bytes(&value)).is_err());
            assert!(!images_path(&root).exists());
        }
        for version in ["v0.0.7", "0.0.7", "release-candidate_01"] {
            let mut value = complete_manifest(); value.version = version.into();
            record(&root, version, false).unwrap();
            save_images(&root, version, &manifest_bytes(&value)).unwrap();
            assert_eq!(read_images(&root).unwrap().version, version);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_wrong_response_version_writes_neither_new_manifest_nor_success_stamp() {
        let root = scratch("save-version-new");
        let value = complete_manifest();
        assert!(save_images(&root, "0.0.7", &manifest_bytes(&value)).is_err());
        assert!(!images_path(&root).exists());
        assert!(!stamp_path(&root).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_response_or_requested_version_preserves_existing_manifest_and_stamp() {
        let root = scratch("save-version-existing");
        let value = complete_manifest();
        record(&root, &value.version, false).unwrap();
        save_images(&root, &value.version, &manifest_bytes(&value)).unwrap();
        let old_stamp = std::fs::read(stamp_path(&root)).unwrap();
        let old_images = std::fs::read(images_path(&root)).unwrap();
        let mut wrong = value.clone(); wrong.version = "v-other".into();
        let mut bad_ref = value.clone(); bad_ref.images.get_mut("server").unwrap().reference = "repo:latest".into();
        let mut missing = value.clone(); missing.images.remove("server");
        for body in [manifest_bytes(&wrong), manifest_bytes(&bad_ref), manifest_bytes(&missing), b"not json".to_vec()] {
            assert!(save_images(&root, &value.version, &body).is_err());
            assert_eq!(std::fs::read(images_path(&root)).unwrap(), old_images);
            assert_eq!(std::fs::read(stamp_path(&root)).unwrap(), old_stamp);
        }
        assert!(save_images(&root, "v0.0.7 ", &manifest_bytes(&value)).is_err());
        assert_eq!(std::fs::read(images_path(&root)).unwrap(), old_images);
        assert_eq!(std::fs::read(stamp_path(&root)).unwrap(), old_stamp);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_save_keeps_fixed_version_bytes_then_allows_explicit_success_record() {
        let root = scratch("save-success");
        let value = complete_manifest(); let body = manifest_bytes(&value);
        save_images(&root, &value.version, &body).unwrap();
        assert_eq!(std::fs::read(images_path(&root)).unwrap(), body);
        assert!(!stamp_path(&root).exists(), "saving images does not record fetch success");
        record(&root, &value.version, false).unwrap();
        assert_eq!(image_variables(&root).unwrap(), pin(&value).unwrap());
        assert_eq!(reference(&root, "server").unwrap(), value.images["server"].reference);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_manifest_missing_an_image_is_refused_rather_than_filled_in_from_compose() {
        // Compose's defaults are local build names. Falling back to them would run four published
        // images beside one that does not exist, and say nothing about the difference.
        let missing = pin(&manifest(&[
            "server",
            "supervisor",
            "agent-computer",
            "agent-bot",
        ]));
        let error = missing.expect_err("an incomplete manifest is not a deployment");
        assert!(error.contains("agent-langgraph"), "{error}");
    }

    #[test]
    fn the_image_manifest_is_fetched_from_the_same_version_as_the_tree() {
        let url = images_url("v0.0.7");
        assert!(url.contains("/download/v0.0.7/"), "{url}");
        assert!(url.ends_with("container-images.json"), "{url}");
    }

    #[test]
    fn the_tarball_is_a_tag_rather_than_a_branch() {
        let url = tarball_url("v0.0.7");
        assert!(url.contains("/refs/tags/v0.0.7"), "{url}");
        assert!(!url.contains("/heads/"), "a branch is not a version: {url}");
        assert!(
            url.starts_with("https://"),
            "must not need a git client: {url}"
        );
    }

    #[test]
    fn an_empty_directory_needs_fetching() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-empty-{}", std::process::id()));
        assert!(needs_fetch(&dir, "v0.0.7"));
    }

    /// One tarball, written as bytes rather than through `tar::Builder`.
    ///
    /// The builder refuses a path holding `..` outright ("paths in archives must
    /// not have `..`"), which is the right thing for it to do and makes it the
    /// wrong tool for this: an archive that climbs out of its root is not
    /// produced by a careful writer, it is produced by somebody writing the
    /// bytes. A ustar header is a name, a size, a checksum and padding.
    fn tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar: Vec<u8> = Vec::new();
        for (name, body) in entries {
            let mut header = [0u8; 512];
            let bytes = name.as_bytes();
            assert!(bytes.len() < 100, "the test uses short names");
            header[..bytes.len()].copy_from_slice(bytes);
            header[100..107].copy_from_slice(b"0000644"); // mode
            header[108..115].copy_from_slice(b"0000000"); // uid
            header[116..123].copy_from_slice(b"0000000"); // gid
            let size = format!("{:011o}", body.len());
            header[124..135].copy_from_slice(size.as_bytes());
            header[136..147].copy_from_slice(b"00000000000"); // mtime
            header[156] = b'0'; // a regular file
            header[257..263].copy_from_slice(b"ustar ");
            header[263..265].copy_from_slice(b"00");
            // The checksum is computed with its own field read as spaces.
            header[148..156].copy_from_slice(b"        ");
            let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
            let checksum = format!("{sum:06o}  ");
            header[148..156].copy_from_slice(checksum.as_bytes());

            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(512) * 512, 0); // pad to a block
        }
        tar.extend_from_slice(&[0u8; 1024]); // two empty blocks end an archive

        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &tar).expect("the test archive is compressed");
        encoder.finish().expect("the test archive is compressed")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("openbot-unpack-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        dir
    }

    fn full_pin_text() -> &'static str {
        let images: Vec<String> = IMAGE_VARIABLES
            .iter()
            .map(|(name, _)| {
                format!(r#""{name}": {{ "reference": "ghcr.io/x/{name}@sha256:{}" }}"#, "a".repeat(64))
            })
            .collect();
        let text = format!(
            r#"{{ "version": "v0.3.0-rc.1", "images": {{ {} }} }}"#,
            images.join(", ")
        );
        Box::leak(text.into_boxed_str())
    }

    #[test]
    fn a_pinned_fetch_fails_closed_and_lays_nothing_out() {
        // M3: upstream lays the pinned commit's archive out in place; this fork refuses an
        // unverified lay-out, a pinned build's included (see `fetch_pinned`).
        let dir = scratch("pinned-fetch");
        std::fs::write(dir.join(".env"), "KEEP=1").unwrap();
        let pin = pin_from(full_pin_text(), "0123456789abcdef").unwrap();
        let error = fetch_pinned(&dir, &pin).unwrap_err();
        assert!(error.starts_with(PUBLICATION_UNAVAILABLE), "{error}");
        assert!(installed(&dir).is_none());
        assert!(!images_path(&dir).exists());
        assert_eq!(std::fs::read_to_string(dir.join(".env")).unwrap(), "KEEP=1");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_incomplete_pin_is_refused_before_anything_is_fetched() {
        let dir = scratch("pinned-incomplete");
        let pin = pin_from(r#"{ "version": "v0.3.0", "images": {} }"#, "abc").unwrap();
        let error = fetch_pinned(&dir, &pin).unwrap_err();
        assert!(error.contains("names no"), "{error}");
        assert!(installed(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_test_archive_really_carries_the_traversal() {
        // Guards the guard: if the archive did not hold `..` the next test would
        // pass for the wrong reason.
        let archive = tarball(&[(
            "OpenBot-0.0.8/agent-computer/src/../../../escaped.txt",
            b"owned",
        )]);
        let decoder = flate2::read::GzDecoder::new(&archive[..]);
        let mut tar = tar::Archive::new(decoder);
        let paths: Vec<String> = tar
            .entries()
            .expect("the test archive is readable")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .path()
                    .expect("a path")
                    .display()
                    .to_string()
            })
            .collect();
        assert_eq!(
            paths,
            ["OpenBot-0.0.8/agent-computer/src/../../../escaped.txt"]
        );
    }

    #[test]
    fn a_download_that_climbs_out_of_the_root_is_refused() {
        // `root.join("agent-computer/src/../../../x")` starts with `root` --
        // `Path::starts_with` compares components and does not resolve `..` -- so
        // asking where the path landed cannot answer this. Refused before the
        // wanted-list is asked, so it is refused whatever a deployment lays out.
        let dir = scratch("escape");
        let root = dir.join("deployment");
        std::fs::create_dir_all(&root).expect("the root is made");

        let archive = tarball(&[(
            "OpenBot-0.0.8/agent-computer/src/../../../escaped.txt",
            b"owned",
        )]);
        let outcome = unpack(&root, &archive);

        let climbed = dir.join("escaped.txt");
        let written = climbed.exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!written, "a file was written above the root");
        assert!(outcome.is_err(), "the traversal was accepted: {outcome:?}");
        assert!(
            outcome.unwrap_err().contains("outside"),
            "the refusal should say what it refused"
        );
    }

    #[test]
    fn an_ordinary_download_still_lands_where_it_should() {
        let dir = scratch("ordinary");

        let archive = tarball(&[
            ("OpenBot-0.0.8/docker-compose.yml", b"services: {}"),
            // Not part of a deployment: skipped, not refused.
            ("OpenBot-0.0.8/agent-computer/src/index.ts", b"export {}"),
            ("OpenBot-0.0.8/docs/readme.md", b"# hi"),
        ]);
        unpack(&dir, &archive).expect("an ordinary download is laid out");

        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).ok();
        let computer = dir.join("agent-computer").exists();
        let docs = dir.join("docs").exists();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(compose.as_deref(), Some("services: {}"));
        assert!(!computer, "the computer runs from its image");
        assert!(!docs, "the rest of the tree is not part of a deployment");
    }

    #[test]
    fn a_recorded_version_is_not_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-same-{}", std::process::id()));
        record(&dir, "v0.0.7", false).unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        assert!(!needs_fetch(&dir, "v0.0.7"));
        assert!(
            needs_fetch(&dir, "v0.0.8"),
            "a newer version has to be fetched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// v0.2.0 installs were laid out by an app that did not copy `agent-computer`, and their stamp
    /// matches the version they run, so Repair never fetched again. A stamp says what it laid out;
    /// one that laid out less than this app needs is fetched once.
    #[test]
    fn a_deployment_laid_out_by_an_app_that_copied_less_is_fetched_again() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-layout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(images_path(&dir), "{}").unwrap();
        // Exactly what an earlier app wrote.
        std::fs::write(stamp_path(&dir), r#"{"version":"v0.2.0"}"#).unwrap();
        assert!(needs_fetch(&dir, "v0.2.0"));
        assert_eq!(installed(&dir).unwrap().version, "v0.2.0");

        record(&dir, "v0.2.0", false).unwrap();
        assert!(!needs_fetch(&dir, "v0.2.0"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stamp_written_before_pinning_reads_as_unpinned() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-unpinned-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), r#"{"version":"v0.2.0","layout":["app"]}"#).unwrap();
        assert!(!installed(&dir).unwrap().pinned);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_pinned_stamp_reads_back_as_pinned() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-pinned-{}", std::process::id()));
        record(&dir, "v0.2.0", true).unwrap();
        assert!(installed(&dir).unwrap().pinned);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_fetch_is_replaced_rather_than_trusted() {
        // Files present, stamp absent: what an interrupted extract leaves behind. The stamp is
        // written last precisely so this case is distinguishable.
        let dir = std::env::temp_dir().join(format!("openbot-dep-partial-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("server")).unwrap();
        std::fs::write(dir.join("docker-compose.yml"), "services: {}\n").unwrap();
        assert!(
            needs_fetch(&dir, "v0.0.7"),
            "a directory with no stamp is not a deployment"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_stamp_is_treated_as_absent_rather_than_fatal() {
        let dir = std::env::temp_dir().join(format!("openbot-dep-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(stamp_path(&dir), "{ not json").unwrap();
        assert!(installed(&dir).is_none());
        assert!(needs_fetch(&dir, "v0.0.7"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The containers' Compose file is the one thing a deployment cannot run without.
    #[test]
    fn the_compose_file_is_laid_out_and_nothing_a_container_runs_from_is() {
        assert!(LAYOUT.contains(&"docker-compose.yml"));
        for entry in LAYOUT {
            for container_source in ["server", "app", "worker", "toolkit", "examples", "scripts"] {
                assert!(
                    !entry.starts_with(container_source),
                    "{entry}: the containers run that from their images"
                );
            }
        }
    }
    // F4a preconditions ONLY. No fake archive oracle or successful bundle stub.
    fn admission_test_limits() -> AdmissionLimits {
        AdmissionLimits { max_entries: 64, max_total_uncompressed: 65536, max_tar_bytes: 131072,
            max_entry_bytes: 8192, max_path_bytes: 1024, max_source_bytes: 32768,
            max_images_bytes: 32768 }
    }
    fn admission_test_requirements() -> Vec<AdmissionRequirement<'static>> {
        ["docker-compose.yml", "package.json", "bun.lock", "server/package.json",
            "app/package.json", "worker/package.json", "tsconfig.base.json"].into_iter()
            .map(|path| AdmissionRequirement { path, kind: AdmissionKind::Regular }).collect()
    }

    #[test]
    fn admission_limits_require_all_explicit_positive_finite_caps() {
        for index in 0..7 {
            for invalid in [0, usize::MAX] {
                let mut limits = admission_test_limits();
                match index { 0 => limits.max_entries = invalid, 1 => limits.max_total_uncompressed = invalid,
                    2 => limits.max_entry_bytes = invalid, 3 => limits.max_path_bytes = invalid,
                    4 => limits.max_source_bytes = invalid, 5 => limits.max_images_bytes = invalid,
                    _ => limits.max_tar_bytes = invalid }
                assert!(limits.validate().is_err());
            }
        }
        let mut limits = admission_test_limits(); limits.max_entry_bytes = limits.max_total_uncompressed + 1;
        assert!(limits.validate().is_err());
        let mut limits = admission_test_limits(); limits.max_path_bytes = limits.max_total_uncompressed + 1;
        assert!(limits.validate().is_err());
        let mut limits = admission_test_limits(); limits.max_entries = usize::MAX / 2 + 1;
        assert!(limits.validate().is_err());
    }

    #[test]
    fn admission_input_caps_are_inclusive_and_reject_one_byte_excess() {
        let mut limits = admission_test_limits(); limits.max_source_bytes = 2; limits.max_images_bytes = 3;
        assert!(limits.check_inputs(b"ab", b"xyz").is_ok());
        assert!(limits.check_inputs(b"abc", b"xyz").is_err());
        assert!(limits.check_inputs(b"ab", b"xyzz").is_err());
    }

    #[test]
    fn admission_budget_uses_actual_counts_and_refuses_overflow_without_advancing() {
        let mut limits = admission_test_limits(); limits.max_entries = 2;
        limits.max_total_uncompressed = 4; limits.max_entry_bytes = 3; limits.max_path_bytes = 4;
        let mut budget = AdmissionBudget::new(limits).unwrap();
        assert!(budget.read_entry_payload(1).is_err());
        budget.begin_entry().unwrap(); budget.read_entry_payload(3).unwrap();
        assert!(budget.read_entry_payload(1).is_err()); assert_eq!(budget.entry, 3);
        budget.read_uncompressed(4).unwrap(); assert!(budget.read_uncompressed(1).is_err()); assert_eq!(budget.total, 4);
        budget.begin_entry().unwrap(); assert_eq!(budget.entry, 0); assert!(budget.begin_entry().is_err()); assert_eq!(budget.entries, 2);
        budget.total = usize::MAX - 1; assert!(budget.read_uncompressed(2).is_err()); assert_eq!(budget.total, usize::MAX - 1);
        budget.entry = usize::MAX - 1; assert!(budget.read_entry_payload(2).is_err()); assert_eq!(budget.entry, usize::MAX - 1);
        budget.entries = usize::MAX; assert!(budget.begin_entry().is_err()); assert_eq!(budget.entries, usize::MAX);
    }

    #[test]
    fn admission_path_refuses_unsafe_names_even_when_not_selectable() {
        for path in ["/docs/a", "//server/a", "C:/docs/a", "docs\\a", "docs/a:b", "docs/../a",
            "docs//a", "docs/./a", "docs/a/", "docs/a.", "docs/a ", "docs/CON.txt", "docs/com1",
            "docs/LPT9.log", "docs/aux", "docs/é", "docs/a\n", "docs/a*", "docs/a?"] {
            assert!(admission_path(path, false, 1024).is_err(), "{path:?}");
        }
        assert_eq!(admission_path("docs/ordinary.txt", false, 1024).unwrap(), "docs/ordinary.txt");
        assert!(!admission_selected("docs/ordinary.txt"));
        assert_eq!(admission_path("server/", true, 1024).unwrap(), "server");
        assert!(admission_path("server//", true, 1024).is_err());
        assert!(admission_path("server", false, 5).is_err());
    }

    #[test]
    fn admission_requirements_reject_missing_duplicate_case_alias_and_file_parent() {
        let limits = admission_test_limits();
        assert!(admission_requirements(&[], limits).is_err());
        for paths in [vec!["docs/readme"], vec!["server/a", "server/a"],
            vec!["server/A", "server/a"], vec!["server", "server/a"], vec!["server/../a"]] {
            let requirements: Vec<_> = paths.into_iter().map(|path| AdmissionRequirement { path, kind: AdmissionKind::Regular }).collect();
            assert!(admission_requirements(&requirements, limits).is_err());
        }
        let requirements = admission_test_requirements();
        let validated = admission_requirements(&requirements, limits).unwrap();
        assert_eq!(validated.len(), 7); assert_eq!(validated["bun.lock"], AdmissionKind::Regular);
    }

    #[test]
    fn admission_preconditions_reuse_strict_images_without_claiming_archive_admission() {
        let manifest = complete_manifest(); let bytes = manifest_bytes(&manifest);
        let requirements = admission_test_requirements();
        let source = tarball(&[
            ("OpenBot-v0.0.7/docker-compose.yml", b"services: {}"),
            ("OpenBot-v0.0.7/package.json", b"{}"), ("OpenBot-v0.0.7/bun.lock", b"lock"),
            ("OpenBot-v0.0.7/server/package.json", b"{}"), ("OpenBot-v0.0.7/app/package.json", b"{}"),
            ("OpenBot-v0.0.7/worker/package.json", b"{}"), ("OpenBot-v0.0.7/tsconfig.base.json", b"{}"),
        ]);
        // Checks input caps/images/requirement syntax ONLY. This success does
        // not assert that the separate full archive reader consumed this fixture.
        let preconditions = admission_preconditions(&source, &bytes, "v0.0.7", admission_test_limits(), &requirements).unwrap();
        assert_eq!(preconditions.images.version, "v0.0.7"); assert_eq!(preconditions.requirements.len(), 7);
        assert!(admission_preconditions(b"", &bytes, "v-other", admission_test_limits(), &requirements).is_err());
        let mut bad = manifest; bad.images.insert("optional-extra".into(), Image { reference: "repo:tag".into() });
        assert!(admission_preconditions(b"", &manifest_bytes(&bad), "v0.0.7", admission_test_limits(), &requirements).is_err());
    }

    // Independent literal ustar/V7 fixture construction, not tar parser output.
    fn bundle_fixture_checksum(block: &mut [u8]) {
        block[148..156].fill(b' ');
        let sum: u32 = block.iter().map(|b| u32::from(*b)).sum();
        let value = format!("{sum:06o}\0 ");
        block[148..156].copy_from_slice(value.as_bytes());
    }
    fn bundle_fixture_member(name: &str, flag: u8, body: &[u8], ustar: bool) -> Vec<u8> {
        assert!(name.len() < 100);
        let mut block = [0u8; 512]; block[..name.len()].copy_from_slice(name.as_bytes());
        block[100..108].copy_from_slice(b"0000644\0"); block[108..116].copy_from_slice(b"0000000\0");
        block[116..124].copy_from_slice(b"0000000\0");
        block[124..136].copy_from_slice(format!("{:011o}\0", body.len()).as_bytes());
        block[136..148].copy_from_slice(b"00000000000\0"); block[156] = flag;
        if ustar { block[257..263].copy_from_slice(b"ustar\0"); block[263..265].copy_from_slice(b"00"); }
        bundle_fixture_checksum(&mut block);
        let mut raw = block.to_vec(); raw.extend_from_slice(body);
        raw.resize(raw.len().div_ceil(512) * 512, 0); raw
    }
    fn bundle_fixture_tar(ustar: bool) -> Vec<u8> {
        fn padded(prefix: &[u8]) -> Vec<u8> { let mut b = vec![b' '; 100]; b[..prefix.len()].copy_from_slice(prefix); b }
        let compose = padded(b"services: {}"); let json = padded(b"{\"fixture\":true}"); let lock = padded(b"lock");
        let members: [(&str, u8, &[u8]); 12] = [
            ("release/", b'5', b""), ("release/server/", b'5', b""),
            ("release/app/", b'5', b""), ("release/worker/", b'5', b""),
            ("release/docker-compose.yml", b'0', &compose), ("release/package.json", b'0', &json),
            ("release/bun.lock", b'0', &lock), ("release/server/package.json", b'0', &json),
            ("release/app/package.json", b'0', &json), ("release/worker/package.json", b'0', &json),
            ("release/tsconfig.base.json", b'0', &json), ("release/docs/readme.md", b'0', b"documentation"),
        ];
        let mut raw = Vec::new();
        for (name, flag, body) in members { raw.extend(bundle_fixture_member(name, flag, body, ustar)); }
        raw.extend_from_slice(&[0u8; 1024]); raw
    }
    fn bundle_fixture_gzip(raw: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(raw).unwrap(); encoder.finish().unwrap()
    }
    fn bundle_fixture_append(raw: &mut Vec<u8>, name: &str, flag: u8, body: &[u8]) {
        raw.truncate(raw.len() - 1024);
        raw.extend(bundle_fixture_member(name, flag, body, false)); raw.extend_from_slice(&[0u8; 1024]);
    }
    fn bundle_fixture_error(raw: &[u8]) -> String {
        let compressed = bundle_fixture_gzip(raw); let images = manifest_bytes(&complete_manifest());
        admit_release_bundle(&compressed, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap_err()
    }

    #[test]
    fn bundle_admits_full_v7_and_ustar_and_returns_exact_selected_bytes_and_inventory() {
        for ustar in [false, true] {
            let raw = bundle_fixture_tar(ustar); let source = bundle_fixture_gzip(&raw);
            let images = manifest_bytes(&complete_manifest());
            let bundle = admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap();
            assert_eq!(bundle.version, "v0.0.7"); assert_eq!(bundle.wrapper, "release");
            assert_eq!(bundle.images.version, "v0.0.7"); assert_eq!(bundle.files.len(), 7);
            assert_eq!(bundle.files["docker-compose.yml"].len(), 100);
            assert!(bundle.files["docker-compose.yml"].starts_with(b"services: {}"));
            assert!(bundle.files["server/package.json"].starts_with(b"{\"fixture\":true}"));
            assert_eq!(bundle.directories, ["app", "server", "worker"]);
            assert_eq!(bundle.inventory.len(), 12); assert_eq!(bundle.selected.len(), 10); assert_eq!(bundle.excluded.len(), 2);
            assert!(bundle.excluded.contains(&"release/docs/readme.md".to_string()));
            assert!(!bundle.files.contains_key("docs/readme.md"));
            assert_eq!(bundle.tar_bytes, raw.len()); assert_eq!(bundle.payload_bytes, 7 * 100 + 13);
            let doc = bundle.inventory.iter().find(|e| e.archive_path == "release/docs/readme.md").unwrap();
            assert_eq!(doc.bytes, 13); assert!(!doc.selected);
        }
    }

    #[test]
    fn bundle_preserves_raw_nul_or_zero_regular_flag_and_ustar_prefix_name_binding() {
        let mut raw = bundle_fixture_tar(false); raw[2048 + 156] = 0; bundle_fixture_checksum(&mut raw[2048..2560]);
        let compressed = bundle_fixture_gzip(&raw); let images = manifest_bytes(&complete_manifest());
        assert!(admit_release_bundle(&compressed, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).is_ok());
        let mut raw = bundle_fixture_tar(true);
        raw[2048..2148].fill(0); raw[2048..2048 + 18].copy_from_slice(b"docker-compose.yml");
        raw[2048 + 345..2048 + 500].fill(0); raw[2048 + 345..2048 + 352].copy_from_slice(b"release");
        bundle_fixture_checksum(&mut raw[2048..2560]);
        let compressed = bundle_fixture_gzip(&raw);
        let bundle = admit_release_bundle(&compressed, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap();
        assert!(bundle.files.contains_key("docker-compose.yml"));
        raw[2048 + 345 + 8] = b'X'; bundle_fixture_checksum(&mut raw[2048..2560]);
        assert!(bundle_fixture_error(&raw).contains("hidden bytes after NUL"));
    }

    #[test]
    fn bundle_refuses_raw_gnu_pax_sparse_links_special_unknown_and_gnu_regular_headers() {
        for flag in [b'L', b'K', b'x', b'g', b'S', b'1', b'2', b'3', b'4', b'6', b'7', b'Z'] {
            let mut raw = bundle_fixture_tar(false); raw[2048 + 156] = flag;
            bundle_fixture_checksum(&mut raw[2048..2560]);
            assert!(bundle_fixture_error(&raw).contains("raw typeflag"), "{flag}");
            let mut raw = bundle_fixture_tar(false);
            bundle_fixture_append(&mut raw, "release/docs/excluded", flag, b"extension");
            assert!(bundle_fixture_error(&raw).contains("raw typeflag"), "excluded {flag}");
        }
        let mut raw = bundle_fixture_tar(false); raw[2048 + 257..2048 + 263].copy_from_slice(b"ustar ");
        raw[2048 + 263..2048 + 265].copy_from_slice(b" \0"); bundle_fixture_checksum(&mut raw[2048..2560]);
        assert!(bundle_fixture_error(&raw).contains("GNU or unknown header format"));
    }

    #[test]
    fn bundle_refuses_checksum_corruption_and_valid_checksum_short_declared_payload() {
        let mut raw = bundle_fixture_tar(false); raw[2048 + 100] = b'1';
        assert!(bundle_fixture_error(&raw).contains("checksum mismatch"));
        let mut raw = bundle_fixture_tar(false); let declared = raw.len() + 512;
        raw[2048 + 124..2048 + 136].copy_from_slice(format!("{declared:011o}\0").as_bytes());
        bundle_fixture_checksum(&mut raw[2048..2560]);
        let compressed = bundle_fixture_gzip(&raw); let images = manifest_bytes(&complete_manifest()); let mut limits = admission_test_limits();
        limits.max_entry_bytes = 20000;
        let error = admit_release_bundle(&compressed, &images, "v0.0.7", limits, &admission_test_requirements()).unwrap_err();
        assert!(error.contains("short"));
    }

    #[test]
    fn bundle_requires_zero_payload_padding_two_footer_blocks_and_zero_aligned_remainder() {
        let raw = bundle_fixture_tar(false);
        let mut bad = raw.clone(); bad[2048 + 512 + 100] = 1;
        assert!(bundle_fixture_error(&bad).contains("nonzero payload padding"));
        let mut bad = raw.clone(); bad.truncate(bad.len() - 1024);
        assert!(bundle_fixture_error(&bad).contains("no complete footer"));
        let mut bad = raw.clone(); bad.truncate(bad.len() - 512);
        assert!(bundle_fixture_error(&bad).contains("two zero footer"));
        let mut bad = raw.clone(); let hidden = bad.len() - 512; bad[hidden..].copy_from_slice(&raw[..512]);
        assert!(bundle_fixture_error(&bad).contains("two zero footer"));
        let mut bad = raw.clone(); bad.push(0); assert!(bundle_fixture_error(&bad).contains("unaligned"));
        let mut bad = raw.clone(); bad.extend_from_slice(&[1u8; 512]); assert!(bundle_fixture_error(&bad).contains("zero tar remainder"));
        let mut allowed = raw; allowed.extend_from_slice(&[0u8; 512]);
        let source = bundle_fixture_gzip(&allowed); let images = manifest_bytes(&complete_manifest());
        assert!(admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).is_ok());
    }

    #[test]
    fn bundle_rejects_gzip_crc_isize_truncated_deflate_and_footer_without_later_eof_success() {
        let raw = bundle_fixture_tar(false); let source = bundle_fixture_gzip(&raw); let images = manifest_bytes(&complete_manifest());
        for footer_index in [source.len() - 8, source.len() - 4] {
            let mut bad = source.clone(); bad[footer_index] ^= 1;
            let error = admit_release_bundle(&bad, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap_err();
            assert!(error.contains("gzip body/footer/CRC/ISIZE"));
        }
        for length in [10, source.len() / 2, source.len() - 8, source.len() - 3] {
            let error = admit_release_bundle(&source[..length], &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap_err();
            assert!(error.contains("gzip body/footer/CRC/ISIZE"));
        }
        assert!(admit_release_bundle(b"not gzip", &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).is_err());
    }

    #[test]
    fn bundle_rejects_second_valid_gzip_member_and_every_nonempty_compressed_trailer() {
        let source = bundle_fixture_gzip(&bundle_fixture_tar(false)); let images = manifest_bytes(&complete_manifest());
        let mut doubled = source.clone(); doubled.extend_from_slice(&source);
        assert!(admit_release_bundle(&doubled, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap_err().contains("second gzip member"));
        for tail in [b"\0".as_slice(), b"junk", b"\x1f\x8b"] {
            let mut bad = source.clone(); bad.extend_from_slice(tail);
            assert!(admit_release_bundle(&bad, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap_err().contains("compressed trailing"));
        }
    }

    #[test]
    fn bundle_caps_accept_exact_fixture_boundaries_and_reject_each_one_byte_or_entry_excess() {
        let raw = bundle_fixture_tar(false); let source = bundle_fixture_gzip(&raw); let images = manifest_bytes(&complete_manifest());
        let limits = AdmissionLimits { max_entries: 12, max_total_uncompressed: 7 * 100 + 13,
            max_tar_bytes: raw.len(), max_entry_bytes: 100, max_path_bytes: "release/server/package.json".len(),
            max_source_bytes: source.len(), max_images_bytes: images.len() };
        assert!(admit_release_bundle(&source, &images, "v0.0.7", limits, &admission_test_requirements()).is_ok());
        for index in 0..7 {
            let mut small = limits;
            match index { 0 => small.max_entries -= 1, 1 => small.max_total_uncompressed -= 1,
                2 => small.max_tar_bytes -= 1, 3 => small.max_entry_bytes -= 1,
                4 => small.max_path_bytes -= 1, 5 => small.max_source_bytes -= 1, _ => small.max_images_bytes -= 1 }
            assert!(admit_release_bundle(&source, &images, "v0.0.7", small, &admission_test_requirements()).is_err(), "limit {index}");
        }
        let mut budget = AdmissionBudget::new(limits).unwrap(); budget.read_tar(raw.len()).unwrap();
        assert!(budget.read_tar(1).is_err()); assert_eq!(budget.tar, raw.len());
        budget.tar = usize::MAX - 1; assert!(budget.read_tar(2).is_err()); assert_eq!(budget.tar, usize::MAX - 1);
    }

    #[test]
    fn bundle_audits_all_paths_including_excluded_and_refuses_wrappers_aliases_and_collisions() {
        for name in ["/release/docs/a", "C:/release/docs/a", "release/docs\\a", "release/docs/../a", "release/docs//a",
            "release/docs/./a", "release/docs/a.", "release/docs/a ", "release/docs/CON.txt", "release/docs/é", "release/docs/a:b"] {
            let mut raw = bundle_fixture_tar(false); bundle_fixture_append(&mut raw, name, b'0', b"excluded");
            assert!(bundle_fixture_error(&raw).starts_with("admission"), "{name:?}");
        }
        for (name, flag) in [("other/docs/a", b'0'), ("release/server/", b'5'), ("release/package.json", b'0'), ("release/APP/a", b'0')] {
            let mut raw = bundle_fixture_tar(false); bundle_fixture_append(&mut raw, name, flag, b"");
            assert!(bundle_fixture_error(&raw).starts_with("admission"), "{name}");
        }
        for child_first in [false, true] {
            let mut raw = bundle_fixture_tar(false);
            let paths = if child_first { ["release/docs/p/a", "release/docs/p"] } else { ["release/docs/p", "release/docs/p/a"] };
            for name in paths { bundle_fixture_append(&mut raw, name, b'0', b""); }
            assert!(bundle_fixture_error(&raw).contains("file-parent conflict"));
        }
    }

    #[test]
    fn bundle_requires_actual_requirement_hits_and_exact_kinds_not_only_valid_requirement_syntax() {
        let source = bundle_fixture_gzip(&bundle_fixture_tar(false)); let images = manifest_bytes(&complete_manifest());
        let mut requirements = admission_test_requirements(); requirements.push(AdmissionRequirement { path: "server/missing.json", kind: AdmissionKind::Regular });
        assert!(admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &requirements).unwrap_err().contains("required archive entry"));
        let mut requirements = admission_test_requirements(); requirements[4].kind = AdmissionKind::Directory;
        assert!(admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &requirements).unwrap_err().contains("wrong kind"));
        assert!(admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &[]).is_err());
        assert!(admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &[AdmissionRequirement { path: "docs/a", kind: AdmissionKind::Regular }]).is_err());
    }

    #[test]
    fn bundle_reuses_f1_exact_version_and_all_published_reference_rules() {
        let source = bundle_fixture_gzip(&bundle_fixture_tar(false)); let manifest = complete_manifest();
        assert!(admit_release_bundle(&source, &manifest_bytes(&manifest), "v-other", admission_test_limits(), &admission_test_requirements()).is_err());
        let mut bad = manifest.clone(); bad.images.insert("optional".into(), Image { reference: "repo:tag".into() });
        assert!(admit_release_bundle(&source, &manifest_bytes(&bad), "v0.0.7", admission_test_limits(), &admission_test_requirements()).is_err());
        let mut good = manifest; good.images.insert("optional".into(), Image { reference: format!("REGISTRY/team/repo:tag@sha256:{}", "a".repeat(64)) });
        let bundle = admit_release_bundle(&source, &manifest_bytes(&good), "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap();
        assert_eq!(bundle.images, good); assert_eq!(bundle.version, "v0.0.7");
    }

    #[test]
    fn bundle_reconciles_raw_iterator_against_independent_physical_records() {
        let raw = bundle_fixture_tar(false); let physical = admission_physical_tar(&raw, admission_test_limits()).unwrap();
        assert_eq!(physical.entries.len(), 12); assert_eq!(physical.entries[4].header_offset, 2048);
        assert_eq!(physical.entries[4].file_offset, 2560); assert_eq!(physical.entries[4].size, 100);
        let mut archive = tar::Archive::new(raw.as_slice());
        let mut entries = archive.entries().unwrap().raw(true);
        for expected in physical.entries {
            let entry = entries.next().unwrap().unwrap();
            assert_eq!(entry.raw_header_position(), expected.header_offset as u64);
            assert_eq!(entry.raw_file_position(), expected.file_offset as u64);
            assert_eq!(entry.header().as_bytes()[156], expected.raw_type);
        }
        assert!(entries.next().is_none());
    }


    #[test]
    fn bundle_rejects_windows_device_stems_in_selected_and_excluded_paths_without_trimming_output() {
        let names = ["CON.txt", "con.TXT", "CON .txt", "cOn  .bin", "PRN .txt", "AUX .txt",
            "NUL .txt", "CLOCK$ .txt", "COM1 .txt", "LPT9 .txt", "CONIN$", "conout$",
            "ConIn$.txt", "conOUT$ .txt"];
        for directory in ["app", "docs"] {
            for name in names {
                let path = format!("release/{directory}/{name}");
                let mut raw = bundle_fixture_tar(false);
                bundle_fixture_append(&mut raw, &path, b'0', b"device");
                assert_eq!(bundle_fixture_error(&raw), "admission path uses a reserved Windows basename", "{path}");
            }
        }
        let mut raw = bundle_fixture_tar(false);
        bundle_fixture_append(&mut raw, "release/app/CONifer.txt", b'0', b"literal selected");
        bundle_fixture_append(&mut raw, "release/docs/CONifer.txt", b'0', b"literal excluded");
        let source = bundle_fixture_gzip(&raw); let images = manifest_bytes(&complete_manifest());
        let bundle = admit_release_bundle(&source, &images, "v0.0.7", admission_test_limits(), &admission_test_requirements()).unwrap();
        assert_eq!(bundle.files["app/CONifer.txt"], b"literal selected");
        assert!(bundle.excluded.contains(&"release/docs/CONifer.txt".to_string()));
        assert_eq!(admission_path("app/CONifer .txt", false, 1024).unwrap(), "app/CONifer .txt");
    }

    struct AdmissionRecordingReader<'a> {
        bytes: &'a [u8], position: usize, short: usize, fail_at_end: bool, requests: Vec<usize>,
    }
    impl std::io::Read for AdmissionRecordingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.requests.push(buffer.len());
            if self.fail_at_end && self.position == self.bytes.len() {
                return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
            }
            let count = buffer.len().min(self.short).min(self.bytes.len() - self.position);
            buffer[..count].copy_from_slice(&self.bytes[self.position..self.position + count]);
            self.position += count; Ok(count)
        }
    }
    fn admission_three_byte_tar_budget() -> AdmissionBudget {
        let mut limits = admission_test_limits(); limits.max_entries = 1;
        limits.max_total_uncompressed = 3; limits.max_entry_bytes = 3;
        limits.max_path_bytes = 3; limits.max_tar_bytes = 3;
        AdmissionBudget::new(limits).unwrap()
    }

    #[test]
    fn decoder_read_boundary_requests_remaining_plus_one_through_short_reads_and_true_eof() {
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 1, fail_at_end: false, requests: Vec::new() };
        let mut budget = admission_three_byte_tar_budget(); let mut buffer = [0u8; 8192];
        for expected in b"abc" { assert_eq!(admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).unwrap(), 1); assert_eq!(buffer[0], *expected); }
        assert_eq!(budget.tar, 3);
        assert_eq!(admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).unwrap(), 0);
        assert_eq!(reader.requests, [4, 3, 2, 1]); assert_eq!(reader.position, 3);
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 3, fail_at_end: false, requests: Vec::new() };
        let mut budget = admission_three_byte_tar_budget(); let mut small = [0u8; 2];
        assert_eq!(admission_read_tar_chunk(&mut reader, &mut small, &mut budget).unwrap(), 2);
        assert_eq!(admission_read_tar_chunk(&mut reader, &mut small, &mut budget).unwrap(), 1);
        assert_eq!(admission_read_tar_chunk(&mut reader, &mut small, &mut budget).unwrap(), 0);
        assert_eq!(reader.requests, [2, 2, 1]);
    }

    #[test]
    fn decoder_read_boundary_rejects_extra_byte_and_end_error_without_artificial_eof_or_budget_advance() {
        let mut reader = AdmissionRecordingReader { bytes: b"abcd", position: 0, short: 1, fail_at_end: false, requests: Vec::new() };
        let mut budget = admission_three_byte_tar_budget(); let mut buffer = [0u8; 8192];
        for _ in 0..3 { assert_eq!(admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).unwrap(), 1); }
        assert!(admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).is_err());
        assert_eq!(reader.requests, [4, 3, 2, 1]); assert_eq!(reader.position, 4); assert_eq!(budget.tar, 3);
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 1, fail_at_end: true, requests: Vec::new() };
        let mut budget = admission_three_byte_tar_budget();
        for _ in 0..3 { admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).unwrap(); }
        assert_eq!(admission_read_tar_chunk(&mut reader, &mut buffer, &mut budget).unwrap_err(), "admission gzip body/footer/CRC/ISIZE error");
        assert_eq!(reader.requests, [4, 3, 2, 1]); assert_eq!(budget.tar, 3);
        assert!(admission_read_tar_chunk(&mut reader, &mut [], &mut budget).is_err());
        assert_eq!(reader.requests, [4, 3, 2, 1]);
    }
    #[test]
    fn staged_response_read_is_bounded_and_status_or_first_error_never_becomes_eof() {
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 1, fail_at_end: false, requests: Vec::new() };
        assert_eq!(stage_response_body(true, &mut reader, 3, &mut || Ok(())).unwrap(), b"abc");
        assert_eq!(reader.requests, [4, 3, 2, 1]);
        let mut reader = AdmissionRecordingReader { bytes: b"abcd", position: 0, short: 1, fail_at_end: false, requests: Vec::new() };
        assert_eq!(stage_read_bounded(&mut reader, 3, &mut || Ok(())).unwrap_err(), "STAGE_READ_LIMIT");
        assert_eq!(reader.requests, [4, 3, 2, 1]);
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 1, fail_at_end: true, requests: Vec::new() };
        assert_eq!(stage_read_bounded(&mut reader, 3, &mut || Ok(())).unwrap_err(), "STAGE_READ_ERROR");
        assert_eq!(reader.requests, [4, 3, 2, 1]);
        let mut reader = AdmissionRecordingReader { bytes: b"abc", position: 0, short: 1, fail_at_end: false, requests: Vec::new() };
        assert_eq!(stage_response_body(false, &mut reader, 3, &mut || Ok(())).unwrap_err(), "STAGE_HTTP_STATUS");
        assert!(reader.requests.is_empty());
        assert_eq!(stage_read_bounded(&mut reader, 3, &mut || Err("cancelled".into())).unwrap_err(), "cancelled");
        assert!(reader.requests.is_empty());
    }

    #[test]
    fn stage_policy_and_binary_seal_have_explicit_frozen_limits_and_independent_layout() {
        let limits = stage_limits(); limits.validate().unwrap();
        assert_eq!((limits.max_entries, limits.max_total_uncompressed, limits.max_tar_bytes), (20000, 96*1024*1024, 128*1024*1024));
        assert_eq!((limits.max_entry_bytes, limits.max_path_bytes, limits.max_source_bytes, limits.max_images_bytes), (16*1024*1024,512,32*1024*1024,2*1024*1024));
        assert_eq!(stage_requirements().len(), 10);
        let abc = [0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
            0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad];
        assert_eq!(stage_sha(b"abc"), abc);
        let records = [StageRecord { path: "app".into(), kind: 2, size: 0, hash: [0;32] },
            StageRecord { path: "app/a".into(), kind: 1, size: 3, hash: abc }];
        let mut expected = b"openbot.release-stage.v1\0".to_vec();
        expected.extend_from_slice(&[0,0,0,1, 0,0,0,6]); expected.extend_from_slice(b"v1.2.3"); expected.extend_from_slice(&[0,0,0,2]);
        expected.extend_from_slice(&[2,0,0,0,3]); expected.extend_from_slice(b"app"); expected.extend_from_slice(&[0;40]);
        expected.extend_from_slice(&[1,0,0,0,5]); expected.extend_from_slice(b"app/a"); expected.extend_from_slice(&3u64.to_be_bytes()); expected.extend_from_slice(&abc);
        expected.extend_from_slice(&[1;32]); expected.extend_from_slice(&[2;32]);
        let digest = stage_sha(&expected); expected.extend_from_slice(&digest);
        assert_eq!(stage_seal("v1.2.3", &records, [1;32], [2;32]).unwrap(), expected);
        assert!(stage_seal("v1.2.3", &[records[1].clone(),records[0].clone()],[1;32],[2;32]).is_err());
        assert!(stage_seal("bad version", &records,[1;32],[2;32]).is_err());
    }

    #[test]
    fn context_free_fetch_refuses_without_any_live_creation() {
        let root = scratch("f4b-context-free").join("absent");
        assert_eq!(fetch(&root, "v0.0.7").unwrap_err(), "PUBLICATION_UNAVAILABLE: UNVERIFIED_PUBLICATION_CONTEXT");
        assert!(!root.exists()); std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_native_context_refuses_without_creating_stage_or_live_paths() {
        let base = scratch("f4b-unsupported"); let live = base.join("live"); let config = base.join("config");
        assert!(prepare_stage_context(&live,&config,&config.join("release-staging-v1")).is_err());
        assert!(!live.exists()); assert!(!config.exists()); std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    fn staging_fixture(label: &str) -> (PathBuf, PathBuf, StageContext, Vec<u8>, Vec<u8>, AdmittedBundle) {
        use std::os::unix::fs::DirBuilderExt;
        let base = scratch(label); let live = base.join("live"); let config = base.join("config");
        std::fs::DirBuilder::new().mode(0o700).create(&live).unwrap();
        std::fs::create_dir(live.join(".secrets")).unwrap();
        std::fs::write(live.join(".secrets/KEY_ENCRYPTION_KEY.secret"), b"synthetic-preserve").unwrap();
        std::fs::write(live.join(".openbot-deployment"), b"old-synthetic-pin").unwrap();
        std::fs::DirBuilder::new().mode(0o700).create(&config).unwrap();
        let context = prepare_stage_context(&live,&config,&config.join("release-staging-v1")).unwrap();
        let source = bundle_fixture_gzip(&bundle_fixture_tar(false)); let images = manifest_bytes(&complete_manifest());
        let bundle = admit_release_bundle(&source,&images,"v0.0.7",stage_limits(),&stage_requirements()).unwrap();
        (base,live,context,source,images,bundle)
    }
    #[cfg(unix)]
    fn staging_ids(stage: &Path, records: &[StageRecord]) -> BTreeMap<String, StageIdentity> {
        records.iter().map(|r|(r.path.clone(),stage_identity(&std::fs::symlink_metadata(stage.join(&r.path)).unwrap()))).collect()
    }

    #[cfg(unix)]
    #[test]
    fn staging_constructor_rejects_overlap_redirects_and_unknown_owner_or_unsafe_modes() {
        use std::os::unix::fs::symlink;
        let base = scratch("f4b-constructor"); let config = base.join("config");
        assert_eq!(prepare_stage_context(&base.join("live"),&config,&config.join("release-staging-v1")).err().unwrap(),"STAGE_APP_CONFIG_MISSING");
        assert!(!config.exists());
        std::fs::create_dir(&config).unwrap();
        assert!(prepare_stage_context(&config,&config,&config.join("release-staging-v1")).is_err());
        let outside = base.join("outside");std::fs::create_dir(&outside).unwrap();symlink(&outside,config.join("release-staging-v1")).unwrap();
        assert!(prepare_stage_context(&base.join("live"),&config,&config.join("release-staging-v1")).is_err());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        assert!(stage_owner_mode(1001,1000,0o700,true,false).is_err());
        assert!(stage_owner_mode(0,1000,0o755,false,false).is_err());
        assert!(stage_owner_mode(1000,1000,0o777,true,false).is_err());
        assert!(stage_owner_mode(1000,1000,0o700,true,false).is_ok());
        assert!(stage_owner_mode(0,1000,0o1777,false,true).is_ok());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn actual_stage_admission_and_sealing_never_returns_install_success_or_changes_live_root() {
        let (base,live,context,source,images,_) = staging_fixture("f4b-full-stage");
        assert!(stage_received(&context,"v0.0.7",&source,&images,&mut || Ok(())).unwrap_err().starts_with(PUBLICATION_UNAVAILABLE));
        let entries:Vec<_>=std::fs::read_dir(&context.parent_path).unwrap().collect();assert_eq!(entries.len(),1);
        let stage=entries[0].as_ref().unwrap().path();assert!(stage.join("stage.seal").is_file());assert!(stage.join(".attempt.lock").is_file());
        assert_eq!(std::fs::read(stage.join(IMAGES)).unwrap(), images);
        assert_eq!(std::fs::read(live.join(".secrets/KEY_ENCRYPTION_KEY.secret")).unwrap(),b"synthetic-preserve");
        assert_eq!(std::fs::read(live.join(".openbot-deployment")).unwrap(),b"old-synthetic-pin");
        assert!(!live.join("docker-compose.yml").exists());assert!(!live.join(".openbot-prepared.json").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn admission_failure_and_cancel_create_no_attempt_and_collision_never_overwrites_retained_stage() {
        let (base,_,context,_,images,bundle)=staging_fixture("f4b-no-write");
        assert!(stage_received(&context,"v0.0.7",b"not gzip",&images,&mut || Ok(())).is_err());
        assert!(!context.parent_path.exists());
        let name="stage-00000000000000000000000000000000";
        assert!(stage_bundle(&context,&bundle,[1;32],&images,&mut || Err("cancelled".into()),name).is_err());
        assert!(!context.parent_path.exists());
        let stage=stage_bundle(&context,&bundle,[1;32],&images,&mut || Ok(()),name).unwrap();let seal=std::fs::read(stage.join("stage.seal")).unwrap();
        assert!(stage_bundle(&context,&bundle,[1;32],&images,&mut || Ok(()),name).is_err());
        assert_eq!(std::fs::read(stage.join("stage.seal")).unwrap(),seal);std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn staged_reopen_detects_hash_changes_extra_members_and_changed_file_identity() {
        let (base,_,context,_,images,bundle)=staging_fixture("f4b-reopen");
        let stage=stage_bundle(&context,&bundle,[1;32],&images,&mut || Ok(()),"stage-00000000000000000000000000000001").unwrap();
        let records=stage_records(&bundle,&images).unwrap();let ids=staging_ids(&stage,&records);
        std::fs::write(stage.join("package.json"),vec![b'x';100]).unwrap();
        assert_eq!(stage_verify_inventory(&stage,&records,&ids,true,&mut || Ok(())).unwrap_err(),"STAGE_REOPEN_HASH");
        std::fs::write(stage.join("package.json"),&bundle.files["package.json"]).unwrap();
        std::fs::write(stage.join("unexpected"),b"extra").unwrap();
        assert_eq!(stage_verify_inventory(&stage,&records,&ids,true,&mut || Ok(())).unwrap_err(),"STAGE_EXTRA_ENTRY");
        std::fs::remove_file(stage.join("unexpected")).unwrap();
        std::fs::rename(stage.join("package.json"),stage.join("retained-original")).unwrap();
        stage_write_file(&stage.join("package.json"),&bundle.files["package.json"]).unwrap();
        assert_eq!(stage_reopen(&stage.join("package.json"),ids["package.json"],100,&mut || Ok(())).unwrap_err(),"STAGE_REOPEN_IDENTITY");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn actual_file_write_failure_and_coordinator_directory_sync_failure_retain_evidence() {
        use std::io::Write;
        let (base,live,context,_,images,bundle)=staging_fixture("f4b-faults");let partial=base.join("partial");
        let error=stage_write_file_with(&partial,b"abcdef",|file,bytes| {file.write_all(&bytes[..2]).unwrap();Err("injected-write".into())}).unwrap_err();
        assert_eq!(error,"injected-write");assert_eq!(std::fs::read(&partial).unwrap(),b"ab");
        let name="stage-00000000000000000000000000000002";let mut syncs=0;
        assert_eq!(stage_bundle_with_sync(&context,&bundle,[1;32],&images,&mut || Ok(()),name,&mut |_| {syncs+=1;Err("injected-directory-sync".into())}).unwrap_err(),"injected-directory-sync");
        assert_eq!(syncs,1);let retained=context.parent_path.join(name);assert!(retained.join("package.json").is_file());assert!(!retained.join("stage.seal").exists());
        assert_eq!(std::fs::read(live.join(".openbot-deployment")).unwrap(),b"old-synthetic-pin");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn coordinator_cancellation_at_every_observed_checkpoint_retains_only_own_attempts() {
        let (base,live,context,_,images,bundle)=staging_fixture("f4b-all-cancel"); let mut total=0;
        stage_bundle(&context,&bundle,[1;32],&images,&mut || {total+=1;Ok(())},"stage-ffffffffffffffffffffffffffffffff").unwrap();
        assert!(total>10);
        for stop_at in 1..=total {
            let name=format!("stage-{stop_at:032x}");let mut calls=0;
            let result=stage_bundle(&context,&bundle,[1;32],&images,&mut || {calls+=1;if calls==stop_at {Err("cancelled-at-boundary".into())}else{Ok(())}},&name);
            assert_eq!(result.unwrap_err(),"cancelled-at-boundary");assert_eq!(calls,stop_at);
            assert_eq!(std::fs::read(live.join(".openbot-deployment")).unwrap(),b"old-synthetic-pin");
            if stop_at==1 {assert!(!context.parent_path.join(&name).exists());}
            else {assert!(context.parent_path.join(&name).is_dir());}
        }
        std::fs::remove_dir_all(base).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn changed_context_parent_is_rejected_by_real_fetch_before_transport() {
        use std::os::unix::fs::DirBuilderExt;
        let (base,live,context,_,images,bundle)=staging_fixture("f4b-changed-context");
        stage_bundle(&context,&bundle,[1;32],&images,&mut || Ok(()),"stage-00000000000000000000000000000003").unwrap();
        let retained=base.join("retained-stage-parent");
        std::fs::rename(&context.parent_path,&retained).unwrap();
        std::fs::DirBuilder::new().mode(0o700).create(&context.parent_path).unwrap();
        assert_eq!(fetch_staged(&context,"v0.0.7",||Ok(())).unwrap_err(),"STAGE_CONTEXT_CHANGED");
        assert_eq!(std::fs::read_dir(&retained).unwrap().count(),1);
        assert_eq!(std::fs::read(live.join(".openbot-deployment")).unwrap(),b"old-synthetic-pin");std::fs::remove_dir_all(base).unwrap();
    }
}
