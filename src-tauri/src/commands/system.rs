use crate::models::dto::PingResponse;
use crate::models::error::{AppError, AppResult};

/// Core of `ping`, separated from the Tauri macro so it is unit-testable.
pub fn ping_impl(message: &str) -> AppResult<PingResponse> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::InvalidInput("message must not be empty".into()));
    }
    Ok(PingResponse {
        message: format!("pong: {message}"),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub fn ping(message: String) -> Result<PingResponse, AppError> {
    tracing::debug!("ping received");
    ping_impl(&message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_echoes_message() {
        let r = ping_impl("hello").unwrap();
        assert_eq!(r.message, "pong: hello");
        assert_eq!(r.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn ping_rejects_blank_message() {
        let e = ping_impl("   ").unwrap_err();
        assert_eq!(e.code(), "InvalidInput");
    }
}
