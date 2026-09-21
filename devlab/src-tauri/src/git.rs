use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::Duration,
};
use tauri::State;
use wait_timeout::ChildExt;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    credentials::{load_git_token, GitProvider},
    workspace::{CommandError, WorkspaceService},
};

const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 16 * 1024;
const MAX_OPERATION_OUTPUT_CHARS: usize = 32 * 1024;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_PATHS_PER_OPERATION: usize = 500;
const MAX_COMMIT_MESSAGE_BYTES: usize = 4_096;
const MAX_REMOTES: usize = 50;
const MAX_COMMITS: usize = 50;

#[derive(Default)]
struct GitEnvironment {
    values: Vec<(String, String)>,
    secrets: Vec<String>,
}

impl Drop for GitEnvironment {
    fn drop(&mut self) {
        for (_, value) in &mut self.values {
            value.zeroize();
        }
        for secret in &mut self.secrets {
            secret.zeroize();
        }
    }
}

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    output_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStateMessage {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    git_installed: bool,
    git_version: Option<String>,
    workspace_path: Option<String>,
    state: GitStateMessage,
    repository: Option<GitRepository>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    root: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    unborn: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    user_name: Option<String>,
    user_email: Option<String>,
    changes: Vec<GitChange>,
    commits: Vec<GitCommit>,
    branches: Vec<GitBranch>,
    remotes: Vec<GitRemote>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    path: String,
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
    kind: &'static str,
    staged: bool,
    unstaged: bool,
    conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    hash: String,
    short_hash: String,
    author_name: String,
    author_email: String,
    timestamp: i64,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    name: String,
    kind: &'static str,
    current: bool,
    hash: String,
    upstream: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    name: String,
    fetch_url: String,
    push_url: String,
    provider: Option<GitProvider>,
    uses_ssh: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    path: String,
    staged: String,
    unstaged: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    message: String,
    output: String,
    repository: GitRepository,
}

struct StatusDetails {
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    unborn: bool,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    changes: Vec<GitChange>,
}

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

fn run_git(
    root: Option<&Path>,
    arguments: &[OsString],
    timeout: Duration,
    environment: &GitEnvironment,
) -> Result<ProcessOutput, CommandError> {
    let mut command = Command::new("git");
    if let Some(root) = root {
        command.arg("-C").arg(root);
    }

    // Do not execute repository hooks or fsmonitor helpers from an untrusted checkout.
    // DevLab invokes only fixed Git subcommands; no renderer value is interpreted by a shell.
    command
        .arg("-c")
        .arg("core.hooksPath=")
        .arg("-c")
        .arg("core.fsmonitor=false")
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C")
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_ICASE_PATHSPECS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT");

    for (name, value) in &environment.values {
        command.env(name, value);
    }

    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CommandError::new(
                "git_not_installed",
                "Git was not found on PATH. Install Git and restart DevLab.",
            )
        } else {
            CommandError::new("git_start_failed", format!("Could not start Git: {error}"))
        }
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::new("git_output_unavailable", "Git stdout could not be captured.")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CommandError::new("git_output_unavailable", "Git stderr could not be captured.")
    })?;

    let stdout_reader = thread::spawn(move || read_bounded(stdout, MAX_GIT_OUTPUT_BYTES));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, MAX_GIT_OUTPUT_BYTES));

    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| CommandError::new("git_wait_failed", format!("Could not wait for Git: {error}")))?
    {
        Some(status) => status,
        None => {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CommandError::new(
                "git_timeout",
                format!("Git exceeded the {} second operation limit.", timeout.as_secs()),
            ));
        }
    };

    let (stdout, stdout_truncated) = join_reader(stdout_reader)?;
    let (stderr, stderr_truncated) = join_reader(stderr_reader)?;
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
        output_truncated: stdout_truncated || stderr_truncated,
    })
}

fn read_bounded(mut reader: impl Read) -> io::Result<(Vec<u8>, bool)> {
    let mut stored = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = MAX_GIT_OUTPUT_BYTES.saturating_sub(stored.len());
        let keep = count.min(remaining);
        stored.extend_from_slice(&buffer[..keep]);
        if keep < count {
            truncated = true;
        }
    }
    Ok((stored, truncated))
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<(Vec<u8>, bool)>>,
) -> Result<(Vec<u8>, bool), CommandError> {
    reader
        .join()
        .map_err(|_| CommandError::new("git_output_unavailable", "A Git output reader stopped unexpectedly."))?
        .map_err(|error| CommandError::new("git_output_unavailable", format!("Could not read Git output: {error}")))
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_tree(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut Child) {
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process_tree(child: &mut Child) {
    let _ = child.kill();
}

fn output_text<'a>(bytes: &'a [u8], description: &str) -> Result<&'a str, CommandError> {
    std::str::from_utf8(bytes).map_err(|_| {
        CommandError::new(
            "unsupported_git_output",
            format!("Git returned non-UTF-8 {description}, which DevLab cannot display safely."),
        )
    })
}

fn checked_output(
    output: ProcessOutput,
    action: &str,
    environment: &GitEnvironment,
) -> Result<String, CommandError> {
    if output.output_truncated {
        return Err(CommandError::new(
            "git_output_too_large",
            format!("Git produced more than {MAX_GIT_OUTPUT_BYTES} bytes while trying to {action}."),
        ));
    }
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }

    let source = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let mut detail = String::from_utf8_lossy(source).trim().to_string();
    if detail.chars().count() > MAX_ERROR_CHARS {
        detail = detail.chars().take(MAX_ERROR_CHARS).collect();
        detail.push_str("…");
    }
    detail = redact_sensitive_text(&detail, &environment.secrets);
    if detail.is_empty() {
        detail = match output.status.code() {
            Some(code) => format!("Git exited with status {code}."),
            None => "Git was terminated by the operating system.".to_string(),
        };
    }
    Err(CommandError::new(
        "git_command_failed",
        format!("Could not {action}: {detail}"),
    ))
}

fn redact_sensitive_text(value: &str, secrets: &[String]) -> String {
    let mut redacted = redact_url_credentials(value);
    for secret in secrets {
        if !secret.is_empty() {
            redacted = redacted.replace(secret, "[REDACTED]");
        }
    }
    redacted
}

fn concise_operation_output(value: String) -> String {
    if value.chars().count() <= MAX_OPERATION_OUTPUT_CHARS {
        value
    } else {
        let mut concise: String = value.chars().take(MAX_OPERATION_OUTPUT_CHARS).collect();
        concise.push_str("\n… Git output truncated for display.");
        concise
    }
}

fn redact_url_credentials(value: &str) -> String {
    let mut result = value.to_string();
    for scheme in ["https://", "http://"] {
        let mut search_from = 0;
        while let Some(relative_start) = result[search_from..].find(scheme) {
            let authority_start = search_from + relative_start + scheme.len();
            let authority_end = result[authority_start..]
                .find(|character: char| matches!(character, '/' | ' ' | '\n' | '\r'))
                .map(|offset| authority_start + offset)
                .unwrap_or(result.len());
            if let Some(at_offset) = result[authority_start..authority_end].rfind('@') {
                let at = authority_start + at_offset;
                result.replace_range(authority_start..at, "[REDACTED]");
                search_from = authority_start + "[REDACTED]".len() + 1;
            } else {
                search_from = authority_end;
            }
        }
    }
    result
}

fn git_version() -> Result<String, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        None,
        &args(&["--version"]),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    checked_output(output, "read the Git version", &environment)
}

fn repository_root(root: &Path) -> Result<Result<PathBuf, GitStateMessage>, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(&["rev-parse", "--show-toplevel"]),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        });
        let detail = redact_sensitive_text(detail.trim(), &[]);
        let not_repository = detail.contains("not a git repository");
        return Ok(Err(GitStateMessage {
            code: if not_repository {
                "not_repository"
            } else {
                "repository_unavailable"
            },
            message: if not_repository {
                "The selected workspace is not a Git repository. Initialize it in the terminal or select a repository root."
                    .to_string()
            } else {
                format!("Git could not inspect the selected workspace: {detail}")
            },
        }));
    }
    if output.output_truncated {
        return Err(CommandError::new(
            "git_output_too_large",
            "Git returned an unexpectedly large repository path.",
        ));
    }

    let path_text = output_text(&output.stdout, "repository path")?.trim();
    let discovered = fs::canonicalize(path_text).map_err(|error| {
        CommandError::new(
            "repository_unavailable",
            format!("Could not resolve the Git repository root: {error}"),
        )
    })?;
    let workspace = fs::canonicalize(root).map_err(|error| {
        CommandError::new(
            "workspace_unavailable",
            format!("Could not resolve the selected workspace: {error}"),
        )
    })?;

    if discovered != workspace {
        return Ok(Err(GitStateMessage {
            code: "repository_root_mismatch",
            message: format!(
                "The selected folder is inside the repository at {}. Select that repository root so Git cannot operate outside the granted workspace.",
                discovered.to_string_lossy()
            ),
        }));
    }
    Ok(Ok(discovered))
}

fn snapshot(workspace: Option<PathBuf>) -> Result<GitSnapshot, CommandError> {
    let version = match git_version() {
        Ok(version) => version,
        Err(error) if error.code == "git_not_installed" => {
            return Ok(GitSnapshot {
                git_installed: false,
                git_version: None,
                workspace_path: workspace.map(|path| path.to_string_lossy().into_owned()),
                state: GitStateMessage {
                    code: "git_not_installed",
                    message: error.message,
                },
                repository: None,
            });
        }
        Err(error) => return Err(error),
    };

    let Some(workspace) = workspace else {
        return Ok(GitSnapshot {
            git_installed: true,
            git_version: Some(version),
            workspace_path: None,
            state: GitStateMessage {
                code: "workspace_not_selected",
                message: "Select a native workspace folder before using source control.".to_string(),
            },
            repository: None,
        });
    };

    match repository_root(&workspace)? {
        Ok(root) => Ok(GitSnapshot {
            git_installed: true,
            git_version: Some(version),
            workspace_path: Some(workspace.to_string_lossy().into_owned()),
            state: GitStateMessage {
                code: "ready",
                message: "Git is connected to the selected repository.".to_string(),
            },
            repository: Some(read_repository(&root)?),
        }),
        Err(state) => Ok(GitSnapshot {
            git_installed: true,
            git_version: Some(version),
            workspace_path: Some(workspace.to_string_lossy().into_owned()),
            state,
            repository: None,
        }),
    }
}

fn require_repository(root: &Path) -> Result<PathBuf, CommandError> {
    match repository_root(root)? {
        Ok(root) => Ok(root),
        Err(state) => Err(CommandError::new(state.code, state.message)),
    }
}

fn read_repository(root: &Path) -> Result<GitRepository, CommandError> {
    let status = read_status(root)?;
    let head = read_optional(root, &["rev-parse", "--verify", "HEAD"])?;
    let (user_name, user_email) = (
        read_optional(root, &["config", "--get", "user.name"] )?,
        read_optional(root, &["config", "--get", "user.email"] )?,
    );
    let commits = if head.is_some() {
        read_commits(root)?
    } else {
        Vec::new()
    };

    Ok(GitRepository {
        root: root.to_string_lossy().into_owned(),
        head,
        branch: status.branch,
        detached: status.detached,
        unborn: status.unborn,
        upstream: status.upstream,
        ahead: status.ahead,
        behind: status.behind,
        user_name,
        user_email,
        changes: status.changes,
        commits,
        branches: read_branches(root)?,
        remotes: read_remotes(root)?,
    })
}

fn read_status(root: &Path) -> Result<StatusDetails, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(&[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ]),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    if !output.status.success() {
        checked_output(output, "read repository status", &environment)?;
        unreachable!();
    }
    if output.output_truncated {
        return Err(CommandError::new(
            "repository_too_large",
            "Repository status exceeded DevLab's 4 MiB response limit. Reduce the number of untracked files or add ignore rules.",
        ));
    }
    parse_status(output_text(&output.stdout, "repository status")?)
}

fn parse_status(value: &str) -> Result<StatusDetails, CommandError> {
    let records: Vec<&str> = value.split('\0').collect();
    let mut index = 0;
    let mut head = None;
    let mut branch = None;
    let mut detached = false;
    let mut unborn = false;
    let mut upstream = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut changes = Vec::new();

    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value == "(initial)" {
                unborn = true;
            } else {
                head = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.head ") {
            if value == "(detached)" {
                detached = true;
            } else {
                branch = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.upstream ") {
            upstream = Some(value.to_string());
            continue;
        }
        if let Some(value) = record.strip_prefix("# branch.ab ") {
            for field in value.split_whitespace() {
                if let Some(value) = field.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = field.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
            continue;
        }

        let (xy, path, original_path, force_conflict) = if record.starts_with("1 ") {
            let fields: Vec<&str> = record.splitn(9, ' ').collect();
            if fields.len() != 9 {
                return Err(malformed_status());
            }
            (fields[1], fields[8], None, false)
        } else if record.starts_with("2 ") {
            let fields: Vec<&str> = record.splitn(10, ' ').collect();
            if fields.len() != 10 || index >= records.len() {
                return Err(malformed_status());
            }
            let original = records[index];
            index += 1;
            (fields[1], fields[9], Some(original), false)
        } else if record.starts_with("u ") {
            let fields: Vec<&str> = record.splitn(11, ' ').collect();
            if fields.len() != 11 {
                return Err(malformed_status());
            }
            (fields[1], fields[10], None, true)
        } else if let Some(path) = record.strip_prefix("? ") {
            ("??", path, None, false)
        } else if record.starts_with("! ") {
            continue;
        } else {
            return Err(malformed_status());
        };

        let mut statuses = xy.chars();
        let index_status = statuses.next().unwrap_or('.');
        let worktree_status = statuses.next().unwrap_or('.');
        let conflicted = force_conflict || is_conflicted(index_status, worktree_status);
        changes.push(GitChange {
            path: path.to_string(),
            original_path: original_path.map(str::to_string),
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            kind: change_kind(index_status, worktree_status, conflicted),
            staged: index_status != '.' && index_status != '?',
            unstaged: worktree_status != '.' || index_status == '?',
            conflicted,
        });
    }

    Ok(StatusDetails {
        head,
        branch,
        detached,
        unborn,
        upstream,
        ahead,
        behind,
        changes,
    })
}

fn malformed_status() -> CommandError {
    CommandError::new(
        "unsupported_git_output",
        "Git returned a repository status record DevLab could not parse.",
    )
}

fn is_conflicted(index: char, worktree: char) -> bool {
    index == 'U'
        || worktree == 'U'
        || matches!((index, worktree), ('A', 'A') | ('D', 'D'))
}

fn change_kind(index: char, worktree: char, conflicted: bool) -> &'static str {
    if conflicted {
        return "conflicted";
    }
    let status = if worktree != '.' && worktree != '?' {
        worktree
    } else {
        index
    };
    match status {
        '?' => "untracked",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type-changed",
        'M' => "modified",
        _ => "changed",
    }
}

fn read_optional(root: &Path, values: &[&str]) -> Result<Option<String>, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(values),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    if output.status.success() {
        if output.output_truncated {
            return Err(CommandError::new(
                "git_output_too_large",
                "Git returned an unexpectedly large configuration value.",
            ));
        }
        let value = output_text(&output.stdout, "configuration")?.trim().to_string();
        Ok((!value.is_empty()).then_some(value))
    } else if output.status.code() == Some(1) || output.status.code() == Some(128) {
        Ok(None)
    } else {
        checked_output(output, "read repository configuration", &environment)?;
        unreachable!()
    }
}

fn read_commits(root: &Path) -> Result<Vec<GitCommit>, CommandError> {
    let format = "%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s";
    let limit = format!("--max-count={MAX_COMMITS}");
    let arguments = vec![
        OsString::from("log"),
        OsString::from("--date-order"),
        OsString::from(limit),
        OsString::from(format!("--format={format}")),
    ];
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &arguments,
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    let text = checked_output(output, "read commit history", &environment)?;
    let mut commits = Vec::new();
    for record in text.split('\x1e').filter(|record| !record.trim().is_empty()) {
        let fields: Vec<&str> = record.trim_matches('\n').split('\x1f').collect();
        if fields.len() != 6 {
            return Err(CommandError::new(
                "unsupported_git_output",
                "Git returned a commit record DevLab could not parse.",
            ));
        }
        commits.push(GitCommit {
            hash: fields[0].to_string(),
            short_hash: fields[1].to_string(),
            author_name: fields[2].to_string(),
            author_email: fields[3].to_string(),
            timestamp: fields[4].parse().unwrap_or(0),
            subject: fields[5].to_string(),
        });
    }
    Ok(commits)
}

fn read_branches(root: &Path) -> Result<Vec<GitBranch>, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(&[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
            "refs/heads",
            "refs/remotes",
        ]),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    let text = checked_output(output, "read branches", &environment)?;
    let mut branches = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let fields: Vec<&str> = line.split('\0').collect();
        if fields.len() != 5 {
            return Err(CommandError::new(
                "unsupported_git_output",
                "Git returned a branch record DevLab could not parse.",
            ));
        }
        if !fields[4].is_empty() || fields[0].ends_with("/HEAD") {
            continue;
        }
        let (name, kind) = if let Some(name) = fields[0].strip_prefix("refs/heads/") {
            (name.to_string(), "local")
        } else if let Some(name) = fields[0].strip_prefix("refs/remotes/") {
            (name.to_string(), "remote")
        } else {
            continue;
        };
        branches.push(GitBranch {
            name,
            kind,
            current: fields[3] == "*",
            hash: fields[1].chars().take(12).collect(),
            upstream: (!fields[2].is_empty()).then(|| fields[2].to_string()),
        });
    }
    Ok(branches)
}

fn read_remotes(root: &Path) -> Result<Vec<GitRemote>, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(&["remote"]),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    let names = checked_output(output, "read remotes", &environment)?;
    let names: Vec<&str> = names.lines().filter(|name| !name.is_empty()).collect();
    if names.len() > MAX_REMOTES {
        return Err(CommandError::new(
            "too_many_remotes",
            format!("This repository has more than {MAX_REMOTES} remotes."),
        ));
    }

    let mut remotes = Vec::new();
    for name in names {
        let fetch_url = remote_url(root, name, false)?;
        let push_url = remote_url(root, name, true).unwrap_or_else(|_| fetch_url.clone());
        let provider = provider_from_url(&fetch_url).or_else(|| provider_from_url(&push_url));
        let uses_ssh = is_ssh_url(&fetch_url) || is_ssh_url(&push_url);
        remotes.push(GitRemote {
            name: name.to_string(),
            fetch_url: redact_url_credentials(&fetch_url),
            push_url: redact_url_credentials(&push_url),
            provider,
            uses_ssh,
        });
    }
    Ok(remotes)
}

fn remote_url(root: &Path, name: &str, push: bool) -> Result<String, CommandError> {
    let mut values = vec!["remote", "get-url"];
    if push {
        values.push("--push");
    }
    values.push(name);
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &args(&values),
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    checked_output(output, "read a remote URL", &environment)
}

fn provider_from_url(url: &str) -> Option<GitProvider> {
    let host = remote_host(url)?;
    match host.as_str() {
        "github.com" => Some(GitProvider::Github),
        "gitlab.com" => Some(GitProvider::Gitlab),
        "bitbucket.org" => Some(GitProvider::Bitbucket),
        _ => None,
    }
}

fn remote_host(url: &str) -> Option<String> {
    if let Some((_, rest)) = url.split_once("://") {
        let authority = rest.split('/').next()?;
        return Some(
            authority
                .rsplit_once('@')
                .map(|(_, host)| host)
                .unwrap_or(authority)
                .split(':')
                .next()?
                .to_ascii_lowercase(),
        );
    }
    let authority = url.split(':').next()?;
    authority
        .rsplit_once('@')
        .map(|(_, host)| host.to_ascii_lowercase())
}

fn is_ssh_url(url: &str) -> bool {
    url.starts_with("ssh://") || (url.contains('@') && !url.starts_with("http://") && !url.starts_with("https://"))
}

fn validate_paths(paths: &[String]) -> Result<(), CommandError> {
    if paths.is_empty() {
        return Err(CommandError::new(
            "path_required",
            "Select at least one repository path.",
        ));
    }
    if paths.len() > MAX_PATHS_PER_OPERATION {
        return Err(CommandError::new(
            "too_many_paths",
            format!("At most {MAX_PATHS_PER_OPERATION} paths can be changed at once."),
        ));
    }
    for path in paths {
        validate_path(path)?;
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), CommandError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
        return Err(CommandError::new(
            "invalid_path",
            "Repository paths must be non-empty, valid text under 4 KiB.",
        ));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(CommandError::new(
            "invalid_path",
            "Absolute repository paths are not allowed.",
        ));
    }
    let mut components = candidate.components();
    let first = components.next();
    if matches!(first, Some(Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        || components.any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CommandError::new(
            "invalid_path",
            "Repository paths cannot contain parent traversal or special components.",
        ));
    }
    if matches!(first, Some(Component::Normal(name)) if name == std::ffi::OsStr::new(".git")) {
        return Err(CommandError::new(
            "invalid_path",
            "Direct access to Git's internal metadata is not allowed.",
        ));
    }
    Ok(())
}

fn path_arguments(command: &[&str], paths: &[String]) -> Vec<OsString> {
    let mut arguments: Vec<OsString> = command.iter().map(OsString::from).collect();
    arguments.push(OsString::from("--"));
    arguments.extend(paths.iter().map(OsString::from));
    arguments
}

fn run_local_operation(
    root: &Path,
    arguments: Vec<OsString>,
    action: &str,
    success_message: &str,
) -> Result<GitOperationResult, CommandError> {
    let environment = GitEnvironment::default();
    let output = run_git(
        Some(root),
        &arguments,
        LOCAL_COMMAND_TIMEOUT,
        &environment,
    )?;
    let detail = checked_output(output, action, &environment)?;
    Ok(GitOperationResult {
        message: success_message.to_string(),
        output: concise_operation_output(detail),
        repository: read_repository(root)?,
    })
}

fn has_head(root: &Path) -> Result<bool, CommandError> {
    Ok(read_optional(root, &["rev-parse", "--verify", "HEAD"])?.is_some())
}

fn validate_remote(root: &Path, remote: &str) -> Result<String, CommandError> {
    if remote.is_empty()
        || remote.len() > 255
        || remote.chars().any(|character| character.is_whitespace() || character == '\0')
    {
        return Err(CommandError::new("invalid_remote", "Choose a valid configured remote."));
    }
    let remotes = read_remotes(root)?;
    if !remotes.iter().any(|candidate| candidate.name == remote) {
        return Err(CommandError::new(
            "unknown_remote",
            "The requested remote is not configured for this repository.",
        ));
    }
    remote_url(root, remote, false)
}

fn network_environment(url: &str) -> Result<GitEnvironment, CommandError> {
    if url.starts_with("http://") {
        return Err(CommandError::new(
            "insecure_remote",
            "DevLab refuses Git network authentication over plain HTTP. Use HTTPS or SSH.",
        ));
    }
    if !url.starts_with("https://") {
        return Ok(GitEnvironment::default());
    }
    let Some(provider) = provider_from_url(url) else {
        return Ok(GitEnvironment::default());
    };
    let Some(token) = load_git_token(provider)? else {
        return Ok(GitEnvironment::default());
    };

    let basic = Zeroizing::new(format!(
        "{}:{}",
        provider.basic_auth_username(),
        token.as_str()
    ));
    let encoded = BASE64.encode(basic.as_bytes());
    Ok(GitEnvironment {
        values: vec![
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            (
                "GIT_CONFIG_KEY_0".to_string(),
                format!("http.https://{}/.extraHeader", provider.host()),
            ),
            (
                "GIT_CONFIG_VALUE_0".to_string(),
                format!("Authorization: Basic {encoded}"),
            ),
        ],
        secrets: vec![token.to_string(), encoded],
    })
}

fn run_network_operation(
    root: &Path,
    remote: &str,
    arguments: Vec<OsString>,
    action: &str,
    success_message: &str,
) -> Result<GitOperationResult, CommandError> {
    let url = validate_remote(root, remote)?;
    let environment = network_environment(&url)?;
    let output = run_git(
        Some(root),
        &arguments,
        NETWORK_COMMAND_TIMEOUT,
        &environment,
    )?;
    let detail = checked_output(output, action, &environment)?;
    Ok(GitOperationResult {
        message: success_message.to_string(),
        output: concise_operation_output(redact_sensitive_text(&detail, &environment.secrets)),
        repository: read_repository(root)?,
    })
}

async fn blocking<T, F>(work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| CommandError::new("git_worker_failed", "The Git worker stopped unexpectedly."))?
}

#[tauri::command]
pub async fn git_repository_snapshot(
    service: State<'_, WorkspaceService>,
) -> Result<GitSnapshot, CommandError> {
    let workspace = match service.root_path() {
        Ok(root) => Some(root),
        Err(error) if error.code == "workspace_not_selected" => None,
        Err(error) => return Err(error),
    };
    blocking(move || snapshot(workspace)).await
}

#[tauri::command]
pub async fn git_stage_paths(
    paths: Vec<String>,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        validate_paths(&paths)?;
        let root = require_repository(&workspace)?;
        run_local_operation(
            &root,
            path_arguments(&["add"], &paths),
            "stage repository paths",
            "Selected paths staged.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_unstage_paths(
    paths: Vec<String>,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        validate_paths(&paths)?;
        let root = require_repository(&workspace)?;
        let command = if has_head(&root)? {
            vec!["reset", "-q", "HEAD"]
        } else {
            vec!["rm", "-r", "--cached", "--ignore-unmatch"]
        };
        run_local_operation(
            &root,
            path_arguments(&command, &paths),
            "unstage repository paths",
            "Selected paths unstaged.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let root = require_repository(&workspace)?;
        run_local_operation(
            &root,
            args(&["add", "-A", "--", "."]),
            "stage all repository changes",
            "All repository changes staged.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_unstage_all(
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let root = require_repository(&workspace)?;
        let arguments = if has_head(&root)? {
            args(&["reset", "-q", "HEAD", "--", "."])
        } else {
            args(&["rm", "-r", "--cached", "--ignore-unmatch", "--", "."])
        };
        run_local_operation(
            &root,
            arguments,
            "unstage all repository changes",
            "All repository changes unstaged.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    message: String,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err(CommandError::new(
                "commit_message_required",
                "Enter a commit message.",
            ));
        }
        if message.len() > MAX_COMMIT_MESSAGE_BYTES || message.contains('\0') {
            return Err(CommandError::new(
                "invalid_commit_message",
                format!("Commit messages are limited to {MAX_COMMIT_MESSAGE_BYTES} bytes."),
            ));
        }
        let root = require_repository(&workspace)?;
        run_local_operation(
            &root,
            vec![
                OsString::from("commit"),
                OsString::from("--no-verify"),
                OsString::from("-m"),
                OsString::from(message),
            ],
            "create the commit",
            "Commit created.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_diff(
    path: String,
    service: State<'_, WorkspaceService>,
) -> Result<GitDiff, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        validate_path(&path)?;
        let root = require_repository(&workspace)?;
        let environment = GitEnvironment::default();
        let unstaged = checked_output(
            run_git(
                Some(&root),
                &path_arguments(&["diff", "--no-ext-diff", "--no-textconv"], std::slice::from_ref(&path)),
                LOCAL_COMMAND_TIMEOUT,
                &environment,
            )?,
            "read the unstaged diff",
            &environment,
        )?;
        let staged = checked_output(
            run_git(
                Some(&root),
                &path_arguments(
                    &["diff", "--cached", "--no-ext-diff", "--no-textconv"],
                    std::slice::from_ref(&path),
                ),
                LOCAL_COMMAND_TIMEOUT,
                &environment,
            )?,
            "read the staged diff",
            &environment,
        )?;
        Ok(GitDiff {
            path,
            staged,
            unstaged,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    remote: String,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let root = require_repository(&workspace)?;
        run_network_operation(
            &root,
            &remote,
            vec![
                OsString::from("fetch"),
                OsString::from("--prune"),
                OsString::from("--"),
                OsString::from(&remote),
            ],
            "fetch the remote",
            "Remote refs fetched.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_pull(
    remote: String,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let root = require_repository(&workspace)?;
        let status = read_status(&root)?;
        let branch = status.branch.ok_or_else(|| {
            CommandError::new(
                "detached_head",
                "Pull requires a checked-out local branch; this repository has a detached HEAD.",
            )
        })?;
        run_network_operation(
            &root,
            &remote,
            vec![
                OsString::from("pull"),
                OsString::from("--ff-only"),
                OsString::from("--no-rebase"),
                OsString::from("--"),
                OsString::from(&remote),
                OsString::from(branch),
            ],
            "fast-forward the current branch",
            "Current branch fast-forwarded.",
        )
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    remote: String,
    service: State<'_, WorkspaceService>,
) -> Result<GitOperationResult, CommandError> {
    let workspace = service.root_path()?;
    blocking(move || {
        let root = require_repository(&workspace)?;
        let status = read_status(&root)?;
        if status.branch.is_none() {
            return Err(CommandError::new(
                "detached_head",
                "Push requires a checked-out local branch; this repository has a detached HEAD.",
            ));
        }
        let mut arguments = vec![OsString::from("push"), OsString::from("--porcelain")];
        if status.upstream.is_none() {
            arguments.push(OsString::from("--set-upstream"));
        }
        arguments.extend([
            OsString::from("--"),
            OsString::from(&remote),
            OsString::from("HEAD"),
        ]);
        run_network_operation(
            &root,
            &remote,
            arguments,
            "push the current branch",
            "Current branch pushed.",
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_mixed_changes() {
        let value = concat!(
            "# branch.oid abcdef\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 M. N... 100644 100644 100644 abc def staged.txt\0",
            "1 .M N... 100644 100644 100644 abc def worktree.txt\0",
            "? new file.txt\0",
        );
        let parsed = parse_status(value).expect("status should parse");
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 1);
        assert!(parsed.changes[0].staged);
        assert!(parsed.changes[1].unstaged);
        assert_eq!(parsed.changes[2].kind, "untracked");
    }

    #[test]
    fn rejects_parent_paths_and_git_metadata() {
        assert!(validate_path("../outside").is_err());
        assert!(validate_path(".git/config").is_err());
        assert!(validate_path("src/main.rs").is_ok());
    }

    #[test]
    fn recognizes_supported_provider_urls() {
        assert!(matches!(
            provider_from_url("https://github.com/example/repo.git"),
            Some(GitProvider::Github)
        ));
        assert!(matches!(
            provider_from_url("git@gitlab.com:example/repo.git"),
            Some(GitProvider::Gitlab)
        ));
        assert!(provider_from_url("ssh://git@example.com/repo.git").is_none());
    }

    #[test]
    fn redacts_http_userinfo() {
        assert_eq!(
            redact_url_credentials("failed https://secret@github.com/a/b"),
            "failed https://[REDACTED]@github.com/a/b"
        );
    }
}
