//! Route AppKit's native Quit/Dock termination through the same asynchronous
//! save/PTY decisions as window close. The pinned Tao delegate has no
//! applicationShouldTerminate: implementation; its default Quit calls AppKit
//! directly and never reaches Tauri's preventable ExitRequested event.
use objc2::{
    MainThreadMarker, ffi,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel,
};
use objc2_app_kit::NSApplication;
use std::sync::OnceLock;
use tauri::Manager;

static APPLICATION: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C-unwind" fn should_terminate(
    _delegate: *mut AnyObject,
    _selector: Sel,
    _application: *mut AnyObject,
) -> usize {
    // Never unwind through AppKit and never approve termination before the
    // renderer/native services have acknowledged the normal safe-close flow.
    std::panic::catch_unwind(|| {
        if let Some(app) = APPLICATION.get() {
            if app
                .try_state::<crate::AppState>()
                .is_some_and(|state| state.closing.load(std::sync::atomic::Ordering::SeqCst))
            {
                return 1; // NSTerminateNow, after safe-close acknowledgement
            }
            app.exit(0); // queues the preventable Tauri ExitRequested event
        }
        0 // NSTerminateCancel; the queued safe-close flow owns eventual exit.
    })
    .unwrap_or(0)
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| lifecycle_error("Native quit guard must initialize on the main thread"))?;
    let delegate = NSApplication::sharedApplication(mtm)
        .delegate()
        .ok_or_else(|| lifecycle_error("Native application delegate is unavailable"))?;
    let object: &AnyObject = (&*delegate).as_ref();
    if object
        .class()
        .instance_method(sel!(applicationShouldTerminate:))
        .is_some()
    {
        return Err(lifecycle_error(
            "The native delegate already handles termination; review its integration before building",
        ));
    }
    APPLICATION
        .set(app.clone())
        .map_err(|_| lifecycle_error("Native quit guard was already initialized"))?;
    // SAFETY: the public Objective-C runtime adds an absent, documented
    // NSApplicationDelegate method to this process's live Tao delegate class.
    // We do not replace an upstream implementation or change its object layout.
    // The ABI is NSUInteger(id, SEL, NSApplication*) on supported 64-bit macOS;
    // Q@:@ is its exact type encoding. Runtime classes live for the process.
    let added = unsafe {
        let implementation = std::mem::transmute::<
            extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        ffi::class_addMethod(
            object.class() as *const AnyClass as *mut AnyClass,
            sel!(applicationShouldTerminate:),
            implementation,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        // A future delegate implementation needs deliberate integration, not
        // silent method replacement or an unguarded termination fallback.
        return Err(lifecycle_error("Native quit guard could not be installed"));
    }
    Ok(())
}

fn lifecycle_error(message: &'static str) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(message))
}
