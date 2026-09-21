use keyring::{error::Error as KeyringError, Entry};
use native_tls::TlsConnector;
use ::postgres::{config::SslMode, Client, Config, NoTls};
use fallible_iterator::FallibleIterator;
use postgres_native_tls::MakeTlsConnector;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    error::Error as StdError,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
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
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
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

fn postgres_error(action: &str, error: ::postgres::Error) -> CommandError {
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
}
