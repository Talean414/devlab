use serde::Serialize;
use tauri::Manager;

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

/// The smallest possible typed bridge command. The frontend uses this response
/// as proof that it is connected to the trusted native process rather than
/// guessing from browser globals.
#[tauri::command]
fn get_runtime_info(app: tauri::AppHandle) -> NativeRuntimeInfo {
    NativeRuntimeInfo {
        runtime: "tauri",
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        app_version: app.package_info().version.to_string(),
        debug: cfg!(debug_assertions),
        // Capabilities are enabled only after their real backend is implemented.
        // The UI must never infer a capability or silently fall back to a simulation.
        capabilities: vec!["native-runtime"],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![get_runtime_info])
        .run(tauri::generate_context!())
        .expect("error while running DevLab");
}
