mod terminal;
mod workspace;

use serde::Serialize;
use tauri::Manager;
use terminal::{
    terminal_clear, terminal_close, terminal_create, terminal_kill, terminal_list,
    terminal_resize, terminal_snapshot, terminal_write, TerminalService,
};
use workspace::{
    workspace_close, workspace_create_directory, workspace_create_file, workspace_current,
    workspace_delete, workspace_list, workspace_read, workspace_rename, workspace_select,
    workspace_write, WorkspaceService,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRuntimeInfo {
    runtime: &'static str,
    os: &'static str,
    arch: &'static str,
    app_version: String,
    debug: bool,
    capabilities: Vec<&'static str>,
}

#[tauri::command]
fn get_runtime_info(app: tauri::AppHandle) -> NativeRuntimeInfo {
    NativeRuntimeInfo {
        runtime: "tauri",
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: app.package_info().version.to_string(),
        debug: cfg!(debug_assertions),
        // A capability is advertised only after its real backend is registered.
        capabilities: vec!["native-runtime", "filesystem", "pty"],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceService::default())
        .manage(TerminalService::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_info,
            workspace_select,
            workspace_current,
            workspace_close,
            workspace_list,
            workspace_read,
            workspace_write,
            workspace_create_file,
            workspace_create_directory,
            workspace_rename,
            workspace_delete,
            terminal_create,
            terminal_list,
            terminal_snapshot,
            terminal_write,
            terminal_resize,
            terminal_clear,
            terminal_kill,
            terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevLab");
}
