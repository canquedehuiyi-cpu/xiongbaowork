//! Keeping the runner alive, and knowing when to stop trying.
//!
//! The same three rules `openbot/desktop/src-tauri/src/supervise.rs` keeps for the self-hosted
//! stack, applied to one process:
//!
//! - **Restart, with backoff.** A runner that dies once, because a laptop slept through a network
//!   change or somebody killed it, comes back on its own, after a wait that doubles each time.
//! - **A limit.** A runner that dies `max_crashes` times in a row is broken, and restarting it
//!   forever turns that into a hot laptop and a log nobody can read. It is left stopped and the
//!   tray says so. A run that lasted longer than `stable_after` was healthy, so the count starts
//!   again after it.
//! - **A refusal is not a crash.** The runner exits with 2 when it refuses its arguments or its
//!   state (no token, paired to a different server). Starting it again gets the same answer.
//!
//! The loop is written against [`Launcher`] and [`Running`] so the tests can drive it with fake
//! children that crash on cue; [`crate::sidecar`] is the real launcher.

use crate::desktop_guard::{parse_desktop_line, DesktopEvent};
use serde::Serialize;
use std::io;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The runner's exit code for "I refuse these arguments or this state" (see `runner/src/index.ts`).
pub const REFUSED_EXIT_CODE: i32 = 2;

#[derive(Clone, Debug)]
pub struct Policy {
    /// Give up after this many crashes in a row.
    pub max_crashes: u32,
    /// A run at least this long was healthy: the next crash is counted as the first.
    pub stable_after: Duration,
    pub first_delay: Duration,
    pub max_delay: Duration,
    /// How long the runner is given to close its browser before it is killed.
    pub grace: Duration,
    /// How often a running child is checked.
    pub poll: Duration,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_crashes: 5,
            stable_after: Duration::from_secs(60),
            first_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(30),
            // The runner's own shutdown budget is 8 seconds (SHUTDOWN_BUDGET_MS).
            grace: Duration::from_secs(10),
            poll: Duration::from_millis(200),
        }
    }
}

impl Policy {
    /// The wait before restart number `attempt` (1-based): doubling from `first_delay`, capped.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let factor = 1u32 << attempt.saturating_sub(1).min(16);
        self.first_delay.saturating_mul(factor).min(self.max_delay)
    }
}

/// How a run ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Code(i32),
    /// Killed by a signal, or the status could not be read.
    Unknown,
}

impl From<std::process::ExitStatus> for Exit {
    fn from(status: std::process::ExitStatus) -> Self {
        status.code().map(Exit::Code).unwrap_or(Exit::Unknown)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Restart { attempt: u32, after: Duration },
    GiveUp { crashes: u32 },
    Refused,
}

/// Consecutive crashes, and what to do about the latest one.
#[derive(Default, Debug)]
pub struct Crashes {
    consecutive: u32,
}

impl Crashes {
    pub fn record(&mut self, policy: &Policy, exit: Exit, ran_for: Duration) -> Decision {
        if exit == Exit::Code(REFUSED_EXIT_CODE) {
            return Decision::Refused;
        }
        if ran_for >= policy.stable_after {
            self.consecutive = 0;
        }
        self.consecutive += 1;
        if self.consecutive >= policy.max_crashes {
            Decision::GiveUp {
                crashes: self.consecutive,
            }
        } else {
            Decision::Restart {
                attempt: self.consecutive,
                after: policy.backoff(self.consecutive),
            }
        }
    }
}

/// What the tray and the window show.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum State {
    Unpaired,
    Pairing,
    Starting,
    Online,
    Offline,
    #[serde(rename_all = "camelCase")]
    Restarting {
        attempt: u32,
        in_seconds: u64,
    },
    Failed {
        message: String,
    },
    Stopped,
}

impl State {
    /// The words for the tray. The window has its own copy in `ui/pairing.js`.
    pub fn label(&self) -> String {
        match self {
            State::Unpaired => "未配对".into(),
            State::Pairing => "正在配对…".into(),
            State::Starting => "正在连接…".into(),
            State::Online => "在线".into(),
            State::Offline => "离线，正在重连".into(),
            State::Restarting {
                attempt,
                in_seconds,
            } => format!("设备端服务已退出，{in_seconds} 秒后第 {attempt} 次重启"),
            State::Failed { message } => format!("出错：{message}"),
            State::Stopped => "已停止".into(),
        }
    }
}

/// What a line the runner printed means for the state.
#[derive(Debug, PartialEq, Eq)]
pub enum Signal {
    Paired,
    Connected,
    ConnectionLost,
    /// A desktop action needs a macOS grant this app does not have yet.
    DesktopPermission,
    /// The desktop session's other news, for its guard (`desktop_guard`). Not a connection state.
    Desktop(DesktopEvent),
}

/// Everything a line means: what [`classify`] reads, else one of the desktop session's events.
pub fn signal(line: &str) -> Option<Signal> {
    classify(line).or_else(|| parse_desktop_line(line).map(Signal::Desktop))
}

/// The runner's own log lines, from `runner/src/index.ts`, as connection states, and its
/// control-channel line `permission-needed` (`runner/src/desktop/control.ts`, read by
/// [`parse_desktop_line`]). The control channel's other events are for the desktop session's guard
/// ([`signal`]); none of them is a connection state.
pub fn classify(line: &str) -> Option<Signal> {
    let line = line.trim();
    if line.starts_with(crate::desktop_guard::CONTROL_LINE_PREFIX) {
        matches!(
            parse_desktop_line(line),
            Some(DesktopEvent::PermissionNeeded)
        )
        .then_some(Signal::DesktopPermission)
    } else if line.starts_with("runner: paired as ") {
        Some(Signal::Paired)
    } else if line.starts_with("runner: connected as ") {
        Some(Signal::Connected)
    } else if line.starts_with("runner: the connection failed") || line == "runner: disconnected" {
        Some(Signal::ConnectionLost)
    } else {
        None
    }
}

/// The most useful line of what the runner wrote to stderr before it stopped: Bun prints an uncaught
/// error as `error: <message>` among source lines and a stack, and the runner's own refusals are a
/// single line.
pub fn reason(stderr: &[String]) -> Option<String> {
    stderr
        .iter()
        .rev()
        .find_map(|line| line.trim().strip_prefix("error: ").map(str::to_string))
        .or_else(|| {
            stderr
                .iter()
                .rev()
                .map(|line| line.trim())
                .find(|line| !line.is_empty() && !line.starts_with("at "))
                .map(str::to_string)
        })
        .filter(|line| !line.is_empty())
}

/// Told about every change, on the supervisor's thread.
pub trait Observer: Send + Sync {
    fn changed(&self, state: &State);
    /// The runner said it paired. Called once, before the state becomes `Online`.
    fn paired(&self) {}
    /// The runner said a desktop action needs a permission: the card that grants it is shown.
    fn desktop_permission(&self) {}
    /// The runner said something about its desktop session (any event but `permission-needed`).
    fn desktop(&self, _event: DesktopEvent) {}
}

pub trait Running: Send {
    fn try_wait(&mut self) -> io::Result<Option<Exit>>;
    fn kill_tree(&mut self, grace: Duration);
}

/// The real child: the runner and everything it starts.
impl Running for crate::process_tree::Tree {
    fn try_wait(&mut self) -> io::Result<Option<Exit>> {
        crate::process_tree::Tree::try_wait(self).map(|status| status.map(Exit::from))
    }
    fn kill_tree(&mut self, grace: Duration) {
        crate::process_tree::Tree::kill_tree(self, grace)
    }
}

pub trait Launcher: Send + 'static {
    type Child: Running;
    /// Start the runner. `pairing` is true for the one run that is given the pairing code.
    fn launch(&mut self, pairing: bool, output: Output) -> io::Result<Self::Child>;
    /// Where the runner's output is kept, for the message shown when it is given up on.
    fn log_location(&self) -> String;
}

const STDERR_LINES: usize = 40;

struct Inner {
    state: State,
    stop: bool,
    paired: bool,
    stderr: Vec<String>,
}

struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
    observer: Box<dyn Observer>,
}

impl Shared {
    fn set(&self, state: State) {
        let mut inner = self.inner.lock().unwrap();
        if inner.state != state {
            inner.state = state.clone();
            drop(inner);
            self.observer.changed(&state);
        }
    }

    fn stopping(&self) -> bool {
        self.inner.lock().unwrap().stop
    }

    /// Sleep for `duration` unless asked to stop first. True when asked to stop.
    fn sleep(&self, duration: Duration) -> bool {
        let until = Instant::now() + duration;
        let mut inner = self.inner.lock().unwrap();
        while !inner.stop {
            let now = Instant::now();
            if now >= until {
                return false;
            }
            inner = self.wake.wait_timeout(inner, until - now).unwrap().0;
        }
        true
    }
}

/// Where a child's output goes: each line is handed over as it is read.
#[derive(Clone)]
pub struct Output(Arc<Shared>);

impl Output {
    pub fn stdout(&self, line: &str) {
        match signal(line) {
            Some(Signal::Paired) => {
                let first = {
                    let mut inner = self.0.inner.lock().unwrap();
                    !std::mem::replace(&mut inner.paired, true)
                };
                if first {
                    self.0.observer.paired();
                }
            }
            Some(Signal::Connected) => self.0.set(State::Online),
            Some(Signal::ConnectionLost) => self.0.set(State::Offline),
            Some(Signal::DesktopPermission) => self.0.observer.desktop_permission(),
            Some(Signal::Desktop(event)) => self.0.observer.desktop(event),
            None => {}
        }
    }

    pub fn stderr(&self, line: &str) {
        let mut inner = self.0.inner.lock().unwrap();
        if inner.stderr.len() == STDERR_LINES {
            inner.stderr.remove(0);
        }
        inner.stderr.push(line.to_string());
    }
}

/// A supervisor running on its own thread.
pub struct Supervisor {
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Supervisor {
    /// Start supervising. With `pairing`, the first run is the pairing run: if it stops before the
    /// runner says it paired, the pairing failed and nothing is restarted.
    pub fn start<L: Launcher>(
        launcher: L,
        policy: Policy,
        pairing: bool,
        observer: Box<dyn Observer>,
    ) -> Self {
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                state: State::Stopped,
                stop: false,
                paired: false,
                stderr: Vec::new(),
            }),
            wake: Condvar::new(),
            observer,
        });
        let running = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("device-supervisor".into())
            .spawn(move || run(launcher, policy, pairing, running))
            .expect("could not start the supervisor thread");
        Self {
            shared,
            thread: Some(thread),
        }
    }

    /// The window reads the observer's copy; this one is for the tests.
    #[cfg(test)]
    pub fn state(&self) -> State {
        self.shared.inner.lock().unwrap().state.clone()
    }

    /// Stop the runner and everything it started, and wait for that to finish.
    pub fn stop(&mut self) {
        self.shared.inner.lock().unwrap().stop = true;
        self.shared.wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run<L: Launcher>(mut launcher: L, policy: Policy, mut pairing: bool, shared: Arc<Shared>) {
    let mut crashes = Crashes::default();
    loop {
        if shared.stopping() {
            shared.set(State::Stopped);
            return;
        }
        shared.set(if pairing {
            State::Pairing
        } else {
            State::Starting
        });
        shared.inner.lock().unwrap().stderr.clear();
        let started = Instant::now();
        let mut child = match launcher.launch(pairing, Output(Arc::clone(&shared))) {
            Ok(child) => child,
            Err(error) => {
                shared.set(State::Failed {
                    message: format!("无法启动设备端服务：{error}"),
                });
                return;
            }
        };

        let exit = loop {
            if shared.stopping() {
                child.kill_tree(policy.grace);
                shared.set(State::Stopped);
                return;
            }
            match child.try_wait() {
                Ok(Some(exit)) => break exit,
                Ok(None) => {}
                Err(_) => break Exit::Unknown,
            }
            let inner = shared.inner.lock().unwrap();
            if !inner.stop {
                drop(shared.wake.wait_timeout(inner, policy.poll).unwrap());
            }
        };
        // Whatever the runner left running is not left running.
        child.kill_tree(Duration::ZERO);
        let said = reason(&shared.inner.lock().unwrap().stderr);

        if pairing {
            if !shared.inner.lock().unwrap().paired {
                shared.set(State::Failed {
                    message: match said {
                        Some(said) => format!("配对失败：{said}"),
                        None => "配对失败，设备端服务没有说明原因。".into(),
                    },
                });
                return;
            }
            // Paired, then stopped: from now on it is an ordinary runner and is restarted as one.
            pairing = false;
        }

        match crashes.record(&policy, exit, started.elapsed()) {
            Decision::Restart { attempt, after } => {
                shared.set(State::Restarting {
                    attempt,
                    in_seconds: after.as_secs_f64().ceil() as u64,
                });
                if shared.sleep(after) {
                    shared.set(State::Stopped);
                    return;
                }
            }
            Decision::GiveUp { crashes } => {
                shared.set(State::Failed {
                    message: format!(
                        "设备端服务连续 {crashes} 次异常退出，已停止自动重启。日志：{}",
                        launcher.log_location()
                    ),
                });
                return;
            }
            Decision::Refused => {
                shared.set(State::Failed {
                    message: said.unwrap_or_else(|| "设备端服务拒绝启动。".into()),
                });
                return;
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// An `Output` that leads nowhere, for a launcher started outside a supervisor.
    pub(crate) fn output() -> Output {
        Output(Arc::new(Shared {
            inner: Mutex::new(Inner {
                state: State::Stopped,
                stop: false,
                paired: false,
                stderr: Vec::new(),
            }),
            wake: Condvar::new(),
            observer: Box::new(Quiet),
        }))
    }

    fn quick() -> Policy {
        Policy {
            max_crashes: 4,
            stable_after: Duration::from_secs(60),
            first_delay: Duration::from_millis(10),
            max_delay: Duration::from_millis(40),
            grace: Duration::from_millis(50),
            poll: Duration::from_millis(5),
        }
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        let policy = Policy::default();
        let waits: Vec<u64> = (1..=7).map(|n| policy.backoff(n).as_secs()).collect();
        assert_eq!(waits, vec![1, 2, 4, 8, 16, 30, 30]);
        assert_eq!(policy.backoff(1000), Duration::from_secs(30));
    }

    #[test]
    fn crashes_in_a_row_are_restarted_until_the_limit() {
        let policy = quick();
        let mut crashes = Crashes::default();
        let short = Duration::from_secs(1);
        for attempt in 1..policy.max_crashes {
            assert_eq!(
                crashes.record(&policy, Exit::Code(1), short),
                Decision::Restart {
                    attempt,
                    after: policy.backoff(attempt)
                }
            );
        }
        assert_eq!(
            crashes.record(&policy, Exit::Unknown, short),
            Decision::GiveUp {
                crashes: policy.max_crashes
            }
        );
    }

    #[test]
    fn a_long_healthy_run_resets_the_count() {
        let policy = quick();
        let mut crashes = Crashes::default();
        for _ in 1..policy.max_crashes {
            crashes.record(&policy, Exit::Code(1), Duration::ZERO);
        }
        assert_eq!(
            crashes.record(&policy, Exit::Code(0), policy.stable_after),
            Decision::Restart {
                attempt: 1,
                after: policy.backoff(1)
            },
            "an hour of work followed by one exit is a first problem, not the last straw"
        );
    }

    #[test]
    fn a_refusal_is_not_retried() {
        let mut crashes = Crashes::default();
        assert_eq!(
            crashes.record(&quick(), Exit::Code(REFUSED_EXIT_CODE), Duration::ZERO),
            Decision::Refused
        );
    }

    #[test]
    fn runner_lines_are_read_as_states() {
        assert_eq!(classify("runner: paired as 6f1c…"), Some(Signal::Paired));
        assert_eq!(
            classify("runner: connected as abc"),
            Some(Signal::Connected)
        );
        assert_eq!(
            classify("runner: the connection failed; retrying in a moment"),
            Some(Signal::ConnectionLost)
        );
        assert_eq!(
            classify("runner: disconnected"),
            Some(Signal::ConnectionLost)
        );
        assert_eq!(classify("runner: closing any open browser"), None);
    }

    #[test]
    fn a_permission_line_is_classified() {
        assert_eq!(
            classify(r#"runner: desktop {"event":"permission-needed"}"#),
            Some(Signal::DesktopPermission)
        );
        assert_eq!(
            classify("  runner: desktop {\"event\": \"permission-needed\"}\r"),
            Some(Signal::DesktopPermission)
        );
    }

    #[test]
    fn other_desktop_lines_are_not_mistaken_for_a_state() {
        // The control channel's other events are for later; none of them is a connection state.
        for line in [
            r#"runner: desktop {"event":"session-started","label":"0123abcd"}"#,
            r#"runner: desktop {"event":"session-ended","reason":"stopped"}"#,
            r#"runner: desktop {"event":"headed-begin","seq":1}"#,
            r#"runner: desktop {"event":"headed-end","seq":1}"#,
            r#"runner: desktop {"event":"connected as d"}"#,
            r#"runner: desktop {"event":"permission-needed""#,
            r#"runner: desktop ["permission-needed"]"#,
            "runner: desktop permission-needed",
            "runner: desktop ",
        ] {
            assert_eq!(classify(line), None, "{line}");
        }
    }

    #[test]
    fn desktop_lines_are_signals_for_the_guard() {
        assert_eq!(
            signal(r#"runner: desktop {"event":"session-started","label":"0123abcd"}"#),
            Some(Signal::Desktop(DesktopEvent::SessionStarted {
                label: "0123abcd".into()
            }))
        );
        assert_eq!(
            signal(r#"runner: desktop {"event":"headed-end","seq":4}"#),
            Some(Signal::Desktop(DesktopEvent::HeadedEnd { seq: 4 }))
        );
        // The permission line keeps its own signal, and the states read as before.
        assert_eq!(
            signal(r#"runner: desktop {"event":"permission-needed"}"#),
            Some(Signal::DesktopPermission)
        );
        assert_eq!(signal("runner: connected as d"), Some(Signal::Connected));
        assert_eq!(
            signal(r#"runner: desktop {"event":"connected as d"}"#),
            None
        );
        assert_eq!(signal("runner: closing any open browser"), None);
    }

    #[test]
    fn the_reason_is_bun_s_error_line_or_the_last_line() {
        let bun = [
            "283 |     throw new Error(".to_string(),
            "error: 该配对码无效或已过期。".to_string(),
            "      at pair (/$bunfs/root/xiongbao-runner:1:2)".to_string(),
        ];
        assert_eq!(reason(&bun).as_deref(), Some("该配对码无效或已过期。"));
        let refusal = ["runner: this machine is already paired to https://a".to_string()];
        assert_eq!(
            reason(&refusal).as_deref(),
            Some("runner: this machine is already paired to https://a")
        );
        assert_eq!(reason(&[]), None);
    }

    // ---- The loop, with fake children. ----

    /// A fake run: the lines it prints, then how it ends (None: runs until killed).
    #[derive(Clone)]
    struct Script {
        stdout: Vec<&'static str>,
        stderr: Vec<&'static str>,
        exit: Option<Exit>,
    }

    fn crash() -> Script {
        Script {
            stdout: vec![],
            stderr: vec!["error: boom"],
            exit: Some(Exit::Code(1)),
        }
    }

    fn online() -> Script {
        Script {
            stdout: vec!["runner: connected as d"],
            stderr: vec![],
            exit: None,
        }
    }

    #[derive(Default)]
    struct Record {
        launches: Vec<(Instant, bool)>,
        killed: Vec<Duration>,
        states: Vec<State>,
        paired: u32,
        permission: u32,
        desktop: Vec<DesktopEvent>,
    }

    struct FakeChild {
        exit: Option<Exit>,
        killed: bool,
        record: Arc<Mutex<Record>>,
    }

    impl Running for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<Exit>> {
            Ok(if self.killed {
                Some(Exit::Unknown)
            } else {
                self.exit
            })
        }
        fn kill_tree(&mut self, grace: Duration) {
            if !self.killed && self.exit.is_none() {
                self.killed = true;
                self.record.lock().unwrap().killed.push(grace);
            }
        }
    }

    struct FakeLauncher {
        scripts: VecDeque<Script>,
        record: Arc<Mutex<Record>>,
    }

    impl Launcher for FakeLauncher {
        type Child = FakeChild;
        fn launch(&mut self, pairing: bool, output: Output) -> io::Result<FakeChild> {
            self.record
                .lock()
                .unwrap()
                .launches
                .push((Instant::now(), pairing));
            let script = self.scripts.pop_front().unwrap_or_else(online);
            for line in &script.stderr {
                output.stderr(line);
            }
            for line in &script.stdout {
                output.stdout(line);
            }
            Ok(FakeChild {
                exit: script.exit,
                killed: false,
                record: Arc::clone(&self.record),
            })
        }
        fn log_location(&self) -> String {
            "/logs/runner.log".into()
        }
    }

    struct Watcher(Arc<Mutex<Record>>);

    impl Observer for Watcher {
        fn changed(&self, state: &State) {
            self.0.lock().unwrap().states.push(state.clone());
        }
        fn paired(&self) {
            self.0.lock().unwrap().paired += 1;
        }
        fn desktop_permission(&self) {
            self.0.lock().unwrap().permission += 1;
        }
        fn desktop(&self, event: DesktopEvent) {
            self.0.lock().unwrap().desktop.push(event);
        }
    }

    fn supervise(
        scripts: Vec<Script>,
        policy: Policy,
        pairing: bool,
    ) -> (Supervisor, Arc<Mutex<Record>>) {
        let record = Arc::new(Mutex::new(Record::default()));
        let launcher = FakeLauncher {
            scripts: scripts.into(),
            record: Arc::clone(&record),
        };
        let supervisor = Supervisor::start(
            launcher,
            policy,
            pairing,
            Box::new(Watcher(Arc::clone(&record))),
        );
        (supervisor, record)
    }

    fn until(supervisor: &Supervisor, want: impl Fn(&State) -> bool) -> State {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state = supervisor.state();
            if want(&state) {
                return state;
            }
            assert!(Instant::now() < deadline, "stuck in {state:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn a_killed_runner_is_restarted_with_growing_waits_and_comes_back_online() {
        let policy = quick();
        let (supervisor, record) =
            supervise(vec![crash(), crash(), online()], policy.clone(), false);
        until(&supervisor, |s| *s == State::Online);

        let record = record.lock().unwrap();
        assert_eq!(record.launches.len(), 3);
        let gaps: Vec<Duration> = record
            .launches
            .windows(2)
            .map(|pair| pair[1].0 - pair[0].0)
            .collect();
        assert!(
            gaps[0] >= policy.backoff(1),
            "restarted before its backoff: {gaps:?}"
        );
        assert!(
            gaps[1] >= policy.backoff(2),
            "the second wait did not grow: {gaps:?}"
        );
        assert!(record.states.contains(&State::Restarting {
            attempt: 1,
            in_seconds: 1
        }));
        assert!(record.states.contains(&State::Restarting {
            attempt: 2,
            in_seconds: 1
        }));
        assert!(record.launches.iter().all(|(_, pairing)| !pairing));
    }

    #[test]
    fn after_n_crashes_in_a_row_it_stops_and_says_so() {
        let policy = quick();
        let (supervisor, record) = supervise(vec![crash(); 10], policy.clone(), false);
        let state = until(&supervisor, |s| matches!(s, State::Failed { .. }));
        std::thread::sleep(Duration::from_millis(100));

        assert_eq!(
            record.lock().unwrap().launches.len() as u32,
            policy.max_crashes,
            "started again after it was given up on"
        );
        let State::Failed { message } = state else {
            unreachable!()
        };
        assert!(
            message.contains(&policy.max_crashes.to_string()),
            "{message}"
        );
        assert!(
            message.contains("/logs/runner.log"),
            "must point at the log: {message}"
        );
        assert!(State::Failed { message }.label().starts_with("出错"));
    }

    #[test]
    fn a_refusing_runner_is_not_restarted_and_its_reason_is_shown() {
        let refused = Script {
            stdout: vec![],
            stderr: vec!["runner: this machine is already paired to https://other"],
            exit: Some(Exit::Code(REFUSED_EXIT_CODE)),
        };
        let (supervisor, record) = supervise(vec![refused], quick(), false);
        let state = until(&supervisor, |s| matches!(s, State::Failed { .. }));
        assert_eq!(
            state,
            State::Failed {
                message: "runner: this machine is already paired to https://other".into()
            }
        );
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(record.lock().unwrap().launches.len(), 1);
    }

    #[test]
    fn a_failed_pairing_shows_the_server_s_reason_and_is_not_retried() {
        let rejected = Script {
            stdout: vec![],
            stderr: vec!["error: 该配对码无效或已过期。", "    at pair (x)"],
            exit: Some(Exit::Code(1)),
        };
        let (supervisor, record) = supervise(vec![rejected], quick(), true);
        let state = until(&supervisor, |s| matches!(s, State::Failed { .. }));
        assert_eq!(
            state,
            State::Failed {
                message: "配对失败：该配对码无效或已过期。".into()
            }
        );
        std::thread::sleep(Duration::from_millis(50));
        let record = record.lock().unwrap();
        assert_eq!(record.launches.len(), 1, "a pairing code is single use");
        assert_eq!(record.paired, 0);
    }

    #[test]
    fn a_paired_runner_is_restarted_without_the_pairing_code() {
        let paired_then_crashed = Script {
            stdout: vec!["runner: paired as d", "runner: connected as d"],
            stderr: vec![],
            exit: Some(Exit::Code(1)),
        };
        let (supervisor, record) = supervise(vec![paired_then_crashed, online()], quick(), true);
        until(&supervisor, |s| *s == State::Online);
        std::thread::sleep(Duration::from_millis(20));
        let record = record.lock().unwrap();
        let pairing: Vec<bool> = record.launches.iter().map(|(_, p)| *p).collect();
        assert_eq!(pairing, vec![true, false]);
        assert_eq!(record.paired, 1);
        assert_eq!(record.states.first(), Some(&State::Pairing));
    }

    #[test]
    fn stopping_kills_the_runner_tree_with_the_grace_period() {
        let policy = quick();
        let (mut supervisor, record) = supervise(vec![online()], policy.clone(), false);
        until(&supervisor, |s| *s == State::Online);
        supervisor.stop();
        assert_eq!(supervisor.state(), State::Stopped);
        assert_eq!(record.lock().unwrap().killed, vec![policy.grace]);
    }

    #[test]
    fn stopping_during_a_backoff_does_not_start_it_again() {
        let mut policy = quick();
        policy.first_delay = Duration::from_secs(30);
        policy.max_delay = Duration::from_secs(30);
        let (mut supervisor, record) = supervise(vec![crash()], policy, false);
        until(&supervisor, |s| matches!(s, State::Restarting { .. }));
        let asked = Instant::now();
        supervisor.stop();
        assert!(
            asked.elapsed() < Duration::from_secs(5),
            "waited out the backoff"
        );
        assert_eq!(supervisor.state(), State::Stopped);
        assert_eq!(record.lock().unwrap().launches.len(), 1);
    }

    #[test]
    fn the_connection_state_follows_the_runner_s_log() {
        let flapping = Script {
            stdout: vec![
                "runner: connected as d",
                "runner: the connection failed; retrying in a moment",
            ],
            stderr: vec![],
            exit: None,
        };
        let (mut supervisor, record) = supervise(vec![flapping], quick(), false);
        until(&supervisor, |s| *s == State::Offline);
        supervisor.stop();
        let states = record.lock().unwrap().states.clone();
        assert_eq!(
            states,
            vec![
                State::Starting,
                State::Online,
                State::Offline,
                State::Stopped
            ]
        );
    }

    #[test]
    fn a_permission_line_brings_the_card_up_and_leaves_the_state_alone() {
        let asking = Script {
            stdout: vec![
                "runner: connected as d",
                r#"runner: desktop {"event":"session-started","label":"0123abcd"}"#,
                r#"runner: desktop {"event":"permission-needed"}"#,
            ],
            stderr: vec![],
            exit: None,
        };
        let (mut supervisor, record) = supervise(vec![asking], quick(), false);
        until(&supervisor, |s| *s == State::Online);
        supervisor.stop();
        let record = record.lock().unwrap();
        assert_eq!(record.permission, 1);
        assert_eq!(
            record.states,
            vec![State::Starting, State::Online, State::Stopped]
        );
    }

    #[test]
    fn the_session_s_lines_reach_the_observer_in_order_and_leave_the_state_alone() {
        let session = Script {
            stdout: vec![
                "runner: connected as d",
                r#"runner: desktop {"event":"session-started","label":"0123abcd"}"#,
                r#"runner: desktop {"event":"headed-begin","seq":1}"#,
                r#"runner: desktop {"event":"permission-needed"}"#,
                r#"runner: desktop {"event":"headed-end","seq":1}"#,
                r#"runner: desktop {"event":"session-ended","reason":"stopped"}"#,
            ],
            stderr: vec![],
            exit: None,
        };
        let (mut supervisor, record) = supervise(vec![session], quick(), false);
        until(&supervisor, |s| *s == State::Online);
        supervisor.stop();
        let record = record.lock().unwrap();
        assert_eq!(
            record.desktop,
            vec![
                DesktopEvent::SessionStarted {
                    label: "0123abcd".into()
                },
                DesktopEvent::HeadedBegin { seq: 1 },
                DesktopEvent::HeadedEnd { seq: 1 },
                DesktopEvent::SessionEnded {
                    reason: "stopped".into()
                },
            ]
        );
        assert_eq!(record.permission, 1);
        assert_eq!(
            record.states,
            vec![State::Starting, State::Online, State::Stopped]
        );
    }

    // ---- The loop, with a real process. ----

    struct RealCrasher {
        launches: Arc<Mutex<u32>>,
    }

    impl Launcher for RealCrasher {
        type Child = crate::process_tree::Tree;
        fn launch(&mut self, _pairing: bool, _output: Output) -> io::Result<Self::Child> {
            *self.launches.lock().unwrap() += 1;
            crate::process_tree::spawn(crate::process_tree::tests::fake("exit:1"))
        }
        fn log_location(&self) -> String {
            "log".into()
        }
    }

    struct Quiet;
    impl Observer for Quiet {
        fn changed(&self, _: &State) {}
    }

    #[test]
    fn a_real_process_that_keeps_crashing_is_given_up_on() {
        let launches = Arc::new(Mutex::new(0));
        let policy = quick();
        let supervisor = Supervisor::start(
            RealCrasher {
                launches: Arc::clone(&launches),
            },
            policy.clone(),
            false,
            Box::new(Quiet),
        );
        until(&supervisor, |s| matches!(s, State::Failed { .. }));
        assert_eq!(*launches.lock().unwrap(), policy.max_crashes);
    }
}
