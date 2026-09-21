use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::ValueRef,
    Connection, ErrorCode, OpenFlags,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    str,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::workspace::{CommandError, ScopedWorkspaceFile, WorkspaceService};

const MAX_CONNECTIONS: usize = 8;
const MAX_CONNECTION_ID_BYTES: usize = 64;
const MAX_SQL_BYTES: usize = 64 * 1024;
const MAX_RESULT_ROWS: usize = 1_000;
const MAX_RESULT_COLUMNS: usize = 200;
const MAX_CELL_BYTES: usize = 64 * 1024;
const MAX_RESULT_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_SCHEMA_OBJECTS: usize = 2_000;
const MAX_SCHEMA_COLUMNS: usize = 20_000;
const MAX_SCHEMA_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 1_024;
const SQLITE_VALUE_LIMIT: i32 = 2 * 1024 * 1024;
const SQLITE_VDBE_OPERATION_LIMIT: i32 = 5_000_000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

struct SqliteSession {
    connection: Connection,
    path: PathBuf,
    relative_path: String,
    workspace_root: PathBuf,
    name: String,
    allow_writes: bool,
    sqlite_version: String,
}

#[derive(Default)]
struct DatabaseInner {
    next_id: u64,
    sessions: HashMap<String, SqliteSession>,
}

#[derive(Default)]
pub struct DatabaseService {
    inner: Mutex<DatabaseInner>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnectionInfo {
    id: String,
    name: String,
    engine: &'static str,
    path: String,
    allow_writes: bool,
    sqlite_version: String,
    file_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSchema {
    connection: DatabaseConnectionInfo,
    objects: Vec<DatabaseObject>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseObject {
    name: String,
    kind: String,
    columns: Vec<DatabaseColumn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseColumn {
    position: i64,
    name: String,
    data_type: String,
    not_null: bool,
    default_value: Option<String>,
    default_value_truncated: bool,
    primary_key: bool,
    hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCell {
    kind: &'static str,
    value: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryResult {
    columns: Vec<String>,
    rows: Vec<Vec<DatabaseCell>>,
    row_count: usize,
    affected_rows: u64,
    read_only: bool,
    truncated: bool,
    elapsed_ms: u64,
}

impl DatabaseService {
    fn lock(&self) -> Result<MutexGuard<'_, DatabaseInner>, CommandError> {
        self.inner.lock().map_err(|_| {
            CommandError::new(
                "database_state_unavailable",
                "Database connection state is unavailable.",
            )
        })
    }

    fn connections(
        &self,
        workspace_root: &Path,
    ) -> Result<Vec<DatabaseConnectionInfo>, CommandError> {
        let mut inner = self.lock()?;
        inner
            .sessions
            .retain(|_, session| session.workspace_root == workspace_root);
        let mut values = inner
            .sessions
            .iter()
            .map(|(id, session)| connection_info(id, session))
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        Ok(values)
    }

    fn add_sqlite(
        &self,
        scoped: ScopedWorkspaceFile,
        allow_writes: bool,
    ) -> Result<DatabaseConnectionInfo, CommandError> {
        let (connection, sqlite_version) = open_sqlite(&scoped.path, allow_writes)?;
        let name = scoped
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                CommandError::new(
                    "unsupported_filename",
                    "The selected SQLite filename is not valid Unicode.",
                )
            })?
            .to_string();

        let mut inner = self.lock()?;
        inner
            .sessions
            .retain(|_, session| session.workspace_root == scoped.workspace_root);
        if inner
            .sessions
            .values()
            .any(|session| session.path == scoped.path)
        {
            return Err(CommandError::new(
                "database_already_open",
                "That SQLite database is already open. Change its access mode from the connection panel.",
            ));
        }
        if inner.sessions.len() >= MAX_CONNECTIONS {
            return Err(CommandError::new(
                "database_connection_limit",
                format!("DevLab keeps at most {MAX_CONNECTIONS} database connections open."),
            ));
        }
        inner.next_id = inner.next_id.saturating_add(1);
        let id = format!("sqlite-{}", inner.next_id);
        inner.sessions.insert(
            id.clone(),
            SqliteSession {
                connection,
                path: scoped.path,
                relative_path: scoped.relative_path,
                workspace_root: scoped.workspace_root,
                name,
                allow_writes,
                sqlite_version,
            },
        );
        let session = inner.sessions.get(&id).ok_or_else(|| {
            CommandError::new(
                "database_state_unavailable",
                "The SQLite connection could not be retained.",
            )
        })?;
        Ok(connection_info(&id, session))
    }

    fn schema(
        &self,
        workspace_root: &Path,
        id: &str,
    ) -> Result<DatabaseSchema, CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        let info = connection_info(id, session);
        let objects = read_schema(&mut session.connection)?;
        Ok(DatabaseSchema {
            connection: info,
            objects,
        })
    }

    fn query(
        &self,
        workspace_root: &Path,
        id: &str,
        sql: &str,
        confirmed_write: bool,
    ) -> Result<DatabaseQueryResult, CommandError> {
        validate_connection_id(id)?;
        validate_sql(sql)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        run_query(session, sql, confirmed_write)
    }

    fn set_write_access(
        &self,
        workspace_root: &Path,
        id: &str,
        allow_writes: bool,
    ) -> Result<DatabaseConnectionInfo, CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        if session.allow_writes == allow_writes {
            return Ok(connection_info(id, session));
        }
        let (connection, sqlite_version) = open_sqlite(&session.path, allow_writes)?;
        session.connection = connection;
        session.allow_writes = allow_writes;
        session.sqlite_version = sqlite_version;
        Ok(connection_info(id, session))
    }

    fn disconnect(&self, workspace_root: &Path, id: &str) -> Result<(), CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let belongs_to_workspace = inner
            .sessions
            .get(id)
            .is_some_and(|session| session.workspace_root == workspace_root);
        if !belongs_to_workspace {
            return Err(CommandError::new(
                "database_connection_not_found",
                "The requested database connection is not open in the active workspace.",
            ));
        }
        inner.sessions.remove(id);
        Ok(())
    }
}

fn connection_info(id: &str, session: &SqliteSession) -> DatabaseConnectionInfo {
    DatabaseConnectionInfo {
        id: id.to_string(),
        name: session.name.clone(),
        engine: "SQLite",
        path: session.relative_path.clone(),
        allow_writes: session.allow_writes,
        sqlite_version: session.sqlite_version.clone(),
        file_size: fs::metadata(&session.path).ok().map(|metadata| metadata.len()),
    }
}

fn require_session<'a>(
    inner: &'a mut DatabaseInner,
    workspace_root: &Path,
    id: &str,
) -> Result<&'a mut SqliteSession, CommandError> {
    let session = inner.sessions.get_mut(id).ok_or_else(|| {
        CommandError::new(
            "database_connection_not_found",
            "The requested database connection is no longer open.",
        )
    })?;
    if session.workspace_root != workspace_root {
        return Err(CommandError::new(
            "database_workspace_changed",
            "The active workspace changed. Reopen the database from the current workspace.",
        ));
    }
    Ok(session)
}

fn validate_connection_id(id: &str) -> Result<(), CommandError> {
    if id.len() <= "sqlite-".len()
        || id.len() > MAX_CONNECTION_ID_BYTES
        || !id.starts_with("sqlite-")
        || !id[7..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(CommandError::new(
            "invalid_database_connection",
            "The database connection identifier is invalid.",
        ));
    }
    Ok(())
}

fn validate_sql(sql: &str) -> Result<(), CommandError> {
    if sql.trim().is_empty() {
        return Err(CommandError::new(
            "database_query_empty",
            "Enter one SQL statement before running the query.",
        ));
    }
    if sql.len() > MAX_SQL_BYTES {
        return Err(CommandError::new(
            "database_query_too_large",
            format!("SQL statements are limited to {} KiB.", MAX_SQL_BYTES / 1024),
        ));
    }
    if sql.contains('\0') {
        return Err(CommandError::new(
            "invalid_database_query",
            "SQL statements cannot contain null bytes.",
        ));
    }
    Ok(())
}

fn open_sqlite(path: &Path, allow_writes: bool) -> Result<(Connection, String), CommandError> {
    let access = if allow_writes {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let connection = Connection::open_with_flags(path, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|error| sqlite_error("open the SQLite database", error))?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|error| sqlite_error("configure the SQLite busy timeout", error))?;
    connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, SQLITE_VALUE_LIMIT);
    connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MAX_SQL_BYTES as i32);
    connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    connection.set_limit(
        Limit::SQLITE_LIMIT_VDBE_OP,
        SQLITE_VDBE_OPERATION_LIMIT,
    );
    connection.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0);
    connection
        .execute_batch("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;")
        .map_err(|error| sqlite_error("configure the SQLite connection", error))?;
    connection.authorizer(Some(database_authorizer));

    let sqlite_version = connection
        .query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
        .map_err(|error| sqlite_error("read the SQLite version", error))?;
    connection
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| sqlite_error("verify the SQLite database", error))?;
    Ok((connection, sqlite_version))
}

fn database_authorizer(context: AuthContext<'_>) -> Authorization {
    match context.action {
        AuthAction::Pragma { pragma_name, .. }
            if [
                "table_info",
                "table_xinfo",
                "index_info",
                "index_xinfo",
                "index_list",
                "foreign_key_list",
                "compile_options",
            ]
            .iter()
            .any(|allowed| pragma_name.eq_ignore_ascii_case(allowed)) =>
        {
            Authorization::Allow
        }
        AuthAction::Attach { .. }
        | AuthAction::Detach { .. }
        | AuthAction::Pragma { .. }
        | AuthAction::Transaction { .. }
        | AuthAction::Savepoint { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTempTable { .. }
        | AuthAction::CreateTempTrigger { .. }
        | AuthAction::CreateTempView { .. }
        | AuthAction::DropTempIndex { .. }
        | AuthAction::DropTempTable { .. }
        | AuthAction::DropTempTrigger { .. }
        | AuthAction::DropTempView { .. }
        | AuthAction::CreateVtable { .. }
        | AuthAction::DropVtable { .. }
        | AuthAction::Unknown { .. } => Authorization::Deny,
        AuthAction::Function { function_name }
            if ["load_extension", "readfile", "writefile", "edit"]
                .iter()
                .any(|blocked| function_name.eq_ignore_ascii_case(blocked)) =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }
}

fn install_query_timeout(connection: &mut Connection) {
    let started = Instant::now();
    connection.progress_handler(
        1_000,
        Some(move || started.elapsed() >= QUERY_TIMEOUT),
    );
}

fn clear_query_timeout(connection: &mut Connection) {
    connection.progress_handler(0, None::<fn() -> bool>);
}

fn read_schema(connection: &mut Connection) -> Result<Vec<DatabaseObject>, CommandError> {
    install_query_timeout(connection);
    let result = (|| {
        let mut statement = connection
            .prepare(
                "SELECT type, name FROM sqlite_schema \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
            )
            .map_err(|error| sqlite_error("prepare the schema query", error))?;
        let mut rows = statement
            .query([])
            .map_err(|error| sqlite_error("read the SQLite schema", error))?;
        let mut identities = Vec::new();
        let mut schema_bytes = 0_usize;
        while let Some(row) = rows
            .next()
            .map_err(|error| sqlite_error("read the SQLite schema", error))?
        {
            if identities.len() >= MAX_SCHEMA_OBJECTS {
                return Err(CommandError::new(
                    "database_schema_too_large",
                    format!("The database has more than {MAX_SCHEMA_OBJECTS} tables and views."),
                ));
            }
            let kind = row
                .get::<_, String>(0)
                .map_err(|error| sqlite_error("read a schema object type", error))?;
            let name = row
                .get::<_, String>(1)
                .map_err(|error| sqlite_error("read a schema object name", error))?;
            validate_identifier_output(&name)?;
            schema_bytes = schema_bytes
                .saturating_add(name.len().saturating_mul(6))
                .saturating_add(kind.len().saturating_mul(6))
                .saturating_add(32);
            if schema_bytes > MAX_SCHEMA_JSON_BYTES {
                return Err(CommandError::new(
                    "database_schema_too_large",
                    "The encoded schema exceeds DevLab's 2 MiB response limit.",
                ));
            }
            identities.push((kind, name));
        }
        drop(rows);
        drop(statement);

        let mut total_columns = 0_usize;
        let mut objects = Vec::with_capacity(identities.len());
        for (kind, name) in identities {
            let mut statement = connection
                .prepare(
                    "SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden \
                     FROM pragma_table_xinfo(?1) ORDER BY cid",
                )
                .map_err(|error| sqlite_error("prepare the table-column query", error))?;
            let mut rows = statement
                .query([&name])
                .map_err(|error| sqlite_error("read table columns", error))?;
            let mut columns = Vec::new();
            while let Some(row) = rows
                .next()
                .map_err(|error| sqlite_error("read table columns", error))?
            {
                total_columns = total_columns.saturating_add(1);
                if total_columns > MAX_SCHEMA_COLUMNS {
                    return Err(CommandError::new(
                        "database_schema_too_large",
                        format!("The schema has more than {MAX_SCHEMA_COLUMNS} columns."),
                    ));
                }
                let column_name = row
                    .get::<_, String>(1)
                    .map_err(|error| sqlite_error("read a column name", error))?;
                let data_type = row
                    .get::<_, String>(2)
                    .map_err(|error| sqlite_error("read a column type", error))?;
                validate_identifier_output(&column_name)?;
                validate_identifier_output(&data_type)?;
                let (default_value, default_value_truncated) = match row
                    .get::<_, Option<String>>(4)
                    .map_err(|error| sqlite_error("read a column default", error))?
                {
                    Some(value) => {
                        let (value, truncated) = truncate_text(&value, MAX_CELL_BYTES);
                        (Some(value), truncated)
                    }
                    None => (None, false),
                };
                let column = DatabaseColumn {
                    position: row
                        .get(0)
                        .map_err(|error| sqlite_error("read a column position", error))?,
                    name: column_name,
                    data_type,
                    not_null: row
                        .get::<_, i64>(3)
                        .map_err(|error| sqlite_error("read a column constraint", error))?
                        != 0,
                    default_value,
                    default_value_truncated,
                    primary_key: row
                        .get::<_, i64>(5)
                        .map_err(|error| sqlite_error("read a primary-key flag", error))?
                        != 0,
                    hidden: row
                        .get::<_, i64>(6)
                        .map_err(|error| sqlite_error("read a hidden-column flag", error))?
                        != 0,
                };
                schema_bytes = schema_bytes.saturating_add(
                    serde_json::to_vec(&column)
                        .map_err(|_| {
                            CommandError::new(
                                "database_schema_failed",
                                "Could not encode a database column.",
                            )
                        })?
                        .len(),
                );
                if schema_bytes > MAX_SCHEMA_JSON_BYTES {
                    return Err(CommandError::new(
                        "database_schema_too_large",
                        "The encoded schema exceeds DevLab's 2 MiB response limit.",
                    ));
                }
                columns.push(column);
            }
            objects.push(DatabaseObject {
                name,
                kind,
                columns,
            });
        }
        Ok(objects)
    })();
    clear_query_timeout(connection);
    result
}

fn run_query(
    session: &mut SqliteSession,
    sql: &str,
    confirmed_write: bool,
) -> Result<DatabaseQueryResult, CommandError> {
    install_query_timeout(&mut session.connection);
    let started = Instant::now();
    let result = (|| {
        let mut statement = session
            .connection
            .prepare(sql)
            .map_err(|error| sqlite_error("prepare the SQL statement", error))?;
        if statement.parameter_count() != 0 {
            return Err(CommandError::new(
                "database_parameters_unsupported",
                "Parameterized statements are not exposed in this checkpoint. Enter a statement without unbound parameters.",
            ));
        }
        let read_only = statement.readonly();
        if !read_only && !session.allow_writes {
            return Err(CommandError::new(
                "database_read_only",
                "This connection is read-only. Explicitly enable writes for the connection before running a mutating statement.",
            ));
        }
        if !read_only && !confirmed_write {
            return Err(CommandError::new(
                "database_write_confirmation_required",
                "This statement can modify the database and requires confirmation before execution.",
            ));
        }

        let column_count = statement.column_count();
        if column_count > MAX_RESULT_COLUMNS {
            return Err(CommandError::new(
                "database_result_too_wide",
                format!("Query results are limited to {MAX_RESULT_COLUMNS} columns."),
            ));
        }
        let mut columns = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let name = statement
                .column_name(index)
                .map_err(|error| sqlite_error("read a result-column name", error))?;
            validate_identifier_output(name)?;
            columns.push(name.to_string());
        }

        if column_count == 0 {
            let affected_rows = statement
                .execute([])
                .map_err(|error| sqlite_error("execute the SQL statement", error))?
                as u64;
            return Ok(DatabaseQueryResult {
                columns,
                rows: Vec::new(),
                row_count: 0,
                affected_rows,
                read_only,
                truncated: false,
                elapsed_ms: elapsed_ms(started),
            });
        }

        let mut rows_cursor = statement
            .query([])
            .map_err(|error| sqlite_error("execute the SQL query", error))?;
        let mut rows = Vec::new();
        let mut result_bytes = serde_json::to_vec(&columns)
            .map_err(|_| CommandError::new("database_result_failed", "Could not encode query columns."))?
            .len();
        let mut truncated = false;
        let mut capture_results = true;
        while let Some(row) = rows_cursor
            .next()
            .map_err(|error| sqlite_error("read a query row", error))?
        {
            if !capture_results || rows.len() >= MAX_RESULT_ROWS {
                truncated = true;
                capture_results = false;
                if read_only {
                    break;
                }
                continue;
            }
            let mut values = Vec::with_capacity(column_count);
            for index in 0..column_count {
                let value = row
                    .get_ref(index)
                    .map_err(|error| sqlite_error("read a query value", error))?;
                values.push(cell_from_value(value));
            }
            if values.iter().any(|value| value.truncated) {
                truncated = true;
            }
            let encoded_size = serde_json::to_vec(&values)
                .map_err(|_| CommandError::new("database_result_failed", "Could not encode a query row."))?
                .len();
            if result_bytes.saturating_add(encoded_size) > MAX_RESULT_JSON_BYTES {
                truncated = true;
                capture_results = false;
                if read_only {
                    break;
                }
                continue;
            }
            result_bytes = result_bytes.saturating_add(encoded_size);
            rows.push(values);
        }
        drop(rows_cursor);
        drop(statement);
        let affected_rows = if read_only {
            0
        } else {
            session.connection.changes()
        };
        Ok(DatabaseQueryResult {
            columns,
            row_count: rows.len(),
            rows,
            affected_rows,
            read_only,
            truncated,
            elapsed_ms: elapsed_ms(started),
        })
    })();
    clear_query_timeout(&mut session.connection);
    result
}

fn cell_from_value(value: ValueRef<'_>) -> DatabaseCell {
    match value {
        ValueRef::Null => DatabaseCell {
            kind: "null",
            value: "NULL".to_string(),
            truncated: false,
        },
        ValueRef::Integer(value) => DatabaseCell {
            kind: "integer",
            value: value.to_string(),
            truncated: false,
        },
        ValueRef::Real(value) => DatabaseCell {
            kind: "real",
            value: value.to_string(),
            truncated: false,
        },
        ValueRef::Text(value) => match str::from_utf8(value) {
            Ok(value) => {
                let (value, truncated) = truncate_text(value, MAX_CELL_BYTES);
                DatabaseCell {
                    kind: "text",
                    value,
                    truncated,
                }
            }
            Err(_) => DatabaseCell {
                kind: "text",
                value: format!("<invalid UTF-8 · {} bytes>", value.len()),
                truncated: true,
            },
        },
        ValueRef::Blob(value) => DatabaseCell {
            kind: "blob",
            value: format!("<BLOB · {} bytes>", value.len()),
            truncated: !value.is_empty(),
        },
    }
}

fn truncate_text(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push('…');
    (output, true)
}

fn validate_identifier_output(value: &str) -> Result<(), CommandError> {
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(CommandError::new(
            "database_identifier_too_large",
            format!("A database identifier exceeded the {MAX_IDENTIFIER_BYTES}-byte display limit."),
        ));
    }
    Ok(())
}

fn elapsed_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn sqlite_error(action: &str, error: rusqlite::Error) -> CommandError {
    let code = match error.sqlite_error_code() {
        Some(ErrorCode::OperationInterrupted) => "database_query_timeout",
        Some(ErrorCode::AuthorizationForStatementDenied) => "database_statement_restricted",
        _ => "database_error",
    };
    let message = if code == "database_query_timeout" {
        format!("Could not {action}: the SQLite operation exceeded the five-second limit.")
    } else if code == "database_statement_restricted" {
        format!(
            "Could not {action}: DevLab blocks ATTACH, DETACH, configuration PRAGMAs, explicit transactions, temporary or virtual-table DDL, and filesystem-capable SQL functions."
        )
    } else {
        let detail = error.to_string();
        let (detail, _) = truncate_text(&detail, 8 * 1024);
        format!("Could not {action}: {detail}")
    };
    CommandError::new(code, message)
}

async fn blocking<T, F>(work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            CommandError::new(
                "database_worker_failed",
                "The database worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub fn database_connections(
    app: AppHandle,
) -> Result<Vec<DatabaseConnectionInfo>, CommandError> {
    let workspace_root = app.state::<WorkspaceService>().root_path()?;
    app.state::<DatabaseService>().connections(&workspace_root)
}

#[tauri::command]
pub async fn database_sqlite_select(
    app: AppHandle,
    allow_writes: bool,
) -> Result<Option<DatabaseConnectionInfo>, CommandError> {
    app.state::<WorkspaceService>().root_path()?;
    let selected = app
        .dialog()
        .file()
        .set_title("Open an existing SQLite database inside the workspace")
        .blocking_pick_file();
    let selected = match selected {
        Some(selected) => selected,
        None => return Ok(None),
    };
    let selected_path = selected.as_path().ok_or_else(|| {
        CommandError::new(
            "unsupported_selection",
            "The selected database is not available as a local filesystem path.",
        )
    })?;
    let scoped = app
        .state::<WorkspaceService>()
        .authorize_existing_file(selected_path)?;
    app.state::<DatabaseService>()
        .add_sqlite(scoped, allow_writes)
        .map(Some)
}

#[tauri::command]
pub async fn database_schema(
    app: AppHandle,
    id: String,
) -> Result<DatabaseSchema, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<DatabaseService>().schema(&workspace_root, &id)
    })
    .await
}

#[tauri::command]
pub async fn database_query(
    app: AppHandle,
    id: String,
    sql: String,
    confirmed_write: bool,
) -> Result<DatabaseQueryResult, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<DatabaseService>()
            .query(&workspace_root, &id, &sql, confirmed_write)
    })
    .await
}

#[tauri::command]
pub async fn database_set_write_access(
    app: AppHandle,
    id: String,
    allow_writes: bool,
) -> Result<DatabaseConnectionInfo, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<DatabaseService>()
            .set_write_access(&workspace_root, &id, allow_writes)
    })
    .await
}

#[tauri::command]
pub fn database_disconnect(app: AppHandle, id: String) -> Result<(), CommandError> {
    let workspace_root = app.state::<WorkspaceService>().root_path()?;
    app.state::<DatabaseService>()
        .disconnect(&workspace_root, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_session(allow_writes: bool) -> SqliteSession {
        let connection = Connection::open_in_memory().expect("database should open");
        connection
            .execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL);")
            .expect("table should be created before tests run");
        connection.authorizer(Some(database_authorizer));
        SqliteSession {
            connection,
            path: PathBuf::new(),
            relative_path: "test.sqlite".to_string(),
            workspace_root: PathBuf::new(),
            name: "test.sqlite".to_string(),
            allow_writes,
            sqlite_version: "test".to_string(),
        }
    }

    #[test]
    fn validates_connection_ids_and_sql_bounds() {
        assert!(validate_connection_id("sqlite-1").is_ok());
        assert!(validate_connection_id("sqlite-").is_err());
        assert!(validate_connection_id("sqlite-one").is_err());
        assert!(validate_connection_id("git-1").is_err());
        assert!(validate_sql("SELECT 1").is_ok());
        assert!(validate_sql("  ").is_err());
        assert!(validate_sql("SELECT '\0'").is_err());
    }

    #[test]
    fn read_only_mode_rejects_writes() {
        let mut session = test_session(false);
        let result = run_query(&mut session, "INSERT INTO users(name) VALUES ('Ava')", true)
            .expect_err("read-only connection must reject writes");
        assert_eq!(result.code, "database_read_only");
    }

    #[test]
    fn write_mode_requires_confirmation_and_returns_real_rows() {
        let mut session = test_session(true);
        let error = run_query(
            &mut session,
            "INSERT INTO users(name) VALUES ('Ava')",
            false,
        )
        .expect_err("write should need confirmation");
        assert_eq!(error.code, "database_write_confirmation_required");

        let write = run_query(
            &mut session,
            "INSERT INTO users(name) VALUES ('Ava')",
            true,
        )
        .expect("confirmed write should run");
        assert_eq!(write.affected_rows, 1);
        let read = run_query(
            &mut session,
            "SELECT id, name FROM users ORDER BY id",
            false,
        )
        .expect("read should run");
        assert_eq!(read.row_count, 1);
        assert_eq!(read.rows[0][1].value, "Ava");
    }

    #[test]
    fn accepts_one_statement_and_safe_schema_inspection() {
        let mut session = test_session(false);
        let schema = read_schema(&mut session.connection).expect("real schema should load");
        assert_eq!(schema[0].name, "users");
        let columns = run_query(&mut session, "PRAGMA table_info(users)", false)
            .expect("safe schema PRAGMA should run");
        assert!(!columns.rows.is_empty());
        assert!(run_query(&mut session, "SELECT 1; SELECT 2", false).is_err());
    }

    #[test]
    fn authorizer_rejects_filesystem_and_connection_escape_statements() {
        let mut session = test_session(true);
        for sql in [
            "ATTACH DATABASE 'outside.sqlite' AS outside",
            "PRAGMA writable_schema = ON",
            "BEGIN TRANSACTION",
            "CREATE VIRTUAL TABLE search USING fts5(value)",
        ] {
            let error = run_query(&mut session, sql, true)
                .expect_err("restricted SQLite statement should fail");
            assert_eq!(error.code, "database_statement_restricted");
        }
    }

    #[test]
    fn truncates_large_cells_without_fabricating_values() {
        let value = "x".repeat(MAX_CELL_BYTES + 100);
        let cell = cell_from_value(ValueRef::Text(value.as_bytes()));
        assert!(cell.truncated);
        assert!(cell.value.ends_with('…'));
        assert!(cell.value.len() <= MAX_CELL_BYTES + '…'.len_utf8());
    }
}
