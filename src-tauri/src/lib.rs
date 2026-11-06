mod backend;
mod capabilities;
mod color;
mod enforce;
mod identify;
mod monitor;
mod nvapi;
mod nvgamma;
mod store;

use capabilities::get_display_capabilities;
use color::{apply_preset_cmd, probe_monitor_cmd, reset_monitor_cmd};
use enforce::reapply_now_cmd;
use identify::{identify_info_cmd, identify_monitors_cmd};
use monitor::list_monitors_cmd;
use nvapi::vibrance_supported_cmd;
use nvgamma::capture_nvcp_cmd;
use store::{
    create_preset_cmd, delete_preset_cmd, import_icc_cmd, list_applied_cmd, list_pins_cmd,
    list_presets_cmd, pin_preset_cmd, set_monitor_name_cmd, unpin_monitor_cmd, update_preset_cmd,
    AppStore,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

struct TrayMenuItems {
    show: MenuItem<tauri::Wry>,
    reapply: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

// --- System tray -------------------------------------------------------------

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示主窗口 / Show", true, None::<&str>)?;
    let reapply = MenuItem::with_id(app, "tray-reapply", "立即重新应用 / Reapply now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出程序 / Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &reapply, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    app.manage(TrayMenuItems {
        show: show.clone(),
        reapply: reapply.clone(),
        quit: quit.clone(),
    });

    // Reuse the app/window icon for the tray so the title bar, taskbar and
    // tray stay consistent. The icon comes from `bundle.icon` in
    // tauri.conf.json via `app.default_window_icon()`.
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("ChromaDeck");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "tray-quit" => {
            // Defined exit semantics (see enforce.rs): applied colour is
            // intentionally kept – quitting never wipes displays. The sweep
            // only classifies/logs per-backend outcomes and is safe when a
            // display disconnected during shutdown.
            crate::enforce::shutdown_sweep(app);
            app.exit(0);
        }
        "tray-show" => {
            show_main_window(app);
        }
        "tray-reapply" => {
            use tauri::Manager;
            if let Some(store) = app.try_state::<AppStore>() {
                if let Ok(s) = store.0.lock() {
                    let (pins, presets) = (s.list_pins(), s.list_presets());
                    drop(s);
                    let api = crate::color::RealColorApi;
                    let nv = crate::nvapi::RealNvapi;
                    let reader = crate::enforce::RealStateReader;
                    let _ = crate::enforce::check_once(
                        &api, &nv, &reader, &pins, &presets, true,
                    );
                }
            }
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let app = tray.app_handle();
            show_main_window(app);
        }
    })
    .build(app)?;
    Ok(())
}

/// Dynamically update tray menu item labels when the user switches between Chinese and English.
#[tauri::command]
fn set_tray_language_cmd(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    if let Some(items) = app.try_state::<TrayMenuItems>() {
        let (show_txt, reapply_txt, quit_txt) = if lang.to_lowercase().starts_with("zh") {
            ("显示主窗口", "立即重新应用", "退出程序")
        } else {
            ("Show", "Reapply now", "Quit")
        };
        items.show.set_text(show_txt).map_err(|e| e.to_string())?;
        items.reapply.set_text(reapply_txt).map_err(|e| e.to_string())?;
        items.quit.set_text(quit_txt).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show + focus the main window and notify the frontend so it replays its
/// entrance animation. The main window is hidden (not destroyed) on close,
/// so without the emit the staged load animation would only play once per
/// app lifetime instead of on every open.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("window-shown", ());
    }
}

// --- Application entry point -------------------------------------------------

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store_path = store::default_store_path();
    let app_store = AppStore(std::sync::Mutex::new(
        store::Store::new(store_path).expect("failed to initialise preset store"),
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(app_store)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("ChromaDeck")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            greet,
            list_monitors_cmd,
            identify_monitors_cmd,
            identify_info_cmd,
            list_presets_cmd,
            create_preset_cmd,
            update_preset_cmd,
            delete_preset_cmd,
            import_icc_cmd,
            apply_preset_cmd,
            vibrance_supported_cmd,
            reset_monitor_cmd,
            probe_monitor_cmd,
            pin_preset_cmd,
            unpin_monitor_cmd,
            list_pins_cmd,
            list_applied_cmd,
            reapply_now_cmd,
            capture_nvcp_cmd,
            set_monitor_name_cmd,
            get_display_capabilities,
            set_tray_language_cmd,
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Reassert pinned/applied presets once through the backend
                // registry before the drift loop takes over. Runs off the main
                // thread; disconnected displays are skipped.
                crate::enforce::startup_reapply(&handle);
                crate::enforce::enforce_loop(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label();
                // Let identify- overlay windows close normally; prevent
                // close + hide the main window (system-tray style).
                if label.starts_with("identify-") {
                    return; // allow normal close / destroy
                }
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
