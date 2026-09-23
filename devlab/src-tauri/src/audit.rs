use serde::Serialize;
use std::{
    collections::VecDeque,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

use crate::workspace::CommandError;

const MAX_AUDIT_EVENTS: usize = 200;
const MAX_AUDIT_LIST_LIMIT: usize = 100;
const MAX_WORKSPACE_NAME_CHARS: usize = 160;
const MAX_TARGET_CHARS: usize = 512;
const MAX_SUMMARY_CHARS: usize = 1_024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuditEvent {
    id: u64,
    timestamp_ms: u64,
    workspace_name: Option<String>,
    kind: &'static str,
    action: &'static str,
    target: String,
    outcome: &'static str,
    summary: String,
}

#[derive(Default)]
struct AgentAuditInner {
    next_id: u64,
    events: VecDeque<AgentAuditEvent>,
}

#[derive(Default)]
pub struct AgentAuditService {
    inner: Mutex<AgentAuditInner>,
}

impl AgentAuditService {
    pub(crate) fn record(
        &self,
        workspace_root: Option<&Path>,
        kind: &'static str,
        action: &'static str,
        target: impl Into<String>,
        outcome: &'static str,
        summary: impl Into<String>,
    ) -> u64 {
        let Ok(mut inner) = self.inner.lock() else {
            return 0;
        };
        inner.next_id = inner.next_id.saturating_add(1);
        let id = inner.next_id;
        let event = AgentAuditEvent {
            id,
            timestamp_ms: now_ms(),
            workspace_name: workspace_root.and_then(|root| {
                root.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| bounded(name, MAX_WORKSPACE_NAME_CHARS))
            }),
            kind,
            action,
            target: bounded(&target.into(), MAX_TARGET_CHARS),
            outcome,
            summary: bounded(&summary.into(), MAX_SUMMARY_CHARS),
        };
        inner.events.push_back(event);
        while inner.events.len() > MAX_AUDIT_EVENTS {
            inner.events.pop_front();
        }
        id
    }

    fn list(&self, limit: Option<usize>) -> Result<Vec<AgentAuditEvent>, CommandError> {
        let inner = self.inner.lock().map_err(|_| {
            CommandError::new("audit_state_unavailable", "Agent audit state is unavailable.")
        })?;
        let limit = limit.unwrap_or(50).clamp(1, MAX_AUDIT_LIST_LIMIT);
        Ok(inner.events.iter().rev().take(limit).cloned().collect())
    }
}

#[tauri::command]
pub fn agent_audit_list(
    limit: Option<usize>,
    service: State<'_, AgentAuditService>,
) -> Result<Vec<AgentAuditEvent>, CommandError> {
    service.list(limit)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn bounded(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut output = value.chars().take(max_chars.saturating_sub(1)).collect::<String>();
    output.push('…');
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_newest_bounded_events_first() {
        let service = AgentAuditService::default();
        for index in 0..(MAX_AUDIT_EVENTS + 5) {
            service.record(
                None,
                "test-run",
                "run",
                format!("profile-{index}"),
                "passed",
                "test summary",
            );
        }
        let events = service.list(Some(3)).expect("audit list should load");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].target, format!("profile-{}", MAX_AUDIT_EVENTS + 4));
        assert_eq!(events[2].target, format!("profile-{}", MAX_AUDIT_EVENTS + 2));
        assert_eq!(
            service.list(Some(MAX_AUDIT_EVENTS + 100)).expect("bounded list should load").len(),
            MAX_AUDIT_LIST_LIMIT,
        );
    }

    #[test]
    fn truncates_large_metadata() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 20);
        let service = AgentAuditService::default();
        service.record(None, "reviewed-draft", "apply", long.as_str(), "success", long.as_str());
        let event = service.list(Some(1)).expect("audit list should load").remove(0);
        assert_eq!(event.target.chars().count(), MAX_TARGET_CHARS);
        assert_eq!(event.summary.chars().count(), MAX_SUMMARY_CHARS);
        assert!(event.target.ends_with('…'));
        assert!(event.summary.ends_with('…'));
    }
}
