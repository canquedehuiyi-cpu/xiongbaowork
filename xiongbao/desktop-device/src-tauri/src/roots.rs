//! The folders this computer lets its owner's 分身 read (story F1, stage 2, S2), and, when the owner
//! says so here, lets a project's coworkers change (story RES2, decision D3).
//!
//! They are the runner's, not this app's: the runner keeps them in `runner-roots.json` in its data
//! directory, gives each an opaque reference, and reports only references and names to the server.
//! This app adds, lists and removes them by running the same sidecar once with `--add-root`,
//! `--remove-root` or `--list-roots` and the same `--data-dir`, and reads the one JSON line it
//! prints, so there is exactly one implementation of the rules (no folder over the runner's own
//! files, no duplicates, read-only unless registered `write`) and a running runner sees the change on
//! its next heartbeat.
//!
//! WRITE IS CHOSEN HERE, ON THIS COMPUTER, AND NEVER BY DEFAULT. A folder is registered `read` unless
//! the person at this computer ticked the window's write box, and the mode is passed to the runner as
//! `--root-mode read|write` on every add. Only those two words are accepted (`parse_mode`); anything
//! else is refused before a process starts. The server can only make a folder stricter: a `write`
//! folder is written to only when a project on it is also set writable there.
//!
//! The runner has no command that changes a registered folder's mode, and removing and adding it
//! again mints a new reference (which the server's projects name it by), so the window changes a
//! mode only by removing the folder and adding it again.
//!
//! The tray has no native folder picker (the dialog plugin is not in this app's lock), so the
//! window takes the folder's path as text.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

/// Whether a project's coworkers may change files in a folder. `Read` unless the person at this
/// computer chose otherwise.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RootMode {
    #[default]
    Read,
    Write,
}

impl RootMode {
    /// The word the runner's `--root-mode` takes.
    pub fn as_flag(self) -> &'static str {
        match self {
            RootMode::Read => "read",
            RootMode::Write => "write",
        }
    }
}

/// The window's mode, exactly one of the two words. Anything else, including an empty one or a
/// different spelling, is refused rather than read as either.
pub fn parse_mode(mode: &str) -> Result<RootMode, String> {
    match mode {
        "read" => Ok(RootMode::Read),
        "write" => Ok(RootMode::Write),
        _ => Err("文件夹的权限只能是只读或可写。".into()),
    }
}

/// One folder, as the runner prints it to this computer's owner. The path is shown here, on this
/// computer, and never leaves it. The runner prints `mode` only for a `write` folder; absent is
/// `read`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    #[serde(rename = "ref")]
    pub reference: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub mode: RootMode,
}

/// What the window asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RootCommand {
    List,
    Add {
        name: String,
        path: String,
        mode: RootMode,
    },
    Remove {
        reference: String,
    },
}

/// The sidecar's arguments for one command.
pub fn root_args(data_dir: &Path, command: &RootCommand) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--data-dir".into(), data_dir.as_os_str().to_owned()];
    match command {
        RootCommand::List => args.push("--list-roots".into()),
        RootCommand::Add { name, path, mode } => {
            args.push("--add-root".into());
            args.push(format!("{name}={path}").into());
            args.push("--root-mode".into());
            args.push(mode.as_flag().into());
        }
        RootCommand::Remove { reference } => {
            args.push("--remove-root".into());
            args.push(reference.into());
        }
    }
    args
}

/// Checked here too, so the window's mistakes are said without starting a process.
pub fn validate_add(
    name: &str,
    path: &str,
    mode: &str,
) -> Result<(String, String, RootMode), String> {
    let mode = parse_mode(mode)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("请给这个文件夹起个名字。".into());
    }
    if name.chars().count() > 60 {
        return Err("名称最多 60 个字。".into());
    }
    // `NAME=PATH` is split at the first `=`, so a name may not hold one.
    if name.contains('=') {
        return Err("名称里不能有「=」。".into());
    }
    let path = path.trim();
    if path.is_empty() {
        return Err("请填写文件夹的路径。".into());
    }
    if !Path::new(path).is_absolute() {
        return Err("请填写文件夹的完整路径（绝对路径）。".into());
    }
    Ok((name.to_string(), path.to_string(), mode))
}

#[derive(Deserialize)]
struct Reply {
    ok: bool,
    #[serde(default)]
    roots: Option<Vec<Root>>,
    #[serde(default)]
    error: Option<String>,
}

/// The runner's reply: the folders after the command, or the sentence it refused with. The last
/// line that is JSON is the reply; anything else it printed is ignored.
pub fn parse_reply(stdout: &str) -> Result<Vec<Root>, String> {
    let reply = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Reply>(line.trim()).ok())
        .ok_or_else(|| "设备端服务没有给出回应，请重新启动设备端后再试。".to_string())?;
    if reply.ok {
        Ok(reply.roots.unwrap_or_default())
    } else {
        Err(reply
            .error
            .unwrap_or_else(|| "操作没有成功。".to_string()))
    }
}

/// Run the sidecar once for `command` and read its reply.
pub fn run(program: &Path, data_dir: &Path, command: &RootCommand) -> Result<Vec<Root>, String> {
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let mut process = Command::new(program);
    process
        .args(root_args(data_dir, command))
        .current_dir(data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up for a one-line command.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let output = process
        .output()
        .map_err(|error| format!("无法启动设备端服务：{error}"))?;
    parse_reply(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn each_command_names_the_data_dir_and_one_root_flag() {
        let dir = PathBuf::from("/data/runner");
        assert_eq!(
            root_args(&dir, &RootCommand::List),
            vec![
                OsString::from("--data-dir"),
                "/data/runner".into(),
                "--list-roots".into()
            ]
        );
        assert_eq!(
            root_args(
                &dir,
                &RootCommand::Add {
                    name: "周报".into(),
                    path: "/home/me/文档/周报".into(),
                    mode: RootMode::Read,
                }
            ),
            vec![
                OsString::from("--data-dir"),
                "/data/runner".into(),
                "--add-root".into(),
                "周报=/home/me/文档/周报".into(),
                "--root-mode".into(),
                "read".into()
            ]
        );
        assert_eq!(
            root_args(
                &dir,
                &RootCommand::Add {
                    name: "后端".into(),
                    path: "/home/me/code/backend".into(),
                    mode: RootMode::Write,
                }
            )[2..],
            [
                OsString::from("--add-root"),
                "后端=/home/me/code/backend".into(),
                "--root-mode".into(),
                "write".into()
            ]
        );
        assert_eq!(
            root_args(
                &dir,
                &RootCommand::Remove {
                    reference: "fld_AAAAAAAAAAAAAAAAAAAAAA".into()
                }
            )[2..],
            [
                OsString::from("--remove-root"),
                "fld_AAAAAAAAAAAAAAAAAAAAAA".into()
            ]
        );
    }

    #[test]
    fn the_window_s_mistakes_are_caught_before_a_process_starts() {
        assert!(validate_add("", "/tmp", "read").unwrap_err().contains("名字"));
        assert!(validate_add(&"名".repeat(61), "/tmp", "read")
            .unwrap_err()
            .contains("60"));
        assert!(validate_add("a=b", "/tmp", "read").unwrap_err().contains("="));
        assert!(validate_add("周报", "", "read").unwrap_err().contains("路径"));
        assert!(validate_add("周报", "文档/周报", "read")
            .unwrap_err()
            .contains("绝对路径"));
        let absolute = if cfg!(windows) { r"C:\Users\me\周报" } else { "/home/me/周报" };
        assert_eq!(
            validate_add("  周报 ", absolute, "read").unwrap(),
            ("周报".to_string(), absolute.to_string(), RootMode::Read)
        );
        assert_eq!(
            validate_add("周报", absolute, "write").unwrap(),
            ("周报".to_string(), absolute.to_string(), RootMode::Write)
        );
    }

    /// Only the two words: no other spelling, no padding, no empty mode is taken for either.
    #[test]
    fn only_read_and_write_are_accepted_as_a_mode() {
        assert_eq!(parse_mode("read"), Ok(RootMode::Read));
        assert_eq!(parse_mode("write"), Ok(RootMode::Write));
        for refused in ["", "Write", "WRITE", " write", "write ", "rw", "readwrite", "admin", "true"] {
            assert_eq!(
                parse_mode(refused).unwrap_err(),
                "文件夹的权限只能是只读或可写。",
                "{refused:?} was accepted"
            );
        }
        // Refused before the name and path are looked at, so a valid form with a bad mode starts
        // nothing.
        let absolute = if cfg!(windows) { r"C:\Users\me\周报" } else { "/home/me/周报" };
        assert!(validate_add("周报", absolute, "owner")
            .unwrap_err()
            .contains("只读或可写"));
        assert_eq!(RootMode::default(), RootMode::Read);
    }

    #[test]
    fn the_reply_is_the_last_json_line_and_a_refusal_keeps_its_sentence() {
        let listed = parse_reply(
            "something else\n{\"ok\":true,\"roots\":[{\"ref\":\"fld_AAAAAAAAAAAAAAAAAAAAAA\",\"name\":\"周报\",\"path\":\"/home/me/周报\",\"addedAt\":\"2026-11-04T00:00:00.000Z\"}]}\n",
        )
        .unwrap();
        assert_eq!(
            listed,
            vec![Root {
                reference: "fld_AAAAAAAAAAAAAAAAAAAAAA".into(),
                name: "周报".into(),
                path: "/home/me/周报".into(),
                mode: RootMode::Read,
            }]
        );
        // The runner names the mode only for a `write` folder.
        let written = parse_reply(
            "{\"ok\":true,\"roots\":[{\"ref\":\"fld_BBBBBBBBBBBBBBBBBBBBBB\",\"name\":\"后端\",\"path\":\"/home/me/code\",\"addedAt\":\"2026-11-04T00:00:00.000Z\",\"mode\":\"write\"}]}",
        )
        .unwrap();
        assert_eq!(written[0].mode, RootMode::Write);
        assert_eq!(parse_reply("{\"ok\":true,\"roots\":[]}").unwrap(), vec![]);
        assert_eq!(
            parse_reply("{\"ok\":false,\"error\":\"找不到这个文件夹。\"}").unwrap_err(),
            "找不到这个文件夹。"
        );
        assert!(parse_reply("").unwrap_err().contains("没有给出回应"));
    }

    /// The window is sent `ref`, `name`, `path` and `mode`, in those names, and always told the mode.
    #[test]
    fn a_root_reaches_the_window_with_the_runner_s_field_names() {
        let root = Root {
            reference: "fld_AAAAAAAAAAAAAAAAAAAAAA".into(),
            name: "周报".into(),
            path: "/home/me/周报".into(),
            mode: RootMode::Read,
        };
        let json = serde_json::to_value(&root).unwrap();
        assert_eq!(json["ref"], "fld_AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(json["name"], "周报");
        assert_eq!(json["path"], "/home/me/周报");
        assert_eq!(json["mode"], "read");
        let written = Root {
            mode: RootMode::Write,
            ..root
        };
        assert_eq!(serde_json::to_value(&written).unwrap()["mode"], "write");
    }
}
