//! Shared streaming plumbing for the native AI adapters (Phase 9F).
//!
//! Every adapter keeps its own validation, host policy, credential handling and error mapping;
//! this module only owns the pieces that are identical across them:
//! * [`StreamEvent`] — the bounded events delivered to the WebView through a Tauri `Channel`
//!   (text deltas and one final summary). Errors are returned through the command `Result`.
//! * [`StreamRegistry`] — cancellation flags keyed by a renderer-chosen stream id so the user can
//!   stop a reply; the reader drops the connection at the next line boundary.
//! * [`run_stream`] — drives `http::send_request_streaming` with a protocol parser (Ollama
//!   NDJSON, OpenAI-style SSE, Anthropic SSE), enforces the reply-character bound, and returns a
//!   [`StreamSummary`] or the buffered non-2xx body for the adapter's error mapping.

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::ipc::Channel;

use crate::http::{send_request_streaming, HttpRequest};
use crate::workspace::CommandError;

const MAX_ACTIVE_STREAMS: usize = 8;
const MAX_STREAM_ID_BYTES: usize = 64;
/// Deltas are coalesced so the IPC channel is not flooded by single-token events.
const DELTA_FLUSH_CHARS: usize = 24;
const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(40);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamProtocol {
    OllamaNdjson,
    OpenAiSse,
    AnthropicSse,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    Delta { text: String },
    Done { summary: StreamSummary },
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSummary {
    pub(crate) finish_reason: String,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) chars: usize,
    pub(crate) text_truncated: bool,
    pub(crate) cancelled: bool,
    pub(crate) lines: usize,
    pub(crate) elapsed_ms: u64,
}

/// Buffered non-2xx response, handed back to the adapter for its own status mapping.
pub(crate) struct StreamHttpError {
    pub(crate) status: u16,
    pub(crate) status_text: String,
    pub(crate) body: String,
    pub(crate) body_truncated: bool,
}

pub(crate) enum StreamResult {
    Completed(StreamSummary),
    HttpError(StreamHttpError),
}

#[derive(Default)]
pub struct StreamRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Registers a cancellation flag for `stream_id`. Ids are renderer-chosen opaque tokens. The
/// handle owns an `Arc` to the registry so it can live inside a blocking worker.
pub(crate) fn begin_stream(registry: &Arc<StreamRegistry>, stream_id: &str) -> Result<StreamHandle, CommandError> {
    validate_stream_id(stream_id)?;
    let mut flags = registry
        .flags
        .lock()
        .map_err(|_| CommandError::new("state_unavailable", "Stream registry is unavailable."))?;
    if flags.contains_key(stream_id) {
        return Err(CommandError::new("ai_stream_duplicate", "A stream with this id is already running."));
    }
    if flags.len() >= MAX_ACTIVE_STREAMS {
        return Err(CommandError::new(
            "ai_stream_limit",
            format!("At most {MAX_ACTIVE_STREAMS} replies can stream at once. Stop one before starting another."),
        ));
    }
    let flag = Arc::new(AtomicBool::new(false));
    flags.insert(stream_id.to_string(), flag.clone());
    drop(flags);
    Ok(StreamHandle { registry: registry.clone(), id: stream_id.to_string(), flag })
}

impl StreamRegistry {
    /// Requests cancellation. Unknown ids are not an error (the stream may have just finished).
    pub(crate) fn cancel(&self, stream_id: &str) -> Result<bool, CommandError> {
        validate_stream_id(stream_id)?;
        let flags = self
            .flags
            .lock()
            .map_err(|_| CommandError::new("state_unavailable", "Stream registry is unavailable."))?;
        Ok(match flags.get(stream_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        })
    }

    fn finish(&self, stream_id: &str) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(stream_id);
        }
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        self.flags.lock().map(|flags| flags.len()).unwrap_or(0)
    }
}

/// RAII registration: dropping the handle (normal return, error or panic unwinding) removes the
/// flag so ids can be reused and the concurrency cap never leaks.
pub(crate) struct StreamHandle {
    registry: Arc<StreamRegistry>,
    id: String,
    flag: Arc<AtomicBool>,
}

impl StreamHandle {
    pub(crate) fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }
}

impl Drop for StreamHandle {
    fn drop(&mut self) {
        self.registry.finish(&self.id);
    }
}

pub(crate) fn validate_stream_id(stream_id: &str) -> Result<(), CommandError> {
    if stream_id.is_empty() || stream_id.len() > MAX_STREAM_ID_BYTES {
        return Err(CommandError::new("ai_stream_id_invalid", "Stream ids must be 1–64 characters."));
    }
    if !stream_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err(CommandError::new(
            "ai_stream_id_invalid",
            "Stream ids may contain only letters, digits, '-' and '_'.",
        ));
    }
    Ok(())
}

/// One parsed line of a streaming body.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ParsedLine {
    pub(crate) text: Option<String>,
    pub(crate) finish_reason: Option<String>,
    pub(crate) input_tokens: Option<u64>,
    pub(crate) output_tokens: Option<u64>,
    pub(crate) done: bool,
}

fn json_line(line: &str) -> Option<Value> {
    serde_json::from_str::<Value>(line).ok()
}

/// Parses a single body line for the given protocol. Unknown or non-data lines yield an empty
/// [`ParsedLine`]; malformed JSON is ignored rather than aborting the stream (the final summary
/// still reflects what was delivered).
pub(crate) fn parse_line(protocol: StreamProtocol, line: &str) -> ParsedLine {
    let mut parsed = ParsedLine::default();
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with(':') {
        return parsed;
    }
    match protocol {
        StreamProtocol::OllamaNdjson => {
            let Some(value) = json_line(trimmed) else { return parsed };
            if let Some(text) = value.get("message").and_then(|m| m.get("content")).and_then(Value::as_str) {
                if !text.is_empty() {
                    parsed.text = Some(text.to_string());
                }
            }
            if value.get("done").and_then(Value::as_bool) == Some(true) {
                parsed.done = true;
                parsed.finish_reason = value.get("done_reason").and_then(Value::as_str).map(str::to_string);
                parsed.input_tokens = value.get("prompt_eval_count").and_then(Value::as_u64);
                parsed.output_tokens = value.get("eval_count").and_then(Value::as_u64);
            }
        }
        StreamProtocol::OpenAiSse => {
            let Some(data) = trimmed.strip_prefix("data:") else { return parsed };
            let data = data.trim();
            if data == "[DONE]" {
                parsed.done = true;
                return parsed;
            }
            let Some(value) = json_line(data) else { return parsed };
            if let Some(choice) = value.get("choices").and_then(Value::as_array).and_then(|c| c.first()) {
                let delta = choice.get("delta");
                let text = delta.and_then(|d| d.get("content"));
                match text {
                    Some(Value::String(text)) if !text.is_empty() => parsed.text = Some(text.clone()),
                    Some(Value::Array(parts)) => {
                        let joined = parts
                            .iter()
                            .filter_map(|part| part.get("text").and_then(Value::as_str))
                            .collect::<String>();
                        if !joined.is_empty() {
                            parsed.text = Some(joined);
                        }
                    }
                    _ => {}
                }
                if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                    parsed.finish_reason = Some(reason.to_string());
                }
            }
            if let Some(usage) = value.get("usage").filter(|u| !u.is_null()) {
                parsed.input_tokens = usage.get("prompt_tokens").and_then(Value::as_u64);
                parsed.output_tokens = usage.get("completion_tokens").and_then(Value::as_u64);
            }
        }
        StreamProtocol::AnthropicSse => {
            let Some(data) = trimmed.strip_prefix("data:") else { return parsed };
            let Some(value) = json_line(data.trim()) else { return parsed };
            match value.get("type").and_then(Value::as_str).unwrap_or_default() {
                "message_start" => {
                    parsed.input_tokens = value
                        .get("message")
                        .and_then(|m| m.get("usage"))
                        .and_then(|u| u.get("input_tokens"))
                        .and_then(Value::as_u64);
                }
                "content_block_delta" => {
                    let delta = value.get("delta");
                    if delta.and_then(|d| d.get("type")).and_then(Value::as_str) == Some("text_delta") {
                        if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                            if !text.is_empty() {
                                parsed.text = Some(text.to_string());
                            }
                        }
                    }
                }
                "message_delta" => {
                    parsed.finish_reason = value
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    parsed.output_tokens = value.get("usage").and_then(|u| u.get("output_tokens")).and_then(Value::as_u64);
                }
                "message_stop" => parsed.done = true,
                "error" => {
                    let message = value
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("stream error")
                        .chars()
                        .take(400)
                        .collect::<String>();
                    parsed.finish_reason = Some(format!("error: {message}"));
                    parsed.done = true;
                }
                _ => {}
            }
        }
    }
    parsed
}

/// Coalesces deltas and forwards them through the channel. Character accounting is done here so
/// every adapter shares the same reply bound.
struct DeltaSink<'a> {
    channel: &'a Channel<StreamEvent>,
    pending: String,
    last_flush: Instant,
    chars: usize,
    max_chars: usize,
    truncated: bool,
    send_failed: bool,
}

impl DeltaSink<'_> {
    fn push(&mut self, text: &str) -> bool {
        let remaining = self.max_chars.saturating_sub(self.chars);
        let count = text.chars().count();
        if count > remaining {
            self.pending.extend(text.chars().take(remaining));
            self.chars += remaining;
            self.truncated = true;
            self.flush();
            return false;
        }
        self.pending.push_str(text);
        self.chars += count;
        if self.pending.chars().count() >= DELTA_FLUSH_CHARS || self.last_flush.elapsed() >= DELTA_FLUSH_INTERVAL {
            self.flush();
        }
        !self.send_failed
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.pending);
        if self.channel.send(StreamEvent::Delta { text }).is_err() {
            self.send_failed = true;
        }
        self.last_flush = Instant::now();
    }
}

/// Runs a streaming request end to end. `max_chars` bounds the delivered reply; `cancel` is
/// polled at every line. The adapter maps `StreamResult::HttpError` with its own status mapping
/// and turns the returned `StreamSummary` into its response type.
pub(crate) fn run_stream(
    request: HttpRequest,
    timeout: Duration,
    protocol: StreamProtocol,
    max_chars: usize,
    cancel: Arc<AtomicBool>,
    channel: &Channel<StreamEvent>,
) -> Result<StreamResult, CommandError> {
    let started = Instant::now();
    let mut sink = DeltaSink {
        channel,
        pending: String::new(),
        last_flush: Instant::now(),
        chars: 0,
        max_chars,
        truncated: false,
        send_failed: false,
    };
    let mut summary = StreamSummary::default();
    let mut cancelled = false;

    let outcome = send_request_streaming(request, timeout, |line| {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            return false;
        }
        let parsed = parse_line(protocol, line);
        if let Some(reason) = parsed.finish_reason {
            summary.finish_reason = reason;
        }
        if let Some(tokens) = parsed.input_tokens {
            summary.input_tokens = tokens;
        }
        if let Some(tokens) = parsed.output_tokens {
            summary.output_tokens = tokens;
        }
        if let Some(text) = parsed.text {
            if !sink.push(&text) {
                return false;
            }
        }
        !parsed.done
    })?;

    if !(200..300).contains(&outcome.status) {
        return Ok(StreamResult::HttpError(StreamHttpError {
            status: outcome.status,
            status_text: outcome.status_text,
            body: outcome.error_body,
            body_truncated: outcome.error_body_truncated,
        }));
    }
    sink.flush();
    if sink.send_failed {
        return Err(CommandError::new(
            "ai_stream_channel_closed",
            "The interface stopped listening to this reply before it finished.",
        ));
    }
    summary.chars = sink.chars;
    summary.text_truncated = sink.truncated || outcome.truncated;
    summary.cancelled = cancelled;
    summary.lines = outcome.lines_delivered;
    summary.elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    if summary.finish_reason.is_empty() {
        summary.finish_reason = if cancelled {
            "cancelled".to_string()
        } else if summary.text_truncated {
            "length".to_string()
        } else {
            "stop".to_string()
        };
    }
    summary.finish_reason = summary.finish_reason.chars().take(48).collect();
    let _ = channel.send(StreamEvent::Done { summary: summary.clone() });
    Ok(StreamResult::Completed(summary))
}

/// Response of every `*_chat_stream` command: the text itself arrived through the channel.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamedReply {
    pub(crate) target: String,
    pub(crate) model: String,
    pub(crate) summary: StreamSummary,
}

#[tauri::command]
pub fn ai_stream_cancel(stream_id: String, registry: tauri::State<'_, Arc<StreamRegistry>>) -> Result<bool, CommandError> {
    registry.cancel(&stream_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_enforces_ids_uniqueness_and_limits() {
        let registry = Arc::new(StreamRegistry::default());
        assert_eq!(validate_stream_id("").unwrap_err().code, "ai_stream_id_invalid");
        assert_eq!(validate_stream_id("bad id").unwrap_err().code, "ai_stream_id_invalid");
        assert_eq!(validate_stream_id(&"x".repeat(65)).unwrap_err().code, "ai_stream_id_invalid");
        {
            let handle = begin_stream(&registry, "s-1").unwrap();
            assert_eq!(begin_stream(&registry, "s-1").unwrap_err().code, "ai_stream_duplicate");
            assert!(!handle.flag().load(Ordering::SeqCst));
            assert!(registry.cancel("s-1").unwrap());
            assert!(handle.flag().load(Ordering::SeqCst));
            assert_eq!(registry.active(), 1);
        }
        assert_eq!(registry.active(), 0, "drop removes the registration");
        assert!(!registry.cancel("s-1").unwrap(), "unknown ids are not errors");
        let handles = (0..MAX_ACTIVE_STREAMS).map(|i| begin_stream(&registry, &format!("s{i}")).unwrap()).collect::<Vec<_>>();
        assert_eq!(begin_stream(&registry, "overflow").unwrap_err().code, "ai_stream_limit");
        drop(handles);
        assert_eq!(registry.active(), 0);
    }

    #[test]
    fn parses_ollama_ndjson_lines() {
        let delta = parse_line(StreamProtocol::OllamaNdjson, r#"{"message":{"role":"assistant","content":"Hel"},"done":false}"#);
        assert_eq!(delta.text.as_deref(), Some("Hel"));
        assert!(!delta.done);
        let done = parse_line(
            StreamProtocol::OllamaNdjson,
            r#"{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":7}"#,
        );
        assert!(done.done && done.text.is_none());
        assert_eq!(done.finish_reason.as_deref(), Some("stop"));
        assert_eq!((done.input_tokens, done.output_tokens), (Some(12), Some(7)));
        assert_eq!(parse_line(StreamProtocol::OllamaNdjson, "not json"), ParsedLine::default());
    }

    #[test]
    fn parses_openai_sse_lines() {
        let delta = parse_line(StreamProtocol::OpenAiSse, r#"data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}"#);
        assert_eq!(delta.text.as_deref(), Some("Hi"));
        assert!(!delta.done && delta.finish_reason.is_none());
        let finish = parse_line(StreamProtocol::OpenAiSse, r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9}}"#);
        assert_eq!(finish.finish_reason.as_deref(), Some("stop"));
        assert_eq!((finish.input_tokens, finish.output_tokens), (Some(5), Some(9)));
        assert!(parse_line(StreamProtocol::OpenAiSse, "data: [DONE]").done);
        assert_eq!(parse_line(StreamProtocol::OpenAiSse, ": keep-alive"), ParsedLine::default());
        assert_eq!(parse_line(StreamProtocol::OpenAiSse, "event: ping"), ParsedLine::default());
        let parts = parse_line(StreamProtocol::OpenAiSse, r#"data: {"choices":[{"delta":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}]}"#);
        assert_eq!(parts.text.as_deref(), Some("ab"));
    }

    #[test]
    fn parses_anthropic_sse_lines() {
        let start = parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"message_start","message":{"usage":{"input_tokens":21}}}"#);
        assert_eq!(start.input_tokens, Some(21));
        let delta = parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hey"}}"#);
        assert_eq!(delta.text.as_deref(), Some("Hey"));
        let thinking = parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}"#);
        assert!(thinking.text.is_none());
        let end = parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":33}}"#);
        assert_eq!(end.finish_reason.as_deref(), Some("end_turn"));
        assert_eq!(end.output_tokens, Some(33));
        assert!(parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"message_stop"}"#).done);
        let error = parse_line(StreamProtocol::AnthropicSse, r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#);
        assert!(error.done);
        assert_eq!(error.finish_reason.as_deref(), Some("error: Overloaded"));
        assert_eq!(parse_line(StreamProtocol::AnthropicSse, "event: content_block_delta"), ParsedLine::default());
    }
}
