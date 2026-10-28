//! Native PTYs. The bounded byte ring is drained only after xterm has parsed
//! the previous chunk. No text decoding, transcript persistence or input replay.
use crate::{
    dto::{Settings, TerminalChunk, TerminalInfo},
    error::{AppError, Result},
};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Condvar, Mutex, mpsc},
    time::Duration,
};
const OUTPUT_CAP: usize = 256 * 1024;
const READ_CHUNK: usize = 32 * 1024;
struct Output {
    bytes: VecDeque<u8>,
    eof: bool,
    closed: bool,
    info: TerminalInfo,
    token: String,
    sequence: u32,
}
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    output: Mutex<Output>,
    changed: Condvar,
    input: mpsc::SyncSender<Vec<u8>>,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    #[cfg(windows)]
    job: crate::job::Job,
    #[cfg(unix)]
    pid: Option<u32>,
}
#[derive(Default)]
pub struct TerminalService {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> AppError {
    AppError::new("internal", "Terminal service unavailable")
}
fn account_shell() -> Option<String> {
    #[cfg(unix)]
    {
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut result = std::ptr::null_mut();
        // SAFETY: reentrant lookup receives a correctly sized record and live
        // bounded buffer. Copy the shell before either allocation is dropped.
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status != 0 || result.is_null() {
            return None;
        }
        let record = unsafe { record.assume_init() };
        if record.pw_shell.is_null() {
            return None;
        }
        let shell = unsafe { std::ffi::CStr::from_ptr(record.pw_shell) }
            .to_str()
            .ok()?;
        (!shell.is_empty()).then(|| shell.to_owned())
    }
    #[cfg(not(unix))]
    {
        None
    }
}
#[cfg(all(test, unix))]
mod shell_tests {
    #[test]
    fn natural_exit_releases_idle_input_worker_without_waiting_for_close() {
        let root = tempfile::tempdir().unwrap();
        let service = super::TerminalService::default();
        let mut settings = crate::workspace::default_settings();
        settings.shell = Some("/bin/sh".into());
        settings.shell_args = vec!["-c".into(), "exit 7".into()];
        let (info, _) = service
            .open("fixture", root.path(), 80, 24, &settings)
            .unwrap();
        let session = service.get("fixture", &info.id).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if session
                .workers
                .lock()
                .unwrap()
                .iter()
                .all(|worker| worker.is_finished())
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Natural exit left a PTY worker waiting"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(session.output.lock().unwrap().info.exit_code, Some(7));
        service.close("fixture", &info.id).unwrap();
    }

    #[test]
    fn account_shell_is_an_installed_absolute_executable() {
        let shell = super::account_shell().expect("A Unix account must provide its login shell");
        assert!(std::path::Path::new(&shell).is_absolute());
        crate::security::executable(&shell).unwrap();
    }
}
impl TerminalService {
    pub fn len(&self) -> usize {
        self.sessions.lock().map(|s| s.len()).unwrap_or(0)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn get(&self, scope: &str, id: &str) -> Result<Arc<Session>> {
        let s = self
            .sessions
            .lock()
            .map_err(lock_error)?
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("notFound", "Terminal is closed"))?;
        if s.output.lock().map_err(lock_error)?.info.scope != scope {
            return Err(AppError::new(
                "scope",
                "Terminal belongs to another workspace",
            ));
        }
        Ok(s)
    }
    pub fn list(&self, scope: &str) -> Result<Vec<TerminalInfo>> {
        self.sessions
            .lock()
            .map_err(lock_error)?
            .values()
            .map(|s| Ok(s.output.lock().map_err(lock_error)?.info.clone()))
            .filter(|r: &Result<TerminalInfo>| r.as_ref().map_or(true, |i| i.scope == scope))
            .collect()
    }
    pub fn open(
        &self,
        scope: &str,
        root: &Path,
        cols: u16,
        rows: u16,
        settings: &Settings,
    ) -> Result<(TerminalInfo, String)> {
        size(cols, rows)?;
        let mut sessions = self.sessions.lock().map_err(lock_error)?;
        if sessions.len() >= 16 {
            return Err(AppError::limit());
        }
        let shell = settings
            .shell
            .clone()
            .or_else(|| {
                std::env::var(if cfg!(windows) { "COMSPEC" } else { "SHELL" })
                    .ok()
                    .filter(|value| !value.is_empty())
            })
            .or_else(account_shell)
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    "C:\\Windows\\System32\\cmd.exe".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let exe = crate::security::executable(&shell)?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| AppError::new("terminal", "Unable to allocate a native PTY"))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| AppError::new("terminal", "PTY input unavailable"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| AppError::new("terminal", "PTY output unavailable"))?;
        #[cfg(windows)]
        let job = crate::job::Job::new()?;
        let mut cmd = CommandBuilder::new(exe);
        if cfg!(target_os = "macos") && settings.shell.is_none() && settings.shell_args.is_empty() {
            // GUI launches don't inherit a terminal's login environment. Load
            // the user's normal login profile so installed CLI tools resolve.
            cmd.arg("-l");
        } else {
            cmd.args(&settings.shell_args);
        }
        cmd.cwd(root);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        #[cfg(windows)]
        cmd.set_start_suspended(true);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|_| AppError::new("terminal", "Unable to start the selected shell"))?;
        #[cfg(windows)]
        let job = {
            if let Err(error) = child
                .as_raw_handle()
                .ok_or_else(|| AppError::new("processOwnership", "PTY process handle unavailable"))
                .and_then(|handle| {
                    let pid = child.process_id().ok_or_else(|| {
                        AppError::new("processOwnership", "PTY process identity unavailable")
                    })?;
                    job.assign_and_resume(handle, pid)
                })
            {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
            job
        };
        drop(pair.slave);
        let info = TerminalInfo {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.into(),
            shell,
            cwd: root.to_string_lossy().into(),
            cols,
            rows,
            exited: false,
            exit_code: None,
            signal: None,
            error: None,
        };
        let token = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(64);
        let session = Arc::new(Session {
            master: Mutex::new(pair.master),
            output: Mutex::new(Output {
                bytes: VecDeque::new(),
                eof: false,
                closed: false,
                info: info.clone(),
                token: token.clone(),
                sequence: 0,
            }),
            changed: Condvar::new(),
            input: tx,
            workers: Mutex::new(Vec::new()),
            #[cfg(windows)]
            job,
            #[cfg(unix)]
            pid: child.process_id(),
        });
        sessions.insert(info.id.clone(), session.clone());
        let s = session.clone();
        let reader_worker = std::thread::spawn(move || {
            let mut bytes = [0u8; 8192];
            loop {
                let n = match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut out = match s.output.lock() {
                    Ok(o) => o,
                    Err(_) => return,
                };
                while out.bytes.len() + n > OUTPUT_CAP && !out.closed {
                    out = match s.changed.wait(out) {
                        Ok(o) => o,
                        Err(_) => return,
                    };
                }
                if out.closed {
                    // Drain/discard during termination. On macOS a full PTY
                    // write can delay process exit until the master is drained.
                    continue;
                }
                out.bytes.extend(&bytes[..n]);
                s.changed.notify_all();
            }
            if let Ok(mut out) = s.output.lock() {
                out.eof = true;
                s.changed.notify_all();
            }
        });
        let s = session.clone();
        let writer_worker = std::thread::spawn(move || {
            loop {
                // Input and shutdown wake this worker; an idle shell needs no
                // periodic channel timeout or project-state lock acquisition.
                let Ok(data) = rx.recv() else { break };
                if data.is_empty()
                    || s.output
                        .lock()
                        .map(|o| o.closed || o.info.exited)
                        .unwrap_or(true)
                {
                    break;
                }
                if writer
                    .write_all(&data)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    if let Ok(mut out) = s.output.lock() {
                        out.info.error = Some("PTY input failed; input was not replayed".into());
                        s.changed.notify_all();
                    }
                    break;
                }
            }
        });
        let waited = session.clone();
        let wait_worker = std::thread::spawn(move || {
            let status = child.wait();
            if let Ok(mut out) = waited.output.lock() {
                out.info.exited = true;
                match status {
                    Ok(status) => {
                        out.info.exit_code = Some(status.exit_code());
                        out.info.signal = status.signal().map(str::to_string);
                    }
                    Err(_) => out.info.error = Some("Unable to obtain shell exit status".into()),
                }
                waited.changed.notify_all();
            }
            // A queued input already wakes the writer. Otherwise enqueue the
            // existing shutdown marker so natural exit also releases it.
            let _ = waited.input.try_send(Vec::new());
        });
        session.workers.lock().map_err(lock_error)?.extend([
            reader_worker,
            writer_worker,
            wait_worker,
        ]);
        Ok((info, token))
    }
    pub fn attach(&self, scope: &str, id: &str) -> Result<(TerminalInfo, String)> {
        let s = self.get(scope, id)?;
        let mut out = s.output.lock().map_err(lock_error)?;
        out.token = uuid::Uuid::new_v4().to_string();
        out.sequence = 0;
        if !out.info.exited {
            let master = s.master.lock().map_err(lock_error)?;
            let cols = out.info.cols;
            let rows = out.info.rows;
            for (index, width) in [if cols < 1000 { cols + 1 } else { cols - 1 }, cols]
                .into_iter()
                .enumerate()
            {
                master
                    .resize(PtySize {
                        cols: width,
                        rows,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|_| AppError::new("terminal", "Unable to request terminal repaint"))?;
                if index == 0 {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        s.changed.notify_all();
        Ok((out.info.clone(), out.token.clone()))
    }
    pub fn read(&self, scope: &str, id: &str, token: &str) -> Result<TerminalChunk> {
        let s = self.get(scope, id)?;
        let mut out = s.output.lock().map_err(lock_error)?;
        if out.bytes.is_empty()
            && !out.closed
            && !(out.eof && out.info.exited)
            && out.token == token
        {
            out = s
                .changed
                .wait_timeout(out, Duration::from_secs(5))
                .map_err(lock_error)?
                .0;
        }
        attachment(&out, token)?;
        let n = READ_CHUNK.min(out.bytes.len());
        let data = out.bytes.drain(..n).collect();
        let done = out.closed || (out.eof && out.info.exited && out.bytes.is_empty());
        s.changed.notify_all();
        Ok(TerminalChunk {
            data,
            done,
            info: out.info.clone(),
        })
    }
    pub fn write(
        &self,
        scope: &str,
        id: &str,
        token: &str,
        sequence: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        if data.is_empty() || data.len() > 8192 {
            return Err(AppError::limit());
        }
        let s = self.get(scope, id)?;
        let mut out = s.output.lock().map_err(lock_error)?;
        attachment(&out, token)?;
        if out.closed || out.info.exited || out.info.error.is_some() {
            return Err(AppError::new("terminal", "Terminal input is closed"));
        }
        if sequence != out.sequence {
            return Err(AppError::new(
                "sequence",
                "Input sequence changed; input was not replayed",
            ));
        }
        let next = out.sequence.checked_add(1).ok_or_else(AppError::limit)?;
        s.input.try_send(data).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => {
                AppError::new("terminalBusy", "Terminal input queue is full")
            }
            _ => AppError::new("terminal", "Terminal input is closed"),
        })?;
        out.sequence = next;
        Ok(())
    }
    pub fn resize(&self, scope: &str, id: &str, token: &str, cols: u16, rows: u16) -> Result<()> {
        size(cols, rows)?;
        let s = self.get(scope, id)?;
        let mut out = s.output.lock().map_err(lock_error)?;
        attachment(&out, token)?;
        s.master
            .lock()
            .map_err(lock_error)?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| AppError::new("terminal", "Resize failed"))?;
        out.info.cols = cols;
        out.info.rows = rows;
        Ok(())
    }
    pub fn close(&self, scope: &str, id: &str) -> Result<()> {
        let s = self.get(scope, id)?;
        terminate(&s)?;
        self.sessions.lock().map_err(lock_error)?.remove(id);
        Ok(())
    }
    pub fn close_all(&self) {
        let entries = self
            .sessions
            .lock()
            .map(|mut s| std::mem::take(&mut *s))
            .unwrap_or_default();
        for s in entries.values() {
            if terminate(s).is_err() {
                tracing::warn!("Terminal process cleanup was not acknowledged");
            }
        }
    }
}
impl Drop for TerminalService {
    fn drop(&mut self) {
        self.close_all();
    }
}
fn attachment(out: &Output, token: &str) -> Result<()> {
    if out.token != token {
        Err(AppError::new(
            "staleAttachment",
            "This terminal is attached to a newer view",
        ))
    } else {
        Ok(())
    }
}
fn terminate(s: &Session) -> Result<()> {
    if let Ok(mut out) = s.output.lock() {
        out.closed = true;
        out.bytes.clear();
        s.changed.notify_all();
    }
    let _ = s.input.try_send(Vec::new());
    #[cfg(unix)]
    {
        // portable-pty starts a new session. Signal only groups still in that
        // session; never process names, parent groups, or arbitrary renderer PIDs.
        if let Some(pid) = s.pid {
            let pid = pid as libc::pid_t;
            let fg = s.master.lock().ok().and_then(|m| m.process_group_leader());
            for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGKILL] {
                let mut members = owned_session_members(pid);
                members.push(pid);
                if let Some(fg) = fg {
                    members.push(fg);
                }
                let mut groups = std::collections::HashSet::new();
                for member in members {
                    // Revalidate membership immediately before signalling.
                    unsafe {
                        if libc::getsid(member) == pid {
                            let pgid = libc::getpgid(member);
                            if pgid > 0 && groups.insert(pgid) {
                                libc::kill(-pgid, libc::SIGCONT);
                                libc::kill(-pgid, signal);
                            }
                        }
                    }
                }
                if groups.is_empty() {
                    break;
                }
                if signal != libc::SIGKILL {
                    std::thread::sleep(Duration::from_millis(80));
                }
            }
        }
    }
    #[cfg(windows)]
    s.job.terminate()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut out = s.output.lock().map_err(lock_error)?;
    while !out.info.exited && std::time::Instant::now() < deadline {
        out = s
            .changed
            .wait_timeout(out, Duration::from_millis(50))
            .map_err(lock_error)?
            .0;
    }
    if !out.info.exited {
        return Err(AppError::new(
            "unknownOutcome",
            "Shell termination was not acknowledged. Inspect running jobs before retrying.",
        ));
    }
    drop(out);
    loop {
        let mut workers = s.workers.lock().map_err(lock_error)?;
        if workers.iter().all(|worker| worker.is_finished()) {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
            break;
        }
        drop(workers);
        if std::time::Instant::now() >= deadline {
            return Err(AppError::new(
                "unknownOutcome",
                "PTY I/O cleanup did not finish; session retained for inspection",
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}
fn size(cols: u16, rows: u16) -> Result<()> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        Err(AppError::new("input", "Invalid terminal dimensions"))
    } else {
        Ok(())
    }
}

pub fn validate_layout(layout: &crate::dto::TerminalLayout) -> Result<()> {
    if layout.version != 1 {
        return Err(AppError::new(
            "stateVersion",
            "Unsupported terminal layout version; original state retained",
        ));
    }
    use crate::dto::TerminalNode;
    use std::collections::HashSet;
    fn walk(
        n: &TerminalNode,
        depth: usize,
        ids: &mut HashSet<String>,
        count: &mut usize,
    ) -> Result<()> {
        if depth > 8 {
            return Err(AppError::limit());
        }
        let id = match n {
            TerminalNode::Pane { id, .. } | TerminalNode::Split { id, .. } => id,
        };
        if uuid::Uuid::parse_str(id).is_err() || !ids.insert(id.clone()) {
            return Err(AppError::new(
                "input",
                "Invalid terminal layout identifiers",
            ));
        }
        match n {
            TerminalNode::Pane { session, .. } => {
                *count += 1;
                if session
                    .as_ref()
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_err())
                {
                    return Err(AppError::limit());
                }
            }
            TerminalNode::Split {
                direction,
                ratio,
                first,
                second,
                ..
            } => {
                if !["horizontal", "vertical"].contains(&direction.as_str())
                    || !ratio.is_finite()
                    || !(10.0..=90.0).contains(ratio)
                {
                    return Err(AppError::new("input", "Invalid terminal split geometry"));
                }
                walk(first, depth + 1, ids, count)?;
                walk(second, depth + 1, ids, count)?;
            }
        }
        Ok(())
    }
    let mut ids = HashSet::new();
    let mut count = 0;
    if layout.tabs.len() > 8 {
        return Err(AppError::limit());
    }
    for tab in &layout.tabs {
        if uuid::Uuid::parse_str(&tab.id).is_err()
            || !ids.insert(tab.id.clone())
            || tab.title.is_empty()
            || tab.title.len() > 120
            || tab.title.chars().any(char::is_control)
        {
            return Err(AppError::new("input", "Invalid terminal tab"));
        }
        walk(&tab.root, 0, &mut ids, &mut count)?;
    }
    if count > 16
        || layout
            .active
            .as_ref()
            .is_some_and(|a| !layout.tabs.iter().any(|t| t.id == *a))
    {
        return Err(AppError::limit());
    }
    Ok(())
}

#[cfg(unix)]
fn owned_session_members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    #[cfg(target_os = "macos")]
    let pids = {
        // Snapshot process identifiers only; never inspect arguments or contents.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) }.max(0) as usize;
        let mut pids = vec![0 as libc::pid_t; (count + 1024).min(1_000_000)];
        let len = unsafe {
            libc::proc_listallpids(
                pids.as_mut_ptr().cast(),
                (pids.len() * std::mem::size_of::<libc::pid_t>()) as i32,
            )
        }
        .max(0) as usize;
        pids.truncate(len.min(pids.len()));
        pids
    };
    #[cfg(target_os = "linux")]
    let pids = std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<libc::pid_t>().ok())
        .take(1_000_000)
        .collect::<Vec<_>>();
    pids.into_iter()
        .filter(|pid| *pid > 0 && unsafe { libc::getsid(*pid) == sid })
        .collect()
}
