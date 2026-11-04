use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const MAX_SESSIONS: usize = 4;
const MAX_SESSION_ID_CHARS: usize = 64;
const MAX_INPUT_CHARS: usize = 4_000;
const MAX_PATH_CHARS: usize = 1_024;
const TAIL_CHARS: usize = 6_000;
const TRANSCRIPT_LIMIT: usize = 256 * 1024;
const GRACEFUL_EXIT: Duration = Duration::from_millis(1_500);
const GRACEFUL_KILL: Duration = Duration::from_millis(300);
const KILL_VERIFY: Duration = Duration::from_secs(3);
const OUTPUT_EVENT: &str = "panel-terminal:output";
const EXIT_EVENT: &str = "panel-terminal:exit";
const READY_EVENT: &str = "panel-terminal:ready";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn session_key(raw: Option<&str>) -> Result<String, String> {
    let trimmed = raw.unwrap_or("main").trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_SESSION_ID_CHARS
        || !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("That terminal name is not valid.".into());
    }
    Ok(trimmed.to_string())
}

/// A terminal starts inside a folder that really exists; with no folder given
/// it uses the user's home rather than the app's working directory.
fn resolve_cwd(raw: Option<&str>) -> Result<PathBuf, String> {
    let requested = raw.unwrap_or("").trim();
    if requested.chars().count() > MAX_PATH_CHARS {
        return Err("That folder path is too long.".into());
    }
    let candidate: PathBuf = if requested.is_empty() {
        dirs::home_dir().ok_or("Windows could not find your home folder.")?
    } else {
        Path::new(requested).to_path_buf()
    };
    let metadata = std::fs::metadata(&candidate)
        .map_err(|_| "That folder does not exist on this machine.".to_string())?;
    if !metadata.is_dir() {
        return Err("That path is not a folder.".into());
    }
    Ok(candidate)
}

#[cfg(windows)]
fn shell_plan() -> Result<(String, Vec<String>), String> {
    Ok((
        "powershell.exe".into(),
        vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-Command".into(),
            "-".into(),
        ],
    ))
}

#[cfg(all(not(windows), unix))]
fn shell_plan() -> Result<(String, Vec<String>), String> {
    Ok(("/bin/sh".into(), vec!["-s".into()]))
}

#[cfg(not(any(windows, unix)))]
fn shell_plan() -> Result<(String, Vec<String>), String> {
    Err("The terminal pane is only available on Windows.".into())
}

/// Redirected pipes are written in the console's OEM codepage unless the shell
/// is told otherwise, which garbles anything non-ASCII.
const BOOTSTRAP: &str = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }";

#[derive(Default)]
struct Transcript {
    bytes: Vec<u8>,
    truncated: bool,
}

impl Transcript {
    fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if self.bytes.len() + chunk.len() > TRANSCRIPT_LIMIT {
            let keep = TRANSCRIPT_LIMIT.saturating_sub(chunk.len());
            let drain = self.bytes.len().saturating_sub(keep);
            if drain > 0 {
                self.bytes.drain(0..drain);
                self.truncated = true;
            }
        }
        self.bytes.extend_from_slice(chunk);
    }

    fn tail(&self, max_chars: usize) -> (String, bool) {
        let text = String::from_utf8_lossy(&self.bytes).to_string();
        let count = text.chars().count();
        if count <= max_chars {
            return (text, self.truncated);
        }
        (
            text.chars().skip(count - max_chars).collect(),
            true,
        )
    }
}

#[derive(Default, Clone)]
struct SessionState {
    running: bool,
    stopped: bool,
    exit_code: Option<i32>,
    ended_at: Option<i64>,
    input_error: Option<String>,
}

impl SessionState {
    fn label(&self) -> &'static str {
        if self.running {
            "running"
        } else if self.stopped {
            "stopped"
        } else {
            "exited"
        }
    }
}

pub(crate) struct TerminalSession {
    id: String,
    pid: u32,
    cwd: String,
    shell: String,
    started_at: i64,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
    state: Arc<Mutex<SessionState>>,
    transcript: Arc<Mutex<Transcript>>,
}

impl TerminalSession {
    fn record(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Ok(mut buffer) = self.transcript.lock() {
            buffer.push(text.as_bytes());
        }
    }

    fn snapshot(&self, with_transcript: bool) -> Value {
        let state = self
            .state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let (tail, truncated) = match self.transcript.lock() {
            Ok(buffer) => buffer.tail(TAIL_CHARS),
            Err(_) => (String::new(), false),
        };
        let mut value = json!({
            "sessionId": self.id,
            "pid": self.pid,
            "cwd": self.cwd,
            "shell": self.shell,
            "startedAt": self.started_at,
            "endedAt": state.ended_at,
            "status": state.label(),
            "running": state.running,
            "exitCode": state.exit_code,
            "inputError": state.input_error,
            "transcriptTruncated": truncated
        });
        if with_transcript {
            value["transcript"] = json!(tail);
        }
        value
    }

    fn send_line(&self, text: &str) -> Result<(), String> {
        if !self.is_running() {
            return Err("That terminal session has already closed.".into());
        }
        if text.chars().count() > MAX_INPUT_CHARS {
            return Err("That command is longer than the terminal accepts.".into());
        }
        let line = if text.ends_with('\n') {
            text.to_string()
        } else {
            format!("{text}\n")
        };
        let mut guard = self
            .stdin
            .lock()
            .map_err(|_| "The terminal session is unavailable.".to_string())?;
        let stdin = guard.as_mut().ok_or("The terminal session has no input pipe.")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|error| {
                let message = format!("Windows rejected the input: {error}");
                if let Ok(mut state) = self.state.lock() {
                    state.input_error = Some(message.clone());
                }
                message
            })
    }

    fn is_running(&self) -> bool {
        self.state.lock().map(|guard| guard.running).unwrap_or(false)
    }

    /// True once Windows has confirmed the child is reaped.
    fn child_dead(&self) -> bool {
        let exited = {
            let Ok(mut guard) = self.child.lock() else {
                return false;
            };
            let Some(child) = guard.as_mut() else {
                return true;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    *guard = None;
                    Some(code)
                }
                Ok(None) => None,
                Err(_) => {
                    *guard = None;
                    Some(None)
                }
            }
        };
        match exited {
            Some(code) => {
                if let Ok(mut state) = self.state.lock() {
                    state.running = false;
                    if state.exit_code.is_none() {
                        state.exit_code = code;
                    }
                    state.ended_at.get_or_insert_with(now_millis);
                }
                true
            }
            None => false,
        }
    }

    fn close_stdin(&self) {
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
    }

    /// Kills the shell and everything it started, then marks the session
    /// stopped. Returns false when Windows never confirmed the death.
    fn terminate(&self) -> bool {
        kill_tree(self.pid, &self.child);
        let dead = self.child_dead();
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.stopped = true;
            if dead {
                state.ended_at.get_or_insert_with(now_millis);
            }
        }
        dead
    }
}

#[cfg(windows)]
fn taskkill(pid: u32, tree: bool, force: bool) {
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string()]);
    if tree {
        command.arg("/T");
    }
    if force {
        command.arg("/F");
    }
    hide_console(&mut command);
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn taskkill(_pid: u32, _tree: bool, _force: bool) {}

/// `/T` takes the whole tree so a dev server launched from the panel cannot
/// outlive its shell. The forced pass runs while the shell is still alive:
/// taskkill resolves the tree by parent pid, and once the shell has exited its
/// children are no longer reachable, which would leave a server holding a port.
fn kill_tree(pid: u32, child: &Arc<Mutex<Option<Child>>>) -> bool {
    taskkill(pid, true, false);
    if !shell_alive(child, GRACEFUL_KILL) {
        return true;
    }
    taskkill(pid, true, true);
    if !shell_alive(child, KILL_VERIFY) {
        return true;
    }
    // Windows still reports the shell: terminate the direct child and let the
    // caller's reaper confirm.
    if let Ok(mut guard) = child.lock() {
        if let Some(inner) = guard.as_mut() {
            let _ = inner.kill();
        }
    }
    false
}

/// True when the shell is still running after `window`. Reaps it and returns
/// false as soon as Windows reports it gone.
fn shell_alive(child: &Arc<Mutex<Option<Child>>>, window: Duration) -> bool {
    let deadline = Instant::now() + window;
    loop {
        let running = {
            let Ok(mut guard) = child.lock() else {
                return true;
            };
            match guard.as_mut() {
                Some(inner) => match inner.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        false
                    }
                    Ok(None) => true,
                    Err(_) => {
                        *guard = None;
                        false
                    }
                },
                None => false,
            }
        };
        if !running || Instant::now() >= deadline {
            return running;
        }
        thread::sleep(Duration::from_millis(60));
    }
}

/// Split off the longest complete UTF-8 prefix so a multi-byte character that
/// straddles a pipe read is never rendered as a replacement glyph.
fn take_text(buffer: &mut Vec<u8>, force: bool) -> String {
    let valid = match std::str::from_utf8(buffer) {
        Ok(_) => buffer.len(),
        Err(error) => error.valid_up_to(),
    };
    let cut = if force { buffer.len() } else { valid };
    if cut == 0 {
        return String::new();
    }
    let text = String::from_utf8_lossy(&buffer[..cut]).to_string();
    buffer.drain(..cut);
    text.trim_start_matches('\u{feff}').to_string()
}

fn emit(
    app: &Option<AppHandle>,
    event: &str,
    session_id: &str,
    stream: &str,
    text: &str,
) {
    let Some(app) = app else { return };
    let _ = app.emit(
        event,
        json!({
            "sessionId": session_id,
            "stream": stream,
            "text": truncate_chars(text, 20_000),
            "at": now_millis()
        }),
    );
}

fn pump_stream<R: Read + Send + 'static>(
    mut stream: R,
    stream_name: &'static str,
    session_id: String,
    transcript: Arc<Mutex<Transcript>>,
    state: Arc<Mutex<SessionState>>,
    app: Option<AppHandle>,
) {
    let mut raw = [0u8; 8_192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match stream.read(&mut raw) {
            Ok(0) => break,
            Ok(read) => {
                carry.extend_from_slice(&raw[..read]);
                let text = take_text(&mut carry, false);
                if text.is_empty() {
                    continue;
                }
                if let Ok(mut buffer) = transcript.lock() {
                    buffer.push(text.as_bytes());
                }
                emit(&app, OUTPUT_EVENT, &session_id, stream_name, &text);
                if !state.lock().map(|guard| guard.running).unwrap_or(false) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let tail = take_text(&mut carry, true);
    if !tail.is_empty() {
        if let Ok(mut buffer) = transcript.lock() {
            buffer.push(tail.as_bytes());
        }
        emit(&app, OUTPUT_EVENT, &session_id, stream_name, &tail);
    }
}

fn monitor_exit(
    child: Arc<Mutex<Option<Child>>>,
    state: Arc<Mutex<SessionState>>,
    session_id: String,
    app: Option<AppHandle>,
) {
    // Polled rather than a blocking wait(): wait() holds the child mutex for
    // the whole life of the shell, and every reader that needs it (a status
    // poll, a close, app-exit shutdown) would queue behind this thread.
    let code = loop {
        let polled = {
            let Ok(mut guard) = child.lock() else {
                return;
            };
            match guard.as_mut() {
                Some(inner) => match inner.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code();
                        *guard = None;
                        Some(code)
                    }
                    Ok(None) => None,
                    Err(_) => {
                        *guard = None;
                        Some(None)
                    }
                },
                None => break None,
            }
        };
        match polled {
            Some(code) => break code,
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stopped = state.lock().map(|guard| guard.stopped).unwrap_or(false);
    if let Ok(mut guard) = state.lock() {
        guard.running = false;
        if guard.exit_code.is_none() {
            guard.exit_code = code;
        }
        guard.ended_at.get_or_insert_with(now_millis);
    }
    let Some(app) = app else { return };
    let _ = app.emit(
        EXIT_EVENT,
        json!({
            "sessionId": session_id,
            "exitCode": code,
            "status": if stopped { "stopped" } else { "exited" },
            "at": now_millis()
        }),
    );
}

fn spawn_session(id: &str, cwd: &Path, app: Option<AppHandle>) -> Result<Arc<TerminalSession>, String> {
    let (program, args) = shell_plan()?;
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Windows could not start {program}. {error}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or("The terminal session has no input pipe.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The terminal session has no output pipe.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The terminal session has no error pipe.")?;

    let session = Arc::new(TerminalSession {
        id: id.to_string(),
        pid,
        cwd: cwd.to_string_lossy().to_string(),
        shell: program.clone(),
        started_at: now_millis(),
        stdin: Arc::new(Mutex::new(Some(stdin))),
        child: Arc::new(Mutex::new(Some(child))),
        state: Arc::new(Mutex::new(SessionState {
            running: true,
            ..SessionState::default()
        })),
        transcript: Arc::new(Mutex::new(Transcript::default())),
    });

    session
        .send_line(BOOTSTRAP)
        .map_err(|error| format!("The terminal session could not be prepared. {error}"))?;
    session.record(&format!(
        "Windows PowerShell started (pid {pid}) in {}\n",
        session.cwd
    ));

    let readers = [
        (Box::new(stdout) as Box<dyn Read + Send>, "stdout"),
        (Box::new(stderr) as Box<dyn Read + Send>, "stderr"),
    ];
    for (stream, name) in readers {
        let sink = app.clone();
        let reader = session.clone();
        thread::spawn(move || {
            pump_stream(
                stream,
                name,
                reader.id.clone(),
                reader.transcript.clone(),
                reader.state.clone(),
                sink,
            )
        });
    }

    let watcher = app.clone();
    let (watch_child, watch_state) = (session.child.clone(), session.state.clone());
    let watch_id = session.id.clone();
    thread::spawn(move || monitor_exit(watch_child, watch_state, watch_id, watcher));

    Ok(session)
}

/// Cloned freely: the command layer hands a handle to a blocking thread to
/// kill a process tree without holding a borrow across the await.
#[derive(Clone, Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

impl TerminalState {
    fn find(&self, id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "The terminal pane is unavailable.".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "That terminal session is not open.".to_string())
    }

    fn remove(&self, id: &str) {
        if let Ok(mut guard) = self.sessions.lock() {
            guard.remove(id);
        }
    }

    /// Every shell the panel started dies with the window that owned it, so a
    /// dev server launched from the terminal cannot outlive the app.
    pub fn shutdown(&self) {
        let all: Vec<Arc<TerminalSession>> = self
            .sessions
            .lock()
            .map(|guard| guard.values().cloned().collect())
            .unwrap_or_default();
        for session in all {
            session.terminate();
        }
        if let Ok(mut guard) = self.sessions.lock() {
            guard.clear();
        }
    }
}

fn start_session(
    state: &TerminalState,
    app: Option<AppHandle>,
    id: &str,
    cwd: Option<&str>,
) -> Result<Value, String> {
    if let Some(existing) = state.find(id).ok() {
        if existing.is_running() {
            let mut snapshot = existing.snapshot(true);
            snapshot["reused"] = json!(true);
            return Ok(snapshot);
        }
        state.remove(id);
    }

    let directory = resolve_cwd(cwd)?;
    let running = {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "The terminal pane is unavailable.".to_string())?;
        guard
            .values()
            .filter(|session| session.is_running())
            .count()
    };
    if running >= MAX_SESSIONS {
        return Err(format!(
            "The panel already has {MAX_SESSIONS} terminal sessions open. Close one first."
        ));
    }

    let session = spawn_session(id, &directory, app.clone())?;
    if let Ok(mut guard) = state.sessions.lock() {
        guard.insert(id.to_string(), session.clone());
    }
    if let Some(app) = app {
        let _ = app.emit(
            READY_EVENT,
            json!({
                "sessionId": id,
                "pid": session.pid,
                "cwd": session.cwd,
                "at": now_millis()
            }),
        );
    }
    let mut snapshot = session.snapshot(true);
    snapshot["reused"] = json!(false);
    Ok(snapshot)
}

fn send_input(state: &TerminalState, app: Option<&AppHandle>, id: &str, text: &str) -> Result<Value, String> {
    let session = state.find(id)?;
    session.send_line(text)?;
    let echoed = format!("$ {}\n", text.trim_end());
    session.record(&echoed);
    if let Some(app) = app {
        emit(&Some(app.clone()), OUTPUT_EVENT, id, "input", &echoed);
    }
    Ok(json!({
        "sessionId": id,
        "accepted": true,
        "bytes": text.chars().count()
    }))
}

fn stop_session(session: &Arc<TerminalSession>) -> Value {
    let dead = session.terminate();
    session.close_stdin();
    let mut snapshot = session.snapshot(true);
    snapshot["killed"] = json!(dead);
    snapshot["running"] = json!(session.is_running());
    snapshot
}

fn close_session(session: &Arc<TerminalSession>) -> Value {
    session.close_stdin();
    let deadline = Instant::now() + GRACEFUL_EXIT;
    let mut graceful = session.child_dead();
    while !graceful && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
        graceful = session.child_dead();
    }
    let killed = if graceful { false } else { session.terminate() };
    let mut snapshot = session.snapshot(true);
    snapshot["closed"] = json!(true);
    snapshot["graceful"] = json!(graceful);
    snapshot["killed"] = json!(killed);
    snapshot
}

#[tauri::command]
pub async fn panel_terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: Option<String>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let id = session_key(session_id.as_deref())?;
    let cwd = cwd.unwrap_or_default();
    let registry = state.inner().clone();
    // Starting is a process spawn plus a first write, so it stays off the
    // command thread.
    tauri::async_runtime::spawn_blocking(move || {
        start_session(
            &registry,
            Some(app),
            &id,
            if cwd.is_empty() { None } else { Some(cwd.as_str()) },
        )
    })
    .await
    .map_err(|_| "The terminal could not be started.".to_string())?
}

#[tauri::command]
pub async fn panel_terminal_send(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    text: String,
) -> Result<Value, String> {
    let id = session_key(Some(&session_id))?;
    send_input(state.inner(), Some(&app), &id, &text)
}

fn status_session(state: &TerminalState, id: &str) -> Result<Value, String> {
    let session = state.find(id)?;
    session.child_dead();
    Ok(session.snapshot(true))
}

fn list_sessions(state: &TerminalState) -> Value {
    let all: Vec<Arc<TerminalSession>> = state
        .sessions
        .lock()
        .map(|guard| guard.values().cloned().collect())
        .unwrap_or_default();
    let sessions: Vec<Value> = all
        .iter()
        .map(|session| {
            session.child_dead();
            session.snapshot(false)
        })
        .collect();
    json!({ "sessions": sessions, "limit": MAX_SESSIONS })
}

#[tauri::command]
pub async fn panel_terminal_status(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Value, String> {
    let id = session_key(Some(&session_id))?;
    status_session(state.inner(), &id)
}

#[tauri::command]
pub async fn panel_terminal_list(state: State<'_, TerminalState>) -> Result<Value, String> {
    Ok(list_sessions(state.inner()))
}

#[tauri::command]
pub async fn panel_terminal_stop(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Value, String> {
    let id = session_key(Some(&session_id))?;
    let session = state.find(&id)?;
    tauri::async_runtime::spawn_blocking(move || stop_session(&session))
        .await
        .map_err(|_| "The terminal could not be stopped.".to_string())
}

#[tauri::command]
pub async fn panel_terminal_close(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<Value, String> {
    let id = session_key(Some(&session_id))?;
    let session = state.find(&id)?;
    let registry = state.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let snapshot = close_session(&session);
        // The shell is unregistered only once Windows has confirmed it is gone.
        registry.remove(&session.id);
        snapshot
    })
    .await
    .map_err(|_| "The terminal could not be closed.".to_string())?;
    Ok(snapshot)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("vupsrouter-terminal-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("scratch folder");
        directory
    }

    fn transcript(session: &Arc<TerminalSession>) -> String {
        session.snapshot(true)["transcript"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn wait_until(session: &Arc<TerminalSession>, needle: &str, seconds: u64) -> String {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        loop {
            let text = transcript(session);
            if text.contains(needle) || Instant::now() >= deadline {
                return text;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Only what the shell itself printed. The panel writes two kinds of line
    /// into the same transcript: the echoed command ("$ ...") and the start
    /// banner. A needle that appears in them proves nothing about streaming, so
    /// output assertions filter them out first.
    fn shell_output(session: &Arc<TerminalSession>) -> String {
        transcript(session)
            .lines()
            .filter(|line| {
                !line.starts_with("$ ") && !line.starts_with("Windows PowerShell started")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for_shell_output(
        session: &Arc<TerminalSession>,
        needle: &str,
        seconds: u64,
    ) -> String {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        loop {
            let text = shell_output(session);
            if text.contains(needle) || Instant::now() >= deadline {
                return text;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn windows_has_process(pid: u32) -> bool {
        let output = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .expect("tasklist");
        String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
    }

    #[test]
    fn names_and_folders_are_validated_before_any_process_starts() {
        assert_eq!(session_key(None).unwrap(), "main");
        assert_eq!(session_key(Some(" build-1 ")).unwrap(), "build-1");
        assert!(session_key(Some("bad name")).is_err());
        assert!(session_key(Some("")).is_err());
        assert!(session_key(Some(&"x".repeat(80))).is_err());

        let state = TerminalState::default();
        assert!(start_session(&state, None, "main", Some(r"Z:\no\such\folder")).is_err());

        let directory = scratch_dir("file");
        let file = directory.join("not-a-folder.txt");
        std::fs::write(&file, "x").unwrap();
        let error =
            start_session(&state, None, "main", Some(file.to_string_lossy().as_ref()))
                .expect_err("a file is not a folder");
        assert!(error.contains("not a folder"), "{error}");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_session_streams_output_and_keeps_state_between_commands() {
        let directory = scratch_dir("stream");
        let state = TerminalState::default();
        let started = start_session(
            &state,
            None,
            "main",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect("start");
        assert_eq!(started["running"], json!(true));
        assert_eq!(
            started["cwd"].as_str().unwrap(),
            directory.to_string_lossy().as_ref()
        );
        let session = state.find("main").unwrap();

        send_input(&state, None, "main", "Write-Output 'vr-alpha'").expect("first");
        assert!(
            wait_for_shell_output(&session, "vr-alpha", 25).contains("vr-alpha"),
            "PowerShell output must stream into the transcript"
        );

        // One shell answers both lines, so the variable set by the first is
        // still there for the second: that is what makes it a session.
        send_input(&state, None, "main", "$vrNumber = 21").expect("set");
        send_input(&state, None, "main", "Write-Output ($vrNumber * 2)").expect("read");
        let text = wait_for_shell_output(&session, "42", 25);
        assert!(text.contains("42"), "session state must persist: {text}");

        send_input(&state, None, "main", "Write-Error 'vr-beta'").expect("error");
        let text = wait_for_shell_output(&session, "vr-beta", 25);
        assert!(text.contains("vr-beta"), "stderr must reach the pane: {text}");

        send_input(&state, None, "main", "Get-Location").expect("cwd");
        let text = wait_for_shell_output(&session, "vupsrouter-terminal-stream", 25);
        assert!(
            text.contains("vupsrouter-terminal-stream"),
            "the shell must start in the chosen folder: {text}"
        );

        assert!(send_input(&state, None, "missing", "Write-Output 1").is_err());
        assert_eq!(list_sessions(&state)["sessions"].as_array().unwrap().len(), 1);

        close_session(&session);
        state.remove("main");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_typed_line_is_recorded_and_oversized_input_is_refused() {
        let directory = scratch_dir("echo");
        let state = TerminalState::default();
        start_session(
            &state,
            None,
            "main",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect("start");
        let session = state.find("main").unwrap();

        send_input(&state, None, "main", "Write-Output 'vr-echoed'").expect("send");
        let text = wait_until(&session, "$ Write-Output", 25);
        assert!(text.contains("$ Write-Output"), "the typed line is kept: {text}");

        let too_long = "a".repeat(MAX_INPUT_CHARS + 1);
        let error = send_input(&state, None, "main", &too_long).expect_err("oversized input");
        assert!(error.contains("longer than"), "{error}");
        assert!(session.is_running(), "a refused input keeps the session alive");

        close_session(&session);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn stopping_a_session_kills_the_shell_and_its_children() {
        let directory = scratch_dir("stop");
        let state = TerminalState::default();
        let started = start_session(
            &state,
            None,
            "main",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect("start");
        let pid = started["pid"].as_u64().unwrap() as u32;
        assert!(windows_has_process(pid), "the shell is really running");
        let session = state.find("main").unwrap();

        // A child of the shell has to die with it, or Stop would leave an
        // orphan holding a port.
        send_input(
            &state,
            None,
            "main",
            "$vrChild = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' -PassThru; Write-Output ('child=' + $vrChild.Id)",
        )
        .expect("spawn child");
        let text = wait_for_shell_output(&session, "child=", 25);
        let child_pid: u32 = text
            .split("child=")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|digits| digits.parse().ok())
            .unwrap_or(0);
        assert!(child_pid > 0, "the child pid was reported: {text}");
        assert!(windows_has_process(child_pid), "the child is running");

        let stopped = stop_session(&session);
        assert_eq!(stopped["killed"], json!(true));
        assert_eq!(stopped["running"], json!(false));
        let deadline = Instant::now() + Duration::from_secs(8);
        while (windows_has_process(pid) || windows_has_process(child_pid))
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(100));
        }
        assert!(!windows_has_process(pid), "the shell is gone");
        assert!(!windows_has_process(child_pid), "no orphan outlives Stop");

        state.remove("main");
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn closing_exits_the_shell_and_frees_the_slot() {
        let directory = scratch_dir("close");
        let state = TerminalState::default();
        start_session(
            &state,
            None,
            "main",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect("start");
        let session = state.find("main").unwrap();
        let pid = session.pid;

        send_input(&state, None, "main", "exit").expect("exit");
        let closed = close_session(&session);
        assert_eq!(closed["closed"], json!(true));
        assert!(
            closed["graceful"].as_bool().unwrap_or(false),
            "a cooperative shell leaves without being killed"
        );
        let deadline = Instant::now() + Duration::from_secs(8);
        while windows_has_process(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        assert!(!windows_has_process(pid), "the shell exited on its own");

        state.remove("main");
        assert_eq!(list_sessions(&state)["sessions"].as_array().unwrap().len(), 0);
        assert!(status_session(&state, "main").is_err());
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn the_session_limit_holds_and_a_live_name_is_reused() {
        let directory = scratch_dir("limit");
        let state = TerminalState::default();
        for index in 0..MAX_SESSIONS {
            start_session(
                &state,
                None,
                &format!("s{index}"),
                Some(directory.to_string_lossy().as_ref()),
            )
            .expect("start");
        }
        let error = start_session(
            &state,
            None,
            "overflow",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect_err("the limit holds");
        assert!(error.contains("Close one first"), "{error}");

        // A name that is already taken hands back the live shell instead of
        // starting a second one behind the user's back.
        let reused = start_session(
            &state,
            None,
            "s0",
            Some(directory.to_string_lossy().as_ref()),
        )
        .expect("reuse");
        assert_eq!(reused["reused"], json!(true));

        let pids: Vec<u32> = state
            .sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.pid)
            .collect();
        state.shutdown();
        assert_eq!(list_sessions(&state)["sessions"].as_array().unwrap().len(), 0);
        let deadline = Instant::now() + Duration::from_secs(10);
        while pids.iter().any(|pid| windows_has_process(*pid)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        for pid in pids {
            assert!(!windows_has_process(pid), "shutdown left no shell behind");
        }
        std::fs::remove_dir_all(&directory).ok();
    }
}
