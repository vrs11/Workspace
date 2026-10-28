//! One-operation authenticated local askpass bridge. No passwords are logged or persisted.
use crate::{
    EventBus,
    dto::StreamEvent,
    error::{AppError, Result},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, mpsc},
};
pub type Pending = Arc<Mutex<HashMap<String, (String, mpsc::SyncSender<Option<String>>)>>>;
pub struct CredentialSession {
    pub environment: Vec<(String, String)>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    _directory: tempfile::TempDir,
    pending: Pending,
    scope: String,
}
fn handle_request(
    mut socket: impl std::io::Read + std::io::Write,
    secret: &str,
    scope: &str,
    callbacks: &Pending,
    bus: &Arc<EventBus>,
    stop: &std::sync::atomic::AtomicBool,
) {
    use std::{
        io::{BufRead, BufReader, Read},
        time::Duration,
    };
    let mut request = String::new();
    let read = BufReader::new(&mut socket)
        .take(4096)
        .read_line(&mut request);
    if read.is_err() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&request) else {
        return;
    };
    if value.get("token").and_then(|v| v.as_str()) != Some(secret) {
        return;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel(1);
    if let Ok(mut map) = callbacks.lock() {
        if stop.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        map.insert(id.clone(), (scope.to_owned(), tx));
    } else {
        return;
    }
    let prompt = value
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("Credential required");
    let prompt = prompt
        .split_whitespace()
        .map(|w| if w.contains("://") { "[remote]" } else { w })
        .collect::<Vec<_>>()
        .join(" ");
    bus.emit_wait(StreamEvent::Credential {
        scope: scope.to_owned(),
        request: id.clone(),
        prompt: prompt.chars().take(1024).collect(),
    });
    let answer = rx.recv_timeout(Duration::from_secs(90)).ok().flatten();
    if let Ok(mut map) = callbacks.lock() {
        map.remove(&id);
    }
    let response = serde_json::to_vec(&answer).unwrap_or_else(|_| b"null".to_vec());
    let _ = socket.write_all(&response);
    let _ = socket.write_all(b"\n");
}
impl CredentialSession {
    #[cfg(unix)]
    pub fn new(scope: String, bus: Arc<EventBus>, pending: Pending) -> Result<Self> {
        use std::{
            os::unix::{fs::PermissionsExt, net::UnixListener},
            sync::atomic::Ordering,
            time::Duration,
        };
        let directory = tempfile::Builder::new().prefix("aw-auth-").tempdir()?;
        let path = directory.path().join("socket");
        let listener = UnixListener::bind(&path)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let token = uuid::Uuid::new_v4().to_string();
        let secret = token.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = stop.clone();
        let callbacks = pending.clone();
        let s = scope.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        // macOS may inherit the listener's nonblocking mode.
                        // Wait for delayed/partial requests within the timeout.
                        if socket.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
                        let _ = socket.set_write_timeout(Some(Duration::from_secs(5)));
                        handle_request(socket, &secret, &s, &callbacks, &bus, &done);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        });
        let exe = std::env::current_exe()?;
        let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
        Ok(Self {
            environment: vec![
                ("GIT_ASKPASS".into(), quoted.clone()),
                ("SSH_ASKPASS".into(), exe.to_string_lossy().into()),
                ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
                ("AW_ASKPASS_SOCKET".into(), path.to_string_lossy().into()),
                ("AW_ASKPASS_TOKEN".into(), token),
            ],
            stop,
            _directory: directory,
            pending,
            scope,
        })
    }
    #[cfg(windows)]
    pub fn new(scope: String, bus: Arc<EventBus>, pending: Pending) -> Result<Self> {
        Self::new_tcp(scope, bus, pending)
    }
    #[cfg(any(windows, test))]
    fn new_tcp(scope: String, bus: Arc<EventBus>, pending: Pending) -> Result<Self> {
        use std::{net::TcpListener, sync::atomic::Ordering, time::Duration};
        let directory = tempfile::Builder::new().prefix("aw-auth-").tempdir()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let address = listener.local_addr()?;
        let token = uuid::Uuid::new_v4().to_string();
        let secret = token.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done = stop.clone();
        let callbacks = pending.clone();
        let s = scope.clone();
        std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, peer)) if peer.ip().is_loopback() => {
                        if socket.set_nonblocking(false).is_err() {
                            continue;
                        }
                        let _ = socket.set_read_timeout(Some(Duration::from_secs(5)));
                        let _ = socket.set_write_timeout(Some(Duration::from_secs(5)));
                        handle_request(socket, &secret, &s, &callbacks, &bus, &done);
                    }
                    Ok(_) => (),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        });
        let exe = std::env::current_exe()?;
        // Git for Windows invokes askpass through its POSIX shell. SSH expects
        // an ordinary executable path. Credentials themselves stay in the pipe.
        let path = exe.to_string_lossy().replace('\\', "/");
        let quoted = format!("'{}'", path.replace('\'', "'\\''"));
        Ok(Self {
            environment: vec![
                ("GIT_ASKPASS".into(), quoted),
                ("SSH_ASKPASS".into(), path),
                ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
                ("AW_ASKPASS_SOCKET".into(), format!("tcp:{address}")),
                ("AW_ASKPASS_TOKEN".into(), token),
            ],
            stop,
            _directory: directory,
            pending,
            scope,
        })
    }
}
#[cfg(test)]
mod tcp_tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpStream,
        time::Duration,
    };
    fn connect(session: &CredentialSession) -> (TcpStream, String) {
        let endpoint = session
            .environment
            .iter()
            .find(|v| v.0 == "AW_ASKPASS_SOCKET")
            .unwrap()
            .1
            .strip_prefix("tcp:")
            .unwrap();
        let socket = TcpStream::connect(endpoint).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let token = session
            .environment
            .iter()
            .find(|v| v.0 == "AW_ASKPASS_TOKEN")
            .unwrap()
            .1
            .clone();
        (socket, token)
    }
    #[test]
    fn tcp_bridge_authenticates_scopes_and_cancels_on_drop() {
        let bus = EventBus::new();
        let pending = bus.credentials.clone();
        let session = CredentialSession::new_tcp("project".into(), bus, pending.clone()).unwrap();
        let (mut bad, _) = connect(&session);
        writeln!(
            bad,
            "{{\"token\":\"wrong\",\"prompt\":\"must not appear\"}}"
        )
        .unwrap();
        let mut line = String::new();
        assert_eq!(BufReader::new(bad).read_line(&mut line).unwrap(), 0);
        assert!(pending.lock().unwrap().is_empty());
        let (mut good, token) = connect(&session);
        writeln!(
            good,
            "{}",
            serde_json::json!({"token":token, "prompt":"Password for https://private.invalid"})
        )
        .unwrap();
        let id = (0..100)
            .find_map(|_| {
                let id = pending.lock().unwrap().keys().next().cloned();
                if id.is_none() {
                    std::thread::sleep(Duration::from_millis(10));
                }
                id
            })
            .expect("Credential request must arrive");
        assert!(reply(&pending, "different", &id, Some("must-not-send".into())).is_err());
        drop(session);
        let mut line = String::new();
        BufReader::new(good).read_line(&mut line).unwrap();
        assert_eq!(serde_json::from_str::<Option<String>>(&line).unwrap(), None);
        assert!(pending.lock().unwrap().is_empty());
    }
    #[test]
    fn cancellation_during_request_read_cannot_create_a_late_prompt() {
        let bus = EventBus::new();
        let pending = bus.credentials.clone();
        let session = CredentialSession::new_tcp("project".into(), bus, pending.clone()).unwrap();
        let (mut socket, token) = connect(&session);
        socket.write_all(b"{").unwrap();
        std::thread::sleep(Duration::from_millis(100));
        drop(session);
        writeln!(socket, "\"token\":\"{token}\",\"prompt\":\"late\"}}").unwrap();
        let mut response = String::new();
        // Cancellation can close an accepted socket with unread data (RST) or
        // cleanly reach EOF. Neither may return a credential or create a prompt.
        match BufReader::new(socket).read_line(&mut response) {
            Ok(0) => (),
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => (),
            outcome => panic!("Cancelled credential transport stayed active: {outcome:?}"),
        }
        assert!(response.is_empty());
        assert!(pending.lock().unwrap().is_empty());
    }
}
impl Drop for CredentialSession {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut map) = self.pending.lock() {
            let ids = map
                .iter()
                .filter(|(_, v)| v.0 == self.scope)
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>();
            for id in ids {
                if let Some((_, tx)) = map.remove(&id) {
                    let _ = tx.send(None);
                }
            }
        }
    }
}
pub fn reply(pending: &Pending, scope: &str, id: &str, value: Option<String>) -> Result<()> {
    if value
        .as_ref()
        .is_some_and(|v| v.len() > 8192 || v.contains(['\n', '\r', '\0']))
    {
        return Err(AppError::new("input", "Invalid credential response"));
    }
    let mut map = pending
        .lock()
        .map_err(|_| AppError::new("internal", "Credential state unavailable"))?;
    if !map.get(id).is_some_and(|v| v.0 == scope) {
        return Err(AppError::new(
            "scope",
            "Credential request expired or belongs to another operation",
        ));
    }
    let (_, tx) = map.remove(id).expect("validated while locked");
    tx.send(value)
        .map_err(|_| AppError::new("cancelled", "Credential operation already ended"))
}
pub fn helper_mode() -> Option<i32> {
    let endpoint = std::env::var_os("AW_ASKPASS_SOCKET")?;
    let token = std::env::var("AW_ASKPASS_TOKEN").ok()?;
    let result = if let Some(address) = endpoint.to_str().and_then(|s| s.strip_prefix("tcp:")) {
        (|| -> Result<()> {
            let address: std::net::SocketAddrV4 = address
                .parse()
                .map_err(|_| AppError::new("scope", "Invalid credential endpoint"))?;
            if !address.ip().is_loopback() || address.port() == 0 {
                return Err(AppError::new("scope", "Credential endpoint must be local"));
            }
            let stream = std::net::TcpStream::connect_timeout(
                &address.into(),
                std::time::Duration::from_secs(2),
            )?;
            stream.set_read_timeout(Some(std::time::Duration::from_secs(100)))?;
            stream.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
            helper_exchange(stream, &token)
        })()
    } else {
        #[cfg(unix)]
        {
            (|| -> Result<()> {
                let stream =
                    std::os::unix::net::UnixStream::connect(std::path::PathBuf::from(endpoint))?;
                stream.set_read_timeout(Some(std::time::Duration::from_secs(100)))?;
                stream.set_write_timeout(Some(std::time::Duration::from_secs(5)))?;
                helper_exchange(stream, &token)
            })()
        }
        #[cfg(not(unix))]
        {
            Err(AppError::new("scope", "Invalid credential transport"))
        }
    };
    Some(if result.is_ok() { 0 } else { 1 })
}
fn helper_exchange(mut stream: impl std::io::Read + std::io::Write, token: &str) -> Result<()> {
    use std::io::{BufRead, BufReader, Read, Write};
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Credential".into());
    let request = serde_json::json!({"token":token,"prompt":prompt});
    stream.write_all(serde_json::to_string(&request)?.as_bytes())?;
    stream.write_all(b"\n")?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(16384)
        .read_line(&mut response)?;
    let answer: Option<String> = serde_json::from_str(&response)?;
    match answer {
        Some(value) => {
            std::io::stdout().write_all(value.as_bytes())?;
            std::io::stdout().write_all(b"\n")?;
            Ok(())
        }
        None => Err(AppError::new("cancelled", "Credential cancelled")),
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
        time::Duration,
    };
    #[test]
    fn scoped_transient_bridge_and_cancellation() {
        let bus = EventBus::new();
        let pending = bus.credentials.clone();
        let session = CredentialSession::new("project".into(), bus, pending.clone()).unwrap();
        let path = session
            .environment
            .iter()
            .find(|p| p.0 == "AW_ASKPASS_SOCKET")
            .unwrap()
            .1
            .clone();
        let token = session
            .environment
            .iter()
            .find(|p| p.0 == "AW_ASKPASS_TOKEN")
            .unwrap()
            .1
            .clone();
        let client = std::thread::spawn(move || {
            let mut socket = UnixStream::connect(&path).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            writeln!(
                socket,
                "{}",
                serde_json::json!({"token":token,"prompt":"Password for remote"})
            )
            .unwrap();
            let mut result = String::new();
            socket.read_to_string(&mut result).unwrap();
            result
        });
        let mut request = None;
        for _ in 0..100 {
            if let Some(key) = pending.lock().unwrap().keys().next() {
                request = Some(key.clone());
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let id = request.unwrap();
        assert!(reply(&pending, "wrong-project", &id, Some("must-not-send".into())).is_err());
        reply(&pending, "project", &id, None).unwrap();
        assert_eq!(
            serde_json::from_str::<Option<String>>(&client.join().unwrap()).unwrap(),
            None
        );
        assert!(pending.lock().unwrap().is_empty());
    }
    #[test]
    fn expired_request_cannot_receive_a_credential() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        assert!(reply(&pending, "scope", "expired", Some("not-stored".into())).is_err());
        assert!(pending.lock().unwrap().is_empty());
    }
}
