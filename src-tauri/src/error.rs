use serde::Serialize;
use ts_rs::TS;

pub type Result<T> = std::result::Result<T, AppError>;
#[derive(Debug, Serialize, TS, thiserror::Error)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub operation_id: String,
}
impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            operation_id: uuid::Uuid::new_v4().to_string(),
        }
    }
    pub fn file_context(mut self, action: &str, path: &std::path::Path) -> Self {
        let name = path.to_str().map(str::to_owned).unwrap_or_else(|| {
            format!(
                "{} [non-UTF-8]",
                path.as_os_str().to_string_lossy().escape_default()
            )
        });
        self.message = match self.code.as_str() {
            "alreadyExists" => format!(
                "“{name}” already exists in the destination folder. Choose a different name or folder."
            ),
            "permissionDenied" => format!(
                "Couldn’t {action} “{name}”. Check the destination folder’s permissions or choose another folder."
            ),
            "notFound" => format!(
                "Couldn’t {action} “{name}”: the item or destination folder no longer exists. Refresh the explorer and try again."
            ),
            "diskFull" => format!(
                "Couldn’t {action} “{name}”: the disk is full. Free some space and try again."
            ),
            "readOnly" => format!(
                "Couldn’t {action} “{name}”: this location is read-only. Choose a writable folder."
            ),
            "io" => format!("Couldn’t {action} “{name}”. Check the folder and try again."),
            _ => self.message,
        };
        self
    }
    pub fn conflict(message: &str) -> Self {
        Self::new("conflict", message)
    }
    pub fn limit() -> Self {
        Self::new(
            "resourceLimit",
            "Operation exceeded its bounded resource limit",
        )
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let (code, message) = match e.kind() {
            std::io::ErrorKind::NotFound => (
                "notFound",
                "The requested item could not be found. Refresh the project or check the configured program path.",
            ),
            std::io::ErrorKind::PermissionDenied => (
                "permissionDenied",
                "Access was denied. Check the file or folder permissions and try again.",
            ),
            std::io::ErrorKind::AlreadyExists => (
                "alreadyExists",
                "A file or folder with that name already exists. Choose a different name.",
            ),
            std::io::ErrorKind::StorageFull => (
                "diskFull",
                "The disk is full. Free some space and try again.",
            ),
            std::io::ErrorKind::ReadOnlyFilesystem => (
                "readOnly",
                "This location is read-only. Choose a writable folder.",
            ),
            std::io::ErrorKind::DirectoryNotEmpty => (
                "directoryNotEmpty",
                "This folder is not empty. Move or remove its contents first.",
            ),
            std::io::ErrorKind::TimedOut => (
                "timeout",
                "The operation took too long. Check the connection or program and try again.",
            ),
            std::io::ErrorKind::Interrupted => (
                "interrupted",
                "The operation was interrupted. Check its result before trying again.",
            ),
            _ => (
                "io",
                "The operating system could not complete the operation. Check the location and try again.",
            ),
        };
        // Never include file contents, environment or process arguments.
        Self::new(code, message)
    }
}
impl From<serde_json::Error> for AppError {
    fn from(_: serde_json::Error) -> Self {
        Self::new("protocol", "Invalid structured data")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_errors_explain_the_conflict_without_losing_the_reference() {
        let error: AppError = std::io::Error::from(std::io::ErrorKind::AlreadyExists).into();
        let id = error.operation_id.clone();
        let error = error.file_context("create", std::path::Path::new("src/existing.ts"));
        assert_eq!(error.code, "alreadyExists");
        assert_eq!(error.operation_id, id);
        assert!(error.message.contains("src/existing.ts"));
        assert!(error.message.contains("Choose a different"));
        assert!(!error.message.contains("Filesystem/process"));
        let denied: AppError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(denied.code, "permissionDenied");
        assert!(
            denied
                .file_context("move", std::path::Path::new("target/a"))
                .message
                .contains("permissions")
        );
    }
}
