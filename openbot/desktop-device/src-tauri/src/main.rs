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
//! On Linux, `tauri.linux.conf.json` sets an ASCII product name, because the deb's `Package:` field
//! is made from it and dpkg refuses one that is not; its desktop entry keeps the Chinese name.
//!
//! TODO(D8): the product name and the identifier `com.xiongbao.device` in tauri.conf.json are
//! placeholders until the brand owner decides. Whatever they become, the identifier must not be
//! the upstream `ai.copilotkit.*` (a test below holds that line).

mod apps;
mod autostart;
mod process_tree;
mod roots;
mod sidecar;
mod supervise;

use serde::Serialize;
use sidecar::{RunnerLauncher, Settings};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use supervise::{Observer, Policy, State, Supervisor};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const PRODUCT: &str = "熊宝数字员工 设备端";
const BROWSER_MISSING: &str = "未检测到 Chrome 或 Edge，浏览器相关任务无法执行";

struct Paths {
    /// What this app remembers about the pairing (`device.json`).
    settings: PathBuf,
    /// The runner's `--data-dir`.
    data_dir: PathBuf,
    log: PathBuf,
}

struct Device {
    paths: Paths,
    browser: Option<PathBuf>,
    supervisor: Mutex<Option<Supervisor>>,
    /// The latest state, for the window. Unpaired until a supervisor says otherwise.
    state: Mutex<State>,
    /// The settings a pairing run was started with, saved once the runner says it paired.
    pending: Mutex<Option<Settings>>,
    status_item: Mutex<Option<MenuItem<Wry>>>,
    autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    quitting: AtomicBool,
    stopped: AtomicBool,
}

impl Device {
    fn settings(&self) -> Option<Settings> {
        Settings::load(&self.paths.settings)
    }
}

/// Passes the supervisor's news to the tray and the window, and saves a pairing that worked.
struct Tray(AppHandle);

impl Observer for Tray {
    fn changed(&self, state: &State) {
        let device = self.0.state::<Device>();
        *device.state.lock().unwrap() = state.clone();
        show_state(&self.0, state);
    }

    fn paired(&self) {
        let device = self.0.state::<Device>();
        let Some(settings) = device.pending.lock().unwrap().take() else {
            return;
        };
        if let Err(error) = settings.save(&device.paths.settings) {
            eprintln!(
                "[device] could not save {}: {error}",
                device.paths.settings.display()
            );
        }
        // A paired computer should come back online after a restart without anybody touching it
        // (stage 1, criterion 4). It can be turned off again from the tray.
        let identifier = self.0.config().identifier.clone();
        match autostart::set(true, &identifier) {
            Ok(()) => set_autostart_check(&self.0, true),
            Err(error) => eprintln!("[device] could not turn on start at login: {error}"),
        }
    }
}

fn show_state(app: &AppHandle, state: &State) {
    let label = state.label();
    if let Some(item) = app.state::<Device>().status_item.lock().unwrap().as_ref() {
        let _ = item.set_text(format!("状态：{label}"));
    }
    if let Some(tray) = app.tray_by_id("device") {
        let _ = tray.set_tooltip(Some(format!("{PRODUCT} · {label}")));
    }
}

fn set_autostart_check(app: &AppHandle, on: bool) {
    if let Some(item) = app
        .state::<Device>()
        .autostart_item
        .lock()
        .unwrap()
        .as_ref()
    {
        let _ = item.set_checked(on);
    }
}

/// Stop whatever is running, then supervise the runner for `settings`.
fn start(app: &AppHandle, settings: Settings, pair_code: Option<String>) -> Result<(), String> {
    let device = app.state::<Device>();
    stop(app);
    let program = sidecar::sidecar_path().map_err(|error| error.to_string())?;
    let pairing = pair_code.is_some();
    *device.pending.lock().unwrap() = pairing.then(|| settings.clone());
    let launcher = RunnerLauncher {
        program,
        data_dir: device.paths.data_dir.clone(),
        settings,
        pair_code,
        browser: device.browser.clone(),
        log: device.paths.log.clone(),
    };
    let supervisor = Supervisor::start(
        launcher,
        Policy::default(),
        pairing,
        Box::new(Tray(app.clone())),
    );
    *device.supervisor.lock().unwrap() = Some(supervisor);
    Ok(())
}

/// Stop the runner and everything under it, waiting for that to finish.
fn stop(app: &AppHandle) {
    let taken = app.state::<Device>().supervisor.lock().unwrap().take();
    if let Some(mut supervisor) = taken {
        supervisor.stop();
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Quit, on a thread of its own: stopping the runner can take its grace period, and the event loop
/// must keep answering meanwhile or the OS reports the app as not responding.
fn quit(app: &AppHandle) {
    let device = app.state::<Device>();
    if device.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(item) = device.status_item.lock().unwrap().as_ref() {
        let _ = item.set_text("状态：正在退出…");
    }
    let app = app.clone();
    std::thread::spawn(move || {
        stop(&app);
        app.state::<Device>().stopped.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    state: State,
    label: String,
    paired: bool,
    server: Option<String>,
    name: Option<String>,
    browser_missing: bool,
    autostart: bool,
    log: String,
}

#[tauri::command]
fn status(app: AppHandle) -> View {
    let device = app.state::<Device>();
    let settings = device.settings();
    let state = device.state.lock().unwrap().clone();
    View {
        label: state.label(),
        state,
        paired: settings.is_some(),
        server: settings.as_ref().map(|s| s.server.clone()),
        name: settings.and_then(|s| s.name),
        browser_missing: device.browser.is_none(),
        autostart: autostart::is_enabled(&app.config().identifier),
        log: device.paths.log.display().to_string(),
    }
}

/// Pair this computer. Returns once the runner has been started; the window follows the state.
#[tauri::command]
async fn pair(app: AppHandle, server: String, code: String, name: String) -> Result<(), String> {
    let (settings, code) = sidecar::validate_pairing(&server, &code, &name)?;
    if let Some(current) = app.state::<Device>().settings() {
        if current.server != settings.server {
            // The runner refuses this too, with a message in English; saying it here is kinder.
            return Err(format!(
                "这台电脑已配对到 {}。请先在该服务器的「我的设备」页面移除它，再配对到新的服务器。",
                current.server
            ));
        }
    }
    *app.state::<Device>().state.lock().unwrap() = State::Pairing;
    start(&app, settings, Some(code))
}

/// Start the runner again, after it was given up on or stopped.
#[tauri::command]
async fn restart(app: AppHandle) -> Result<(), String> {
    let settings = app
        .state::<Device>()
        .settings()
        .ok_or_else(|| "这台电脑还没有配对。".to_string())?;
    start(&app, settings, None)
}

/// The folders this computer offers its owner's 分身, changed by running the sidecar once (see
/// roots.rs). Not tied to the pairing: a folder can be added before or after it.
fn folders(app: &AppHandle, command: roots::RootCommand) -> Result<Vec<roots::Root>, String> {
    let program = sidecar::sidecar_path().map_err(|error| error.to_string())?;
    roots::run(&program, &app.state::<Device>().paths.data_dir, &command)
}

#[tauri::command]
async fn list_roots(app: AppHandle) -> Result<Vec<roots::Root>, String> {
    folders(&app, roots::RootCommand::List)
}

/// Offer a folder, `read` or `write` as the person at this computer chose (RES2 D3; only those two
/// words are accepted). The runner checks it again and refuses one over its own files.
#[tauri::command]
async fn add_root(
    app: AppHandle,
    name: String,
    path: String,
    mode: String,
) -> Result<Vec<roots::Root>, String> {
    let (name, path, mode) = roots::validate_add(&name, &path, &mode)?;
    folders(&app, roots::RootCommand::Add { name, path, mode })
}

#[tauri::command]
async fn remove_root(app: AppHandle, reference: String) -> Result<Vec<roots::Root>, String> {
    folders(&app, roots::RootCommand::Remove { reference })
}

/// The local MCP apps, changed by running the sidecar once (see apps.rs). Commands and keys stay in
/// the runner's file on this computer; the runner prints env values masked.
fn app_reply(app: &AppHandle, command: apps::AppCommand) -> Result<serde_json::Value, String> {
    let program = sidecar::sidecar_path().map_err(|error| error.to_string())?;
    apps::run(&program, &app.state::<Device>().paths.data_dir, &command)
}

#[tauri::command]
async fn list_apps(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    app_reply(&app, apps::AppCommand::List).map(|reply| apps::apps_of(&reply))
}

#[tauri::command]
async fn add_app(app: AppHandle, definition: serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    apps::validate_app(&definition)?;
    app_reply(&app, apps::AppCommand::Add(definition)).map(|reply| apps::apps_of(&reply))
}

#[tauri::command]
async fn remove_app(app: AppHandle, target: String) -> Result<Vec<serde_json::Value>, String> {
    let target = apps::validate_target(&target)?;
    app_reply(&app, apps::AppCommand::Remove(target)).map(|reply| apps::apps_of(&reply))
}

/// Start the app once and list its tools. Returns `{ tools, count }`.
#[tauri::command]
async fn test_app(app: AppHandle, target: String) -> Result<serde_json::Value, String> {
    let target = apps::validate_target(&target)?;
    app_reply(&app, apps::AppCommand::Test(target))
}

#[tauri::command]
async fn set_app_enabled(
    app: AppHandle,
    target: String,
    enabled: bool,
) -> Result<Vec<serde_json::Value>, String> {
    let target = apps::validate_target(&target)?;
    let command = if enabled {
        apps::AppCommand::Enable(target)
    } else {
        apps::AppCommand::Disable(target)
    };
    app_reply(&app, command).map(|reply| apps::apps_of(&reply))
}

/// The window, opened at its folder section, for the tray's 「添加本地文件夹…」.
fn show_folders(app: &AppHandle) {
    show_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.showFolders && window.showFolders()");
    }
}

fn chose(app: &AppHandle, id: &str) {
    match id {
        "open" => show_window(app),
        "folders" => show_folders(app),
        "restart" => {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(settings) = app.state::<Device>().settings() {
                    let _ = start(&app, settings, None);
                } else {
                    show_window(&app);
                }
            });
        }
        "autostart" => {
            let identifier = app.config().identifier.clone();
            let on = !autostart::is_enabled(&identifier);
            if let Err(error) = autostart::set(on, &identifier) {
                eprintln!("[device] could not change start at login: {error}");
            }
            set_autostart_check(app, autostart::is_enabled(&identifier));
        }
        "quit" => quit(app),
        _ => {}
    }
}

fn build_tray(app: &AppHandle, browser_missing: bool, identifier: &str) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "状态：未配对", false, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", BROWSER_MISSING, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开设备端窗口", true, None::<&str>)?;
    let folders = MenuItem::with_id(app, "folders", "添加本地文件夹…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        autostart::is_enabled(identifier),
        None::<&str>,
    )?;
    let restart = MenuItem::with_id(app, "restart", "重新启动设备端服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = if browser_missing {
        Menu::with_items(
            app,
            &[
                &status,
                &browser,
                &separator,
                &open,
                &folders,
                &autostart,
                &restart,
                &separator_two,
                &quit,
            ],
        )?
    } else {
        Menu::with_items(
            app,
            &[
                &status,
                &separator,
                &open,
                &folders,
                &autostart,
                &restart,
                &separator_two,
                &quit,
            ],
        )?
    };
    TrayIconBuilder::with_id("device")
        .icon(tauri::include_image!(
            "../../desktop/src-tauri/icons/64x64.png"
        ))
        .tooltip(PRODUCT)
        .menu(&menu)
        .on_menu_event(|app, event| chose(app, event.id().as_ref()))
        .build(app)?;
    let device = app.state::<Device>();
    *device.status_item.lock().unwrap() = Some(status);
    *device.autostart_item.lock().unwrap() = Some(autostart);
    Ok(())
}

/// Set by a termination signal; read by a thread that turns it into an ordinary quit.
#[cfg(unix)]
static TERMINATE: AtomicBool = AtomicBool::new(false);

/// Logging out, `kill`, or Ctrl-C in a development terminal send a signal, not a Quit, and the default
/// action ends this process without stopping the runner, which would then keep the device online
/// with nobody watching it. The handler only sets a flag (all a signal handler may safely do); the
/// watcher thread does the quitting. A runner started after this keeps the default handlers: exec
/// resets caught signals. Windows needs none of this, because the job object ends the tree.
#[cfg(unix)]
fn route_signals_to_quit(app: &AppHandle) {
    extern "C" fn flag(_: libc::c_int) {
        TERMINATE.store(true, Ordering::SeqCst);
    }
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
        unsafe {
            libc::signal(
                signal,
                flag as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("device-signals".into())
        .spawn(move || loop {
            if TERMINATE.load(Ordering::SeqCst) {
                quit(&app);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
}

fn main() {
    let autostarted = std::env::args().any(|arg| arg == autostart::AUTOSTART_ARG);
    tauri::Builder::default()
        // Two copies would run two runners with one device token. A second launch shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .invoke_handler(tauri::generate_handler![
            status,
            pair,
            restart,
            list_roots,
            add_root,
            remove_root,
            list_apps,
            add_app,
            remove_app,
            test_app,
            set_app_enabled
        ])
        // Closing the window hides it; the app lives in the tray and Quit is there.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let data = app.path().app_data_dir()?;
            let log = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| data.join("logs"))
                .join("runner.log");
            let browser = sidecar::detect_browser(
                &sidecar::browser_candidates(&|name| std::env::var_os(name)),
                &|path| path.is_file(),
            );
            app.manage(Device {
                paths: Paths {
                    settings: data.join("device.json"),
                    data_dir: data.join("runner"),
                    log,
                },
                browser,
                supervisor: Mutex::new(None),
                state: Mutex::new(State::Unpaired),
                pending: Mutex::new(None),
                status_item: Mutex::new(None),
                autostart_item: Mutex::new(None),
                quitting: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
            });
            let handle = app.handle().clone();
            #[cfg(unix)]
            route_signals_to_quit(&handle);
            let identifier = app.config().identifier.clone();
            let device = app.state::<Device>();
            build_tray(&handle, device.browser.is_none(), &identifier)?;

            match device.settings() {
                Some(settings) => {
                    if let Err(error) = start(&handle, settings, None) {
                        *device.state.lock().unwrap() = State::Failed { message: error };
                    }
                    show_state(&handle, &device.state.lock().unwrap().clone());
                    if !autostarted {
                        show_window(&handle);
                    }
                }
                // Not paired: the window is the only thing that can fix that, so it opens even when
                // started at login.
                None => show_window(&handle),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("熊宝数字员工 设备端 could not start")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Every way out goes through `quit`, so the runner's tree is stopped first.
                if !app.state::<Device>().stopped.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app);
                }
            }
            tauri::RunEvent::Exit => stop(app),
            _ => {}
        });
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
