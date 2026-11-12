//! What the 「桌面操作」 card shows: whether this computer lets the device app read and operate other
//! programs' windows (plan docs/plans/2026-11-12-desktop-write.md, Task 11).
//!
//! The answer is agent-desktop's, the same helper the runner drives: `permissions` on macOS, `status`
//! on Linux (which nests the same states under `permissions`, and says `denied` for accessibility when
//! there is no AT-SPI bus). Windows needs no grant, so nothing is run there.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
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

/// Run `program args`, and return what it printed, or why not, within `timeout`. A helper that has
/// not answered by then is killed.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
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
            Err(error) => return Err(format!("桌面助手出错：{error}")),
        }
    }
    // It has exited; whatever it printed is in the pipe, unless something it started holds it open.
    receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| "桌面助手没有回答。".to_string())
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

    #[cfg(unix)]
    #[test]
    fn a_helper_that_answers_is_read_and_one_that_hangs_is_given_up_on() {
        let sh = Path::new("/bin/sh");
        assert_eq!(
            run(sh, &["-c", "printf '{\"ok\":true}'"], TIMEOUT).as_deref(),
            Ok("{\"ok\":true}")
        );
        let started = std::time::Instant::now();
        let hung = run(sh, &["-c", "exec sleep 30"], Duration::from_millis(300));
        assert!(hung.is_err(), "{hung:?}");
        assert!(started.elapsed() < Duration::from_secs(5), "waited it out");
        assert!(run(
            Path::new("/nonexistent/agent-desktop"),
            &["status"],
            TIMEOUT
        )
        .is_err());
    }
}
