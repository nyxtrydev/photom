use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Typed application error. Serialises to `{ code, message, details }`.
/// Mirrored by `src/types/error.ts`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(String),
    #[error("Decode error: {0}")]
    Decode(String),
    #[error("Unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("Model missing: {0}")]
    ModelMissing(String),
    #[error("Model load failed: {0}")]
    ModelLoad(String),
    #[error("Inference failed: {0}")]
    Inference(String),
    #[error("Out of memory: {0}")]
    OutOfMemory(String),
    #[error("Project corrupt: {0}")]
    ProjectCorrupt(String),
    #[error("Export failed: {0}")]
    ExportFailed(String),
    #[error("Cancelled")]
    Cancelled,
    #[error("Permission denied: {0}")]
    Permission(String),
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable code consumed by the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "Io",
            Self::Decode(_) => "Decode",
            Self::UnsupportedFormat(_) => "UnsupportedFormat",
            Self::ModelMissing(_) => "ModelMissing",
            Self::ModelLoad(_) => "ModelLoad",
            Self::Inference(_) => "Inference",
            Self::OutOfMemory(_) => "OutOfMemory",
            Self::ProjectCorrupt(_) => "ProjectCorrupt",
            Self::ExportFailed(_) => "ExportFailed",
            Self::Cancelled => "Cancelled",
            Self::Permission(_) => "Permission",
            Self::InvalidInput(_) => "InvalidInput",
            Self::Internal(_) => "Internal",
        }
    }

    fn details(&self) -> Option<&str> {
        match self {
            Self::Io(d)
            | Self::Decode(d)
            | Self::UnsupportedFormat(d)
            | Self::ModelMissing(d)
            | Self::ModelLoad(d)
            | Self::Inference(d)
            | Self::OutOfMemory(d)
            | Self::ProjectCorrupt(d)
            | Self::ExportFailed(d)
            | Self::Permission(d)
            | Self::InvalidInput(d)
            | Self::Internal(d) => Some(d.as_str()),
            Self::Cancelled => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("details", &self.details())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::PermissionDenied => Self::Permission(e.to_string()),
            _ => Self::Io(e.to_string()),
        }
    }
}

impl From<image::ImageError> for AppError {
    fn from(e: image::ImageError) -> Self {
        use image::ImageError as E;
        match e {
            E::Unsupported(u) => Self::UnsupportedFormat(u.to_string()),
            E::IoError(io) => io.into(),
            E::Limits(l) => Self::OutOfMemory(l.to_string()),
            other => Self::Decode(other.to_string()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_to_code_message_details() {
        let v = serde_json::to_value(AppError::InvalidInput("empty".into())).unwrap();
        assert_eq!(v["code"], "InvalidInput");
        assert_eq!(v["message"], "Invalid input: empty");
        assert_eq!(v["details"], "empty");
    }

    #[test]
    fn cancelled_has_null_details() {
        let v = serde_json::to_value(AppError::Cancelled).unwrap();
        assert_eq!(v["code"], "Cancelled");
        assert!(v["details"].is_null());
    }

    #[test]
    fn permission_denied_maps_from_io() {
        let e: AppError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(e.code(), "Permission");
    }
}
