//! Custom OpenAI-compatible endpoint adapter (Phase 9E).
//!
//! Lets DevLab talk to a self-hosted or third-party server that speaks the OpenAI chat-completions
//! protocol (vLLM, LM Studio, LiteLLM, llama.cpp server, OpenRouter-style gateways, …) without
//! giving the WebView a general-purpose fetch. Design constraints:
//! * The endpoint is a user-supplied **base URL**, but it is validated by an explicit host policy
//!   before anything else: `https://` is required unless the host is a literal loopback address,
//!   in which case plain `http://` is accepted; embedded credentials, query strings, fragments and
//!   non-loopback raw IP addresses are refused; the path is normalized and the fixed
//!   `/chat/completions` suffix is appended by Rust. A profile is identified by its normalized
//!   origin + base path.
//! * An optional bearer token lives only in the operating-system credential store, under an
//!   account derived from the normalized profile id. A token stored for one endpoint is therefore
//!   never attached to a request for another endpoint, and no command ever returns token material.
//! * Requests reuse the bounded HTTP/1.1 client (verified TLS, bounded bodies, `Connection:
//!   close`), the same prompt/model/reply bounds as the Phase 9B adapters, a 120-second bound and
//!   no retries or fallbacks. Replies are parsed with the OpenAI response shape only.

use keyring::{error::Error as KeyringError, Entry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

use crate::ai_providers::{
    bound_text, clamp_output_tokens, keyring_backend, keyring_error, lock_keyring, provider_error_detail,
    validate_key, validate_messages, validate_model, validate_system, AiMessage, GENERATE_TIMEOUT_SECS,
    KEYRING_SERVICE, MAX_REPLY_CHARS,
};
use std::sync::Arc;
use tauri::ipc::Channel;

use crate::ai_stream::{begin_stream, run_stream, StreamEvent, StreamProtocol, StreamRegistry, StreamResult, StreamedReply};
use crate::http::{blocking, parse_url, send_request_with_timeout, HttpHeader, HttpRequest};
use crate::ollama::is_loopback_host;
use crate::workspace::CommandError;

const MAX_ENDPOINT_BYTES: usize = 512;
const MAX_BASE_PATH_SEGMENTS: usize = 8;
const CHAT_SUFFIX: &str = "/chat/completions";
const ACCOUNT_PREFIX: &str = "custom-endpoint/";
const MAX_TEMPERATURE: f64 = 2.0;
/// Phase 9V — read-only health check bounds.
const MODELS_SUFFIX: &str = "/models";
const HEALTH_TIMEOUT_SECS: u64 = 20;
const MAX_HEALTH_MODELS: usize = 200;
const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_OWNED_BY_CHARS: usize = 64;

/// A validated endpoint profile. `origin` is `scheme://host[:port]`, `base_path` has no trailing
/// slash (may be empty), and `id` is the string used both for display and as the credential key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProfile {
    id: String,
    origin: String,
    host: String,
    base_path: String,
    chat_url: String,
    loopback: bool,
    tls: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCredentialStatus {
    profile: EndpointProfile,
    configured: bool,
    backend: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomChatRequest {
    endpoint: String,
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<AiMessage>,
    temperature: Option<f64>,
    max_output_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomChatResponse {
    profile: EndpointProfile,
    model: String,
    text: String,
    text_truncated: bool,
    finish_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    authenticated: bool,
    elapsed_ms: u64,
}

/// One entry from the server's OpenAI-style `GET /models` list (Phase 9V).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpointModel {
    id: String,
    owned_by: String,
    created: u64,
}

/// Outcome of the read-only custom-endpoint health check (Phase 9V).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpointHealth {
    profile: EndpointProfile,
    /// HTTP status the server returned for `GET {id}/models`.
    http_status: u16,
    /// False when the server is reachable but does not expose `GET /models`
    /// (HTTP 404/405); the chat completions path may still work in that case.
    models_listed: bool,
    models: Vec<CustomEndpointModel>,
    /// True when the list exceeded the cap and later entries were dropped.
    models_truncated: bool,
    /// True when the profile-scoped bearer token was attached to the request.
    authenticated: bool,
    elapsed_ms: u64,
}

fn endpoint_error(message: impl Into<String>) -> CommandError {
    CommandError::new("custom_endpoint_invalid", message)
}

/// Applies the host policy and normalizes the base URL into an [`EndpointProfile`].
pub(crate) fn validate_endpoint(raw: &str) -> Result<EndpointProfile, CommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(endpoint_error(
            "Enter the base URL of an OpenAI-compatible server, for example https://llm.example.com/v1.",
        ));
    }
    if trimmed.len() > MAX_ENDPOINT_BYTES {
        return Err(endpoint_error(format!("Endpoint URLs are limited to {MAX_ENDPOINT_BYTES} bytes.")));
    }
    if trimmed.contains('?') || trimmed.contains('#') {
        return Err(endpoint_error("Endpoint URLs cannot carry a query string or fragment."));
    }
    if trimmed.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(endpoint_error("Endpoint URLs cannot contain whitespace or control characters."));
    }
    let url = parse_url(trimmed).map_err(|error| endpoint_error(format!("The endpoint is not a valid URL: {}", error.message)))?;
    let host = url.host.to_ascii_lowercase();
    let loopback = is_loopback_host(&host);
    let tls = url.scheme == "https";
    if !tls && !loopback {
        return Err(CommandError::new(
            "custom_endpoint_policy",
            format!(
                "`{host}` must be reached over https://. Plain http:// is accepted only for loopback addresses (localhost, 127.0.0.1, ::1)."
            ),
        ));
    }
    if !loopback && (host.parse::<std::net::Ipv4Addr>().is_ok() || host.parse::<std::net::Ipv6Addr>().is_ok()) {
        return Err(CommandError::new(
            "custom_endpoint_policy",
            "Raw IP addresses are not accepted for remote endpoints; use a DNS host name with a valid certificate.",
        ));
    }
    if host.is_empty() || host.ends_with('.') || host.starts_with('.') || host.contains("..") {
        return Err(endpoint_error("The endpoint host name is malformed."));
    }
    if !host.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b':')) {
        return Err(endpoint_error("Endpoint host names may contain only letters, digits, '.', '-' and ':' (IPv6)."));
    }

    // Normalize the base path: strip a trailing slash and a trailing `/chat/completions` that
    // users often paste, refuse traversal and encoded separators.
    let mut base_path = url.path.trim_end_matches('/').to_string();
    if let Some(stripped) = base_path.strip_suffix(CHAT_SUFFIX) {
        base_path = stripped.to_string();
    }
    let segments = base_path.split('/').filter(|segment| !segment.is_empty()).collect::<Vec<_>>();
    if segments.len() > MAX_BASE_PATH_SEGMENTS {
        return Err(endpoint_error(format!("Endpoint base paths are limited to {MAX_BASE_PATH_SEGMENTS} segments.")));
    }
    for segment in &segments {
        if *segment == "." || *segment == ".." || segment.contains("%2f") || segment.contains("%2F") || segment.contains("%00") {
            return Err(endpoint_error("Endpoint base paths cannot contain traversal or encoded separators."));
        }
        if !segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'~' | b'%')) {
            return Err(endpoint_error("Endpoint base paths may contain only URL-safe characters."));
        }
    }
    let base_path = if segments.is_empty() { String::new() } else { format!("/{}", segments.join("/")) };
    let origin = format!("{}://{}", url.scheme, url.host_header.to_ascii_lowercase());
    let id = format!("{origin}{base_path}");
    let chat_url = format!("{id}{CHAT_SUFFIX}");
    Ok(EndpointProfile { id, origin, host, base_path, chat_url, loopback, tls })
}

fn account_for(profile: &EndpointProfile) -> String {
    format!("{ACCOUNT_PREFIX}{}", profile.id)
}

fn entry_for(profile: &EndpointProfile) -> Result<Entry, CommandError> {
    Entry::new(KEYRING_SERVICE, &account_for(profile)).map_err(keyring_error)
}

fn load_token_unlocked(profile: &EndpointProfile) -> Result<Option<Zeroizing<String>>, CommandError> {
    match entry_for(profile)?.get_password() {
        Ok(token) => Ok(Some(Zeroizing::new(token))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

fn status_unlocked(profile: EndpointProfile) -> Result<CustomCredentialStatus, CommandError> {
    let configured = load_token_unlocked(&profile)?.is_some();
    Ok(CustomCredentialStatus { profile, configured, backend: keyring_backend() })
}

fn clamp_temperature(value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(0.0, MAX_TEMPERATURE),
        _ => 0.7,
    }
}

/// OpenAI chat-completions body. `max_tokens` is the field every compatible server understands.
pub(crate) fn build_body(
    model: &str,
    system: Option<&str>,
    messages: &[(&'static str, String)],
    temperature: f64,
    max_output_tokens: u64,
) -> Value {
    build_body_with_stream(model, system, messages, temperature, max_output_tokens, false)
}

pub(crate) fn build_body_with_stream(
    model: &str,
    system: Option<&str>,
    messages: &[(&'static str, String)],
    temperature: f64,
    max_output_tokens: u64,
    stream: bool,
) -> Value {
    let mut chat = Vec::with_capacity(messages.len() + 1);
    if let Some(system) = system {
        chat.push(json!({ "role": "system", "content": system }));
    }
    chat.extend(messages.iter().map(|(role, content)| json!({ "role": role, "content": content })));
    let mut body = json!({
        "model": model,
        "messages": chat,
        "temperature": temperature,
        "max_tokens": max_output_tokens,
        "stream": stream,
    });
    if stream {
        // Widely supported by vLLM/LiteLLM/LM Studio; servers that ignore it simply omit usage.
        body["stream_options"] = json!({ "include_usage": true });
    }
    body
}

fn request_headers(token: Option<&str>) -> Vec<HttpHeader> {
    let mut headers = vec![HttpHeader { name: "Content-Type".to_string(), value: "application/json".to_string() }];
    if let Some(token) = token {
        headers.push(HttpHeader { name: "Authorization".to_string(), value: format!("Bearer {token}") });
    }
    headers
}

/// Parses an OpenAI-shaped reply. Accepts `content` as a string or as an array of text parts
/// (some gateways return the newer content-part form).
pub(crate) fn parse_reply(body: &Value) -> Result<(String, String, u64, u64), CommandError> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| CommandError::new("ai_protocol_error", "The endpoint returned a response without choices."))?;
    let content = choice.get("message").and_then(|message| message.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| !matches!(part.get("type").and_then(Value::as_str), Some(kind) if kind != "text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    let finish = choice.get("finish_reason").and_then(Value::as_str).unwrap_or("unknown").to_string();
    let usage = body.get("usage").cloned().unwrap_or(Value::Null);
    let number = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    Ok((text, finish, number("prompt_tokens"), number("completion_tokens")))
}

pub(crate) fn http_status_error(profile: &EndpointProfile, status: u16, status_text: &str, body: &Value) -> CommandError {
    let detail = provider_error_detail(body);
    let code = match status {
        401 | 403 => "ai_provider_unauthorized",
        402 => "ai_provider_billing",
        404 => "ai_model_not_found",
        429 => "ai_provider_rate_limited",
        500..=599 => "ai_provider_unavailable",
        _ => "ai_provider_http_error",
    };
    let hint = match code {
        "ai_provider_unauthorized" => " Check whether this endpoint needs a bearer token (Settings → Providers → Custom).",
        "ai_model_not_found" => " Check the model id and whether the base path should end in /v1.",
        "ai_provider_rate_limited" => " Wait before retrying; DevLab does not retry automatically.",
        _ => "",
    };
    CommandError::new(
        code,
        if detail.is_empty() {
            format!("{} responded with HTTP {status} {status_text}.{hint}", profile.id)
        } else {
            format!("{} responded with HTTP {status} {status_text}: {detail}.{hint}", profile.id)
        },
    )
}

fn transport_error(profile: &EndpointProfile, timeout_secs: u64, error: CommandError) -> CommandError {
    match error.code {
        "http_connection_failed" | "http_dns_failed" => CommandError::new(
            "ai_provider_unreachable",
            format!("Could not reach {}: {}", profile.id, error.message),
        ),
        "http_timeout" => CommandError::new(
            "ai_provider_timeout",
            format!("{} did not answer within DevLab's {timeout_secs} s bound: {}", profile.id, error.message),
        ),
        "http_tls_failed" => CommandError::new(
            "custom_endpoint_tls",
            format!("TLS verification failed for {}: {}. Self-signed certificates are not trusted by DevLab.", profile.host, error.message),
        ),
        _ => error,
    }
}

fn parse_json_body(profile: &EndpointProfile, body: &str, truncated: bool) -> Result<Value, CommandError> {
    if truncated {
        return Err(CommandError::new(
            "ai_response_too_large",
            format!("The response from {} exceeded DevLab's response bound and was not parsed.", profile.id),
        ));
    }
    serde_json::from_str::<Value>(body).map_err(|error| {
        CommandError::new(
            "ai_protocol_error",
            format!("{} returned a response that is not valid JSON: {error}", profile.id),
        )
    })
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

struct PreparedChat {
    profile: EndpointProfile,
    model: String,
    authenticated: bool,
    http: HttpRequest,
}

/// Validates the endpoint/prompt, loads the profile-scoped token and builds the HTTP request.
fn prepare_chat(request: &CustomChatRequest, stream: bool) -> Result<PreparedChat, CommandError> {
    let profile = validate_endpoint(&request.endpoint)?;
    let model = validate_model(&request.model)?;
    let system = validate_system(&request.system)?;
    let messages = validate_messages(&request.messages)?;
    let temperature = clamp_temperature(request.temperature);
    let max_output_tokens = clamp_output_tokens(request.max_output_tokens);

    let token = {
        let _guard = lock_keyring()?;
        load_token_unlocked(&profile)?
    };
    let authenticated = token.is_some();
    if authenticated && !profile.tls {
        // Defensive: tokens are never sent in clear text, even to loopback.
        return Err(CommandError::new(
            "custom_endpoint_policy",
            "A bearer token is stored for this loopback endpoint, but tokens are only sent over https://. Remove the token or use an https:// endpoint.",
        ));
    }

    let body = build_body_with_stream(&model, system.as_deref(), &messages, temperature, max_output_tokens, stream);
    let http = HttpRequest {
        method: "POST".to_string(),
        url: profile.chat_url.clone(),
        headers: request_headers(token.as_ref().map(|t| t.as_str())),
        body: body.to_string(),
        timeout_secs: None,
    };
    drop(token);
    Ok(PreparedChat { profile, model, authenticated, http })
}

fn chat(request: CustomChatRequest) -> Result<CustomChatResponse, CommandError> {
    let started = Instant::now();
    let PreparedChat { profile, model, authenticated, http } = prepare_chat(&request, false)?;
    let response = send_request_with_timeout(http, Duration::from_secs(GENERATE_TIMEOUT_SECS))
        .map_err(|error| transport_error(&profile, GENERATE_TIMEOUT_SECS, error))?;

    let parsed = parse_json_body(&profile, &response.body, response.body_truncated)?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(&profile, response.status, &response.status_text, &parsed));
    }
    let (raw_text, finish_reason, input_tokens, output_tokens) = parse_reply(&parsed)?;
    let (text, text_truncated) = bound_text(&raw_text, MAX_REPLY_CHARS);
    Ok(CustomChatResponse {
        profile,
        model,
        text,
        text_truncated,
        finish_reason: finish_reason.chars().take(32).collect(),
        input_tokens,
        output_tokens,
        authenticated,
        elapsed_ms: elapsed_ms(started),
    })
}

/// Validates an endpoint without touching the network or the credential store.
#[tauri::command]
pub fn custom_endpoint_validate(endpoint: String) -> Result<EndpointProfile, CommandError> {
    validate_endpoint(&endpoint)
}

#[tauri::command]
pub async fn custom_credential_status(endpoint: String) -> Result<CustomCredentialStatus, CommandError> {
    blocking(move || {
        let profile = validate_endpoint(&endpoint)?;
        let _guard = lock_keyring()?;
        status_unlocked(profile)
    })
    .await
}

#[tauri::command]
pub async fn custom_credential_store(endpoint: String, key: String) -> Result<CustomCredentialStatus, CommandError> {
    blocking(move || {
        let profile = validate_endpoint(&endpoint)?;
        if !profile.tls {
            return Err(CommandError::new(
                "custom_endpoint_policy",
                "Bearer tokens can only be stored for https:// endpoints; loopback http:// servers must run without one.",
            ));
        }
        let _guard = lock_keyring()?;
        let secret = Zeroizing::new(key);
        let token = validate_key(secret.as_str())?;
        entry_for(&profile)?.set_password(token).map_err(keyring_error)?;
        status_unlocked(profile)
    })
    .await
}

#[tauri::command]
pub async fn custom_credential_delete(endpoint: String) -> Result<CustomCredentialStatus, CommandError> {
    blocking(move || {
        let profile = validate_endpoint(&endpoint)?;
        let _guard = lock_keyring()?;
        match entry_for(&profile)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => status_unlocked(profile),
            Err(error) => Err(keyring_error(error)),
        }
    })
    .await
}

#[tauri::command]
pub async fn custom_endpoint_chat(request: CustomChatRequest) -> Result<CustomChatResponse, CommandError> {
    blocking(move || chat(request)).await
}

/// Streamed variant (OpenAI SSE). Same host policy, token scoping and bounds as the non-streamed command.
#[tauri::command]
pub async fn custom_endpoint_chat_stream(
    request: CustomChatRequest,
    stream_id: String,
    channel: Channel<StreamEvent>,
    registry: tauri::State<'_, Arc<StreamRegistry>>,
) -> Result<StreamedReply, CommandError> {
    let registry = registry.inner().clone();
    blocking(move || {
        let handle = begin_stream(&registry, &stream_id)?;
        let PreparedChat { profile, model, http, .. } = prepare_chat(&request, true)?;
        let result = run_stream(
            http,
            Duration::from_secs(GENERATE_TIMEOUT_SECS),
            StreamProtocol::OpenAiSse,
            MAX_REPLY_CHARS,
            handle.flag(),
            &channel,
        )
        .map_err(|error| transport_error(&profile, GENERATE_TIMEOUT_SECS, error))?;
        match result {
            StreamResult::Completed(summary) => Ok(StreamedReply { target: profile.id, model, summary }),
            StreamResult::HttpError(error) => {
                let body = parse_json_body(&profile, &error.body, error.body_truncated).unwrap_or(Value::Null);
                Err(http_status_error(&profile, error.status, &error.status_text, &body))
            }
        }
    })
    .await
}

/// Whether a non-2xx status means "reachable, but this server does not expose
/// `GET /models`" (chat completions may still work) rather than an outright failure.
fn models_not_listed_status(status: u16) -> bool {
    matches!(status, 404 | 405)
}

fn health_headers(token: Option<&str>) -> Vec<HttpHeader> {
    let mut headers = vec![HttpHeader { name: "Accept".to_string(), value: "application/json".to_string() }];
    if let Some(token) = token {
        headers.push(HttpHeader { name: "Authorization".to_string(), value: format!("Bearer {token}") });
    }
    headers
}

/// Parses the OpenAI-style model list. Entries without a usable `id` are skipped,
/// oversized ids are dropped, `owned_by` is capped and a list over the cap is
/// truncated rather than failed. A payload without a `data` array lists nothing.
fn parse_models_list(profile: &EndpointProfile, body: &str, truncated: bool) -> Result<(Vec<CustomEndpointModel>, bool), CommandError> {
    if truncated {
        return Err(CommandError::new(
            "ai_response_too_large",
            format!("The model list from {} exceeded DevLab's response bound and was not parsed.", profile.id),
        ));
    }
    let parsed: Value = serde_json::from_str(body).map_err(|error| {
        CommandError::new(
            "ai_protocol_error",
            format!("{} returned a model list that is not valid JSON: {error}", profile.id),
        )
    })?;
    let data = parsed.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut models = Vec::new();
    let mut list_truncated = false;
    for entry in &data {
        if models.len() >= MAX_HEALTH_MODELS {
            list_truncated = true;
            break;
        }
        let id = match entry.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() && id.len() <= MAX_MODEL_ID_BYTES => id.to_string(),
            _ => continue,
        };
        let owned_by = entry
            .get("owned_by")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(MAX_OWNED_BY_CHARS).collect())
            .unwrap_or_default();
        let created = entry.get("created").and_then(Value::as_u64).unwrap_or(0);
        models.push(CustomEndpointModel { id, owned_by, created });
    }
    Ok((models, list_truncated))
}

/// Read-only health check (Phase 9V): `GET {id}/models` through the same bounded
/// client, host policy and profile-scoped token as the chat path. No model is
/// loaded, pulled, prompted or written to; the result is metadata only.
fn health(endpoint: String) -> Result<CustomEndpointHealth, CommandError> {
    let started = Instant::now();
    let profile = validate_endpoint(&endpoint)?;
    let token = {
        let _guard = lock_keyring()?;
        load_token_unlocked(&profile)?
    };
    let authenticated = token.is_some();
    if authenticated && !profile.tls {
        // Defensive: tokens are never sent in clear text, even to loopback.
        return Err(CommandError::new(
            "custom_endpoint_policy",
            "A bearer token is stored for this loopback endpoint, but tokens are only sent over https://. Remove the token or use an https:// endpoint.",
        ));
    }
    let http = HttpRequest {
        method: "GET".to_string(),
        url: format!("{}{MODELS_SUFFIX}", profile.id),
        headers: health_headers(token.as_deref()),
        body: String::new(),
        timeout_secs: Some(HEALTH_TIMEOUT_SECS),
    };
    drop(token);
    let response = send_request_with_timeout(http, Duration::from_secs(HEALTH_TIMEOUT_SECS))
        .map_err(|error| transport_error(&profile, HEALTH_TIMEOUT_SECS, error))?;
    if models_not_listed_status(response.status) {
        return Ok(CustomEndpointHealth {
            profile,
            http_status: response.status,
            models_listed: false,
            models: Vec::new(),
            models_truncated: false,
            authenticated,
            elapsed_ms: elapsed_ms(started),
        });
    }
    let parsed = parse_json_body(&profile, &response.body, response.body_truncated)?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(&profile, response.status, &response.status_text, &parsed));
    }
    let (models, models_truncated) = parse_models_list(&profile, &response.body, response.body_truncated)?;
    Ok(CustomEndpointHealth {
        profile,
        http_status: response.status,
        models_listed: true,
        models,
        models_truncated,
        authenticated,
        elapsed_ms: elapsed_ms(started),
    })
}

#[tauri::command]
pub async fn custom_endpoint_health(endpoint: String) -> Result<CustomEndpointHealth, CommandError> {
    blocking(move || health(endpoint)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_https_endpoints_and_appends_fixed_suffix() {
        let profile = validate_endpoint(" HTTPS://LLM.Example.com/v1/ ").unwrap();
        assert_eq!(profile.id, "https://llm.example.com/v1");
        assert_eq!(profile.origin, "https://llm.example.com");
        assert_eq!(profile.base_path, "/v1");
        assert_eq!(profile.chat_url, "https://llm.example.com/v1/chat/completions");
        assert!(profile.tls && !profile.loopback);

        let pasted = validate_endpoint("https://gateway.example.com/openai/v1/chat/completions").unwrap();
        assert_eq!(pasted.chat_url, "https://gateway.example.com/openai/v1/chat/completions");
        assert_eq!(pasted.base_path, "/openai/v1");

        let bare = validate_endpoint("https://api.example.com").unwrap();
        assert_eq!(bare.base_path, "");
        assert_eq!(bare.chat_url, "https://api.example.com/chat/completions");

        let with_port = validate_endpoint("https://llm.example.com:8443/v1").unwrap();
        assert_eq!(with_port.origin, "https://llm.example.com:8443");
        assert_eq!(account_for(&with_port), "custom-endpoint/https://llm.example.com:8443/v1");
        assert_ne!(account_for(&with_port), account_for(&profile), "credentials are scoped per profile");
        assert!(crate::http::parse_url(&with_port.chat_url).is_ok());
    }

    #[test]
    fn allows_plain_http_only_for_loopback() {
        let local = validate_endpoint("http://localhost:1234/v1").unwrap();
        assert!(local.loopback && !local.tls);
        assert_eq!(local.chat_url, "http://localhost:1234/v1/chat/completions");
        assert!(validate_endpoint("http://127.0.0.1:8080").unwrap().loopback);
        assert!(validate_endpoint("http://[::1]:8080/v1").unwrap().loopback);

        assert_eq!(validate_endpoint("http://llm.example.com/v1").unwrap_err().code, "custom_endpoint_policy");
        assert_eq!(validate_endpoint("http://192.168.1.10:8000/v1").unwrap_err().code, "custom_endpoint_policy");
        assert_eq!(validate_endpoint("https://10.0.0.5/v1").unwrap_err().code, "custom_endpoint_policy");
        assert_eq!(validate_endpoint("https://[fd00::1]/v1").unwrap_err().code, "custom_endpoint_policy");
    }

    #[test]
    fn rejects_malformed_and_unsafe_endpoints() {
        for bad in [
            "",
            "llm.example.com/v1",
            "ftp://llm.example.com/v1",
            "https://user:pw@llm.example.com/v1",
            "https://llm.example.com/v1?key=abc",
            "https://llm.example.com/v1#frag",
            "https://llm.example.com/v1/../admin",
            "https://llm.example.com/v1/%2Fetc",
            "https://llm.example.com/a/b/c/d/e/f/g/h/i",
            "https://llm example.com/v1",
            "https://llm.example.com./v1",
        ] {
            let error = validate_endpoint(bad).unwrap_err();
            assert!(
                error.code == "custom_endpoint_invalid" || error.code == "custom_endpoint_policy",
                "{bad} → {}",
                error.code
            );
        }
        assert_eq!(validate_endpoint(&format!("https://x.example.com/{}", "a".repeat(600))).unwrap_err().code, "custom_endpoint_invalid");
    }

    #[test]
    fn builds_openai_bodies_and_headers() {
        let messages = vec![("user", "hi".to_string()), ("assistant", "hello".to_string())];
        let body = build_body("my-model", Some("sys"), &messages, 0.3, 512);
        assert_eq!(body["model"], "my-model");
        assert_eq!(body["max_tokens"], 512);
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert!(body.get("max_completion_tokens").is_none());

        let anonymous = request_headers(None);
        assert_eq!(anonymous.len(), 1);
        let authed = request_headers(Some("tok-1234567890"));
        assert_eq!(authed[1].name, "Authorization");
        assert_eq!(authed[1].value, "Bearer tok-1234567890");
        assert_eq!(clamp_temperature(Some(5.0)), 2.0);
        assert_eq!(clamp_temperature(Some(f64::NAN)), 0.7);
    }

    #[test]
    fn parses_string_and_part_replies() {
        let plain: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"hi there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}"#,
        )
        .unwrap();
        assert_eq!(parse_reply(&plain).unwrap(), ("hi there".to_string(), "stop".to_string(), 3, 2));
        let parts: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"a"},{"type":"image_url","image_url":{}},{"type":"text","text":"b"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(parse_reply(&parts).unwrap().0, "ab");
        assert_eq!(parse_reply(&json!({"object":"error"})).unwrap_err().code, "ai_protocol_error");
    }

    #[test]
    fn maps_errors_without_leaking_tokens() {
        let profile = validate_endpoint("https://llm.example.com/v1").unwrap();
        let body: Value = serde_json::from_str(r#"{"error":{"message":"invalid token tok-secret-1"}}"#).unwrap();
        let unauthorized = http_status_error(&profile, 401, "Unauthorized", &body);
        assert_eq!(unauthorized.code, "ai_provider_unauthorized");
        assert!(unauthorized.message.contains("llm.example.com"));
        assert_eq!(http_status_error(&profile, 404, "Not Found", &Value::Null).code, "ai_model_not_found");
        assert_eq!(http_status_error(&profile, 503, "Unavailable", &Value::Null).code, "ai_provider_unavailable");
        assert_eq!(transport_error(&profile, GENERATE_TIMEOUT_SECS, CommandError::new("http_dns_failed", "x")).code, "ai_provider_unreachable");
        assert_eq!(transport_error(&profile, HEALTH_TIMEOUT_SECS, CommandError::new("http_timeout", "x")).code, "ai_provider_timeout");
        assert_eq!(parse_json_body(&profile, "nope", false).unwrap_err().code, "ai_protocol_error");
        assert_eq!(parse_json_body(&profile, "{}", true).unwrap_err().code, "ai_response_too_large");
    }

    #[test]
    fn health_check_parses_openai_model_lists() {
        let profile = validate_endpoint("https://llm.example.com/v1").unwrap();
        let body = r#"{"object":"list","data":[{"id":"meta-llama/Llama-3.1-8B","object":"model","created":1700000000,"owned_by":"llama"},{"id":"qwen2.5:7b","owned_by":"qwen"},{"object":"model"}]}"#;
        let (models, truncated) = parse_models_list(&profile, body, false).unwrap();
        assert_eq!(models.len(), 2, "entries without an id are skipped");
        assert_eq!(models[0].id, "meta-llama/Llama-3.1-8B");
        assert_eq!(models[0].owned_by, "llama");
        assert_eq!(models[0].created, 1_700_000_000);
        assert_eq!(models[1].owned_by, "qwen");
        assert_eq!(models[1].created, 0, "missing created defaults to 0");
        assert!(!truncated);

        // A payload without a `data` array lists nothing rather than failing.
        let (none, none_truncated) = parse_models_list(&profile, r#"{"object":"list"}"#, false).unwrap();
        assert!(none.is_empty() && !none_truncated);

        // Oversized ids are dropped.
        let oversized = format!(r#"{{"data":[{{"id":"{}"}}]}}"#, "m".repeat(MAX_MODEL_ID_BYTES + 1));
        let (skip, _) = parse_models_list(&profile, &oversized, false).unwrap();
        assert!(skip.is_empty());

        // A list over the cap is truncated, not an error.
        let big = serde_json::json!({
            "data": (0..(MAX_HEALTH_MODELS + 5)).map(|i| json!({ "id": format!("model-{i}") })).collect::<Vec<_>>()
        })
        .to_string();
        let (capped, capped_truncated) = parse_models_list(&profile, &big, false).unwrap();
        assert_eq!(capped.len(), MAX_HEALTH_MODELS);
        assert!(capped_truncated);

        // An over-bound response is an honest error, not a partial list.
        assert_eq!(parse_models_list(&profile, "{}", true).unwrap_err().code, "ai_response_too_large");
        assert_eq!(parse_models_list(&profile, "nope", false).unwrap_err().code, "ai_protocol_error");
    }

    #[test]
    fn health_check_classifies_unlisted_model_endpoints() {
        assert!(models_not_listed_status(404));
        assert!(models_not_listed_status(405));
        assert!(!models_not_listed_status(200));
        assert!(!models_not_listed_status(401));
        assert!(!models_not_listed_status(429));
        assert!(!models_not_listed_status(500));
    }

    #[test]
    fn health_check_headers_carry_the_token_only_when_stored() {
        let anonymous = health_headers(None);
        assert_eq!(anonymous.len(), 1);
        assert_eq!(anonymous[0].name, "Accept");
        assert_eq!(anonymous[0].value, "application/json");
        let authed = health_headers(Some("tok-abc"));
        assert_eq!(authed.len(), 2);
        assert_eq!(authed[1].name, "Authorization");
        assert_eq!(authed[1].value, "Bearer tok-abc");
    }
}
