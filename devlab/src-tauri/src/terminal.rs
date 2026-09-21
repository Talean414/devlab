use portable_pty::{
    native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize, PtySystem,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

use crate::workspace::{CommandError as WorkspaceCommandError, WorkspaceService};

const MAX_TERMINAL_SESSIONS: usize = 8;
const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_TERMINAL_SESSION_ID_BYTES: usize = 128;
const MIN_TERMINAL_DIMENSION: u16 = 2;
const MAX_TERMINAL_DIMENSION: u16 = 1_000;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalError {
    code: &'static str,
    message: String,
}

impl TerminalError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn native(action: &str, error: impl std::fmt::Display) -> Self {
        Self::new(
            "terminal_io_error",
            format!("Could not {action}: {error}"),
        )
    }
}

impl From<WorkspaceCommandError> for TerminalError {
    fn from(error: WorkspaceCommandError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    id: String,
    shell: String,
    cwd: String,
    pid: Option<u32>,
    status: &'static str,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
    started_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    session: TerminalSessionInfo,
    output: Vec<u8>,
    output_start: u64,
    output_end: u64,
    truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    offset: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    session_id: String,
    status: &'static str,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Copy)]
enum SessionStatus {
    Running,
    Exited,
    Failed,
}

impl SessionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Failed => "failed",
        }
    }
}

struct OutputBuffer {
    bytes: Vec<u8>,
    start: u64,
    end: u64,
    truncated: bool,
}

impl Default for OutputBuffer {
    fn default() -> Self {
        Self {
            bytes: Vec::new(),
            start: 0,
            end: 0,
            truncated: false,
        }
    }
}

impl OutputBuffer {
    fn append(&mut self, data: &[u8]) -> u64 {
        let offset = self.end;
        self.end = self.end.saturating_add(data.len() as u64);

        if data.len() >= MAX_TERMINAL_OUTPUT_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&data[data.len() - MAX_TERMINAL_OUTPUT_BYTES..]);
            self.start = self.end.saturating_sub(self.bytes.len() as u64);
            self.truncated = true;
            return offset;
        }

        let overflow = self
            .bytes
            .len()
            .saturating_add(data.len())
            .saturating_sub(MAX_TERMINAL_OUTPUT_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.start = self.start.saturating_add(overflow as u64);
            self.truncated = true;
        }
        self.bytes.extend_from_slice(data);
        offset
    }
}

struct TerminalSessionState {
    status: SessionStatus,
    exit_code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
    output: OutputBuffer,
}

impl Default for TerminalSessionState {
    fn default() -> Self {
        Self {
            status: SessionStatus::Running,
            exit_code: None,
            signal: None,
            error: None,
            output: OutputBuffer::default(),
        }
    }
}

struct TerminalSession {
    id: String,
    shell: String,
    cwd: String,
    pid: Option<u32>,
    process_group_leader: Option<i32>,
    started_at_ms: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    state: Mutex<TerminalSessionState>,
}

impl TerminalSession {
    fn info(&self) -> Result<TerminalSessionInfo, TerminalError> {
        let state = self.state.lock().map_err(|_| state_unavailable())?;
        Ok(self.info_with_state(&state))
    }

    fn info_with_state(&self, state: &TerminalSessionState) -> TerminalSessionInfo {
        TerminalSessionInfo {
            id: self.id.clone(),
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            pid: self.pid,
            status: state.status.as_str(),
            exit_code: state.exit_code,
            signal: state.signal.clone(),
            error: state.error.clone(),
            started_at_ms: self.started_at_ms,
        }
    }

    fn snapshot(&self) -> Result<TerminalSnapshot, TerminalError> {
        let state = self.state.lock().map_err(|_| state_unavailable())?;
        Ok(TerminalSnapshot {
            session: self.info_with_state(&state),
            output: state.output.bytes.clone(),
            output_start: state.output.start,
            output_end: state.output.end,
            truncated: state.output.truncated,
        })
    }

    fn append_output(&self, data: &[u8]) -> Option<u64> {
        self.state
            .lock()
            .ok()
            .map(|mut state| state.output.append(data))
    }

    fn clear_output(&self) -> Result<u64, TerminalError> {
        let mut state = self.state.lock().map_err(|_| state_unavailable())?;
        state.output.bytes.clear();
        state.output.start = state.output.end;
        state.output.truncated = false;
        Ok(state.output.end)
    }

    fn write(&self, data: &[u8]) -> Result<(), TerminalError> {
        let state = self.state.lock().map_err(|_| state_unavailable())?;
        if !matches!(state.status, SessionStatus::Running) {
            return Err(TerminalError::new(
                "terminal_not_running",
                "This terminal session has already exited.",
            ));
        }
        drop(state);

        let mut writer = self.writer.lock().map_err(|_| state_unavailable())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| TerminalError::native("write to the terminal", error))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.master.lock().map_err(|_| state_unavailable())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::native("resize the terminal", error))
    }

    fn kill_if_running(&self) -> Result<(), TerminalError> {
        let state = self.state.lock().map_err(|_| state_unavailable())?;
        if !matches!(state.status, SessionStatus::Running) {
            return Ok(());
        }
        drop(state);
        self.terminate_processes()
    }

    fn terminate_for_close(&self) -> Result<(), TerminalError> {
        if terminate_process_tree(self)? {
            return Ok(());
        }
        let state = self.state.lock().map_err(|_| state_unavailable())?;
        if !matches!(state.status, SessionStatus::Running) {
            return Ok(());
        }
        drop(state);
        self.terminate_leader()
    }

    fn terminate_processes(&self) -> Result<(), TerminalError> {
        if terminate_process_tree(self)? {
            return Ok(());
        }
        self.terminate_leader()
    }

    fn terminate_leader(&self) -> Result<(), TerminalError> {
        self.killer
            .lock()
            .map_err(|_| state_unavailable())?
            .kill()
            .map_err(|error| TerminalError::native("terminate the terminal process", error))
    }

    fn mark_exit(&self, exit_code: u32, signal: Option<String>) -> TerminalExitEvent {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.status = SessionStatus::Exited;
        state.exit_code = Some(exit_code);
        state.signal = signal.clone();
        state.error = None;
        TerminalExitEvent {
            session_id: self.id.clone(),
            status: state.status.as_str(),
            exit_code: state.exit_code,
            signal,
            error: None,
        }
    }

    fn mark_wait_failure(&self, error: String) -> TerminalExitEvent {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.status = SessionStatus::Failed;
        state.error = Some(error.clone());
        TerminalExitEvent {
            session_id: self.id.clone(),
            status: state.status.as_str(),
            exit_code: None,
            signal: None,
            error: Some(error),
        }
    }
}

#[derive(Default)]
pub struct TerminalService {
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
}

impl TerminalService {
    fn session(&self, id: &str) -> Result<Arc<TerminalSession>, TerminalError> {
        validate_session_id(id)?;
        self.sessions
            .lock()
            .map_err(|_| state_unavailable())?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                TerminalError::new(
                    "terminal_session_not_found",
                    "The terminal session no longer exists.",
                )
            })
    }

    fn remove(&self, id: &str) -> Result<Arc<TerminalSession>, TerminalError> {
        validate_session_id(id)?;
        self.sessions
            .lock()
            .map_err(|_| state_unavailable())?
            .remove(id)
            .ok_or_else(|| {
                TerminalError::new(
                    "terminal_session_not_found",
                    "The terminal session no longer exists.",
                )
            })
    }
}

impl Drop for TerminalService {
    fn drop(&mut self) {
        let sessions = match self.sessions.get_mut() {
            Ok(sessions) => sessions,
            Err(poisoned) => poisoned.into_inner(),
        };
        for session in sessions.values() {
            if let Err(error) = session.terminate_for_close() {
                log::warn!("could not stop terminal {} during shutdown: {}", session.id, error.message);
            }
        }
    }
}

#[tauri::command]
pub fn terminal_create(
    cols: u16,
    rows: u16,
    app: AppHandle,
    terminals: State<'_, TerminalService>,
    workspace: State<'_, WorkspaceService>,
) -> Result<TerminalSessionInfo, TerminalError> {
    validate_dimensions(cols, rows)?;
    let cwd = workspace.root_path()?;
    validate_terminal_workspace(&cwd)?;

    let mut sessions = terminals
        .sessions
        .lock()
        .map_err(|_| state_unavailable())?;
    if sessions.len() >= MAX_TERMINAL_SESSIONS {
        return Err(TerminalError::new(
            "terminal_session_limit",
            format!("Close a terminal before opening another. The limit is {MAX_TERMINAL_SESSIONS}."),
        ));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::native("allocate a native PTY", error))?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| TerminalError::native("open the terminal output stream", error))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| TerminalError::native("open the terminal input stream", error))?;

    let mut command = CommandBuilder::new_default_prog();
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("DEVLAB_TERMINAL", "1");
    let shell = command.get_shell();

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| TerminalError::native("start the default shell", error))?;
    let pid = child.process_id();
    let process_group_leader = pair
        .master
        .process_group_leader()
        .map(|leader| leader as i32);
    let killer = child.clone_killer();
    drop(pair.slave);

    let id = format!(
        "terminal-{}-{}",
        std::process::id(),
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let session = Arc::new(TerminalSession {
        id: id.clone(),
        shell,
        cwd: cwd.to_string_lossy().into_owned(),
        pid,
        process_group_leader,
        started_at_ms: now_ms(),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        state: Mutex::new(TerminalSessionState::default()),
    });
    sessions.insert(id, Arc::clone(&session));
    drop(sessions);

    spawn_output_reader(app.clone(), Arc::clone(&session), reader);
    spawn_exit_waiter(app, Arc::clone(&session), child);
    session.info()
}

#[tauri::command]
pub fn terminal_list(
    terminals: State<'_, TerminalService>,
) -> Result<Vec<TerminalSessionInfo>, TerminalError> {
    let sessions = terminals
        .sessions
        .lock()
        .map_err(|_| state_unavailable())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut infos = sessions
        .iter()
        .map(|session| session.info())
        .collect::<Result<Vec<_>, _>>()?;
    infos.sort_by_key(|session| session.started_at_ms);
    Ok(infos)
}

#[tauri::command]
pub fn terminal_snapshot(
    session_id: String,
    terminals: State<'_, TerminalService>,
) -> Result<TerminalSnapshot, TerminalError> {
    terminals.session(&session_id)?.snapshot()
}

#[tauri::command]
pub fn terminal_write(
    session_id: String,
    data: Vec<u8>,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(TerminalError::new(
            "terminal_input_too_large",
            format!("A terminal input message cannot exceed {MAX_TERMINAL_INPUT_BYTES} bytes."),
        ));
    }
    terminals.session(&session_id)?.write(&data)
}

#[tauri::command]
pub fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    validate_dimensions(cols, rows)?;
    terminals.session(&session_id)?.resize(cols, rows)
}

#[tauri::command]
pub fn terminal_clear(
    session_id: String,
    terminals: State<'_, TerminalService>,
) -> Result<u64, TerminalError> {
    terminals.session(&session_id)?.clear_output()
}

#[tauri::command]
pub fn terminal_kill(
    session_id: String,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    terminals.session(&session_id)?.kill_if_running()
}

#[tauri::command]
pub fn terminal_close(
    session_id: String,
    terminals: State<'_, TerminalService>,
) -> Result<(), TerminalError> {
    let session = terminals.session(&session_id)?;
    session.terminate_for_close()?;
    terminals.remove(&session_id)?;
    Ok(())
}

fn spawn_output_reader(
    app: AppHandle,
    session: Arc<TerminalSession>,
    mut reader: Box<dyn Read + Send>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let data = buffer[..read].to_vec();
                    let Some(offset) = session.append_output(&data) else {
                        log::warn!("could not buffer output for terminal {}", session.id);
                        break;
                    };
                    if app
                        .emit_to(
                            "main",
                            "terminal-output",
                            TerminalOutputEvent {
                                session_id: session.id.clone(),
                                offset,
                                data,
                            },
                        )
                        .is_err()
                    {
                        log::warn!("could not emit output for terminal {}", session.id);
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    log::warn!("terminal {} output stream ended: {error}", session.id);
                    break;
                }
            }
        }
    });
}

fn spawn_exit_waiter(
    app: AppHandle,
    session: Arc<TerminalSession>,
    mut child: Box<dyn Child + Send + Sync>,
) {
    thread::spawn(move || {
        let event = match child.wait() {
            Ok(status) => session.mark_exit(
                status.exit_code(),
                status.signal().map(std::string::ToString::to_string),
            ),
            Err(error) => session.mark_wait_failure(format!("Could not wait for the shell: {error}")),
        };
        if app.emit_to("main", "terminal-exit", event).is_err() {
            log::warn!("could not emit exit status for terminal {}", session.id);
        }
    });
}

#[cfg(unix)]
fn terminate_process_tree(session: &TerminalSession) -> Result<bool, TerminalError> {
    let Some(process_group) = session.process_group_leader else {
        return Ok(false);
    };
    let own_process_group = unsafe { libc::getpgrp() };
    if process_group <= 1 || process_group == own_process_group {
        log::warn!(
            "refusing unsafe process-group termination for terminal {} (group {process_group})",
            session.id
        );
        return Ok(false);
    }

    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == 0 {
        Ok(true)
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(TerminalError::native(
                "terminate the terminal process group",
                error,
            ))
        }
    }
}

#[cfg(windows)]
fn terminate_process_tree(session: &TerminalSession) -> Result<bool, TerminalError> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Some(pid) = session.pid else {
        return Ok(false);
    };
    let result = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match result {
        Ok(output) if output.status.success() => Ok(true),
        Ok(output) => {
            log::warn!(
                "taskkill could not terminate terminal {} tree: {}",
                session.id,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            Ok(false)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(TerminalError::native(
            "launch Windows process-tree termination",
            error,
        )),
    }
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(_session: &TerminalSession) -> Result<bool, TerminalError> {
    Ok(false)
}

fn validate_terminal_workspace(path: &Path) -> Result<(), TerminalError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        TerminalError::new(
            "workspace_unavailable",
            format!("The selected workspace is no longer available: {error}"),
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(TerminalError::new(
            "workspace_unavailable",
            "The selected workspace is no longer the canonical directory that was approved.",
        ));
    }
    let canonical = fs::canonicalize(path).map_err(|error| {
        TerminalError::new(
            "workspace_unavailable",
            format!("The selected workspace could not be resolved again: {error}"),
        )
    })?;
    if canonical != path {
        return Err(TerminalError::new(
            "workspace_changed",
            "The selected workspace path changed after approval. Select it again before starting a shell.",
        ));
    }
    Ok(())
}

fn validate_session_id(id: &str) -> Result<(), TerminalError> {
    if id.is_empty()
        || id.len() > MAX_TERMINAL_SESSION_ID_BYTES
        || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(TerminalError::new(
            "invalid_terminal_session_id",
            "The terminal session identifier is invalid.",
        ));
    }
    Ok(())
}

fn validate_dimensions(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if !(MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&cols)
        || !(MIN_TERMINAL_DIMENSION..=MAX_TERMINAL_DIMENSION).contains(&rows)
    {
        return Err(TerminalError::new(
            "invalid_terminal_size",
            format!(
                "Terminal rows and columns must be between {MIN_TERMINAL_DIMENSION} and {MAX_TERMINAL_DIMENSION}."
            ),
        ));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn state_unavailable() -> TerminalError {
    TerminalError::new(
        "terminal_state_unavailable",
        "Native terminal state is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_terminal_dimensions() {
        assert!(validate_dimensions(80, 24).is_ok());
        assert!(validate_dimensions(1, 24).is_err());
        assert!(validate_dimensions(80, 1_001).is_err());
    }

    #[test]
    fn validates_a_canonical_terminal_workspace() {
        let path = std::env::temp_dir().join(format!(
            "devlab-terminal-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir(&path).expect("test workspace should be created");
        let canonical = fs::canonicalize(&path).expect("test workspace should canonicalize");
        assert!(validate_terminal_workspace(&canonical).is_ok());
        fs::remove_dir(path).expect("test workspace should be removed");
    }

    #[test]
    fn validates_terminal_session_ids() {
        assert!(validate_session_id("terminal-42-7").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("../terminal").is_err());
        assert!(validate_session_id(&"x".repeat(MAX_TERMINAL_SESSION_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn output_buffer_tracks_offsets() {
        let mut buffer = OutputBuffer::default();
        assert_eq!(buffer.append(b"abc"), 0);
        assert_eq!(buffer.append(b"def"), 3);
        assert_eq!(buffer.bytes, b"abcdef");
        assert_eq!(buffer.start, 0);
        assert_eq!(buffer.end, 6);
        assert!(!buffer.truncated);
    }

    #[test]
    fn output_buffer_keeps_only_the_bounded_tail() {
        let mut buffer = OutputBuffer::default();
        let data = vec![b'x'; MAX_TERMINAL_OUTPUT_BYTES + 32];
        assert_eq!(buffer.append(&data), 0);
        assert_eq!(buffer.bytes.len(), MAX_TERMINAL_OUTPUT_BYTES);
        assert_eq!(buffer.start, 32);
        assert_eq!(buffer.end, (MAX_TERMINAL_OUTPUT_BYTES + 32) as u64);
        assert!(buffer.truncated);
    }
}
