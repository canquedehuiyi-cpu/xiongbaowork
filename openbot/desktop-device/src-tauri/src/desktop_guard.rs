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
/// What registering the stop key says until the key is wired up.
pub const HOTKEY_MISSING: &str = "停止键尚未接入";

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
    /// A stop was said for this session: it is the runner's to end, and is not said again.
    stopped: bool,
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

    /// 有会话、不在真实输入期间、相对起点在任一方向移动 ≥ 3 px 时，回 Stop("mouse")。
    pub fn on_cursor(&mut self, pos: (f64, f64)) -> Option<GuardAction> {
        if !self.is_polling() {
            return None;
        }
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
        *self = Guard::default();
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
    fn hide_banner(&mut self);
    fn register_hotkey(&mut self) -> Result<(), String>;
    fn unregister_hotkey(&mut self);
    /// One line to the runner's stdin.
    fn send(&mut self, line: &str);
}

/// Carry `actions` out, in order. Once the banner or the stop key fails, nothing more is brought up
/// or promised in this batch (no later banner, key, ack or ready); hiding, unregistering and stops
/// still go through. A session being set up then gets its answer from [`Guard::on_setup`], and those
/// actions are carried out too.
pub fn apply(guard: &mut Guard, actions: Vec<GuardAction>, effects: &mut dyn Effects) {
    let mut failed: Option<&'static str> = None;
    for action in actions {
        match action {
            GuardAction::ShowBanner { headed } => {
                if failed.is_none() {
                    if let Err(error) = effects.show_banner(headed) {
                        eprintln!("[device] the desktop banner did not come up: {error}");
                        failed = Some(BANNER_FAILED);
                    }
                }
            }
            GuardAction::RegisterHotkey => {
                if failed.is_none() {
                    if let Err(error) = effects.register_hotkey() {
                        eprintln!("[device] the stop key was not registered: {error}");
                        failed = Some(HOTKEY_FAILED);
                    }
                }
            }
            GuardAction::HideBanner => effects.hide_banner(),
            GuardAction::UnregisterHotkey => effects.unregister_hotkey(),
            GuardAction::SendAck(_) | GuardAction::SendReady { .. } if failed.is_some() => {}
            other => {
                if let Some(line) = control_line(&other) {
                    effects.send(&line);
                }
            }
        }
    }
    if guard.setting_up() {
        let answer = guard.on_setup(failed.map_or(Ok(()), Err));
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
        hotkey_fails: bool,
        done: Vec<String>,
        sent: Vec<String>,
    }

    impl Effects for Record {
        fn show_banner(&mut self, headed: bool) -> Result<(), String> {
            if self.banner_fails {
                return Err("no window".into());
            }
            self.done.push(format!("show headed={headed}"));
            Ok(())
        }
        fn hide_banner(&mut self) {
            self.done.push("hide".into());
        }
        fn register_hotkey(&mut self) -> Result<(), String> {
            if self.hotkey_fails {
                return Err(HOTKEY_MISSING.into());
            }
            self.done.push("register".into());
            Ok(())
        }
        fn unregister_hotkey(&mut self) {
            self.done.push("unregister".into());
        }
        fn send(&mut self, line: &str) {
            self.sent.push(line.into());
        }
    }

    fn start(effects: &mut Record) -> Guard {
        let mut guard = Guard::new();
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
}
