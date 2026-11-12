//! The runner as this app starts it: the compiled `xiongbao-runner` sidecar, its arguments, where
//! its files go, and which browser it is pointed at.
//!
//! Everything the runner writes goes under one directory in the app's data directory, passed as
//! `--data-dir` (F2 stage 0): its token, its action journal, the workspace and the browser
//! profiles. It is also started *in* that directory, so nothing can land wherever the app happened
//! to be launched from.

use crate::supervise::{Launcher, Output};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// The sidecar's name, as `externalBin` places it next to this app's own executable.
pub const SIDECAR: &str = "xiongbao-runner";

/// The desktop helper's name, shipped next to this app's own executable like the sidecar. The
/// runner reads the desktop through it on macOS and Linux (and on Windows when asked for).
pub const AGENT_DESKTOP: &str = "agent-desktop";

/// What earlier releases called the sidecar. An app that crashed (or was upgraded in place while
/// running) can leave one of these alive in the install directory, still holding the runner's data
/// directory, so the first start of this version stops it.
pub const LEGACY_SIDECAR: &str = "openbot-runner";

/// A path as comparable text: Windows' `\\?\` verbatim prefix dropped (`canonicalize` adds it, WMI
/// does not), separators unified, no trailing slash, and a drive-letter path lower-cased because
/// Windows paths are case-insensitive. Text rather than `Path` so the Windows forms can be tested,
/// and behave the same, on every platform.
fn comparable(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    let mut text = path.replace('\\', "/");
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    let drive = text.as_bytes().get(1) == Some(&b':') && text.as_bytes()[0].is_ascii_alphabetic();
    if drive {
        text.make_ascii_lowercase();
    }
    text
}

/// Pids among `processes` (`pid`, executable path) that are a leftover legacy runner of *this* app:
/// named exactly `openbot-runner` (+ the platform suffix) and living directly in `install_dir`.
/// A same-named program anywhere else is somebody else's and is left alone.
pub fn legacy_runner_pids(
    processes: &[(u32, PathBuf)],
    install_dir: &Path,
    exe_suffix: &str,
) -> Vec<u32> {
    let wanted = comparable(&format!("{LEGACY_SIDECAR}{exe_suffix}"));
    let dir = comparable(&install_dir.to_string_lossy());
    processes
        .iter()
        .filter(|(_, exe)| {
            // Linux reports an executable replaced by a package upgrade as "<path> (deleted)",
            // which is exactly the orphan this is looking for.
            let text = exe.to_string_lossy();
            let text = text.strip_suffix(" (deleted)").unwrap_or(&text);
            let full = comparable(text);
            let Some((parent, name)) = full.rsplit_once('/') else {
                return false;
            };
            // `wanted` is already lower-case-safe for the .exe case: compare ignoring case only
            // for drive-letter (Windows) paths, which `comparable` lower-cased.
            let name_matches = if parent.as_bytes().get(1) == Some(&b':') {
                name.eq_ignore_ascii_case(&wanted)
            } else {
                name == wanted
            };
            name_matches && parent == dir
        })
        .map(|(pid, _)| *pid)
        .collect()
}

/// `command`'s stdout, or None if it fails or has not finished within `limit` (then it is killed).
/// The process listing must not be able to hang the supervisor thread that `stop()` waits for.
#[cfg(any(target_os = "macos", windows))]
fn stdout_within(mut command: Command, limit: std::time::Duration) -> Option<String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        bytes
    });
    let until = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().ok()?;
                return status
                    .success()
                    .then(|| String::from_utf8_lossy(&bytes).into_owned());
            }
            Ok(None) if std::time::Instant::now() < until => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
const LISTING_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

/// `(pid, executable path)` of every process this user can inspect. Best effort: empty if the
/// platform tool is missing, which only means a stale runner is not found.
fn running_executables() -> Vec<(u32, PathBuf)> {
    #[cfg(target_os = "linux")]
    {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
                Some((pid, std::fs::read_link(entry.path().join("exe")).ok()?))
            })
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        // On macOS `comm` is the full executable path.
        let mut ps = Command::new("ps");
        ps.args(["-A", "-o", "pid=", "-o", "comm="]);
        let Some(text) = stdout_within(ps, LISTING_LIMIT) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let (pid, path) = line.trim_start().split_once(' ')?;
                Some((pid.parse().ok()?, PathBuf::from(path.trim())))
            })
            .collect()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let filter = format!("Name = '{LEGACY_SIDECAR}.exe'");
        let mut powershell = Command::new("powershell");
        powershell
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "Get-CimInstance Win32_Process -Filter \"{filter}\" | ForEach-Object {{ \"$($_.ProcessId) $($_.ExecutablePath)\" }}"
            ))
            .creation_flags(CREATE_NO_WINDOW);
        let Some(text) = stdout_within(powershell, LISTING_LIMIT) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let (pid, path) = line.trim().split_once(' ')?;
                Some((pid.parse().ok()?, PathBuf::from(path.trim())))
            })
            .collect()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

/// Whether a legacy runner of this install could be running, so the process table is worth listing.
/// Windows cannot delete a running executable, so with no `openbot-runner.exe` in the install
/// directory none of this install's is running, and the slow WMI query is skipped. Unix can: a
/// package upgrade unlinks the old file while it runs (the " (deleted)" orphan above), so there a
/// missing file proves nothing and the listing, a cheap one, always runs.
pub fn legacy_runner_possible(
    legacy_file_exists: bool,
    running_files_can_be_removed: bool,
) -> bool {
    legacy_file_exists || running_files_can_be_removed
}

/// Stop a runner left over from before the rename, if one is running from this app's install
/// directory. Runs once per app process: an orphan from before the upgrade can only exist at the
/// first start, and later restarts must not pay for (or hang on) a process listing.
pub fn stop_legacy_runners() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(stop_legacy_runners_now);
}

fn stop_legacy_runners_now() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else { return };
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    let legacy_file = dir.join(format!("{LEGACY_SIDECAR}{}", std::env::consts::EXE_SUFFIX));
    if !legacy_runner_possible(legacy_file.exists(), !cfg!(windows)) {
        return;
    }
    for pid in legacy_runner_pids(&running_executables(), &dir, std::env::consts::EXE_SUFFIX) {
        #[cfg(unix)]
        {
            // SAFETY: kill only sends a signal; a pid that is gone is an ESRCH, which is the goal.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
            // Signal 0 only checks that the process is still there.
            let alive = || unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
            for _ in 0..40 {
                if !alive() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            // Only if it ignored SIGTERM: a pid that is gone may already belong to someone else.
            if alive() {
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output();
        }
    }
}

/// What this app remembers about a pairing. Not the token: that is the runner's, in its data dir.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    pub server: String,
    /// The name shown on the My Devices screen. None: the runner uses the machine's hostname.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Settings {
    pub fn load(file: &Path) -> Option<Settings> {
        let text = std::fs::read_to_string(file).ok()?;
        let settings: Settings = serde_json::from_str(&text).ok()?;
        normalize_server(&settings.server).ok()?;
        Some(settings)
    }

    pub fn save(&self, file: &Path) -> io::Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        let temporary = file.with_extension("json.tmp");
        std::fs::write(&temporary, text)?;
        std::fs::rename(temporary, file)
    }
}

/// The server address the runner accepts: http(s), no trailing slash.
pub fn normalize_server(input: &str) -> Result<String, String> {
    let input = input.trim();
    let scheme = ["https://", "http://"]
        .into_iter()
        .find(|scheme| input.starts_with(scheme))
        .ok_or_else(|| "服务器地址需要以 https:// 或 http:// 开头。".to_string())?;
    let rest = input[scheme.len()..].trim_end_matches('/');
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return Err("服务器地址不完整。".into());
    }
    Ok(format!("{scheme}{rest}"))
}

/// What the pairing form sent, checked again here because the window is not the only caller.
pub fn validate_pairing(
    server: &str,
    code: &str,
    name: &str,
) -> Result<(Settings, String), String> {
    let server = normalize_server(server)?;
    let code = code.trim();
    if code.is_empty() {
        return Err("请输入配对码。".into());
    }
    if code.len() > 64 || code.chars().any(char::is_whitespace) {
        return Err("配对码格式不正确。".into());
    }
    let name = name.trim();
    if name.chars().count() > 120 {
        return Err("设备名称不能超过 120 个字符。".into());
    }
    Ok((
        Settings {
            server,
            name: (!name.is_empty()).then(|| name.to_string()),
        },
        code.to_string(),
    ))
}

/// The runner's command line. `pair` only for the run that pairs: a code is single use, and a
/// restart that sent it again would be refused by the server.
pub fn runner_args(
    settings: &Settings,
    data_dir: &Path,
    pair: Option<&str>,
    browser: Option<&Path>,
    desktop_helper: Option<&Path>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--server".into(),
        settings.server.clone().into(),
        "--data-dir".into(),
        data_dir.as_os_str().to_owned(),
    ];
    if let Some(name) = &settings.name {
        args.extend(["--name".into(), name.into()]);
    }
    if let Some(code) = pair {
        args.extend(["--pair".into(), code.into()]);
    }
    if let Some(browser) = browser {
        args.extend([
            "--browser-executable".into(),
            browser.as_os_str().to_owned(),
        ]);
    }
    if let Some(helper) = desktop_helper {
        args.extend(["--desktop-helper".into(), helper.as_os_str().to_owned()]);
    }
    args
}

/// Where Chrome, Edge and Chromium are installed on this operating system, in order of preference.
/// D9: no browser is bundled, so the runner can only use one of these.
pub fn browser_candidates(env: &dyn Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        for root in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = env(root) {
                let root = PathBuf::from(root);
                candidates.push(root.join(r"Google\Chrome\Application\chrome.exe"));
                candidates.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
            }
        }
    } else if cfg!(target_os = "macos") {
        let mut roots = vec![PathBuf::from("/Applications")];
        if let Some(home) = env("HOME") {
            roots.push(PathBuf::from(home).join("Applications"));
        }
        for root in roots {
            for app in [
                "Google Chrome.app/Contents/MacOS/Google Chrome",
                "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "Chromium.app/Contents/MacOS/Chromium",
            ] {
                candidates.push(root.join(app));
            }
        }
    } else {
        for path in [
            "/opt/google/chrome/chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/opt/microsoft/msedge/msedge",
            "/usr/bin/microsoft-edge-stable",
            "/usr/bin/microsoft-edge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ] {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates
}

pub fn detect_browser(candidates: &[PathBuf], exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.iter().find(|path| exists(path)).cloned()
}

/// The sidecar next to this executable, where Tauri's `externalBin` puts it in every bundle.
///
/// A debug build also honours `OPENBOT_RUNNER_BINARY`, so the shell can be run with `cargo run`
/// against a runner compiled by `scripts/build-sidecar.ts` without bundling.
pub fn sidecar_path() -> io::Result<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("OPENBOT_RUNNER_BINARY") {
            return Ok(PathBuf::from(path));
        }
    }
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("the app's executable has no directory"))?;
    Ok(dir.join(format!("{SIDECAR}{}", std::env::consts::EXE_SUFFIX)))
}

/// The desktop helper next to this executable, where the sidecar is.
///
/// A debug build also honours `OPENBOT_AGENT_DESKTOP_BINARY`, as `sidecar_path` does
/// `OPENBOT_RUNNER_BINARY`. Whether the file is there is found out by the runner, when a desktop
/// action first needs it.
pub fn agent_desktop_path() -> io::Result<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(path) = std::env::var_os("OPENBOT_AGENT_DESKTOP_BINARY") {
            return Ok(PathBuf::from(path));
        }
    }
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| io::Error::other("the app's executable has no directory"))?;
    Ok(dir.join(format!("{AGENT_DESKTOP}{}", std::env::consts::EXE_SUFFIX)))
}

/// Starts the compiled runner, writes its output to a log, and hands each line to the supervisor.
pub struct RunnerLauncher {
    pub program: PathBuf,
    pub data_dir: PathBuf,
    pub settings: Settings,
    /// Taken by the first launch.
    pub pair_code: Option<String>,
    pub browser: Option<PathBuf>,
    /// The agent-desktop binary, passed as `--desktop-helper`. None: the runner looks next to itself.
    pub desktop_helper: Option<PathBuf>,
    pub log: PathBuf,
}

/// Log files bigger than this are started again rather than appended to.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

impl RunnerLauncher {
    pub fn command(&mut self, pairing: bool) -> Command {
        let code = if pairing { self.pair_code.take() } else { None };
        let mut command = Command::new(&self.program);
        command
            .args(runner_args(
                &self.settings,
                &self.data_dir,
                code.as_deref(),
                self.browser.as_deref(),
                self.desktop_helper.as_deref(),
            ))
            .current_dir(&self.data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn open_log(&self) -> io::Result<std::fs::File> {
        if let Some(parent) = self.log.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let large = std::fs::metadata(&self.log)
            .map(|meta| meta.len() > LOG_LIMIT)
            .unwrap_or(false);
        std::fs::OpenOptions::new()
            .create(true)
            .append(!large)
            .write(true)
            .truncate(large)
            .open(&self.log)
    }
}

impl Launcher for RunnerLauncher {
    type Child = crate::process_tree::Tree;

    fn launch(&mut self, pairing: bool, output: Output) -> io::Result<Self::Child> {
        // Before the first start. The runner makes it private (0700) when it is asked for by flag.
        std::fs::create_dir_all(&self.data_dir)?;
        stop_legacy_runners();
        let log = Arc::new(Mutex::new(self.open_log()?));
        let mut tree = crate::process_tree::spawn(self.command(pairing))?;
        if let Ok(mut file) = log.lock() {
            let _ = writeln!(
                file,
                "[device] started the runner, pid {}{}",
                tree.id(),
                if pairing { ", to pair" } else { "" }
            );
        }
        let child = tree.child_mut();
        if let Some(stdout) = child.stdout.take() {
            forward(stdout, Arc::clone(&log), output.clone(), false);
        }
        if let Some(stderr) = child.stderr.take() {
            forward(stderr, log, output, true);
        }
        Ok(tree)
    }

    fn log_location(&self) -> String {
        self.log.display().to_string()
    }
}

/// Read a pipe line by line until it closes. Never echoes a line that could hold the device token:
/// the runner does not print it, and the pairing code is only in the arguments.
fn forward(
    pipe: impl Read + Send + 'static,
    log: Arc<Mutex<std::fs::File>>,
    output: Output,
    stderr: bool,
) {
    let _ = std::thread::Builder::new()
        .name(
            if stderr {
                "runner-stderr"
            } else {
                "runner-stdout"
            }
            .into(),
        )
        .spawn(move || {
            for line in BufReader::new(pipe).lines() {
                let Ok(line) = line else { break };
                if let Ok(mut file) = log.lock() {
                    let _ = writeln!(file, "{}{line}", if stderr { "[stderr] " } else { "" });
                }
                if stderr {
                    output.stderr(&line);
                } else {
                    output.stdout(&line);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        Settings {
            server: "https://bot.example.com".into(),
            name: Some("前台电脑".into()),
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn only_a_legacy_runner_in_the_install_dir_is_stopped() {
        let dir = Path::new("/opt/xiongbao-device");
        let table = vec![
            (10, PathBuf::from("/opt/xiongbao-device/openbot-runner")),
            (11, PathBuf::from("/opt/xiongbao-device/xiongbao-runner")),
            (12, PathBuf::from("/usr/local/bin/openbot-runner")),
            (13, PathBuf::from("/opt/xiongbao-device/sub/openbot-runner")),
            (
                14,
                PathBuf::from("/opt/xiongbao-device/openbot-runner-helper"),
            ),
            (
                15,
                PathBuf::from("/opt/xiongbao-device/openbot-runner (deleted)"),
            ),
        ];
        assert_eq!(legacy_runner_pids(&table, dir, ""), vec![10, 15]);
        let windows = vec![
            (20, PathBuf::from("/opt/xiongbao-device/openbot-runner.exe")),
            (21, PathBuf::from("/opt/xiongbao-device/openbot-runner")),
        ];
        assert_eq!(legacy_runner_pids(&windows, dir, ".exe"), vec![20]);
    }

    #[test]
    fn windows_paths_match_across_verbatim_prefix_slashes_and_case() {
        // canonicalize() gives the verbatim form; WMI gives the plain one, in whatever case.
        let dir = Path::new(r"\\?\C:\Program Files\Xiongbao Device");
        let table = vec![
            (
                1,
                PathBuf::from(r"C:\Program Files\Xiongbao Device\openbot-runner.exe"),
            ),
            (
                2,
                PathBuf::from(r"c:\program files\xiongbao device\OPENBOT-RUNNER.EXE"),
            ),
            (3, PathBuf::from(r"C:\Other\openbot-runner.exe")),
            (
                4,
                PathBuf::from(r"C:\Program Files\Xiongbao Device\xiongbao-runner.exe"),
            ),
        ];
        assert_eq!(legacy_runner_pids(&table, dir, ".exe"), vec![1, 2]);
    }

    #[test]
    fn the_process_table_is_listed_only_when_a_legacy_runner_could_be_running() {
        // Windows: no legacy file in the install directory, no legacy process from it.
        assert!(!legacy_runner_possible(false, false));
        assert!(legacy_runner_possible(true, false));
        // Unix: an upgrade can unlink the file under a running orphan, so always look.
        assert!(legacy_runner_possible(false, true));
        assert!(legacy_runner_possible(true, true));
    }

    #[test]
    fn unix_paths_stay_case_sensitive() {
        let table = vec![(1, PathBuf::from("/opt/App/OPENBOT-RUNNER"))];
        assert!(legacy_runner_pids(&table, Path::new("/opt/App"), "").is_empty());
    }

    #[test]
    fn the_sidecar_is_named_xiongbao_runner() {
        assert_eq!(SIDECAR, "xiongbao-runner");
    }

    #[test]
    fn the_data_dir_is_always_passed() {
        let dir = PathBuf::from("/data/熊宝 设备端/runner");
        let args = strings(&runner_args(&settings(), &dir, None, None, None));
        let at = args
            .iter()
            .position(|a| a == "--data-dir")
            .expect("--data-dir missing");
        assert_eq!(
            args[at + 1],
            dir.to_string_lossy(),
            "one argument, spaces and all"
        );
        assert_eq!(
            args,
            vec![
                "--server",
                "https://bot.example.com",
                "--data-dir",
                &dir.to_string_lossy(),
                "--name",
                "前台电脑",
            ]
        );
    }

    #[test]
    fn the_pairing_code_is_only_sent_when_pairing() {
        let dir = PathBuf::from("/d");
        let pairing = strings(&runner_args(
            &settings(),
            &dir,
            Some("AB12CD34"),
            None,
            None,
        ));
        assert!(pairing.windows(2).any(|w| w == ["--pair", "AB12CD34"]));
        let steady = strings(&runner_args(&settings(), &dir, None, None, None));
        assert!(!steady.iter().any(|a| a == "--pair"));
    }

    #[test]
    fn no_name_lets_the_runner_use_the_hostname_and_a_browser_is_passed_by_path() {
        let unnamed = Settings {
            name: None,
            ..settings()
        };
        let chrome = PathBuf::from("/opt/google/chrome/chrome");
        let args = strings(&runner_args(
            &unnamed,
            Path::new("/d"),
            None,
            Some(&chrome),
            None,
        ));
        assert!(!args.iter().any(|a| a == "--name"));
        assert!(args
            .windows(2)
            .any(|w| w == ["--browser-executable", "/opt/google/chrome/chrome"]));
    }

    #[test]
    fn the_launcher_uses_the_code_once_and_runs_in_the_data_dir() {
        let mut launcher = RunnerLauncher {
            program: PathBuf::from("runner"),
            data_dir: PathBuf::from("/data/runner"),
            settings: settings(),
            pair_code: Some("CODE1234".into()),
            browser: None,
            desktop_helper: None,
            log: PathBuf::from("/data/runner.log"),
        };
        let first = launcher.command(true);
        assert_eq!(first.get_current_dir(), Some(Path::new("/data/runner")));
        assert!(first.get_args().any(|a| a == "CODE1234"));
        let again = launcher.command(true);
        assert!(
            !again.get_args().any(|a| a == "--pair"),
            "a code is single use"
        );
    }

    #[test]
    fn the_desktop_helper_is_passed_when_known() {
        let dir = PathBuf::from("/d");
        let helper = PathBuf::from("/Applications/熊宝 设备端.app/Contents/MacOS/agent-desktop");
        let args = strings(&runner_args(&settings(), &dir, None, None, Some(&helper)));
        assert!(
            args.windows(2)
                .any(|w| w == ["--desktop-helper", &*helper.to_string_lossy()]),
            "one argument, spaces and all"
        );
        let unknown = strings(&runner_args(&settings(), &dir, None, None, None));
        assert!(!unknown.iter().any(|a| a == "--desktop-helper"));

        let mut launcher = RunnerLauncher {
            program: PathBuf::from("runner"),
            data_dir: PathBuf::from("/data/runner"),
            settings: settings(),
            pair_code: None,
            browser: None,
            desktop_helper: Some(helper.clone()),
            log: PathBuf::from("/data/runner.log"),
        };
        let command = launcher.command(false);
        let launched: Vec<String> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(launched
            .windows(2)
            .any(|w| w == ["--desktop-helper", &*helper.to_string_lossy()]));
    }

    #[test]
    fn server_addresses_are_checked_and_tidied() {
        assert_eq!(
            normalize_server("  https://bot.example.com/// ").unwrap(),
            "https://bot.example.com"
        );
        assert_eq!(
            normalize_server("http://10.0.0.5:3000").unwrap(),
            "http://10.0.0.5:3000"
        );
        assert!(normalize_server("bot.example.com").is_err());
        assert_eq!(
            normalize_server("https:///").unwrap_err(),
            "服务器地址不完整。"
        );
        assert!(normalize_server("ftp://x").is_err());
    }

    #[test]
    fn the_pairing_form_is_checked_again_here() {
        let (settings, code) = validate_pairing("https://a.example/", " AB12 ", "").unwrap();
        assert_eq!(settings.server, "https://a.example");
        assert_eq!(settings.name, None);
        assert_eq!(code, "AB12");
        assert!(validate_pairing("https://a.example", "  ", "x").is_err());
        assert!(validate_pairing("https://a.example", "AB 12", "x").is_err());
        assert!(validate_pairing("https://a.example", "AB12", &"名".repeat(121)).is_err());
    }

    #[test]
    fn settings_round_trip_and_bad_files_are_ignored() {
        let dir = crate::process_tree::tests::scratch("settings");
        let file = dir.join("device.json");
        assert_eq!(Settings::load(&file), None);
        settings().save(&file).unwrap();
        assert_eq!(Settings::load(&file), Some(settings()));
        std::fs::write(&file, r#"{"server":"not a url"}"#).unwrap();
        assert_eq!(Settings::load(&file), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_first_installed_browser_wins_and_none_is_reported() {
        let candidates = browser_candidates(&|name| match name {
            "HOME" => Some("/Users/a".into()),
            "ProgramFiles" => Some(r"C:\Program Files".into()),
            "ProgramFiles(x86)" => Some(r"C:\Program Files (x86)".into()),
            "LOCALAPPDATA" => Some(r"C:\Users\a\AppData\Local".into()),
            _ => None,
        });
        assert!(candidates.len() >= 3);
        let edge = candidates
            .iter()
            .find(|path| path.to_string_lossy().to_lowercase().contains("edge"))
            .unwrap()
            .clone();
        assert_eq!(
            detect_browser(&candidates, &|path| path == edge),
            Some(edge.clone())
        );
        assert_eq!(
            detect_browser(&candidates, &|_| true),
            candidates.first().cloned(),
            "Chrome first when both are installed"
        );
        assert_eq!(detect_browser(&candidates, &|_| false), None);
    }

    #[test]
    fn the_sidecar_sits_next_to_the_app() {
        if std::env::var_os("OPENBOT_RUNNER_BINARY").is_some() {
            return;
        }
        let path = sidecar_path().unwrap();
        assert_eq!(path.parent(), std::env::current_exe().unwrap().parent());
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(SIDECAR));
    }

    #[test]
    fn agent_desktop_path_is_next_to_the_app() {
        // Either override moves a path this test compares, as in `the_sidecar_sits_next_to_the_app`.
        if std::env::var_os("OPENBOT_AGENT_DESKTOP_BINARY").is_some()
            || std::env::var_os("OPENBOT_RUNNER_BINARY").is_some()
        {
            return;
        }
        let path = agent_desktop_path().unwrap();
        assert_eq!(path.parent(), std::env::current_exe().unwrap().parent());
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            format!("{AGENT_DESKTOP}{}", std::env::consts::EXE_SUFFIX)
        );
        assert_eq!(AGENT_DESKTOP, "agent-desktop");
        assert_eq!(path.parent(), sidecar_path().unwrap().parent());
    }
}
