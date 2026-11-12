// No console window behind the app on Windows, in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 熊宝数字员工 设备端: a tray app that keeps the runner (`openbot/runner`, compiled into the
//! `xiongbao-runner` sidecar) connected to a deployment, so a tenant's coworkers can use this
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
mod desktop_guard;
mod desktop_permissions;
mod process_tree;
mod roots;
mod sidecar;
mod supervise;

use desktop_guard::{DesktopEvent, Effects, Guard, GuardAction, HotkeyError};
use serde::Serialize;
use sidecar::{ControlPipe, RunnerLauncher, Settings};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use supervise::{Observer, Policy, State, Supervisor};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_global_shortcut::GlobalShortcut;

const PRODUCT: &str = "熊宝数字员工 设备端";
const BROWSER_MISSING: &str = "未检测到 Chrome 或 Edge，浏览器相关任务无法执行";

struct Paths {
    /// What this app remembers about the pairing (`device.json`).
    settings: PathBuf,
    /// The runner's `--data-dir`.
    data_dir: PathBuf,
    log: PathBuf,
    /// agent-desktop's home for the 「桌面操作」 card's probe: private, emptied before each probe,
    /// and not the runner's `agent-desktop-state`.
    probe: PathBuf,
    /// Left by `restart_app` so the restarted app shows its window even if it was started at login.
    show_once: PathBuf,
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
    /// When the window was last brought up for a `permission-needed`.
    desktop_raised: Mutex<Option<Instant>>,
    /// The desktop session's guard. Never locked on the main thread: carrying its actions out waits
    /// for the main thread (window and menu calls), so a main-thread caller would deadlock.
    guard: Mutex<Guard>,
    /// The running runner's stdin, for the control channel's answers.
    control: ControlPipe,
    /// The tray's 「停止桌面操作」, enabled while the banner is up.
    stop_desktop_item: Mutex<Option<MenuItem<Wry>>>,
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
        // A new runner has no session: no banner, no stop key.
        if desktop_guard::runner_gone(state) {
            guard_do(&self.0, Guard::reset);
        }
    }

    fn desktop(&self, event: DesktopEvent) {
        let cursor = cursor(&self.0);
        guard_do(&self.0, |guard| guard.on_event(&event, cursor));
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

    fn desktop_permission(&self) {
        let Some(window) = self.0.get_webview_window("main") else {
            return;
        };
        let visible =
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        let device = self.0.state::<Device>();
        let mut raised = device.desktop_raised.lock().unwrap();
        let now = Instant::now();
        match desktop_permissions::react(visible, *raised, now) {
            desktop_permissions::Reaction::Scroll => scroll_to_desktop(&self.0),
            desktop_permissions::Reaction::Raise => {
                *raised = Some(now);
                show_window(&self.0);
                scroll_to_desktop(&self.0);
            }
            desktop_permissions::Reaction::Nothing => {}
        }
    }
}

// --- desktop session guard (sub-project 2, write phase) ---

/// Decide with the guard, then carry the decision out, under its lock so the runner's lines, the
/// mouse check and the tray are handled one at a time. Not on the main thread (see `Device::guard`).
fn guard_do(app: &AppHandle, decide: impl FnOnce(&mut Guard) -> Vec<GuardAction>) {
    let device = app.state::<Device>();
    // A panic elsewhere while it was held leaves the guard's state as it was; carrying on with it
    // beats taking the runner's output thread down too.
    let mut guard = device
        .guard
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let actions = decide(&mut guard);
    desktop_guard::apply(&mut guard, actions, &mut Shell(app));
}

fn cursor(app: &AppHandle) -> Option<(f64, f64)> {
    app.cursor_position()
        .ok()
        .map(|position| (position.x, position.y))
}

/// The guard's actions on the banner window, the stop key and the runner's stdin.
struct Shell<'a>(&'a AppHandle);

impl Shell<'_> {
    fn banner(&self) -> Result<tauri::WebviewWindow, String> {
        self.0
            .get_webview_window(desktop_guard::BANNER_LABEL)
            .ok_or_else(|| "没有提示条窗口".to_string())
    }

    /// The banner's words: its title for screen readers, and the page's 「正在移动鼠标」.
    fn say(&self, window: &tauri::WebviewWindow, headed: bool) -> Result<(), String> {
        let _ = window.set_title(&desktop_guard::banner_title(headed));
        self.0
            .emit_to(
                desktop_guard::BANNER_LABEL,
                desktop_guard::BANNER_EVENT,
                desktop_guard::BannerView { headed },
            )
            .map_err(|error| error.to_string())
    }
}

impl Effects for Shell<'_> {
    fn show_banner(&mut self, headed: bool) -> Result<(), String> {
        let window = self.banner()?;
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let area = monitor.work_area();
            let (x, y) = desktop_guard::banner_origin(
                (area.position.x, area.position.y),
                area.size.width,
                monitor.scale_factor(),
            );
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
        // Shown, never focused: whatever the person is typing into keeps the keyboard.
        window.show().map_err(|error| error.to_string())?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        self.say(&window, headed)?;
        if !window.is_visible().map_err(|error| error.to_string())? {
            return Err("提示条窗口没有显示".into());
        }
        set_stop_desktop_item(self.0, true);
        Ok(())
    }

    fn update_banner(&mut self, headed: bool) -> Result<(), String> {
        let window = self.banner()?;
        self.say(&window, headed)
    }

    fn hide_banner(&mut self) {
        if let Some(window) = self.0.get_webview_window(desktop_guard::BANNER_LABEL) {
            let _ = window.hide();
        }
        set_stop_desktop_item(self.0, false);
    }

    fn register_hotkey(&mut self) -> Result<(), HotkeyError> {
        register_stop_key(self.0)
    }

    fn unregister_hotkey(&mut self) {
        unregister_stop_key(self.0)
    }

    fn notice(&mut self, text: &'static str) {
        eprintln!("[device] {text}");
        let device = self.0.state::<Device>();
        let state = device.state.lock().unwrap().label();
        if let Some(item) = menu_item(&device.status_item) {
            let _ = item.set_text(format!("状态：{state} · {text}"));
        }
        if let Some(tray) = self.0.tray_by_id("device") {
            let _ = tray.set_tooltip(Some(format!("{PRODUCT} · {text}")));
        }
    }

    fn clear_notice(&mut self) {
        let state = self.0.state::<Device>().state.lock().unwrap().clone();
        show_state(self.0, &state);
    }

    fn send(&mut self, line: &str) -> std::io::Result<()> {
        self.0.state::<Device>().control.send(line)
    }
}

/// The stop key, Ctrl+Alt+Esc (⌃⌥⎋ on a Mac): the one place it is registered, for a session only.
/// The plugin does the registering on the main thread and this waits for the answer (ruling C5:
/// no `session-ready` without the key). That is safe here: the guard's lock, which the caller holds,
/// is never taken on the main thread. Linux has no plugin (see `main`), so no key and no session.
/// Always asks the system, never the plugin's list: an unregistering still queued on the main
/// thread (see below) runs first there, so only the system's answer says the key is up.
fn register_stop_key(app: &AppHandle) -> Result<(), HotkeyError> {
    let Some(shortcuts) = app.try_state::<GlobalShortcut<Wry>>() else {
        return Err(HotkeyError::Unsupported);
    };
    shortcuts
        .register(desktop_guard::stop_shortcut())
        .map_err(|error| match error {
            // The system's refusal: only some of these mean another program holds the key.
            tauri_plugin_global_shortcut::Error::GlobalHotkey(message) => {
                desktop_guard::hotkey_refusal(message)
            }
            // The event loop is gone or never answered: nothing to tell the person.
            other => HotkeyError::Failed(other.to_string()),
        })
}

/// Must be harmless when the key is not registered: a failed or replaced session unregisters too.
/// Handed to the main thread without waiting, so a session that ends never waits on it; a later
/// registration is queued behind it there, so it cannot be undone by it.
fn unregister_stop_key(app: &AppHandle) {
    let Some(shortcuts) = app.try_state::<GlobalShortcut<Wry>>() else {
        return;
    };
    if !shortcuts.is_registered(desktop_guard::stop_shortcut()) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let shortcuts = handle.state::<GlobalShortcut<Wry>>();
        if let Err(error) = shortcuts.unregister(desktop_guard::stop_shortcut()) {
            eprintln!("[device] could not unregister the stop key: {error}");
        }
    });
}

/// The stop key's plugin. Its handler runs on the main thread, where the guard is never locked, so
/// the stop goes through a thread of its own, as the tray's button does.
fn stop_key_plugin() -> tauri::plugin::TauriPlugin<Wry> {
    use tauri_plugin_global_shortcut::ShortcutState;
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state == ShortcutState::Pressed && *shortcut == desktop_guard::stop_shortcut()
            {
                let app = app.clone();
                std::thread::spawn(move || guard_do(&app, |guard| guard.on_stop("hotkey")));
            }
        })
        .build()
}

fn set_stop_desktop_item(app: &AppHandle, enabled: bool) {
    if let Some(item) = menu_item(&app.state::<Device>().stop_desktop_item) {
        let _ = item.set_enabled(enabled);
    }
}

/// A tray menu item, cloned out of its slot so the slot's lock is not held while the item changes:
/// off the main thread, changing it waits for the main thread, which takes these locks too (`quit`,
/// `restart_app`, the tray's menu).
fn menu_item<T: Clone>(slot: &Mutex<Option<T>>) -> Option<T> {
    slot.lock().unwrap().clone()
}

/// The banner, made at start-up and kept hidden until a session (see `desktop_guard::BANNER_WINDOW`).
fn create_banner(app: &AppHandle) -> tauri::Result<()> {
    let config = &desktop_guard::BANNER_WINDOW;
    WebviewWindowBuilder::new(app, config.label, WebviewUrl::App(config.page.into()))
        .title(desktop_guard::banner_title(false))
        .inner_size(config.width, config.height)
        .always_on_top(config.always_on_top)
        .decorations(config.decorations)
        .skip_taskbar(config.skip_taskbar)
        .focused(config.focused)
        .focusable(config.focusable)
        .resizable(config.resizable)
        .visible_on_all_workspaces(config.visible_on_all_workspaces)
        .visible(config.visible)
        .build()?;
    Ok(())
}

/// The mouse check: every `POLL_MS`, while a session is on and no `--headed` step is under way, the
/// cursor is compared with where it started; a move stops the session, and so does a cursor that
/// keeps failing to be read. Until this thread has told the guard it runs, no session is ready, and
/// once it leaves its loop (a panic) no session is again. Not on Linux, which has no write actions.
fn watch_the_mouse(app: &AppHandle) {
    /// Dropped only when the loop is left: the guard then stops counting on the check.
    struct Ended(AppHandle);
    impl Drop for Ended {
        fn drop(&mut self) {
            guard_do(&self.0, Guard::mouse_check_ended);
        }
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("desktop-mouse".into())
        .spawn(move || {
            guard_do(&app, |guard| {
                guard.mouse_check_started();
                Vec::new()
            });
            let _ended = Ended(app.clone());
            loop {
                std::thread::sleep(std::time::Duration::from_millis(desktop_guard::POLL_MS));
                guard_do(&app, |guard| guard.poll(|| cursor(&app)));
            }
        });
    // The guard was never told the check runs, so every session gets `session-failed`.
    if let Err(error) = spawned {
        eprintln!(
            "[device] could not start the mouse check; no desktop session can start: {error}"
        );
    }
}

// --- end desktop session guard ---

fn show_state(app: &AppHandle, state: &State) {
    let label = state.label();
    if let Some(item) = menu_item(&app.state::<Device>().status_item) {
        let _ = item.set_text(format!("状态：{label}"));
    }
    if let Some(tray) = app.tray_by_id("device") {
        let _ = tray.set_tooltip(Some(format!("{PRODUCT} · {label}")));
    }
}

fn set_autostart_check(app: &AppHandle, on: bool) {
    if let Some(item) = menu_item(&app.state::<Device>().autostart_item) {
        let _ = item.set_checked(on);
    }
}

/// Stop whatever is running, then supervise the runner for `settings`. Nothing while quitting
/// (final review M5): a supervisor installed after Quit stopped the last one would be joined on the
/// main thread at Exit while it waits for the main thread.
fn start(app: &AppHandle, settings: Settings, pair_code: Option<String>) -> Result<(), String> {
    let device = app.state::<Device>();
    if device.quitting.load(Ordering::SeqCst) {
        return Ok(());
    }
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
        desktop_helper: sidecar::agent_desktop_path().ok(),
        log: device.paths.log.clone(),
        control: device.control.clone(),
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
    if let Some(item) = menu_item(&device.status_item) {
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

// --- app discovery (sub-project 3) ---
/// What this computer could offer, by name. Returns the runner's whole reply (`candidates`, ...).
#[tauri::command]
async fn discover_apps(app: AppHandle) -> Result<serde_json::Value, String> {
    app_reply(&app, apps::AppCommand::Discover)
}

/// Register a discovered candidate and test it. Returns `{ app, tools, apps }`.
#[tauri::command]
async fn enable_candidate(app: AppHandle, candidate: String) -> Result<serde_json::Value, String> {
    let candidate = apps::validate_target(&candidate)?;
    app_reply(&app, apps::AppCommand::EnableCandidate(candidate))
}
// --- end app discovery ---

/// The notices bundled as resources (tauri.bundle.conf.json) that the 「关于」 section may show.
const BUNDLED_NOTICES: [&str; 6] = [
    "LICENSE",
    "NOTICE",
    "THIRD-PARTY-NOTICES.md",
    "licenses/agent-desktop/LICENSE",
    "licenses/agent-desktop/THIRD-PARTY.md",
    "licenses/agent-desktop/COPYRIGHT",
];

/// `name` if it is one of the bundled notices, exactly. Anything else is refused, never resolved.
fn bundled_notice(name: &str) -> Result<&'static str, String> {
    BUNDLED_NOTICES
        .into_iter()
        .find(|notice| *notice == name)
        .ok_or_else(|| "没有这份许可文件。".to_string())
}

/// One of the bundled notices, for the 「关于」 section.
#[tauri::command]
fn read_bundled_text(app: AppHandle, name: String) -> Result<String, String> {
    let name = bundled_notice(&name)?;
    let mut path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    path.extend(name.split('/'));
    std::fs::read_to_string(&path).map_err(|error| format!("无法读取 {name}：{error}"))
}

/// Whether this computer lets the app read and operate windows, as the bundled agent-desktop says.
/// The helper is given up to five seconds, on a blocking thread of its own.
#[tauri::command]
async fn desktop_permissions(
    app: AppHandle,
) -> Result<desktop_permissions::DesktopPermissionView, String> {
    let home = app.state::<Device>().paths.probe.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let platform = std::env::consts::OS;
        let reply = match desktop_permissions::command_for(platform) {
            Some(command) => {
                let program = sidecar::agent_desktop_path().map_err(|error| error.to_string())?;
                desktop_permissions::run(&program, &[command], &home, desktop_permissions::TIMEOUT)?
            }
            None => String::new(),
        };
        desktop_permissions::view_for(platform, &reply)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Open System Settings at the pane for `kind` (`accessibility` or `screen`). macOS only.
#[tauri::command]
fn open_desktop_settings(kind: String) -> Result<(), String> {
    let url = desktop_permissions::settings_url(&kind).ok_or("没有这个设置项。")?;
    if !cfg!(target_os = "macos") {
        return Err("只有 macOS 需要在系统设置里开启。".into());
    }
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())
        .and_then(|status| {
            if status.success() {
                Ok(())
            } else {
                Err("无法打开系统设置。".into())
            }
        })
}

/// Start this app again, for a grant macOS applies only to a new process. The runner's tree is
/// stopped first, as on Quit, so the new copy does not find a second runner using the same token.
#[tauri::command]
fn restart_app(app: AppHandle) {
    let device = app.state::<Device>();
    if device.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(item) = menu_item(&device.status_item) {
        let _ = item.set_text("状态：正在重新打开…");
    }
    // The new process gets this one's arguments, `--autostart` included: this note makes it show
    // its window all the same.
    if let Err(error) = desktop_permissions::mark_show_once(&device.paths.show_once) {
        eprintln!("[device] could not leave the show-window note: {error}");
    }
    let app = app.clone();
    std::thread::spawn(move || {
        stop(&app);
        app.state::<Device>().stopped.store(true, Ordering::SeqCst);
        // From a thread other than the main one, this asks the event loop to exit and restarts on
        // its Exit, which `run` below lets through because the runner is already stopped.
        app.restart();
    });
}

/// Refresh the 「桌面操作」 card and scroll to it, without showing or focusing the window.
fn scroll_to_desktop(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.showDesktop && window.showDesktop()");
    }
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
        // Off the main thread: the guard is never locked there.
        "stop-desktop" => {
            let app = app.clone();
            std::thread::spawn(move || guard_do(&app, |guard| guard.on_stop("button")));
        }
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
    let stop_desktop = MenuItem::with_id(app, "stop-desktop", "停止桌面操作", false, None::<&str>)?;
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
                &stop_desktop,
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
                &stop_desktop,
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
        .icon(tauri::include_image!("icons/64x64.png"))
        .tooltip(PRODUCT)
        .menu(&menu)
        .on_menu_event(|app, event| chose(app, event.id().as_ref()))
        .build(app)?;
    let device = app.state::<Device>();
    *device.status_item.lock().unwrap() = Some(status);
    *device.autostart_item.lock().unwrap() = Some(autostart);
    *device.stop_desktop_item.lock().unwrap() = Some(stop_desktop);
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
    let builder = tauri::Builder::default()
        // Two copies would run two runners with one device token. A second launch shows the window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }));
    // The stop key, registered only during a desktop session. Not on Linux (no session there).
    let builder = if cfg!(target_os = "linux") {
        builder
    } else {
        builder.plugin(stop_key_plugin())
    };
    builder
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
            set_app_enabled,
            // --- app discovery (sub-project 3) ---
            discover_apps,
            enable_candidate,
            // --- end app discovery ---
            desktop_permissions,
            open_desktop_settings,
            restart_app,
            read_bundled_text
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
                    probe: data.join("agent-desktop-probe"),
                    show_once: data.join("show-window-once"),
                },
                browser,
                supervisor: Mutex::new(None),
                state: Mutex::new(State::Unpaired),
                pending: Mutex::new(None),
                status_item: Mutex::new(None),
                autostart_item: Mutex::new(None),
                quitting: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                desktop_raised: Mutex::new(None),
                guard: Mutex::new(Guard::new()),
                control: ControlPipe::default(),
                stop_desktop_item: Mutex::new(None),
            });
            let handle = app.handle().clone();
            #[cfg(unix)]
            route_signals_to_quit(&handle);
            let identifier = app.config().identifier.clone();
            let device = app.state::<Device>();
            build_tray(&handle, device.browser.is_none(), &identifier)?;
            // Without a banner no session can start (`show_banner` fails, the runner is told
            // `session-failed`), so this is not fatal to the rest of the app.
            if let Err(error) = create_banner(&handle) {
                eprintln!("[device] could not make the desktop banner: {error}");
            }
            // No mouse check on Linux: no session can be ready there (no write actions either).
            if !cfg!(target_os = "linux") {
                watch_the_mouse(&handle);
            }

            match device.settings() {
                Some(settings) => {
                    if let Err(error) = start(&handle, settings, None) {
                        *device.state.lock().unwrap() = State::Failed { message: error };
                    }
                    show_state(&handle, &device.state.lock().unwrap().clone());
                    // Restarted from the 「桌面操作」 card: shown even when it was started at login.
                    let show_once = desktop_permissions::take_show_once(&device.paths.show_once);
                    if !autostarted || show_once {
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
    fn only_the_bundled_notices_can_be_read() {
        for name in super::BUNDLED_NOTICES {
            assert_eq!(super::bundled_notice(name), Ok(name));
        }
        for name in [
            "../device.json",
            "/etc/passwd",
            "licenses/agent-desktop/../../x",
            "licenses/agent-desktop/../../LICENSE",
            "./LICENSE",
            "LICENSE ",
            "license",
            "licenses\\agent-desktop\\LICENSE",
            "C:\\Windows\\win.ini",
            "",
        ] {
            assert!(super::bundled_notice(name).is_err(), "{name}");
        }
        // Each one is a resource the bundle really ships.
        let bundle: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.bundle.conf.json")).unwrap();
        let shipped: Vec<&str> = bundle["bundle"]["resources"]
            .as_object()
            .unwrap()
            .values()
            .filter_map(|target| target.as_str())
            .collect();
        for name in super::BUNDLED_NOTICES {
            assert!(shipped.contains(&name), "{name} is not bundled");
        }
    }

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

    /// Final review M5: a start (Restart, or pairing) that runs while Quit is under way must not
    /// install a supervisor after Quit stopped the last one: the main thread would join it on Exit
    /// while its thread waits for the main thread (menu and tray calls). `start` returns at once.
    #[test]
    fn start_returns_at_once_while_quitting() {
        let source = include_str!("main.rs");
        let at = source
            .find("fn start(app: &AppHandle")
            .expect("start is defined");
        let body = &source[at..];
        let quitting = body
            .find("if device.quitting.load(Ordering::SeqCst)")
            .expect("start checks quitting");
        let stops = body.find("stop(app);").expect("start stops what runs");
        assert!(quitting < stops, "the check comes before anything is done");
        assert!(
            body[quitting..stops].contains("return Ok(());"),
            "and returns"
        );
    }
}
