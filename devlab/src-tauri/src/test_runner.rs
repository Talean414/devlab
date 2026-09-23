use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io::{self, Read},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use wait_timeout::ChildExt;

use crate::{
    audit::AgentAuditService,
    workspace::{CommandError, WorkspaceService},
};

const TEST_RUN_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TEST_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 512 * 1024;
const MAX_TEST_PROFILES: usize = 24;

/// Profile kinds exposed to the renderer. "test" profiles run a test suite;
/// "check" profiles run a non-mutating verification (type check, lint, static
/// analysis). Both are backend-owned fixed commands; neither accepts renderer
/// supplied arguments.
const KIND_TEST: &str = "test";
const KIND_CHECK: &str = "check";
const MAX_PROFILE_ID_BYTES: usize = 96;

#[derive(Clone, Debug)]
struct TestProfileSpec {
    id: String,
    label: String,
    program: String,
    args: Vec<String>,
    command: String,
    reason: String,
    kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestProfile {
    id: String,
    label: String,
    command: String,
    reason: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerSnapshot {
    workspace_name: String,
    workspace_path: String,
    timeout_secs: u64,
    max_output_bytes: usize,
    profiles: Vec<TestProfile>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    profile: TestProfile,
    status: &'static str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    output_truncated: bool,
    timed_out: bool,
    elapsed_ms: u64,
}

#[derive(Deserialize)]
struct PackageJson {
    #[serde(default)]
    scripts: HashMap<String, String>,
}

struct ProcessOutput {
    status: Option<std::process::ExitStatus>,
    stdout: String,
    stderr: String,
    output_truncated: bool,
    timed_out: bool,
    elapsed_ms: u64,
}

impl TestProfileSpec {
    fn public(&self) -> TestProfile {
        TestProfile {
            id: self.id.clone(),
            label: self.label.clone(),
            command: self.command.clone(),
            reason: self.reason.clone(),
            kind: self.kind,
        }
    }
}

fn workspace_name(root: &Path) -> String {
    root.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Workspace")
        .to_string()
}

fn snapshot(root: &Path) -> Result<TestRunnerSnapshot, CommandError> {
    let (profiles, warnings) = discover_profiles(root)?;
    Ok(TestRunnerSnapshot {
        workspace_name: workspace_name(root),
        workspace_path: root.to_string_lossy().into_owned(),
        timeout_secs: TEST_RUN_TIMEOUT.as_secs(),
        max_output_bytes: MAX_TEST_OUTPUT_BYTES,
        profiles: profiles.iter().map(TestProfileSpec::public).collect(),
        warnings,
    })
}

fn run(root: &Path, profile_id: &str) -> Result<TestRunResult, CommandError> {
    validate_profile_id(profile_id)?;
    let (profiles, _) = discover_profiles(root)?;
    let profile = profiles
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| {
            CommandError::new(
                "test_profile_not_found",
                "That test profile is not available for the active workspace anymore. Refresh the test runner.",
            )
        })?;
    run_profile(root, profile)
}

fn discover_profiles(root: &Path) -> Result<(Vec<TestProfileSpec>, Vec<String>), CommandError> {
    let mut profiles = Vec::new();
    let mut ids = HashSet::new();
    let mut warnings = Vec::new();

    discover_node_profiles(root, &mut profiles, &mut ids, &mut warnings)?;
    discover_cargo_profile(root, &mut profiles, &mut ids);
    discover_go_profile(root, &mut profiles, &mut ids);
    discover_python_profile(root, &mut profiles, &mut ids);

    // Tests first, then checks; alphabetical within each kind.
    profiles.sort_by(|left, right| {
        kind_rank(left.kind)
            .cmp(&kind_rank(right.kind))
            .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
    });
    if profiles.is_empty() && warnings.is_empty() {
        warnings.push(
            "No supported verification profile was detected. DevLab currently discovers package.json test/typecheck/lint/check scripts, an installed TypeScript compiler, Cargo (test, check, clippy), Go (test, vet), pytest, ruff and mypy workspaces.".to_string(),
        );
    }
    Ok((profiles, warnings))
}

fn kind_rank(kind: &str) -> u8 {
    if kind == KIND_TEST {
        0
    } else {
        1
    }
}

fn discover_node_profiles(
    root: &Path,
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
    warnings: &mut Vec<String>,
) -> Result<(), CommandError> {
    let package_json = root.join("package.json");
    if !package_json.is_file() {
        return Ok(());
    }
    let text = read_manifest(&package_json, "package.json")?;
    let parsed = match serde_json::from_str::<PackageJson>(&text) {
        Ok(parsed) => parsed,
        Err(error) => {
            warnings.push(format!("package.json could not be parsed for test scripts: {error}"));
            return Ok(());
        }
    };
    let (program, runner_args) = node_package_manager(root);
    let mut names = parsed
        .scripts
        .keys()
        .filter(|name| {
            (is_test_script((*name).as_str()) || is_check_script((*name).as_str()))
                && !is_lifecycle_hook((*name).as_str(), &parsed.scripts)
        })
        .cloned()
        .collect::<Vec<_>>();
    names.sort();
    let mut has_typecheck_script = false;
    for name in names {
        if profiles.len() >= MAX_TEST_PROFILES {
            warnings.push(format!(
                "Only the first {MAX_TEST_PROFILES} verification profiles are exposed."
            ));
            break;
        }
        if !safe_script_name(&name) {
            warnings.push(format!("Skipped package script {name:?}; script names exposed to DevLab must be simple ASCII tokens."));
            continue;
        }
        let is_test = is_test_script(&name);
        if !is_test && is_typecheck_script(&name) {
            has_typecheck_script = true;
        }
        let id = format!("package:{name}");
        let mut args = runner_args.clone();
        args.push(name.clone());
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id,
                label: format!("package.json · {name}"),
                command: display_command(&program, &args),
                program: program.clone(),
                args,
                reason: if is_test {
                    "Discovered from package.json scripts. Runs without a shell, from the selected workspace.".to_string()
                } else {
                    "Discovered from package.json scripts as a non-mutating check (typecheck, lint or check). Runs without a shell, from the selected workspace.".to_string()
                },
                kind: if is_test { KIND_TEST } else { KIND_CHECK },
            },
        );
    }
    discover_tsc_profile(root, profiles, ids, warnings, has_typecheck_script);
    Ok(())
}

/// Offers `tsc --noEmit` when a tsconfig.json exists and the TypeScript compiler is
/// already installed in the workspace's node_modules. The compiler is started through
/// `node` with the package's own entry script, so nothing is downloaded and no shell
/// or PATH lookup of a package-manager shim is involved.
fn discover_tsc_profile(
    root: &Path,
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
    warnings: &mut Vec<String>,
    has_typecheck_script: bool,
) {
    if has_typecheck_script || !root.join("tsconfig.json").is_file() {
        return;
    }
    let entry = root
        .join("node_modules")
        .join("typescript")
        .join("bin")
        .join("tsc");
    if !entry.is_file() {
        warnings.push(
            "tsconfig.json exists but node_modules/typescript is not installed, so no tsc --noEmit profile is offered. Install dependencies first.".to_string(),
        );
        return;
    }
    let args = vec![
        "node_modules/typescript/bin/tsc".to_string(),
        "--noEmit".to_string(),
        "--pretty".to_string(),
        "false".to_string(),
    ];
    push_profile(
        profiles,
        ids,
        TestProfileSpec {
            id: "node:tsc".to_string(),
            label: "TypeScript · tsc --noEmit".to_string(),
            command: display_command("node", &args),
            program: "node".to_string(),
            args,
            reason: "tsconfig.json exists and the TypeScript compiler is installed in node_modules. Type checks only; emits nothing.".to_string(),
            kind: KIND_CHECK,
        },
    );
}

fn discover_cargo_profile(
    root: &Path,
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
) {
    if root.join("Cargo.toml").is_file() {
        let args = vec!["test".to_string(), "--color".to_string(), "never".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "cargo:test".to_string(),
                label: "Cargo tests".to_string(),
                command: display_command("cargo", &args),
                program: "cargo".to_string(),
                args,
                reason: "Cargo.toml exists in the selected workspace.".to_string(),
                kind: KIND_TEST,
            },
        );
        let check_args = vec!["check".to_string(), "--color".to_string(), "never".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "cargo:check".to_string(),
                label: "Cargo check".to_string(),
                command: display_command("cargo", &check_args),
                program: "cargo".to_string(),
                args: check_args,
                reason: "Cargo.toml exists in the selected workspace. Compiles without producing binaries; a cold build can exceed the 60-second bound and is then reported as a timeout.".to_string(),
                kind: KIND_CHECK,
            },
        );
        let clippy_args = vec![
            "clippy".to_string(),
            "--color".to_string(),
            "never".to_string(),
            "--no-deps".to_string(),
        ];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "cargo:clippy".to_string(),
                label: "Cargo clippy".to_string(),
                command: display_command("cargo", &clippy_args),
                program: "cargo".to_string(),
                args: clippy_args,
                reason: "Cargo.toml exists in the selected workspace. Requires the clippy component (rustup component add clippy); a missing component is reported as a failed run.".to_string(),
                kind: KIND_CHECK,
            },
        );
    }
}

fn discover_go_profile(
    root: &Path,
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
) {
    if root.join("go.mod").is_file() {
        let args = vec!["test".to_string(), "./...".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "go:test".to_string(),
                label: "Go tests".to_string(),
                command: display_command("go", &args),
                program: "go".to_string(),
                args,
                reason: "go.mod exists in the selected workspace.".to_string(),
                kind: KIND_TEST,
            },
        );
        let vet_args = vec!["vet".to_string(), "./...".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "go:vet".to_string(),
                label: "Go vet".to_string(),
                command: display_command("go", &vet_args),
                program: "go".to_string(),
                args: vet_args,
                reason: "go.mod exists in the selected workspace. Static analysis only; modifies nothing.".to_string(),
                kind: KIND_CHECK,
            },
        );
    }
}

fn discover_python_profile(
    root: &Path,
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
) {
    let has_pytest_config = ["pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml"]
        .iter()
        .any(|name| root.join(name).is_file());
    let program = if cfg!(windows) { "python" } else { "python3" };
    if has_pytest_config || root.join("tests").is_dir() {
        let args = vec!["-m".to_string(), "pytest".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "python:pytest".to_string(),
                label: "pytest".to_string(),
                command: display_command(program, &args),
                program: program.to_string(),
                args,
                reason: "A Python test marker or tests/ directory exists in the selected workspace.".to_string(),
                kind: KIND_TEST,
            },
        );
    }

    // Static checks are offered only when the workspace declares their configuration,
    // so a workspace that never adopted ruff or mypy is not sent failing runs.
    let pyproject = root.join("pyproject.toml");
    let pyproject_text = if pyproject.is_file() {
        read_manifest(&pyproject, "pyproject.toml").ok()
    } else {
        None
    };
    let declares_tool = |table: &str| {
        pyproject_text
            .as_deref()
            .is_some_and(|text| text.lines().any(|line| {
                let trimmed = line.trim();
                trimmed.starts_with(&format!("[tool.{table}]")) || trimmed.starts_with(&format!("[tool.{table}."))
            }))
    };
    if root.join("ruff.toml").is_file() || root.join(".ruff.toml").is_file() || declares_tool("ruff") {
        let args = vec!["-m".to_string(), "ruff".to_string(), "check".to_string(), ".".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "python:ruff".to_string(),
                label: "ruff check".to_string(),
                command: display_command(program, &args),
                program: program.to_string(),
                args,
                reason: "A ruff configuration exists in the selected workspace. Lints only; never rewrites files (no --fix).".to_string(),
                kind: KIND_CHECK,
            },
        );
    }
    if root.join("mypy.ini").is_file() || root.join(".mypy.ini").is_file() || declares_tool("mypy") {
        let args = vec!["-m".to_string(), "mypy".to_string(), ".".to_string()];
        push_profile(
            profiles,
            ids,
            TestProfileSpec {
                id: "python:mypy".to_string(),
                label: "mypy".to_string(),
                command: display_command(program, &args),
                program: program.to_string(),
                args,
                reason: "A mypy configuration exists in the selected workspace. Type checks only.".to_string(),
                kind: KIND_CHECK,
            },
        );
    }
}

fn push_profile(
    profiles: &mut Vec<TestProfileSpec>,
    ids: &mut HashSet<String>,
    profile: TestProfileSpec,
) {
    if profiles.len() >= MAX_TEST_PROFILES || !ids.insert(profile.id.clone()) {
        return;
    }
    profiles.push(profile);
}

fn node_package_manager(root: &Path) -> (String, Vec<String>) {
    if root.join("pnpm-lock.yaml").is_file() {
        ("pnpm".to_string(), vec!["run".to_string()])
    } else if root.join("yarn.lock").is_file() {
        ("yarn".to_string(), vec!["run".to_string()])
    } else {
        ("npm".to_string(), vec!["run".to_string()])
    }
}

fn read_manifest(path: &Path, name: &str) -> Result<String, CommandError> {
    let metadata = fs::metadata(path).map_err(|error| {
        CommandError::new(
            "test_manifest_unavailable",
            format!("Could not inspect {name}: {error}"),
        )
    })?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(CommandError::new(
            "test_manifest_too_large",
            format!("{name} is larger than DevLab's 512 KiB discovery limit."),
        ));
    }
    fs::read_to_string(path).map_err(|error| {
        CommandError::new(
            "test_manifest_unavailable",
            format!("Could not read {name}: {error}"),
        )
    })
}

fn is_test_script(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == "pretest" || lower == "posttest" {
        return false;
    }
    lower == "test"
        || lower == "vitest"
        || lower == "jest"
        || lower.starts_with("test:")
        || lower.ends_with(":test")
        || lower.contains(":test:")
        || lower.contains("-test")
        || lower.ends_with("tests")
}

/// Package scripts that DevLab treats as non-mutating checks. Names that suggest a
/// rewrite (fix, write, format without :check) are excluded on purpose: a reviewed
/// draft must never be changed behind the Editor's back by a verification run.
fn is_check_script(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if is_test_script(&lower) || lower.contains("fix") || lower.contains("write") {
        return false;
    }
    if lower == "format:check" || lower == "fmt:check" || lower == "prettier:check" {
        return true;
    }
    if lower.starts_with("format") || lower.starts_with("fmt") || lower.starts_with("prettier") {
        return false;
    }
    is_typecheck_script(&lower)
        || lower == "lint"
        || lower == "check"
        || lower.starts_with("lint:")
        || lower.starts_with("check:")
        || lower.ends_with(":lint")
        || lower.ends_with(":check")
}

/// npm runs `pre<name>`/`post<name>` automatically around `<name>`; they are never
/// offered on their own when the base script exists.
fn is_lifecycle_hook(name: &str, scripts: &HashMap<String, String>) -> bool {
    ["pre", "post"].iter().any(|prefix| {
        name.strip_prefix(*prefix)
            .is_some_and(|base| !base.is_empty() && scripts.contains_key(base))
    })
}

fn is_typecheck_script(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "typecheck"
        || lower == "type-check"
        || lower == "types"
        || lower == "tsc"
        || lower.starts_with("typecheck:")
        || lower.starts_with("type-check:")
        || lower.ends_with(":typecheck")
        || lower.ends_with(":type-check")
}

fn safe_script_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
        })
}

fn validate_profile_id(id: &str) -> Result<(), CommandError> {
    if id.is_empty()
        || id.len() > MAX_PROFILE_ID_BYTES
        || !id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.')
        })
    {
        return Err(CommandError::new(
            "invalid_test_profile",
            "The test profile identifier is invalid.",
        ));
    }
    Ok(())
}

fn display_command(program: &str, args: &[String]) -> String {
    std::iter::once(program.to_string())
        .chain(args.iter().cloned())
        .map(|part| {
            if part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/' | b':' | b'_' | b'-'))
            {
                part
            } else {
                format!("{:?}", part)
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn run_profile(root: &Path, profile: TestProfileSpec) -> Result<TestRunResult, CommandError> {
    let output = run_process(root, &profile)?;
    let status = if output.timed_out {
        "timeout"
    } else if output.status.as_ref().is_some_and(|status| status.success()) {
        "passed"
    } else {
        "failed"
    };
    Ok(TestRunResult {
        profile: profile.public(),
        status,
        exit_code: output.status.as_ref().and_then(|status| status.code()),
        stdout: output.stdout,
        stderr: output.stderr,
        output_truncated: output.output_truncated,
        timed_out: output.timed_out,
        elapsed_ms: output.elapsed_ms,
    })
}

fn run_process(root: &Path, profile: &TestProfileSpec) -> Result<ProcessOutput, CommandError> {
    let started = Instant::now();
    let mut command = Command::new(&profile.program);
    command
        .args(&profile.args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb");
    configure_process_group(&mut command);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CommandError::new(
                "test_command_not_found",
                format!(
                    "Could not start `{}`. Install the required toolchain or choose another detected test profile.",
                    profile.command
                ),
            )
        } else {
            CommandError::new(
                "test_command_start_failed",
                format!("Could not start `{}`: {error}", profile.command),
            )
        }
    })?;

    let stdout = child.stdout.take().ok_or_else(|| {
        CommandError::new("test_output_unavailable", "Test stdout could not be captured.")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CommandError::new("test_output_unavailable", "Test stderr could not be captured.")
    })?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout));
    let stderr_reader = thread::spawn(move || read_bounded(stderr));

    let mut timed_out = false;
    let status = match child.wait_timeout(TEST_RUN_TIMEOUT).map_err(|error| {
        CommandError::new(
            "test_wait_failed",
            format!("Could not wait for `{}`: {error}", profile.command),
        )
    })? {
        Some(status) => Some(status),
        None => {
            timed_out = true;
            terminate_process_tree(&mut child);
            let _ = child.wait();
            None
        }
    };

    let (stdout, stdout_truncated) = join_reader(stdout_reader)?;
    let (stderr, stderr_truncated) = join_reader(stderr_reader)?;
    Ok(ProcessOutput {
        status,
        stdout: display_text(&stdout),
        stderr: display_text(&stderr),
        output_truncated: stdout_truncated || stderr_truncated,
        timed_out,
        elapsed_ms: elapsed_ms(started),
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
        let remaining = MAX_TEST_OUTPUT_BYTES.saturating_sub(stored.len());
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
                "test_output_unavailable",
                "A test-output reader stopped unexpectedly.",
            )
        })?
        .map_err(|error| {
            CommandError::new(
                "test_output_unavailable",
                format!("Could not read test output: {error}"),
            )
        })
}

fn display_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|ch| {
            if ch.is_control() && !matches!(ch, '\n' | '\r' | '\t') {
                '�'
            } else {
                ch
            }
        })
        .collect()
}

fn elapsed_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
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

async fn blocking<T, F>(work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| {
            CommandError::new(
                "test_worker_failed",
                "The native test runner worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub async fn test_runner_snapshot(app: AppHandle) -> Result<TestRunnerSnapshot, CommandError> {
    blocking(move || {
        let root = app.state::<WorkspaceService>().root_path()?;
        snapshot(&root)
    })
    .await
}

#[tauri::command]
pub async fn test_runner_run(
    app: AppHandle,
    profile_id: String,
) -> Result<TestRunResult, CommandError> {
    blocking(move || {
        let root = app.state::<WorkspaceService>().root_path()?;
        let result = run(&root, &profile_id);
        let audit = app.state::<AgentAuditService>();
        match &result {
            Ok(run) => audit.record(
                Some(&root),
                "test-run",
                "run",
                run.profile.id.clone(),
                run.status,
                format!(
                    "{} completed with status {} in {} ms (exit code: {}).",
                    run.profile.label,
                    run.status,
                    run.elapsed_ms,
                    run.exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "none".to_string()),
                ),
            ),
            Err(error) => audit.record(
                Some(&root),
                "test-run",
                "run",
                profile_id.clone(),
                "error",
                format!("Test profile failed before completion: {}", error.message),
            ),
        };
        result
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = format!(
                "devlab-test-runner-{}-{}",
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
    fn discovers_safe_package_test_scripts() {
        let workspace = TestWorkspace::new();
        fs::write(
            workspace.0.join("package.json"),
            r#"{"scripts":{"test":"vitest run","native:test":"cargo test","pretest":"echo setup","build":"vite build"}}"#,
        )
        .expect("package.json should be written");
        let (profiles, warnings) = discover_profiles(&workspace.0).expect("profiles should load");
        let ids = profiles.iter().map(|profile| profile.id.as_str()).collect::<Vec<_>>();
        assert!(ids.contains(&"package:test"));
        assert!(ids.contains(&"package:native:test"));
        assert!(!ids.contains(&"package:pretest"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn discovers_backend_owned_test_profiles() {
        let workspace = TestWorkspace::new();
        fs::write(workspace.0.join("Cargo.toml"), "[package]\nname='demo'\nversion='0.1.0'")
            .expect("Cargo.toml should be written");
        fs::write(workspace.0.join("go.mod"), "module example.com/demo\n")
            .expect("go.mod should be written");
        fs::create_dir(workspace.0.join("tests")).expect("tests dir should be created");
        let (profiles, _) = discover_profiles(&workspace.0).expect("profiles should load");
        let commands = profiles
            .iter()
            .map(|profile| profile.command.as_str())
            .collect::<Vec<_>>();
        assert!(commands.contains(&"cargo test --color never"));
        assert!(commands.contains(&"go test ./..."));
        assert!(commands.iter().any(|command| command.ends_with("-m pytest")));
    }

    #[test]
    fn discovers_non_mutating_check_profiles() {
        let workspace = TestWorkspace::new();
        fs::write(
            workspace.0.join("package.json"),
            r#"{"scripts":{"test":"vitest run","typecheck":"tsc --noEmit","lint":"eslint .","lint:fix":"eslint . --fix","format":"prettier --write .","format:check":"prettier --check .","prelint":"echo x"}}"#,
        )
        .expect("package.json should be written");
        fs::write(workspace.0.join("tsconfig.json"), "{}").expect("tsconfig should be written");
        fs::write(workspace.0.join("Cargo.toml"), "[package]\nname='demo'\nversion='0.1.0'")
            .expect("Cargo.toml should be written");
        fs::write(workspace.0.join("go.mod"), "module example.com/demo\n")
            .expect("go.mod should be written");
        fs::write(workspace.0.join("pyproject.toml"), "[tool.ruff]\nline-length = 100\n")
            .expect("pyproject should be written");
        fs::write(workspace.0.join("mypy.ini"), "[mypy]\n").expect("mypy.ini should be written");

        let (profiles, warnings) = discover_profiles(&workspace.0).expect("profiles should load");
        let kinds = profiles
            .iter()
            .map(|profile| (profile.id.as_str(), profile.kind))
            .collect::<Vec<_>>();
        assert!(kinds.contains(&("package:test", KIND_TEST)));
        assert!(kinds.contains(&("package:typecheck", KIND_CHECK)));
        assert!(kinds.contains(&("package:lint", KIND_CHECK)));
        assert!(kinds.contains(&("package:format:check", KIND_CHECK)));
        assert!(!kinds.iter().any(|(id, _)| *id == "package:lint:fix"));
        assert!(!kinds.iter().any(|(id, _)| *id == "package:format"));
        assert!(!kinds.iter().any(|(id, _)| *id == "package:prelint"));
        // A typecheck script exists, so the direct tsc fallback is not duplicated.
        assert!(!kinds.iter().any(|(id, _)| *id == "node:tsc"));
        assert!(kinds.contains(&("cargo:check", KIND_CHECK)));
        assert!(kinds.contains(&("cargo:clippy", KIND_CHECK)));
        assert!(kinds.contains(&("go:vet", KIND_CHECK)));
        assert!(kinds.contains(&("python:ruff", KIND_CHECK)));
        assert!(kinds.contains(&("python:mypy", KIND_CHECK)));
        // Tests sort before checks.
        let first_check = profiles.iter().position(|profile| profile.kind == KIND_CHECK).expect("a check profile exists");
        assert!(profiles[..first_check].iter().all(|profile| profile.kind == KIND_TEST));
        assert!(profiles[first_check..].iter().all(|profile| profile.kind == KIND_CHECK));
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
    }

    #[test]
    fn offers_direct_tsc_only_when_installed() {
        let workspace = TestWorkspace::new();
        fs::write(workspace.0.join("package.json"), r#"{"scripts":{"build":"vite build"}}"#)
            .expect("package.json should be written");
        fs::write(workspace.0.join("tsconfig.json"), "{}").expect("tsconfig should be written");
        let (profiles, warnings) = discover_profiles(&workspace.0).expect("profiles should load");
        assert!(profiles.iter().all(|profile| profile.id != "node:tsc"));
        assert!(warnings.iter().any(|warning| warning.contains("node_modules/typescript is not installed")));

        let bin = workspace.0.join("node_modules").join("typescript").join("bin");
        fs::create_dir_all(&bin).expect("typescript bin dir should be created");
        fs::write(bin.join("tsc"), "#!/usr/bin/env node\n").expect("tsc entry should be written");
        let (profiles, warnings) = discover_profiles(&workspace.0).expect("profiles should load");
        let tsc = profiles.iter().find(|profile| profile.id == "node:tsc").expect("tsc profile should exist");
        assert_eq!(tsc.command, "node node_modules/typescript/bin/tsc --noEmit --pretty false");
        assert_eq!(tsc.kind, KIND_CHECK);
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
    }

    #[test]
    fn rejects_renderer_supplied_command_shapes() {
        assert!(validate_profile_id("package:test").is_ok());
        assert!(validate_profile_id("cargo:test").is_ok());
        assert!(validate_profile_id("../../secret").is_err());
        assert!(validate_profile_id("package:test;rm-rf").is_err());
    }

    #[test]
    fn sanitizes_control_characters_in_test_output() {
        let rendered = display_text(b"ok\n\x1b[31mred\x07\n");
        assert!(rendered.contains("ok"));
        assert!(rendered.contains('�'));
    }
}
