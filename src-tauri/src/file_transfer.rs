//! Native file offers are short-lived, single-use capabilities minted by OS drops.
use crate::error::{AppError, Result};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct FileTransfers(Mutex<VecDeque<Offer>>);
struct Offer {
    id: String,
    paths: Vec<PathBuf>,
    created: Instant,
}
impl FileTransfers {
    pub fn offer(&self, paths: Vec<PathBuf>) -> Option<String> {
        if paths.is_empty() || paths.len() > 100 {
            return None;
        }
        let mut offers = self.0.lock().ok()?;
        offers.retain(|o| o.created.elapsed() < Duration::from_secs(120));
        while offers.len() >= 8 {
            offers.pop_front();
        }
        let id = uuid::Uuid::new_v4().to_string();
        offers.push_back(Offer {
            id: id.clone(),
            paths,
            created: Instant::now(),
        });
        Some(id)
    }
    pub fn peek(&self, id: &str) -> Result<Vec<PathBuf>> {
        let offers = self
            .0
            .lock()
            .map_err(|_| AppError::new("internal", "File drop unavailable"))?;
        offers
            .iter()
            .find(|o| o.id == id && o.created.elapsed() < Duration::from_secs(120))
            .map(|o| o.paths.clone())
            .ok_or_else(|| AppError::new("scope", "The file drop expired. Drop the files again."))
    }
    pub fn take(&self, id: &str) -> Result<Vec<PathBuf>> {
        let mut offers = self
            .0
            .lock()
            .map_err(|_| AppError::new("internal", "File drop unavailable"))?;
        offers.retain(|o| o.created.elapsed() < Duration::from_secs(120));
        let index = offers.iter().position(|o| o.id == id).ok_or_else(|| {
            AppError::new("scope", "The file drop expired. Drop the files again.")
        })?;
        Ok(offers.remove(index).expect("located offer").paths)
    }
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEvent {
    phase: &'static str,
    x: f64,
    y: f64,
    offer: Option<String>,
    folder: Option<String>,
    error: Option<&'static str>,
}
pub fn webview_event(webview: &tauri::Webview, event: &tauri::WebviewEvent) {
    if let tauri::WebviewEvent::DragDrop(event) = event {
        window_event(&webview.window(), event);
    }
}
pub fn window_event(window: &tauri::Window, event: &tauri::DragDropEvent) {
    let Ok(state) = crate::windows::state(window.app_handle(), window.label()) else {
        return;
    };
    let (phase, position, paths) = match event {
        tauri::DragDropEvent::Enter { paths, position } => ("over", Some(position), Some(paths)),
        tauri::DragDropEvent::Over { position } => ("over", Some(position), None),
        tauri::DragDropEvent::Drop { paths, position } => ("drop", Some(position), Some(paths)),
        tauri::DragDropEvent::Leave => ("leave", None, None),
        _ => return,
    };
    #[cfg(feature = "desktop-test")]
    eprintln!(
        "native_file_event phase={phase} x={} y={} count={}",
        position.map_or(0., |p| p.x),
        position.map_or(0., |p| p.y),
        paths.map_or(0, |p| p.len())
    );
    let offer = if phase == "drop" {
        paths.and_then(|p| state.files.offer(p.clone()))
    } else {
        None
    };
    let folder = if phase == "drop" {
        paths
            .and_then(|p| p.first())
            .and_then(|p| p.parent())
            .and_then(|p| p.to_str())
            .map(str::to_owned)
    } else {
        None
    };
    // WKWebView reports AppKit points; Windows/GTK report physical pixels.
    #[cfg(target_os = "macos")]
    let scale = 1.;
    #[cfg(not(target_os = "macos"))]
    let scale = window.scale_factor().unwrap_or(1.);
    let _ = window.emit(
        "workspace-native-file",
        FileEvent {
            phase,
            x: position.map_or(0., |p| p.x / scale),
            y: position.map_or(0., |p| p.y / scale),
            offer,
            folder,
            error: if phase == "drop" && paths.is_some_and(|paths| paths.len() > 100) {
                Some("Drop up to 100 files or folders at a time.")
            } else {
                None
            },
        },
    );
}
pub async fn start_drag(
    window: tauri::WebviewWindow,
    scope: String,
    entries: Vec<String>,
) -> Result<crate::dto::Response> {
    let host = crate::windows::state(window.app_handle(), window.label())?
        .host
        .clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| AppError::new("internal", "Workspace unavailable"))?
            .project(&scope, true, true)?
            .drag_paths(&entries)
    })
    .await
    .map_err(|_| AppError::new("internal", "File drag worker failed"))??;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        let raw_window = window.gtk_window();
        #[cfg(not(target_os = "linux"))]
        let raw_window = tauri::Result::Ok(window.clone());
        let emitter = window.clone();
        let result = raw_window
            .map_err(|_| AppError::new("window", "File drag window unavailable"))
            .and_then(|raw| {
                drag::start_drag(
                    &raw,
                    drag::DragItem::Files(paths),
                    drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
                    move |_, _| {
                        let _ = emitter.emit("workspace-native-file-end", ());
                    },
                    drag::Options {
                        mode: drag::DragMode::Move,
                        ..Default::default()
                    },
                )
                .map_err(|_| {
                    AppError::new(
                        "drag",
                        "Could not start dragging. Keep the mouse button held and try again.",
                    )
                })
            });
        let _ = tx.send(result);
    })
    .map_err(|_| AppError::new("window", "File drag window unavailable"))?;
    rx.await
        .map_err(|_| AppError::new("internal", "File drag was interrupted"))??;
    Ok(crate::dto::Response::Ok)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_single_use_os_offers_are_accepted() {
        let offers = FileTransfers::default();
        assert!(offers.offer(vec![]).is_none());
        assert!(offers.offer(vec![PathBuf::from("fixture"); 101]).is_none());
        assert!(offers.take("forged").is_err());
        let id = offers.offer(vec![PathBuf::from("fixture")]).unwrap();
        assert_eq!(offers.take(&id).unwrap(), vec![PathBuf::from("fixture")]);
        assert!(offers.take(&id).is_err());
        let old = offers.offer(vec![PathBuf::from("old")]).unwrap();
        for _ in 0..8 {
            offers.offer(vec![PathBuf::from("new")]);
        }
        assert!(offers.take(&old).is_err());
        let stale = offers.offer(vec![PathBuf::from("stale")]).unwrap();
        offers.0.lock().unwrap().back_mut().unwrap().created =
            Instant::now() - Duration::from_secs(121);
        assert!(offers.take(&stale).is_err());
    }
}
