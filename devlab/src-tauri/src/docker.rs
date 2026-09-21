use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::Duration,
};
use wait_timeout::ChildExt;

use crate::workspace::CommandError;

const DOCKER_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const DOCKER_ACTION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DOCKER_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 16 * 1024;
const MAX_OPERATION_OUTPUT_CHARS: usize = 32 * 1024;
const MAX_CONTAINERS: usize = 2_000;
const MAX_IMAGES: usize = 5_000;

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    output_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStateMessage {
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerSnapshot {
    cli_installed: bool,
    cli_version: Option<String>,
    daemon_connected: bool,
    daemon_version: Option<String>,
    state: DockerStateMessage,
    containers: Vec<DockerContainer>,
    images: Vec<DockerImage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    id: String,
    short_id: String,
    name: String,
    image: String,
    image_id: String,
    state: String,
    status: String,
    ports: String,
    created_at: String,
    running: bool,
    stats: Option<DockerStats>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStats {
    cpu_percent: String,
    memory_usage: String,
    memory_percent: String,
    network_io: String,
    block_io: String,
    pids: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    id: String,
    short_id: String,
    repository: String,
    tag: String,
    digest: String,
    size: String,
    created_since: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerOperationResult {
    message: String,
    output: String,
    snapshot: DockerSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogs {
    container_id: String,
    container_name: String,
    content: String,
}

#[derive(Default, Deserialize)]
struct RawContainer {
    #[serde(default, rename = "ID")]
    id: String,
    #[serde(default, rename = "Names")]
    names: String,
    #[serde(default, rename = "Image")]
    image: String,
    #[serde(default, rename = "ImageID")]
    image_id: String,
    #[serde(default, rename = "State")]
    state: String,
    #[serde(default, rename = "Status")]
    status: String,
    #[serde(default, rename = "Ports")]
    ports: String,
    #[serde(default, rename = "CreatedAt")]
    created_at: String,
}

#[derive(Default, Deserialize)]
struct RawStats {
    #[serde(default, rename = "Container")]
    container: String,
    #[serde(default, rename = "Name")]
    name: String,
    #[serde(default, rename = "CPUPerc")]
    cpu_percent: String,
    #[serde(default, rename = "MemUsage")]
    memory_usage: String,
    #[serde(default, rename = "MemPerc")]
    memory_percent: String,
    #[serde(default, rename = "NetIO")]
    network_io: String,
    #[serde(default, rename = "BlockIO")]
    block_io: String,
    #[serde(default, rename = "PIDs")]
    pids: String,
}

#[derive(Default, Deserialize)]
struct RawImage {
    #[serde(default, rename = "ID")]
    id: String,
    #[serde(default, rename = "Repository")]
    repository: String,
    #[serde(default, rename = "Tag")]
    tag: String,
    #[serde(default, rename = "Digest")]
    digest: String,
    #[serde(default, rename = "Size")]
    size: String,
    #[serde(default, rename = "CreatedSince")]
    created_since: String,
}

fn run_docker(arguments: &[&str], timeout: Duration) -> Result<ProcessOutput, CommandError> {
    let mut command = Command::new("docker");
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C");
    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CommandError::new(
                "docker_not_installed",
                "Docker CLI was not found on PATH. Install Docker and restart DevLab.",
            )
        } else {
            CommandError::new(
                "docker_start_failed",
                format!("Could not start the Docker CLI: {error}"),
            )
        }
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::new(
            "docker_output_unavailable",
            "Docker stdout could not be captured.",
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CommandError::new(
            "docker_output_unavailable",
            "Docker stderr could not be captured.",
        )
    })?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));

    let status = match child.wait_timeout(timeout).map_err(|error| {
        CommandError::new(
            "docker_wait_failed",
            format!("Could not wait for the Docker CLI: {error}"),
        )
    })? {
        Some(status) => status,
        None => {
            terminate_process_tree(&mut child);
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CommandError::new(
                "docker_timeout",
                format!(
                    "Docker exceeded the {} second operation limit.",
                    timeout.as_secs()
                ),
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
        let remaining = MAX_DOCKER_OUTPUT_BYTES.saturating_sub(stored.len());
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
        .map_err(|_| {
            CommandError::new(
                "docker_output_unavailable",
                "A Docker output reader stopped unexpectedly.",
            )
        })?
        .map_err(|error| {
            CommandError::new(
                "docker_output_unavailable",
                format!("Could not read Docker output: {error}"),
            )
        })
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

fn text(bytes: &[u8], description: &str) -> Result<String, CommandError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        CommandError::new(
            "unsupported_docker_output",
            format!("Docker returned non-UTF-8 {description}, which DevLab cannot display safely."),
        )
    })
}

fn output_detail(output: &ProcessOutput) -> String {
    let source = if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let value = String::from_utf8_lossy(source).trim().to_string();
    if value.chars().count() <= MAX_ERROR_CHARS {
        value
    } else {
        let mut concise: String = value.chars().take(MAX_ERROR_CHARS).collect();
        concise.push('…');
        concise
    }
}

fn checked_output(output: ProcessOutput, action: &str) -> Result<String, CommandError> {
    if output.output_truncated {
        return Err(CommandError::new(
            "docker_output_too_large",
            format!(
                "Docker produced more than {MAX_DOCKER_OUTPUT_BYTES} bytes while trying to {action}."
            ),
        ));
    }
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let detail = output_detail(&output);
    Err(CommandError::new(
        "docker_command_failed",
        if detail.is_empty() {
            format!("Could not {action}: Docker exited without an error message.")
        } else {
            format!("Could not {action}: {detail}")
        },
    ))
}

fn concise_output(value: String) -> String {
    if value.chars().count() <= MAX_OPERATION_OUTPUT_CHARS {
        value
    } else {
        let mut concise: String = value.chars().take(MAX_OPERATION_OUTPUT_CHARS).collect();
        concise.push_str("\n… Docker output truncated for display.");
        concise
    }
}

fn parse_json_lines<T: for<'de> Deserialize<'de>>(
    value: &str,
    kind: &str,
    limit: usize,
) -> Result<Vec<T>, CommandError> {
    let lines: Vec<&str> = value.lines().filter(|line| !line.trim().is_empty()).collect();
    if lines.len() > limit {
        return Err(CommandError::new(
            "docker_result_too_large",
            format!("Docker returned more than {limit} {kind} records."),
        ));
    }
    lines
        .into_iter()
        .map(|line| {
            serde_json::from_str(line).map_err(|error| {
                CommandError::new(
                    "unsupported_docker_output",
                    format!("Docker returned a {kind} record DevLab could not parse: {error}"),
                )
            })
        })
        .collect()
}

fn cli_version() -> Result<String, CommandError> {
    checked_output(
        run_docker(&["--version"], DOCKER_COMMAND_TIMEOUT)?,
        "read the Docker CLI version",
    )
}

fn daemon_version() -> Result<Result<String, String>, CommandError> {
    let output = run_docker(
        &["version", "--format", "{{.Server.Version}}"],
        DOCKER_COMMAND_TIMEOUT,
    )?;
    if output.output_truncated {
        return Err(CommandError::new(
            "docker_output_too_large",
            "Docker returned an unexpectedly large version response.",
        ));
    }
    if output.status.success() {
        Ok(Ok(text(&output.stdout, "daemon version")?.trim().to_string()))
    } else {
        Ok(Err(output_detail(&output)))
    }
}

fn read_stats() -> Result<Vec<RawStats>, CommandError> {
    let output = run_docker(
        &[
            "stats",
            "--all",
            "--no-stream",
            "--no-trunc",
            "--format",
            "{{json .}}",
        ],
        DOCKER_COMMAND_TIMEOUT,
    )?;
    let value = checked_output(output, "read container statistics")?;
    parse_json_lines(&value, "container statistics", MAX_CONTAINERS)
}

fn read_containers() -> Result<Vec<DockerContainer>, CommandError> {
    let output = run_docker(
        &[
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "{{json .}}",
        ],
        DOCKER_COMMAND_TIMEOUT,
    )?;
    let raw: Vec<RawContainer> = parse_json_lines(
        &checked_output(output, "list containers")?,
        "container",
        MAX_CONTAINERS,
    )?;
    let stats = read_stats()?;

    let mut containers: Vec<DockerContainer> = raw
        .into_iter()
        .map(|container| {
            let matching_stats = stats.iter().find(|stats| {
                stats.container == container.id
                    || (!stats.container.is_empty() && container.id.starts_with(&stats.container))
                    || (!stats.name.is_empty() && stats.name == container.names)
            });
            DockerContainer {
                short_id: container.id.chars().take(12).collect(),
                running: container.state.eq_ignore_ascii_case("running"),
                stats: matching_stats.map(|stats| DockerStats {
                    cpu_percent: stats.cpu_percent.clone(),
                    memory_usage: stats.memory_usage.clone(),
                    memory_percent: stats.memory_percent.clone(),
                    network_io: stats.network_io.clone(),
                    block_io: stats.block_io.clone(),
                    pids: stats.pids.clone(),
                }),
                id: container.id,
                name: container.names,
                image: container.image,
                image_id: container.image_id,
                state: container.state,
                status: container.status,
                ports: container.ports,
                created_at: container.created_at,
            }
        })
        .collect();
    containers.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(containers)
}

fn read_images() -> Result<Vec<DockerImage>, CommandError> {
    let output = run_docker(
        &[
            "image",
            "ls",
            "--all",
            "--no-trunc",
            "--digests",
            "--format",
            "{{json .}}",
        ],
        DOCKER_COMMAND_TIMEOUT,
    )?;
    let raw: Vec<RawImage> = parse_json_lines(
        &checked_output(output, "list images")?,
        "image",
        MAX_IMAGES,
    )?;
    let mut images: Vec<DockerImage> = raw
        .into_iter()
        .map(|image| DockerImage {
            short_id: image
                .id
                .strip_prefix("sha256:")
                .unwrap_or(&image.id)
                .chars()
                .take(12)
                .collect(),
            id: image.id,
            repository: image.repository,
            tag: image.tag,
            digest: image.digest,
            size: image.size,
            created_since: image.created_since,
        })
        .collect();
    images.sort_by(|left, right| {
        left.repository
            .cmp(&right.repository)
            .then(left.tag.cmp(&right.tag))
    });
    Ok(images)
}

fn snapshot() -> Result<DockerSnapshot, CommandError> {
    let cli_version = match cli_version() {
        Ok(version) => version,
        Err(error) if error.code == "docker_not_installed" => {
            return Ok(DockerSnapshot {
                cli_installed: false,
                cli_version: None,
                daemon_connected: false,
                daemon_version: None,
                state: DockerStateMessage {
                    code: "docker_not_installed",
                    message: error.message,
                },
                containers: Vec::new(),
                images: Vec::new(),
            });
        }
        Err(error) => return Err(error),
    };

    match daemon_version()? {
        Ok(daemon_version) => Ok(DockerSnapshot {
            cli_installed: true,
            cli_version: Some(cli_version),
            daemon_connected: true,
            daemon_version: Some(daemon_version),
            state: DockerStateMessage {
                code: "ready",
                message: "Docker Engine is connected.".to_string(),
            },
            containers: read_containers()?,
            images: read_images()?,
        }),
        Err(detail) => Ok(DockerSnapshot {
            cli_installed: true,
            cli_version: Some(cli_version),
            daemon_connected: false,
            daemon_version: None,
            state: DockerStateMessage {
                code: "docker_daemon_unavailable",
                message: if detail.is_empty() {
                    "Docker CLI is installed, but the Docker daemon is unavailable.".to_string()
                } else {
                    format!("Docker daemon is unavailable: {detail}")
                },
            },
            containers: Vec::new(),
            images: Vec::new(),
        }),
    }
}

fn validate_container_id(id: &str) -> Result<(), CommandError> {
    if !(12..=64).contains(&id.len()) || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CommandError::new(
            "invalid_container_id",
            "Container IDs must be 12 to 64 hexadecimal characters.",
        ));
    }
    Ok(())
}

fn require_container(id: &str) -> Result<DockerContainer, CommandError> {
    validate_container_id(id)?;
    read_containers()?
        .into_iter()
        .find(|container| container.id == id)
        .ok_or_else(|| {
            CommandError::new(
                "container_not_found",
                "The requested container no longer exists. Refresh Docker state.",
            )
        })
}

fn operation(
    id: String,
    action: &'static str,
    arguments: Vec<String>,
    success_message: &'static str,
) -> Result<DockerOperationResult, CommandError> {
    let _container = require_container(&id)?;
    let argument_refs: Vec<&str> = arguments.iter().map(String::as_str).collect();
    let output = checked_output(run_docker(&argument_refs, DOCKER_ACTION_TIMEOUT)?, action)?;
    Ok(DockerOperationResult {
        message: success_message.to_string(),
        output: concise_output(output),
        snapshot: snapshot()?,
    })
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
                "docker_worker_failed",
                "The Docker worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub async fn docker_snapshot() -> Result<DockerSnapshot, CommandError> {
    blocking(snapshot).await
}

#[tauri::command]
pub async fn docker_start(id: String) -> Result<DockerOperationResult, CommandError> {
    blocking(move || {
        operation(
            id.clone(),
            "start the container",
            vec!["start".to_string(), "--".to_string(), id],
            "Container started.",
        )
    })
    .await
}

#[tauri::command]
pub async fn docker_stop(id: String) -> Result<DockerOperationResult, CommandError> {
    blocking(move || {
        operation(
            id.clone(),
            "stop the container",
            vec![
                "stop".to_string(),
                "--time".to_string(),
                "10".to_string(),
                "--".to_string(),
                id,
            ],
            "Container stopped.",
        )
    })
    .await
}

#[tauri::command]
pub async fn docker_restart(id: String) -> Result<DockerOperationResult, CommandError> {
    blocking(move || {
        operation(
            id.clone(),
            "restart the container",
            vec![
                "restart".to_string(),
                "--time".to_string(),
                "10".to_string(),
                "--".to_string(),
                id,
            ],
            "Container restarted.",
        )
    })
    .await
}

#[tauri::command]
pub async fn docker_remove(id: String) -> Result<DockerOperationResult, CommandError> {
    blocking(move || {
        let container = require_container(&id)?;
        if container.running {
            return Err(CommandError::new(
                "container_running",
                "Stop the container before removing it. DevLab does not force-remove running containers.",
            ));
        }
        operation(
            id.clone(),
            "remove the container",
            vec!["rm".to_string(), "--".to_string(), id],
            "Container removed.",
        )
    })
    .await
}

#[tauri::command]
pub async fn docker_logs(id: String) -> Result<DockerLogs, CommandError> {
    blocking(move || {
        let container = require_container(&id)?;
        let output = run_docker(
            &[
                "logs",
                "--tail",
                "500",
                "--timestamps",
                "--",
                &id,
            ],
            DOCKER_COMMAND_TIMEOUT,
        )?;
        if output.output_truncated {
            return Err(CommandError::new(
                "docker_output_too_large",
                "Container logs exceeded DevLab's 4 MiB response limit.",
            ));
        }
        if !output.status.success() {
            return Err(CommandError::new(
                "docker_command_failed",
                format!("Could not read container logs: {}", output_detail(&output)),
            ));
        }
        let mut content = text(&output.stdout, "container logs")?;
        let stderr = text(&output.stderr, "container logs")?;
        if !stderr.is_empty() {
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str(&stderr);
        }
        Ok(DockerLogs {
            container_id: container.id,
            container_name: container.name,
            content,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_container_json_lines() {
        let value = r#"{"ID":"abcdef1234567890","Names":"web","Image":"nginx:latest","State":"running","Status":"Up 2 minutes"}
{"ID":"123456abcdef7890","Names":"worker","Image":"worker:dev","State":"exited","Status":"Exited (0)"}"#;
        let parsed: Vec<RawContainer> =
            parse_json_lines(value, "container", 10).expect("containers should parse");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].names, "web");
        assert_eq!(parsed[1].state, "exited");
    }

    #[test]
    fn validates_container_ids() {
        assert!(validate_container_id("abcdef123456").is_ok());
        assert!(validate_container_id("ABCDEF1234567890").is_ok());
        assert!(validate_container_id("short").is_err());
        assert!(validate_container_id("abcdef12345-").is_err());
    }
}
