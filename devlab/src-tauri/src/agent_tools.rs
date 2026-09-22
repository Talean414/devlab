use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::{
    audit::AgentAuditService,
    workspace::{CommandError, WorkspaceService},
};

const MAX_DRAFT_FILES: usize = 12;
const MAX_DRAFT_PATH_BYTES: usize = 512;
const MAX_DRAFT_SUMMARY_BYTES: usize = 2 * 1024;
const MAX_TOTAL_DRAFT_BYTES: u64 = 512 * 1024;
const MAX_CONTEXT_FILES: usize = 4;
const MAX_TOTAL_CONTEXT_BYTES: u64 = 48 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDraftFileMetadata {
    path: String,
    bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextFileMetadata {
    path: String,
    bytes: u64,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDraftSession {
    id: u64,
    file_count: usize,
    total_bytes: u64,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentContextSession {
    id: u64,
    file_count: usize,
    total_bytes: u64,
    truncated_count: usize,
}

#[tauri::command]
pub fn agent_tools_record_draft(
    app: AppHandle,
    summary: String,
    files: Vec<AgentDraftFileMetadata>,
) -> Result<AgentDraftSession, CommandError> {
    let root = app.state::<WorkspaceService>().root_path()?;
    let summary = validate_summary(&summary)?;
    validate_files(&files)?;
    let total_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
    let target = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let audit = app.state::<AgentAuditService>();
    let id = audit.record(
        Some(&root),
        "multi-file-draft",
        "staged",
        target,
        "review",
        format!(
            "Agent staged {} reviewed draft file(s), {} bytes total. Summary: {}",
            files.len(), total_bytes, summary
        ),
    );
    Ok(AgentDraftSession {
        id,
        file_count: files.len(),
        total_bytes,
        summary,
    })
}

#[tauri::command]
pub fn agent_tools_record_context(
    app: AppHandle,
    files: Vec<AgentContextFileMetadata>,
) -> Result<AgentContextSession, CommandError> {
    let root = app.state::<WorkspaceService>().root_path()?;
    validate_context_files(&files)?;
    let total_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
    let truncated_count = files.iter().filter(|file| file.truncated).count();
    let target = files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let id = app.state::<AgentAuditService>().record(
        Some(&root),
        "agent-context",
        "attached",
        target,
        "read-only",
        format!(
            "Agent attached {} read-only context file(s), {} bytes total, {} truncated. File contents were not recorded.",
            files.len(), total_bytes, truncated_count,
        ),
    );
    Ok(AgentContextSession {
        id,
        file_count: files.len(),
        total_bytes,
        truncated_count,
    })
}

fn validate_summary(summary: &str) -> Result<String, CommandError> {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new(
            "agent_draft_summary_required",
            "A draft summary is required before staging agent-generated files.",
        ));
    }
    if trimmed.len() > MAX_DRAFT_SUMMARY_BYTES {
        return Err(CommandError::new(
            "agent_draft_summary_too_large",
            format!(
                "Agent draft summaries are limited to {} KiB.",
                MAX_DRAFT_SUMMARY_BYTES / 1024
            ),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_files(files: &[AgentDraftFileMetadata]) -> Result<(), CommandError> {
    if files.is_empty() {
        return Err(CommandError::new(
            "agent_draft_empty",
            "Generate at least one draft file before opening the editor review.",
        ));
    }
    if files.len() > MAX_DRAFT_FILES {
        return Err(CommandError::new(
            "agent_draft_file_limit",
            format!("Agent drafts can stage at most {MAX_DRAFT_FILES} files at once."),
        ));
    }
    let mut total = 0_u64;
    for file in files {
        validate_relative_path(&file.path)?;
        total = total.saturating_add(file.bytes);
        if total > MAX_TOTAL_DRAFT_BYTES {
            return Err(CommandError::new(
                "agent_draft_too_large",
                format!(
                    "Agent drafts can stage at most {} KiB of text at once.",
                    MAX_TOTAL_DRAFT_BYTES / 1024
                ),
            ));
        }
    }
    Ok(())
}

fn validate_context_files(files: &[AgentContextFileMetadata]) -> Result<(), CommandError> {
    if files.is_empty() {
        return Err(CommandError::new(
            "agent_context_empty",
            "Attach at least one workspace file before recording agent context.",
        ));
    }
    if files.len() > MAX_CONTEXT_FILES {
        return Err(CommandError::new(
            "agent_context_file_limit",
            format!("Agent context can include at most {MAX_CONTEXT_FILES} files at once."),
        ));
    }
    let mut total = 0_u64;
    for file in files {
        validate_relative_path(&file.path)?;
        total = total.saturating_add(file.bytes);
        if total > MAX_TOTAL_CONTEXT_BYTES {
            return Err(CommandError::new(
                "agent_context_too_large",
                format!(
                    "Agent context can include at most {} KiB of text at once.",
                    MAX_TOTAL_CONTEXT_BYTES / 1024
                ),
            ));
        }
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), CommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CommandError::new("invalid_path", "Draft file paths cannot be empty."));
    }
    if trimmed.len() > MAX_DRAFT_PATH_BYTES {
        return Err(CommandError::new(
            "path_too_large",
            "Draft file paths are too long.",
        ));
    }
    if trimmed.contains('\\')
        || trimmed.contains("//")
        || trimmed.ends_with('/')
        || trimmed.starts_with('/')
        || trimmed.starts_with('~')
    {
        return Err(CommandError::new(
            "invalid_path",
            "Draft file paths must be workspace-relative paths using forward slashes.",
        ));
    }
    if trimmed.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err(CommandError::new(
            "invalid_path",
            "Draft file paths cannot contain control characters.",
        ));
    }
    let path = Path::new(trimmed);
    if path
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(CommandError::new(
            "invalid_path",
            "Draft file paths cannot be absolute, empty, or contain parent traversal.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_draft_paths() {
        assert!(validate_relative_path("src/main.ts").is_ok());
        assert!(validate_relative_path("README.md").is_ok());
        assert!(validate_relative_path("../secret").is_err());
        assert!(validate_relative_path("/tmp/file").is_err());
        assert!(validate_relative_path("src\\main.ts").is_err());
        assert!(validate_relative_path("src//main.ts").is_err());
    }

    #[test]
    fn enforces_file_count_and_size_bounds() {
        let files = (0..=MAX_DRAFT_FILES)
            .map(|index| AgentDraftFileMetadata {
                path: format!("src/file-{index}.ts"),
                bytes: 1,
            })
            .collect::<Vec<_>>();
        assert!(validate_files(&files).is_err());
        assert!(validate_files(&[AgentDraftFileMetadata {
            path: "src/main.ts".to_string(),
            bytes: MAX_TOTAL_DRAFT_BYTES + 1,
        }])
        .is_err());
    }

    #[test]
    fn validates_summary_bounds() {
        assert_eq!(validate_summary(" demo ").expect("summary should trim"), "demo");
        assert!(validate_summary(" ").is_err());
        assert!(validate_summary(&"x".repeat(MAX_DRAFT_SUMMARY_BYTES + 1)).is_err());
    }

    #[test]
    fn enforces_agent_context_bounds() {
        let files = (0..=MAX_CONTEXT_FILES)
            .map(|index| AgentContextFileMetadata {
                path: format!("src/context-{index}.ts"),
                bytes: 1,
                truncated: false,
            })
            .collect::<Vec<_>>();
        assert!(validate_context_files(&files).is_err());
        assert!(validate_context_files(&[AgentContextFileMetadata {
            path: "src/main.ts".to_string(),
            bytes: MAX_TOTAL_CONTEXT_BYTES + 1,
            truncated: true,
        }])
        .is_err());
        assert!(validate_context_files(&[AgentContextFileMetadata {
            path: "../secret".to_string(),
            bytes: 1,
            truncated: false,
        }])
        .is_err());
    }
}
