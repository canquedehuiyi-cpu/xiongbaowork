//! The runner as this app starts it: the compiled `openbot-runner` sidecar, its arguments, where
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
pub const SIDECAR: &str = "openbot-runner";

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

/// Starts the compiled runner, writes its output to a log, and hands each line to the supervisor.
pub struct RunnerLauncher {
    pub program: PathBuf,
    pub data_dir: PathBuf,
    pub settings: Settings,
    /// Taken by the first launch.
    pub pair_code: Option<String>,
    pub browser: Option<PathBuf>,
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
    fn the_data_dir_is_always_passed() {
        let dir = PathBuf::from("/data/熊宝 设备端/runner");
        let args = strings(&runner_args(&settings(), &dir, None, None));
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
        let pairing = strings(&runner_args(&settings(), &dir, Some("AB12CD34"), None));
        assert!(pairing.windows(2).any(|w| w == ["--pair", "AB12CD34"]));
        let steady = strings(&runner_args(&settings(), &dir, None, None));
        assert!(!steady.iter().any(|a| a == "--pair"));
    }

    #[test]
    fn no_name_lets_the_runner_use_the_hostname_and_a_browser_is_passed_by_path() {
        let unnamed = Settings {
            name: None,
            ..settings()
        };
        let chrome = PathBuf::from("/opt/google/chrome/chrome");
        let args = strings(&runner_args(&unnamed, Path::new("/d"), None, Some(&chrome)));
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
}
