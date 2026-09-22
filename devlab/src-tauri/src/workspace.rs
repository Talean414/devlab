use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audit::AgentAuditService;
use crate::search_index::SearchIndexService;
use tauri_plugin_dialog::DialogExt;

const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_RELATIVE_PATH_BYTES: usize = 4_096;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(action: &str, error: std::io::Error) -> Self {
        Self::new("io_error", format!("Could not {action}: {error}"))
    }
}

#[derive(Clone, Debug)]
struct WorkspaceRoot(PathBuf);

impl WorkspaceRoot {
    fn open(path: &Path) -> Result<Self, CommandError> {
        let root = fs::canonicalize(path)
            .map_err(|error| CommandError::io("open the selected workspace", error))?;
        let metadata = fs::metadata(&root)
            .map_err(|error| CommandError::io("inspect the selected workspace", error))?;
        if !metadata.is_dir() {
            return Err(CommandError::new(
                "not_a_directory",
                "The selected workspace is not a directory.",
            ));
        }
        Ok(Self(root))
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn resolve_existing(&self, relative_path: &str) -> Result<PathBuf, CommandError> {
        let relative = validate_relative_path(relative_path, true)?;
        let unresolved = self.0.join(&relative);
        let resolved = fs::canonicalize(&unresolved)
            .map_err(|error| CommandError::io("resolve the workspace path", error))?;
        self.ensure_scoped(&resolved)?;

        if !relative.as_os_str().is_empty() {
            let metadata = fs::symlink_metadata(&unresolved)
                .map_err(|error| CommandError::io("inspect the workspace path", error))?;
            if metadata.file_type().is_symlink() {
                return Err(CommandError::new(
                    "symlink_not_allowed",
                    "Symbolic links cannot be opened by the workspace service.",
                ));
            }
        }

        Ok(resolved)
    }

    fn resolve_new(&self, relative_path: &str) -> Result<PathBuf, CommandError> {
        let relative = validate_relative_path(relative_path, false)?;
        let name = relative.file_name().ok_or_else(|| {
            CommandError::new("invalid_path", "A file or directory name is required.")
        })?;
        let relative_parent = relative.parent().unwrap_or_else(|| Path::new(""));
        let parent = self.resolve_existing(path_to_wire(relative_parent)?.as_str())?;
        let parent_metadata = fs::metadata(&parent)
            .map_err(|error| CommandError::io("inspect the parent directory", error))?;
        if !parent_metadata.is_dir() {
            return Err(CommandError::new(
                "not_a_directory",
                "The destination parent is not a directory.",
            ));
        }

        let destination = parent.join(name);
        self.ensure_scoped(&destination)?;
        Ok(destination)
    }

    fn ensure_scoped(&self, path: &Path) -> Result<(), CommandError> {
        if path == self.0 || path.starts_with(&self.0) {
            Ok(())
        } else {
            Err(CommandError::new(
                "path_outside_workspace",
                "The requested path resolves outside the selected workspace.",
            ))
        }
    }
}

pub(crate) struct ScopedWorkspaceFile {
    pub(crate) path: PathBuf,
    pub(crate) relative_path: String,
    pub(crate) workspace_root: PathBuf,
}

#[derive(Default)]
struct WorkspaceInner {
    root: Option<WorkspaceRoot>,
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct WorkspaceService {
    inner: Mutex<WorkspaceInner>,
}

impl WorkspaceService {
    pub(crate) fn root_path(&self) -> Result<PathBuf, CommandError> {
        Ok(self.root()?.path().to_path_buf())
    }

    pub(crate) fn authorize_existing_file(
        &self,
        selected_path: &Path,
    ) -> Result<ScopedWorkspaceFile, CommandError> {
        let root = self.root()?;
        let unresolved_metadata = fs::symlink_metadata(selected_path)
            .map_err(|error| CommandError::io("inspect the selected workspace file", error))?;
        if unresolved_metadata.file_type().is_symlink() {
            return Err(CommandError::new(
                "symlink_not_allowed",
                "Symbolic links cannot be opened by the workspace service.",
            ));
        }
        if !unresolved_metadata.is_file() {
            return Err(CommandError::new(
                "not_a_file",
                "Select an existing regular file inside the workspace.",
            ));
        }
        let path = fs::canonicalize(selected_path)
            .map_err(|error| CommandError::io("resolve the selected workspace file", error))?;
        let resolved_metadata = fs::symlink_metadata(selected_path)
            .map_err(|error| CommandError::io("recheck the selected workspace file", error))?;
        if resolved_metadata.file_type().is_symlink() {
            return Err(CommandError::new(
                "symlink_not_allowed",
                "Symbolic links cannot be opened by the workspace service.",
            ));
        }
        root.ensure_scoped(&path)?;
        let relative = path.strip_prefix(root.path()).map_err(|_| {
            CommandError::new(
                "path_outside_workspace",
                "The selected file resolves outside the active workspace.",
            )
        })?;
        Ok(ScopedWorkspaceFile {
            relative_path: path_to_wire(relative)?,
            path,
            workspace_root: root.path().to_path_buf(),
        })
    }

    fn root(&self) -> Result<WorkspaceRoot, CommandError> {
        self.inner
            .lock()
            .map_err(|_| CommandError::new("state_unavailable", "Workspace state is unavailable."))?
            .root
            .clone()
            .ok_or_else(|| {
                CommandError::new(
                    "workspace_not_selected",
                    "Select a workspace folder before accessing files.",
                )
            })
    }

    fn replace(
        &self,
        root: WorkspaceRoot,
        watcher: RecommendedWatcher,
    ) -> Result<(), CommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CommandError::new("state_unavailable", "Workspace state is unavailable."))?;
        inner.root = Some(root);
        inner.watcher = Some(watcher);
        Ok(())
    }

    fn close(&self) -> Result<(), CommandError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| CommandError::new("state_unavailable", "Workspace state is unavailable."))?;
        inner.watcher = None;
        inner.root = None;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    name: String,
    path: String,
}

impl WorkspaceInfo {
    fn from_root(root: &WorkspaceRoot) -> Self {
        let name = root
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Workspace")
            .to_string();
        Self {
            name,
            path: root.path().to_string_lossy().into_owned(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    name: String,
    path: String,
    kind: &'static str,
    size: Option<u64>,
    modified_ms: Option<u64>,
    readonly: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocument {
    path: String,
    content: String,
    revision: String,
    size: u64,
    modified_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChange {
    kind: &'static str,
    paths: Vec<String>,
}

#[tauri::command]
pub async fn workspace_select(
    app: AppHandle,
    service: State<'_, WorkspaceService>,
    search_index: State<'_, SearchIndexService>,
) -> Result<Option<WorkspaceInfo>, CommandError> {
    let selected = app
        .dialog()
        .file()
        .set_title("Select a DevLab workspace")
        .blocking_pick_folder();
    let selected = match selected {
        Some(selected) => selected,
        None => return Ok(None),
    };
    let selected_path = selected.as_path().ok_or_else(|| {
        CommandError::new(
            "unsupported_selection",
            "The selected folder is not available as a local filesystem path.",
        )
    })?;
    let root = WorkspaceRoot::open(selected_path)?;
    let watcher = create_watcher(&app, &root)?;
    let info = WorkspaceInfo::from_root(&root);
    // Any search index belongs to the previous workspace; drop it before the root changes.
    search_index.clear();
    service.replace(root, watcher)?;
    Ok(Some(info))
}

#[tauri::command]
pub fn workspace_current(
    service: State<'_, WorkspaceService>,
) -> Result<Option<WorkspaceInfo>, CommandError> {
    match service.root() {
        Ok(root) => Ok(Some(WorkspaceInfo::from_root(&root))),
        Err(error) if error.code == "workspace_not_selected" => Ok(None),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn workspace_close(
    service: State<'_, WorkspaceService>,
    search_index: State<'_, SearchIndexService>,
) -> Result<(), CommandError> {
    search_index.clear();
    service.close()
}

#[tauri::command]
pub fn workspace_list(
    relative_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<Vec<WorkspaceEntry>, CommandError> {
    let relative_path = normalize_relative_path(&relative_path, true)?;
    let root = service.root()?;
    let directory = root.resolve_existing(&relative_path)?;
    let metadata = fs::metadata(&directory)
        .map_err(|error| CommandError::io("inspect the directory", error))?;
    if !metadata.is_dir() {
        return Err(CommandError::new(
            "not_a_directory",
            "The requested workspace path is not a directory.",
        ));
    }

    let mut entries = Vec::new();
    let read_dir =
        fs::read_dir(&directory).map_err(|error| CommandError::io("list the directory", error))?;
    for entry_result in read_dir.take(MAX_DIRECTORY_ENTRIES + 1) {
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            return Err(CommandError::new(
                "directory_too_large",
                format!(
                    "This directory contains more than {MAX_DIRECTORY_ENTRIES} entries. Open a smaller directory."
                ),
            ));
        }

        let entry = entry_result.map_err(|error| CommandError::io("read a directory entry", error))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| {
                CommandError::new(
                    "unsupported_filename",
                    "The directory contains a filename that is not valid Unicode.",
                )
            })?;
        let entry_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", relative_path.trim_end_matches('/'), name)
        };
        let entry_metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| CommandError::io("inspect a directory entry", error))?;
        let file_type = entry_metadata.file_type();
        let kind = if file_type.is_symlink() {
            "symlink"
        } else if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else {
            "other"
        };
        entries.push(WorkspaceEntry {
            name,
            path: entry_relative,
            kind,
            size: file_type.is_file().then_some(entry_metadata.len()),
            modified_ms: modified_ms(&entry_metadata),
            readonly: entry_metadata.permissions().readonly(),
        });
    }

    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn workspace_read(
    relative_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<WorkspaceDocument, CommandError> {
    read_workspace_document(relative_path, &service)
}

fn read_workspace_document(
    relative_path: String,
    service: &WorkspaceService,
) -> Result<WorkspaceDocument, CommandError> {
    let relative_path = normalize_relative_path(&relative_path, false)?;
    let root = service.root()?;
    let path = root.resolve_existing(&relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| CommandError::io("inspect the file", error))?;
    if !metadata.is_file() {
        return Err(CommandError::new(
            "not_a_file",
            "The requested workspace path is not a regular file.",
        ));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            format!(
                "DevLab opens text files up to {} MiB.",
                MAX_TEXT_FILE_BYTES / 1024 / 1024
            ),
        ));
    }

    let file = fs::File::open(&path).map_err(|error| CommandError::io("open the file", error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_TEXT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CommandError::io("read the file", error))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "The file grew beyond the text-file limit while it was being read.",
        ));
    }
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        CommandError::new(
            "binary_file",
            "This file is not valid UTF-8 text and cannot be edited safely.",
        )
    })?;

    Ok(WorkspaceDocument {
        path: relative_path,
        content,
        revision: revision(&bytes),
        size: bytes.len() as u64,
        modified_ms: modified_ms(&metadata),
    })
}

#[tauri::command]
pub fn workspace_write(
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
    service: State<'_, WorkspaceService>,
) -> Result<WorkspaceDocument, CommandError> {
    let (document, _) = write_workspace_document(
        relative_path,
        content,
        expected_revision,
        &service,
        false,
    )?;
    Ok(document)
}

#[tauri::command]
pub fn workspace_apply_reviewed_draft(
    app: AppHandle,
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
    service: State<'_, WorkspaceService>,
) -> Result<WorkspaceDocument, CommandError> {
    let root = service.root_path()?;
    let (document, action) = write_workspace_document(
        relative_path,
        content,
        expected_revision,
        &service,
        true,
    )?;
    app.state::<AgentAuditService>().record(
        Some(&root),
        "reviewed-draft",
        action,
        document.path.clone(),
        "success",
        format!(
            "Reviewed draft {action} {} through scoped workspace write ({} bytes).",
            document.path, document.size
        ),
    );
    Ok(document)
}

fn write_workspace_document(
    relative_path: String,
    content: String,
    expected_revision: Option<String>,
    service: &WorkspaceService,
    create_missing_parents: bool,
) -> Result<(WorkspaceDocument, &'static str), CommandError> {
    let relative_path = normalize_relative_path(&relative_path, false)?;
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            format!(
                "DevLab writes text files up to {} MiB.",
                MAX_TEXT_FILE_BYTES / 1024 / 1024
            ),
        ));
    }

    let root = service.root()?;
    let unresolved = if create_missing_parents {
        resolve_new_with_missing_parents(&root, &relative_path)?
    } else {
        root.resolve_new(&relative_path)?
    };
    let action;
    if workspace_entry_exists(&unresolved)? {
        action = "updated";
        let path = root.resolve_existing(&relative_path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| CommandError::io("inspect the file before saving", error))?;
        if !metadata.is_file() {
            return Err(CommandError::new(
                "not_a_file",
                "The requested workspace path is not a regular file.",
            ));
        }
        if metadata.len() > MAX_TEXT_FILE_BYTES {
            return Err(CommandError::new(
                "file_too_large",
                "The existing file is larger than the native text-file limit.",
            ));
        }
        let current_bytes = fs::read(&path)
            .map_err(|error| CommandError::io("verify the file before saving", error))?;
        if current_bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
            return Err(CommandError::new(
                "file_too_large",
                "The existing file grew beyond the native text-file limit.",
            ));
        }
        let expected = expected_revision.ok_or_else(|| {
            CommandError::new(
                "revision_required",
                "Read the existing file before overwriting it.",
            )
        })?;
        if revision(&current_bytes) != expected {
            return Err(CommandError::new(
                "revision_conflict",
                "The file changed on disk after it was opened. Reload it before saving.",
            ));
        }
        write_existing(&path, content.as_bytes())?;
    } else {
        action = "created";
        if expected_revision.is_some() {
            return Err(CommandError::new(
                "revision_conflict",
                "The destination file was removed or renamed after it was opened.",
            ));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&unresolved)
            .map_err(|error| CommandError::io("create the file", error))?;
        file.write_all(content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| CommandError::io("write the new file", error))?;
    }

    let document = read_workspace_document(relative_path, service)?;
    Ok((document, action))
}


fn resolve_new_with_missing_parents(
    root: &WorkspaceRoot,
    relative_path: &str,
) -> Result<PathBuf, CommandError> {
    let relative = validate_relative_path(relative_path, false)?;
    let name = relative.file_name().ok_or_else(|| {
        CommandError::new("invalid_path", "A file or directory name is required.")
    })?;
    let relative_parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent = ensure_workspace_directories(root, relative_parent)?;
    let destination = parent.join(name);
    root.ensure_scoped(&destination)?;
    Ok(destination)
}

fn ensure_workspace_directories(
    root: &WorkspaceRoot,
    relative_parent: &Path,
) -> Result<PathBuf, CommandError> {
    let mut current = root.path().to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(part) = component else {
            return Err(CommandError::new(
                "invalid_path",
                "Only relative workspace paths can be created by reviewed drafts.",
            ));
        };
        let next = current.join(part);
        match fs::symlink_metadata(&next) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(CommandError::new(
                        "symlink_not_allowed",
                        "Symbolic links cannot be used as reviewed-draft parent directories.",
                    ));
                }
                if !metadata.is_dir() {
                    return Err(CommandError::new(
                        "not_a_directory",
                        "A reviewed-draft parent path exists but is not a directory.",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&next)
                    .map_err(|error| CommandError::io("create reviewed-draft parent directory", error))?;
            }
            Err(error) => {
                return Err(CommandError::io(
                    "inspect reviewed-draft parent directory",
                    error,
                ));
            }
        }
        current = fs::canonicalize(&next)
            .map_err(|error| CommandError::io("resolve reviewed-draft parent directory", error))?;
        root.ensure_scoped(&current)?;
    }
    Ok(current)
}

#[tauri::command]
pub fn workspace_create_file(
    relative_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<WorkspaceDocument, CommandError> {
    let relative_path = normalize_relative_path(&relative_path, false)?;
    let root = service.root()?;
    let path = root.resolve_new(&relative_path)?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CommandError::new("already_exists", "A file or directory already exists there.")
            } else {
                CommandError::io("create the file", error)
            }
        })?;
    file.sync_all()
        .map_err(|error| CommandError::io("finish creating the file", error))?;
    workspace_read(relative_path, service)
}

#[tauri::command]
pub fn workspace_create_directory(
    relative_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<(), CommandError> {
    let relative_path = normalize_relative_path(&relative_path, false)?;
    let root = service.root()?;
    let path = root.resolve_new(&relative_path)?;
    fs::create_dir(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CommandError::new("already_exists", "A file or directory already exists there.")
        } else {
            CommandError::io("create the directory", error)
        }
    })
}

#[tauri::command]
pub fn workspace_rename(
    from_path: String,
    to_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<(), CommandError> {
    let from_path = normalize_relative_path(&from_path, false)?;
    let to_path = normalize_relative_path(&to_path, false)?;
    let root = service.root()?;
    let source = root.resolve_existing(&from_path)?;
    if source == root.path() {
        return Err(CommandError::new(
            "invalid_path",
            "The workspace root cannot be renamed from inside DevLab.",
        ));
    }
    let destination = root.resolve_new(&to_path)?;
    if workspace_entry_exists(&destination)? {
        return Err(CommandError::new(
            "already_exists",
            "A file or directory already exists at the destination.",
        ));
    }
    fs::rename(source, destination)
        .map_err(|error| CommandError::io("rename the workspace entry", error))
}

#[tauri::command]
pub fn workspace_delete(
    relative_path: String,
    service: State<'_, WorkspaceService>,
) -> Result<(), CommandError> {
    let relative_path = normalize_relative_path(&relative_path, false)?;
    let root = service.root()?;
    let path = root.resolve_existing(&relative_path)?;
    if path == root.path() {
        return Err(CommandError::new(
            "invalid_path",
            "The workspace root cannot be deleted from inside DevLab.",
        ));
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| CommandError::io("inspect the entry before deleting", error))?;
    if metadata.is_file() {
        fs::remove_file(path).map_err(|error| CommandError::io("delete the file", error))
    } else if metadata.is_dir() {
        fs::remove_dir(path).map_err(|error| {
            CommandError::new(
                "directory_delete_failed",
                format!(
                    "The directory could not be deleted. Only empty, writable directories are allowed: {error}"
                ),
            )
        })
    } else {
        Err(CommandError::new(
            "unsupported_file_type",
            "This type of workspace entry cannot be deleted.",
        ))
    }
}

fn create_watcher(
    app: &AppHandle,
    root: &WorkspaceRoot,
) -> Result<RecommendedWatcher, CommandError> {
    let app = app.clone();
    let watched_root = root.path().to_path_buf();
    let event_root = watched_root.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        let event = match result {
            Ok(event) => event,
            Err(_) => return,
        };
        let kind = match event.kind {
            EventKind::Access(_) => return,
            EventKind::Create(_) => "create",
            EventKind::Modify(_) => "modify",
            EventKind::Remove(_) => "remove",
            EventKind::Any | EventKind::Other => "other",
        };
        let paths = event
            .paths
            .iter()
            .filter_map(|path| path.strip_prefix(&event_root).ok())
            .filter_map(|path| path_to_wire(path).ok())
            .collect::<Vec<String>>();
        if paths.is_empty() {
            return;
        }
        if app
            .emit("workspace-changed", WorkspaceChange { kind, paths })
            .is_err()
        {
            log::warn!("could not emit a workspace change event");
        }
    })
    .map_err(|error| {
        CommandError::new(
            "watcher_unavailable",
            format!("Could not start native workspace watching: {error}"),
        )
    })?;
    watcher
        .watch(&watched_root, RecursiveMode::Recursive)
        .map_err(|error| {
            CommandError::new(
                "watcher_unavailable",
                format!("Could not watch the selected workspace: {error}"),
            )
        })?;
    Ok(watcher)
}

fn normalize_relative_path(value: &str, allow_empty: bool) -> Result<String, CommandError> {
    path_to_wire(&validate_relative_path(value, allow_empty)?)
}

fn validate_relative_path(value: &str, allow_empty: bool) -> Result<PathBuf, CommandError> {
    if value.len() > MAX_RELATIVE_PATH_BYTES {
        return Err(CommandError::new(
            "invalid_path",
            "The relative workspace path is too long.",
        ));
    }
    if value.contains('\0') {
        return Err(CommandError::new(
            "invalid_path",
            "Workspace paths cannot contain null bytes.",
        ));
    }

    let path = Path::new(value);
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(CommandError::new(
                    "invalid_path",
                    "Use a relative path inside the selected workspace; parent traversal is not allowed.",
                ));
            }
        }
    }
    if !allow_empty && relative.as_os_str().is_empty() {
        return Err(CommandError::new(
            "invalid_path",
            "A non-empty relative workspace path is required.",
        ));
    }
    Ok(relative)
}

fn path_to_wire(path: &Path) -> Result<String, CommandError> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(
                part.to_str()
                    .ok_or_else(|| {
                        CommandError::new(
                            "unsupported_filename",
                            "The workspace path is not valid Unicode.",
                        )
                    })?
                    .to_string(),
            ),
            Component::CurDir => {}
            _ => {
                return Err(CommandError::new(
                    "invalid_path",
                    "Only relative workspace paths can cross the native boundary.",
                ));
            }
        }
    }
    Ok(parts.join("/"))
}

fn workspace_entry_exists(path: &Path) -> Result<bool, CommandError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(CommandError::io("inspect the workspace destination", error)),
    }
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn write_existing(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| CommandError::io("open the file for saving", error))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| CommandError::io("save the file", error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = format!(
                "devlab-workspace-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock should be after Unix epoch")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir(&path).expect("test workspace should be created");
            Self(path)
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(validate_relative_path("../secret", false).is_err());
        assert!(validate_relative_path("a/../../secret", false).is_err());
        assert!(validate_relative_path("/etc/passwd", false).is_err());
        assert!(validate_relative_path("src/main.rs", false).is_ok());
    }

    #[test]
    fn resolves_only_paths_inside_the_workspace() {
        let workspace = TestWorkspace::new();
        let nested = workspace.0.join("src");
        fs::create_dir(&nested).expect("nested directory should be created");
        fs::write(nested.join("main.rs"), "fn main() {}")
            .expect("test file should be written");
        let root = WorkspaceRoot::open(&workspace.0).expect("workspace should open");

        let file = root
            .resolve_existing("src/main.rs")
            .expect("workspace file should resolve");
        assert!(file.starts_with(root.path()));
        assert!(root.resolve_existing("../outside").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        fs::write(outside.0.join("secret.txt"), "secret").expect("outside file should exist");
        symlink(outside.0.join("secret.txt"), workspace.0.join("escape.txt"))
            .expect("test symlink should be created");
        let root = WorkspaceRoot::open(&workspace.0).expect("workspace should open");

        let error = root
            .resolve_existing("escape.txt")
            .expect_err("escaping symlink must fail");
        assert_eq!(error.code, "path_outside_workspace");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_even_when_the_target_is_inside() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        fs::write(workspace.0.join("real.txt"), "real").expect("real file should exist");
        symlink("real.txt", workspace.0.join("alias.txt"))
            .expect("test symlink should be created");
        let root = WorkspaceRoot::open(&workspace.0).expect("workspace should open");

        let error = root
            .resolve_existing("alias.txt")
            .expect_err("all final symlinks must fail");
        assert_eq!(error.code, "symlink_not_allowed");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_new_files_below_an_escaping_symlink() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        symlink(&outside.0, workspace.0.join("outside"))
            .expect("test directory symlink should be created");
        let root = WorkspaceRoot::open(&workspace.0).expect("workspace should open");

        let error = root
            .resolve_new("outside/new.txt")
            .expect_err("a destination below an escaping symlink must fail");
        assert_eq!(error.code, "path_outside_workspace");
    }

    #[cfg(unix)]
    #[test]
    fn treats_dangling_symlinks_as_existing_entries() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        let dangling = workspace.0.join("dangling.txt");
        symlink("missing.txt", &dangling).expect("test symlink should be created");

        assert!(workspace_entry_exists(&dangling).expect("entry check should succeed"));
    }

    #[test]
    fn authorizes_only_existing_regular_files_in_the_workspace() {
        let workspace = TestWorkspace::new();
        let database = workspace.0.join("app.sqlite");
        fs::write(&database, b"SQLite format 3\0").expect("test file should exist");
        let service = WorkspaceService {
            inner: Mutex::new(WorkspaceInner {
                root: Some(WorkspaceRoot::open(&workspace.0).expect("workspace should open")),
                watcher: None,
            }),
        };
        let scoped = service
            .authorize_existing_file(&database)
            .expect("workspace file should be authorized");
        assert_eq!(scoped.relative_path, "app.sqlite");
        assert_eq!(scoped.workspace_root, workspace.0);

        let outside = TestWorkspace::new();
        let outside_file = outside.0.join("outside.sqlite");
        fs::write(&outside_file, b"SQLite format 3\0").expect("outside file should exist");
        assert!(service.authorize_existing_file(&outside_file).is_err());
        assert!(service.authorize_existing_file(&workspace.0).is_err());
    }

    #[test]
    fn reviewed_draft_write_creates_missing_parent_directories() {
        let workspace = TestWorkspace::new();
        let service = WorkspaceService {
            inner: Mutex::new(WorkspaceInner {
                root: Some(WorkspaceRoot::open(&workspace.0).expect("workspace should open")),
                watcher: None,
            }),
        };
        let (document, action) = write_workspace_document(
            "src/components/App.tsx".to_string(),
            "export function App() { return null; }".to_string(),
            None,
            &service,
            true,
        )
        .expect("reviewed draft should create missing parents");
        assert_eq!(action, "created");
        assert_eq!(document.path, "src/components/App.tsx");
        assert!(workspace.0.join("src/components/App.tsx").is_file());
    }

    #[test]
    fn generic_workspace_write_still_requires_existing_parent() {
        let workspace = TestWorkspace::new();
        let service = WorkspaceService {
            inner: Mutex::new(WorkspaceInner {
                root: Some(WorkspaceRoot::open(&workspace.0).expect("workspace should open")),
                watcher: None,
            }),
        };
        assert!(write_workspace_document(
            "src/main.ts".to_string(),
            "console.log('hi');".to_string(),
            None,
            &service,
            false,
        )
        .is_err());
    }

    #[test]
    fn revision_changes_with_content() {
        assert_eq!(revision(b"same"), revision(b"same"));
        assert_ne!(revision(b"before"), revision(b"after"));
    }
}
