const APP_COMMANDS: &[&str] = &[
    "get_runtime_info",
    "workspace_select",
    "workspace_current",
    "workspace_close",
    "workspace_list",
    "workspace_read",
    "workspace_write",
    "workspace_create_file",
    "workspace_create_directory",
    "workspace_rename",
    "workspace_delete",
    "terminal_create",
    "terminal_list",
    "terminal_snapshot",
    "terminal_write",
    "terminal_resize",
    "terminal_clear",
    "terminal_kill",
    "terminal_close",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build DevLab's Tauri permission manifest");
}
