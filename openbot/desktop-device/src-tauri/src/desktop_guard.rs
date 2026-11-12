//! The device's side of a desktop session (plan docs/plans/2026-11-12-desktop-write.md, Task 14;
//! spec docs/specs/2026-11-12-desktop-write-agent-desktop.md §5; ruling C5).
//!
//! The runner says on stdout what its session is doing (`runner: desktop <json>`, see
//! `runner/src/desktop/control.ts`); this module reads those lines and decides what the device does
//! about them: show or hide the always-on-top banner, register or drop the stop key, answer on the
//! runner's stdin, and stop the session when the mouse moves. [`Guard`] only decides; [`apply`]
//! carries the decisions out through [`Effects`], which `main.rs` implements with the banner window,
//! the stop key and the runner's stdin, and the tests implement with a record.

use serde::Serialize;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

/// What starts every control-channel line on the runner's stdout (`CONTROL_LINE_PREFIX`).
pub const CONTROL_LINE_PREFIX: &str = "runner: desktop ";

/// The banner's words, spec §5 verbatim.
pub const BANNER_TEXT: &str =
    "熊宝员工正在操作你的电脑 · 按 Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）或移动鼠标即可停止";
/// Added to the banner while the runner uses the real mouse and keyboard (`--headed`).
pub const BANNER_HEADED_SUFFIX: &str = " · 正在移动鼠标";

/// The banner window's label, and the event that tells its page whether `--headed` is on.
pub const BANNER_LABEL: &str = "desktop-banner";
pub const BANNER_EVENT: &str = "desktop-banner";

/// How far, in pixels and in either direction, the cursor may drift before the session is stopped.
pub const MOVE_THRESHOLD: f64 = 3.0;
/// How often the cursor is read while a session is on.
pub const POLL_MS: u64 = 250;

/// The reasons a session could not be brought up, as `session-failed` carries them.
pub const BANNER_FAILED: &str = "提示条没能显示";
pub const HOTKEY_FAILED: &str = "停止键没能注册";
/// The mouse check is not running, or the cursor cannot be read: moving the mouse would not stop.
pub const MOUSE_FAILED: &str = "鼠标检测没能启动";
/// Cursor reads that may fail in a row during a session before it is stopped (one second).
pub const CURSOR_FAILURE_LIMIT: u32 = 4;
/// The stop key as the banner names it (⌃⌥⎋ on a Mac: Control, not Command).
pub const STOP_SHORTCUT: &str = "Ctrl+Alt+Esc";
/// What the tray says when another program holds the stop key: the session was not started.
pub const HOTKEY_TAKEN_NOTICE: &str = "停止键被占用，桌面操作已停止。";

/// The stop key, Ctrl+Alt+Esc. Registered only while a session is on.
pub fn stop_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape)
}

/// Why the stop key did not register.
#[derive(Debug, PartialEq)]
pub enum HotkeyError {
    /// The system refused it: another program holds Ctrl+Alt+Esc. The person is told in the tray.
    Taken(String),
    /// Anything else (the system failed otherwise, the event loop is gone): only logged.
    Failed(String),
    /// This system has no stop key (Linux, where nothing physical runs).
    Unsupported,
}

impl std::fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HotkeyError::Taken(error) | HotkeyError::Failed(error) => write!(f, "{error}"),
            HotkeyError::Unsupported => write!(f, "this system has no stop key"),
        }
    }
}

/// How global-hotkey 0.8 words the two refusals that mean the key is held: `AlreadyRegistered`
/// (Windows' ERROR_HOTKEY_ALREADY_REGISTERED, or macOS's eventHotKeyExistsErr) and
/// `FailedToRegister`. The plugin passes its errors on only as their text.
pub const HOTKEY_TAKEN_PREFIXES: [&str; 2] =
    ["HotKey already registered: ", "Unable to register hotkey: "];

/// The global-hotkey error the plugin reported, as `message`: taken, or some other failure.
pub fn hotkey_refusal(message: String) -> HotkeyError {
    if HOTKEY_TAKEN_PREFIXES
        .iter()
        .any(|prefix| message.starts_with(prefix))
    {
        HotkeyError::Taken(message)
    } else {
        HotkeyError::Failed(message)
    }
}

/// What the runner said about its desktop session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesktopEvent {
    /// `label`: the first 8 hex digits of the session token's sha256, never the token.
    SessionStarted {
        label: String,
    },
    SessionEnded {
        reason: String,
    },
    HeadedBegin {
        seq: u64,
    },
    HeadedEnd {
        seq: u64,
    },
    PermissionNeeded,
}

/// One stdout line as a desktop event, or nothing: not a control line, not JSON, or not a known event
/// with the fields it needs.
pub fn parse_desktop_line(line: &str) -> Option<DesktopEvent> {
    let json = line.trim().strip_prefix(CONTROL_LINE_PREFIX)?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let seq = || value.get("seq")?.as_u64().filter(|seq| *seq > 0);
    match value.get("event")?.as_str()? {
        "session-started" => {
            let label = value.get("label")?.as_str()?;
            is_label(label).then(|| DesktopEvent::SessionStarted {
                label: label.to_string(),
            })
        }
        "session-ended" => Some(DesktopEvent::SessionEnded {
            reason: value.get("reason")?.as_str()?.to_string(),
        }),
        "headed-begin" => Some(DesktopEvent::HeadedBegin { seq: seq()? }),
        "headed-end" => Some(DesktopEvent::HeadedEnd { seq: seq()? }),
        "permission-needed" => Some(DesktopEvent::PermissionNeeded),
        _ => None,
    }
}

/// Eight lower-case hex digits, as `sessionLabel` makes them and `parseControlInput` accepts them.
fn is_label(label: &str) -> bool {
    label.len() == 8
        && label
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What the device does next.
#[derive(Clone, Debug, PartialEq)]
pub enum GuardAction {
    ShowBanner {
        headed: bool,
    },
    HideBanner,
    SendAck(u64),
    /// `hotkey`, `mouse` or `button`.
    Stop(&'static str),
    RegisterHotkey,
    UnregisterHotkey,
    /// The banner is up and the stop key registered for this session.
    SendReady {
        label: String,
    },
    /// The banner or the stop key did not come up; the session must not start.
    SendFailed {
        label: String,
        reason: &'static str,
    },
}

/// The line written to the runner's stdin for `action`, or None for an action that is not a line.
pub fn control_line(action: &GuardAction) -> Option<String> {
    let value = match action {
        GuardAction::Stop(reason) => serde_json::json!({ "control": "stop", "reason": reason }),
        GuardAction::SendAck(seq) => serde_json::json!({ "control": "headed-ack", "seq": seq }),
        GuardAction::SendReady { label } => {
            serde_json::json!({ "control": "session-ready", "label": label })
        }
        GuardAction::SendFailed { label, reason } => serde_json::json!({
            "control": "session-failed",
            "label": label,
            "reason": reason,
        }),
        GuardAction::ShowBanner { .. }
        | GuardAction::HideBanner
        | GuardAction::RegisterHotkey
        | GuardAction::UnregisterHotkey => return None,
    };
    Some(value.to_string())
}

/// The desktop session as the device sees it.
///
/// A session starts *being set up* when the runner says `session-started`: the banner is shown and
/// the stop key registered, and [`Guard::on_setup`] is told whether both came up. Only then is it
/// *active*, the mouse watched and `session-ready` sent (ruling C5); otherwise `session-failed` is
/// sent and nothing is left on.
#[derive(Debug, Default)]
pub struct Guard {
    /// The label of the session being set up.
    setting_up: Option<String>,
    active: bool,
    /// The `--headed` steps under way, by seq. The mouse is not watched while there is one.
    headed: Vec<u64>,
    /// Where the cursor was when watching started; None until it could be read.
    baseline: Option<(f64, f64)>,
    /// A stop reached the runner for this session: it is the runner's to end, and is not said
    /// again. Cleared when the write failed, so the next reading or key press says it again.
    stopped: bool,
    /// Cursor reads that failed in a row during this session.
    cursor_failures: u32,
    /// The mouse check's thread is running. Kept across sessions.
    mouse_check: bool,
    /// The tray says the stop key is taken, until a later session registers it. Kept across
    /// sessions.
    taken_notice: bool,
}

impl Guard {
    pub fn new() -> Self {
        Self::default()
    }

    /// What to do about `event`. `cursor` is where the cursor is now, if it could be read: the
    /// baseline for a session that starts or a `--headed` step that ends.
    pub fn on_event(
        &mut self,
        event: &DesktopEvent,
        cursor: Option<(f64, f64)>,
    ) -> Vec<GuardAction> {
        match event {
            DesktopEvent::SessionStarted { label } => {
                // The runner ends a session before it starts the next; if this one was missed, its
                // stop key goes before the new one is registered.
                let replacing = self.active || self.setting_up.is_some();
                *self = Guard {
                    setting_up: Some(label.clone()),
                    baseline: cursor,
                    mouse_check: self.mouse_check,
                    taken_notice: self.taken_notice,
                    ..Guard::default()
                };
                let mut actions = Vec::new();
                if replacing {
                    actions.push(GuardAction::UnregisterHotkey);
                }
                actions.push(GuardAction::ShowBanner { headed: false });
                actions.push(GuardAction::RegisterHotkey);
                actions
            }
            DesktopEvent::SessionEnded { .. } => self.reset(),
            DesktopEvent::HeadedBegin { seq } => {
                // No session that came up, no ack: the runner then refuses the step.
                if !self.active || self.stopped {
                    return Vec::new();
                }
                if !self.headed.contains(seq) {
                    self.headed.push(*seq);
                }
                vec![
                    GuardAction::ShowBanner { headed: true },
                    GuardAction::SendAck(*seq),
                ]
            }
            DesktopEvent::HeadedEnd { seq } => {
                let Some(at) = self.headed.iter().position(|open| open == seq) else {
                    return Vec::new();
                };
                self.headed.remove(at);
                if !self.headed.is_empty() || !self.active {
                    return Vec::new();
                }
                // The runner left the cursor where its step put it: that is the new start.
                self.baseline = cursor;
                vec![GuardAction::ShowBanner { headed: false }]
            }
            DesktopEvent::PermissionNeeded => Vec::new(),
        }
    }

    /// Whether the banner and the stop key came up for the session being set up (`Err` names what
    /// did not). Only both make it active.
    pub fn on_setup(&mut self, outcome: Result<(), &'static str>) -> Vec<GuardAction> {
        let Some(label) = self.setting_up.take() else {
            return Vec::new();
        };
        match outcome {
            Ok(()) => {
                self.active = true;
                vec![GuardAction::SendReady { label }]
            }
            Err(reason) => {
                let mut actions = self.reset();
                actions.push(GuardAction::SendFailed { label, reason });
                actions
            }
        }
    }

    /// A session is being set up: [`apply`] owes [`Guard::on_setup`] an answer.
    pub fn setting_up(&self) -> bool {
        self.setting_up.is_some()
    }

    /// Whether the mouse check can watch the session being set up: its thread runs and the cursor
    /// could be read where the session starts. Without both, moving the mouse would stop nothing.
    pub fn mouse_ready(&self) -> Result<(), &'static str> {
        if self.mouse_check && self.baseline.is_some() {
            Ok(())
        } else {
            Err(MOUSE_FAILED)
        }
    }

    /// The mouse check's thread is running.
    pub fn mouse_check_started(&mut self) {
        self.mouse_check = true;
    }

    /// The mouse check's thread left its loop: no later session can be ready, and a session that
    /// is on is no longer watched, so it is stopped.
    pub fn mouse_check_ended(&mut self) -> Vec<GuardAction> {
        self.mouse_check = false;
        if self.active && !self.stopped {
            self.stopped = true;
            vec![GuardAction::Stop("mouse")]
        } else {
            Vec::new()
        }
    }

    /// One round of the mouse check: `read` reads the cursor, and is called only while the session
    /// is watched (on, and no `--headed` step under way).
    pub fn poll(&mut self, read: impl FnOnce() -> Option<(f64, f64)>) -> Vec<GuardAction> {
        if !self.is_polling() {
            return Vec::new();
        }
        match read() {
            Some(position) => self.on_cursor(position),
            None => self.on_cursor_error(),
        }
        .into_iter()
        .collect()
    }

    /// The cursor could not be read. `CURSOR_FAILURE_LIMIT` failures in a row stop the session: it
    /// is no longer watched.
    pub fn on_cursor_error(&mut self) -> Option<GuardAction> {
        if !self.is_polling() {
            return None;
        }
        self.cursor_failures += 1;
        if self.cursor_failures >= CURSOR_FAILURE_LIMIT {
            self.stopped = true;
            Some(GuardAction::Stop("mouse"))
        } else {
            None
        }
    }

    /// A stop could not be written to the runner: it has not heard it.
    fn stop_not_heard(&mut self) {
        self.stopped = false;
    }

    /// 有会话、不在真实输入期间、相对起点在任一方向移动 ≥ 3 px 时，回 Stop("mouse")。
    pub fn on_cursor(&mut self, pos: (f64, f64)) -> Option<GuardAction> {
        if !self.is_polling() {
            return None;
        }
        self.cursor_failures = 0;
        let Some((x, y)) = self.baseline else {
            self.baseline = Some(pos);
            return None;
        };
        if (pos.0 - x).abs() >= MOVE_THRESHOLD || (pos.1 - y).abs() >= MOVE_THRESHOLD {
            self.stopped = true;
            Some(GuardAction::Stop("mouse"))
        } else {
            None
        }
    }

    /// The stop key or the tray's 「停止桌面操作」. Said even with no session on: the runner ignores
    /// a stop it has no session for, and a guard that missed a line must not keep one alive.
    pub fn on_stop(&mut self, reason: &'static str) -> Vec<GuardAction> {
        self.stopped = true;
        vec![GuardAction::Stop(reason)]
    }

    /// Back to no session: the session ended, could not start, or its runner is gone.
    pub fn reset(&mut self) -> Vec<GuardAction> {
        *self = Guard {
            mouse_check: self.mouse_check,
            taken_notice: self.taken_notice,
            ..Guard::default()
        };
        vec![GuardAction::HideBanner, GuardAction::UnregisterHotkey]
    }

    /// 有会话且不在 headed 期间。
    pub fn is_polling(&self) -> bool {
        self.active && self.headed.is_empty() && !self.stopped
    }
}

/// Whether the runner process the guard was following is gone or being replaced: a new runner has no
/// session, so the guard starts again from nothing. Offline is the same process, session and all.
pub fn runner_gone(state: &crate::supervise::State) -> bool {
    use crate::supervise::State;
    !matches!(state, State::Online | State::Offline)
}

/// What carries the guard's actions out.
pub trait Effects {
    fn show_banner(&mut self, headed: bool) -> Result<(), String>;
    /// The banner is already up: only its words change.
    fn update_banner(&mut self, headed: bool) -> Result<(), String>;
    fn hide_banner(&mut self);
    fn register_hotkey(&mut self) -> Result<(), HotkeyError>;
    fn unregister_hotkey(&mut self);
    /// Tell the person, in the tray.
    fn notice(&mut self, text: &'static str);
    /// The tray shows the state again instead of the notice.
    fn clear_notice(&mut self);
    /// One line to the runner's stdin.
    fn send(&mut self, line: &str) -> std::io::Result<()>;
}

/// Carry `actions` out, in order. Once the banner or the stop key fails, nothing more is brought up
/// or promised in this batch (no later banner, key, ack or ready); hiding, unregistering and stops
/// still go through; a stop key another program holds is also said in the tray, until a later one
/// registers. A session being set up then gets its answer from [`Guard::on_setup`] (which
/// also needs [`Guard::mouse_ready`]), and those actions are carried out too. A stop the runner
/// could not be told is left unsaid in the guard, to be said again; other lines that fail are logged.
pub fn apply(guard: &mut Guard, actions: Vec<GuardAction>, effects: &mut dyn Effects) {
    let mut failed: Option<&'static str> = None;
    // The first show of a session brings the window up; later ones only change its words.
    let first_show = guard.setting_up();
    for action in actions {
        match action {
            GuardAction::ShowBanner { headed } => {
                if failed.is_none() {
                    let shown = if first_show {
                        effects.show_banner(headed)
                    } else {
                        effects.update_banner(headed)
                    };
                    if let Err(error) = shown {
                        eprintln!("[device] the desktop banner did not come up: {error}");
                        failed = Some(BANNER_FAILED);
                    }
                }
            }
            GuardAction::RegisterHotkey => {
                if failed.is_none() {
                    match effects.register_hotkey() {
                        Ok(()) => {
                            if guard.taken_notice {
                                guard.taken_notice = false;
                                effects.clear_notice();
                            }
                        }
                        Err(error) => {
                            eprintln!(
                                "[device] the stop key {STOP_SHORTCUT} was not registered: {error}"
                            );
                            if matches!(error, HotkeyError::Taken(_)) {
                                guard.taken_notice = true;
                                effects.notice(HOTKEY_TAKEN_NOTICE);
                            }
                            failed = Some(HOTKEY_FAILED);
                        }
                    }
                }
            }
            GuardAction::HideBanner => effects.hide_banner(),
            GuardAction::UnregisterHotkey => effects.unregister_hotkey(),
            GuardAction::SendAck(_) | GuardAction::SendReady { .. } if failed.is_some() => {}
            other => {
                let Some(line) = control_line(&other) else {
                    continue;
                };
                if let Err(error) = effects.send(&line) {
                    eprintln!("[device] could not tell the runner {line}: {error}");
                    if matches!(other, GuardAction::Stop(_)) {
                        guard.stop_not_heard();
                    }
                }
            }
        }
    }
    if guard.setting_up() {
        let outcome = match failed {
            Some(reason) => Err(reason),
            None => guard.mouse_ready(),
        };
        let answer = guard.on_setup(outcome);
        apply(guard, answer, effects);
    }
}

/// The banner window's parameters.
#[derive(Debug, PartialEq)]
pub struct BannerWindow {
    pub label: &'static str,
    pub page: &'static str,
    pub width: f64,
    pub height: f64,
    pub always_on_top: bool,
    pub decorations: bool,
    pub skip_taskbar: bool,
    pub focused: bool,
    pub focusable: bool,
    pub resizable: bool,
    pub visible_on_all_workspaces: bool,
    pub visible: bool,
}

/// Made hidden at start-up and shown for a session. It never takes the focus away from what the
/// person is doing: not focused, not focusable, no taskbar entry; `main.rs` also makes it ignore the
/// cursor once shown, and never calls `set_focus` on it.
pub const BANNER_WINDOW: BannerWindow = BannerWindow {
    label: BANNER_LABEL,
    page: "banner.html",
    width: 620.0,
    height: 36.0,
    always_on_top: true,
    decorations: false,
    skip_taskbar: true,
    focused: false,
    focusable: false,
    resizable: false,
    visible_on_all_workspaces: true,
    visible: false,
};

/// Where the banner goes, in physical pixels: centred at the top of the primary monitor's work area
/// (below a macOS menu bar or a top taskbar). `area` is the work area's top-left corner, `scale` the
/// monitor's scale factor. A screen narrower than the banner gets it at its left edge.
pub fn banner_origin(area: (i32, i32), area_width: u32, scale: f64) -> (i32, i32) {
    let width = (BANNER_WINDOW.width * scale).round();
    let spare = (f64::from(area_width) - width).max(0.0);
    (area.0 + (spare / 2.0).round() as i32, area.1)
}

/// The banner's words as its window title, for screen readers: the page shows the same.
pub fn banner_title(headed: bool) -> String {
    let suffix = if headed { BANNER_HEADED_SUFFIX } else { "" };
    format!("{BANNER_TEXT}{suffix}")
}

/// The `desktop-banner` event's payload.
#[derive(Clone, Debug, Serialize)]
pub struct BannerView {
    pub headed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervise::State;

    fn started(label: &str) -> DesktopEvent {
        DesktopEvent::SessionStarted {
            label: label.into(),
        }
    }

    fn ended() -> DesktopEvent {
        DesktopEvent::SessionEnded {
            reason: "stopped".into(),
        }
    }

    /// A guard with a session that came up.
    fn live(at: (f64, f64)) -> Guard {
        let mut guard = Guard::new();
        guard.mouse_check_started();
        guard.on_event(&started("0123abcd"), Some(at));
        guard.on_setup(Ok(()));
        guard
    }

    #[test]
    fn lines_parse_into_events_and_junk_is_ignored() {
        assert_eq!(
            parse_desktop_line(r#"runner: desktop {"event":"session-started","label":"0123abcd"}"#),
            Some(started("0123abcd"))
        );
        assert_eq!(
            parse_desktop_line(r#"runner: desktop {"event":"session-ended","reason":"expired"}"#),
            Some(DesktopEvent::SessionEnded {
                reason: "expired".into()
            })
        );
        assert_eq!(
            parse_desktop_line(r#"runner: desktop {"event":"headed-begin","seq":7}"#),
            Some(DesktopEvent::HeadedBegin { seq: 7 })
        );
        assert_eq!(
            parse_desktop_line(" runner: desktop {\"event\": \"headed-end\", \"seq\": 7}\r"),
            Some(DesktopEvent::HeadedEnd { seq: 7 })
        );
        assert_eq!(
            parse_desktop_line(r#"runner: desktop {"event":"permission-needed"}"#),
            Some(DesktopEvent::PermissionNeeded)
        );
        for junk in [
            "",
            "runner: connected as d",
            "runner: desktop ",
            "runner: desktop permission-needed",
            r#"runner: desktop ["permission-needed"]"#,
            r#"runner: desktop {"event":"permission-needed""#,
            r#"runner: desktop {"event":"connected as d"}"#,
            r#"desktop {"event":"permission-needed"}"#,
            r#"xrunner: desktop {"event":"permission-needed"}"#,
            // A label is exactly 8 lower-case hex digits, as the runner makes it: never a token.
            r#"runner: desktop {"event":"session-started"}"#,
            r#"runner: desktop {"event":"session-started","label":"0123ABCD"}"#,
            r#"runner: desktop {"event":"session-started","label":"0123abcd9"}"#,
            r#"runner: desktop {"event":"session-started","label":12345678}"#,
            r#"runner: desktop {"event":"session-ended"}"#,
            r#"runner: desktop {"event":"headed-begin"}"#,
            r#"runner: desktop {"event":"headed-begin","seq":0}"#,
            r#"runner: desktop {"event":"headed-begin","seq":-1}"#,
            r#"runner: desktop {"event":"headed-begin","seq":1.5}"#,
            r#"runner: desktop {"event":"headed-end","seq":"1"}"#,
        ] {
            assert_eq!(parse_desktop_line(junk), None, "{junk}");
        }
    }

    #[test]
    fn a_session_shows_the_banner_and_registers_the_hotkey_then_hides_and_unregisters() {
        let mut guard = Guard::new();
        assert_eq!(
            guard.on_event(&started("0123abcd"), Some((10.0, 10.0))),
            vec![
                GuardAction::ShowBanner { headed: false },
                GuardAction::RegisterHotkey
            ]
        );
        assert!(guard.setting_up());
        assert!(
            !guard.is_polling(),
            "not before the runner is told it is ready"
        );
        assert_eq!(
            guard.on_setup(Ok(())),
            vec![GuardAction::SendReady {
                label: "0123abcd".into()
            }]
        );
        assert!(!guard.setting_up());
        assert!(guard.is_polling());
        assert_eq!(
            guard.on_event(&ended(), Some((10.0, 10.0))),
            vec![GuardAction::HideBanner, GuardAction::UnregisterHotkey]
        );
        assert!(!guard.is_polling());
        assert_eq!(guard.on_cursor((500.0, 500.0)), None);
    }

    #[test]
    fn a_banner_or_stop_key_that_does_not_come_up_fails_the_session() {
        for reason in [BANNER_FAILED, HOTKEY_FAILED] {
            let mut guard = Guard::new();
            guard.on_event(&started("89abcdef"), Some((0.0, 0.0)));
            assert_eq!(
                guard.on_setup(Err(reason)),
                vec![
                    GuardAction::HideBanner,
                    GuardAction::UnregisterHotkey,
                    GuardAction::SendFailed {
                        label: "89abcdef".into(),
                        reason
                    }
                ]
            );
            assert!(!guard.setting_up());
            assert!(!guard.is_polling());
            assert_eq!(guard.on_cursor((100.0, 100.0)), None);
            assert_eq!(
                guard.on_event(&DesktopEvent::HeadedBegin { seq: 1 }, None),
                vec![],
                "no ack for a session that never came up"
            );
        }
        // Nothing being set up: nothing to answer.
        assert_eq!(Guard::new().on_setup(Ok(())), vec![]);
    }

    #[test]
    fn headed_pauses_the_mouse_check_acks_and_rebaselines_after() {
        let mut guard = live((100.0, 100.0));
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedBegin { seq: 3 }, Some((100.0, 100.0))),
            vec![
                GuardAction::ShowBanner { headed: true },
                GuardAction::SendAck(3)
            ]
        );
        assert!(!guard.is_polling());
        assert_eq!(
            guard.on_cursor((400.0, 300.0)),
            None,
            "the runner is moving it"
        );
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedEnd { seq: 3 }, Some((400.0, 300.0))),
            vec![GuardAction::ShowBanner { headed: false }]
        );
        assert!(guard.is_polling());
        assert_eq!(guard.on_cursor((400.0, 300.0)), None);
        assert_eq!(guard.on_cursor((402.0, 298.0)), None, "2 px is not a move");
        assert_eq!(
            guard.on_cursor((400.0, 303.0)),
            Some(GuardAction::Stop("mouse"))
        );
        // Said once: the runner ends the session and says so.
        assert!(!guard.is_polling());
        assert_eq!(guard.on_cursor((0.0, 0.0)), None);

        let mut left = live((50.0, 50.0));
        assert_eq!(
            left.on_cursor((47.0, 50.0)),
            Some(GuardAction::Stop("mouse")),
            "either direction"
        );
    }

    #[test]
    fn overlapping_headed_steps_pause_until_the_last_ends_and_a_stray_end_is_ignored() {
        let mut guard = live((0.0, 0.0));
        guard.on_event(&DesktopEvent::HeadedBegin { seq: 1 }, None);
        guard.on_event(&DesktopEvent::HeadedBegin { seq: 2 }, None);
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedEnd { seq: 9 }, Some((5.0, 5.0))),
            vec![]
        );
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedEnd { seq: 1 }, Some((5.0, 5.0))),
            vec![]
        );
        assert!(!guard.is_polling());
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedEnd { seq: 2 }, Some((20.0, 20.0))),
            vec![GuardAction::ShowBanner { headed: false }]
        );
        assert_eq!(guard.on_cursor((21.0, 21.0)), None);
    }

    #[test]
    fn an_unreadable_cursor_takes_the_first_reading_as_the_baseline() {
        let mut guard = Guard::new();
        guard.on_event(&started("0123abcd"), None);
        guard.on_setup(Ok(()));
        assert_eq!(guard.on_cursor((300.0, 300.0)), None);
        assert_eq!(guard.on_cursor((301.0, 301.0)), None);
        assert_eq!(
            guard.on_cursor((310.0, 300.0)),
            Some(GuardAction::Stop("mouse"))
        );
    }

    #[test]
    fn no_session_no_polling() {
        let mut guard = Guard::new();
        assert!(!guard.is_polling());
        assert_eq!(guard.on_cursor((0.0, 0.0)), None);
        assert_eq!(guard.on_cursor((900.0, 900.0)), None);
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedBegin { seq: 1 }, None),
            vec![]
        );
        assert_eq!(
            guard.on_event(&DesktopEvent::PermissionNeeded, None),
            vec![]
        );
        assert!(!guard.is_polling());
    }

    #[test]
    fn the_stop_key_and_the_tray_stop_and_a_restart() {
        let mut guard = live((0.0, 0.0));
        assert_eq!(guard.on_stop("button"), vec![GuardAction::Stop("button")]);
        assert!(!guard.is_polling());
        // Without a session the stop is still said: the runner ignores it, and nothing is left on.
        assert_eq!(
            Guard::new().on_stop("hotkey"),
            vec![GuardAction::Stop("hotkey")]
        );

        let mut guard = live((0.0, 0.0));
        guard.on_event(&DesktopEvent::HeadedBegin { seq: 4 }, None);
        assert_eq!(
            guard.reset(),
            vec![GuardAction::HideBanner, GuardAction::UnregisterHotkey]
        );
        assert!(!guard.is_polling());
        assert_eq!(guard.on_cursor((99.0, 99.0)), None);
        assert_eq!(
            guard.on_event(&DesktopEvent::HeadedEnd { seq: 4 }, None),
            vec![],
            "a new runner starts from nothing"
        );
    }

    #[test]
    fn a_new_session_over_a_live_one_drops_the_old_stop_key_first() {
        let mut guard = live((0.0, 0.0));
        assert_eq!(
            guard.on_event(&started("fedcba98"), Some((7.0, 7.0))),
            vec![
                GuardAction::UnregisterHotkey,
                GuardAction::ShowBanner { headed: false },
                GuardAction::RegisterHotkey
            ]
        );
        assert_eq!(
            guard.on_setup(Ok(())),
            vec![GuardAction::SendReady {
                label: "fedcba98".into()
            }]
        );
        assert_eq!(
            guard.on_cursor((9.0, 9.0)),
            None,
            "baseline is the new start"
        );
    }

    #[test]
    fn a_runner_that_is_gone_resets_the_guard() {
        for state in [
            State::Unpaired,
            State::Pairing,
            State::Starting,
            State::Restarting {
                attempt: 1,
                in_seconds: 1,
            },
            State::Failed {
                message: "x".into(),
            },
            State::Stopped,
        ] {
            assert!(runner_gone(&state), "{state:?}");
        }
        // Still the same process: a lost connection does not end the session on this computer.
        assert!(!runner_gone(&State::Online));
        assert!(!runner_gone(&State::Offline));
    }

    #[test]
    fn control_lines_are_the_runner_s_json() {
        assert_eq!(
            control_line(&GuardAction::Stop("mouse")).as_deref(),
            Some(r#"{"control":"stop","reason":"mouse"}"#)
        );
        assert_eq!(
            control_line(&GuardAction::Stop("hotkey")).as_deref(),
            Some(r#"{"control":"stop","reason":"hotkey"}"#)
        );
        assert_eq!(
            control_line(&GuardAction::SendAck(7)).as_deref(),
            Some(r#"{"control":"headed-ack","seq":7}"#)
        );
        assert_eq!(
            control_line(&GuardAction::SendReady {
                label: "0123abcd".into()
            })
            .as_deref(),
            Some(r#"{"control":"session-ready","label":"0123abcd"}"#)
        );
        assert_eq!(
            control_line(&GuardAction::SendFailed {
                label: "0123abcd".into(),
                reason: HOTKEY_FAILED
            })
            .as_deref(),
            Some(r#"{"control":"session-failed","label":"0123abcd","reason":"停止键没能注册"}"#)
        );
        for silent in [
            GuardAction::ShowBanner { headed: true },
            GuardAction::HideBanner,
            GuardAction::RegisterHotkey,
            GuardAction::UnregisterHotkey,
        ] {
            assert_eq!(control_line(&silent), None, "{silent:?}");
        }
    }

    #[test]
    fn the_banner_text_is_the_spec_s() {
        assert_eq!(
            BANNER_TEXT,
            "熊宝员工正在操作你的电脑 · 按 Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）或移动鼠标即可停止"
        );
        assert_eq!(BANNER_HEADED_SUFFIX, " · 正在移动鼠标");
        let spec = include_str!("../../../../docs/specs/2026-11-12-desktop-write-agent-desktop.md");
        assert!(
            spec.contains(&format!("「{BANNER_TEXT}」")),
            "spec §5 changed"
        );
        assert!(spec.contains("追加「正在移动鼠标」"));
        assert_eq!(banner_title(false), BANNER_TEXT);
        assert_eq!(
            banner_title(true),
            format!("{BANNER_TEXT}{BANNER_HEADED_SUFFIX}")
        );
        // The page shows the same words; the event only says whether `--headed` is on.
        let page = include_str!("../../ui/banner.html");
        assert!(page.contains(BANNER_TEXT));
        assert!(page.contains(BANNER_HEADED_SUFFIX));
        assert!(page.contains(r#"listen("desktop-banner""#));
        assert!(
            !page.contains("invoke"),
            "the banner asks nothing of the app"
        );
        assert_eq!(
            serde_json::to_string(&BannerView { headed: true }).unwrap(),
            r#"{"headed":true}"#
        );
    }

    #[test]
    fn the_banner_window_never_takes_focus() {
        assert_eq!(
            BANNER_WINDOW,
            BannerWindow {
                label: "desktop-banner",
                page: "banner.html",
                width: 620.0,
                height: 36.0,
                always_on_top: true,
                decorations: false,
                skip_taskbar: true,
                focused: false,
                focusable: false,
                resizable: false,
                visible_on_all_workspaces: true,
                visible: false,
            }
        );
        assert_eq!(BANNER_WINDOW.label, BANNER_LABEL);
        // Its page may listen for its event and nothing else.
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-banner.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!([BANNER_LABEL]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"])
        );
    }

    #[test]
    fn the_banner_sits_at_the_top_centre_of_the_work_area() {
        // 1920 px wide at scale 1: (1920 - 620) / 2.
        assert_eq!(banner_origin((0, 0), 1920, 1.0), (650, 0));
        // A Retina screen: 620 logical px are 1240 physical.
        assert_eq!(banner_origin((0, 25), 2880, 2.0), (820, 25));
        // A second screen to the left, and one narrower than the banner.
        assert_eq!(banner_origin((-1280, 0), 1280, 1.0), (-1280 + 330, 0));
        assert_eq!(banner_origin((100, 0), 400, 1.0), (100, 0));
    }

    // ---- Carrying the actions out. ----

    #[derive(Default)]
    struct Record {
        banner_fails: bool,
        /// Another program holds the stop key.
        hotkey_fails: bool,
        /// This system has no stop key.
        hotkey_unsupported: bool,
        /// The stop key failed otherwise (the event loop is gone).
        hotkey_broken: bool,
        /// How many of the next writes to the runner fail.
        send_fails: u32,
        done: Vec<String>,
        sent: Vec<String>,
        /// What the tray told the person.
        notices: Vec<String>,
        /// How often the tray went back to showing the state.
        cleared: u32,
    }

    impl Effects for Record {
        fn show_banner(&mut self, headed: bool) -> Result<(), String> {
            if self.banner_fails {
                return Err("no window".into());
            }
            self.done.push(format!("show headed={headed}"));
            Ok(())
        }
        fn update_banner(&mut self, headed: bool) -> Result<(), String> {
            if self.banner_fails {
                return Err("no window".into());
            }
            self.done.push(format!("update headed={headed}"));
            Ok(())
        }
        fn hide_banner(&mut self) {
            self.done.push("hide".into());
        }
        fn register_hotkey(&mut self) -> Result<(), HotkeyError> {
            if self.hotkey_fails {
                return Err(HotkeyError::Taken("held by another program".into()));
            }
            if self.hotkey_unsupported {
                return Err(HotkeyError::Unsupported);
            }
            if self.hotkey_broken {
                return Err(HotkeyError::Failed("event loop closed".into()));
            }
            self.done.push("register".into());
            Ok(())
        }
        fn unregister_hotkey(&mut self) {
            self.done.push("unregister".into());
        }
        fn notice(&mut self, text: &'static str) {
            self.notices.push(text.into());
        }
        fn clear_notice(&mut self) {
            self.cleared += 1;
        }
        fn send(&mut self, line: &str) -> std::io::Result<()> {
            if self.send_fails > 0 {
                self.send_fails -= 1;
                return Err(std::io::ErrorKind::BrokenPipe.into());
            }
            self.sent.push(line.into());
            Ok(())
        }
    }

    fn start(effects: &mut Record) -> Guard {
        let mut guard = Guard::new();
        guard.mouse_check_started();
        let actions = guard.on_event(&started("0123abcd"), Some((0.0, 0.0)));
        apply(&mut guard, actions, effects);
        guard
    }

    #[test]
    fn a_session_is_ready_only_when_banner_and_stop_key_both_came_up() {
        let mut fine = Record::default();
        let guard = start(&mut fine);
        assert_eq!(fine.done, vec!["show headed=false", "register"]);
        assert_eq!(
            fine.sent,
            vec![r#"{"control":"session-ready","label":"0123abcd"}"#]
        );
        assert!(guard.is_polling());

        let mut no_key = Record {
            hotkey_fails: true,
            ..Record::default()
        };
        let guard = start(&mut no_key);
        assert_eq!(
            no_key.done,
            vec!["show headed=false", "hide", "unregister"],
            "the banner is taken down again and no key is left registered"
        );
        assert_eq!(
            no_key.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"停止键没能注册"}"#]
        );
        assert!(!guard.is_polling());

        let mut no_banner = Record {
            banner_fails: true,
            ..Record::default()
        };
        start(&mut no_banner);
        assert_eq!(
            no_banner.done,
            vec!["hide", "unregister"],
            "no key is registered for a session without a banner"
        );
        assert_eq!(
            no_banner.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"提示条没能显示"}"#]
        );
    }

    #[test]
    fn no_ack_when_the_banner_cannot_say_the_mouse_is_moving() {
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        effects.sent.clear();
        effects.banner_fails = true;
        let actions = guard.on_event(&DesktopEvent::HeadedBegin { seq: 2 }, None);
        apply(&mut guard, actions, &mut effects);
        assert_eq!(effects.sent, Vec::<String>::new());

        effects.banner_fails = false;
        let actions = guard.on_event(&DesktopEvent::HeadedBegin { seq: 3 }, None);
        apply(&mut guard, actions, &mut effects);
        assert_eq!(effects.sent, vec![r#"{"control":"headed-ack","seq":3}"#]);
        let stop = guard.on_stop("hotkey");
        apply(&mut guard, stop, &mut effects);
        assert_eq!(
            effects.sent.last().map(String::as_str),
            Some(r#"{"control":"stop","reason":"hotkey"}"#)
        );
    }

    #[test]
    fn a_stop_that_could_not_be_written_is_said_again() {
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        effects.sent.clear();
        effects.send_fails = 1;
        let stop = guard.on_cursor((10.0, 0.0)).into_iter().collect();
        apply(&mut guard, stop, &mut effects);
        assert_eq!(effects.sent, Vec::<String>::new());
        assert!(
            guard.is_polling(),
            "still watching: the runner did not hear it"
        );
        let again: Vec<GuardAction> = guard.on_cursor((10.0, 0.0)).into_iter().collect();
        assert_eq!(again, vec![GuardAction::Stop("mouse")]);
        apply(&mut guard, again, &mut effects);
        assert_eq!(effects.sent, vec![r#"{"control":"stop","reason":"mouse"}"#]);
        assert_eq!(guard.on_cursor((50.0, 0.0)), None, "heard: not said again");

        // The stop key and the tray's button too.
        let mut guard = start(&mut effects);
        effects.sent.clear();
        effects.send_fails = 1;
        let stop = guard.on_stop("hotkey");
        apply(&mut guard, stop, &mut effects);
        assert!(guard.is_polling());
        assert_eq!(
            guard.on_cursor((10.0, 0.0)),
            Some(GuardAction::Stop("mouse"))
        );

        // An ack, a ready or a failed that cannot be written is only logged.
        let mut effects = Record {
            send_fails: 1,
            ..Record::default()
        };
        let guard = start(&mut effects);
        assert!(guard.is_polling());
    }

    #[test]
    fn a_session_is_not_ready_without_a_running_mouse_check_and_a_readable_cursor() {
        // The thread never started.
        let mut effects = Record::default();
        let mut guard = Guard::new();
        let actions = guard.on_event(&started("0123abcd"), Some((0.0, 0.0)));
        apply(&mut guard, actions, &mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"鼠标检测没能启动"}"#]
        );
        assert_eq!(
            effects.done,
            vec!["show headed=false", "register", "hide", "unregister"]
        );
        assert!(!guard.is_polling());

        // The cursor cannot be read where the session starts.
        let mut effects = Record::default();
        let mut guard = Guard::new();
        guard.mouse_check_started();
        let actions = guard.on_event(&started("0123abcd"), None);
        apply(&mut guard, actions, &mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"鼠标检测没能启动"}"#]
        );

        // Kept across sessions: a session that ends does not stop the thread.
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        let end = guard.on_event(&ended(), None);
        apply(&mut guard, end, &mut effects);
        effects.sent.clear();
        let actions = guard.on_event(&started("89abcdef"), Some((0.0, 0.0)));
        apply(&mut guard, actions, &mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-ready","label":"89abcdef"}"#]
        );
    }

    #[test]
    fn a_cursor_that_keeps_failing_stops_the_session() {
        let mut guard = live((0.0, 0.0));
        for _ in 1..CURSOR_FAILURE_LIMIT {
            assert_eq!(guard.on_cursor_error(), None);
        }
        // A good reading in between starts the count again.
        assert_eq!(guard.on_cursor((1.0, 1.0)), None);
        for _ in 1..CURSOR_FAILURE_LIMIT {
            assert_eq!(guard.on_cursor_error(), None);
        }
        assert_eq!(guard.on_cursor_error(), Some(GuardAction::Stop("mouse")));
        assert_eq!(guard.on_cursor_error(), None, "said once");
        // No session: nothing to stop.
        let mut idle = Guard::new();
        for _ in 0..CURSOR_FAILURE_LIMIT * 2 {
            assert_eq!(idle.on_cursor_error(), None);
        }
    }

    #[test]
    fn the_stop_shortcut_is_ctrl_alt_escape() {
        use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
        let shortcut = stop_shortcut();
        assert_eq!(
            shortcut,
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Escape)
        );
        assert_eq!(STOP_SHORTCUT.parse::<Shortcut>().unwrap(), shortcut);
        assert_eq!(STOP_SHORTCUT, "Ctrl+Alt+Esc");
        // Control, not Command, on a Mac too: ⌃⌥⎋ as the banner says.
        assert!(!shortcut.mods.contains(Modifiers::SUPER));
        assert!(!shortcut.mods.contains(Modifiers::SHIFT));
        assert!(BANNER_TEXT.contains("Ctrl+Alt+Esc（Mac 上 ⌃⌥⎋）"));
        assert_eq!(HOTKEY_TAKEN_NOTICE, "停止键被占用，桌面操作已停止。");
    }

    #[test]
    fn polling_runs_only_during_a_session_outside_headed() {
        // A fake cursor that counts its readings and drifts by 1 px each time (never a move).
        let mut reads = 0;
        let mut poll = |guard: &mut Guard| {
            guard.poll(|| {
                reads += 1;
                Some((f64::from(reads % 2), 0.0))
            })
        };
        let mut guard = Guard::new();
        guard.mouse_check_started();
        assert_eq!(poll(&mut guard), vec![], "no session");
        guard.on_event(&started("0123abcd"), Some((0.0, 0.0)));
        assert_eq!(poll(&mut guard), vec![], "being set up: not yet");
        guard.on_setup(Ok(()));
        assert_eq!(poll(&mut guard), vec![]);
        assert_eq!(poll(&mut guard), vec![]);
        guard.on_event(&DesktopEvent::HeadedBegin { seq: 1 }, None);
        assert_eq!(poll(&mut guard), vec![], "the runner is moving it");
        guard.on_event(&DesktopEvent::HeadedEnd { seq: 1 }, Some((1.0, 0.0)));
        assert_eq!(poll(&mut guard), vec![]);
        guard.on_event(&ended(), None);
        assert_eq!(poll(&mut guard), vec![], "ended");
        drop(poll);
        assert_eq!(reads, 3, "read only while the session was watched");

        // A reading that moved stops it; after that the cursor is not read again.
        let mut guard = live((0.0, 0.0));
        assert_eq!(
            guard.poll(|| Some((5.0, 0.0))),
            vec![GuardAction::Stop("mouse")]
        );
        assert_eq!(guard.poll(|| panic!("not read once stopped")), vec![]);
        // A reading that failed counts towards the stop.
        let mut guard = live((0.0, 0.0));
        for _ in 1..CURSOR_FAILURE_LIMIT {
            assert_eq!(guard.poll(|| None), vec![]);
        }
        assert_eq!(guard.poll(|| None), vec![GuardAction::Stop("mouse")]);
    }

    #[test]
    fn a_stop_key_that_registers_lets_the_session_be_ready() {
        let mut effects = Record::default();
        let guard = start(&mut effects);
        assert_eq!(effects.done, vec!["show headed=false", "register"]);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-ready","label":"0123abcd"}"#]
        );
        assert_eq!(effects.notices, Vec::<String>::new());
        assert!(guard.is_polling());
    }

    #[test]
    fn a_stop_key_that_is_taken_fails_the_session_and_says_so_in_the_tray() {
        let mut effects = Record {
            hotkey_fails: true,
            ..Record::default()
        };
        let guard = start(&mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"停止键没能注册"}"#]
        );
        assert_eq!(
            effects.done,
            vec!["show headed=false", "hide", "unregister"]
        );
        assert_eq!(effects.notices, vec![HOTKEY_TAKEN_NOTICE]);
        assert!(!guard.is_polling());

        // A system with no stop key at all: the session fails, but nothing is said to be taken.
        let mut effects = Record {
            hotkey_unsupported: true,
            ..Record::default()
        };
        start(&mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"停止键没能注册"}"#]
        );
        assert_eq!(effects.notices, Vec::<String>::new());
    }

    #[test]
    fn only_a_refusal_of_the_key_is_taken() {
        let taken = [
            "HotKey already registered: HotKey { mods: Modifiers(CONTROL | ALT), key: Escape, id: 1 }",
            "Unable to register hotkey: OSStatus -9878",
        ];
        for message in taken {
            assert_eq!(
                hotkey_refusal(message.into()),
                HotkeyError::Taken(message.into())
            );
        }
        for message in [
            "Access is denied. (os error 5)",
            "failed to receive message",
            "Failed to unregister hotkey: HotKey { .. }",
            "",
        ] {
            assert_eq!(
                hotkey_refusal(message.into()),
                HotkeyError::Failed(message.into())
            );
        }
    }

    #[test]
    fn a_stop_key_that_fails_otherwise_fails_the_session_without_saying_taken() {
        let mut effects = Record {
            hotkey_broken: true,
            ..Record::default()
        };
        let guard = start(&mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"0123abcd","reason":"停止键没能注册"}"#]
        );
        assert_eq!(effects.notices, Vec::<String>::new());
        assert!(!guard.is_polling());
    }

    #[test]
    fn the_tray_goes_back_to_the_state_only_after_the_key_was_taken() {
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        assert_eq!(effects.cleared, 0, "nothing to take back");

        // Taken: said once, then the next session that registers takes it back, once.
        let end = guard.on_event(&ended(), None);
        apply(&mut guard, end, &mut effects);
        effects.hotkey_fails = true;
        let actions = guard.on_event(&started("89abcdef"), Some((0.0, 0.0)));
        apply(&mut guard, actions, &mut effects);
        assert_eq!(effects.notices, vec![HOTKEY_TAKEN_NOTICE]);
        assert_eq!(effects.cleared, 0);
        effects.hotkey_fails = false;
        for label in ["01234567", "76543210"] {
            let actions = guard.on_event(&started(label), Some((0.0, 0.0)));
            apply(&mut guard, actions, &mut effects);
            let end = guard.on_event(&ended(), None);
            apply(&mut guard, end, &mut effects);
        }
        assert_eq!(effects.cleared, 1);
        assert_eq!(effects.notices, vec![HOTKEY_TAKEN_NOTICE]);
    }

    #[test]
    fn a_mouse_check_that_ends_stops_the_session_and_fails_the_next() {
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        effects.sent.clear();
        let ended_check = guard.mouse_check_ended();
        assert_eq!(ended_check, vec![GuardAction::Stop("mouse")]);
        apply(&mut guard, ended_check, &mut effects);
        assert_eq!(effects.sent, vec![r#"{"control":"stop","reason":"mouse"}"#]);
        assert_eq!(guard.mouse_check_ended(), vec![], "said once");
        assert_eq!(guard.mouse_ready(), Err(MOUSE_FAILED));

        let end = guard.on_event(&ended(), None);
        apply(&mut guard, end, &mut effects);
        effects.sent.clear();
        let actions = guard.on_event(&started("89abcdef"), Some((0.0, 0.0)));
        apply(&mut guard, actions, &mut effects);
        assert_eq!(
            effects.sent,
            vec![r#"{"control":"session-failed","label":"89abcdef","reason":"鼠标检测没能启动"}"#]
        );
        // With no session on, it only stops being counted on.
        let mut idle = Guard::new();
        idle.mouse_check_started();
        assert_eq!(idle.mouse_check_ended(), vec![]);
        assert_eq!(idle.mouse_ready(), Err(MOUSE_FAILED));
    }

    #[test]
    fn headed_only_changes_the_banner_s_words() {
        let mut effects = Record::default();
        let mut guard = start(&mut effects);
        effects.done.clear();
        let begin = guard.on_event(&DesktopEvent::HeadedBegin { seq: 1 }, None);
        apply(&mut guard, begin, &mut effects);
        let end = guard.on_event(&DesktopEvent::HeadedEnd { seq: 1 }, Some((0.0, 0.0)));
        apply(&mut guard, end, &mut effects);
        assert_eq!(
            effects.done,
            vec!["update headed=true", "update headed=false"]
        );
    }
}
