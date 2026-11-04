// No console window behind the app on Windows, in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 熊宝数字员工 设备端: a tray app that keeps the runner (`openbot/runner`, compiled into the
//! `openbot-runner` sidecar) connected to a deployment, so a tenant's coworkers can use this
//! computer (F2 stage 1, option A of docs/specs/2026-11-02-f2-runner-desktop-client.md).
//!
//! It is deliberately not `openbot/desktop`, which installs and runs a whole self-hosted stack.
//! This app pairs, supervises one process, and shows whether it is online. The runner dials out;
//! nothing here listens on a port.
//!
//! This is the skeleton: a window and single-instance only. The supervisor, tray, pairing and
//! autostart follow in the next change of this stack.
//!
//! TODO(D8): the product name and the identifier `com.xiongbao.device` in tauri.conf.json are
//! placeholders until the brand owner decides. Whatever they become, the identifier must not be
//! the upstream `ai.copilotkit.*` (a test below holds that line).

#[cfg(test)]
const PRODUCT: &str = "熊宝数字员工 设备端";

fn main() {
    tauri::Builder::default()
        // Two copies would run two runners with one device token. A second launch is ignored.
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .run(tauri::generate_context!())
        .expect("熊宝数字员工 设备端 could not start");
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_identifier_is_ours_and_the_name_is_the_product_s() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let identifier = config["identifier"].as_str().unwrap();
        // TODO(D8): the brand owner picks the final identifier; it is never the upstream one.
        assert!(!identifier.starts_with("ai.copilotkit"), "{identifier}");
        assert_ne!(
            identifier, "com.xiongbao.desktop",
            "would collide with openbot/desktop"
        );
        assert_eq!(config["productName"], super::PRODUCT);
        assert_eq!(config["mainBinaryName"], "xiongbao-device");
        assert!(
            config["bundle"]["externalBin"].is_null(),
            "the sidecar is added by tauri.bundle.conf.json, so cargo test needs no runner binary"
        );
    }
}
