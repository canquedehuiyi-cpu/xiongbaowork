//! Starting at login, written by hand.
//!
//! `tauri-plugin-autostart` would do this, but every release of it depends on `auto-launch`, which is
//! not in the Cargo.lock this app shares its versions with, and its current release needs a newer
//! tauri than that lock has. What it does is small, so it is done here with nothing new: a desktop entry under `~/.config/autostart` on Linux (the XDG autostart
//! spec), a LaunchAgent on macOS, and a value under the current user's `Run` key on Windows. All
//! three are per user and need no administrator rights.
//!
//! The app is started with [`AUTOSTART_ARG`], which keeps the window closed: a computer that has
//! just been switched on should come online in the tray, not open a window nobody asked for.

use std::io;
use std::path::{Path, PathBuf};

pub const AUTOSTART_ARG: &str = "--autostart";

/// Linux and macOS file names, and the Windows value name.
const ENTRY_NAME: &str = "xiongbao-device";
const PRODUCT_NAME: &str = "熊宝数字员工 设备端";

/// What should be started at login. An AppImage runs from a temporary mount, so its own path is the
/// one that will still be there after a reboot.
pub fn launch_target() -> io::Result<PathBuf> {
    if cfg!(target_os = "linux") {
        if let Some(appimage) = std::env::var_os("APPIMAGE") {
            return Ok(PathBuf::from(appimage));
        }
    }
    std::env::current_exe()
}

/// An `Exec` value per the desktop entry spec: quoted, with `"`, `` ` ``, `$` and `\` escaped.
pub fn desktop_entry(exe: &Path) -> String {
    let mut quoted = String::from("\"");
    for ch in exe.to_string_lossy().chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    format!(
        "[Desktop Entry]\nType=Application\nName={PRODUCT_NAME}\nExec={quoted} {AUTOSTART_ARG}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    )
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A LaunchAgent that starts the app once at login.
pub fn launch_agent(label: &str, exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>{AUTOSTART_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(label),
        xml_escape(&exe.to_string_lossy())
    )
}

/// The command line Windows runs from the `Run` key.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn run_value(exe: &Path) -> String {
    format!("\"{}\" {AUTOSTART_ARG}", exe.display())
}

/// The file that makes this app start at login, on Linux and macOS.
pub fn entry_file(home: &Path, config_home: Option<&Path>, identifier: &str) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents")
            .join(format!("{identifier}.plist"))
    } else {
        config_home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"))
            .join("autostart")
            .join(format!("{ENTRY_NAME}.desktop"))
    }
}

/// The contents of [`entry_file`].
pub fn entry_contents(identifier: &str, exe: &Path) -> String {
    if cfg!(target_os = "macos") {
        launch_agent(identifier, exe)
    } else {
        desktop_entry(exe)
    }
}

/// Turn starting at login on or off for this user.
pub fn set(enabled: bool, identifier: &str) -> io::Result<()> {
    #[cfg(windows)]
    {
        let _ = identifier;
        if enabled {
            windows::set(&run_value(&launch_target()?))
        } else {
            windows::remove()
        }
    }
    #[cfg(not(windows))]
    {
        let file = user_entry_file(identifier)?;
        if enabled {
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&file, entry_contents(identifier, &launch_target()?))
        } else {
            match std::fs::remove_file(&file) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        }
    }
}

pub fn is_enabled(identifier: &str) -> bool {
    #[cfg(windows)]
    {
        let _ = identifier;
        windows::get().is_some()
    }
    #[cfg(not(windows))]
    {
        user_entry_file(identifier)
            .map(|file| file.is_file())
            .unwrap_or(false)
    }
}

#[cfg(not(windows))]
fn user_entry_file(identifier: &str) -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("HOME is not set"))?;
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    Ok(entry_file(&home, config_home.as_deref(), identifier))
}

#[cfg(windows)]
mod windows {
    use std::io;
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn check(status: u32) -> io::Result<()> {
        if status == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(status as i32))
        }
    }

    pub fn set(command: &str) -> io::Result<()> {
        let (key, name, data) = (wide(RUN_KEY), wide(super::ENTRY_NAME), wide(command));
        // SAFETY: all three are NUL-terminated UTF-16, and the length counts the terminator.
        check(unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        })
    }

    pub fn remove() -> io::Result<()> {
        let (key, name) = (wide(RUN_KEY), wide(super::ENTRY_NAME));
        // SAFETY: both are NUL-terminated UTF-16.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) };
        // ERROR_FILE_NOT_FOUND: it was already off.
        if status == 2 {
            return Ok(());
        }
        check(status)
    }

    pub fn get() -> Option<()> {
        let (key, name) = (wide(RUN_KEY), wide(super::ENTRY_NAME));
        // SAFETY: a null buffer asks only whether the value exists, and its size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (status == 0).then_some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desktop_entry_quotes_the_path_and_starts_hidden() {
        let entry = desktop_entry(Path::new("/opt/熊宝 设备端/$bin/run\"me"));
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Type=Application\n"));
        assert!(
            entry.contains("Exec=\"/opt/熊宝 设备端/\\$bin/run\\\"me\" --autostart\n"),
            "{entry}"
        );
    }

    #[test]
    fn the_launch_agent_runs_at_load_with_an_escaped_path() {
        let plist = launch_agent("com.xiongbao.device", Path::new("/Applications/A&B.app/x"));
        assert!(plist.contains("<string>com.xiongbao.device</string>"));
        assert!(plist.contains("<string>/Applications/A&amp;B.app/x</string>"));
        assert!(plist.contains("<string>--autostart</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
    }

    #[test]
    fn the_run_value_quotes_a_path_with_spaces() {
        assert_eq!(
            run_value(Path::new(r"C:\Program Files\熊宝\xiongbao-device.exe")),
            r#""C:\Program Files\熊宝\xiongbao-device.exe" --autostart"#
        );
    }

    #[test]
    fn the_entry_lives_in_the_user_s_own_autostart_location() {
        let home = Path::new("/home/a");
        let file = entry_file(home, None, "com.xiongbao.device");
        if cfg!(target_os = "macos") {
            assert_eq!(
                file,
                home.join("Library/LaunchAgents/com.xiongbao.device.plist")
            );
        } else {
            assert_eq!(file, home.join(".config/autostart/xiongbao-device.desktop"));
            assert_eq!(
                entry_file(home, Some(Path::new("/x")), "id"),
                Path::new("/x/autostart/xiongbao-device.desktop")
            );
        }
    }
}
