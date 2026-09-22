//! Native cloud provider adapters for DeepSeek, OpenAI and Anthropic (Phase 9B).
//!
//! Design constraints:
//! * API keys live only in the operating-system credential store (same `keyring` backend that
//!   Source Control uses, under a separate service name). React can store, check and delete a
//!   key, but no command ever returns key material to the WebView and keys are never logged or
//!   echoed in error messages.
//! * Each provider has a fixed HTTPS host and a fixed API path compiled into this module. The
//!   renderer cannot redirect a key to another host; there is no user-supplied URL here.
//! * Requests go through the existing bounded HTTP/1.1 client in `http.rs` (verified TLS,
//!   bounded headers/bodies, `Connection: close`). Generation is non-streamed and bounded by an
//!   in-crate 120-second timeout.
//! * Prompt size, message count, model ids and reply size are bounded before anything is sent.

use keyring::{error::Error as KeyringError, Entry};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

use crate::http::{blocking, send_request_with_timeout, HttpHeader, HttpRequest};
use crate::workspace::CommandError;

pub(crate) const KEYRING_SERVICE: &str = "io.github.talean414.devlab.ai";
const MAX_KEY_BYTES: usize = 4 * 1024;
const MIN_KEY_BYTES: usize = 8;
const MAX_MODEL_ID_BYTES: usize = 128;
const MAX_MESSAGES: usize = 64;
const MAX_MESSAGE_CHARS: usize = 64 * 1024;
const MAX_PROMPT_CHARS: usize = 192 * 1024;
const MAX_SYSTEM_CHARS: usize = 16 * 1024;
pub(crate) const MAX_REPLY_CHARS: usize = 256 * 1024;
const MIN_OUTPUT_TOKENS: u64 = 64;
const MAX_OUTPUT_TOKENS: u64 = 16_384;
pub(crate) const GENERATE_TIMEOUT_SECS: u64 = 120;
const ANTHROPIC_VERSION: &str = "2023-06-01";
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Deepseek,
    Openai,
    Anthropic,
}

impl AiProvider {
    pub(crate) fn host(self) -> &'static str {
        match self {
            Self::Deepseek => "api.deepseek.com",
            Self::Openai => "api.openai.com",
            Self::Anthropic => "api.anthropic.com",
        }
    }

    pub(crate) fn chat_path(self) -> &'static str {
        match self {
            Self::Deepseek => "/chat/completions",
            Self::Openai => "/v1/chat/completions",
            Self::Anthropic => "/v1/messages",
        }
    }

    pub(crate) fn chat_url(self) -> String {
        format!("https://{}{}", self.host(), self.chat_path())
    }

    fn account(self) -> &'static str {
        match self {
            Self::Deepseek => "api.deepseek.com/api-key",
            Self::Openai => "api.openai.com/api-key",
            Self::Anthropic => "api.anthropic.com/api-key",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Deepseek => "DeepSeek",
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
        }
    }

    /// Anthropic's API accepts temperatures in 0..=1; the OpenAI-style APIs accept 0..=2.
    fn max_temperature(self) -> f64 {
        match self {
            Self::Anthropic => 1.0,
            Self::Deepseek | Self::Openai => 2.0,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCredentialStatus {
    provider: AiProvider,
    host: &'static str,
    configured: bool,
    backend: &'static str,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiChatRequest {
    provider: AiProvider,
    model: String,
    #[serde(default)]
    system: String,
    messages: Vec<AiMessage>,
    temperature: Option<f64>,
    max_output_tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResponse {
    provider: AiProvider,
    host: &'static str,
    model: String,
    text: String,
    text_truncated: bool,
    finish_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    elapsed_ms: u64,
}

pub(crate) fn keyring_backend() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Windows Credential Manager"
    }
    #[cfg(target_os = "macos")]
    {
        "macOS Keychain"
    }
    #[cfg(target_os = "linux")]
    {
        "Linux Secret Service / kernel keyring"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "operating-system credential store"
    }
}

fn entry(provider: AiProvider) -> Result<Entry, CommandError> {
    Entry::new(KEYRING_SERVICE, provider.account()).map_err(keyring_error)
}

pub(crate) fn keyring_error(error: KeyringError) -> CommandError {
    CommandError::new(
        "secure_storage_error",
        format!("The operating-system credential store could not complete the request: {error}"),
    )
}

pub(crate) fn lock_keyring() -> Result<MutexGuard<'static, ()>, CommandError> {
    KEYRING_LOCK.lock().map_err(|_| {
        CommandError::new(
            "secure_storage_unavailable",
            "The secure credential store lock is unavailable.",
        )
    })
}

fn load_key_unlocked(provider: AiProvider) -> Result<Option<Zeroizing<String>>, CommandError> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(Zeroizing::new(key))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

fn status_unlocked(provider: AiProvider) -> Result<AiCredentialStatus, CommandError> {
    Ok(AiCredentialStatus {
        provider,
        host: provider.host(),
        configured: load_key_unlocked(provider)?.is_some(),
        backend: keyring_backend(),
    })
}

/// Validates key material without ever placing it in an error message.
pub(crate) fn validate_key(raw: &str) -> Result<&str, CommandError> {
    let key = raw.trim();
    if key.len() < MIN_KEY_BYTES {
        return Err(CommandError::new(
            "invalid_credential",
            format!("Enter a provider API key of at least {MIN_KEY_BYTES} characters."),
        ));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(CommandError::new(
            "credential_too_large",
            format!("Provider API keys are limited to {MAX_KEY_BYTES} bytes."),
        ));
    }
    if key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) || !key.is_ascii() {
        return Err(CommandError::new(
            "invalid_credential",
            "Provider API keys must be printable ASCII without whitespace or control characters.",
        ));
    }
    Ok(key)
}

pub(crate) fn validate_model(model: &str) -> Result<String, CommandError> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_ID_BYTES {
        return Err(CommandError::new(
            "ai_model_invalid",
            format!("Choose a provider model id between 1 and {MAX_MODEL_ID_BYTES} bytes."),
        ));
    }
    let valid = model
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':' | b'/'));
    if !valid {
        return Err(CommandError::new(
            "ai_model_invalid",
            "Model ids may contain only letters, digits, '.', '-', '_', ':' and '/'.",
        ));
    }
    Ok(model.to_string())
}

/// Normalizes renderer turns into (role, content) pairs with provider-neutral roles.
pub(crate) fn validate_messages(messages: &[AiMessage]) -> Result<Vec<(&'static str, String)>, CommandError> {
    if messages.is_empty() {
        return Err(CommandError::new("ai_prompt_empty", "Provide at least one message."));
    }
    if messages.len() > MAX_MESSAGES {
        return Err(CommandError::new(
            "ai_prompt_too_large",
            format!("Provider requests may include at most {MAX_MESSAGES} messages."),
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
                    "ai_prompt_invalid",
                    "Message roles must be `user` or `model`.",
                ))
            }
        };
        let chars = message.content.chars().count();
        if chars == 0 {
            return Err(CommandError::new("ai_prompt_invalid", "Messages cannot be empty."));
        }
        if chars > MAX_MESSAGE_CHARS {
            return Err(CommandError::new(
                "ai_prompt_too_large",
                format!("A single message is limited to {} KiB of text.", MAX_MESSAGE_CHARS / 1024),
            ));
        }
        total_chars += chars;
        output.push((role, message.content.clone()));
    }
    if total_chars > MAX_PROMPT_CHARS {
        return Err(CommandError::new(
            "ai_prompt_too_large",
            format!("The combined prompt is limited to {} KiB of text.", MAX_PROMPT_CHARS / 1024),
        ));
    }
    if output.first().map(|(role, _)| *role) != Some("user") {
        return Err(CommandError::new(
            "ai_prompt_invalid",
            "The first message must come from the user.",
        ));
    }
    Ok(output)
}

pub(crate) fn validate_system(system: &str) -> Result<Option<String>, CommandError> {
    let trimmed = system.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_SYSTEM_CHARS {
        return Err(CommandError::new(
            "ai_prompt_too_large",
            format!("The system instruction is limited to {} KiB.", MAX_SYSTEM_CHARS / 1024),
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn clamp_temperature(provider: AiProvider, value: Option<f64>) -> f64 {
    match value {
        Some(v) if v.is_finite() => v.clamp(0.0, provider.max_temperature()),
        _ => 0.7_f64.min(provider.max_temperature()),
    }
}

pub(crate) fn clamp_output_tokens(value: Option<u64>) -> u64 {
    value.unwrap_or(4096).clamp(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
}

/// Builds the provider-specific JSON body. Pure so it can be unit-tested without a network.
pub(crate) fn build_body(
    provider: AiProvider,
    model: &str,
    system: Option<&str>,
    messages: &[(&'static str, String)],
    temperature: f64,
    max_output_tokens: u64,
) -> Value {
    match provider {
        AiProvider::Anthropic => {
            let mut body = json!({
                "model": model,
                "max_tokens": max_output_tokens,
                "temperature": temperature,
                "messages": messages
                    .iter()
                    .map(|(role, content)| json!({ "role": role, "content": content }))
                    .collect::<Vec<_>>(),
            });
            if let Some(system) = system {
                body["system"] = Value::String(system.to_string());
            }
            body
        }
        AiProvider::Deepseek | AiProvider::Openai => {
            let mut chat = Vec::with_capacity(messages.len() + 1);
            if let Some(system) = system {
                chat.push(json!({ "role": "system", "content": system }));
            }
            chat.extend(
                messages
                    .iter()
                    .map(|(role, content)| json!({ "role": role, "content": content })),
            );
            let mut body = json!({
                "model": model,
                "messages": chat,
                "temperature": temperature,
                "stream": false,
            });
            // OpenAI's newer models reject `max_tokens`; DeepSeek still expects it.
            let key = if provider == AiProvider::Openai { "max_completion_tokens" } else { "max_tokens" };
            body[key] = Value::from(max_output_tokens);
            body
        }
    }
}

/// Builds the authentication headers. The key is moved into the header value and never cloned
/// anywhere else; the request buffer that carries it is dropped when the HTTP call returns.
fn auth_headers(provider: AiProvider, key: &str) -> Vec<HttpHeader> {
    let mut headers = vec![HttpHeader {
        name: "Content-Type".to_string(),
        value: "application/json".to_string(),
    }];
    match provider {
        AiProvider::Anthropic => {
            headers.push(HttpHeader { name: "x-api-key".to_string(), value: key.to_string() });
            headers.push(HttpHeader {
                name: "anthropic-version".to_string(),
                value: ANTHROPIC_VERSION.to_string(),
            });
        }
        AiProvider::Deepseek | AiProvider::Openai => {
            headers.push(HttpHeader {
                name: "Authorization".to_string(),
                value: format!("Bearer {key}"),
            });
        }
    }
    headers
}

/// Extracts text, finish reason and usage from a provider response. Pure and unit-tested.
pub(crate) fn parse_reply(provider: AiProvider, body: &Value) -> Result<(String, String, u64, u64), CommandError> {
    let number = |value: &Value, key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    match provider {
        AiProvider::Anthropic => {
            let text = body
                .get("content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|block| block.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if text.is_empty() && body.get("content").is_none() {
                return Err(CommandError::new(
                    "ai_protocol_error",
                    "Anthropic returned a response without a content array.",
                ));
            }
            let finish = body.get("stop_reason").and_then(Value::as_str).unwrap_or("unknown");
            let usage = body.get("usage").cloned().unwrap_or(Value::Null);
            Ok((text, finish.to_string(), number(&usage, "input_tokens"), number(&usage, "output_tokens")))
        }
        AiProvider::Deepseek | AiProvider::Openai => {
            let choice = body
                .get("choices")
                .and_then(Value::as_array)
                .and_then(|choices| choices.first())
                .ok_or_else(|| {
                    CommandError::new(
                        "ai_protocol_error",
                        format!("{} returned a response without choices.", provider.label()),
                    )
                })?;
            let text = choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let finish = choice.get("finish_reason").and_then(Value::as_str).unwrap_or("unknown");
            let usage = body.get("usage").cloned().unwrap_or(Value::Null);
            Ok((text, finish.to_string(), number(&usage, "prompt_tokens"), number(&usage, "completion_tokens")))
        }
    }
}

pub(crate) fn provider_error_detail(body: &Value) -> String {
    // OpenAI/DeepSeek: {"error":{"message":..}}; Anthropic: {"error":{"message":..}} or {"error":".."}
    let detail = body
        .get("error")
        .map(|error| match error {
            Value::String(text) => text.clone(),
            other => other
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .unwrap_or_default();
    detail.chars().take(400).collect()
}

pub(crate) fn http_status_error(provider: AiProvider, status: u16, status_text: &str, body: &Value) -> CommandError {
    let label = provider.label();
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
        "ai_provider_unauthorized" => " Check the stored API key in Settings → Providers.",
        "ai_provider_billing" => " The provider reports a billing or balance problem for this key.",
        "ai_model_not_found" => " Check the model id in Settings → Providers.",
        "ai_provider_rate_limited" => " Wait before retrying; DevLab does not retry automatically.",
        _ => "",
    };
    CommandError::new(
        code,
        if detail.is_empty() {
            format!("{label} responded with HTTP {status} {status_text}.{hint}")
        } else {
            format!("{label} responded with HTTP {status} {status_text}: {detail}.{hint}")
        },
    )
}

fn transport_error(provider: AiProvider, error: CommandError) -> CommandError {
    match error.code {
        "http_connection_failed" | "http_dns_failed" => CommandError::new(
            "ai_provider_unreachable",
            format!("Could not reach {} ({}): {}", provider.label(), provider.host(), error.message),
        ),
        "http_timeout" => CommandError::new(
            "ai_provider_timeout",
            format!(
                "{} did not answer within DevLab's {GENERATE_TIMEOUT_SECS} s bound: {}",
                provider.label(),
                error.message
            ),
        ),
        _ => error,
    }
}

fn parse_json_body(provider: AiProvider, body: &str, truncated: bool) -> Result<Value, CommandError> {
    if truncated {
        return Err(CommandError::new(
            "ai_response_too_large",
            format!("The {} response exceeded DevLab's response bound and was not parsed.", provider.label()),
        ));
    }
    serde_json::from_str::<Value>(body).map_err(|error| {
        CommandError::new(
            "ai_protocol_error",
            format!("{} returned a response that is not valid JSON: {error}", provider.label()),
        )
    })
}

pub(crate) fn bound_text(text: &str, max_chars: usize) -> (String, bool) {
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

fn chat(request: AiChatRequest) -> Result<AiChatResponse, CommandError> {
    let started = Instant::now();
    let provider = request.provider;
    let model = validate_model(&request.model)?;
    let system = validate_system(&request.system)?;
    let messages = validate_messages(&request.messages)?;
    let temperature = clamp_temperature(provider, request.temperature);
    let max_output_tokens = clamp_output_tokens(request.max_output_tokens);

    let key = {
        let _guard = lock_keyring()?;
        load_key_unlocked(provider)?
    }
    .ok_or_else(|| {
        CommandError::new(
            "ai_credential_missing",
            format!(
                "No {} API key is stored in the {}. Add one in Settings → Providers; DevLab sent nothing.",
                provider.label(),
                keyring_backend()
            ),
        )
    })?;

    let body = build_body(provider, &model, system.as_deref(), &messages, temperature, max_output_tokens);
    let response = send_request_with_timeout(
        HttpRequest {
            method: "POST".to_string(),
            url: provider.chat_url(),
            headers: auth_headers(provider, key.as_str()),
            body: body.to_string(),
            timeout_secs: None,
        },
        Duration::from_secs(GENERATE_TIMEOUT_SECS),
    )
    .map_err(|error| transport_error(provider, error))?;
    drop(key);

    let parsed = parse_json_body(provider, &response.body, response.body_truncated)?;
    if !(200..300).contains(&response.status) {
        return Err(http_status_error(provider, response.status, &response.status_text, &parsed));
    }
    let (raw_text, finish_reason, input_tokens, output_tokens) = parse_reply(provider, &parsed)?;
    let (text, text_truncated) = bound_text(&raw_text, MAX_REPLY_CHARS);
    Ok(AiChatResponse {
        provider,
        host: provider.host(),
        model,
        text,
        text_truncated,
        finish_reason: finish_reason.chars().take(32).collect(),
        input_tokens,
        output_tokens,
        elapsed_ms: elapsed_ms(started),
    })
}

#[tauri::command]
pub async fn ai_credential_status(provider: AiProvider) -> Result<AiCredentialStatus, CommandError> {
    blocking(move || {
        let _guard = lock_keyring()?;
        status_unlocked(provider)
    })
    .await
}

#[tauri::command]
pub async fn ai_credential_store(provider: AiProvider, key: String) -> Result<AiCredentialStatus, CommandError> {
    blocking(move || {
        let _guard = lock_keyring()?;
        let secret = Zeroizing::new(key);
        let key = validate_key(secret.as_str())?;
        entry(provider)?.set_password(key).map_err(keyring_error)?;
        status_unlocked(provider)
    })
    .await
}

#[tauri::command]
pub async fn ai_credential_delete(provider: AiProvider) -> Result<AiCredentialStatus, CommandError> {
    blocking(move || {
        let _guard = lock_keyring()?;
        match entry(provider)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => status_unlocked(provider),
            Err(error) => Err(keyring_error(error)),
        }
    })
    .await
}

#[tauri::command]
pub async fn ai_provider_chat(request: AiChatRequest) -> Result<AiChatResponse, CommandError> {
    blocking(move || chat(request)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> AiMessage {
        AiMessage {
            role: role.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn hosts_and_paths_are_fixed_https() {
        assert_eq!(AiProvider::Deepseek.chat_url(), "https://api.deepseek.com/chat/completions");
        assert_eq!(AiProvider::Openai.chat_url(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(AiProvider::Anthropic.chat_url(), "https://api.anthropic.com/v1/messages");
        for provider in [AiProvider::Deepseek, AiProvider::Openai, AiProvider::Anthropic] {
            assert!(provider.chat_url().starts_with("https://"));
            assert!(crate::http::parse_url(&provider.chat_url()).is_ok());
            assert_ne!(provider.account(), crate::credentials::GitProvider::Github.account());
        }
        assert_ne!(KEYRING_SERVICE, "io.github.talean414.devlab.git");
    }

    #[test]
    fn validates_keys_without_echoing_them() {
        assert_eq!(validate_key("  sk-abcdefghijklmnop  ").unwrap(), "sk-abcdefghijklmnop");
        let short = validate_key("sk-1").unwrap_err();
        assert_eq!(short.code, "invalid_credential");
        assert!(!short.message.contains("sk-1"));
        let spaced = validate_key("sk-abc defghijklmnop").unwrap_err();
        assert_eq!(spaced.code, "invalid_credential");
        assert!(!spaced.message.contains("sk-abc"));
        assert_eq!(validate_key("sk-ключ-not-ascii-123").unwrap_err().code, "invalid_credential");
        assert_eq!(validate_key(&"k".repeat(MAX_KEY_BYTES + 1)).unwrap_err().code, "credential_too_large");
    }

    #[test]
    fn validates_models_and_messages() {
        assert_eq!(validate_model(" gpt-4.1-mini ").unwrap(), "gpt-4.1-mini");
        assert!(validate_model("claude-sonnet-4-5").is_ok());
        assert_eq!(validate_model("bad model").unwrap_err().code, "ai_model_invalid");
        assert_eq!(validate_model("").unwrap_err().code, "ai_model_invalid");
        let converted = validate_messages(&[message("user", "hi"), message("model", "hello")]).unwrap();
        assert_eq!(converted[1].0, "assistant");
        assert_eq!(validate_messages(&[]).unwrap_err().code, "ai_prompt_empty");
        assert_eq!(validate_messages(&[message("system", "x")]).unwrap_err().code, "ai_prompt_invalid");
        assert_eq!(
            validate_messages(&[message("model", "assistant first")]).unwrap_err().code,
            "ai_prompt_invalid"
        );
        assert_eq!(
            validate_messages(&vec![message("user", "x"); MAX_MESSAGES + 1]).unwrap_err().code,
            "ai_prompt_too_large"
        );
        assert_eq!(
            validate_messages(&[message("user", &"x".repeat(MAX_MESSAGE_CHARS + 1))]).unwrap_err().code,
            "ai_prompt_too_large"
        );
        assert_eq!(validate_system(&"s".repeat(MAX_SYSTEM_CHARS + 1)).unwrap_err().code, "ai_prompt_too_large");
        assert_eq!(validate_system("  ").unwrap(), None);
    }

    #[test]
    fn clamps_options_per_provider() {
        assert_eq!(clamp_temperature(AiProvider::Openai, Some(1.5)), 1.5);
        assert_eq!(clamp_temperature(AiProvider::Anthropic, Some(1.5)), 1.0);
        assert_eq!(clamp_temperature(AiProvider::Deepseek, Some(-3.0)), 0.0);
        assert_eq!(clamp_temperature(AiProvider::Anthropic, None), 0.7);
        assert_eq!(clamp_temperature(AiProvider::Openai, Some(f64::INFINITY)), 0.7);
        assert_eq!(clamp_output_tokens(None), 4096);
        assert_eq!(clamp_output_tokens(Some(1)), MIN_OUTPUT_TOKENS);
        assert_eq!(clamp_output_tokens(Some(u64::MAX)), MAX_OUTPUT_TOKENS);
    }

    #[test]
    fn builds_openai_style_bodies() {
        let messages = vec![("user", "hi".to_string()), ("assistant", "hello".to_string())];
        let openai = build_body(AiProvider::Openai, "gpt-4.1-mini", Some("sys"), &messages, 0.5, 1024);
        assert_eq!(openai["model"], "gpt-4.1-mini");
        assert_eq!(openai["stream"], false);
        assert_eq!(openai["messages"][0]["role"], "system");
        assert_eq!(openai["messages"][0]["content"], "sys");
        assert_eq!(openai["messages"][1]["role"], "user");
        assert_eq!(openai["messages"][2]["role"], "assistant");
        assert_eq!(openai["max_completion_tokens"], 1024);
        assert!(openai.get("max_tokens").is_none());

        let deepseek = build_body(AiProvider::Deepseek, "deepseek-chat", None, &messages, 0.5, 1024);
        assert_eq!(deepseek["messages"][0]["role"], "user");
        assert_eq!(deepseek["max_tokens"], 1024);
        assert!(deepseek.get("max_completion_tokens").is_none());
    }

    #[test]
    fn builds_anthropic_bodies() {
        let messages = vec![("user", "hi".to_string())];
        let body = build_body(AiProvider::Anthropic, "claude-sonnet-4-5", Some("sys"), &messages, 0.3, 2048);
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], 2048);
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body.get("stream").is_none());
        let without_system = build_body(AiProvider::Anthropic, "claude-sonnet-4-5", None, &messages, 0.3, 2048);
        assert!(without_system.get("system").is_none());
    }

    #[test]
    fn auth_headers_match_provider_conventions() {
        let openai = auth_headers(AiProvider::Openai, "sk-test");
        assert!(openai.iter().any(|h| h.name == "Authorization" && h.value == "Bearer sk-test"));
        assert!(!openai.iter().any(|h| h.name == "x-api-key"));
        let anthropic = auth_headers(AiProvider::Anthropic, "sk-ant");
        assert!(anthropic.iter().any(|h| h.name == "x-api-key" && h.value == "sk-ant"));
        assert!(anthropic.iter().any(|h| h.name == "anthropic-version" && h.value == ANTHROPIC_VERSION));
        assert!(!anthropic.iter().any(|h| h.name == "Authorization"));
    }

    #[test]
    fn parses_provider_replies() {
        let openai: Value = serde_json::from_str(
            r#"{"choices":[{"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}"#,
        )
        .unwrap();
        assert_eq!(parse_reply(AiProvider::Openai, &openai).unwrap(), ("hello".to_string(), "stop".to_string(), 5, 2));
        assert_eq!(parse_reply(AiProvider::Deepseek, &openai).unwrap().0, "hello");
        let anthropic: Value = serde_json::from_str(
            r#"{"content":[{"type":"text","text":"hel"},{"type":"tool_use","id":"x"},{"type":"text","text":"lo"}],"stop_reason":"end_turn","usage":{"input_tokens":7,"output_tokens":3}}"#,
        )
        .unwrap();
        assert_eq!(
            parse_reply(AiProvider::Anthropic, &anthropic).unwrap(),
            ("hello".to_string(), "end_turn".to_string(), 7, 3)
        );
        assert_eq!(parse_reply(AiProvider::Openai, &json!({})).unwrap_err().code, "ai_protocol_error");
        assert_eq!(parse_reply(AiProvider::Anthropic, &json!({})).unwrap_err().code, "ai_protocol_error");
    }

    #[test]
    fn maps_http_and_transport_errors() {
        let body: Value = serde_json::from_str(r#"{"error":{"message":"Incorrect API key provided: sk-live-123"}}"#).unwrap();
        let unauthorized = http_status_error(AiProvider::Openai, 401, "Unauthorized", &body);
        assert_eq!(unauthorized.code, "ai_provider_unauthorized");
        assert!(unauthorized.message.contains("Settings"));
        assert_eq!(http_status_error(AiProvider::Deepseek, 402, "Payment Required", &Value::Null).code, "ai_provider_billing");
        assert_eq!(http_status_error(AiProvider::Openai, 404, "Not Found", &Value::Null).code, "ai_model_not_found");
        assert_eq!(http_status_error(AiProvider::Anthropic, 429, "Too Many", &json!({"error":"overloaded"})).code, "ai_provider_rate_limited");
        assert_eq!(http_status_error(AiProvider::Anthropic, 529, "Overloaded", &Value::Null).code, "ai_provider_unavailable");
        assert_eq!(http_status_error(AiProvider::Openai, 400, "Bad Request", &Value::Null).code, "ai_provider_http_error");
        assert_eq!(
            transport_error(AiProvider::Openai, CommandError::new("http_dns_failed", "x")).code,
            "ai_provider_unreachable"
        );
        assert_eq!(
            transport_error(AiProvider::Openai, CommandError::new("http_timeout", "x")).code,
            "ai_provider_timeout"
        );
        assert_eq!(
            transport_error(AiProvider::Openai, CommandError::new("http_protocol_error", "x")).code,
            "http_protocol_error"
        );
        assert_eq!(parse_json_body(AiProvider::Openai, "{", false).unwrap_err().code, "ai_protocol_error");
        assert_eq!(parse_json_body(AiProvider::Openai, "{}", true).unwrap_err().code, "ai_response_too_large");
    }

    #[test]
    fn bounds_reply_text() {
        let (text, truncated) = bound_text(&"z".repeat(MAX_REPLY_CHARS + 1), MAX_REPLY_CHARS);
        assert_eq!(text.chars().count(), MAX_REPLY_CHARS);
        assert!(truncated);
        assert_eq!(bound_text("ok", MAX_REPLY_CHARS), ("ok".to_string(), false));
    }
}
