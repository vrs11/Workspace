//! Read-only, capability-scoped media. No absolute paths or file:// access reach
//! the renderer. Each short-lived token owns a pinned, no-follow file handle.
use crate::{
    dto::Media,
    error::{AppError, Result},
    security,
    workspace::Workspace,
};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tauri::{
    Manager,
    http::{Request, Response, StatusCode},
};

const CHUNK: u64 = 4 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 32 * 1024 * 1024;
static READERS: AtomicUsize = AtomicUsize::new(0);
#[derive(Clone)]
pub struct Preview {
    pub info: Media,
    file: Arc<Mutex<File>>,
}
pub type Previews = HashMap<String, Preview>;
fn format(name: &str) -> Option<(&'static str, &'static str)> {
    Some(
        match name.rsplit('.').next()?.to_ascii_lowercase().as_str() {
            "png" => ("image", "image/png"),
            "jpg" | "jpeg" | "jfif" => ("image", "image/jpeg"),
            "gif" => ("image", "image/gif"),
            "webp" => ("image", "image/webp"),
            "avif" => ("image", "image/avif"),
            "bmp" => ("image", "image/bmp"),
            "ico" => ("image", "image/x-icon"),
            "svg" => ("image", "image/svg+xml"),
            "tif" | "tiff" => ("image", "image/tiff"),
            "mp4" | "m4v" => ("video", "video/mp4"),
            "mov" => ("video", "video/quicktime"),
            "webm" => ("video", "video/webm"),
            "ogv" => ("video", "video/ogg"),
            "mkv" => ("video", "video/x-matroska"),
            "mp3" => ("audio", "audio/mpeg"),
            "wav" | "wave" => ("audio", "audio/wav"),
            "m4a" => ("audio", "audio/mp4"),
            "aac" => ("audio", "audio/aac"),
            "ogg" | "oga" | "opus" => ("audio", "audio/ogg"),
            "flac" => ("audio", "audio/flac"),
            "aif" | "aiff" => ("audio", "audio/aiff"),
            _ => return None,
        },
    )
}
impl Workspace {
    pub fn media_open(&mut self, entry: &str) -> Result<Option<Media>> {
        let path = self.entry(entry)?;
        let Some((kind, mime)) = format(&path.to_string_lossy()) else {
            return Ok(None);
        };
        let (parent, leaf) = security::parent(&self.dir, &path)?;
        let file = security::open_read(&parent, &leaf)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(AppError::new(
                "unsupported",
                "Only regular media files can be previewed",
            ));
        }
        if kind == "image" && metadata.len() > IMAGE_LIMIT {
            return Err(AppError::new(
                "resourceLimit",
                "Image exceeds the 32 MiB preview limit. Use an image tool to resize it; the original is unchanged.",
            ));
        }
        self.media.retain(|_, preview| preview.info.entry != entry);
        if self.media.len() >= 64 {
            return Err(AppError::new(
                "resourceLimit",
                "Close a media tab before opening another preview (64 open previews).",
            ));
        }
        let info = Media {
            entry: entry.into(),
            token: uuid::Uuid::new_v4().to_string(),
            name: security::display(&leaf),
            path: security::display(&path),
            kind: kind.into(),
            mime: mime.into(),
            size: metadata.len(),
        };
        self.media.insert(
            info.token.clone(),
            Preview {
                info: info.clone(),
                file: Arc::new(Mutex::new(file)),
            },
        );
        Ok(Some(info))
    }
}

/// A single bounded range. Multipart responses are deliberately unsupported.
fn range(value: Option<&str>, length: u64, kind: &str) -> Option<(u64, u64, bool)> {
    if length == 0 {
        return value.is_none().then_some((0, 0, false));
    }
    let Some(value) = value else {
        let limit = if kind == "image" { IMAGE_LIMIT } else { CHUNK };
        return (length <= limit).then_some((0, length, false));
    };
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>().ok()?.min(length - 1)
        };
        (start, end)
    };
    if start >= length || end < start {
        return None;
    }
    Some((start, (end - start + 1).min(CHUNK), true))
}
fn response(status: StatusCode, bytes: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header(
            "Access-Control-Allow-Origin",
            if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            },
        )
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length",
        )
        .body(bytes)
        .expect("static valid media headers")
}
pub fn read(preview: &Preview, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != "GET" && request.method() != "HEAD" {
        return response(StatusCode::METHOD_NOT_ALLOWED, vec![], "text/plain");
    }
    let length = preview.info.size;
    let selection = if request.method() == "HEAD" {
        Some((0, length, false))
    } else {
        range(
            request.headers().get("Range").and_then(|v| v.to_str().ok()),
            length,
            &preview.info.kind,
        )
    };
    let Some((start, count, partial)) = selection else {
        let mut r = response(StatusCode::RANGE_NOT_SATISFIABLE, vec![], "text/plain");
        r.headers_mut().insert(
            "Content-Range",
            format!("bytes */{length}").parse().expect("numeric range"),
        );
        return r;
    };
    let body = (|| -> Result<Vec<u8>> {
        let mut file = preview
            .file
            .lock()
            .map_err(|_| AppError::new("internal", "Media unavailable"))?;
        if file.metadata()?.len() != length {
            return Err(AppError::conflict("Media changed; reload the preview"));
        }
        if request.method() == "HEAD" {
            return Ok(vec![]);
        }
        file.seek(SeekFrom::Start(start))?;
        let mut body = vec![0; count as usize];
        file.read_exact(&mut body)?;
        Ok(body)
    })();
    let Ok(body) = body else {
        return response(StatusCode::CONFLICT, vec![], "text/plain");
    };
    let mut result = response(
        if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        },
        body,
        &preview.info.mime,
    );
    let headers = result.headers_mut();
    headers.insert("Accept-Ranges", "bytes".parse().expect("static"));
    headers.insert(
        "Content-Length",
        count.to_string().parse().expect("numeric"),
    );
    if partial {
        headers.insert(
            "Content-Range",
            format!("bytes {}-{}/{length}", start, start + count - 1)
                .parse()
                .expect("numeric range"),
        );
    }
    result
}
pub fn protocol(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if context.webview_label() != "main" || READERS.fetch_add(1, Ordering::SeqCst) >= 8 {
        if context.webview_label() == "main" {
            READERS.fetch_sub(1, Ordering::SeqCst);
        }
        responder.respond(response(
            StatusCode::TOO_MANY_REQUESTS,
            vec![],
            "text/plain",
        ));
        return;
    }
    let app = context.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        struct Guard;
        impl Drop for Guard {
            fn drop(&mut self) {
                READERS.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _guard = Guard;
        let preview = (|| {
            let (scope, token) = request.uri().path().strip_prefix('/')?.split_once('/')?;
            if scope.len() != 64 || token.len() != 36 || request.uri().query().is_some() {
                return None;
            }
            let state = app.state::<crate::AppState>();
            // Playback must not wait on the repository/process operation mutex.
            let context = state.terminal_context.read().ok()?;
            let project = context.0.as_ref()?;
            if project.id != scope || security::project_identity(project).ok()? != scope {
                return None;
            }
            let store = state.media_store.lock().ok()?;
            let (authorized, preview) = store.get(token)?;
            (authorized == scope).then(|| preview.clone())
        })();
        responder.respond(match preview {
            Some(preview) => read(&preview, &request),
            None => response(StatusCode::NOT_FOUND, vec![], "text/plain"),
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded_and_strict() {
        assert_eq!(range(Some("bytes=2-9"), 20, "video"), Some((2, 8, true)));
        assert_eq!(range(Some("bytes=-4"), 20, "video"), Some((16, 4, true)));
        assert_eq!(
            range(Some("bytes=5-"), u64::MAX, "video"),
            Some((5, CHUNK, true))
        );
        for bad in [
            "bytes=1-0",
            "bytes=20-",
            "bytes=0-1,3-4",
            "bytes=-0",
            "bytes=a-2",
            "bytes=18446744073709551616-",
        ] {
            assert!(range(Some(bad), 20, "video").is_none(), "{bad}");
        }
        assert!(range(None, CHUNK + 1, "video").is_none());
    }
    #[test]
    fn pinned_read_and_head_do_not_load_whole_media() {
        let mut file = tempfile::tempfile().unwrap();
        use std::io::Write;
        file.write_all(b"0123456789").unwrap();
        let preview = Preview {
            file: Arc::new(Mutex::new(file)),
            info: Media {
                entry: "e".into(),
                token: "t".into(),
                name: "x.mp4".into(),
                path: "x.mp4".into(),
                kind: "video".into(),
                mime: "video/mp4".into(),
                size: 10,
            },
        };
        let r = read(
            &preview,
            &Request::builder()
                .header("Range", "bytes=2-5")
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), b"2345");
        assert_eq!(r.headers()["Content-Range"], "bytes 2-5/10");
        let r = read(
            &preview,
            &Request::builder().method("HEAD").body(vec![]).unwrap(),
        );
        assert!(r.body().is_empty());
        assert_eq!(r.headers()["Content-Length"], "10");
    }
}
