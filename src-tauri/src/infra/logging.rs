use std::path::Path;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::models::error::{AppError, AppResult};

/// Initialise file logging (daily rolling). Keep the returned guard alive for the app lifetime.
/// Logs never include image content.
pub fn init(log_dir: &Path) -> AppResult<WorkerGuard> {
    std::fs::create_dir_all(log_dir)?;
    let appender = tracing_appender::rolling::daily(log_dir, "photom.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(writer).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(guard)
}
