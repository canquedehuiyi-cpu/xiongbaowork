//! The local MCP apps this computer lets its owner's 员工 call (the device MCP bridge, §3.5).
//!
//! They are the runner's, not this app's: the runner keeps them in `runner-apps.json` in its data
//! directory (commands and keys stay there, on this computer) and reports only references and names
//! to the server. This app changes them by running the same sidecar once with `--list-apps`,
//! `--add-app -`, `--remove-app`, `--test-app`, `--enable-app` or `--disable-app` and the same
//! `--data-dir`, and reads the one JSON line it prints, so the rules (duplicate names, the loopback
//! only url, the limit) have exactly one implementation. A new app's JSON (keys included) is written
//! to the sidecar's stdin, never put on its command line. The runner prints environment values
//! masked, so a key is never sent back to the window.

use serde_json::Value;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// What the window asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum AppCommand {
    List,
    /// The app as the runner's `AppInput` JSON.
    Add(Value),
    Remove(String),
    Test(String),
    Enable(String),
    Disable(String),
}

/// The sidecar's arguments for one command.
pub fn app_args(data_dir: &Path, command: &AppCommand) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--data-dir".into(), data_dir.as_os_str().to_owned()];
    match command {
        AppCommand::List => args.push("--list-apps".into()),
        // The app itself goes on stdin (`stdin_payload`): its keys must not be on a command line,
        // which any process listing or audit log on this computer can read.
        AppCommand::Add(_) => {
            args.push("--add-app".into());
            args.push("-".into());
        }
        AppCommand::Remove(target) => {
            args.push("--remove-app".into());
            args.push(target.into());
        }
        AppCommand::Test(target) => {
            args.push("--test-app".into());
            args.push(target.into());
        }
        AppCommand::Enable(target) => {
            args.push("--enable-app".into());
            args.push(target.into());
        }
        AppCommand::Disable(target) => {
            args.push("--disable-app".into());
            args.push(target.into());
        }
    }
    args
}

/// What the sidecar reads on stdin for one command: the app's JSON for `Add`, nothing otherwise.
pub fn stdin_payload(command: &AppCommand) -> Option<String> {
    match command {
        AppCommand::Add(app) => Some(app.to_string()),
        _ => None,
    }
}

/// Checked here too, so an empty target is said without starting a process.
pub fn validate_target(target: &str) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("请指定要操作的应用。".into());
    }
    Ok(target.to_string())
}

/// The app must at least be a JSON object with a kind; the runner checks the rest.
pub fn validate_app(app: &Value) -> Result<(), String> {
    match app.get("kind").and_then(Value::as_str) {
        Some("stdio") | Some("http") if app.is_object() => Ok(()),
        _ => Err("应用的类型只能是启动命令或本机地址。".into()),
    }
}

/// The runner's reply: the whole object after `ok`, or the sentence it refused with. The last line
/// that is a JSON object with an `ok` is the reply; anything else it printed is ignored.
pub fn parse_reply(stdout: &str) -> Result<Value, String> {
    let reply = stdout
        .lines()
        .rev()
        .find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .filter(|value| value.get("ok").and_then(Value::as_bool).is_some())
        })
        .ok_or_else(|| "设备端服务没有给出回应，请重新启动设备端后再试。".to_string())?;
    if reply["ok"].as_bool() == Some(true) {
        Ok(reply)
    } else {
        Err(reply["error"]
            .as_str()
            .unwrap_or("操作没有成功。")
            .to_string())
    }
}

/// The `apps` list of a reply (empty when it has none).
pub fn apps_of(reply: &Value) -> Vec<Value> {
    reply["apps"].as_array().cloned().unwrap_or_default()
}

/// Run the sidecar once for `command` and read its reply.
pub fn run(program: &Path, data_dir: &Path, command: &AppCommand) -> Result<Value, String> {
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let payload = stdin_payload(command);
    let mut process = Command::new(program);
    process
        .args(app_args(data_dir, command))
        .current_dir(data_dir)
        .stdin(if payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up for a one-line command.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = process
        .spawn()
        .map_err(|error| format!("无法启动设备端服务：{error}"))?;
    if let Some(payload) = payload {
        // Written whole and then closed, so the sidecar sees the end of its input. A sidecar that
        // exited before reading leaves a broken pipe here; its own reply says why.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload.as_bytes());
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("无法启动设备端服务：{error}"))?;
    parse_reply(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn add_app_passes_add_app_dash_and_sends_the_json_on_stdin() {
        let dir = PathBuf::from("/data/runner");
        let app = json!({"name":"笔记","kind":"stdio","command":"x","args":[],"env":{"API_KEY":"sk-secret"}});
        let args = app_args(&dir, &AppCommand::Add(app.clone()));
        assert_eq!(
            args,
            vec![
                OsString::from("--data-dir"),
                "/data/runner".into(),
                "--add-app".into(),
                "-".into()
            ]
        );
        // The key is never on the command line, where process auditing would see it.
        assert!(args
            .iter()
            .all(|arg| !arg.to_string_lossy().contains("sk-secret")));
        assert_eq!(
            stdin_payload(&AppCommand::Add(app.clone())),
            Some(app.to_string())
        );
        assert_eq!(stdin_payload(&AppCommand::List), None);
        assert_eq!(stdin_payload(&AppCommand::Test("Excel".into())), None);
    }

    /// A stand-in sidecar that answers with what it read on stdin and the arguments it was given.
    #[cfg(unix)]
    #[test]
    fn run_writes_the_app_to_the_sidecar_s_stdin() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("apps-rs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("fake-sidecar.sh");
        std::fs::write(
            &program,
            r#"#!/bin/sh
input=$(cat)
[ -z "$input" ] && input=null
printf '{"ok":true,"flag":"%s","value":"%s","input":%s}\n' "$3" "$4" "$input"
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let app = json!({"name":"笔记","kind":"stdio","command":"x","args":[],"env":{"API_KEY":"sk-secret"}});
        let reply = run(&program, &dir.join("data"), &AppCommand::Add(app.clone())).unwrap();
        assert_eq!(reply["flag"], "--add-app");
        assert_eq!(reply["value"], "-");
        assert_eq!(reply["input"], app);
        // Every other command gets no stdin at all, and still answers.
        let listed = run(&program, &dir.join("data"), &AppCommand::List).unwrap();
        assert_eq!(listed["flag"], "--list-apps");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn each_other_command_names_the_data_dir_and_one_app_flag() {
        let dir = PathBuf::from("/data/runner");
        assert_eq!(
            app_args(&dir, &AppCommand::List),
            vec![
                OsString::from("--data-dir"),
                "/data/runner".into(),
                "--list-apps".into()
            ]
        );
        for (command, flag) in [
            (AppCommand::Remove("Excel".into()), "--remove-app"),
            (AppCommand::Test("Excel".into()), "--test-app"),
            (AppCommand::Enable("Excel".into()), "--enable-app"),
            (AppCommand::Disable("Excel".into()), "--disable-app"),
        ] {
            assert_eq!(
                app_args(&dir, &command)[2..],
                [OsString::from(flag), "Excel".into()]
            );
        }
    }

    #[test]
    fn the_window_s_mistakes_are_caught_before_a_process_starts() {
        assert!(validate_target("  ").unwrap_err().contains("应用"));
        assert_eq!(validate_target(" Excel ").unwrap(), "Excel");
        assert!(validate_app(&json!({"kind":"ftp"})).is_err());
        assert!(validate_app(&json!("x")).is_err());
        assert!(validate_app(&json!({"kind":"stdio","name":"a"})).is_ok());
        assert!(validate_app(&json!({"kind":"http","name":"a"})).is_ok());
    }

    #[test]
    fn the_reply_is_the_last_json_line_and_a_refusal_keeps_its_sentence() {
        let reply = parse_reply(
            "noise\n{\"ok\":true,\"apps\":[{\"ref\":\"app_AAAAAAAAAAAAAAAAAAAAAA\",\"name\":\"Excel\",\"kind\":\"http\",\"url\":\"http://127.0.0.1:1\",\"enabled\":true}]}\n",
        )
        .unwrap();
        let apps = apps_of(&reply);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0]["name"], "Excel");
        let tested = parse_reply("{\"ok\":true,\"tools\":[\"a\",\"b\"],\"count\":2}").unwrap();
        assert_eq!(tested["count"], 2);
        assert!(apps_of(&tested).is_empty());
        assert_eq!(
            parse_reply("{\"ok\":false,\"error\":\"没有找到这个应用。\"}").unwrap_err(),
            "没有找到这个应用。"
        );
        assert!(parse_reply("").unwrap_err().contains("没有给出回应"));
        assert!(parse_reply("{\"x\":1}")
            .unwrap_err()
            .contains("没有给出回应"));
    }
}
