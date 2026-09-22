mod agent_tools;
mod ai_providers;
mod audit;
mod credentials;
mod database;
mod docker;
mod git;
mod http;
mod ollama;
mod postgres;
mod terminal;
mod test_runner;
mod toolchain;
mod workspace;

use agent_tools::{agent_tools_record_context, agent_tools_record_draft};
use ai_providers::{ai_credential_delete, ai_credential_status, ai_credential_store, ai_provider_chat};
use audit::{agent_audit_list, AgentAuditService};
use credentials::{git_credential_delete, git_credential_status, git_credential_store};
use database::{
    database_connections, database_disconnect, database_query, database_schema,
    database_set_write_access, database_sqlite_select, DatabaseService,
};
use docker::{
    docker_create, docker_logs, docker_pull, docker_remove, docker_restart, docker_snapshot,
    docker_start, docker_stop,
};
use git::{
    git_commit, git_diff, git_fetch, git_pull, git_push, git_repository_snapshot,
    git_stage_all, git_stage_paths, git_unstage_all, git_unstage_paths,
};
use http::http_request;
use ollama::{ollama_chat, ollama_list_models};
use postgres::{
    database_postgres_connect, database_postgres_connections, database_postgres_disconnect,
    database_postgres_execute, database_postgres_forget_password, database_postgres_query,
    database_postgres_schema, database_postgres_set_write_access, PostgresService,
};
use serde::Serialize;
use terminal::{
    terminal_clear, terminal_close, terminal_create, terminal_kill, terminal_list,
    terminal_resize, terminal_snapshot, terminal_write, TerminalService,
};
use test_runner::{test_runner_run, test_runner_snapshot};
use toolchain::toolchain_snapshot;
use workspace::{
    workspace_apply_reviewed_draft, workspace_close, workspace_create_directory, workspace_create_file,
    workspace_current, workspace_delete, workspace_list, workspace_read, workspace_rename,
    workspace_select, workspace_write, WorkspaceService,
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
        capabilities: vec![
            "native-runtime",
            "filesystem",
            "pty",
            "git",
            "secure-storage",
            "docker",
            "database",
            "native-http",
            "test-runner",
            "agent-audit",
            "agent-tools",
            "toolchain",
            "local-ai",
            "ai-providers",
        ],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AgentAuditService::default())
        .manage(WorkspaceService::default())
        .manage(TerminalService::default())
        .manage(DatabaseService::default())
        .manage(PostgresService::default())
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
            agent_audit_list,
            agent_tools_record_context,
            agent_tools_record_draft,
            workspace_select,
            workspace_current,
            workspace_close,
            workspace_list,
            workspace_read,
            workspace_write,
            workspace_apply_reviewed_draft,
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
            git_repository_snapshot,
            git_stage_paths,
            git_unstage_paths,
            git_stage_all,
            git_unstage_all,
            git_commit,
            git_diff,
            git_fetch,
            git_pull,
            git_push,
            git_credential_status,
            git_credential_store,
            git_credential_delete,
            docker_snapshot,
            docker_pull,
            docker_create,
            docker_start,
            docker_stop,
            docker_restart,
            docker_remove,
            docker_logs,
            database_connections,
            database_sqlite_select,
            database_schema,
            database_query,
            database_set_write_access,
            database_disconnect,
            database_postgres_connections,
            database_postgres_connect,
            database_postgres_schema,
            database_postgres_query,
            database_postgres_execute,
            database_postgres_set_write_access,
            database_postgres_disconnect,
            database_postgres_forget_password,
            http_request,
            ollama_list_models,
            ollama_chat,
            ai_credential_status,
            ai_credential_store,
            ai_credential_delete,
            ai_provider_chat,
            test_runner_snapshot,
            test_runner_run,
            toolchain_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevLab");
}
