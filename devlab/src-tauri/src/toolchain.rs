use serde::Serialize;
use std::{
    io::ErrorKind,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::workspace::CommandError;

const TOOLCHAIN_TIMEOUT_MS: u64 = 2_000;
const MAX_VERSION_OUTPUT_BYTES: usize = 2 * 1024;

struct ToolchainProbeSpec {
    id: &'static str,
    label: &'static str,
    category: &'static str,
    command: &'static str,
    args: &'static [&'static str],
}

const TOOLCHAIN_PROBES: &[ToolchainProbeSpec] = &[
    ToolchainProbeSpec { id: "node", label: "Node.js", category: "JavaScript", command: "node", args: &["--version"] },
    ToolchainProbeSpec { id: "npm", label: "npm", category: "JavaScript", command: "npm", args: &["--version"] },
    ToolchainProbeSpec { id: "git", label: "Git", category: "Source control", command: "git", args: &["--version"] },
    ToolchainProbeSpec { id: "docker", label: "Docker CLI", category: "Containers", command: "docker", args: &["--version"] },
    ToolchainProbeSpec { id: "cargo", label: "Cargo", category: "Rust", command: "cargo", args: &["--version"] },
    ToolchainProbeSpec { id: "rustc", label: "Rust compiler", category: "Rust", command: "rustc", args: &["--version"] },
    ToolchainProbeSpec { id: "go", label: "Go", category: "Go", command: "go", args: &["version"] },
    ToolchainProbeSpec { id: "python3", label: "Python 3", category: "Python", command: "python3", args: &["--version"] },
    ToolchainProbeSpec { id: "python", label: "Python", category: "Python", command: "python", args: &["--version"] },
    ToolchainProbeSpec { id: "pytest", label: "pytest", category: "Python", command: "pytest", args: &["--version"] },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainSnapshot {
    checked_at_ms: u64,
    timeout_ms: u64,
    max_output_bytes: usize,
    tools: Vec<ToolchainTool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainTool {
    id: &'static str,
    label: &'static str,
    category: &'static str,
    command: &'static str,
    args: Vec<&'static str>,
    available: bool,
    version: Option<String>,
    detail: String,
    error_code: Option<&'static str>,
}

#[tauri::command]
pub fn toolchain_snapshot() -> Result<ToolchainSnapshot, CommandError> {
    let tools = TOOLCHAIN_PROBES.iter().map(run_probe).collect::<Vec<_>>();
    Ok(ToolchainSnapshot {
        checked_at_ms: now_ms(),
        timeout_ms: TOOLCHAIN_TIMEOUT_MS,
        max_output_bytes: MAX_VERSION_OUTPUT_BYTES,
        tools,
    })
}

fn run_probe(spec: &ToolchainProbeSpec) -> ToolchainTool {
    let mut command = Command::new(spec.command);
    command.args(spec.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return unavailable(spec, "not_found", "Command was not found on PATH.");
        }
        Err(error) => {
            return unavailable(spec, "spawn_failed", format!("Could not start command: {error}"));
        }
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return match child.wait_with_output() {
                    Ok(output) => {
                        let detail = command_output(&output.stdout, &output.stderr);
                        if status.success() {
                            let version = first_line(&detail).unwrap_or_else(|| "detected".to_string());
                            ToolchainTool {
                                id: spec.id,
                                label: spec.label,
                                category: spec.category,
                                command: spec.command,
                                args: spec.args.to_vec(),
                                available: true,
                                version: Some(version),
                                detail: if detail.is_empty() { "Command completed without version output.".to_string() } else { detail },
                                error_code: None,
                            }
                        } else {
                            unavailable(spec, "nonzero_exit", if detail.is_empty() {
                                format!("Version command exited with status {status}.")
                            } else {
                                detail
                            })
                        }
                    }
                    Err(error) => unavailable(spec, "output_failed", format!("Could not read command output: {error}")),
                };
            }
            Ok(None) => {
                if started.elapsed() >= Duration::from_millis(TOOLCHAIN_TIMEOUT_MS) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return unavailable(spec, "timeout", format!("Version command exceeded {TOOLCHAIN_TIMEOUT_MS} ms."));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return unavailable(spec, "wait_failed", format!("Could not inspect command status: {error}")),
        }
    }
}

fn unavailable(spec: &ToolchainProbeSpec, code: &'static str, detail: impl Into<String>) -> ToolchainTool {
    ToolchainTool {
        id: spec.id,
        label: spec.label,
        category: spec.category,
        command: spec.command,
        args: spec.args.to_vec(),
        available: false,
        version: None,
        detail: bounded(detail.into()),
        error_code: Some(code),
    }
}

fn command_output(stdout: &[u8], stderr: &[u8]) -> String {
    let mut output = String::new();
    let stdout = bounded_bytes(stdout);
    if !stdout.trim().is_empty() {
        output.push_str(stdout.trim());
    }
    let stderr = bounded_bytes(stderr);
    if !stderr.trim().is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(stderr.trim());
    }
    bounded(output)
}

fn bounded(value: String) -> String {
    let bytes = value.as_bytes();
    if bytes.len() <= MAX_VERSION_OUTPUT_BYTES {
        return value;
    }
    let mut end = MAX_VERSION_OUTPUT_BYTES.saturating_sub(1);
    while !value.is_char_boundary(end) && end > 0 {
        end -= 1;
    }
    let mut output = value[..end].to_string();
    output.push('…');
    output
}

fn bounded_bytes(bytes: &[u8]) -> String {
    let length = bytes.len().min(MAX_VERSION_OUTPUT_BYTES);
    String::from_utf8_lossy(&bytes[..length]).to_string()
}

fn first_line(value: &str) -> Option<String> {
    value.lines().map(str::trim).find(|line| !line.is_empty()).map(|line| line.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_large_output_at_char_boundary() {
        let value = "é".repeat(MAX_VERSION_OUTPUT_BYTES);
        let bounded = bounded(value);
        assert!(bounded.len() <= MAX_VERSION_OUTPUT_BYTES + "…".len());
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn first_line_skips_empty_lines() {
        assert_eq!(first_line("\n\nnode v1\nextra"), Some("node v1".to_string()));
    }
}
