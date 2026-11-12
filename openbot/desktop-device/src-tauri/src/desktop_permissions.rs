//! What the 「桌面操作」 card shows: whether this computer lets the device app read and operate other
//! programs' windows (plan docs/plans/2026-11-12-desktop-write.md, Task 11).
//!
//! The answer is agent-desktop's, the same helper the runner drives: `permissions` on macOS, `status`
//! on Linux (which nests the same states under `permissions`, and says `denied` for accessibility when
//! there is no AT-SPI bus). Windows needs no grant, so nothing is run there.

use serde::Serialize;
use std::ffi::OsString;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

/// How long agent-desktop is given to answer before the card says it did not.
pub const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PermState {
    Granted,
    Denied,
    NotRequired,
    Unknown,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPermissionView {
    pub platform: &'static str,
    pub accessibility: PermState,
    pub screen_recording: PermState,
    /// Linux only: whether the accessibility bus answers. None elsewhere, or when it is not known.
    pub at_spi: Option<bool>,
}

impl PermState {
    fn from_word(word: Option<&str>) -> PermState {
        match word {
            Some("granted") => PermState::Granted,
            Some("denied") => PermState::Denied,
            Some("not_required") => PermState::NotRequired,
            _ => PermState::Unknown,
        }
    }
}

/// The accessibility and screen-recording states in agent-desktop's `permissions` envelope (or its
/// `status` envelope, which nests them under `permissions`). None when it is not one that worked.
pub fn parse_permissions(json: &str) -> Option<(PermState, PermState)> {
    let envelope: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    if envelope["ok"] != serde_json::Value::Bool(true) {
        return None;
    }
    let data = &envelope["data"];
    let states = if data["permissions"].is_object() {
        &data["permissions"]
    } else {
        data
    };
    let accessibility = states["accessibility"]["state"].as_str()?;
    Some((
        PermState::from_word(Some(accessibility)),
        PermState::from_word(states["screen_recording"]["state"].as_str()),
    ))
}

/// The System Settings pane for one of the two macOS grants.
pub fn settings_url(kind: &str) -> Option<&'static str> {
    match kind {
        "accessibility" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        "screen" => {
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
        _ => None,
    }
}

/// The agent-desktop command whose answer the card reads on `platform`. None: nothing to ask.
pub fn command_for(platform: &str) -> Option<&'static str> {
    match platform {
        "macos" => Some("permissions"),
        "linux" => Some("status"),
        _ => None,
    }
}

/// The card's view for `platform` (`std::env::consts::OS`), from what agent-desktop printed.
pub fn view_for(platform: &'static str, reply: &str) -> Result<DesktopPermissionView, String> {
    if command_for(platform).is_none() {
        return Ok(DesktopPermissionView {
            platform,
            accessibility: PermState::NotRequired,
            screen_recording: PermState::NotRequired,
            at_spi: None,
        });
    }
    let (accessibility, screen_recording) =
        parse_permissions(reply).ok_or_else(|| "桌面助手没有给出权限状态。".to_string())?;
    let at_spi = match (platform, accessibility) {
        ("linux", PermState::Granted) => Some(true),
        ("linux", PermState::Denied) => Some(false),
        _ => None,
    };
    Ok(DesktopPermissionView {
        platform,
        accessibility,
        screen_recording,
        at_spi,
    })
}

/// The environment agent-desktop is given, besides `AGENT_DESKTOP_HOME`: the runner's own list
/// (`ENV_KEEP` in `runner/src/desktop/agent-desktop.ts`). Nothing else of this app's environment.
pub const ENV_KEEP: [&str; 17] = [
    "PATH",
    "HOME",
    "USER",
    "USERPROFILE",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];

/// The child's whole environment: the allow-listed keys `get` has a value for, then
/// `AGENT_DESKTOP_HOME` set to `home`.
pub fn child_env(get: &dyn Fn(&str) -> Option<OsString>, home: &Path) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = ENV_KEEP
        .iter()
        .filter_map(|key| get(key).map(|value| (OsString::from(key), value)))
        .collect();
    env.push(("AGENT_DESKTOP_HOME".into(), home.as_os_str().to_owned()));
    env
}

/// Make `home` an empty directory only this user can open: whatever an earlier probe left in it is
/// removed first. It is the probe's own, never the runner's `agent-desktop-state`.
pub fn fresh_home(home: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(home) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(home)?,
        Ok(_) => std::fs::remove_file(home)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(parent) = home.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(home)
}

/// One probe at a time: they share the home directory each one empties first.
static PROBE: Mutex<()> = Mutex::new(());

/// Run `program args` with an emptied private `home` and only the allow-listed environment, and
/// return what it printed, or why not, within `timeout`. A helper that has not answered by then is
/// killed.
pub fn run(
    program: &Path,
    args: &[&str],
    home: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let _one = PROBE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    fresh_home(home).map_err(|error| format!("无法准备桌面助手的目录：{error}"))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .env_clear()
        .envs(child_env(&|key| std::env::var_os(key), home))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动桌面助手：{error}"))?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = send.send(text);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "桌面助手 {} 秒内没有回答。",
                    timeout.as_secs_f64().ceil() as u64
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("桌面助手出错：{error}"));
            }
        }
    }
    // It has exited; whatever it printed is in the pipe, unless something it started holds it open.
    receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "桌面助手没有回答。".to_string())
}

/// The window is brought up for a `permission-needed` at most this often.
pub const RAISE_EVERY: Duration = Duration::from_secs(60);

/// What a `permission-needed` from the runner does to the window.
#[derive(Debug, PartialEq, Eq)]
pub enum Reaction {
    /// The window is on screen: refresh the card and scroll to it, without taking the focus.
    Scroll,
    /// Show and raise the window at the card.
    Raise,
    /// Raised less than `RAISE_EVERY` ago: leave the person alone.
    Nothing,
}

/// `visible`: the window is shown and not minimized. `last`: when it was last raised for this.
pub fn react(visible: bool, last: Option<Instant>, now: Instant) -> Reaction {
    if visible {
        Reaction::Scroll
    } else if last.map_or(true, |last| {
        now.saturating_duration_since(last) >= RAISE_EVERY
    }) {
        Reaction::Raise
    } else {
        Reaction::Nothing
    }
}

/// Leave a note that the next start should show the window, even one started at login: a restart
/// from the card re-runs this process with its original arguments, `--autostart` included.
pub fn mark_show_once(marker: &Path) -> io::Result<()> {
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(marker, b"")
}

/// Whether the note was there; it is removed, so it counts for one start only.
pub fn take_show_once(marker: &Path) -> bool {
    std::fs::remove_file(marker).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MACOS: &str = include_str!("../../../runner/tests/fixtures/agent-desktop/macos.json");
    const LINUX: &str = include_str!("../../../runner/tests/fixtures/agent-desktop/linux.json");

    fn sample(file: &str, key: &str) -> String {
        let all: serde_json::Value = serde_json::from_str(file).unwrap();
        all[key].to_string()
    }

    /// The Linux `status` answer without a session bus (FACTS (k)): still `ok`, accessibility denied.
    fn linux_without_bus() -> String {
        let mut status: serde_json::Value = serde_json::from_str(&sample(LINUX, "status")).unwrap();
        status["data"]["permissions"]["accessibility"]["state"] = "denied".into();
        status["data"]["supported_surfaces"] = serde_json::json!([]);
        status.to_string()
    }

    #[test]
    fn parse_permissions_reads_the_two_states() {
        let permissions = sample(MACOS, "permissions");
        assert_eq!(
            parse_permissions(&permissions),
            Some((PermState::Granted, PermState::Granted))
        );

        let mut denied: serde_json::Value = serde_json::from_str(&permissions).unwrap();
        denied["data"]["accessibility"]["state"] = "denied".into();
        denied["data"]["screen_recording"]["state"] = "something new".into();
        assert_eq!(
            parse_permissions(&denied.to_string()),
            Some((PermState::Denied, PermState::Unknown))
        );

        // `status` nests the same states under `permissions`.
        assert_eq!(
            parse_permissions(&sample(LINUX, "status")),
            Some((PermState::Granted, PermState::NotRequired))
        );
        assert_eq!(
            parse_permissions(&linux_without_bus()),
            Some((PermState::Denied, PermState::NotRequired))
        );

        // Not an answer that worked: nothing is made up.
        let mut failed: serde_json::Value = serde_json::from_str(&permissions).unwrap();
        failed["ok"] = false.into();
        assert_eq!(parse_permissions(&failed.to_string()), None);
        assert_eq!(parse_permissions("not json"), None);
        assert_eq!(parse_permissions("{\"ok\":true,\"data\":{}}"), None);
    }

    #[test]
    fn settings_urls_are_the_two_privacy_panes() {
        assert_eq!(
            settings_url("accessibility"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        );
        assert_eq!(
            settings_url("screen"),
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        );
        assert_eq!(settings_url("automation"), None);
        assert_eq!(settings_url("x-apple.systempreferences:anything"), None);
        assert_eq!(settings_url(""), None);
    }

    #[test]
    fn each_platform_s_view() {
        assert_eq!(
            view_for("macos", &sample(MACOS, "permissions")),
            Ok(DesktopPermissionView {
                platform: "macos",
                accessibility: PermState::Granted,
                screen_recording: PermState::Granted,
                at_spi: None,
            })
        );
        assert!(view_for("macos", "garbage").is_err());

        let linux = view_for("linux", &sample(LINUX, "status")).unwrap();
        assert_eq!(linux.at_spi, Some(true));
        let linux = view_for("linux", &linux_without_bus()).unwrap();
        assert_eq!(linux.at_spi, Some(false));
        assert_eq!(linux.accessibility, PermState::Denied);

        assert_eq!(
            view_for("windows", ""),
            Ok(DesktopPermissionView {
                platform: "windows",
                accessibility: PermState::NotRequired,
                screen_recording: PermState::NotRequired,
                at_spi: None,
            })
        );

        let json = serde_json::to_value(view_for("linux", &linux_without_bus()).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "platform": "linux",
                "accessibility": "denied",
                "screenRecording": "not_required",
                "atSpi": false
            })
        );
    }

    /// A directory of this test's own under the system's temporary directory, emptied.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xiongbao-device-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_helper_that_answers_is_read_and_one_that_hangs_is_given_up_on() {
        let home = scratch("answers").join("agent-desktop-probe");
        let sh = Path::new("/bin/sh");
        assert_eq!(
            run(sh, &["-c", "printf '{\"ok\":true}'"], &home, TIMEOUT).as_deref(),
            Ok("{\"ok\":true}")
        );
        let started = std::time::Instant::now();
        let hung = run(
            sh,
            &["-c", "exec sleep 30"],
            &home,
            Duration::from_millis(300),
        );
        assert!(hung.is_err(), "{hung:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "waited it out");
        assert!(run(
            Path::new("/nonexistent/agent-desktop"),
            &["status"],
            &home,
            TIMEOUT
        )
        .is_err());
    }

    #[test]
    fn the_child_environment_is_the_allow_list_and_the_private_home() {
        let home = Path::new("/data/agent-desktop-probe");
        let env = child_env(
            &|key| match key {
                "XAUTHORITY" | "SECRET_TOKEN" => None,
                _ => Some(OsString::from(format!("value of {key}"))),
            },
            home,
        );
        let keys: Vec<&OsString> = env.iter().map(|(key, _)| key).collect();
        let mut want: Vec<OsString> = ENV_KEEP
            .iter()
            .filter(|key| **key != "XAUTHORITY")
            .map(OsString::from)
            .collect();
        want.push("AGENT_DESKTOP_HOME".into());
        assert_eq!(keys, want.iter().collect::<Vec<_>>());
        assert_eq!(
            env.last(),
            Some(&(
                OsString::from("AGENT_DESKTOP_HOME"),
                OsString::from("/data/agent-desktop-probe")
            ))
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_helper_sees_only_the_allow_list_and_an_emptied_private_home() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("env").join("agent-desktop-probe");
        std::fs::create_dir_all(home.join("left-over")).unwrap();
        std::fs::write(home.join("left-over").join("snapshot.json"), "{}").unwrap();

        let printed = run(
            Path::new("/bin/sh"),
            &["-c", "env; echo '--'; ls -A \"$AGENT_DESKTOP_HOME\""],
            &home,
            TIMEOUT,
        )
        .unwrap();
        let (env, listing) = printed.split_once("--\n").unwrap();
        assert_eq!(listing.trim(), "", "the probe's directory was not emptied");

        // The shell itself adds a few of its own; nothing else may come from this process.
        let shell_own = ["PWD", "SHLVL", "_", "OLDPWD"];
        let mut seen = Vec::new();
        for line in env.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            if key.is_empty() || !key.chars().all(|c| c == '_' || c.is_ascii_alphanumeric()) {
                continue;
            }
            assert!(
                ENV_KEEP.contains(&key) || key == "AGENT_DESKTOP_HOME" || shell_own.contains(&key),
                "{key} reached the helper"
            );
            if key == "AGENT_DESKTOP_HOME" {
                assert_eq!(Path::new(value), home);
            }
            seen.push(key.to_string());
        }
        assert!(seen.iter().any(|key| key == "AGENT_DESKTOP_HOME"));
        if std::env::var_os("CARGO_MANIFEST_DIR").is_some() {
            assert!(!seen.iter().any(|key| key == "CARGO_MANIFEST_DIR"));
        }

        let mode = std::fs::metadata(&home).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn the_window_is_raised_at_most_once_a_minute_and_never_grabbed_when_shown() {
        let now = Instant::now();
        assert_eq!(react(false, None, now), Reaction::Raise);
        assert_eq!(
            react(false, Some(now), now + Duration::from_secs(10)),
            Reaction::Nothing
        );
        assert_eq!(
            react(
                false,
                Some(now),
                now + RAISE_EVERY - Duration::from_millis(1)
            ),
            Reaction::Nothing
        );
        assert_eq!(react(false, Some(now), now + RAISE_EVERY), Reaction::Raise);
        // On screen already: the card is refreshed and scrolled to, every time, without the focus.
        assert_eq!(react(true, Some(now), now), Reaction::Scroll);
        assert_eq!(react(true, None, now), Reaction::Scroll);
        assert_eq!(RAISE_EVERY, Duration::from_secs(60));
    }

    #[test]
    fn the_show_once_note_counts_for_one_start() {
        let marker = scratch("marker").join("data").join("show-window-once");
        assert!(!take_show_once(&marker));
        mark_show_once(&marker).unwrap();
        assert!(take_show_once(&marker));
        assert!(
            !take_show_once(&marker),
            "a second start is an ordinary one"
        );
    }
}
