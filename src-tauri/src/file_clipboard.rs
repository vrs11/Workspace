//! Native file-list clipboard formats, read only after an explicit Paste action.
//! Text paths are never interpreted as file capabilities.
use crate::error::{AppError, Result};
use std::path::PathBuf;
fn validate(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>> {
    if paths.is_empty() {
        return Err(AppError::new(
            "clipboard",
            "The clipboard contains no files. Copy files in Explorer or your system file manager first.",
        ));
    }
    if paths.len() > 100
        || paths
            .iter()
            .any(|p| !p.is_absolute() || p.as_os_str().len() > 8192)
    {
        return Err(AppError::new(
            "resourceLimit",
            "Paste up to 100 local files or folders at a time.",
        ));
    }
    Ok(paths)
}
fn file_url(value: &str) -> Result<PathBuf> {
    if value.len() > 32768 {
        return Err(AppError::limit());
    }
    let url = tauri::Url::parse(value).map_err(|_| {
        AppError::new(
            "clipboard",
            "The clipboard contains an invalid file reference.",
        )
    })?;
    if url.scheme() != "file"
        || url
            .host_str()
            .is_some_and(|host| !host.is_empty() && host != "localhost")
    {
        return Err(AppError::new(
            "clipboard",
            "Only local file references can be pasted into Explorer.",
        ));
    }
    url.to_file_path().map_err(|_| {
        AppError::new(
            "clipboard",
            "The clipboard file reference cannot be opened.",
        )
    })
}
/// Availability only: no file contents, filesystem access or clipboard writes.
pub async fn has_files(app: tauri::AppHandle) -> Result<bool> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || platform::has_files(tx))
        .map_err(|_| AppError::new("clipboard", "The system clipboard is unavailable."))?;
    tokio::time::timeout(std::time::Duration::from_secs(2), rx)
        .await
        .map_err(|_| AppError::new("clipboard", "Clipboard availability timed out."))?
        .map_err(|_| AppError::new("clipboard", "Clipboard availability was interrupted."))?
}
pub async fn read(app: tauri::AppHandle) -> Result<Vec<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || platform::read(tx))
        .map_err(|_| AppError::new("clipboard", "The system clipboard is unavailable."))?;
    validate(
        rx.await.map_err(|_| {
            AppError::new("clipboard", "Reading the file clipboard was interrupted.")
        })??,
    )
}
pub async fn write(app: tauri::AppHandle, paths: Vec<PathBuf>) -> Result<()> {
    let paths = validate(paths)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::write(&paths));
    })
    .map_err(|_| AppError::new("clipboard", "The system clipboard is unavailable."))?;
    rx.await.map_err(|_| {
        AppError::new(
            "clipboard",
            "Copying files to the clipboard was interrupted.",
        )
    })?
}
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::{
        rc::autoreleasepool,
        runtime::{AnyObject, ProtocolObject},
    };
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};
    fn board_has_files(board: &NSPasteboard) -> bool {
        let legacy = NSString::from_str("NSFilenamesPboardType");
        // SAFETY: Apple's immutable declared file-URL type. Query format
        // availability only; do not materialize paths or trigger file reads.
        let types = NSArray::from_slice(&[unsafe { NSPasteboardTypeFileURL }, &legacy]);
        board.availableTypeFromArray(&types).is_some()
    }
    pub fn has_files(tx: tokio::sync::oneshot::Sender<Result<bool>>) {
        let _ = tx.send(Ok(autoreleasepool(|_| {
            board_has_files(&NSPasteboard::generalPasteboard())
        })));
    }
    pub fn write(paths: &[PathBuf]) -> Result<()> {
        write_board(&NSPasteboard::generalPasteboard(), paths)
    }
    fn write_board(board: &NSPasteboard, paths: &[PathBuf]) -> Result<()> {
        autoreleasepool(|_| {
            let mut items = Vec::new();
            for path in paths {
                let url = tauri::Url::from_file_path(path).map_err(|_| {
                    AppError::new(
                        "clipboard",
                        "This filename cannot be copied to the system clipboard.",
                    )
                })?;
                let item = NSURL::URLWithString(&NSString::from_str(url.as_str()))
                    .ok_or_else(|| AppError::new("clipboard", "Invalid native file URL."))?;
                items.push(item);
            }
            let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items
                .iter()
                .map(|item| ProtocolObject::from_ref(&**item))
                .collect();
            board.clearContents();
            if !board.writeObjects(&NSArray::from_slice(&objects)) {
                return Err(AppError::new(
                    "clipboard",
                    "The system could not copy the selected files.",
                ));
            }
            Ok(())
        })
    }
    pub fn read(tx: tokio::sync::oneshot::Sender<Result<Vec<PathBuf>>>) {
        let _ = tx.send(read_board(&NSPasteboard::generalPasteboard()));
    }
    fn read_board(board: &NSPasteboard) -> Result<Vec<PathBuf>> {
        autoreleasepool(|_| {
            let version = board.changeCount();
            let mut paths = Vec::new();
            if let Some(items) = board.pasteboardItems() {
                if items.len() > 100 {
                    return Err(AppError::limit());
                }
                for item in items.iter() {
                    if let Some(value) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                        paths.push(file_url(&value.to_string())?);
                    }
                }
            }
            if paths.is_empty() {
                // Older applications still publish the documented filenames list.
                if let Some(value) =
                    board.propertyListForType(&NSString::from_str("NSFilenamesPboardType"))
                {
                    if let Some(items) = value.downcast_ref::<NSArray<AnyObject>>() {
                        if items.len() > 100 {
                            return Err(AppError::limit());
                        }
                        for item in items.iter() {
                            let name = item.downcast_ref::<NSString>().ok_or_else(|| {
                                AppError::new("clipboard", "Invalid system file list.")
                            })?;
                            paths.push(PathBuf::from(name.to_string()));
                        }
                    }
                }
            }
            if version != board.changeCount() {
                return Err(AppError::new(
                    "clipboard",
                    "The clipboard changed while reading. Paste again.",
                ));
            }
            Ok(paths)
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn native_named_pasteboard_roundtrip_and_legacy_file_lists_keep_text_separate() {
            // A separate native pasteboard exercises AppKit without modifying
            // the user's general clipboard or taking foreground focus.
            let board = NSPasteboard::pasteboardWithUniqueName();
            assert!(!board_has_files(&board));
            let paths = vec![
                PathBuf::from("/fixture/a space #🌍.txt"),
                PathBuf::from("/fixture/folder"),
            ];
            write_board(&board, &paths).unwrap();
            assert!(board_has_files(&board));
            assert_eq!(read_board(&board).unwrap(), paths);
            let items = board.pasteboardItems().unwrap();
            assert_eq!(items.len(), 2);
            assert!(items.iter().all(|item| {
                item.stringForType(unsafe { NSPasteboardTypeFileURL })
                    .is_some()
            }));
            board.clearContents();
            board.setString_forType(
                &NSString::from_str("/a/plain/text/path"),
                &NSString::from_str("public.utf8-plain-text"),
            );
            assert!(!board_has_files(&board));
            assert!(read_board(&board).unwrap().is_empty());
            board.clearContents();
            let legacy = NSArray::from_retained_slice(&[NSString::from_str("/fixture/legacy")]);
            // SAFETY: an NSArray of NSString is the documented legacy format.
            assert!(unsafe {
                board.setPropertyList_forType(
                    legacy.as_ref(),
                    &NSString::from_str("NSFilenamesPboardType"),
                )
            });
            assert!(board_has_files(&board));
            assert_eq!(
                read_board(&board).unwrap(),
                vec![PathBuf::from("/fixture/legacy")]
            );
            board.clearContents();
        }
    }
}
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use gtk::{Clipboard, TargetEntry, TargetFlags, gdk};
    pub fn has_files(tx: tokio::sync::oneshot::Sender<Result<bool>>) {
        // URI lists can also contain web links. Check bounded local-file
        // references without touching the referenced files or ordinary text.
        Clipboard::get(&gdk::SELECTION_CLIPBOARD).request_uris(move |_, uris| {
            let available = !uris.is_empty()
                && uris.len() <= 100
                && uris.iter().all(|uri| file_url(uri.as_str()).is_ok());
            let _ = tx.send(Ok(available));
        });
    }
    pub fn write(paths: &[PathBuf]) -> Result<()> {
        let urls = paths
            .iter()
            .map(|p| {
                tauri::Url::from_file_path(p)
                    .map(|u| u.to_string())
                    .map_err(|_| AppError::new("clipboard", "Invalid local filename."))
            })
            .collect::<Result<Vec<_>>>()?;
        let targets = [
            TargetEntry::new("text/uri-list", TargetFlags::empty(), 0),
            TargetEntry::new("x-special/gnome-copied-files", TargetFlags::empty(), 1),
        ];
        let clipboard = Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        if !clipboard.set_with_data(&targets, move |_, data, info| {
            let value = if info == 1 {
                format!("copy\n{}", urls.join("\n"))
            } else {
                format!("{}\r\n", urls.join("\r\n"))
            };
            data.set(&data.target(), 8, value.as_bytes());
        }) {
            return Err(AppError::new(
                "clipboard",
                "The system could not copy the selected files.",
            ));
        }
        use gtk::glib::translate::ToGlibPtr;
        // Persist the offered file formats through an available clipboard
        // manager when Workspace exits; null/zero means all offered targets.
        unsafe {
            gtk::ffi::gtk_clipboard_set_can_store(
                clipboard.to_glib_none().0,
                std::ptr::null_mut(),
                0,
            );
        }
        clipboard.store();
        Ok(())
    }
    pub fn read(tx: tokio::sync::oneshot::Sender<Result<Vec<PathBuf>>>) {
        Clipboard::get(&gdk::SELECTION_CLIPBOARD).request_uris(move |_, uris| {
            let result = if uris.len() > 100 {
                Err(AppError::limit())
            } else {
                uris.iter().map(|u| file_url(u.as_str())).collect()
            };
            let _ = tx.send(result);
        });
    }
}
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::OsString,
        mem::size_of,
        os::windows::ffi::{OsStrExt, OsStringExt},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::GlobalFree,
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
            },
            Memory::{GMEM_MOVEABLE, GMEM_ZEROINIT, GlobalAlloc, GlobalLock, GlobalUnlock},
        },
        UI::Shell::{DROPFILES, DragQueryFileW},
    };
    struct Open;
    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    fn open() -> Result<Open> {
        if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
            return Err(AppError::new(
                "clipboard",
                "The clipboard is busy. Try copying or pasting again.",
            ));
        }
        Ok(Open)
    }
    pub fn has_files(tx: tokio::sync::oneshot::Sender<Result<bool>>) {
        // SAFETY: pure format query; no clipboard handle or memory access.
        let available =
            unsafe { windows_sys::Win32::System::DataExchange::IsClipboardFormatAvailable(15) }
                != 0;
        let _ = tx.send(Ok(available));
    }
    pub fn write(paths: &[PathBuf]) -> Result<()> {
        let mut names = Vec::new();
        for path in paths {
            names.extend(path.as_os_str().encode_wide());
            names.push(0);
        }
        names.push(0);
        let _open = open()?;
        unsafe {
            let memory = GlobalAlloc(
                GMEM_MOVEABLE | GMEM_ZEROINIT,
                size_of::<DROPFILES>() + names.len() * 2,
            );
            if memory.is_null() {
                return Err(AppError::limit());
            }
            let pointer = GlobalLock(memory);
            if pointer.is_null() {
                GlobalFree(memory);
                return Err(AppError::limit());
            }
            let header = DROPFILES {
                pFiles: size_of::<DROPFILES>() as u32,
                pt: std::mem::zeroed(),
                fNC: 0,
                fWide: 1,
            };
            ptr::write(pointer.cast::<DROPFILES>(), header);
            ptr::copy_nonoverlapping(
                names.as_ptr(),
                pointer
                    .cast::<u8>()
                    .add(size_of::<DROPFILES>())
                    .cast::<u16>(),
                names.len(),
            );
            GlobalUnlock(memory);
            if EmptyClipboard() == 0 || SetClipboardData(15, memory).is_null() {
                GlobalFree(memory);
                return Err(AppError::new(
                    "clipboard",
                    "The system could not copy the selected files.",
                ));
            }
        }
        Ok(())
    }
    pub fn read(tx: tokio::sync::oneshot::Sender<Result<Vec<PathBuf>>>) {
        let result = (|| {
            let _open = open()?;
            unsafe {
                let drop = GetClipboardData(15);
                if drop.is_null() {
                    return Ok(vec![]);
                }
                let count = DragQueryFileW(drop, u32::MAX, ptr::null_mut(), 0);
                if count > 100 {
                    return Err(AppError::limit());
                }
                let mut paths = Vec::new();
                for i in 0..count {
                    let length = DragQueryFileW(drop, i, ptr::null_mut(), 0);
                    if length > 8192 {
                        return Err(AppError::limit());
                    }
                    let mut name = vec![0; length as usize + 1];
                    if DragQueryFileW(drop, i, name.as_mut_ptr(), name.len() as u32) != length {
                        return Err(AppError::new("clipboard", "Invalid system file reference."));
                    }
                    name.pop();
                    paths.push(OsString::from_wide(&name).into());
                }
                Ok(paths)
            }
        })();
        let _ = tx.send(result);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_bounded_native_local_file_lists_not_plain_text_or_remote_urls() {
        assert!(validate(vec![]).is_err());
        assert!(validate(vec![PathBuf::from("relative")]).is_err());
        assert!(validate(vec![PathBuf::from("/fixture"); 101]).is_err());
        for value in [
            "https://example.invalid/file",
            "/a/text/path",
            "file://remote.invalid/file",
        ] {
            assert!(file_url(value).is_err());
        }
        #[cfg(unix)]
        assert_eq!(
            file_url("file:///fixture/a%20file%23.txt").unwrap(),
            PathBuf::from("/fixture/a file#.txt")
        );
    }
}
