use keyring::{error::Error as KeyringError, Entry};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

use crate::workspace::CommandError;

const KEYRING_SERVICE: &str = "io.github.talean414.devlab.git";
const MAX_TOKEN_BYTES: usize = 8 * 1024;
static KEYRING_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitProvider {
    Github,
    Gitlab,
    Bitbucket,
}

impl GitProvider {
    pub(crate) fn host(self) -> &'static str {
        match self {
            Self::Github => "github.com",
            Self::Gitlab => "gitlab.com",
            Self::Bitbucket => "bitbucket.org",
        }
    }

    pub(crate) fn account(self) -> &'static str {
        match self {
            Self::Github => "github.com/personal-access-token",
            Self::Gitlab => "gitlab.com/personal-access-token",
            Self::Bitbucket => "bitbucket.org/access-token",
        }
    }

    pub(crate) fn basic_auth_username(self) -> &'static str {
        match self {
            Self::Github => "x-access-token",
            Self::Gitlab => "oauth2",
            Self::Bitbucket => "x-token-auth",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    provider: GitProvider,
    host: &'static str,
    configured: bool,
    backend: &'static str,
}

fn keyring_backend() -> &'static str {
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

fn entry(provider: GitProvider) -> Result<Entry, CommandError> {
    Entry::new(KEYRING_SERVICE, provider.account()).map_err(keyring_error)
}

fn keyring_error(error: KeyringError) -> CommandError {
    CommandError::new(
        "secure_storage_error",
        format!(
            "The operating-system credential store could not complete the request: {error}"
        ),
    )
}

fn lock_keyring() -> Result<MutexGuard<'static, ()>, CommandError> {
    KEYRING_LOCK.lock().map_err(|_| {
        CommandError::new(
            "secure_storage_unavailable",
            "The secure credential store lock is unavailable.",
        )
    })
}

fn load_git_token_unlocked(
    provider: GitProvider,
) -> Result<Option<Zeroizing<String>>, CommandError> {
    match entry(provider)?.get_password() {
        Ok(token) => Ok(Some(Zeroizing::new(token))),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(keyring_error(error)),
    }
}

pub(crate) fn load_git_token(
    provider: GitProvider,
) -> Result<Option<Zeroizing<String>>, CommandError> {
    let _guard = lock_keyring()?;
    load_git_token_unlocked(provider)
}

fn status_unlocked(provider: GitProvider) -> Result<CredentialStatus, CommandError> {
    Ok(CredentialStatus {
        provider,
        host: provider.host(),
        configured: load_git_token_unlocked(provider)?.is_some(),
        backend: keyring_backend(),
    })
}

fn status(provider: GitProvider) -> Result<CredentialStatus, CommandError> {
    let _guard = lock_keyring()?;
    status_unlocked(provider)
}

#[tauri::command]
pub async fn git_credential_status(
    provider: GitProvider,
) -> Result<CredentialStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || status(provider))
        .await
        .map_err(|_| {
            CommandError::new(
                "secure_storage_unavailable",
                "The secure-storage worker stopped unexpectedly.",
            )
        })?
}

#[tauri::command]
pub async fn git_credential_store(
    provider: GitProvider,
    token: String,
) -> Result<CredentialStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        let secret = Zeroizing::new(token);
        let token = secret.trim();
        if token.is_empty() {
            return Err(CommandError::new(
                "invalid_credential",
                "Enter a non-empty provider token.",
            ));
        }
        if token.len() > MAX_TOKEN_BYTES {
            return Err(CommandError::new(
                "credential_too_large",
                format!("Provider tokens are limited to {MAX_TOKEN_BYTES} bytes."),
            ));
        }
        if token.chars().any(char::is_whitespace) || token.contains('\0') {
            return Err(CommandError::new(
                "invalid_credential",
                "Provider tokens cannot contain whitespace or null characters.",
            ));
        }

        entry(provider)?
            .set_password(token)
            .map_err(keyring_error)?;
        status_unlocked(provider)
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "secure_storage_unavailable",
            "The secure-storage worker stopped unexpectedly.",
        )
    })?
}

#[tauri::command]
pub async fn git_credential_delete(
    provider: GitProvider,
) -> Result<CredentialStatus, CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_keyring()?;
        match entry(provider)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => status_unlocked(provider),
            Err(error) => Err(keyring_error(error)),
        }
    })
    .await
    .map_err(|_| {
        CommandError::new(
            "secure_storage_unavailable",
            "The secure-storage worker stopped unexpectedly.",
        )
    })?
}
