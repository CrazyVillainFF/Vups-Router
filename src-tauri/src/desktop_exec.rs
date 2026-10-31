use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_PROCESSES: usize = 32;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_RETURN_CHARS: usize = 6_000;
const MAX_COMMAND_CHARS: usize = 4_000;
const MAX_ARGS: usize = 20;
const MAX_ARG_CHARS: usize = 512;
const MAX_APPS: usize = 500;
const APP_CACHE_TTL: Duration = Duration::from_secs(300);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_LIST_TIMEOUT: Duration = Duration::from_secs(20);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
pub struct ExecError {
    pub code: String,
    pub message: String,
}

impl ExecError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn strip_verbatim(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

fn display_path(path: &Path) -> String {
    strip_verbatim(path).to_string_lossy().to_string()
}

fn os_detail(error: &std::io::Error) -> String {
    truncate_chars(error.to_string().trim(), 220)
}

fn spawn_error(error: std::io::Error, what: &str) -> ExecError {
    let detail = os_detail(&error);
    match error.kind() {
        std::io::ErrorKind::NotFound => ExecError::new(
            "not_found",
            format!("Windows could not find {what}. Windows reported: {detail}."),
        ),
        std::io::ErrorKind::PermissionDenied => ExecError::new(
            "access_denied",
            format!(
                "Windows refused to start {what} for this account. No elevation was attempted. \
                 Windows reported: {detail}."
            ),
        ),
        _ => ExecError::new(
            "spawn_failed",
            format!("Windows could not start {what}. Windows reported: {detail}."),
        ),
    }
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// Windows-critical processes and VupsRouter itself are never closed, even
/// when the user asks: terminating them can sign the user out or kill the
/// agent mid-turn. Everything else with a visible window is fair game.
fn protected_process_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let lower = lower.strip_suffix(".exe").unwrap_or(&lower);
    matches!(
        lower,
        "system"
            | "idle"
            | "registry"
            | "memory compression"
            | "smss"
            | "csrss"
            | "wininit"
            | "winlogon"
            | "services"
            | "lsass"
            | "svchost"
            | "dwm"
            | "fontdrvhost"
            | "sihost"
            | "taskhostw"
            | "explorer"
            | "searchhost"
            | "startmenuexperiencehost"
            | "shellexperiencehost"
            | "textinputhost"
            | "runtimebroker"
            | "vupsrouter"
    )
}

#[derive(Clone, Debug)]
struct WindowProcess {
    pid: u32,
    name: String,
    title: String,
}

/// Resolves one PID to its process name and main-window title. Returns
/// `Ok(None)` when Windows no longer has that process.
fn window_process_info(pid: u32) -> Result<Option<WindowProcess>, ExecError> {
    if pid == 0 {
        return Ok(None);
    }
    let script = format!(
        "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
         if ($p) {{ [pscustomobject]@{{ pid = $p.Id; name = $p.ProcessName; title = [string]$p.MainWindowTitle }} \
         | ConvertTo-Json -Compress }}"
    );
    let raw = run_powershell(&script, PROCESS_LIST_TIMEOUT)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
        ExecError::new(
            "process_lookup_failed",
            format!("Windows returned an unreadable process record: {error}."),
        )
    })?;
    Ok(Some(WindowProcess {
        pid: parsed
            .get("pid")
            .and_then(Value::as_u64)
            .unwrap_or(pid as u64) as u32,
        name: parsed
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        title: parsed
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }))
}

fn process_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut command = Command::new("tasklist.exe");
    command.args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        }
        _ => false,
    }
}

fn taskkill(pid: u32, force: bool, tree: bool) -> bool {
    if pid == 0 {
        return false;
    }
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string()]);
    if tree {
        command.arg("/T");
    }
    if force {
        command.arg("/F");
    }
    hide_console(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[derive(Default)]
struct OutputBuffer {
    bytes: Vec<u8>,
    truncated: bool,
}

impl OutputBuffer {
    fn push(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        if chunk.len() >= MAX_OUTPUT_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - MAX_OUTPUT_BYTES..]);
            self.truncated = true;
            return;
        }
        if self.bytes.len() + chunk.len() > MAX_OUTPUT_BYTES {
            let keep = MAX_OUTPUT_BYTES - chunk.len();
            let drain = self.bytes.len().saturating_sub(keep);
            if drain > 0 {
                self.bytes.drain(0..drain);
            }
            self.truncated = true;
        }
        self.bytes.extend_from_slice(chunk);
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).to_string()
    }

    fn tail(&self, max_chars: usize) -> (String, bool) {
        let text = self.text();
        let chars = text.chars().count();
        if chars <= max_chars {
            return (text, self.truncated);
        }
        let tail: String = text.chars().skip(chars - max_chars).collect();
        (tail, true)
    }

    fn tail_lines(&self, lines: usize) -> (String, bool) {
        let text = self.text();
        let collected: Vec<&str> = text.lines().collect();
        let start = collected.len().saturating_sub(lines);
        let tail = collected[start..].join("\n");
        (tail, self.truncated || start > 0)
    }
}

fn pump(mut stream: impl Read + Send + 'static, buffer: Arc<Mutex<OutputBuffer>>) {
    let mut chunk = [0u8; 8_192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if let Ok(mut guard) = buffer.lock() {
                    guard.push(&chunk[..read]);
                }
            }
            Err(_) => break,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessKind {
    Command,
    App,
}

impl ProcessKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::App => "app",
        }
    }
}

#[derive(Clone, Debug)]
struct ProcessState {
    running: bool,
    stopped: bool,
    exit_code: Option<i32>,
    ended_at: Option<i64>,
}

impl Default for ProcessState {
    fn default() -> Self {
        Self {
            running: true,
            stopped: false,
            exit_code: None,
            ended_at: None,
        }
    }
}

impl ProcessState {
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

pub(crate) struct ManagedProcess {
    id: String,
    pid: u32,
    operation_id: String,
    kind: ProcessKind,
    label: String,
    command_line: String,
    cwd: String,
    started_at: i64,
    child: Arc<Mutex<Option<Child>>>,
    stdout: Arc<Mutex<OutputBuffer>>,
    stderr: Arc<Mutex<OutputBuffer>>,
    state: Arc<Mutex<ProcessState>>,
}

impl ManagedProcess {
    fn snapshot(&self, tail_lines: Option<usize>) -> Value {
        self.refresh();
        let state = self
            .state
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let (stdout, stdout_truncated) = match tail_lines {
            Some(lines) => self
                .stdout
                .lock()
                .map(|buffer| buffer.tail_lines(lines))
                .unwrap_or_default(),
            None => self
                .stdout
                .lock()
                .map(|buffer| buffer.tail(MAX_RETURN_CHARS))
                .unwrap_or_default(),
        };
        let (stderr, stderr_truncated) = match tail_lines {
            Some(lines) => self
                .stderr
                .lock()
                .map(|buffer| buffer.tail_lines(lines))
                .unwrap_or_default(),
            None => self
                .stderr
                .lock()
                .map(|buffer| buffer.tail(MAX_RETURN_CHARS))
                .unwrap_or_default(),
        };
        json!({
            "processId": self.id,
            "pid": self.pid,
            "kind": self.kind.as_str(),
            "label": self.label,
            "command": self.command_line,
            "cwd": self.cwd,
            "status": state.label(),
            "running": state.running,
            "exitCode": state.exit_code,
            "startedAt": self.started_at,
            "endedAt": state.ended_at,
            "stdout": stdout,
            "stderr": stderr,
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated
        })
    }

    fn refresh(&self) {
        let exited = {
            let Ok(mut guard) = self.child.lock() else {
                return;
            };
            let Some(child) = guard.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    *guard = None;
                    Some(code)
                }
                Ok(None) => None,
                Err(_) => Some(None),
            }
        };
        if let Some(code) = exited {
            if let Ok(mut state) = self.state.lock() {
                state.running = false;
                if state.exit_code.is_none() {
                    state.exit_code = code;
                }
                if state.ended_at.is_none() {
                    state.ended_at = Some(now_millis());
                }
            }
        }
    }

    fn mark_stopped(&self, exit_code: Option<i32>) {
        if let Ok(mut state) = self.state.lock() {
            state.running = false;
            state.stopped = true;
            if state.exit_code.is_none() {
                state.exit_code = exit_code;
            }
            state.ended_at.get_or_insert_with(now_millis);
        }
    }

    /// Kills the whole process tree and only reports success after Windows
    /// confirms the direct child is gone. A killed process that refuses to die
    /// must not be described as stopped.
    fn kill_tree(&self) -> bool {
        taskkill(self.pid, true, true);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let exited = {
                let Ok(mut guard) = self.child.lock() else {
                    return false;
                };
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code();
                            *guard = None;
                            Some(code)
                        }
                        Ok(None) => {
                            let _ = child.kill();
                            None
                        }
                        Err(_) => {
                            *guard = None;
                            Some(None)
                        }
                    },
                    None => Some(None),
                }
            };
            if let Some(code) = exited {
                self.mark_stopped(code);
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(60));
        }
    }
}

fn monitor(process: Arc<ManagedProcess>) {
    loop {
        process.refresh();
        let running = process
            .state
            .lock()
            .map(|state| state.running)
            .unwrap_or(false);
        if !running {
            return;
        }
        thread::sleep(Duration::from_millis(250));
    }
}

#[derive(Default)]
pub struct ProcessRegistry {
    processes: Mutex<HashMap<String, Arc<ManagedProcess>>>,
}

impl ProcessRegistry {
    fn register(&self, process: Arc<ManagedProcess>) -> Result<(), ExecError> {
        let Ok(mut map) = self.processes.lock() else {
            return Err(ExecError::new(
                "process_registry_unavailable",
                "The local process registry is unavailable.",
            ));
        };
        if map.len() >= MAX_PROCESSES {
            let mut finished: Vec<(i64, String)> = map
                .iter()
                .filter(|(_, entry)| {
                    entry
                        .state
                        .lock()
                        .map(|state| !state.running)
                        .unwrap_or(true)
                })
                .map(|(id, entry)| (entry.started_at, id.clone()))
                .collect();
            finished.sort_by_key(|(started, _)| *started);
            for (_, id) in finished {
                map.remove(&id);
                if map.len() < MAX_PROCESSES {
                    break;
                }
            }
        }
        if map.len() >= MAX_PROCESSES {
            return Err(ExecError::new(
                "too_many_processes",
                format!(
                    "VupsRouter is already tracking {MAX_PROCESSES} local processes. Stop one with \
                     stop_command before starting another."
                ),
            ));
        }
        map.insert(process.id.clone(), process);
        Ok(())
    }

    pub fn find(&self, key: &str) -> Option<Arc<ManagedProcess>> {
        let id = key.trim();
        if id.is_empty() {
            return None;
        }
        let Ok(map) = self.processes.lock() else {
            return None;
        };
        if let Some(process) = map.get(id) {
            return Some(process.clone());
        }
        let pid = id.parse::<u32>().ok()?;
        map.values().find(|entry| entry.pid == pid).cloned()
    }

    pub fn list(&self) -> Vec<Arc<ManagedProcess>> {
        self.processes
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Stop is scoped to one chat turn. Only background commands this turn
    /// started are killed; an app the user asked to open is left open.
    pub fn kill_operation(&self, operation_id: &str) -> Vec<u32> {
        let operation_id = operation_id.trim();
        if operation_id.is_empty() {
            return Vec::new();
        }
        let targets: Vec<Arc<ManagedProcess>> = self
            .processes
            .lock()
            .map(|map| {
                map.values()
                    .filter(|process| {
                        process.kind == ProcessKind::Command && process.operation_id == operation_id
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        targets
            .into_iter()
            .map(|process| {
                process.kill_tree();
                process.pid
            })
            .collect()
    }

    pub fn kill_all_commands(&self) -> usize {
        let targets: Vec<Arc<ManagedProcess>> = self
            .processes
            .lock()
            .map(|map| {
                map.values()
                    .filter(|process| process.kind == ProcessKind::Command)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let count = targets.len();
        for process in targets {
            process.kill_tree();
        }
        count
    }

    pub fn stop(&self, key: &str) -> Result<Value, ExecError> {
        let process = self.find(key).ok_or_else(|| {
            ExecError::new(
                "unknown_process",
                "No VupsRouter-managed process matches that id or PID.",
            )
        })?;
        if process.kind != ProcessKind::Command {
            return Err(ExecError::new(
                "not_a_command",
                "That process is an app launched by VupsRouter, not a background command. Use close_app.",
            ));
        }
        if !process
            .state
            .lock()
            .map(|state| state.running)
            .unwrap_or(false)
        {
            let snapshot = process.snapshot(Some(20));
            return Ok(json!({
                "processId": snapshot["processId"],
                "pid": snapshot["pid"],
                "alreadyExited": true,
                "status": snapshot["status"],
                "exitCode": snapshot["exitCode"]
            }));
        }
        if !process.kill_tree() {
            return Err(ExecError::new(
                "stop_failed",
                format!(
                    "Windows did not confirm that PID {} ({}) stopped. It may still be running.",
                    process.pid, process.label
                ),
            ));
        }
        let snapshot = process.snapshot(Some(12));
        Ok(json!({
            "processId": snapshot["processId"],
            "pid": snapshot["pid"],
            "stopped": true,
            "status": snapshot["status"],
            "exitCode": snapshot["exitCode"],
            "stdout": snapshot["stdout"],
            "stderr": snapshot["stderr"]
        }))
    }

    pub fn close(&self, key: &str, force: bool) -> Result<Value, ExecError> {
        match self.find(key) {
            Some(process) => self.close_managed(process, force),
            None => close_unmanaged(key, force),
        }
    }

    fn close_managed(&self, process: Arc<ManagedProcess>, force: bool) -> Result<Value, ExecError> {
        if process.kind != ProcessKind::App {
            return Err(ExecError::new(
                "not_an_app",
                "That is a background command. Use stop_command to stop it.",
            ));
        }
        let running = process
            .state
            .lock()
            .map(|state| state.running)
            .unwrap_or(false);
        if !running {
            let snapshot = process.snapshot(Some(8));
            return Ok(json!({
                "processId": snapshot["processId"],
                "pid": snapshot["pid"],
                "label": snapshot["label"],
                "managed": true,
                "launchedByVupsRouter": true,
                "alreadyExited": true,
                "closed": true,
                "forced": false,
                "exitCode": snapshot["exitCode"]
            }));
        }
        // A graceful close asks the app's main process to quit; multi-process
        // apps (Chrome, Electron) exit their own children. `taskkill /T`
        // without `/F` cannot terminate those children, so it fails and leaves
        // the app running. Only force termination needs the whole tree.
        let mut closed = taskkill(process.pid, force, force);
        let wait = if force {
            Duration::from_secs(4)
        } else {
            Duration::from_secs(6)
        };
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            process.refresh();
            if !process
                .state
                .lock()
                .map(|state| state.running)
                .unwrap_or(false)
            {
                closed = true;
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let snapshot = process.snapshot(Some(8));
        let still_running = snapshot["running"].as_bool().unwrap_or(false);
        if force && still_running {
            return Err(ExecError::new(
                "close_failed",
                format!(
                    "Windows did not terminate PID {} ({}). No data was invented; the process is \
                     still running and may need to be closed from its own window.",
                    process.pid, process.label
                ),
            ));
        }
        if !closed && still_running {
            return Err(ExecError::new(
                "close_failed",
                format!(
                    "Windows refused to close PID {} ({}). It is still running.",
                    process.pid, process.label
                ),
            ));
        }
        Ok(json!({
            "processId": snapshot["processId"],
            "pid": snapshot["pid"],
            "label": snapshot["label"],
            "managed": true,
            "launchedByVupsRouter": true,
            "closed": !still_running,
            "stillRunning": still_running,
            "forced": force,
            "alreadyExited": false,
            "exitCode": snapshot["exitCode"],
            "note": if still_running {
                "Windows sent a close request, but the app did not exit. Ask the user before force-terminating it."
            } else if force {
                "The app's process tree was force-terminated after approval."
            } else {
                "The app was asked to close normally."
            }
        }))
    }
}

/// Closes an app that VupsRouter did not start, identified by its numeric PID
/// from `list_processes`. Only a process that currently owns a main window can
/// be targeted, and Windows-critical processes are refused outright.
fn close_unmanaged(key: &str, force: bool) -> Result<Value, ExecError> {
    let pid: u32 = key.trim().parse().map_err(|_| {
        ExecError::new(
            "unknown_process",
            "Use the processId or the numeric PID that list_processes reported. No process was touched.",
        )
    })?;
    let info = window_process_info(pid)?.ok_or_else(|| {
        ExecError::new(
            "not_running",
            format!("PID {pid} is not running, so nothing was closed."),
        )
    })?;
    if info.title.trim().is_empty() {
        return Err(ExecError::new(
            "not_a_window_app",
            format!(
                "PID {pid} ({}) has no visible main window, so VupsRouter will not close it. \
                 Only windowed apps can be closed; no process was touched.",
                info.name
            ),
        ));
    }
    if protected_process_name(&info.name) {
        return Err(ExecError::new(
            "protected_process",
            format!(
                "{} is a protected Windows process and VupsRouter never closes it. No process was touched.",
                info.name
            ),
        ));
    }
    let label = format!("{} — {}", info.name, truncate_chars(info.title.trim(), 120));
    // Graceful close posts WM_CLOSE to the app's windows, so it can save or
    // ask questions. Forcing with /T is reserved for explicit approval.
    let mut closed = taskkill(pid, force, force);
    let wait = if force {
        Duration::from_secs(4)
    } else {
        Duration::from_secs(6)
    };
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        if !process_exists(pid) {
            closed = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let still_running = process_exists(pid);
    if force && still_running {
        return Err(ExecError::new(
            "close_failed",
            format!(
                "Windows did not terminate PID {pid} ({label}). No data was invented; the process \
                 is still running and may need to be closed from its own window."
            ),
        ));
    }
    if !closed && still_running {
        return Err(ExecError::new(
            "close_failed",
            format!("Windows refused to close PID {pid} ({label}). It is still running."),
        ));
    }
    Ok(json!({
        "processId": Value::Null,
        "pid": info.pid,
        "label": label,
        "name": info.name,
        "title": info.title,
        "managed": true,
        "launchedByVupsRouter": false,
        "closed": !still_running,
        "stillRunning": still_running,
        "forced": force,
        "alreadyExited": false,
        "exitCode": Value::Null,
        "note": if still_running {
            "Windows sent a close request, but the app did not exit. Ask the user before force-terminating it."
        } else if force {
            "The app's process tree was force-terminated after approval."
        } else {
            "The app was asked to close normally; it was not launched by VupsRouter."
        }
    }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shell {
    PowerShell,
    Cmd,
}

impl Shell {
    pub fn parse(value: Option<&str>) -> Result<Self, ExecError> {
        match value.map(|entry| entry.trim().to_ascii_lowercase()) {
            None => Ok(Self::PowerShell),
            Some(value) if value.is_empty() || value == "powershell" || value == "pwsh" => {
                Ok(Self::PowerShell)
            }
            Some(value) if value == "cmd" || value == "cmd.exe" => Ok(Self::Cmd),
            Some(value) => Err(ExecError::new(
                "invalid_shell",
                format!("Unknown command shell \"{value}\". Use powershell or cmd."),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell",
            Self::Cmd => "cmd",
        }
    }
}

#[derive(Clone, Debug)]
pub struct CommandSpec {
    pub command: String,
    pub shell: Shell,
    pub cwd: PathBuf,
    pub timeout: Duration,
}

impl CommandSpec {
    pub fn parse(args: &Value, default_cwd: PathBuf) -> Result<Self, ExecError> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ExecError::new("invalid_arguments", "The command tool needs a command.")
            })?;
        if command.chars().count() > MAX_COMMAND_CHARS {
            return Err(ExecError::new(
                "invalid_arguments",
                format!("Keep the command under {MAX_COMMAND_CHARS} characters."),
            ));
        }
        if command.contains('\0') {
            return Err(ExecError::new(
                "invalid_arguments",
                "The command contains a NUL byte.",
            ));
        }
        let shell = Shell::parse(args.get("shell").and_then(Value::as_str))?;
        let cwd = match args.get("cwd").and_then(Value::as_str) {
            Some(raw) if !raw.trim().is_empty() => {
                let path = PathBuf::from(raw.trim());
                if !path.is_absolute() {
                    return Err(ExecError::new(
                        "invalid_path",
                        "The working directory must be an absolute Windows path.",
                    ));
                }
                let canonical = std::fs::canonicalize(&path).map_err(|error| {
                    ExecError::new(
                        "invalid_cwd",
                        format!(
                            "The working directory could not be used. Windows reported: {}.",
                            os_detail(&error)
                        ),
                    )
                })?;
                let canonical = strip_verbatim(&canonical);
                if !canonical.is_dir() {
                    return Err(ExecError::new(
                        "not_a_directory",
                        format!(
                            "The working directory is not a folder: {}.",
                            display_path(&canonical)
                        ),
                    ));
                }
                canonical
            }
            _ => default_cwd,
        };
        let timeout_seconds = args
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(120)
            .clamp(1, 900);
        Ok(Self {
            command: command.to_string(),
            shell,
            cwd,
            timeout: Duration::from_secs(timeout_seconds),
        })
    }

    pub fn command_line(&self) -> String {
        match self.shell {
            Shell::PowerShell => format!("powershell -NoProfile -Command {}", self.command),
            Shell::Cmd => format!("cmd /D /S /C {}", self.command),
        }
    }

    fn program_and_args(&self) -> (String, Vec<String>) {
        match self.shell {
            Shell::PowerShell => (
                "powershell.exe".to_string(),
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-Command".into(),
                    self.command.clone(),
                ],
            ),
            Shell::Cmd => (
                "cmd.exe".to_string(),
                vec!["/D".into(), "/S".into(), "/C".into(), self.command.clone()],
            ),
        }
    }
}

#[derive(Clone, Debug)]
pub struct LaunchPlan {
    pub exe: PathBuf,
    pub name: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub alternatives: Vec<String>,
}

fn spawn_managed(
    registry: &ProcessRegistry,
    operation_id: &str,
    kind: ProcessKind,
    label: &str,
    command_line: &str,
    cwd: &Path,
    program: &str,
    args: &[String],
    no_window: bool,
) -> Result<Arc<ManagedProcess>, ExecError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if no_window {
        hide_console(&mut command);
    }
    let mut child = command
        .spawn()
        .map_err(|error| spawn_error(error, &format!("{program}")))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_buffer = Arc::new(Mutex::new(OutputBuffer::default()));
    let stderr_buffer = Arc::new(Mutex::new(OutputBuffer::default()));
    if let Some(stream) = stdout {
        let buffer = stdout_buffer.clone();
        thread::spawn(move || pump(stream, buffer));
    }
    if let Some(stream) = stderr {
        let buffer = stderr_buffer.clone();
        thread::spawn(move || pump(stream, buffer));
    }
    let process = Arc::new(ManagedProcess {
        id: uuid::Uuid::new_v4().to_string(),
        pid,
        operation_id: operation_id.trim().to_string(),
        kind,
        label: truncate_chars(label.trim(), 160),
        command_line: truncate_chars(command_line.trim(), 1_000),
        cwd: display_path(cwd),
        started_at: now_millis(),
        child: Arc::new(Mutex::new(Some(child))),
        stdout: stdout_buffer,
        stderr: stderr_buffer,
        state: Arc::new(Mutex::default()),
    });
    if let Err(error) = registry.register(process.clone()) {
        process.kill_tree();
        return Err(error);
    }
    let monitored = process.clone();
    thread::spawn(move || monitor(monitored));
    Ok(process)
}

fn tail_from_buffer(process: &ManagedProcess) -> (String, String, bool, bool) {
    thread::sleep(Duration::from_millis(80));
    let (stdout, out_truncated) = process
        .stdout
        .lock()
        .map(|buffer| buffer.tail(MAX_RETURN_CHARS))
        .unwrap_or_default();
    let (stderr, err_truncated) = process
        .stderr
        .lock()
        .map(|buffer| buffer.tail(MAX_RETURN_CHARS))
        .unwrap_or_default();
    (stdout, stderr, out_truncated, err_truncated)
}

pub struct CommandOutcome {
    pub value: Value,
    pub cancelled: bool,
}

/// Runs a command to completion. The child is registered before it starts
/// producing output, so a Stop that lands mid-command kills its whole tree.
pub fn run_command_blocking(
    registry: &ProcessRegistry,
    operation_id: &str,
    spec: &CommandSpec,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<CommandOutcome, ExecError> {
    if is_cancelled() {
        return Err(ExecError::new(
            "cancelled",
            "The command was stopped at your request before it started.",
        ));
    }
    let (program, args) = spec.program_and_args();
    let started = Instant::now();
    let process = spawn_managed(
        registry,
        operation_id,
        ProcessKind::Command,
        &spec.command_line(),
        &spec.command_line(),
        &spec.cwd,
        &program,
        &args,
        true,
    )?;
    let deadline = started + spec.timeout;
    let mut cancelled = false;
    let mut timed_out = false;
    loop {
        process.refresh();
        let running = process
            .state
            .lock()
            .map(|state| state.running)
            .unwrap_or(false);
        if !running {
            break;
        }
        if is_cancelled() {
            cancelled = true;
            process.kill_tree();
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            process.kill_tree();
            break;
        }
        thread::sleep(Duration::from_millis(40));
    }
    let (stdout, stderr, stdout_truncated, stderr_truncated) = tail_from_buffer(&process);
    let state = process
        .state
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    Ok(CommandOutcome {
        cancelled,
        value: json!({
            "processId": process.id,
            "pid": process.pid,
            "shell": spec.shell.as_str(),
            "command": spec.command,
            "cwd": display_path(&spec.cwd),
            "status": if cancelled { "cancelled" } else if timed_out { "timed_out" } else { "exited" },
            "exitCode": if cancelled || timed_out { Value::Null } else { json!(state.exit_code) },
            "timedOut": timed_out,
            "cancelled": cancelled,
            "durationMs": started.elapsed().as_millis() as i64,
            "stdout": stdout,
            "stderr": stderr,
            "stdoutTruncated": stdout_truncated,
            "stderrTruncated": stderr_truncated
        }),
    })
}

pub fn start_command(
    registry: &ProcessRegistry,
    operation_id: &str,
    spec: &CommandSpec,
) -> Result<Value, ExecError> {
    let (program, args) = spec.program_and_args();
    let process = spawn_managed(
        registry,
        operation_id,
        ProcessKind::Command,
        &spec.command_line(),
        &spec.command_line(),
        &spec.cwd,
        &program,
        &args,
        true,
    )?;
    thread::sleep(Duration::from_millis(120));
    process.refresh();
    let snapshot = process.snapshot(Some(40));
    Ok(json!({
        "processId": snapshot["processId"],
        "pid": snapshot["pid"],
        "shell": spec.shell.as_str(),
        "command": spec.command,
        "cwd": display_path(&spec.cwd),
        "status": snapshot["status"],
        "running": snapshot["running"],
        "exitCode": snapshot["exitCode"],
        "startedAt": snapshot["startedAt"],
        "stdout": snapshot["stdout"],
        "stderr": snapshot["stderr"],
        "note": "The command is running in the background. Read it with command_output and stop it with stop_command."
    }))
}

pub fn command_output(
    registry: &ProcessRegistry,
    key: &str,
    tail_lines: usize,
) -> Result<Value, ExecError> {
    let process = registry.find(key).ok_or_else(|| {
        ExecError::new(
            "unknown_process",
            "No VupsRouter-managed process matches that id or PID.",
        )
    })?;
    process.refresh();
    let elapsed = now_millis() - process.started_at;
    let mut snapshot = process.snapshot(Some(tail_lines.clamp(1, 400)));
    snapshot["elapsedMs"] = json!(elapsed);
    Ok(snapshot)
}

pub fn stop_command(registry: &ProcessRegistry, key: &str) -> Result<Value, ExecError> {
    registry.stop(key)
}

pub fn close_app(registry: &ProcessRegistry, key: &str, force: bool) -> Result<Value, ExecError> {
    registry.close(key, force)
}

pub fn open_target(path: &Path) -> Result<Value, ExecError> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| {
        ExecError::new(
            "open_failed",
            format!(
                "Windows could not open {}. Windows reported: {}.",
                display_path(path),
                truncate_chars(&error.to_string(), 220)
            ),
        )
    })?;
    let kind = if path.is_dir() { "directory" } else { "file" };
    Ok(json!({
        "path": display_path(path),
        "kind": kind,
        "opened": true,
        "opener": if kind == "directory" { "File Explorer" } else { "the default Windows app" }
    }))
}

pub fn open_url(url: &str) -> Result<Value, ExecError> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| {
        ExecError::new(
            "open_failed",
            format!(
                "Windows could not open that URL in the default browser. Windows reported: {}.",
                truncate_chars(&error.to_string(), 220)
            ),
        )
    })?;
    Ok(json!({
        "url": url,
        "opened": true,
        "opener": "the default browser"
    }))
}

pub fn launch_plan(
    registry: &ProcessRegistry,
    operation_id: &str,
    plan: &LaunchPlan,
) -> Result<Value, ExecError> {
    if !plan.exe.is_file() {
        return Err(ExecError::new(
            "app_not_found",
            format!(
                "The app executable no longer exists: {}.",
                display_path(&plan.exe)
            ),
        ));
    }
    let cwd = plan.cwd.clone().unwrap_or_else(|| {
        plan.exe
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    });
    let command_line = std::iter::once(display_path(&plan.exe))
        .chain(plan.args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let process = spawn_managed(
        registry,
        operation_id,
        ProcessKind::App,
        &plan.name,
        &command_line,
        &cwd,
        &display_path(&plan.exe),
        &plan.args,
        false,
    )?;
    thread::sleep(Duration::from_millis(350));
    process.refresh();
    let snapshot = process.snapshot(Some(12));
    let running = snapshot["running"].as_bool().unwrap_or(false);
    let exit_code = snapshot["exitCode"].as_i64();
    if !running && exit_code.unwrap_or(0) != 0 {
        return Err(ExecError::new(
            "app_exited",
            format!(
                "{} exited immediately with code {}. Windows reported no window to verify. \
                 Stderr: {}",
                plan.name,
                exit_code.unwrap_or(-1),
                snapshot["stderr"].as_str().unwrap_or("").trim()
            ),
        ));
    }
    Ok(json!({
        "processId": snapshot["processId"],
        "pid": snapshot["pid"],
        "name": plan.name,
        "executable": display_path(&plan.exe),
        "arguments": plan.args,
        "status": snapshot["status"],
        "running": running,
        "exitCode": snapshot["exitCode"],
        "verified": running,
        "alternatives": plan.alternatives,
        "note": "VupsRouter launched this executable. It can report the process, and close it on request; it does not drive the app's interface."
    }))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    pub path: String,
    pub source: String,
}

#[derive(Clone)]
struct CachedApps {
    fetched: Instant,
    apps: Vec<InstalledApp>,
}

static APP_CACHE: OnceLock<Mutex<Option<CachedApps>>> = OnceLock::new();

fn app_cache() -> &'static Mutex<Option<CachedApps>> {
    APP_CACHE.get_or_init(|| Mutex::new(None))
}

const DISCOVERY_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$apps = New-Object System.Collections.Generic.List[object]
$paths = @(
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
  "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
)
foreach ($root in $paths) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $value = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue)."(default)"
    if ($value) {
      $apps.Add([pscustomobject]@{
        name = [System.IO.Path]::GetFileNameWithoutExtension($_.PSChildName)
        path = $value
        source = "app-paths"
      })
    }
  }
}
$shell = New-Object -ComObject WScript.Shell
$menus = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
)
foreach ($menu in $menus) {
  if (-not (Test-Path $menu)) { continue }
  Get-ChildItem -Path $menu -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $shortcut = $shell.CreateShortcut($_.FullName)
      $target = $shortcut.TargetPath
      if ($target -and $target.ToLower().EndsWith(".exe")) {
        $apps.Add([pscustomobject]@{
          name = $_.BaseName
          path = $target
          source = "start-menu"
        })
      }
    } catch {}
  }
}
@($apps | Sort-Object name -Unique | Select-Object -First 500) | ConvertTo-Json -Compress
"#;

const PROCESS_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  $title = ""
  try { $title = $_.MainWindowTitle } catch {}
  if ($title) {
    [pscustomobject]@{
      pid = $_.Id
      name = $_.ProcessName
      title = $title
      startedAt = try { $_.StartTime.ToUniversalTime().ToString("o") } catch { $null }
    }
  }
} | Sort-Object name | Select-Object -First 200) | ConvertTo-Json -Compress
"#;

fn capture(
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Result<(String, String, Option<i32>), ExecError> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| spawn_error(error, program))?;
    let stdout = Arc::new(Mutex::new(OutputBuffer::default()));
    let stderr = Arc::new(Mutex::new(OutputBuffer::default()));
    if let Some(stream) = child.stdout.take() {
        let buffer = stdout.clone();
        thread::spawn(move || pump(stream, buffer));
    }
    if let Some(stream) = child.stderr.take() {
        let buffer = stderr.clone();
        thread::spawn(move || pump(stream, buffer));
    }
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                taskkill(child.id(), true, true);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(_) => {
                let _ = child.kill();
                break None;
            }
        }
    };
    thread::sleep(Duration::from_millis(60));
    let out = stdout
        .lock()
        .map(|buffer| buffer.text())
        .unwrap_or_default();
    let err = stderr
        .lock()
        .map(|buffer| buffer.text())
        .unwrap_or_default();
    if timed_out {
        return Err(ExecError::new(
            "discovery_timeout",
            "Windows did not finish listing its applications in time.",
        ));
    }
    Ok((out, err, status))
}

fn powershell_args(script: &str) -> Vec<String> {
    vec![
        "-NoLogo".into(),
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-Command".into(),
        script.to_string(),
    ]
}

fn run_powershell(script: &str, timeout: Duration) -> Result<String, ExecError> {
    let args = powershell_args(script);
    match capture("powershell.exe", &args, timeout) {
        Ok((stdout, stderr, status)) => {
            if status != Some(0) {
                return Err(ExecError::new(
                    "powershell_failed",
                    format!(
                        "Windows PowerShell could not complete the request (exit code {}). {}",
                        status
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        truncate_chars(stderr.trim(), 300)
                    ),
                ));
            }
            Ok(stdout.trim_start_matches('\u{feff}').to_string())
        }
        Err(error) if error.code == "not_found" => {
            let pwsh_args = {
                let mut args = args;
                args[0] = "-NoLogo".into();
                args
            };
            match capture("pwsh.exe", &pwsh_args, timeout) {
                Ok((stdout, stderr, status)) => {
                    if status != Some(0) {
                        return Err(ExecError::new(
                            "powershell_failed",
                            format!(
                                "PowerShell could not complete the request (exit code {}). {}",
                                status
                                    .map(|code| code.to_string())
                                    .unwrap_or_else(|| "unknown".into()),
                                truncate_chars(stderr.trim(), 300)
                            ),
                        ));
                    }
                    Ok(stdout.trim_start_matches('\u{feff}').to_string())
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

fn resolve_launcher(path: PathBuf) -> PathBuf {
    let Some(stem) = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
    else {
        return path;
    };
    let lower = stem.to_ascii_lowercase();
    let suffix = ["-launcher", ".launcher", " launcher", "-launch"]
        .iter()
        .find(|suffix| lower.ends_with(*suffix));
    let Some(suffix) = suffix else {
        return path;
    };
    let base = stem[..stem.len() - suffix.len()].trim_end_matches(['-', '.', ' ']);
    if base.is_empty() {
        return path;
    }
    let candidate = path.with_file_name(format!("{base}.exe"));
    if candidate.is_file() {
        candidate
    } else {
        path
    }
}

fn normalize_app(raw: Value) -> Option<InstalledApp> {
    let name = raw.get("name")?.as_str()?.trim();
    let path = raw.get("path")?.as_str()?.trim().trim_matches('"').trim();
    let source = raw
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("start-menu");
    if name.is_empty() || path.is_empty() {
        return None;
    }
    let lower_name = name.to_ascii_lowercase();
    if lower_name.contains("uninstall") || lower_name.contains("unins0") {
        return None;
    }
    let raw_path = PathBuf::from(path);
    if !raw_path.is_file() {
        return None;
    }
    let canonical = std::fs::canonicalize(&raw_path).ok()?;
    let canonical = strip_verbatim(&canonical);
    let exe_name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if exe_name == "explorer.exe" || exe_name == "unins000.exe" {
        return None;
    }
    if !canonical
        .extension()
        .map(|value| value.to_string_lossy().eq_ignore_ascii_case("exe"))
        .unwrap_or(false)
    {
        return None;
    }
    let exe = resolve_launcher(canonical);
    Some(InstalledApp {
        name: truncate_chars(name, 120),
        path: display_path(&exe),
        source: source.to_string(),
    })
}

pub fn discover_apps(force_refresh: bool) -> Result<Vec<InstalledApp>, ExecError> {
    if !force_refresh {
        if let Ok(cache) = app_cache().lock() {
            if let Some(cached) = cache.as_ref() {
                if cached.fetched.elapsed() < APP_CACHE_TTL {
                    return Ok(cached.apps.clone());
                }
            }
        }
    }
    let raw = run_powershell(DISCOVERY_SCRIPT, DISCOVERY_TIMEOUT)?;
    let trimmed = raw.trim();
    let parsed: Value = if trimmed.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(trimmed).map_err(|error| {
            ExecError::new(
                "app_discovery_failed",
                format!("Windows returned an unreadable application list: {error}."),
            )
        })?
    };
    let items: Vec<Value> = match parsed {
        Value::Array(items) => items,
        Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };
    let mut apps: Vec<InstalledApp> = items.into_iter().filter_map(normalize_app).collect();
    apps.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    apps.dedup_by(|left, right| {
        left.name.eq_ignore_ascii_case(&right.name) && left.path.eq_ignore_ascii_case(&right.path)
    });
    apps.truncate(MAX_APPS);
    if let Ok(mut cache) = app_cache().lock() {
        *cache = Some(CachedApps {
            fetched: Instant::now(),
            apps: apps.clone(),
        });
    }
    Ok(apps)
}

pub fn search_apps(force_refresh: bool, query: &str) -> Result<Vec<InstalledApp>, ExecError> {
    let apps = discover_apps(force_refresh)?;
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(apps.into_iter().take(100).collect());
    }
    let mut scored: Vec<(u8, InstalledApp)> = apps
        .into_iter()
        .filter_map(|app| {
            let name = app.name.to_ascii_lowercase();
            let stem = Path::new(&app.path)
                .file_stem()
                .map(|value| value.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let score = if name == needle || stem == needle {
                0
            } else if name.starts_with(&needle) || stem.starts_with(&needle) {
                1
            } else if name.contains(&needle) || stem.contains(&needle) {
                2
            } else {
                return None;
            };
            Some((score, app))
        })
        .collect();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        left_score
            .cmp(right_score)
            .then_with(|| left.name.len().cmp(&right.name.len()))
            .then_with(|| {
                right
                    .name
                    .to_ascii_lowercase()
                    .cmp(&left.name.to_ascii_lowercase())
            })
    });
    Ok(scored.into_iter().map(|(_, app)| app).collect())
}

pub fn find_app_plan(
    name: Option<&str>,
    path: Option<&str>,
    args: &Value,
    cwd: Option<&str>,
) -> Result<LaunchPlan, ExecError> {
    let extra_args = parse_args(args)?;
    let cwd = match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(ExecError::new(
                    "invalid_path",
                    "The app working directory must be an absolute Windows path.",
                ));
            }
            let canonical = std::fs::canonicalize(&path).map_err(|error| {
                ExecError::new(
                    "invalid_cwd",
                    format!(
                        "The app working directory could not be used. Windows reported: {}.",
                        os_detail(&error)
                    ),
                )
            })?;
            if !canonical.is_dir() {
                return Err(ExecError::new(
                    "not_a_directory",
                    format!(
                        "The app working directory is not a folder: {}.",
                        display_path(&canonical)
                    ),
                ));
            }
            Some(strip_verbatim(&canonical))
        }
        None => None,
    };
    if let Some(raw) = path.map(str::trim).filter(|value| !value.is_empty()) {
        let requested = PathBuf::from(raw);
        if !requested.is_absolute() {
            return Err(ExecError::new(
                "invalid_path",
                "An app executable must be an absolute Windows path.",
            ));
        }
        let canonical = std::fs::canonicalize(&requested).map_err(|error| {
            ExecError::new(
                "app_not_found",
                format!(
                    "That executable could not be found. Windows reported: {}.",
                    os_detail(&error)
                ),
            )
        })?;
        if !canonical.is_file() {
            return Err(ExecError::new(
                "not_a_file",
                format!("That path is not a file: {}.", display_path(&canonical)),
            ));
        }
        let exe = resolve_launcher(strip_verbatim(&canonical));
        let name = exe
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| "app".into());
        return Ok(LaunchPlan {
            exe,
            name,
            args: extra_args,
            cwd,
            alternatives: Vec::new(),
        });
    }
    let query = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ExecError::new(
                "invalid_arguments",
                "Provide the app name or an absolute executable path.",
            )
        })?;
    let matches = search_apps(false, query)?;
    let Some(first) = matches.first() else {
        return Err(ExecError::new(
            "app_not_found",
            format!(
                "No installed app matched \"{}\". Call list_installed_apps to see what this PC has, \
                 and do not claim the app was launched.",
                truncate_chars(query, 120)
            ),
        ));
    };
    let alternatives = matches
        .iter()
        .skip(1)
        .take(3)
        .map(|app| format!("{} ({})", app.name, app.path))
        .collect();
    Ok(LaunchPlan {
        exe: PathBuf::from(&first.path),
        name: first.name.clone(),
        args: extra_args,
        cwd,
        alternatives,
    })
}

fn parse_args(value: &Value) -> Result<Vec<String>, ExecError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Some(items) = value.as_array() else {
        return Err(ExecError::new(
            "invalid_arguments",
            "App arguments must be an array of strings.",
        ));
    };
    if items.len() > MAX_ARGS {
        return Err(ExecError::new(
            "invalid_arguments",
            format!("Pass at most {MAX_ARGS} app arguments."),
        ));
    }
    let mut args = Vec::new();
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(ExecError::new(
                "invalid_arguments",
                "Every app argument must be a string.",
            ));
        };
        if text.chars().count() > MAX_ARG_CHARS {
            return Err(ExecError::new(
                "invalid_arguments",
                format!("Keep each app argument under {MAX_ARG_CHARS} characters."),
            ));
        }
        args.push(text.to_string());
    }
    Ok(args)
}

pub fn list_processes(
    registry: &ProcessRegistry,
    name: Option<&str>,
    limit: usize,
) -> Result<Value, ExecError> {
    let raw = run_powershell(PROCESS_SCRIPT, PROCESS_LIST_TIMEOUT)?;
    let trimmed = raw.trim();
    let parsed: Value = if trimmed.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(trimmed).map_err(|error| {
            ExecError::new(
                "process_list_failed",
                format!("Windows returned an unreadable process list: {error}."),
            )
        })?
    };
    let items: Vec<Value> = match parsed {
        Value::Array(items) => items,
        Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    };
    let needle = name
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| !value.is_empty());
    let limit = limit.clamp(1, 100);
    let managed = registry.list();
    let mut processes = Vec::new();
    for item in items {
        if processes.len() >= limit {
            break;
        }
        let process_name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(needle) = needle.as_deref() {
            if !process_name.to_ascii_lowercase().contains(needle)
                && !title.to_ascii_lowercase().contains(needle)
            {
                continue;
            }
        }
        let pid = item.get("pid").and_then(Value::as_u64).unwrap_or(0);
        // Every windowed app is manageable now; only Windows-critical
        // processes and VupsRouter itself stay off limits.
        let owned = managed.iter().find(|process| u64::from(process.pid) == pid);
        let running = owned
            .and_then(|process| process.state.lock().ok().map(|state| state.running))
            .unwrap_or(true);
        let protected = protected_process_name(&process_name);
        processes.push(json!({
            "pid": pid,
            "name": process_name,
            "title": title,
            "startedAt": item.get("startedAt").cloned().unwrap_or(Value::Null),
            "managed": true,
            "launchedByVupsRouter": owned.is_some(),
            "processId": owned.map(|process| process.id.clone()),
            "kind": owned.map(|process| process.kind.as_str()).unwrap_or("app"),
            "running": running,
            "canClose": !protected,
            "canStop": owned.map(|process| process.kind == ProcessKind::Command).unwrap_or(false)
        }));
    }
    Ok(json!({
        "processes": processes,
        "count": processes.len(),
        "filter": name.unwrap_or(""),
        "note": "Every entry with canClose=true can be closed with close_app, passing its processId when present or otherwise its numeric pid; it does not have to be launched by VupsRouter. managed=true means VupsRouter tracks the visible app, while launchedByVupsRouter=true only marks processes it started. Protected Windows processes and VupsRouter itself are refused."
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_parsing_accepts_only_real_shells() {
        assert_eq!(Shell::parse(None).unwrap(), Shell::PowerShell);
        assert_eq!(Shell::parse(Some("cmd")).unwrap(), Shell::Cmd);
        assert!(Shell::parse(Some("bash")).is_err());
    }

    #[test]
    fn every_windowed_app_is_closable_except_windows_critical_processes() {
        for name in [
            "explorer",
            "explorer.exe",
            "WinLogon",
            "lsass.exe",
            "dwm",
            "services",
            "VupsRouter.exe",
        ] {
            assert!(protected_process_name(name), "{name} must stay protected");
        }
        for name in [
            "chrome",
            "chrome.exe",
            "msedge",
            "notepad",
            "Code",
            "WINWORD.EXE",
        ] {
            assert!(!protected_process_name(name), "{name} must be closable");
        }
    }

    #[test]
    fn command_specs_reject_relative_working_directories() {
        let args = json!({ "command": "Get-Location", "cwd": "relative" });
        assert!(CommandSpec::parse(&args, PathBuf::from(".")).is_err());
        let args = json!({ "command": "   " });
        assert!(CommandSpec::parse(&args, PathBuf::from(".")).is_err());
    }

    #[test]
    fn launcher_executables_resolve_to_the_real_binary() {
        let dir = std::env::temp_dir().join(format!("vups-launcher-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let launcher = dir.join("blender-launcher.exe");
        let real = dir.join("blender.exe");
        std::fs::write(&launcher, b"x").unwrap();
        std::fs::write(&real, b"x").unwrap();
        assert_eq!(resolve_launcher(launcher), real);
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn app_discovery_finds_installed_programs_without_a_hardcoded_list() {
        let apps = discover_apps(true).expect("discovery");
        assert!(
            apps.len() > 5,
            "this machine has Start Menu apps: {}",
            apps.len()
        );
        assert!(
            apps.iter()
                .any(|app| app.path.to_ascii_lowercase().ends_with(".exe")),
            "every discovered entry resolves to a real executable"
        );
        let chrome = apps
            .iter()
            .find(|app| app.name.to_ascii_lowercase().contains("chrome"));
        if let Some(chrome) = chrome {
            assert!(Path::new(&chrome.path).is_file(), "{}", chrome.path);
        }
        eprintln!("[apps] discovered {}", apps.len());
    }

    #[cfg(windows)]
    #[test]
    fn a_real_powershell_command_returns_its_output_and_exit_code() {
        let registry = ProcessRegistry::default();
        let args = json!({
            "command": "$PSVersionTable.PSVersion.ToString(); exit 7",
            "shell": "powershell",
            "timeoutSeconds": 30
        });
        let spec = CommandSpec::parse(&args, std::env::temp_dir()).expect("spec");
        let outcome = run_command_blocking(&registry, "test-op", &spec, &|| false).expect("run");
        let value = outcome.value;
        assert_eq!(value["exitCode"], 7);
        assert!(
            value["stdout"].as_str().unwrap_or("").contains('.'),
            "the real PowerShell version was captured: {}",
            value["stdout"]
        );
        assert_eq!(value["status"], "exited");
        assert!(!outcome.cancelled);
    }

    #[cfg(windows)]
    #[test]
    fn a_stopped_command_kills_its_tree() {
        let registry = Arc::new(ProcessRegistry::default());
        let args = json!({
            "command": "Start-Sleep -Seconds 30",
            "shell": "powershell",
            "timeoutSeconds": 60
        });
        let spec = CommandSpec::parse(&args, std::env::temp_dir()).expect("spec");
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag_for_worker = flag.clone();
        let registry_for_worker = registry.clone();
        let started = Instant::now();
        let worker = std::thread::spawn(move || {
            run_command_blocking(&registry_for_worker, "stop-me", &spec, &|| {
                flag_for_worker.load(std::sync::atomic::Ordering::SeqCst)
            })
        });
        thread::sleep(Duration::from_millis(600));
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        let outcome = worker.join().expect("worker").expect("outcome");
        assert!(outcome.cancelled);
        assert!(started.elapsed() < Duration::from_secs(10));
        assert!(
            registry.list().iter().all(|process| !process
                .state
                .lock()
                .map(|state| state.running)
                .unwrap_or(false)),
            "no command is left running after the stop"
        );
    }

    #[cfg(windows)]
    #[test]
    fn background_commands_report_output_and_stop() {
        let registry = ProcessRegistry::default();
        let args = json!({
            "command": "Write-Output 'ready'; Start-Sleep -Seconds 30",
            "shell": "powershell"
        });
        let spec = CommandSpec::parse(&args, std::env::temp_dir()).expect("spec");
        let started = start_command(&registry, "server-op", &spec).expect("start");
        let id = started["processId"].as_str().unwrap().to_string();
        // PowerShell startup under a loaded test run can take seconds, so wait
        // for the marker instead of assuming a fixed delay is enough.
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut output = command_output(&registry, &id, 20).expect("output");
        while !output["stdout"].as_str().unwrap_or("").contains("ready")
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(100));
            output = command_output(&registry, &id, 20).expect("output");
        }
        assert!(output["running"].as_bool().unwrap_or(false));
        assert!(output["stdout"].as_str().unwrap_or("").contains("ready"));
        let stopped = stop_command(&registry, &id).expect("stop");
        assert!(stopped["stopped"].as_bool().unwrap_or(false));
    }

    #[cfg(windows)]
    #[test]
    fn stop_is_scoped_to_the_operation_that_started_the_command() {
        let registry = ProcessRegistry::default();
        let first = start_command(
            &registry,
            "turn-a",
            &CommandSpec::parse(
                &json!({ "command": "Start-Sleep -Seconds 30", "shell": "powershell" }),
                std::env::temp_dir(),
            )
            .unwrap(),
        )
        .expect("first");
        let second = start_command(
            &registry,
            "turn-b",
            &CommandSpec::parse(
                &json!({ "command": "Start-Sleep -Seconds 30", "shell": "powershell" }),
                std::env::temp_dir(),
            )
            .unwrap(),
        )
        .expect("second");
        let killed = registry.kill_operation("turn-a");
        assert_eq!(killed.len(), 1);
        assert!(registry
            .find(first["processId"].as_str().unwrap())
            .map(|process| !process
                .state
                .lock()
                .map(|state| state.running)
                .unwrap_or(false))
            .unwrap_or(false));
        assert!(registry
            .find(second["processId"].as_str().unwrap())
            .map(|process| process
                .state
                .lock()
                .map(|state| state.running)
                .unwrap_or(false))
            .unwrap_or(false));
        registry.kill_operation("turn-b");
    }

    #[cfg(windows)]
    #[test]
    fn protected_and_unknown_processes_are_never_closed() {
        let registry = ProcessRegistry::default();
        let error = registry.close("999999", false).expect_err("unknown");
        assert_eq!(error.code, "unknown_process");
        let error = registry.close("1", true).expect_err("system process");
        assert_eq!(error.code, "unknown_process");
    }
}
