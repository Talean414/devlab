use keyring::{error::Error as KeyringError, Entry};
use native_tls::TlsConnector;
use ::postgres::{config::SslMode, types::Type, Client, Config, NoTls};
use fallible_iterator::FallibleIterator;
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    error::Error as StdError,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::workspace::{CommandError, WorkspaceService};

const KEYRING_SERVICE: &str = "io.github.talean414.devlab.postgresql";
const MAX_POSTGRES_CONNECTIONS: usize = 4;
const MAX_CONNECTION_ID_BYTES: usize = 64;
const MAX_HOST_BYTES: usize = 253;
const MAX_NAME_BYTES: usize = 128;
const MAX_PASSWORD_BYTES: usize = 8 * 1024;
const MAX_ERROR_BYTES: usize = 2 * 1024;
const MAX_SCHEMA_OBJECTS: usize = 2_000;
const MAX_SCHEMA_COLUMNS: usize = 20_000;
const MAX_SCHEMA_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 1_024;
const MAX_DEFAULT_BYTES: usize = 64 * 1024;
const MAX_SQL_BYTES: usize = 64 * 1024;
const MAX_RESULT_ROWS: usize = 1_000;
const MAX_RESULT_COLUMNS: usize = 200;
const MAX_CELL_CHARACTERS: usize = 16_384;
const MAX_RESULT_JSON_BYTES: usize = 2 * 1024 * 1024;
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// SQLSTATE 25006: the server refused a statement because its transaction is read-only.
const READ_ONLY_SQL_STATE: &str = "25006";
/// Internal marker used when the read-only probe classifies a statement as a write.
const READ_ONLY_PROBE_CODE: &str = "postgres_read_only_transaction";
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PostgresTlsMode {
    VerifyFull,
    Disable,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresConnectRequest {
    host: String,
    port: u32,
    database: String,
    username: String,
    password: String,
    tls_mode: PostgresTlsMode,
    allow_writes: bool,
    store_password: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresConnectionInfo {
    id: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    tls_mode: PostgresTlsMode,
    allow_writes: bool,
    server_version: String,
    credential_stored: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresSchema {
    connection: PostgresConnectionInfo,
    objects: Vec<PostgresObject>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresObject {
    schema: String,
    name: String,
    kind: &'static str,
    columns: Vec<PostgresColumn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresColumn {
    position: i64,
    name: String,
    data_type: String,
    not_null: bool,
    default_value: Option<String>,
    default_value_truncated: bool,
    primary_key: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresCell {
    kind: &'static str,
    value: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostgresQueryResult {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<PostgresCell>>,
    row_count: usize,
    affected_rows: u64,
    read_only: bool,
    truncated: bool,
    elapsed_ms: u64,
}

struct PostgresSession {
    client: Client,
    workspace_root: PathBuf,
    host: String,
    port: u16,
    database: String,
    username: String,
    tls_mode: PostgresTlsMode,
    allow_writes: bool,
    server_version: String,
    credential_account: String,
    credential_stored: bool,
}

#[derive(Default)]
struct PostgresInner {
    next_id: u64,
    sessions: HashMap<String, PostgresSession>,
}

#[derive(Default)]
pub struct PostgresService {
    inner: Mutex<PostgresInner>,
}

impl PostgresService {
    fn lock(&self) -> Result<MutexGuard<'_, PostgresInner>, CommandError> {
        self.inner.lock().map_err(|_| {
            CommandError::new(
                "postgres_state_unavailable",
                "PostgreSQL connection state is unavailable.",
            )
        })
    }

    fn connections(
        &self,
        workspace_root: &Path,
    ) -> Result<Vec<PostgresConnectionInfo>, CommandError> {
        let mut inner = self.lock()?;
        inner
            .sessions
            .retain(|_, session| session.workspace_root == workspace_root);
        let mut connections = inner
            .sessions
            .iter()
            .map(|(id, session)| connection_info(id, session))
            .collect::<Vec<_>>();
        connections.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        Ok(connections)
    }

    fn schema(
        &self,
        workspace_root: &Path,
        id: &str,
    ) -> Result<PostgresSchema, CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        let connection = connection_info(id, session);
        let objects = read_schema(&mut session.client)?;
        Ok(PostgresSchema {
            connection,
            objects,
        })
    }

    fn query(
        &self,
        workspace_root: &Path,
        id: &str,
        sql: &str,
    ) -> Result<PostgresQueryResult, CommandError> {
        validate_connection_id(id)?;
        validate_read_query(sql)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        run_read_query(&mut session.client, sql)
    }

    /// Runs one statement that may read or mutate.
    ///
    /// Classification is done by the server, not by string parsing: the first
    /// attempt always runs inside a read-only transaction, so PostgreSQL
    /// rejects any mutation with SQLSTATE 25006 before it can change data. A
    /// statement is only re-run in a write transaction when the connection has
    /// writes enabled and the user confirmed that exact statement.
    fn execute(
        &self,
        workspace_root: &Path,
        id: &str,
        sql: &str,
        confirmed_write: bool,
    ) -> Result<PostgresQueryResult, CommandError> {
        validate_connection_id(id)?;
        validate_write_query(sql)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        run_write_query(&mut session.client, sql, session.allow_writes, confirmed_write)
    }

    fn set_write_access(
        &self,
        workspace_root: &Path,
        id: &str,
        allow_writes: bool,
    ) -> Result<PostgresConnectionInfo, CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let session = require_session(&mut inner, workspace_root, id)?;
        if session.allow_writes == allow_writes {
            return Ok(connection_info(id, session));
        }
        session
            .client
            .batch_execute(if allow_writes {
                "SET default_transaction_read_only = off;"
            } else {
                "SET default_transaction_read_only = on;"
            })
            .map_err(|error| postgres_error("change the PostgreSQL write policy", error))?;
        session.allow_writes = allow_writes;
        Ok(connection_info(id, session))
    }

    fn connect(
        &self,
        workspace_root: PathBuf,
        request: PostgresConnectRequest,
    ) -> Result<PostgresConnectionInfo, CommandError> {
        validate_request(&request)?;
        let port = request.port as u16;
        let account = credential_account(&request);
        {
            let mut inner = self.lock()?;
            inner
                .sessions
                .retain(|_, session| session.workspace_root == workspace_root);
            if inner
                .sessions
                .values()
                .any(|session| session.credential_account == account)
            {
                return Err(CommandError::new(
                    "postgres_already_connected",
                    "That PostgreSQL server, database and user are already connected.",
                ));
            }
            if inner.sessions.len() >= MAX_POSTGRES_CONNECTIONS {
                return Err(CommandError::new(
                    "postgres_connection_limit",
                    format!(
                        "DevLab keeps at most {MAX_POSTGRES_CONNECTIONS} PostgreSQL connections open."
                    ),
                ));
            }
        }

        let supplied_password = Zeroizing::new(request.password);
        let mut password = if supplied_password.is_empty() && request.store_password {
            load_password(&account)?.ok_or_else(|| {
                CommandError::new(
                    "postgres_password_required",
                    "No password is stored for this PostgreSQL identity. Enter one or turn off secure password reuse for passwordless authentication.",
                )
            })?
        } else {
            Zeroizing::new(supplied_password.to_string())
        };
        if password.len() > MAX_PASSWORD_BYTES || password.contains('\0') {
            return Err(CommandError::new(
                "invalid_postgres_password",
                format!(
                    "PostgreSQL passwords cannot contain null characters or exceed {MAX_PASSWORD_BYTES} bytes."
                ),
            ));
        }

        let mut config = Config::new();
        config
            .host(&request.host)
            .port(port)
            .dbname(&request.database)
            .user(&request.username)
            .application_name("DevLab")
            .connect_timeout(CONNECT_TIMEOUT)
            .ssl_mode(match request.tls_mode {
                PostgresTlsMode::VerifyFull => SslMode::Require,
                PostgresTlsMode::Disable => SslMode::Disable,
            });
        if !password.is_empty() {
            config.password(password.as_str());
        }

        let mut client = connect_client(&config, request.tls_mode)?;
        password.clear();
        client
            .batch_execute(if request.allow_writes {
                "SET statement_timeout = '5s'; SET lock_timeout = '2s'; SET idle_in_transaction_session_timeout = '5s'; SET default_transaction_read_only = off;"
            } else {
                "SET statement_timeout = '5s'; SET lock_timeout = '2s'; SET idle_in_transaction_session_timeout = '5s'; SET default_transaction_read_only = on;"
            })
            .map_err(|error| postgres_error("configure the PostgreSQL session", error))?;
        let server_version = client
            .query_one("SELECT current_setting('server_version')::text", &[])
            .and_then(|row| row.try_get::<_, String>(0))
            .map_err(|error| postgres_error("read the PostgreSQL server version", error))?;

        let mut inner = self.lock()?;
        inner
            .sessions
            .retain(|_, session| session.workspace_root == workspace_root);
        if inner
            .sessions
            .values()
            .any(|session| session.credential_account == account)
        {
            return Err(CommandError::new(
                "postgres_already_connected",
                "That PostgreSQL server, database and user are already connected.",
            ));
        }
        if inner.sessions.len() >= MAX_POSTGRES_CONNECTIONS {
            return Err(CommandError::new(
                "postgres_connection_limit",
                format!(
                    "DevLab keeps at most {MAX_POSTGRES_CONNECTIONS} PostgreSQL connections open."
                ),
            ));
        }
        if request.store_password && !supplied_password.is_empty() {
            store_password(&account, supplied_password.as_str())?;
        }
        let credential_stored = if request.store_password {
            true
        } else {
            credential_exists(&account).unwrap_or(false)
        };
        inner.next_id = inner.next_id.saturating_add(1);
        let id = format!("postgres-{}", inner.next_id);
        inner.sessions.insert(
            id.clone(),
            PostgresSession {
                client,
                workspace_root,
                host: request.host,
                port,
                database: request.database,
                username: request.username,
                tls_mode: request.tls_mode,
                allow_writes: request.allow_writes,
                server_version,
                credential_account: account,
                credential_stored,
            },
        );
        let session = inner.sessions.get(&id).ok_or_else(|| {
            CommandError::new(
                "postgres_state_unavailable",
                "The PostgreSQL connection could not be retained.",
            )
        })?;
        Ok(connection_info(&id, session))
    }

    fn disconnect(&self, workspace_root: &Path, id: &str) -> Result<(), CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let belongs = inner
            .sessions
            .get(id)
            .map(|session| session.workspace_root == workspace_root)
            .unwrap_or(false);
        if !belongs {
            return Err(CommandError::new(
                "postgres_connection_not_found",
                "The PostgreSQL connection is not open in the active workspace.",
            ));
        }
        inner.sessions.remove(id);
        Ok(())
    }

    fn forget_password(
        &self,
        workspace_root: &Path,
        id: &str,
    ) -> Result<PostgresConnectionInfo, CommandError> {
        validate_connection_id(id)?;
        let mut inner = self.lock()?;
        let session = inner.sessions.get_mut(id).ok_or_else(|| {
            CommandError::new(
                "postgres_connection_not_found",
                "The PostgreSQL connection is not open.",
            )
        })?;
        if session.workspace_root != workspace_root {
            return Err(CommandError::new(
                "postgres_connection_not_found",
                "The PostgreSQL connection is not open in the active workspace.",
            ));
        }
        delete_password(&session.credential_account)?;
        session.credential_stored = false;
        Ok(connection_info(id, session))
    }
}

fn connect_client(config: &Config, tls_mode: PostgresTlsMode) -> Result<Client, CommandError> {
    match tls_mode {
        PostgresTlsMode::VerifyFull => {
            let connector = TlsConnector::builder().build().map_err(|error| {
                CommandError::new(
                    "postgres_tls_failed",
                    format!("Could not initialize the operating-system TLS verifier: {error}"),
                )
            })?;
            config
                .connect(MakeTlsConnector::new(connector))
                .map_err(|error| postgres_error("connect to PostgreSQL with verified TLS", error))
        }
        PostgresTlsMode::Disable => config
            .connect(NoTls)
            .map_err(|error| postgres_error("connect to PostgreSQL without TLS", error)),
    }
}

fn connection_info(id: &str, session: &PostgresSession) -> PostgresConnectionInfo {
    PostgresConnectionInfo {
        id: id.to_string(),
        name: format!("{}@{}", session.database, session.host),
        host: session.host.clone(),
        port: session.port,
        database: session.database.clone(),
        username: session.username.clone(),
        tls_mode: session.tls_mode,
        allow_writes: session.allow_writes,
        server_version: session.server_version.clone(),
        credential_stored: session.credential_stored,
    }
}

fn require_session<'a>(
    inner: &'a mut PostgresInner,
    workspace_root: &Path,
    id: &str,
) -> Result<&'a mut PostgresSession, CommandError> {
    let session = inner.sessions.get_mut(id).ok_or_else(|| {
        CommandError::new(
            "postgres_connection_not_found",
            "The PostgreSQL connection is not open.",
        )
    })?;
    if session.workspace_root != workspace_root {
        return Err(CommandError::new(
            "postgres_connection_not_found",
            "The PostgreSQL connection is not open in the active workspace.",
        ));
    }
    Ok(session)
}

const POSTGRES_SCHEMA_QUERY: &str = r#"
SELECT
    n.nspname::text AS schema_name,
    c.relname::text AS object_name,
    CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END::text AS object_kind,
    a.attnum::bigint AS position,
    a.attname::text AS column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod)::text AS data_type,
    a.attnotnull AS not_null,
    pg_catalog.left(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid), 16385)::text AS default_value,
    COALESCE(
        pg_catalog.length(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)) > 16385
        OR pg_catalog.octet_length(pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)) > 65536,
        false
    ) AS default_value_truncated,
    EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index i
        WHERE i.indrelid = c.oid
          AND i.indisprimary
          AND a.attnum = ANY(i.indkey)
    ) AS primary_key
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attribute a
  ON a.attrelid = c.oid
 AND a.attnum > 0
 AND NOT a.attisdropped
LEFT JOIN pg_catalog.pg_attrdef ad
  ON ad.adrelid = c.oid
 AND ad.adnum = a.attnum
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp_%'
ORDER BY n.nspname, c.relname, a.attnum NULLS LAST
LIMIT 22001
"#;

fn read_schema(client: &mut Client) -> Result<Vec<PostgresObject>, CommandError> {
    let mut rows = client
        .query_raw(POSTGRES_SCHEMA_QUERY, std::iter::empty::<i32>())
        .map_err(|error| postgres_error("read the PostgreSQL schema", error))?;
    let mut objects = Vec::new();
    let mut current: Option<PostgresObject> = None;
    let mut column_count = 0_usize;
    let mut schema_bytes = 0_usize;

    while let Some(row) = rows
        .next()
        .map_err(|error| postgres_error("read a PostgreSQL schema row", error))?
    {
        let schema_name = row
            .try_get::<_, String>(0)
            .map_err(|error| postgres_error("read a PostgreSQL schema name", error))?;
        let object_name = row
            .try_get::<_, String>(1)
            .map_err(|error| postgres_error("read a PostgreSQL object name", error))?;
        let object_kind = row
            .try_get::<_, String>(2)
            .map_err(|error| postgres_error("read a PostgreSQL object kind", error))?;
        validate_schema_text("schema name", &schema_name)?;
        validate_schema_text("object name", &object_name)?;
        let kind = match object_kind.as_str() {
            "table" => "table",
            "view" => "view",
            _ => {
                return Err(CommandError::new(
                    "postgres_schema_failed",
                    "PostgreSQL returned an unsupported schema object kind.",
                ))
            }
        };

        let changed_object = current
            .as_ref()
            .map(|object| {
                object.schema != schema_name
                    || object.name != object_name
                    || object.kind != kind
            })
            .unwrap_or(true);
        if changed_object {
            if let Some(object) = current.take() {
                objects.push(object);
            }
            if objects.len() >= MAX_SCHEMA_OBJECTS {
                return Err(schema_limit_error(format!(
                    "The PostgreSQL schema exceeds the {MAX_SCHEMA_OBJECTS}-object display limit."
                )));
            }
            schema_bytes = schema_bytes
                .saturating_add(schema_name.len().saturating_mul(6))
                .saturating_add(object_name.len().saturating_mul(6))
                .saturating_add(64);
            ensure_schema_size(schema_bytes)?;
            current = Some(PostgresObject {
                schema: schema_name,
                name: object_name,
                kind,
                columns: Vec::new(),
            });
        }

        let position = row
            .try_get::<_, Option<i64>>(3)
            .map_err(|error| postgres_error("read a PostgreSQL column position", error))?;
        let Some(position) = position else {
            continue;
        };
        column_count = column_count.saturating_add(1);
        if column_count > MAX_SCHEMA_COLUMNS {
            return Err(schema_limit_error(format!(
                "The PostgreSQL schema exceeds the {MAX_SCHEMA_COLUMNS}-column display limit."
            )));
        }
        let column_name = row
            .try_get::<_, Option<String>>(4)
            .map_err(|error| postgres_error("read a PostgreSQL column name", error))?
            .ok_or_else(|| {
                CommandError::new(
                    "postgres_schema_failed",
                    "PostgreSQL returned a column without a name.",
                )
            })?;
        let data_type = row
            .try_get::<_, Option<String>>(5)
            .map_err(|error| postgres_error("read a PostgreSQL column type", error))?
            .unwrap_or_default();
        validate_schema_text("column name", &column_name)?;
        validate_schema_text("column type", &data_type)?;
        let server_default_truncated = row
            .try_get::<_, bool>(8)
            .map_err(|error| postgres_error("read a PostgreSQL default-value bound", error))?;
        let (default_value, default_value_truncated) = match row
            .try_get::<_, Option<String>>(7)
            .map_err(|error| postgres_error("read a PostgreSQL column default", error))?
        {
            Some(value) => {
                let (value, truncated) = truncate_text(&value, MAX_DEFAULT_BYTES);
                (Some(value), truncated || server_default_truncated)
            }
            None => (None, server_default_truncated),
        };
        let column = PostgresColumn {
            position,
            name: column_name,
            data_type,
            not_null: row
                .try_get::<_, Option<bool>>(6)
                .map_err(|error| postgres_error("read a PostgreSQL column constraint", error))?
                .unwrap_or(false),
            default_value,
            default_value_truncated,
            primary_key: row
                .try_get::<_, bool>(9)
                .map_err(|error| postgres_error("read a PostgreSQL primary-key flag", error))?,
        };
        schema_bytes = schema_bytes.saturating_add(
            serde_json::to_vec(&column)
                .map_err(|_| {
                    CommandError::new(
                        "postgres_schema_failed",
                        "Could not encode a PostgreSQL schema column.",
                    )
                })?
                .len(),
        );
        ensure_schema_size(schema_bytes)?;
        current
            .as_mut()
            .ok_or_else(|| {
                CommandError::new(
                    "postgres_schema_failed",
                    "PostgreSQL schema grouping failed.",
                )
            })?
            .columns
            .push(column);
    }
    drop(rows);
    if let Some(object) = current {
        objects.push(object);
    }
    Ok(objects)
}

fn validate_schema_text(label: &str, value: &str) -> Result<(), CommandError> {
    if value.len() > MAX_IDENTIFIER_BYTES || value.contains('\0') {
        return Err(CommandError::new(
            "postgres_schema_value_too_large",
            format!(
                "A PostgreSQL {label} exceeded the {MAX_IDENTIFIER_BYTES}-byte display limit."
            ),
        ));
    }
    Ok(())
}

fn truncate_text(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push('…');
    (output, true)
}

fn ensure_schema_size(bytes: usize) -> Result<(), CommandError> {
    if bytes > MAX_SCHEMA_JSON_BYTES {
        Err(schema_limit_error(
            "The encoded PostgreSQL schema exceeds DevLab's 2 MiB response limit.",
        ))
    } else {
        Ok(())
    }
}

fn schema_limit_error(message: impl Into<String>) -> CommandError {
    CommandError::new("postgres_schema_too_large", message)
}

fn validate_read_query(sql: &str) -> Result<(), CommandError> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(CommandError::new(
            "postgres_statement_required",
            "Enter one read-only PostgreSQL statement.",
        ));
    }
    if sql.len() > MAX_SQL_BYTES || sql.contains('\0') {
        return Err(CommandError::new(
            "postgres_sql_too_large",
            format!(
                "PostgreSQL statements are limited to {MAX_SQL_BYTES} bytes and cannot contain null characters."
            ),
        ));
    }
    let identifiers = sql_identifiers(sql);
    let first = identifiers.first().map(String::as_str).unwrap_or("");
    if !matches!(first, "select" | "with" | "values" | "table") {
        return Err(CommandError::new(
            "postgres_read_only_statement",
            "This checkpoint accepts only SELECT, WITH, VALUES, or TABLE statements inside an enforced read-only transaction.",
        ));
    }
    if let Some(identifier) = identifiers
        .iter()
        .find(|identifier| restricted_read_identifier(identifier))
    {
        return Err(CommandError::new(
            "postgres_query_restricted",
            format!(
                "The PostgreSQL function or identifier “{identifier}” is unavailable in DevLab's bounded reader."
            ),
        ));
    }
    Ok(())
}

/// Validates one statement for the read-or-write execute command. Reads keep
/// their existing restrictions; writes add the mutating statement classes and
/// reject anything that is not exactly one statement.
fn validate_write_query(sql: &str) -> Result<(), CommandError> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err(CommandError::new(
            "postgres_statement_required",
            "Enter one PostgreSQL statement.",
        ));
    }
    if sql.len() > MAX_SQL_BYTES || sql.contains('\0') {
        return Err(CommandError::new(
            "postgres_sql_too_large",
            format!(
                "PostgreSQL statements are limited to {MAX_SQL_BYTES} bytes and cannot contain null characters."
            ),
        ));
    }
    if contains_multiple_statements(sql) || has_content_after_semicolon(sql) {
        return Err(CommandError::new(
            "postgres_multiple_statements",
            "DevLab executes exactly one PostgreSQL statement at a time. Remove the extra statements or the trailing semicolon content.",
        ));
    }
    let identifiers = sql_identifiers(sql);
    let first = identifiers.first().map(String::as_str).unwrap_or("");
    if !matches!(
        first,
        "select"
            | "with"
            | "values"
            | "table"
            | "insert"
            | "update"
            | "delete"
            | "merge"
            | "create"
            | "alter"
            | "drop"
            | "truncate"
            | "call"
            | "refresh"
    ) {
        return Err(CommandError::new(
            "postgres_write_statement_unsupported",
            "This statement class is unavailable. DevLab accepts SELECT, WITH, VALUES, TABLE, INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, CALL and REFRESH.",
        ));
    }
    if let Some(identifier) = identifiers
        .iter()
        .find(|identifier| restricted_read_identifier(identifier))
    {
        return Err(CommandError::new(
            "postgres_query_restricted",
            format!(
                "The PostgreSQL function or identifier \u{201c}{identifier}\u{201d} is unavailable in DevLab's bounded client."
            ),
        ));
    }
    Ok(())
}

/// Splits SQL on semicolons that appear outside string literals, quoted
/// identifiers, comments and dollar-quoted bodies, reporting for each segment
/// whether it holds real content rather than whitespace or comments only.
fn sql_statement_segments(sql: &str) -> Vec<bool> {
    let bytes = sql.as_bytes();
    let mut segments = vec![false];
    let mut index = 0_usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index..].starts_with(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1_usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth = depth.saturating_add(1);
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth = depth.saturating_sub(1);
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b';' {
            segments.push(false);
            index += 1;
            continue;
        }
        // Anything below is real content for the current segment.
        let last = segments.len() - 1;
        segments[last] = true;
        if bytes[index] == b'\'' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] == b'\\' && index + 1 < bytes.len() {
                    index += 2;
                } else if bytes[index] == b'\'' {
                    if index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'"' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] == b'"' {
                    if index + 1 < bytes.len() && bytes[index + 1] == b'"' {
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                } else {
                    let Some(character) = sql[index..].chars().next() else {
                        break;
                    };
                    index += character.len_utf8();
                }
            }
            continue;
        }
        if bytes[index] == b'$' {
            if let Some(delimiter_end) = sql[index + 1..].find('$') {
                let delimiter_end = index + 1 + delimiter_end;
                let tag = &sql[index + 1..delimiter_end];
                if tag.bytes().all(|value| value.is_ascii_alphanumeric() || value == b'_') {
                    let delimiter = &sql[index..=delimiter_end];
                    let body_start = delimiter_end + 1;
                    if let Some(body_end) = sql[body_start..].find(delimiter) {
                        index = body_start + body_end + delimiter.len();
                        continue;
                    }
                }
            }
        }
        let Some(character) = sql[index..].chars().next() else {
            break;
        };
        index += character.len_utf8();
    }
    segments
}

/// True when two or more semicolon-delimited statements carry real content.
fn contains_multiple_statements(sql: &str) -> bool {
    sql_statement_segments(sql)
        .iter()
        .filter(|has_content| **has_content)
        .count()
        > 1
}

/// True when real content follows a semicolon, which is how DevLab rejects
/// `SELECT 1; SELECT 2` and stray trailing fragments.
fn has_content_after_semicolon(sql: &str) -> bool {
    let segments = sql_statement_segments(sql);
    segments.len() > 1 && segments[1..].iter().any(|has_content| *has_content)
}

/// The statement's leading keyword, lowercased, ignoring comments and literals.
fn first_statement_keyword(sql: &str) -> Option<String> {
    sql_identifiers(sql).into_iter().next()
}

/// True when the statement hands rows back from a mutation. PostgreSQL forbids
/// a data-modifying statement inside a FROM sub-query but allows one as a WITH
/// body, so this decides which bounding wrapper is generated. A false positive
/// on a plain read is harmless because the CTE form is equivalent there.
fn uses_returning(sql: &str) -> bool {
    sql_identifiers(sql).iter().any(|value| value == "returning")
}

/// True for statement classes that PostgreSQL allows neither in a FROM
/// sub-query nor as a WITH body, so DevLab has no way to apply its server-side
/// cell bounds to their result set. Such statements are rejected before they
/// run rather than executed with weaker bounds or a confusing syntax error.
/// Both still work when they return no result set, which is the normal case.
fn result_set_cannot_be_bounded(sql: &str) -> bool {
    matches!(
        first_statement_keyword(sql).as_deref(),
        Some("call") | Some("merge")
    )
}

fn restricted_read_identifier(identifier: &str) -> bool {
    identifier.starts_with("pg_advisory_")
        || identifier.starts_with("pg_read_")
        || identifier.starts_with("pg_ls_")
        || identifier.starts_with("dblink_")
        || matches!(
            identifier,
            "dblink"
                | "lo_import"
                | "lo_export"
                | "set_config"
                | "pg_read_file"
                | "pg_read_binary_file"
                | "pg_ls_dir"
                | "pg_stat_file"
                | "pg_logdir_ls"
                | "pg_cancel_backend"
                | "pg_terminate_backend"
                | "pg_reload_conf"
                | "pg_rotate_logfile"
                | "pg_promote"
                | "pg_create_restore_point"
                | "pg_switch_wal"
                | "pg_export_snapshot"
                | "pg_log_backend_memory_contexts"
                | "pg_create_physical_replication_slot"
                | "pg_create_logical_replication_slot"
                | "pg_drop_replication_slot"
        )
}

fn sql_identifiers(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut identifiers = Vec::new();
    let mut index = 0_usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if bytes[index..].starts_with(b"--") {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            index += 2;
            let mut depth = 1_usize;
            while index < bytes.len() && depth > 0 {
                if bytes[index..].starts_with(b"/*") {
                    depth = depth.saturating_add(1);
                    index += 2;
                } else if bytes[index..].starts_with(b"*/") {
                    depth = depth.saturating_sub(1);
                    index += 2;
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'\'' {
            index += 1;
            while index < bytes.len() {
                if bytes[index] == b'\\' && index + 1 < bytes.len() {
                    index += 2;
                } else if bytes[index] == b'\'' {
                    if index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if bytes[index] == b'"' {
            index += 1;
            let mut identifier = String::new();
            while index < bytes.len() {
                if bytes[index] == b'"' {
                    if index + 1 < bytes.len() && bytes[index + 1] == b'"' {
                        identifier.push('"');
                        index += 2;
                    } else {
                        index += 1;
                        break;
                    }
                } else {
                    let rest = &sql[index..];
                    let Some(character) = rest.chars().next() else {
                        break;
                    };
                    identifier.push(character);
                    index += character.len_utf8();
                }
            }
            if !identifier.is_empty() {
                identifiers.push(identifier.to_lowercase());
            }
            continue;
        }
        if bytes[index] == b'$' {
            if let Some(delimiter_end) = sql[index + 1..].find('$') {
                let delimiter_end = index + 1 + delimiter_end;
                let tag = &sql[index + 1..delimiter_end];
                if tag.bytes().all(|value| value.is_ascii_alphanumeric() || value == b'_') {
                    let delimiter = &sql[index..=delimiter_end];
                    let body_start = delimiter_end + 1;
                    if let Some(body_end) = sql[body_start..].find(delimiter) {
                        index = body_start + body_end + delimiter.len();
                        continue;
                    }
                }
            }
        }
        let rest = &sql[index..];
        let Some(character) = rest.chars().next() else {
            break;
        };
        if character == '_' || character.is_alphabetic() {
            let start = index;
            index += character.len_utf8();
            while index < bytes.len() {
                let Some(next) = sql[index..].chars().next() else {
                    break;
                };
                if next == '_' || next == '$' || next.is_alphanumeric() {
                    index += next.len_utf8();
                } else {
                    break;
                }
            }
            identifiers.push(sql[start..index].to_lowercase());
        } else {
            index += character.len_utf8();
        }
    }
    identifiers
}

fn run_read_query(client: &mut Client, sql: &str) -> Result<PostgresQueryResult, CommandError> {
    run_bounded_statement(client, sql, true, true)
}

/// Classifies a statement with the server and only then allows a mutation.
///
/// The probe runs the statement inside a read-only transaction. Reads succeed
/// there and are returned directly, so a read is never executed twice. A
/// mutation is rejected by PostgreSQL with SQLSTATE 25006 before it can change
/// anything; only then does DevLab check write access and per-statement
/// confirmation and re-run the statement in a bounded write transaction.
fn run_write_query(
    client: &mut Client,
    sql: &str,
    allow_writes: bool,
    confirmed_write: bool,
) -> Result<PostgresQueryResult, CommandError> {
    match run_bounded_statement(client, sql, true, false) {
        Ok(result) => Ok(result),
        Err(error) if error.code == READ_ONLY_PROBE_CODE => {
            if !allow_writes {
                return Err(CommandError::new(
                    "postgres_write_disabled",
                    "This PostgreSQL connection is read-only. Enable writes for the connection before running a mutating statement.",
                ));
            }
            if !confirmed_write {
                return Err(CommandError::new(
                    "postgres_write_confirmation_required",
                    "This statement can modify the PostgreSQL database and requires confirmation before execution.",
                ));
            }
            run_bounded_statement(client, sql, false, false)
        }
        Err(error) => Err(error),
    }
}

/// Runs one statement inside an explicit transaction with server-side timeouts,
/// parameter rejection, column/row/cell bounds and an encoded-output budget.
/// `require_columns` keeps the legacy reader's insistence on a result set.
fn run_bounded_statement(
    client: &mut Client,
    sql: &str,
    read_only: bool,
    require_columns: bool,
) -> Result<PostgresQueryResult, CommandError> {
    let started = Instant::now();
    let mut transaction = client
        .build_transaction()
        .read_only(read_only)
        .start()
        .map_err(|error| {
            postgres_error(
                if read_only {
                    "start a read-only PostgreSQL transaction"
                } else {
                    "start a bounded PostgreSQL write transaction"
                },
                error,
            )
        })?;
    transaction
        .batch_execute("SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '2s';")
        .map_err(|error| postgres_error("apply PostgreSQL query limits", error))?;
    let statement = transaction
        .prepare(sql)
        .map_err(|error| postgres_error("prepare the PostgreSQL statement", error))?;
    if !statement.params().is_empty() {
        return Err(CommandError::new(
            "postgres_parameters_unsupported",
            "Parameterized PostgreSQL statements are not available in this checkpoint.",
        ));
    }
    if statement.columns().is_empty() {
        if require_columns {
            return Err(CommandError::new(
                "postgres_read_only_statement",
                "The PostgreSQL statement must return at least one column.",
            ));
        }
        // DDL and mutations without RETURNING report the server's real count.
        let affected_rows = transaction
            .execute(&statement, &[])
            .map_err(|error| postgres_error("execute the PostgreSQL statement", error))?;
        transaction.commit().map_err(|error| {
            postgres_error(
                if read_only {
                    "finish the read-only PostgreSQL statement"
                } else {
                    "commit the bounded PostgreSQL write"
                },
                error,
            )
        })?;
        return Ok(PostgresQueryResult {
            columns: Vec::new(),
            column_types: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            affected_rows,
            read_only,
            truncated: false,
            elapsed_ms: elapsed_ms(started),
        });
    }
    if statement.columns().len() > MAX_RESULT_COLUMNS {
        return Err(CommandError::new(
            "postgres_result_too_wide",
            format!(
                "PostgreSQL results are limited to {MAX_RESULT_COLUMNS} displayed columns."
            ),
        ));
    }
    if result_set_cannot_be_bounded(sql) {
        return Err(CommandError::new(
            "postgres_result_set_unbounded",
            "This statement returns a result set that DevLab cannot bound: PostgreSQL allows neither CALL nor MERGE inside a FROM sub-query or a WITH body. Run it without a result set, or read the affected data with a separate SELECT.",
        ));
    }
    let columns = statement
        .columns()
        .iter()
        .enumerate()
        .map(|(index, column)| {
            let name = column.name();
            if name.len() > MAX_IDENTIFIER_BYTES || name.contains('\0') {
                Err(CommandError::new(
                    "postgres_identifier_too_large",
                    format!("Result column {} has an invalid or oversized name.", index + 1),
                ))
            } else {
                Ok(name.to_string())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let column_types = statement
        .columns()
        .iter()
        .map(|column| column.type_().name().to_string())
        .collect::<Vec<_>>();
    let bounded_sql = build_bounded_sql(sql, statement.columns())?;
    let bounded_statement = transaction
        .prepare(&bounded_sql)
        .map_err(|error| postgres_error("prepare the bounded PostgreSQL reader", error))?;
    let portal = transaction
        .bind(&bounded_statement, &[])
        .map_err(|error| postgres_error("open the bounded PostgreSQL result", error))?;
    let bytes_per_row = statement
        .columns()
        .len()
        .saturating_mul(MAX_DEFAULT_BYTES)
        .max(1);
    let batch_rows = (MAX_RESULT_JSON_BYTES / bytes_per_row).clamp(1, 128) as i32;
    let mut rows = Vec::new();
    let mut encoded_bytes = 0_usize;
    let mut truncated = false;
    'result: loop {
        let remaining_ms = remaining_query_ms(started)?;
        transaction
            .batch_execute(&format!(
                "SET LOCAL statement_timeout = '{remaining_ms}ms';"
            ))
            .map_err(|error| postgres_error("refresh the PostgreSQL query timeout", error))?;
        let batch = transaction
            .query_portal(&portal, batch_rows)
            .map_err(|error| postgres_error("read the bounded PostgreSQL result", error))?;
        if batch.is_empty() {
            break;
        }
        for row in batch {
            if rows.len() >= MAX_RESULT_ROWS {
                truncated = true;
                break 'result;
            }
            let mut values = Vec::with_capacity(statement.columns().len());
            for (index, column) in statement.columns().iter().enumerate() {
                let value = row
                    .try_get::<_, Option<String>>(index * 2)
                    .map_err(|error| postgres_error("decode a PostgreSQL result value", error))?;
                let value_truncated = row
                    .try_get::<_, bool>(index * 2 + 1)
                    .map_err(|error| postgres_error("decode a PostgreSQL truncation flag", error))?;
                let cell = match value {
                    Some(value) => PostgresCell {
                        kind: postgres_cell_kind(column.type_()),
                        value,
                        truncated: value_truncated,
                    },
                    None => PostgresCell {
                        kind: "null",
                        value: "NULL".to_string(),
                        truncated: false,
                    },
                };
                truncated |= cell.truncated;
                values.push(cell);
            }
            let row_bytes = serde_json::to_vec(&values)
                .map_err(|_| {
                    CommandError::new(
                        "postgres_result_failed",
                        "Could not encode a PostgreSQL result row.",
                    )
                })?
                .len();
            if encoded_bytes.saturating_add(row_bytes) > MAX_RESULT_JSON_BYTES {
                truncated = true;
                break 'result;
            }
            encoded_bytes = encoded_bytes.saturating_add(row_bytes);
            rows.push(values);
        }
    }
    drop(portal);
    transaction.commit().map_err(|error| {
        postgres_error(
            if read_only {
                "finish the read-only PostgreSQL query"
            } else {
                "commit the bounded PostgreSQL write"
            },
            error,
        )
    })?;
    let row_count = rows.len();
    Ok(PostgresQueryResult {
        columns,
        column_types,
        row_count,
        rows,
        // For statements with a result set DevLab reports the rows the server
        // actually handed back inside the display bounds; `truncated` states
        // when the server produced more than that.
        affected_rows: row_count as u64,
        read_only,
        truncated,
        elapsed_ms: elapsed_ms(started),
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn remaining_query_ms(started: Instant) -> Result<u64, CommandError> {
    let remaining = QUERY_TIMEOUT.checked_sub(started.elapsed()).ok_or_else(|| {
        CommandError::new(
            "postgres_query_timeout",
            "The PostgreSQL query exceeded DevLab's five-second execution limit.",
        )
    })?;
    Ok(remaining.as_millis().clamp(1, u128::from(u64::MAX)) as u64)
}

fn build_bounded_sql(
    sql: &str,
    columns: &[::postgres::Column],
) -> Result<String, CommandError> {
    let mut inner = sql.trim_end();
    if let Some(without_semicolon) = inner.strip_suffix(';') {
        inner = without_semicolon.trim_end();
    }
    if inner.is_empty() {
        return Err(CommandError::new(
            "postgres_statement_required",
            "Enter one read-only PostgreSQL statement.",
        ));
    }
    let aliases = (0..columns.len())
        .map(|index| format!("devlab_col_{}", index + 1))
        .collect::<Vec<_>>();
    let mut expressions = Vec::with_capacity(columns.len().saturating_mul(2));
    for (index, column) in columns.iter().enumerate() {
        let alias = &aliases[index];
        if column.type_().name() == "bytea" {
            expressions.push(format!(
                "CASE WHEN {alias} IS NULL THEN NULL ELSE '<BYTEA · ' || pg_catalog.octet_length({alias})::text || ' bytes>' END"
            ));
            expressions.push(format!(
                "CASE WHEN {alias} IS NULL THEN false ELSE pg_catalog.octet_length({alias}) > 0 END"
            ));
        } else {
            expressions.push(format!(
                "CASE WHEN ({alias})::text IS NULL THEN NULL ELSE pg_catalog.left(({alias})::text, {MAX_CELL_CHARACTERS}) END"
            ));
            expressions.push(format!(
                "CASE WHEN ({alias})::text IS NULL THEN false ELSE pg_catalog.length(({alias})::text) > {MAX_CELL_CHARACTERS} OR pg_catalog.octet_length(({alias})::text) > {MAX_DEFAULT_BYTES} END"
            ));
        }
    }
    if uses_returning(sql) {
        // PostgreSQL rejects a data-modifying statement in a FROM sub-query but
        // accepts one as a WITH body, where it executes exactly once.
        Ok(format!(
            "WITH devlab_source({}) AS (\n{}\n) SELECT {} FROM devlab_source",
            aliases.join(", "),
            inner,
            expressions.join(",\n")
        ))
    } else {
        Ok(format!(
            "SELECT {} FROM (\n{}\n) AS devlab_source({})",
            expressions.join(",\n"),
            inner,
            aliases.join(", ")
        ))
    }
}

fn postgres_cell_kind(data_type: &Type) -> &'static str {
    match data_type.name() {
        "bool" => "boolean",
        "int2" | "int4" | "int8" | "oid" => "integer",
        "float4" | "float8" | "numeric" | "money" => "real",
        "bytea" => "blob",
        _ => "text",
    }
}

fn validate_request(request: &PostgresConnectRequest) -> Result<(), CommandError> {
    validate_host(&request.host)?;
    if request.port == 0 || request.port > u16::MAX as u32 {
        return Err(CommandError::new(
            "invalid_postgres_port",
            "PostgreSQL requires a port from 1 through 65535.",
        ));
    }
    validate_name("database", &request.database)?;
    validate_name("username", &request.username)?;
    if request.password.len() > MAX_PASSWORD_BYTES || request.password.contains('\0') {
        return Err(CommandError::new(
            "invalid_postgres_password",
            format!(
                "PostgreSQL passwords cannot contain null characters or exceed {MAX_PASSWORD_BYTES} bytes."
            ),
        ));
    }
    Ok(())
}

fn validate_host(host: &str) -> Result<(), CommandError> {
    if host.is_empty()
        || host.len() > MAX_HOST_BYTES
        || host.trim() != host
        || host.chars().any(char::is_control)
        || host.chars().any(char::is_whitespace)
        || host.contains('/')
        || host.contains('\\')
        || host.contains('@')
        || host.contains('?')
        || host.contains('#')
    {
        return Err(CommandError::new(
            "invalid_postgres_host",
            "Enter a hostname or IP address without a URL scheme, path, credentials or whitespace.",
        ));
    }
    Ok(())
}

fn validate_name(label: &str, value: &str) -> Result<(), CommandError> {
    if value.is_empty()
        || value.len() > MAX_NAME_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.contains('\0')
    {
        return Err(CommandError::new(
            "invalid_postgres_identity",
            format!(
                "The PostgreSQL {label} must be 1–{MAX_NAME_BYTES} bytes with no surrounding whitespace or control characters."
            ),
        ));
    }
    Ok(())
}

fn validate_connection_id(id: &str) -> Result<(), CommandError> {
    if id.is_empty()
        || id.len() > MAX_CONNECTION_ID_BYTES
        || !id.starts_with("postgres-")
        || !id.bytes().all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err(CommandError::new(
            "invalid_postgres_connection_id",
            "The PostgreSQL connection identifier is invalid.",
        ));
    }
    Ok(())
}

fn credential_account(request: &PostgresConnectRequest) -> String {
    let mut digest = Sha256::new();
    digest.update(request.username.as_bytes());
    digest.update([0]);
    digest.update(request.host.as_bytes());
    digest.update([0]);
    digest.update(request.port.to_be_bytes());
    digest.update(request.database.as_bytes());
    format!("postgresql-{:x}", digest.finalize())
}

fn keyring_entry(account: &str) -> Result<Entry, CommandError> {
    Entry::new(KEYRING_SERVICE, account).map_err(keyring_error)
}

fn keyring_error(error: KeyringError) -> CommandError {
    CommandError::new(
        "secure_storage_error",
        format!(
            "The operating-system credential store could not complete the PostgreSQL password request: {error}"
        ),
    )
}

fn lock_keyring() -> Result<MutexGuard<'static, ()>, CommandError> {
    KEYRING_LOCK.lock().map_err(|_| {
        CommandError::new(
            "secure_storage_unavailable",
            "The PostgreSQL credential-store lock is unavailable.",
        )
    })
}

fn load_password(account: &str) -> Result<Option<Zeroizing<String>>, CommandError> {
    let _guard = lock_keyring()?;
    match keyring_entry(account)?.get_password() {
        Ok(password) => Ok(Some(Zeroizing::new(password))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

fn credential_exists(account: &str) -> Result<bool, CommandError> {
    Ok(load_password(account)?.is_some())
}

fn store_password(account: &str, password: &str) -> Result<(), CommandError> {
    let _guard = lock_keyring()?;
    keyring_entry(account)?
        .set_password(password)
        .map_err(keyring_error)
}

fn delete_password(account: &str) -> Result<(), CommandError> {
    let _guard = lock_keyring()?;
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(keyring_error(error)),
    }
}

fn is_read_only_sql_state(code: &str) -> bool {
    code == READ_ONLY_SQL_STATE
}

/// True when PostgreSQL refused a statement purely because the transaction was
/// read-only. This is the signal that classifies a statement as a write.
fn is_read_only_error(error: &::postgres::Error) -> bool {
    error
        .as_db_error()
        .map(|database_error| is_read_only_sql_state(database_error.code().code()))
        .unwrap_or(false)
}

fn postgres_error(action: &str, error: ::postgres::Error) -> CommandError {
    if is_read_only_error(&error) {
        return CommandError::new(
            READ_ONLY_PROBE_CODE,
            format!(
                "Could not {action}: PostgreSQL refused the statement because the transaction is read-only (SQLSTATE {READ_ONLY_SQL_STATE})."
            ),
        );
    }
    if let Some(database_error) = error.as_db_error() {
        CommandError::new(
            "postgres_server_error",
            format!(
                "Could not {action}: PostgreSQL {}: {}",
                database_error.code().code(),
                database_error.message()
            ),
        )
    } else {
        CommandError::new(
            "postgres_connection_failed",
            format!("Could not {action}: {}", bounded_error_chain(&error)),
        )
    }
}

fn bounded_error_chain(error: &(dyn StdError + 'static)) -> String {
    let mut messages = Vec::new();
    let mut current = Some(error);
    while let Some(source) = current {
        let message = source.to_string();
        if !message.is_empty() && messages.last() != Some(&message) {
            messages.push(message);
        }
        if messages.len() >= 6 {
            break;
        }
        current = source.source();
    }
    let joined = messages.join(": ");
    if joined.len() <= MAX_ERROR_BYTES {
        return joined;
    }
    let mut end = MAX_ERROR_BYTES;
    while end > 0 && !joined.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &joined[..end])
}

async fn blocking<T, F>(operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| {
            CommandError::new(
                "postgres_worker_failed",
                "The PostgreSQL worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub async fn database_postgres_connections(
    app: AppHandle,
) -> Result<Vec<PostgresConnectionInfo>, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>().connections(&workspace_root)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_schema(
    app: AppHandle,
    id: String,
) -> Result<PostgresSchema, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .schema(&workspace_root, &id)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_query(
    app: AppHandle,
    id: String,
    sql: String,
) -> Result<PostgresQueryResult, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .query(&workspace_root, &id, &sql)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_execute(
    app: AppHandle,
    id: String,
    sql: String,
    confirmed_write: bool,
) -> Result<PostgresQueryResult, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .execute(&workspace_root, &id, &sql, confirmed_write)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_set_write_access(
    app: AppHandle,
    id: String,
    allow_writes: bool,
) -> Result<PostgresConnectionInfo, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .set_write_access(&workspace_root, &id, allow_writes)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_connect(
    app: AppHandle,
    request: PostgresConnectRequest,
) -> Result<PostgresConnectionInfo, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .connect(workspace_root, request)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_disconnect(
    app: AppHandle,
    id: String,
) -> Result<(), CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .disconnect(&workspace_root, &id)
    })
    .await
}

#[tauri::command]
pub async fn database_postgres_forget_password(
    app: AppHandle,
    id: String,
) -> Result<PostgresConnectionInfo, CommandError> {
    blocking(move || {
        let workspace_root = app.state::<WorkspaceService>().root_path()?;
        app.state::<PostgresService>()
            .forget_password(&workspace_root, &id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> PostgresConnectRequest {
        PostgresConnectRequest {
            host: "db.example.com".to_string(),
            port: 5432,
            database: "devlab".to_string(),
            username: "developer".to_string(),
            password: "do-not-hash-this-value".to_string(),
            tls_mode: PostgresTlsMode::VerifyFull,
            allow_writes: false,
            store_password: true,
        }
    }

    #[test]
    fn validates_postgres_connection_fields() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.host = "https://db.example.com/path".to_string();
        assert_eq!(
            validate_request(&invalid).expect_err("URL-like host must fail").code,
            "invalid_postgres_host"
        );
        let mut invalid = request();
        invalid.port = 0;
        assert_eq!(
            validate_request(&invalid).expect_err("zero port must fail").code,
            "invalid_postgres_port"
        );
    }

    #[test]
    fn credential_account_is_stable_and_contains_no_identity_or_password() {
        let request = request();
        let account = credential_account(&request);
        assert_eq!(account, credential_account(&request));
        assert!(!account.contains(&request.host));
        assert!(!account.contains(&request.username));
        assert!(!account.contains(&request.password));
    }

    #[test]
    fn tls_policy_labels_are_explicit() {
        assert_eq!(
            serde_json::to_string(&PostgresTlsMode::VerifyFull).unwrap(),
            "\"verify-full\""
        );
        assert_eq!(
            serde_json::to_string(&PostgresTlsMode::Disable).unwrap(),
            "\"disable\""
        );
    }

    #[test]
    fn schema_text_truncation_preserves_utf8_boundaries() {
        let value = "é".repeat(MAX_DEFAULT_BYTES);
        let (truncated, was_truncated) = truncate_text(&value, MAX_DEFAULT_BYTES);
        assert!(was_truncated);
        assert!(truncated.ends_with('…'));
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn schema_response_limit_is_enforced() {
        assert!(ensure_schema_size(MAX_SCHEMA_JSON_BYTES).is_ok());
        assert_eq!(
            ensure_schema_size(MAX_SCHEMA_JSON_BYTES + 1)
                .expect_err("oversized schema must fail")
                .code,
            "postgres_schema_too_large"
        );
    }

    #[test]
    fn read_query_policy_accepts_reads_and_rejects_writes() {
        assert!(validate_read_query("-- inspect\nSELECT 1;").is_ok());
        assert!(validate_read_query("WITH values AS (SELECT 1) SELECT * FROM values").is_ok());
        assert_eq!(
            validate_read_query("INSERT INTO notes(value) VALUES ('x')")
                .expect_err("writes must fail")
                .code,
            "postgres_read_only_statement"
        );
    }

    #[test]
    fn read_query_policy_ignores_literals_but_blocks_dangerous_functions() {
        assert!(validate_read_query("SELECT 'pg_read_file' AS harmless_text").is_ok());
        assert!(validate_read_query("SELECT $$set_config$$ AS harmless_text").is_ok());
        assert_eq!(
            validate_read_query("SELECT pg_catalog.pg_read_file('/etc/passwd')")
                .expect_err("filesystem reads must fail")
                .code,
            "postgres_query_restricted"
        );
        assert_eq!(
            validate_read_query("SELECT \"set_config\"('statement_timeout', '0', false)")
                .expect_err("configuration changes must fail")
                .code,
            "postgres_query_restricted"
        );
    }

    #[test]
    fn write_query_policy_accepts_reads_and_mutations() {
        for sql in [
            "SELECT 1;",
            "WITH rows AS (SELECT 1) SELECT * FROM rows",
            "VALUES (1), (2)",
            "INSERT INTO notes(value) VALUES ('x')",
            "UPDATE notes SET value = 'y' WHERE id = 1",
            "DELETE FROM notes WHERE id = 1",
            "MERGE INTO notes AS target USING staged AS source ON target.id = source.id \
             WHEN MATCHED THEN UPDATE SET value = source.value",
            "CREATE TABLE notes(id integer PRIMARY KEY, value text)",
            "ALTER TABLE notes ADD COLUMN created_at timestamptz",
            "DROP TABLE notes",
            "TRUNCATE TABLE notes",
            "CALL refresh_reports()",
            "REFRESH MATERIALIZED VIEW report_summary",
        ] {
            assert!(validate_write_query(sql).is_ok(), "should accept: {sql}");
        }
    }

    #[test]
    fn write_query_policy_rejects_other_statement_classes() {
        for sql in [
            "GRANT ALL ON notes TO developer",
            "COPY notes FROM STDIN",
            "BEGIN",
            "VACUUM",
            "SET statement_timeout = '0'",
            "",
            "   ",
        ] {
            assert_eq!(
                validate_write_query(sql)
                    .expect_err("statement class must be rejected")
                    .code,
                if sql.trim().is_empty() {
                    "postgres_statement_required"
                } else {
                    "postgres_write_statement_unsupported"
                },
                "unexpected code for {sql:?}"
            );
        }
    }

    #[test]
    fn write_query_policy_accepts_exactly_one_statement_only() {
        assert_eq!(
            validate_write_query("SELECT 1; SELECT 2")
                .expect_err("two statements must fail")
                .code,
            "postgres_multiple_statements"
        );
        assert_eq!(
            validate_write_query("INSERT INTO notes(value) VALUES ('x'); DROP TABLE notes;")
                .expect_err("stacked mutations must fail")
                .code,
            "postgres_multiple_statements"
        );
        // A single trailing semicolon, comments and whitespace stay acceptable.
        assert!(validate_write_query("DELETE FROM notes WHERE id = 1;").is_ok());
        assert!(validate_write_query("DELETE FROM notes WHERE id = 1;  -- done\n").is_ok());
        assert!(validate_write_query("/* lead */ SELECT 1 /* trail */").is_ok());
    }

    #[test]
    fn statement_scanner_ignores_semicolons_inside_literals_and_comments() {
        assert!(!contains_multiple_statements(
            "INSERT INTO notes(value) VALUES ('a;b;c')"
        ));
        assert!(!contains_multiple_statements(
            "SELECT $$; DROP TABLE notes;$$ AS harmless_text"
        ));
        assert!(!contains_multiple_statements(
            "SELECT 1 /* ; */ ; -- ; trailing comment"
        ));
        assert!(contains_multiple_statements("SELECT 1; SELECT 2"));
        assert!(has_content_after_semicolon("; SELECT 1"));
        assert!(!has_content_after_semicolon("SELECT 1;"));
        assert_eq!(sql_statement_segments("SELECT 1;  ; -- nothing").len(), 3);
    }

    #[test]
    fn write_query_policy_still_blocks_restricted_identifiers() {
        for sql in [
            "SELECT pg_catalog.pg_read_file('/etc/passwd')",
            "UPDATE notes SET value = set_config('statement_timeout', '0', false)",
            "SELECT pg_advisory_lock(1)",
            "DELETE FROM notes WHERE id = lo_import('/etc/passwd')",
        ] {
            assert_eq!(
                validate_write_query(sql)
                    .expect_err("restricted identifier must be blocked")
                    .code,
                "postgres_query_restricted"
            );
        }
        // The same names inside a literal stay harmless.
        assert!(validate_write_query("INSERT INTO notes(value) VALUES ('pg_read_file')").is_ok());
    }

    #[test]
    fn write_query_policy_enforces_the_sql_size_limit() {
        let oversized = format!("SELECT '{}'", "x".repeat(MAX_SQL_BYTES));
        assert_eq!(
            validate_write_query(&oversized)
                .expect_err("oversized SQL must fail")
                .code,
            "postgres_sql_too_large"
        );
        assert_eq!(
            validate_write_query("SELECT 1;\u{0}")
                .expect_err("null bytes must fail")
                .code,
            "postgres_sql_too_large"
        );
    }

    #[test]
    fn read_only_sqlstate_classification_is_exact() {
        assert!(is_read_only_sql_state(READ_ONLY_SQL_STATE));
        assert!(is_read_only_sql_state("25006"));
        for other in ["25000", "25007", "25P01", "42501", "250065", "", "25006 "] {
            assert!(!is_read_only_sql_state(other), "must not classify {other:?}");
        }
        assert_eq!(READ_ONLY_PROBE_CODE, "postgres_read_only_transaction");
    }

    #[test]
    fn returning_statements_use_the_cte_bounding_wrapper() {
        assert!(uses_returning("INSERT INTO notes(value) VALUES ('x') RETURNING id"));
        assert!(uses_returning("UPDATE notes SET value = 'y' RETURNING id, value"));
        assert!(uses_returning("DELETE FROM notes WHERE id = 1 RETURNING *"));
        assert!(uses_returning(
            "WITH staged AS (SELECT 1 AS id) INSERT INTO notes(id) SELECT id FROM staged RETURNING id"
        ));
        assert!(!uses_returning("SELECT id, value FROM notes LIMIT 10"));
        assert!(!uses_returning("CREATE TABLE notes(id integer)"));
        // The word inside a literal must not change the wrapper choice.
        assert!(!uses_returning("SELECT 'returning' AS label"));
    }

    #[test]
    fn first_keyword_detection_skips_comments_and_literals() {
        assert_eq!(first_statement_keyword("  -- lead\nSELECT 1").as_deref(), Some("select"));
        assert_eq!(first_statement_keyword("/* c */ INSERT INTO t VALUES (1)").as_deref(), Some("insert"));
        assert_eq!(first_statement_keyword("WITH x AS (SELECT 1) SELECT * FROM x").as_deref(), Some("with"));
        assert_eq!(first_statement_keyword("call refresh_reports()").as_deref(), Some("call"));
        assert_eq!(first_statement_keyword("\"SELECT\" 1").as_deref(), Some("select"));
        assert_eq!(first_statement_keyword("   "), None);
    }

    #[test]
    fn unbounded_result_sets_are_rejected_honestly() {
        assert!(result_set_cannot_be_bounded("CALL report()"));
        assert!(result_set_cannot_be_bounded("merge into t using s on t.id = s.id"));
        assert!(!result_set_cannot_be_bounded("INSERT INTO t(a) VALUES (1) RETURNING a"));
        assert!(!result_set_cannot_be_bounded("UPDATE t SET a = 1 RETURNING a"));
        assert!(!result_set_cannot_be_bounded("DELETE FROM t RETURNING *"));
        assert!(!result_set_cannot_be_bounded("SELECT 1"));
        assert!(!result_set_cannot_be_bounded("CREATE TABLE t(a integer)"));
        assert!(!result_set_cannot_be_bounded("TRUNCATE TABLE t"));
    }

    #[test]
    fn read_query_policy_is_unchanged_by_the_write_checkpoint() {
        assert!(validate_read_query("SELECT 1;").is_ok());
        assert_eq!(
            validate_read_query("INSERT INTO notes(value) VALUES ('x')")
                .expect_err("reads must still reject writes")
                .code,
            "postgres_read_only_statement"
        );
    }

    #[test]
    fn sql_identifier_scanner_skips_nested_comments() {
        let identifiers = sql_identifiers(
            "/* outer /* SELECT pg_read_file */ done */ VALUES (1), (2)",
        );
        assert_eq!(identifiers.first().map(String::as_str), Some("values"));
        assert!(!identifiers.iter().any(|value| value == "pg_read_file"));
    }
}
