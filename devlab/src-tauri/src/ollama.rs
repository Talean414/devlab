//! Native, loopback-only Ollama adapter (Phase 9A).
//!
//! Ollama serves a plain HTTP API on the developer's own machine. DevLab talks to it from Rust
//! through the existing bounded HTTP/1.1 client in `http.rs`, so the WebView never calls
//! `localhost` and the request never leaves the loopback interface:
//!
//! * The endpoint must be `http://` with a host that is literally loopback (`localhost`,
//!   `127.0.0.0/8`, `::1`). Anything else is refused before a socket is opened, and hostnames
//!   are never resolved to decide this.
//! * Only fixed API paths are used: `GET /api/tags` (installed models), `POST /api/chat`
//!   (completions), `POST /api/embed` (Phase 9D embeddings) and, for the Phase 9P health check,
//!   `GET /api/version`, `GET /api/ps` (loaded models) and `POST /api/show` (per-model metadata
//!   such as the context window). Callers cannot choose the path.
//! * Prompts, message counts, response bodies and timeouts are bounded here in addition to the
//!   general HTTP limits. Generation runs with a longer timeout than the API client allows,
//!   because local models on CPUs are slow, but it is still finite.
//! * No credentials exist for this provider and nothing is persisted by this module.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

use std::sync::Arc;
use tauri::ipc::Channel;

use crate::ai_stream::{begin_stream, run_stream, StreamEvent, StreamProtocol, StreamRegistry, StreamResult, StreamedReply};
use crate::http::{
    blocking, parse_url, send_request, send_request_with_timeout, HttpHeader, HttpRequest, ParsedUrl,
};
use crate::workspace::CommandError;

const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";
const MAX_ENDPOINT_BYTES: usize = 256;
const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_MESSAGES: usize = 64;
const MAX_MESSAGE_CHARS: usize = 64 * 1024;
const MAX_PROMPT_CHARS: usize = 192 * 1024;
const MAX_SYSTEM_CHARS: usize = 16 * 1024;
const MAX_MODELS_LISTED: usize = 64;
const MAX_REPLY_CHARS: usize = 256 * 1024;
const MIN_PREDICT_TOKENS: u64 = 64;
const MAX_PREDICT_TOKENS: u64 = 8192;
// The tag listing is quick; generation on a CPU-bound local model is not, so it gets a longer
// (still finite) bound than the API client's 30 s ceiling, via the in-crate timeout entry point.
const LIST_TIMEOUT_SECS: u64 = 10;
const GENERATE_TIMEOUT_SECS: u64 = 120;
const EMBED_TIMEOUT_SECS: u64 = 120;
pub(crate) const MAX_EMBED_BATCH: usize = 16;
pub(crate) const MAX_EMBED_INPUT_CHARS: usize = 4 * 1024;
const MIN_EMBED_DIMS: usize = 16;
const MAX_EMBED_DIMS: usize = 8192;
// Phase 9P health check: metadata reads only (`/api/version`, `/api/ps`, `/api/show`); no model
// is loaded, pulled or prompted. Each probe and the whole check are bounded separately.
const HEALTH_PROBE_TIMEOUT_SECS: u64 = 15;
const HEALTH_DEADLINE_SECS: u64 = 45;
const MAX_HEALTH_MODELS: usize = 12;
const MAX_HEALTH_CAPABILITIES: usize = 8;
const MAX_HEALTH_TEXT_CHARS: usize = 96;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OllamaListRequest {
    #[serde(default)]
    endpoint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelInfo {
    name: String,
    size_bytes: u64,
    family: String,
    parameter_size: String,
    quantization: String,
    modified_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaListResponse {
    endpoint: String,
    models: Vec<OllamaModelInfo>,
    truncated: bool,
    elapsed_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OllamaHealthRequest {
    #[serde(default)]
    endpoint: String,
    /// Optional model ids to probe; empty means every installed model (up to the cap).
    #[serde(default)]
    models: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModelHealth {
    name: String,
    installed: bool,
    family: String,
    parameter_size: String,
    quantization: String,
    format: String,
    architecture: String,
    parameter_count: u64,
    /// Maximum context window the model was trained for (`<arch>.context_length`), when reported.
    context_length: Option<u64>,
    /// `num_ctx` from the model's Modelfile parameters, when the model sets one.
    configured_context: Option<u64>,
    embedding_length: Option<u64>,
    capabilities: Vec<String>,
    size_bytes: u64,
    loaded: bool,
    size_vram: u64,
    expires_at: String,
    /// Context length the running instance was loaded with (`/api/ps`), when reported.
    loaded_context: Option<u64>,
    probe_ms: u64,
    /// Per-model probe failure; the rest of the check still completes.
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaHealthResponse {
    endpoint: String,
    server_version: String,
    installed: usize,
    loaded: usize,
    /// False when `/api/ps` could not be read, so `loaded` fields are unknown rather than false.
    loaded_known: bool,
    models: Vec<OllamaModelHealth>,
    probed: usize,
    skipped: usize,
    truncated: bool,
    truncation_reason: Option<&'static str>,
    elapsed_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OllamaChatRequest {
    #[serde(default)]
    endpoint: String,
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<OllamaMessage>,
    temperature: Option<f64>,
    max_output_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaChatResponse {
    endpoint: String,
    model: String,
    text: String,
    text_truncated: bool,
    done_reason: String,
    prompt_eval_count: u64,
    eval_count: u64,
    total_duration_ms: u64,
    elapsed_ms: u64,
}

/// Accepts only `http://` endpoints whose host is literally a loopback address. Returns the
/// parsed URL (with any path stripped) and the normalized origin string reported back to React.
pub(crate) fn validate_loopback_endpoint(raw: &str) -> Result<(ParsedUrl, String), CommandError> {
    let trimmed = raw.trim();
    let candidate = if trimmed.is_empty() { DEFAULT_ENDPOINT } else { trimmed };
    if candidate.len() > MAX_ENDPOINT_BYTES {
        return Err(CommandError::new(
            "ollama_endpoint_invalid",
            format!("Ollama endpoints are limited to {MAX_ENDPOINT_BYTES} bytes."),
        ));
    }
    let mut url = parse_url(candidate).map_err(|error| {
        CommandError::new(
            "ollama_endpoint_invalid",
            format!("The Ollama endpoint is not a valid URL: {}", error.message),
        )
    })?;
    if url.scheme != "http" {
        return Err(CommandError::new(
            "ollama_endpoint_not_loopback",
            "Ollama endpoints must use plain http:// on this machine; TLS and remote hosts are not supported by the local adapter.",
        ));
    }
    if !is_loopback_host(&url.host) {
        return Err(CommandError::new(
            "ollama_endpoint_not_loopback",
            format!(
                "The Ollama adapter only talks to this machine. `{}` is not a loopback address; use http://127.0.0.1:11434 or http://localhost:11434.",
                url.host
            ),
        ));
    }
    if url.path != "/" {
        return Err(CommandError::new(
            "ollama_endpoint_invalid",
            "Enter only the Ollama origin (scheme, host and port). DevLab appends the fixed API paths itself.",
        ));
    }
    url.path.clear();
    let origin = format!("http://{}", url.host_header);
    Ok((url, origin))
}

/// Literal loopback check. Hostnames other than `localhost` are rejected rather than resolved,
/// so DNS can never turn a "local" endpoint into a remote one.
pub(crate) fn is_loopback_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host == "localhost" {
        return true;
    }
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        return v4.is_loopback();
    }
    if let Ok(v6) = host.parse::<std::net::Ipv6Addr>() {
        return v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback());
    }
    false
}

fn validate_model(model: &str) -> Result<String, CommandError> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_ID_BYTES {
        return Err(CommandError::new(
            "ollama_model_invalid",
            format!("Choose an installed Ollama model id between 1 and {MAX_MODEL_ID_BYTES} bytes."),
        ));
    }
    let valid = model
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':' | b'/'));
    if !valid {
        return Err(CommandError::new(
            "ollama_model_invalid",
            "Ollama model ids may contain only letters, digits, '.', '-', '_', ':' and '/'.",
        ));
    }
    Ok(model.to_string())
}

fn validate_messages(messages: &[OllamaMessage]) -> Result<Vec<Value>, CommandError> {
    if messages.is_empty() {
        return Err(CommandError::new("ollama_prompt_empty", "Provide at least one message."));
    }
    if messages.len() > MAX_MESSAGES {
        return Err(CommandError::new(
            "ollama_prompt_too_large",
            format!("Ollama requests may include at most {MAX_MESSAGES} messages."),
        ));
    }
    let mut total_chars = 0_usize;
    let mut output = Vec::with_capacity(messages.len());
    for message in messages {
        let role = match message.role.as_str() {
            "user" => "user",
            "model" | "assistant" => "assistant",
            _ => {
                return Err(CommandError::new(
                    "ollama_prompt_invalid",
                    "Message roles must be `user` or `model`.",
                ))
            }
        };
        let chars = message.content.chars().count();
        if chars == 0 {
            return Err(CommandError::new("ollama_prompt_invalid", "Messages cannot be empty."));
        }
        if chars > MAX_MESSAGE_CHARS {
            return Err(CommandError::new(
                "ollama_prompt_too_large",
                format!("A single message is limited to {} KiB of text.", MAX_MESSAGE_CHARS / 1024),
            ));
        }
        total_chars += chars;
        output.push(json!({ "role": role, "content": message.content }));
    }
    if total_chars > MAX_PROMPT_CHARS {
        return Err(CommandError::new(
            "ollama_prompt_too_large",
            format!("The combined prompt is limited to {} KiB of text.", MAX_PROMPT_CHARS / 1024),
        ));
    }
    Ok(output)
}

fn validate_system(system: &str) -> Result<Option<String>, CommandError> {
    let trimmed = system.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_SYSTEM_CHARS {
        return Err(CommandError::new(
            "ollama_prompt_too_large",
            format!("The system instruction is limited to {} KiB.", MAX_SYSTEM_CHARS / 1024),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn clamp_temperature(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(0.0, 2.0),
        _ => 0.7,
    }
}

fn clamp_predict(value: Option<u64>) -> u64 {
    value.unwrap_or(2048).clamp(MIN_PREDICT_TOKENS, MAX_PREDICT_TOKENS)
}

fn json_header() -> HttpHeader {
    HttpHeader {
        name: "Content-Type".to_string(),
        value: "application/json".to_string(),
    }
}

fn api_url(origin: &str, path: &str) -> String {
    format!("{origin}{path}")
}

fn transport_error(origin: &str, timeout_secs: u64, error: CommandError) -> CommandError {
    match error.code {
        "http_connection_failed" | "http_dns_failed" => CommandError::new(
            "ollama_unreachable",
            format!(
                "Could not reach Ollama at {origin}. Start it with `ollama serve` (or the desktop app) and confirm the port. Underlying error: {}",
                error.message
            ),
        ),
        "http_timeout" => CommandError::new(
            "ollama_timeout",
            format!(
                "Ollama at {origin} did not answer within DevLab's {timeout_secs} s bound. Smaller models or shorter prompts finish sooner. Underlying error: {}",
                error.message
            ),
        ),
        _ => error,
    }
}

fn parse_json_body(body: &str, truncated: bool, what: &str) -> Result<Value, CommandError> {
    if truncated {
        return Err(CommandError::new(
            "ollama_response_too_large",
            format!("The Ollama {what} response exceeded DevLab's response bound and was not parsed."),
        ));
    }
    serde_json::from_str::<Value>(body).map_err(|error| {
        CommandError::new(
            "ollama_protocol_error",
            format!("Ollama returned a {what} response that is not valid JSON: {error}"),
        )
    })
}

fn http_status_error(status: u16, status_text: &str, body: &Value) -> CommandError {
    let detail = body
        .get("error")
        .and_then(Value::as_str)
        .map(|text| text.chars().take(400).collect::<String>())
        .unwrap_or_default();
    let code = if status == 404 { "ollama_model_not_found" } else { "ollama_http_error" };
    CommandError::new(
        code,
        if detail.is_empty() {
            format!("Ollama responded with HTTP {status} {status_text}.")
        } else {
            format!("Ollama responded with HTTP {status} {status_text}: {detail}")
        },
    )
}

fn list_models(request: OllamaListRequest) -> Result<OllamaListResponse, CommandError> {
    let started = Instant::now();
    let (_, origin) = validate_loopback_endpoint(&request.endpoint)?;
    let response = send_request(HttpRequest {
        method: "GET".to_string(),
        url: api_url(&origin, "/api/tags"),
        headers: Vec::new(),
        body: String::new(),
        timeout_secs: Some(LIST_TIMEOUT_SECS),
    })
    .map_err(|error| transport_error(&origin, LIST_TIMEOUT_SECS, error))?;
    let body = parse_json_body(&response.body, response.body_truncated, "model list")?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(response.status, &response.status_text, &body));
    }
    let raw_models = body
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let truncated = raw_models.len() > MAX_MODELS_LISTED;
    let models = raw_models
        .iter()
        .take(MAX_MODELS_LISTED)
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?.to_string();
            let details = entry.get("details").cloned().unwrap_or(Value::Null);
            let text = |value: &Value, key: &str| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .chars()
                    .take(96)
                    .collect::<String>()
            };
            Some(OllamaModelInfo {
                size_bytes: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                family: text(&details, "family"),
                parameter_size: text(&details, "parameter_size"),
                quantization: text(&details, "quantization_level"),
                modified_at: text(entry, "modified_at"),
                name,
            })
        })
        .collect();
    Ok(OllamaListResponse {
        endpoint: origin,
        models,
        truncated,
        elapsed_ms: elapsed_ms(started),
    })
}

/// Ollama treats an untagged model id as the `latest` tag.
fn canonical_model(name: &str) -> String {
    if name.contains(':') {
        name.to_string()
    } else {
        format!("{name}:latest")
    }
}

fn bounded_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(MAX_HEALTH_TEXT_CHARS)
        .collect()
}

fn as_count(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|number| number.is_finite() && *number >= 0.0).map(|number| number as u64))
}

/// Indexes `/api/ps` entries by both their `name` and `model` fields (with and without a tag).
fn index_running(body: &Value) -> std::collections::HashMap<String, Value> {
    let mut running = std::collections::HashMap::new();
    for entry in body.get("models").and_then(Value::as_array).into_iter().flatten() {
        for key in ["name", "model"] {
            if let Some(name) = entry.get(key).and_then(Value::as_str) {
                running.insert(canonical_model(name), entry.clone());
            }
        }
    }
    running
}

/// Copies the metadata DevLab cares about from a `/api/show` body onto a health entry.
fn apply_show_details(entry: &mut OllamaModelHealth, body: &Value) {
    let details = body.get("details").cloned().unwrap_or(Value::Null);
    for (field, key) in [
        (&mut entry.family, "family"),
        (&mut entry.parameter_size, "parameter_size"),
        (&mut entry.quantization, "quantization_level"),
        (&mut entry.format, "format"),
    ] {
        let value = bounded_text(&details, key);
        if !value.is_empty() {
            *field = value;
        }
    }
    let info = body.get("model_info").cloned().unwrap_or(Value::Null);
    entry.architecture = bounded_text(&info, "general.architecture");
    entry.parameter_count = as_count(info.get("general.parameter_count")).unwrap_or(0);
    let architecture = entry.architecture.clone();
    let lookup = |suffix: &str| -> Option<u64> {
        if !architecture.is_empty() {
            let exact = format!("{architecture}.{suffix}");
            if let Some(found) = as_count(info.get(exact.as_str())) {
                return Some(found);
            }
        }
        let dotted = format!(".{suffix}");
        info.as_object()?
            .iter()
            .filter(|(key, _)| key.ends_with(dotted.as_str()))
            .find_map(|(_, value)| as_count(Some(value)))
    };
    entry.context_length = lookup("context_length");
    entry.embedding_length = lookup("embedding_length");
    entry.capabilities = body
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.chars().take(32).collect::<String>())
                .take(MAX_HEALTH_CAPABILITIES)
                .collect()
        })
        .unwrap_or_default();
    entry.configured_context = body
        .get("parameters")
        .and_then(Value::as_str)
        .and_then(|parameters| {
            parameters.lines().find_map(|line| {
                let mut parts = line.split_whitespace();
                match (parts.next(), parts.next()) {
                    (Some("num_ctx"), Some(value)) => value.parse::<u64>().ok(),
                    _ => None,
                }
            })
        });
}

fn apply_running_details(entry: &mut OllamaModelHealth, running: &Value) {
    entry.loaded = true;
    entry.size_vram = as_count(running.get("size_vram")).unwrap_or(0);
    entry.expires_at = bounded_text(running, "expires_at");
    entry.loaded_context = as_count(running.get("context_length"));
}

fn show_model(origin: &str, name: &str) -> Result<Value, CommandError> {
    let response = send_request(HttpRequest {
        method: "POST".to_string(),
        url: api_url(origin, "/api/show"),
        headers: vec![json_header()],
        body: json!({ "model": name }).to_string(),
        timeout_secs: Some(HEALTH_PROBE_TIMEOUT_SECS),
    })
    .map_err(|error| transport_error(origin, HEALTH_PROBE_TIMEOUT_SECS, error))?;
    let body = parse_json_body(&response.body, response.body_truncated, "model details")?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(response.status, &response.status_text, &body));
    }
    Ok(body)
}

fn get_json(origin: &str, path: &str, what: &str) -> Result<Value, CommandError> {
    let response = send_request(HttpRequest {
        method: "GET".to_string(),
        url: api_url(origin, path),
        headers: Vec::new(),
        body: String::new(),
        timeout_secs: Some(LIST_TIMEOUT_SECS),
    })
    .map_err(|error| transport_error(origin, LIST_TIMEOUT_SECS, error))?;
    let body = parse_json_body(&response.body, response.body_truncated, what)?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(response.status, &response.status_text, &body));
    }
    Ok(body)
}

/// Read-only health check: server version, installed models, which of them are loaded (and with
/// what VRAM/context) and each model's context window and capabilities. No model is loaded,
/// pulled or prompted, and every request is bounded.
fn model_health(request: OllamaHealthRequest) -> Result<OllamaHealthResponse, CommandError> {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(HEALTH_DEADLINE_SECS);
    let (_, origin) = validate_loopback_endpoint(&request.endpoint)?;
    let requested = request
        .models
        .iter()
        .map(|model| validate_model(model).map(|valid| canonical_model(&valid)))
        .collect::<Result<Vec<_>, _>>()?;

    // Best effort: older servers may lack `/api/version`; the tag listing below is the real
    // reachability check and its failure is the whole check's failure.
    let server_version = get_json(&origin, "/api/version", "version")
        .ok()
        .map(|body| bounded_text(&body, "version"))
        .unwrap_or_default();
    let installed = list_models(OllamaListRequest { endpoint: request.endpoint.clone() })?;
    let (running, loaded_known) = match get_json(&origin, "/api/ps", "running models") {
        Ok(body) => (index_running(&body), true),
        Err(_) => (std::collections::HashMap::new(), false),
    };

    let mut targets: Vec<OllamaModelHealth> = installed
        .models
        .iter()
        .filter(|model| requested.is_empty() || requested.iter().any(|name| *name == canonical_model(&model.name)))
        .map(|model| OllamaModelHealth {
            name: model.name.clone(),
            installed: true,
            family: model.family.clone(),
            parameter_size: model.parameter_size.clone(),
            quantization: model.quantization.clone(),
            size_bytes: model.size_bytes,
            ..OllamaModelHealth::default()
        })
        .collect();
    for name in &requested {
        if !targets.iter().any(|entry| canonical_model(&entry.name) == *name) {
            targets.push(OllamaModelHealth {
                name: name.clone(),
                installed: false,
                error: Some("Not installed on this Ollama server; pull it first or pick a detected model.".to_string()),
                ..OllamaModelHealth::default()
            });
        }
    }

    let mut models = Vec::with_capacity(targets.len().min(MAX_HEALTH_MODELS));
    let mut probed = 0usize;
    let mut truncated = false;
    let mut truncation_reason = None;
    let total_targets = targets.len();
    for (index, mut entry) in targets.into_iter().enumerate() {
        if index >= MAX_HEALTH_MODELS {
            truncated = true;
            truncation_reason = Some("max_models");
            break;
        }
        if Instant::now() >= deadline {
            truncated = true;
            truncation_reason = Some("deadline");
            break;
        }
        let probe_started = Instant::now();
        if let Some(running_entry) = running.get(&canonical_model(&entry.name)) {
            apply_running_details(&mut entry, running_entry);
        }
        if entry.installed {
            match show_model(&origin, &entry.name) {
                Ok(body) => apply_show_details(&mut entry, &body),
                Err(error) => entry.error = Some(error.message.chars().take(400).collect()),
            }
            probed += 1;
        }
        entry.probe_ms = elapsed_ms(probe_started);
        models.push(entry);
    }
    let loaded = models.iter().filter(|entry| entry.loaded).count();
    Ok(OllamaHealthResponse {
        endpoint: origin,
        server_version,
        installed: installed.models.len(),
        loaded,
        loaded_known,
        skipped: total_targets.saturating_sub(models.len()),
        models,
        probed,
        truncated: truncated || installed.truncated,
        truncation_reason: truncation_reason.or(if installed.truncated { Some("max_models") } else { None }),
        elapsed_ms: elapsed_ms(started),
    })
}

/// Validates a chat request and builds the `/api/chat` HTTP request (streamed or not).
fn prepare_chat(request: &OllamaChatRequest, stream: bool) -> Result<(String, String, HttpRequest), CommandError> {
    let (_, origin) = validate_loopback_endpoint(&request.endpoint)?;
    let model = validate_model(&request.model)?;
    let mut messages = Vec::new();
    if let Some(system) = validate_system(&request.system)? {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.extend(validate_messages(&request.messages)?);
    let payload = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "options": {
            "temperature": clamp_temperature(request.temperature),
            "num_predict": clamp_predict(request.max_output_tokens),
        },
    });
    let http = HttpRequest {
        method: "POST".to_string(),
        url: api_url(&origin, "/api/chat"),
        headers: vec![json_header()],
        body: payload.to_string(),
        timeout_secs: None,
    };
    Ok((origin, model, http))
}

fn chat(request: OllamaChatRequest) -> Result<OllamaChatResponse, CommandError> {
    let started = Instant::now();
    let (origin, model, http) = prepare_chat(&request, false)?;
    let response = send_request_with_timeout(http, Duration::from_secs(GENERATE_TIMEOUT_SECS))
        .map_err(|error| transport_error(&origin, GENERATE_TIMEOUT_SECS, error))?;
    let body = parse_json_body(&response.body, response.body_truncated, "chat")?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(response.status, &response.status_text, &body));
    }
    let raw_text = body
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (text, text_truncated) = bound_text(raw_text, MAX_REPLY_CHARS);
    let number = |key: &str| body.get(key).and_then(Value::as_u64).unwrap_or(0);
    Ok(OllamaChatResponse {
        endpoint: origin,
        model,
        text,
        text_truncated,
        done_reason: body
            .get("done_reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .chars()
            .take(32)
            .collect(),
        prompt_eval_count: number("prompt_eval_count"),
        eval_count: number("eval_count"),
        total_duration_ms: number("total_duration") / 1_000_000,
        elapsed_ms: elapsed_ms(started),
    })
}

/// Embedding batch result: one unit-normalized vector per input, all of the same dimension.
pub(crate) struct EmbeddingBatch {
    pub(crate) endpoint: String,
    pub(crate) model: String,
    pub(crate) dims: usize,
    pub(crate) vectors: Vec<Vec<f32>>,
    pub(crate) prompt_eval_count: u64,
}

/// Validates the endpoint/model exactly like chat and returns the normalized origin + model id,
/// so callers can record which local model produced a set of vectors.
pub(crate) fn validate_embed_target(endpoint: &str, model: &str) -> Result<(String, String), CommandError> {
    let (_, origin) = validate_loopback_endpoint(endpoint)?;
    let model = validate_model(model)?;
    Ok((origin, model))
}

/// Parses an `/api/embed` body into exactly `expected` finite, non-empty, equal-length vectors and
/// normalizes them to unit length. Anything else is a protocol error; nothing is guessed.
pub(crate) fn parse_embeddings(body: &Value, expected: usize) -> Result<(usize, Vec<Vec<f32>>), CommandError> {
    let protocol = |detail: &str| CommandError::new("ollama_protocol_error", format!("Ollama embedding response was rejected: {detail}"));
    let rows = body
        .get("embeddings")
        .and_then(Value::as_array)
        .ok_or_else(|| protocol("missing `embeddings` array (update Ollama to a version that supports /api/embed)"))?;
    if rows.len() != expected {
        return Err(protocol(&format!("expected {expected} vectors but received {}", rows.len())));
    }
    let mut dims = 0usize;
    let mut vectors = Vec::with_capacity(rows.len());
    for row in rows {
        let values = row.as_array().ok_or_else(|| protocol("a vector is not an array"))?;
        if dims == 0 {
            dims = values.len();
            if !(MIN_EMBED_DIMS..=MAX_EMBED_DIMS).contains(&dims) {
                return Err(protocol(&format!("vector dimension {dims} is outside {MIN_EMBED_DIMS}..={MAX_EMBED_DIMS}")));
            }
        } else if values.len() != dims {
            return Err(protocol("vectors have inconsistent dimensions"));
        }
        let mut vector = Vec::with_capacity(dims);
        let mut norm = 0.0f64;
        for value in values {
            let number = value.as_f64().ok_or_else(|| protocol("a vector component is not a number"))?;
            if !number.is_finite() {
                return Err(protocol("a vector component is not finite"));
            }
            norm += number * number;
            vector.push(number as f32);
        }
        if norm <= 0.0 {
            return Err(protocol("received a zero vector"));
        }
        let scale = (1.0 / norm.sqrt()) as f32;
        for component in &mut vector {
            *component *= scale;
        }
        vectors.push(vector);
    }
    Ok((dims, vectors))
}

/// Embeds up to `MAX_EMBED_BATCH` texts with a local Ollama model. Inputs are bounded per text;
/// the call is non-streamed and bounded by `EMBED_TIMEOUT_SECS`.
pub(crate) fn embed_texts(endpoint: &str, model: &str, inputs: &[&str]) -> Result<EmbeddingBatch, CommandError> {
    let (origin, model) = validate_embed_target(endpoint, model)?;
    if inputs.is_empty() || inputs.len() > MAX_EMBED_BATCH {
        return Err(CommandError::new(
            "ollama_embed_invalid",
            format!("Embedding batches must contain between 1 and {MAX_EMBED_BATCH} texts."),
        ));
    }
    let mut bounded = Vec::with_capacity(inputs.len());
    for input in inputs {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Err(CommandError::new("ollama_embed_invalid", "Cannot embed an empty text."));
        }
        bounded.push(bound_text(trimmed, MAX_EMBED_INPUT_CHARS).0);
    }
    let payload = json!({ "model": model, "input": bounded, "truncate": true });
    let response = send_request_with_timeout(
        HttpRequest {
            method: "POST".to_string(),
            url: api_url(&origin, "/api/embed"),
            headers: vec![json_header()],
            body: payload.to_string(),
            timeout_secs: None,
        },
        Duration::from_secs(EMBED_TIMEOUT_SECS),
    )
    .map_err(|error| transport_error(&origin, EMBED_TIMEOUT_SECS, error))?;
    let body = parse_json_body(&response.body, response.body_truncated, "embedding")?;
    if !(200..300).contains(&response.status) {
        let error = http_status_error(response.status, &response.status_text, &body);
        if response.status == 404 {
            return Err(CommandError::new(
                "ollama_model_not_found",
                format!("{} Pull an embedding model (for example `ollama pull nomic-embed-text`) and make sure Ollama is recent enough to serve /api/embed.", error.message),
            ));
        }
        return Err(error);
    }
    let (dims, vectors) = parse_embeddings(&body, inputs.len())?;
    Ok(EmbeddingBatch {
        endpoint: origin,
        model,
        dims,
        vectors,
        prompt_eval_count: body.get("prompt_eval_count").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn bound_text(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    (text.chars().take(max_chars).collect(), true)
}

fn elapsed_ms(started: Instant) -> u64 {
    started
        .elapsed()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[tauri::command]
pub async fn ollama_list_models(request: OllamaListRequest) -> Result<OllamaListResponse, CommandError> {
    blocking(move || list_models(request)).await
}

/// Phase 9P: read-only local model health check (version, installed, loaded, context windows).
#[tauri::command]
pub async fn ollama_model_health(request: OllamaHealthRequest) -> Result<OllamaHealthResponse, CommandError> {
    blocking(move || model_health(request)).await
}

#[tauri::command]
pub async fn ollama_chat(request: OllamaChatRequest) -> Result<OllamaChatResponse, CommandError> {
    blocking(move || chat(request)).await
}

/// Streamed variant: NDJSON lines from `/api/chat` are forwarded as bounded text deltas through
/// `channel`; the command resolves with the summary once the stream ends, is cancelled or fails.
#[tauri::command]
pub async fn ollama_chat_stream(
    request: OllamaChatRequest,
    stream_id: String,
    channel: Channel<StreamEvent>,
    registry: tauri::State<'_, Arc<StreamRegistry>>,
) -> Result<StreamedReply, CommandError> {
    let registry = registry.inner().clone();
    blocking(move || {
        let handle = begin_stream(&registry, &stream_id)?;
        let (origin, model, http) = prepare_chat(&request, true)?;
        let result = run_stream(
            http,
            Duration::from_secs(GENERATE_TIMEOUT_SECS),
            StreamProtocol::OllamaNdjson,
            MAX_REPLY_CHARS,
            handle.flag(),
            &channel,
        )
        .map_err(|error| transport_error(&origin, GENERATE_TIMEOUT_SECS, error))?;
        match result {
            StreamResult::Completed(summary) => Ok(StreamedReply { target: origin, model, summary }),
            StreamResult::HttpError(error) => {
                let body = parse_json_body(&error.body, error.body_truncated, "chat").unwrap_or(Value::Null);
                Err(http_status_error(error.status, &error.status_text, &body))
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> OllamaMessage {
        OllamaMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn embedding_parser_is_strict_and_normalizes() {
        let body = json!({ "embeddings": [[3.0, 4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                                          [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0]] });
        let (dims, vectors) = parse_embeddings(&body, 2).unwrap();
        assert_eq!(dims, 16);
        assert!((vectors[0][0] - 0.6).abs() < 1e-6 && (vectors[0][1] - 0.8).abs() < 1e-6);
        assert!((vectors[1][15] - 1.0).abs() < 1e-6);

        assert_eq!(parse_embeddings(&body, 1).unwrap_err().code, "ollama_protocol_error");
        assert_eq!(parse_embeddings(&json!({ "embedding": [1.0] }), 1).unwrap_err().code, "ollama_protocol_error");
        assert_eq!(parse_embeddings(&json!({ "embeddings": [[1.0, 2.0]] }), 1).unwrap_err().code, "ollama_protocol_error");
        let ragged = json!({ "embeddings": [vec![1.0; 16], vec![1.0; 17]] });
        assert_eq!(parse_embeddings(&ragged, 2).unwrap_err().code, "ollama_protocol_error");
        let zero = json!({ "embeddings": [vec![0.0; 16]] });
        assert_eq!(parse_embeddings(&zero, 1).unwrap_err().code, "ollama_protocol_error");
        let text = json!({ "embeddings": [vec![json!("x"); 16]] });
        assert_eq!(parse_embeddings(&text, 1).unwrap_err().code, "ollama_protocol_error");
    }

    #[test]
    fn embed_inputs_are_validated_before_any_request() {
        assert_eq!(embed_texts("http://127.0.0.1:11434", "nomic-embed-text", &[]).unwrap_err().code, "ollama_embed_invalid");
        assert_eq!(embed_texts("http://127.0.0.1:11434", "nomic-embed-text", &["   "]).unwrap_err().code, "ollama_embed_invalid");
        let too_many = vec!["x"; MAX_EMBED_BATCH + 1];
        assert_eq!(embed_texts("http://127.0.0.1:11434", "nomic-embed-text", &too_many).unwrap_err().code, "ollama_embed_invalid");
        assert_eq!(embed_texts("http://example.com:11434", "nomic-embed-text", &["x"]).unwrap_err().code, "ollama_endpoint_not_loopback");
        assert_eq!(embed_texts("http://127.0.0.1:11434", "bad model!", &["x"]).unwrap_err().code, "ollama_model_invalid");
        assert_eq!(validate_embed_target("", "nomic-embed-text").unwrap(), ("http://127.0.0.1:11434".to_string(), "nomic-embed-text".to_string()));
    }

    #[test]
    fn accepts_only_literal_loopback_hosts() {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in [
            "localhost.example.com",
            "127.0.0.1.nip.io",
            "0.0.0.0",
            "10.0.0.5",
            "192.168.1.10",
            "169.254.169.254",
            "example.com",
            "::",
            "fe80::1",
        ] {
            assert!(!is_loopback_host(host), "{host} must not be loopback");
        }
    }

    #[test]
    fn endpoint_defaults_and_normalizes_origin() {
        let (url, origin) = validate_loopback_endpoint("").expect("default endpoint");
        assert_eq!(origin, "http://127.0.0.1:11434");
        assert_eq!(url.port, 11434);
        let (_, origin) = validate_loopback_endpoint("  http://localhost:11434  ").expect("trimmed");
        assert_eq!(origin, "http://localhost:11434");
        let (_, origin) = validate_loopback_endpoint("http://[::1]:11434").expect("ipv6");
        assert_eq!(origin, "http://[::1]:11434");
        let (_, origin) = validate_loopback_endpoint("http://127.0.0.1:11434/").expect("trailing slash");
        assert_eq!(origin, "http://127.0.0.1:11434");
    }

    #[test]
    fn endpoint_rejects_remote_tls_paths_and_credentials() {
        assert_eq!(
            validate_loopback_endpoint("https://127.0.0.1:11434").unwrap_err().code,
            "ollama_endpoint_not_loopback"
        );
        assert_eq!(
            validate_loopback_endpoint("http://ollama.internal:11434").unwrap_err().code,
            "ollama_endpoint_not_loopback"
        );
        assert_eq!(
            validate_loopback_endpoint("http://10.0.0.2:11434").unwrap_err().code,
            "ollama_endpoint_not_loopback"
        );
        assert_eq!(
            validate_loopback_endpoint("http://127.0.0.1:11434/api/chat").unwrap_err().code,
            "ollama_endpoint_invalid"
        );
        assert_eq!(
            validate_loopback_endpoint("http://user:pw@127.0.0.1:11434").unwrap_err().code,
            "ollama_endpoint_invalid"
        );
        assert_eq!(
            validate_loopback_endpoint("ftp://127.0.0.1").unwrap_err().code,
            "ollama_endpoint_invalid"
        );
        let long = format!("http://127.0.0.1:11434/{}", "a".repeat(MAX_ENDPOINT_BYTES));
        assert_eq!(validate_loopback_endpoint(&long).unwrap_err().code, "ollama_endpoint_invalid");
    }

    #[test]
    fn api_paths_are_fixed_to_the_origin() {
        let (_, origin) = validate_loopback_endpoint("http://localhost:11434").unwrap();
        assert_eq!(api_url(&origin, "/api/tags"), "http://localhost:11434/api/tags");
        assert_eq!(api_url(&origin, "/api/chat"), "http://localhost:11434/api/chat");
    }

    #[test]
    fn validates_model_ids() {
        assert_eq!(validate_model(" llama3.1:8b ").unwrap(), "llama3.1:8b");
        assert!(validate_model("library/qwen2.5-coder:7b-instruct-q4_K_M").is_ok());
        assert_eq!(validate_model("").unwrap_err().code, "ollama_model_invalid");
        assert_eq!(validate_model("bad model").unwrap_err().code, "ollama_model_invalid");
        assert_eq!(validate_model("mo\ndel").unwrap_err().code, "ollama_model_invalid");
        assert_eq!(
            validate_model(&"m".repeat(MAX_MODEL_ID_BYTES + 1)).unwrap_err().code,
            "ollama_model_invalid"
        );
    }

    #[test]
    fn maps_roles_and_bounds_messages() {
        let converted = validate_messages(&[message("user", "hi"), message("model", "hello")]).unwrap();
        assert_eq!(converted[0]["role"], "user");
        assert_eq!(converted[1]["role"], "assistant");
        assert_eq!(validate_messages(&[]).unwrap_err().code, "ollama_prompt_empty");
        assert_eq!(
            validate_messages(&[message("system", "x")]).unwrap_err().code,
            "ollama_prompt_invalid"
        );
        assert_eq!(
            validate_messages(&[message("user", "")]).unwrap_err().code,
            "ollama_prompt_invalid"
        );
        let too_many = vec![message("user", "x"); MAX_MESSAGES + 1];
        assert_eq!(validate_messages(&too_many).unwrap_err().code, "ollama_prompt_too_large");
        let huge = message("user", &"x".repeat(MAX_MESSAGE_CHARS + 1));
        assert_eq!(validate_messages(&[huge]).unwrap_err().code, "ollama_prompt_too_large");
        let per_message = "y".repeat(MAX_MESSAGE_CHARS);
        let combined = vec![message("user", &per_message); MAX_PROMPT_CHARS / MAX_MESSAGE_CHARS + 1];
        assert_eq!(validate_messages(&combined).unwrap_err().code, "ollama_prompt_too_large");
    }

    #[test]
    fn clamps_generation_options() {
        assert_eq!(clamp_temperature(None), 0.7);
        assert_eq!(clamp_temperature(Some(-1.0)), 0.0);
        assert_eq!(clamp_temperature(Some(9.0)), 2.0);
        assert_eq!(clamp_temperature(Some(f64::NAN)), 0.7);
        assert_eq!(clamp_predict(None), 2048);
        assert_eq!(clamp_predict(Some(1)), MIN_PREDICT_TOKENS);
        assert_eq!(clamp_predict(Some(1_000_000)), MAX_PREDICT_TOKENS);
        assert_eq!(validate_system("   ").unwrap(), None);
        assert_eq!(
            validate_system(&"s".repeat(MAX_SYSTEM_CHARS + 1)).unwrap_err().code,
            "ollama_prompt_too_large"
        );
    }

    #[test]
    fn maps_transport_failures() {
        let mapped = transport_error(
            "http://127.0.0.1:11434",
            LIST_TIMEOUT_SECS,
            CommandError::new("http_connection_failed", "refused"),
        );
        assert_eq!(mapped.code, "ollama_unreachable");
        assert!(mapped.message.contains("ollama serve"));
        let timed_out = transport_error(
            "http://127.0.0.1:11434",
            GENERATE_TIMEOUT_SECS,
            CommandError::new("http_timeout", "slow"),
        );
        assert_eq!(timed_out.code, "ollama_timeout");
        assert!(timed_out.message.contains("120 s"));
        let passthrough = transport_error(
            "http://127.0.0.1:11434",
            LIST_TIMEOUT_SECS,
            CommandError::new("http_protocol_error", "x"),
        );
        assert_eq!(passthrough.code, "http_protocol_error");
    }

    #[test]
    fn generation_timeout_exceeds_api_client_ceiling_but_is_finite() {
        assert!(GENERATE_TIMEOUT_SECS > 30);
        assert!(GENERATE_TIMEOUT_SECS <= 300);
    }

    #[test]
    fn parses_and_bounds_responses() {
        assert_eq!(
            parse_json_body("{", false, "chat").unwrap_err().code,
            "ollama_protocol_error"
        );
        assert_eq!(
            parse_json_body("{}", true, "chat").unwrap_err().code,
            "ollama_response_too_large"
        );
        let body: Value = serde_json::from_str(r#"{"error":"model 'nope' not found"}"#).unwrap();
        let error = http_status_error(404, "Not Found", &body);
        assert_eq!(error.code, "ollama_model_not_found");
        assert!(error.message.contains("not found"));
        assert_eq!(http_status_error(500, "Server Error", &Value::Null).code, "ollama_http_error");
        let (text, truncated) = bound_text(&"z".repeat(MAX_REPLY_CHARS + 5), MAX_REPLY_CHARS);
        assert_eq!(text.chars().count(), MAX_REPLY_CHARS);
        assert!(truncated);
    }

    #[test]
    fn health_show_parser_extracts_context_window_and_capabilities() {
        let body = json!({
            "details": { "format": "gguf", "family": "llama", "parameter_size": "8.0B", "quantization_level": "Q4_K_M" },
            "model_info": {
                "general.architecture": "llama",
                "general.parameter_count": 8030261248u64,
                "llama.context_length": 131072,
                "llama.embedding_length": 4096
            },
            "capabilities": ["completion", "tools"],
            "parameters": "num_ctx 8192\nstop \"<|eot_id|>\""
        });
        let mut entry = OllamaModelHealth { name: "llama3.1:latest".to_string(), installed: true, ..OllamaModelHealth::default() };
        apply_show_details(&mut entry, &body);
        assert_eq!(entry.architecture, "llama");
        assert_eq!(entry.parameter_count, 8030261248);
        assert_eq!(entry.context_length, Some(131072));
        assert_eq!(entry.embedding_length, Some(4096));
        assert_eq!(entry.configured_context, Some(8192));
        assert_eq!(entry.capabilities, vec!["completion".to_string(), "tools".to_string()]);
        assert_eq!(entry.format, "gguf");
        assert_eq!(entry.quantization, "Q4_K_M");
    }

    #[test]
    fn health_show_parser_falls_back_to_any_context_key() {
        let body = json!({
            "model_info": { "nomic-bert.context_length": 2048, "nomic-bert.embedding_length": 768 },
            "capabilities": ["embedding"]
        });
        let mut entry = OllamaModelHealth::default();
        apply_show_details(&mut entry, &body);
        assert_eq!(entry.architecture, "");
        assert_eq!(entry.context_length, Some(2048));
        assert_eq!(entry.embedding_length, Some(768));
        assert_eq!(entry.configured_context, None);
        assert_eq!(entry.capabilities, vec!["embedding".to_string()]);
    }

    #[test]
    fn health_running_index_matches_tagged_and_untagged_names() {
        let body = json!({ "models": [{ "name": "llama3.1:latest", "model": "llama3.1:latest", "size_vram": 6654289920u64, "expires_at": "2026-09-23T10:00:00Z", "context_length": 4096 }] });
        let running = index_running(&body);
        assert!(running.contains_key("llama3.1:latest"));
        assert!(running.contains_key(&canonical_model("llama3.1")));
        let mut entry = OllamaModelHealth::default();
        apply_running_details(&mut entry, running.get("llama3.1:latest").unwrap());
        assert!(entry.loaded);
        assert_eq!(entry.size_vram, 6654289920);
        assert_eq!(entry.loaded_context, Some(4096));
        assert_eq!(entry.expires_at, "2026-09-23T10:00:00Z");
        assert_eq!(canonical_model("qwen2.5-coder:7b"), "qwen2.5-coder:7b");
    }
}
