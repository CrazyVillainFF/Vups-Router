use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    desktop_exec::{
        close_app, command_output, discover_apps, find_app_plan, launch_plan, list_processes,
        open_target, open_url, run_command_blocking, search_apps, start_command, stop_command,
        CommandSpec, ExecError, LaunchPlan, ProcessRegistry,
    },
    workspace,
};

const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_DEPTH: usize = 8;
const MAX_SEARCH_ENTRIES: usize = 5_000;
const MAX_SEARCH_MS: u64 = 5_000;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_PATH_CHARS: usize = 4_096;
const MAX_QUERY_CHARS: usize = 120;
const MAX_AUDIT_BYTES: u64 = 1_000_000;
const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CONTENT_SEARCH_FILES: usize = 800;
const MAX_CONTENT_SEARCH_BYTES: u64 = 24 * 1024 * 1024;
const MAX_CONTENT_SEARCH_MS: u64 = 8_000;
const MAX_COPY_ENTRIES: usize = 20_000;
const MAX_COPY_DEPTH: usize = 32;
const MAX_CANCELLED_OPERATIONS: usize = 256;

const DESKTOP_TOOL_NAMES: [&str; 27] = [
    "get_windows_known_folder",
    "list_directory",
    "list_recent_files",
    "read_file",
    "search_files",
    "read_file_metadata",
    "search_file_contents",
    "create_directory",
    "write_file",
    "append_file",
    "edit_file",
    "rename_path",
    "move_path",
    "copy_path",
    "delete_path",
    "open_path",
    "open_url",
    "list_installed_apps",
    "find_app",
    "launch_app",
    "open_with_app",
    "list_processes",
    "close_app",
    "run_command",
    "start_command",
    "command_output",
    "stop_command",
];

/// How long an unanswered in-chat approval stays live before it is dropped.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_GRANTS: usize = 200;
const MAX_RECENT_FILES: usize = 50;

/// Access labels carried by an approval prompt. Only `contents` and `launch`
/// can be saved, and only for the exact file or executable named in the card.
const READ_SCOPE: &str = "read";
const CONTENT_SCOPE: &str = "contents";
const LAUNCH_SCOPE: &str = "launch";

#[derive(Default)]
pub struct DesktopToolState {
    policy: Mutex<Option<ToolPolicy>>,
    /// Bumped on every real policy change. A tool call captures this before it
    /// runs and rechecks it before touching the disk, so a mode or workspace
    /// switch that lands while a card is on screen cannot authorize the old read.
    generation: Arc<AtomicU64>,
    broker: Arc<ApprovalBroker>,
    scopes: Arc<Mutex<ApprovedScope>>,
    /// One flag per in-flight chat operation. Stop flips the flag and denies
    /// that operation's pending approval, which releases the paused call
    /// before it can touch the disk.
    cancels: Arc<CancelRegistry>,
    /// Commands and apps started during a chat turn. Stop kills the turn's
    /// background commands; an app the user asked to open stays open.
    processes: Arc<ProcessRegistry>,
}

impl DesktopToolState {
    /// Called on app exit so a dev server or long command cannot outlive the
    /// window that owns it.
    pub fn shutdown(&self) {
        self.processes.kill_all_commands();
        self.broker.cancel_all();
    }
}

#[derive(Default)]
pub struct CancelRegistry {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// A Stop can arrive before the call it is meant to stop (the client has a
    /// queued call, or a duplicate arrives late). Remembering the id turns that
    /// race into a cancelled call instead of a fresh unprotected one.
    cancelled: Mutex<VecDeque<String>>,
}

impl CancelRegistry {
    fn begin(&self, operation_id: &str) -> Arc<AtomicBool> {
        let already_cancelled = self
            .cancelled
            .lock()
            .map(|cancelled| cancelled.iter().any(|id| id == operation_id))
            .unwrap_or(false);
        let flag = Arc::new(AtomicBool::new(already_cancelled));
        if let Ok(mut flags) = self.flags.lock() {
            flags.insert(operation_id.to_string(), flag.clone());
        }
        flag
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let mut had_flag = false;
        if let Ok(flags) = self.flags.lock() {
            if let Some(flag) = flags.get(operation_id) {
                flag.store(true, Ordering::SeqCst);
                had_flag = true;
            }
        }
        if let Ok(mut cancelled) = self.cancelled.lock() {
            if !cancelled.iter().any(|id| id == operation_id) {
                cancelled.push_back(operation_id.to_string());
                while cancelled.len() > MAX_CANCELLED_OPERATIONS {
                    cancelled.pop_front();
                }
            }
        }
        had_flag
    }

    fn finish(&self, operation_id: &str) {
        if let Ok(mut flags) = self.flags.lock() {
            flags.remove(operation_id);
        }
    }

}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum ApprovalDecision {
    Denied,
    Once,
    AlwaysResource,
}

impl ApprovalDecision {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "deny" | "denied" | "cancel" => Ok(Self::Denied),
            "once" | "allow_once" => Ok(Self::Once),
            "always" | "allow_always" => Ok(Self::AlwaysResource),
            _ => Err("Unrecognized permission decision.".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalPrompt {
    request_id: String,
    /// Identifies the pending approval so identical concurrent requests join it
    /// instead of opening a second card.
    approval_key: String,
    /// The chat operation this decision belongs to. Stop cancels by this id.
    operation_id: String,
    tool: String,
    action: String,
    /// The folder the decision actually covers.
    scope_path: String,
    scope_name: String,
    summary: String,
    /// `read`, `contents`, `write`, `delete`, `launch` or `execute`.
    access: String,
    read_only: bool,
    modifies_data: bool,
    destructive: bool,
    /// The exact command line or executable the user is approving, when the
    /// operation is more than a path.
    command: Option<String>,
    /// Extra facts the card shows (source, destination, shell, cwd, PID).
    details: Vec<String>,
    /// True only when this card names one exact file or executable and the
    /// answer may be saved for that resource. Folder reads, writes, deletes,
    /// commands and process control are always per call.
    can_persist: bool,
    expires_at: i64,
}

#[derive(Default)]
struct PendingApproval {
    request_id: String,
    owner: String,
    operation_id: String,
    decision: Mutex<Option<ApprovalDecision>>,
    ready: Condvar,
}

#[derive(Default)]
pub struct ApprovalBroker {
    pending: Mutex<HashMap<String, Arc<PendingApproval>>>,
}

impl ApprovalBroker {
    /// Blocks until the user answers, the request expires, or an identical
    /// request that is already pending answers. Concurrent duplicates share one
    /// decision, so one logical request can never raise two cards.
    fn request(&self, app: &AppHandle, owner: &str, prompt: &ApprovalPrompt) -> ApprovalDecision {
        let key = prompt.approval_key.clone();
        let mut guard = match self.pending.lock() {
            Ok(guard) => guard,
            Err(_) => return ApprovalDecision::Denied,
        };
        if let Some(existing) = guard.get(&key) {
            let joined = existing.clone();
            drop(guard);
            return Self::await_decision(&joined, APPROVAL_TIMEOUT);
        }
        let entry = Arc::new(PendingApproval {
            request_id: prompt.request_id.clone(),
            owner: owner.to_string(),
            operation_id: prompt.operation_id.clone(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        guard.insert(key.clone(), entry.clone());
        drop(guard);

        if app.emit("desktop-tool:approval", prompt).is_err() {
            self.drop_entry(&key, &entry);
            return ApprovalDecision::Denied;
        }
        let decision = Self::await_decision(&entry, APPROVAL_TIMEOUT);
        self.drop_entry(&key, &entry);
        decision
    }

    fn await_decision(entry: &Arc<PendingApproval>, timeout: Duration) -> ApprovalDecision {
        let Ok(mut guard) = entry.decision.lock() else {
            return ApprovalDecision::Denied;
        };
        let deadline = Instant::now() + timeout;
        while guard.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return ApprovalDecision::Denied;
            }
            let (next, wait) = match entry.ready.wait_timeout(guard, remaining) {
                Ok(result) => result,
                Err(_) => return ApprovalDecision::Denied,
            };
            guard = next;
            if guard.is_none() && wait.timed_out() {
                return ApprovalDecision::Denied;
            }
        }
        guard.unwrap_or(ApprovalDecision::Denied)
    }

    fn drop_entry(&self, key: &str, entry: &Arc<PendingApproval>) {
        if let Ok(mut guard) = self.pending.lock() {
            if guard
                .get(key)
                .map(|existing| Arc::ptr_eq(existing, entry))
                .unwrap_or(false)
            {
                guard.remove(key);
            }
        }
    }

    /// Resolves a pending request. Only an id the broker issued, that is still
    /// pending and that belongs to `owner` can be answered, so a stale or forged
    /// frontend response authorizes nothing.
    fn respond(&self, owner: &str, request_id: &str, decision: ApprovalDecision) -> Result<(), String> {
        let mut guard = self
            .pending
            .lock()
            .map_err(|_| "Permission state is unavailable.".to_string())?;
        let matched = guard
            .iter()
            .find(|(_, entry)| entry.request_id == request_id)
            .map(|(key, entry)| {
                if !owner.is_empty() && !entry.owner.is_empty() && entry.owner != owner {
                    return Err("That permission request belongs to another account.".to_string());
                }
                Ok((key.clone(), entry.clone()))
            });
        let Some(resolved) = matched else {
            return Err("That permission request is no longer pending.".to_string());
        };
        let (key, entry) = resolved?;
        guard.remove(&key);
        let mut current = entry
            .decision
            .lock()
            .map_err(|_| "Permission state is unavailable.".to_string())?;
        if current.is_some() {
            return Err("That permission request was already answered.".to_string());
        }
        *current = Some(decision);
        drop(current);
        entry.ready.notify_all();
        Ok(())
    }

    fn cancel_all(&self) -> Vec<String> {
        let Ok(mut guard) = self.pending.lock() else {
            return Vec::new();
        };
        let cancelled: Vec<String> = guard
            .values()
            .map(|entry| entry.request_id.clone())
            .collect();
        for entry in guard.values() {
            if let Ok(mut current) = entry.decision.lock() {
                if current.is_none() {
                    *current = Some(ApprovalDecision::Denied);
                }
            }
            entry.ready.notify_all();
        }
        guard.clear();
        cancelled
    }

    /// Denies only the cards raised by one chat operation. Another
    /// conversation's paused call keeps its prompt and its own decision.
    fn cancel_operation(&self, operation_id: &str) -> Vec<String> {
        let Ok(mut guard) = self.pending.lock() else {
            return Vec::new();
        };
        let matched: Vec<String> = guard
            .iter()
            .filter(|(_, entry)| entry.operation_id == operation_id)
            .map(|(key, _)| key.clone())
            .collect();
        let mut cancelled = Vec::new();
        for key in matched {
            if let Some(entry) = guard.remove(&key) {
                cancelled.push(entry.request_id.clone());
                if let Ok(mut current) = entry.decision.lock() {
                    if current.is_none() {
                        *current = Some(ApprovalDecision::Denied);
                    }
                }
                entry.ready.notify_all();
            }
        }
        cancelled
    }
}

/// One saved "Allow Always (Only for This File)" decision. A grant names one
/// canonical file or executable and the one access it covers; it is never a
/// folder, a prefix, or a pattern.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ResourceGrant {
    id: String,
    owner: String,
    #[serde(default)]
    path: String,
    /// `contents` for reading that file, `launch` for starting that executable.
    #[serde(default)]
    kind: String,
    created_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantFile {
    version: u32,
    grants: Vec<ResourceGrant>,
}

/// True only for a grant this build can enforce exactly: a named file or
/// executable, one of the two eligible access kinds. Older folder grants fail
/// this test and are dropped on load rather than widened into exact-file grants.
fn valid_resource_grant(grant: &ResourceGrant) -> bool {
    !grant.owner.trim().is_empty()
        && !grant.path.trim().is_empty()
        && (grant.kind == CONTENT_SCOPE || grant.kind == LAUNCH_SCOPE)
        && Path::new(&grant.path).is_absolute()
}

#[derive(Clone, Default)]
struct GrantStore {
    loaded: bool,
    directory: Option<PathBuf>,
    grants: Vec<ResourceGrant>,
}

impl GrantStore {
    fn ensure_loaded(&mut self, app: &AppHandle) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Ok(directory) = app.path().app_data_dir() else {
            return;
        };
        self.directory = Some(directory.clone());
        let Ok(raw) = fs::read(directory.join("desktop-tool-grants.json")) else {
            return;
        };
        if let Ok(file) = serde_json::from_slice::<GrantFile>(&raw) {
            self.grants = file
                .grants
                .into_iter()
                .filter(valid_resource_grant)
                .take(MAX_GRANTS)
                .collect();
        }
    }

    fn persist(&self) -> Result<(), String> {
        let Some(directory) = &self.directory else {
            return Ok(());
        };
        fs::create_dir_all(directory).map_err(|_| "Could not store the permission grant.".to_string())?;
        let file = GrantFile {
            version: 2,
            grants: self.grants.clone(),
        };
        let rendered =
            serde_json::to_vec_pretty(&file).map_err(|_| "Could not store the permission grant.".to_string())?;
        let path = directory.join("desktop-tool-grants.json");
        let tmp = directory.join("desktop-tool-grants.json.tmp");
        fs::write(&tmp, rendered).map_err(|_| "Could not store the permission grant.".to_string())?;
        fs::rename(&tmp, path).map_err(|_| "Could not store the permission grant.".to_string())?;
        Ok(())
    }

    fn insert(&mut self, grant: ResourceGrant) -> Result<(), String> {
        self.grants.retain(|existing| existing.id != grant.id);
        self.grants.retain(|existing| {
            !(existing.owner == grant.owner
                && existing.kind == grant.kind
                && same_path(Path::new(&existing.path), Path::new(&grant.path)))
        });
        self.grants.push(grant);
        if self.grants.len() > MAX_GRANTS {
            let overflow = self.grants.len() - MAX_GRANTS;
            self.grants.drain(0..overflow);
        }
        self.persist()
    }

    fn revoke(&mut self, owner: &str, id: &str) -> Option<ResourceGrant> {
        let index = self
            .grants
            .iter()
            .position(|grant| grant.owner == owner && grant.id == id)?;
        Some(self.grants.remove(index))
    }

    fn clear(&mut self, owner: &str) -> Result<usize, String> {
        let before = self.grants.len();
        self.grants.retain(|grant| grant.owner != owner);
        let removed = before - self.grants.len();
        self.persist()?;
        Ok(removed)
    }

    /// Covers exactly the canonical resource that was approved. A sibling, a
    /// parent folder, another file in the same folder, or another kind of
    /// access never matches because the comparison is path equality, not
    /// containment.
    fn covers(&self, owner: &str, kind: &str, target: &Path) -> bool {
        self.grants.iter().any(|grant| {
            grant.owner == owner
                && grant.kind == kind
                && same_path(Path::new(&grant.path), target)
        })
    }

    fn for_owner(&self, owner: &str) -> Vec<ResourceGrant> {
        self.grants
            .iter()
            .filter(|grant| grant.owner == owner)
            .cloned()
            .collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ToolMode {
    Ask,
    Workspace,
    Full,
}

impl ToolMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ask" => Ok(Self::Ask),
            "workspace" => Ok(Self::Workspace),
            "full" => Ok(Self::Full),
            _ => Err("Unknown filesystem permission mode.".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Workspace => "workspace",
            Self::Full => "full",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask me every time",
            Self::Workspace => "Agent (workspace)",
            Self::Full => "Full access",
        }
    }

    /// How much the mode allows. Moving down the list is a narrowing switch,
    /// which is what revokes the standing consent the broader mode relied on.
    fn breadth(self) -> u8 {
        match self {
            Self::Ask => 0,
            Self::Workspace => 1,
            Self::Full => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ToolPolicy {
    owner: String,
    mode: ToolMode,
    workspace_root: Option<PathBuf>,
}

impl ToolPolicy {
    fn status(&self) -> PolicyStatus {
        PolicyStatus {
            mode: self.mode.as_str().to_string(),
            label: self.mode.label().to_string(),
            workspace_root: self.workspace_root.as_ref().map(|path| path_text(path)),
        }
    }
}

/// What a policy change must invalidate. A one-time approval belongs to the mode
/// and workspace that asked the question. Saved exact-resource permissions
/// survive a switch between equally broad modes, but a narrowing switch (Full →
/// workspace → Ask) revokes them: the stricter mode would have asked again, so
/// keeping the broader mode's consent would quietly widen it.
#[derive(Debug, PartialEq, Eq)]
struct PolicyTransition {
    cancel_pending: bool,
    revoke_grants: bool,
}

fn policy_transition(current: Option<&ToolPolicy>, next: &ToolPolicy) -> PolicyTransition {
    let changed = current.map(|existing| existing != next).unwrap_or(true);
    let narrowed = current
        .map(|existing| next.mode.breadth() < existing.mode.breadth())
        .unwrap_or(false);
    PolicyTransition {
        cancel_pending: changed,
        revoke_grants: narrowed,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    mode: String,
    label: String,
    workspace_root: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPolicyInput {
    owner: String,
    mode: String,
    workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    tool: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    operation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFailure {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ToolFailure>,
}

impl ToolResponse {
    fn success(data: Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    fn failure(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(ToolFailure {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug)]
enum Prepared {
    None,
    Launch(LaunchPlan),
    Command { spec: CommandSpec, background: bool },
}

#[derive(Debug)]
struct ResolvedRequest {
    tool: String,
    args: Value,
    /// The primary path the prompt describes. Empty for app and command tools.
    target: PathBuf,
    /// Every path that must stay inside the workspace. App executables and
    /// shell commands are deliberately not here: a shell is not sandboxed to a
    /// folder, so it is authorized by its own card instead.
    paths: Vec<PathBuf>,
    prepared: Prepared,
    requires_approval: bool,
    approval: ApprovalPrompt,
}

/// `read` covers enumerating a folder and reading entry metadata. `contents`
/// covers the bytes inside one file and is never implied by a folder grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccessScope {
    Read,
    Contents,
}

fn action_access(action: &str) -> &'static str {
    match action {
        "contents" | "search_contents" => CONTENT_SCOPE,
        "create" | "write" | "append" | "edit" | "rename" | "move" | "copy" => "write",
        "delete" => "delete",
        "open" | "open_url" | "launch" | "open_with" | "close" | "terminate" => "launch",
        "command" | "start_command" | "stop_command" => "execute",
        "app_list" | "app_find" | "process_list" | "command_output" => "system",
        _ => READ_SCOPE,
    }
}

fn action_read_only(action: &str) -> bool {
    matches!(
        action,
        "locate"
            | "list"
            | "recent"
            | "search"
            | "contents"
            | "metadata"
            | "search_contents"
            | "app_list"
            | "app_find"
            | "process_list"
            | "command_output"
    )
}

fn action_modifies_data(action: &str) -> bool {
    matches!(
        action,
        "create" | "write" | "append" | "edit" | "rename" | "move" | "copy" | "delete" | "command"
            | "start_command"
    )
}

/// "Allow Always" is only meaningful for an operation on one exact resource:
/// reading one file's contents, or launching one executable. Folder listings,
/// metadata, writes, deletes, commands and process control stay per call.
fn action_persistable(action: &str) -> bool {
    matches!(action, "contents" | "launch")
}

/// The prompt can offer "Always" only when its scope is one real file or
/// executable that the grant store can match exactly later. Protected system
/// locations, network shares and links are never saved.
fn exact_resource_can_persist(path: &Path) -> bool {
    if path.as_os_str().is_empty() || is_network_path(&path_text(path)) {
        return false;
    }
    if is_protected_system_path(path) {
        return false;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.is_file() && !metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

fn binary_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .as_deref(),
        Some(
            "pdf" | "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ppt"
                | "pptx"
                | "odt"
                | "ods"
                | "odp"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "bmp"
                | "webp"
                | "ico"
                | "tif"
                | "tiff"
                | "psd"
                | "mp3"
                | "wav"
                | "flac"
                | "ogg"
                | "m4a"
                | "mp4"
                | "mov"
                | "avi"
                | "mkv"
                | "webm"
                | "zip"
                | "7z"
                | "rar"
                | "gz"
                | "tar"
                | "exe"
                | "dll"
                | "sys"
                | "bin"
                | "iso"
                | "db"
                | "sqlite"
                | "sqlite3"
                | "msi"
        )
    )
}

fn unsupported_binary_failure(path: &Path) -> ToolFailure {
    ToolFailure {
        code: "unsupported_format".into(),
        message: format!(
            "VupsRouter can open or read metadata for {}, but it cannot edit that binary format. \
             No file was changed.",
            path_text(path)
        ),
    }
}

fn text_content_failure(path: &Path) -> ToolFailure {
    ToolFailure {
        code: "unsupported_format".into(),
        message: format!(
            "That file is not UTF-8 text, so VupsRouter will not edit or overwrite it. \
             No file was changed. Path: {}",
            path_text(path)
        ),
    }
}


fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn truncate_text(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn path_text(path: &Path) -> String {
    display_path(path).to_string_lossy().to_string()
}

fn is_network_path(raw: &str) -> bool {
    let value = raw.trim();
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("\\\\?\\unc\\") || lower.starts_with("//?/unc/") {
        return true;
    }
    (value.starts_with("\\\\") && !value.starts_with("\\\\?\\"))
        || (value.starts_with("//") && !value.starts_with("//?/"))
}

fn is_sensitive_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    workspace::skipped_directory(name)
        || matches!(
            lower.as_str(),
            "appdata"
                | "application data"
                | "local settings"
                | "cookies"
                | "recent"
                | "temporary internet files"
        )
}

fn is_sensitive_file(name: &str) -> bool {
    workspace::sensitive_file(name)
}

fn canonical_for_policy(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .map(|canonical| display_path(&canonical))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn component_eq(left: &Component<'_>, right: &Component<'_>) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

/// Component-wise containment on canonical paths. Deliberately not a string
/// prefix test: `C:\Users\V\DownloadsEvil` must not match a grant over
/// `C:\Users\V\Downloads`, and a case difference must not defeat one.
fn path_within(root: &Path, target: &Path) -> bool {
    let root_canonical = canonical_for_policy(root);
    let target_canonical = canonical_for_policy(target);
    let root_parts: Vec<Component<'_>> = root_canonical.components().collect();
    let target_parts: Vec<Component<'_>> = target_canonical.components().collect();
    root_parts.len() <= target_parts.len()
        && root_parts
            .iter()
            .zip(target_parts.iter())
            .all(|(a, b)| component_eq(a, b))
}

/// Exact identity for a saved resource grant: the same path after
/// canonicalization and case folding, and nothing else. A symlink resolves to
/// its target here, but tool paths reject symlink components before a grant is
/// ever consulted, so a link can never carry an approval to another file.
fn same_path(left: &Path, right: &Path) -> bool {
    let left_canonical = canonical_for_policy(left);
    let right_canonical = canonical_for_policy(right);
    let left_parts: Vec<Component<'_>> = left_canonical.components().collect();
    let right_parts: Vec<Component<'_>> = right_canonical.components().collect();
    left_parts.len() == right_parts.len()
        && left_parts
            .iter()
            .zip(right_parts.iter())
            .all(|(a, b)| component_eq(a, b))
}

fn folder_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path_text(path))
}

fn system_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for name in [
        "SystemRoot",
        "windir",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                paths.push(canonical_for_policy(Path::new(value.trim())));
            }
        }
    }
    for fallback in [
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\ProgramData",
        "C:\\$Recycle.Bin",
        "C:\\System Volume Information",
        "C:\\Recovery",
        "C:\\PerfLogs",
    ] {
        let path = canonical_for_policy(Path::new(fallback));
        if path.exists() {
            paths.push(path);
        }
    }
    paths
}

fn is_protected_system_path(path: &Path) -> bool {
    let canonical = canonical_for_policy(path);
    let lower = path_text(&canonical).to_ascii_lowercase();
    if lower.starts_with("\\\\?\\unc\\") {
        return true;
    }
    if canonical.parent().is_none() {
        return true;
    }
    // Component-wise and case-insensitive: `c:\windows\system32` is the same
    // protected folder as `C:\Windows\System32`.
    system_paths()
        .iter()
        .any(|system| path_within(system, &canonical))
}

/// Full access is broad, but a protected system location is never silently
/// covered by an earlier "always allow" card: each one is answered on its own.
fn requires_fresh_approval(policy: &ToolPolicy, target: &Path) -> bool {
    matches!(policy.mode, ToolMode::Full) && is_protected_system_path(target)
}

fn path_requires_approval(policy: &ToolPolicy, path: &Path) -> bool {
    match policy.mode {
        ToolMode::Ask => true,
        ToolMode::Workspace => policy
            .workspace_root
            .as_ref()
            .map(|root| !path_within(root, path))
            .unwrap_or(true),
        ToolMode::Full => {
            is_protected_system_path(path)
                || is_network_path(&path_text(path))
                || path
                    .file_name()
                    .map(|name| is_sensitive_file(&name.to_string_lossy()))
                    .unwrap_or(false)
        }
    }
}

fn reject_symlink_components(path: &Path) -> Result<(), ToolFailure> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(ToolFailure {
                    code: "invalid_path".into(),
                    message: "Parent-directory traversal is not allowed.".into(),
                })
            }
            Component::Normal(name) => {
                current.push(name);
                if let Ok(metadata) = fs::symlink_metadata(&current) {
                    if metadata.file_type().is_symlink() {
                        return Err(ToolFailure {
                            code: "symlink_rejected".into(),
                            message: "Symbolic links and junctions are not available to AI filesystem tools."
                                .into(),
                        });
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_absolute_no_traversal(raw: &str) -> Result<PathBuf, ToolFailure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_PATH_CHARS {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "Enter a valid absolute Windows path.".into(),
        });
    }
    if is_network_path(trimmed) {
        return Err(ToolFailure {
            code: "network_path_rejected".into(),
            message: "Network and UNC paths are not available to AI filesystem tools.".into(),
        });
    }
    if trimmed.starts_with(r"\\?\") || trimmed.starts_with("//?/") {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "Use a normal drive path; verbatim \\\\?\\ paths are not accepted.".into(),
        });
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "Filesystem tools require an absolute path.".into(),
        });
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "Parent-directory traversal is not allowed.".into(),
        });
    }
    Ok(path.to_path_buf())
}

fn resolve_existing_path(raw: &str, want_dir: bool) -> Result<PathBuf, ToolFailure> {
    let path = validate_absolute_no_traversal(raw)?;
    reject_symlink_components(&path)?;
    let canonical =
        fs::canonicalize(&path).map_err(|error| with_path(io_failure(error), &path))?;
    let readable = display_path(&canonical);
    let metadata =
        fs::metadata(&canonical).map_err(|error| with_path(io_failure(error), &path))?;
    if want_dir && !metadata.is_dir() {
        return Err(ToolFailure {
            code: "not_a_directory".into(),
            message: format!("That path is not a directory: {}.", path_text(&readable)),
        });
    }
    if !want_dir && !metadata.is_file() {
        return Err(ToolFailure {
            code: "not_a_file".into(),
            message: format!("That path is not a file: {}.", path_text(&readable)),
        });
    }
    Ok(readable)
}

fn resolve_existing_any(raw: &str) -> Result<PathBuf, ToolFailure> {
    let path = validate_absolute_no_traversal(raw)?;
    reject_symlink_components(&path)?;
    let canonical =
        fs::canonicalize(&path).map_err(|error| with_path(io_failure(error), &path))?;
    Ok(display_path(&canonical))
}

/// Resolves a path that may not exist yet. Existing ancestors are checked for
/// symlinks/junctions and canonicalized, so a new file cannot be written
/// through a link that escapes the workspace.
fn resolve_creation_path(raw: &str, allow_missing_parents: bool) -> Result<PathBuf, ToolFailure> {
    let path = validate_absolute_no_traversal(raw)?;
    if path.file_name().is_none() {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "That path does not name a file or folder.".into(),
        });
    }
    if !allow_missing_parents {
        let parent = path.parent().ok_or_else(|| ToolFailure {
            code: "invalid_path".into(),
            message: "That path has no parent folder.".into(),
        })?;
        reject_symlink_components(parent)?;
        let metadata =
            fs::metadata(parent).map_err(|error| with_path(io_failure(error), parent))?;
        if !metadata.is_dir() {
            return Err(ToolFailure {
                code: "not_a_directory".into(),
                message: format!("The parent is not a folder: {}.", path_text(parent)),
            });
        }
        let canonical_parent = display_path(
            &fs::canonicalize(parent).map_err(|error| with_path(io_failure(error), parent))?,
        );
        let destination = canonical_parent.join(path.file_name().unwrap_or_default());
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if metadata.file_type().is_symlink() {
                return Err(ToolFailure {
                    code: "symlink_rejected".into(),
                    message: "Symbolic links and junctions are not available to AI filesystem tools."
                        .into(),
                });
            }
        }
        return Ok(destination);
    }
    // Walk up to the nearest existing ancestor, then rebuild the missing tail
    // on top of its canonical path.
    let mut existing = path.as_path();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(ToolFailure {
                code: "invalid_path".into(),
                message: "That path has no usable root.".into(),
            });
        };
        missing.push(name.to_os_string());
        existing = existing.parent().ok_or_else(|| ToolFailure {
            code: "invalid_path".into(),
            message: "That path has no usable root.".into(),
        })?;
    }
    reject_symlink_components(existing)?;
    let metadata =
        fs::metadata(existing).map_err(|error| with_path(io_failure(error), existing))?;
    if !metadata.is_dir() {
        return Err(ToolFailure {
            code: "not_a_directory".into(),
            message: format!("That path is not a folder: {}.", path_text(existing)),
        });
    }
    let mut destination = display_path(
        &fs::canonicalize(existing).map_err(|error| with_path(io_failure(error), existing))?,
    );
    for part in missing.iter().rev() {
        destination.push(part);
    }
    Ok(destination)
}

fn path_same(left: &Path, right: &Path) -> bool {
    path_text(&canonical_for_policy(left)).eq_ignore_ascii_case(&path_text(&canonical_for_policy(right)))
}

fn normal_component_count(path: &Path) -> usize {
    path.components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
}

/// Top-level folders, the user's home, the known folders and the active
/// workspace are never renamed, moved or deleted as a whole by a tool. A model
/// that asks for it gets a refusal, not a catastrophic "success".
fn is_protected_root(path: &Path, workspace_root: Option<&Path>) -> bool {
    if is_protected_system_path(path) || normal_component_count(path) <= 1 {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        if path_same(path, &home) {
            return true;
        }
    }
    for folder in [
        dirs::download_dir(),
        dirs::desktop_dir(),
        dirs::document_dir(),
        dirs::picture_dir(),
        dirs::video_dir(),
        dirs::audio_dir(),
    ]
    .into_iter()
    .flatten()
    {
        if path_same(path, &folder) {
            return true;
        }
    }
    workspace_root
        .map(|root| path_same(path, root))
        .unwrap_or(false)
}

fn protected_root_failure(path: &Path) -> ToolFailure {
    ToolFailure {
        code: "protected_root".into(),
        message: format!(
            "{} is a top-level folder, a Windows folder, or the authorized workspace itself. \
             VupsRouter will not rename, move or delete it as a whole. Nothing was changed. \
             Ask for a specific file or subfolder instead.",
            path_text(path)
        ),
    }
}

fn ensure_safe_mutation_target(path: &Path) -> Result<(), ToolFailure> {
    if let Some(name) = path.file_name() {
        if is_sensitive_file(&name.to_string_lossy()) {
            return Err(ToolFailure {
                code: "sensitive_file".into(),
                message: "That file is excluded to protect credentials and secrets. Nothing was changed."
                    .into(),
            });
        }
    }
    if binary_extension(path) {
        return Err(unsupported_binary_failure(path));
    }
    Ok(())
}

/// Windows reports `fs::canonicalize` results as verbatim paths
/// (`\\?\C:\Users\...`). Those are real paths but they are unreadable in a
/// permission prompt, and they hid the fact that the folder was the ordinary
/// Downloads directory.
fn display_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path.to_path_buf()
}

/// Keeps the real Windows failure next to our own wording. The OS description is
/// the only evidence that separates a genuine access denial from a missing
/// folder, and dropping it is what let the model invent permission advice.
fn io_failure(error: std::io::Error) -> ToolFailure {
    let detail = error.to_string();
    let reported = if detail.trim().is_empty() {
        "no further detail".to_string()
    } else {
        truncate_text(detail.trim(), 180)
    };
    eprintln!(
        "[vupsrouter] filesystem tool error kind={:?} raw_os_error={:?} detail={}",
        error.kind(),
        error.raw_os_error(),
        reported
    );
    match error.kind() {
        ErrorKind::NotFound => ToolFailure {
            code: "path_not_found".into(),
            message: format!(
                "That path does not exist for the signed-in Windows user. Windows reported: {reported}."
            ),
        },
        ErrorKind::PermissionDenied => ToolFailure {
            code: "access_denied".into(),
            message: format!(
                "Windows itself refused this read for the signed-in user's own account, so it is not a \
                 VupsRouter setting. No elevation or permission change was attempted. Windows reported: \
                 {reported}."
            ),
        },
        ErrorKind::InvalidInput => ToolFailure {
            code: "invalid_path".into(),
            message: format!("Windows rejected that path. Windows reported: {reported}."),
        },
        _ => ToolFailure {
            code: "filesystem_error".into(),
            message: format!(
                "Windows could not complete the filesystem request. Windows reported: {reported}."
            ),
        },
    }
}

/// Names the path the failure happened on, so an actionable error can be acted
/// on instead of read as a generic warning.
fn with_path(mut failure: ToolFailure, path: &Path) -> ToolFailure {
    failure.message = format!("{} Path: {}", failure.message, path_text(path));
    failure
}

fn system_known_folder(name: &str) -> Option<PathBuf> {
    match name {
        "downloads" => dirs::download_dir(),
        "desktop" => dirs::desktop_dir(),
        "documents" => dirs::document_dir(),
        "pictures" => dirs::picture_dir(),
        "videos" => dirs::video_dir(),
        "music" => dirs::audio_dir(),
        _ => None,
    }
}

fn known_folder_path(
    name: &str,
    resolver: impl Fn(&str) -> Option<PathBuf>,
) -> Result<(String, PathBuf), ToolFailure> {
    let normalized = name.trim().to_ascii_lowercase();
    if !matches!(
        normalized.as_str(),
        "downloads" | "desktop" | "documents" | "pictures" | "videos" | "music"
    ) {
        return Err(ToolFailure {
            code: "invalid_known_folder".into(),
            message: "Supported Windows folders are Downloads, Desktop, Documents, Pictures, Videos, and Music."
                .into(),
        });
    }
    let path = resolver(&normalized).ok_or_else(|| ToolFailure {
        code: "known_folder_unavailable".into(),
        message: format!("Windows did not report a {} folder for this account.", normalized),
    })?;
    Ok((normalized, path))
}

struct PromptSpec {
    action: &'static str,
    scope_path: String,
    scope_name: String,
    summary: String,
    command: Option<String>,
    details: Vec<String>,
    destructive: bool,
}

/// Builds the question the user actually answers. Each card names the exact
/// target; only cards for one file's contents or one executable can offer a
/// saved permission, and only for that exact resource.
fn make_prompt(
    policy: &ToolPolicy,
    tool: &str,
    spec: PromptSpec,
    operation_id: &str,
) -> ApprovalPrompt {
    let access = action_access(spec.action);
    let can_persist = action_persistable(spec.action)
        && exact_resource_can_persist(Path::new(&spec.scope_path));
    let scope_key = format!(
        "{}|{}|{}|{}",
        policy.owner,
        access,
        spec.scope_path.to_ascii_lowercase(),
        spec.command
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase()
    );
    let approval_key = if operation_id.is_empty() {
        scope_key
    } else {
        // Two chats doing the same thing are two separate decisions.
        format!("{operation_id}|{scope_key}")
    };
    ApprovalPrompt {
        request_id: uuid::Uuid::new_v4().to_string(),
        approval_key,
        operation_id: operation_id.to_string(),
        tool: tool.to_string(),
        action: spec.action.to_string(),
        scope_path: spec.scope_path,
        scope_name: spec.scope_name,
        summary: spec.summary,
        access: access.to_string(),
        read_only: action_read_only(spec.action),
        modifies_data: action_modifies_data(spec.action),
        destructive: spec.destructive,
        command: spec.command,
        details: spec.details,
        can_persist,
        expires_at: now_millis() + APPROVAL_TIMEOUT.as_millis() as i64,
    }
}

fn operation_id_of(request: &ToolRequest) -> String {
    request
        .operation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_text(value, 80))
        .unwrap_or_default()
}

/// Read cards: listing, searching, metadata, and one file's contents.
fn read_prompt(
    policy: &ToolPolicy,
    tool: &str,
    action: &'static str,
    target: &Path,
    scope_root: &Path,
    access: AccessScope,
    summary: String,
    details: Vec<String>,
    operation_id: &str,
) -> ApprovalPrompt {
    let scope_path = match access {
        AccessScope::Read => path_text(scope_root),
        AccessScope::Contents => path_text(target),
    };
    let scope_name = match access {
        AccessScope::Read => folder_display_name(scope_root),
        AccessScope::Contents => folder_display_name(target),
    };
    make_prompt(
        policy,
        tool,
        PromptSpec {
            action,
            scope_path,
            scope_name,
            summary,
            command: None,
            details,
            destructive: false,
        },
        operation_id,
    )
}

fn mutation_prompt(
    policy: &ToolPolicy,
    tool: &str,
    action: &'static str,
    scope_path: &Path,
    summary: String,
    details: Vec<String>,
    destructive: bool,
    operation_id: &str,
) -> ApprovalPrompt {
    make_prompt(
        policy,
        tool,
        PromptSpec {
            action,
            scope_path: path_text(scope_path),
            scope_name: folder_display_name(scope_path),
            summary,
            command: None,
            details,
            destructive,
        },
        operation_id,
    )
}

fn prompt_requires_approval(policy: &ToolPolicy, paths: &[PathBuf]) -> bool {
    match policy.mode {
        ToolMode::Ask => true,
        ToolMode::Workspace => false,
        ToolMode::Full => paths.iter().any(|path| path_requires_approval(policy, path)),
    }
}

/// Inside a workspace the dev-agent file edits run without a card, but a delete
/// is irreversible, so it keeps asking there. Full access is the mode that
/// explicitly opted out of repeated ordinary prompts; protected locations and
/// sensitive names still ask.
fn mutation_requires_approval(policy: &ToolPolicy, paths: &[PathBuf], destructive: bool) -> bool {
    match policy.mode {
        ToolMode::Ask => true,
        ToolMode::Workspace => destructive,
        ToolMode::Full => paths.iter().any(|path| path_requires_approval(policy, path)),
    }
}

fn app_control_requires_approval(policy: &ToolPolicy) -> bool {
    !matches!(policy.mode, ToolMode::Full)
}

fn required_str<'a>(args: &'a Value, key: &str, message: &str) -> Result<&'a str, ToolFailure> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolFailure {
            code: "invalid_arguments".into(),
            message: message.into(),
        })
}

fn optional_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn process_key(args: &Value) -> Result<String, ToolFailure> {
    if let Some(key) = args
        .get("processId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(key.to_string());
    }
    if let Some(pid) = args.get("processId").and_then(Value::as_u64) {
        return Ok(pid.to_string());
    }
    Err(ToolFailure {
        code: "invalid_arguments".into(),
        message: "Use the processId (or PID) that VupsRouter reported for the process.".into(),
    })
}

fn validate_new_name(raw: &str) -> Result<String, ToolFailure> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 255 || name == "." || name == ".." {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "Enter a single valid Windows file or folder name.".into(),
        });
    }
    if name
        .chars()
        .any(|value| matches!(value, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "A new name cannot contain a path separator or a reserved Windows character."
                .into(),
        });
    }
    Ok(name.to_string())
}

fn validate_url(raw: &str) -> Result<String, ToolFailure> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "Only http and https links can be opened.".into(),
        });
    }
    if trimmed.chars().count() > 2_048 {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "That URL is too long to open.".into(),
        });
    }
    Ok(trimmed.to_string())
}

fn validate_content(content: &str) -> Result<(), ToolFailure> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(ToolFailure {
            code: "content_too_large".into(),
            message: format!("Keep written content under {} MB.", MAX_WRITE_BYTES / (1024 * 1024)),
        });
    }
    if content.contains('\0') {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "Text content cannot contain a NUL byte.".into(),
        });
    }
    Ok(())
}

fn ensure_not_sensitive(path: &Path) -> Result<(), ToolFailure> {
    if path
        .file_name()
        .map(|name| is_sensitive_file(&name.to_string_lossy()))
        .unwrap_or(false)
    {
        return Err(ToolFailure {
            code: "sensitive_file".into(),
            message: "That file is excluded to protect credentials and secrets. Nothing was changed."
                .into(),
        });
    }
    Ok(())
}

fn default_working_directory(policy: &ToolPolicy) -> PathBuf {
    policy
        .workspace_root
        .clone()
        .or_else(dirs::home_dir)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(std::env::temp_dir)
}

fn resolve_request(policy: &ToolPolicy, request: &ToolRequest) -> Result<ResolvedRequest, ToolFailure> {
    if !DESKTOP_TOOL_NAMES.contains(&request.tool.as_str()) {
        return Err(ToolFailure {
            code: "unknown_tool".into(),
            message: format!("The local tool \"{}\" is not available.", truncate_text(&request.tool, 80)),
        });
    }
    let args = request.args.clone();
    let tool = request.tool.as_str();
    let operation_id = operation_id_of(request);
    let mut target = PathBuf::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut prepared = Prepared::None;
    let mut requires_approval = false;

    let approval = match tool {
        "get_windows_known_folder" => {
            let name = required_str(&args, "name", "The known-folder tool needs a folder name.")?;
            let (normalized, path) = known_folder_path(name, system_known_folder)?;
            target = path.clone();
            // Windows reports this path; no directory entry is read.
            let _ = policy;
            read_prompt(
                policy,
                tool,
                "locate",
                &path,
                &path,
                AccessScope::Read,
                format!("Locate your {normalized} folder"),
                Vec::new(),
                &operation_id,
            )
        }
        "list_directory" => {
            let path = resolve_existing_path(
                required_str(&args, "path", "The directory tool needs an absolute path.")?,
                true,
            )?;
            target = path.clone();
            paths.push(path.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "list",
                &path,
                &path,
                AccessScope::Read,
                format!("List the contents of {}", path_text(&path)),
                Vec::new(),
                &operation_id,
            )
        }
        "list_recent_files" => {
            let path = resolve_existing_path(
                required_str(
                    &args,
                    "path",
                    "The recent-files tool needs an absolute directory path.",
                )?,
                true,
            )?;
            target = path.clone();
            paths.push(path.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "recent",
                &path,
                &path,
                AccessScope::Read,
                format!("Find the newest files in {}", path_text(&path)),
                vec![format!("Newest {} files", recent_limit(&args))],
                &operation_id,
            )
        }
        "read_file" => {
            let path = resolve_existing_path(
                required_str(&args, "path", "The read tool needs an absolute file path.")?,
                false,
            )?;
            ensure_not_sensitive(&path)?;
            if binary_extension(&path) {
                return Err(ToolFailure {
                    code: "unsupported_format".into(),
                    message: format!(
                        "VupsRouter can report metadata or open {}, but it cannot read that binary \
                         format as text.",
                        path_text(&path)
                    ),
                });
            }
            target = path.clone();
            paths.push(path.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "contents",
                &path,
                &path,
                AccessScope::Contents,
                format!("Read {}", path_text(&path)),
                Vec::new(),
                &operation_id,
            )
        }
        "read_file_metadata" => {
            let path = resolve_existing_any(required_str(
                &args,
                "path",
                "The metadata tool needs an absolute path.",
            )?)?;
            ensure_not_sensitive(&path)?;
            let scope_root = path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone());
            target = path.clone();
            paths.push(path.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "metadata",
                &path,
                &scope_root,
                AccessScope::Read,
                format!("Read metadata for {}", path_text(&path)),
                Vec::new(),
                &operation_id,
            )
        }
        "search_files" => {
            let root = resolve_existing_path(
                required_str(&args, "root", "The search tool needs an absolute root folder.")?,
                true,
            )?;
            let query = required_str(&args, "query", "The search tool needs a filename query.")?;
            if query.chars().count() > MAX_QUERY_CHARS {
                return Err(ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "Keep the filename search query under 120 characters.".into(),
                });
            }
            target = root.clone();
            paths.push(root.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "search",
                &root,
                &root,
                AccessScope::Read,
                format!("Search file names under {}", path_text(&root)),
                vec![format!("Name contains \"{}\"", truncate_text(query, 120))],
                &operation_id,
            )
        }
        "search_file_contents" => {
            let root = resolve_existing_path(
                required_str(&args, "root", "The content search needs an absolute root folder.")?,
                true,
            )?;
            let query = required_str(&args, "query", "The content search needs text to look for.")?;
            if query.chars().count() > 200 {
                return Err(ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "Keep the content search query under 200 characters.".into(),
                });
            }
            target = root.clone();
            paths.push(root.clone());
            requires_approval = prompt_requires_approval(policy, &paths);
            read_prompt(
                policy,
                tool,
                "search_contents",
                &root,
                &root,
                AccessScope::Contents,
                format!("Search the text inside files under {}", path_text(&root)),
                vec![format!("Text contains \"{}\"", truncate_text(query, 200))],
                &operation_id,
            )
        }
        "create_directory" => {
            let path = resolve_creation_path(
                required_str(&args, "path", "The folder tool needs an absolute path.")?,
                false,
            )?;
            target = path.clone();
            paths.push(path.clone());
            requires_approval = mutation_requires_approval(policy, &paths, false);
            mutation_prompt(
                policy,
                tool,
                "create",
                &path,
                format!("Create the folder {}", path_text(&path)),
                Vec::new(),
                false,
                &operation_id,
            )
        }
        "write_file" | "append_file" => {
            let path = resolve_creation_path(
                required_str(&args, "path", "The write tool needs an absolute file path.")?,
                false,
            )?;
            ensure_safe_mutation_target(&path)?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The write tool needs the text to write.".into(),
                })?;
            validate_content(content)?;
            let exists = fs::symlink_metadata(&path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false);
            if exists {
                if fs::metadata(&path).map(|metadata| metadata.len() > MAX_WRITE_BYTES as u64).unwrap_or(false) {
                    return Err(ToolFailure {
                        code: "file_too_large".into(),
                        message: "That file is larger than the 2 MB edit limit. Nothing was changed."
                            .into(),
                    });
                }
            }
            target = path.clone();
            paths.push(path.clone());
            let append = tool == "append_file";
            requires_approval = mutation_requires_approval(policy, &paths, false);
            let action = if append {
                "append"
            } else if exists {
                "edit"
            } else {
                "create"
            };
            let summary = if append {
                format!("Append text to {}", path_text(&path))
            } else if exists {
                format!("Overwrite {}", path_text(&path))
            } else {
                format!("Create the file {}", path_text(&path))
            };
            let mut details = vec![format!("{} bytes of UTF-8 text", content.len())];
            if exists && !append {
                details.push("Replaces the file's current contents".into());
            }
            mutation_prompt(policy, tool, action, &path, summary, details, false, &operation_id)
        }
        "edit_file" => {
            let path = resolve_existing_path(
                required_str(&args, "path", "The edit tool needs an absolute file path.")?,
                false,
            )?;
            ensure_safe_mutation_target(&path)?;
            let find = args
                .get("find")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The edit tool needs the exact text to find.".into(),
                })?;
            let replace = args
                .get("replace")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The edit tool needs the replacement text.".into(),
                })?;
            validate_content(find)?;
            validate_content(replace)?;
            if fs::metadata(&path).map(|metadata| metadata.len() > MAX_WRITE_BYTES as u64).unwrap_or(false) {
                return Err(ToolFailure {
                    code: "file_too_large".into(),
                    message: "That file is larger than the 2 MB edit limit. Nothing was changed.".into(),
                });
            }
            target = path.clone();
            paths.push(path.clone());
            requires_approval = mutation_requires_approval(policy, &paths, false);
            mutation_prompt(
                policy,
                tool,
                "edit",
                &path,
                format!("Edit {}", path_text(&path)),
                vec![format!("Find: \"{}\"", truncate_text(find, 120))],
                false,
                &operation_id,
            )
        }
        "rename_path" => {
            let path = resolve_existing_any(required_str(
                &args,
                "path",
                "The rename tool needs the path to rename.",
            )?)?;
            ensure_not_sensitive(&path)?;
            if is_protected_root(&path, policy.workspace_root.as_deref()) {
                return Err(protected_root_failure(&path));
            }
            let new_name = validate_new_name(required_str(
                &args,
                "newName",
                "The rename tool needs the new name.",
            )?)?;
            let parent = path.parent().ok_or_else(|| ToolFailure {
                code: "invalid_path".into(),
                message: "That path has no parent folder.".into(),
            })?;
            let destination = parent.join(&new_name);
            target = path.clone();
            paths.push(path.clone());
            paths.push(destination.clone());
            requires_approval = mutation_requires_approval(policy, &paths, false);
            mutation_prompt(
                policy,
                tool,
                "rename",
                &path,
                format!("Rename {} to {}", path_text(&path), new_name),
                vec![format!("New path: {}", path_text(&destination))],
                false,
                &operation_id,
            )
        }
        "move_path" | "copy_path" => {
            let source = resolve_existing_any(required_str(
                &args,
                "source",
                "The tool needs an absolute source path.",
            )?)?;
            ensure_not_sensitive(&source)?;
            let destination = resolve_creation_path(
                required_str(&args, "destination", "The tool needs an absolute destination path.")?,
                false,
            )?;
            if path_same(&source, &destination) {
                return Err(ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The source and destination are the same path. Nothing was changed."
                        .into(),
                });
            }
            if path_within(&source, &destination) {
                return Err(ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "A folder cannot be moved or copied inside itself. Nothing was changed."
                        .into(),
                });
            }
            if fs::symlink_metadata(&destination).is_ok() {
                return Err(ToolFailure {
                    code: "path_exists".into(),
                    message: format!(
                        "{} already exists. Choose a destination that does not exist so no work is \
                         overwritten.",
                        path_text(&destination)
                    ),
                });
            }
            let moving = tool == "move_path";
            if moving && is_protected_root(&source, policy.workspace_root.as_deref()) {
                return Err(protected_root_failure(&source));
            }
            target = source.clone();
            paths.push(source.clone());
            paths.push(destination.clone());
            requires_approval = mutation_requires_approval(policy, &paths, false);
            let action = if moving { "move" } else { "copy" };
            mutation_prompt(
                policy,
                tool,
                action,
                &source,
                format!(
                    "{} {} to {}",
                    if moving { "Move" } else { "Copy" },
                    path_text(&source),
                    path_text(&destination)
                ),
                vec![format!("Destination: {}", path_text(&destination))],
                false,
                &operation_id,
            )
        }
        "delete_path" => {
            let path = resolve_existing_any(required_str(
                &args,
                "path",
                "The delete tool needs the path to delete.",
            )?)?;
            ensure_not_sensitive(&path)?;
            if is_protected_root(&path, policy.workspace_root.as_deref()) {
                return Err(protected_root_failure(&path));
            }
            target = path.clone();
            paths.push(path.clone());
            requires_approval = mutation_requires_approval(policy, &paths, true);
            mutation_prompt(
                policy,
                tool,
                "delete",
                &path,
                format!("Permanently delete {}", path_text(&path)),
                vec![
                    "This cannot be undone: VupsRouter does not move items to the Recycle Bin."
                        .into(),
                ],
                true,
                &operation_id,
            )
        }
        "open_path" => {
            let path = resolve_existing_any(required_str(
                &args,
                "path",
                "The open tool needs an absolute path.",
            )?)?;
            target = path.clone();
            paths.push(path.clone());
            requires_approval = match policy.mode {
                ToolMode::Ask | ToolMode::Workspace => true,
                ToolMode::Full => path_requires_approval(policy, &path),
            };
            let kind = if path.is_dir() { "folder in File Explorer" } else { "file in its default app" };
            mutation_prompt(
                policy,
                tool,
                "open",
                &path,
                format!("Open {} {}", path_text(&path), kind),
                Vec::new(),
                false,
                &operation_id,
            )
        }
        "open_url" => {
            let url = validate_url(required_str(&args, "url", "The open tool needs a URL.")?)?;
            requires_approval = app_control_requires_approval(policy);
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "open_url",
                    scope_path: url.clone(),
                    scope_name: "the default browser".into(),
                    summary: format!("Open {url} in the default browser"),
                    command: Some(url),
                    details: Vec::new(),
                    destructive: false,
                },
                &operation_id,
            )
        }
        "list_installed_apps" => make_prompt(
            policy,
            tool,
            PromptSpec {
                action: "app_list",
                scope_path: "Installed applications".into(),
                scope_name: "Installed applications".into(),
                summary: "List installed applications".into(),
                command: None,
                details: Vec::new(),
                destructive: false,
            },
            &operation_id,
        ),
        "find_app" => {
            let query = required_str(&args, "name", "The app lookup needs an app name.")?;
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "app_find",
                    scope_path: format!("App search: {query}"),
                    scope_name: "Installed applications".into(),
                    summary: format!("Find an installed app named \"{query}\""),
                    command: None,
                    details: Vec::new(),
                    destructive: false,
                },
                &operation_id,
            )
        }
        "launch_app" => {
            let plan = find_app_plan(
                optional_str(&args, "name"),
                optional_str(&args, "path"),
                args.get("args").unwrap_or(&Value::Null),
                optional_str(&args, "cwd"),
            )
            .map_err(exec_failure)?;
            let command_line = std::iter::once(path_text(&plan.exe))
                .chain(plan.args.iter().cloned())
                .collect::<Vec<_>>()
                .join(" ");
            target = plan.exe.clone();
            requires_approval = app_control_requires_approval(policy);
            let mut details = vec![format!("Executable: {}", path_text(&plan.exe))];
            if !plan.alternatives.is_empty() {
                details.push(format!("Other matches: {}", plan.alternatives.join("; ")));
            }
            let prompt = make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "launch",
                    scope_path: path_text(&plan.exe),
                    scope_name: plan.name.clone(),
                    summary: format!("Launch {}", plan.name),
                    command: Some(command_line),
                    details,
                    destructive: false,
                },
                &operation_id,
            );
            prepared = Prepared::Launch(plan);
            prompt
        }
        "open_with_app" => {
            let path = resolve_existing_any(required_str(
                &args,
                "path",
                "Opening with an app needs an absolute path.",
            )?)?;
            target = path.clone();
            paths.push(path.clone());
            let app = optional_str(&args, "app");
            match app {
                Some(app) => {
                    let looks_absolute = Path::new(app).is_absolute();
                    let mut plan = if looks_absolute {
                        find_app_plan(None, Some(app), &Value::Null, None)
                    } else {
                        find_app_plan(Some(app), None, &Value::Null, None)
                    }
                    .map_err(exec_failure)?;
                    plan.args.push(path_text(&path));
                    requires_approval = match policy.mode {
                        ToolMode::Ask | ToolMode::Workspace => true,
                        ToolMode::Full => path_requires_approval(policy, &path),
                    };
                    let prompt = make_prompt(
                        policy,
                        tool,
                        PromptSpec {
                            action: "open_with",
                            scope_path: path_text(&path),
                            scope_name: plan.name.clone(),
                            summary: format!("Open {} with {}", path_text(&path), plan.name),
                            command: Some(format!("{} {}", path_text(&plan.exe), path_text(&path))),
                            details: vec![format!("Executable: {}", path_text(&plan.exe))],
                            destructive: false,
                        },
                        &operation_id,
                    );
                    prepared = Prepared::Launch(plan);
                    prompt
                }
                None => {
                    requires_approval = match policy.mode {
                        ToolMode::Ask | ToolMode::Workspace => true,
                        ToolMode::Full => path_requires_approval(policy, &path),
                    };
                    mutation_prompt(
                        policy,
                        tool,
                        "open_with",
                        &path,
                        format!("Open {} with its default app", path_text(&path)),
                        Vec::new(),
                        false,
                        &operation_id,
                    )
                }
            }
        }
        "list_processes" => {
            let filter = optional_str(&args, "name").unwrap_or("all visible processes");
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "process_list",
                    scope_path: "Running applications".into(),
                    scope_name: "Running applications".into(),
                    summary: format!("List running applications ({filter})"),
                    command: None,
                    details: Vec::new(),
                    destructive: false,
                },
                &operation_id,
            )
        }
        "close_app" => {
            let key = process_key(&args)?;
            let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
            requires_approval = force || app_control_requires_approval(policy);
            target = PathBuf::from(&key);
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: if force { "terminate" } else { "close" },
                    scope_path: format!("Process {key}"),
                    scope_name: format!("Process {key}"),
                    summary: if force {
                        format!("Force-terminate the VupsRouter-launched app (process {key})")
                    } else {
                        format!("Ask the VupsRouter-launched app to close (process {key})")
                    },
                    command: None,
                    details: vec![
                        "Only a process VupsRouter launched can be closed; unrelated system \
                         processes are never touched."
                            .into(),
                    ],
                    destructive: force,
                },
                &operation_id,
            )
        }
        "run_command" | "start_command" => {
            let spec = CommandSpec::parse(&args, default_working_directory(policy)).map_err(exec_failure)?;
            let background = tool == "start_command";
            requires_approval = match policy.mode {
                ToolMode::Ask | ToolMode::Workspace => true,
                ToolMode::Full => path_requires_approval(policy, &spec.cwd),
            };
            target = spec.cwd.clone();
            let shell = spec.shell.as_str().to_string();
            let prompt = make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: if background { "start_command" } else { "command" },
                    scope_path: path_text(&spec.cwd),
                    scope_name: format!("{shell} command"),
                    summary: if background {
                        format!("Start a background {shell} command")
                    } else {
                        format!("Run a {shell} command")
                    },
                    command: Some(spec.command.clone()),
                    details: vec![
                        format!("Shell: {shell}"),
                        format!("Working directory: {}", path_text(&spec.cwd)),
                        format!("Timeout: {} seconds", spec.timeout.as_secs()),
                    ],
                    destructive: false,
                },
                &operation_id,
            );
            prepared = Prepared::Command { spec, background };
            prompt
        }
        "command_output" => {
            let key = process_key(&args)?;
            target = PathBuf::from(&key);
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "command_output",
                    scope_path: format!("Process {key}"),
                    scope_name: format!("Process {key}"),
                    summary: format!("Read the output of VupsRouter command {key}"),
                    command: None,
                    details: Vec::new(),
                    destructive: false,
                },
                &operation_id,
            )
        }
        "stop_command" => {
            let key = process_key(&args)?;
            target = PathBuf::from(&key);
            make_prompt(
                policy,
                tool,
                PromptSpec {
                    action: "stop_command",
                    scope_path: format!("Process {key}"),
                    scope_name: format!("Process {key}"),
                    summary: format!("Stop VupsRouter command {key}"),
                    command: None,
                    details: Vec::new(),
                    destructive: false,
                },
                &operation_id,
            )
        }
        _ => unreachable!(),
    };
    Ok(ResolvedRequest {
        tool: tool.to_string(),
        args,
        target,
        paths,
        prepared,
        requires_approval,
        approval,
    })
}

fn recent_limit(args: &Value) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(5)
        .clamp(1, MAX_RECENT_FILES)
}

fn modified_millis(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
}

/// Windows marks folder-customization and thumbnail caches as hidden system
/// entries. They are noise in every ordinary listing and were the single
/// biggest source of redundant permission prompts.
fn is_system_noise(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "desktop.ini" | "thumbs.db" | ".ds_store" | "$recycle.bin" | "ehthumbs.db"
    )
}

fn hidden_attributes(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        let attributes = metadata.file_attributes();
        attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn list_directory(path: &Path) -> Result<Value, ToolFailure> {
    let read_dir = fs::read_dir(path).map_err(|error| with_path(io_failure(error), path))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for child in read_dir {
        if entries.len() >= MAX_LIST_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(child) = child else { continue };
        let name = child.file_name().to_string_lossy().to_string();
        let child_path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&child_path) else {
            continue
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let is_dir = metadata.is_dir();
        if (is_dir && is_sensitive_dir(&name)) || (!is_dir && is_sensitive_file(&name)) {
            continue;
        }
        let kind = if is_dir { "directory" } else { "file" };
        let mut entry = json!({
            "name": name,
            "kind": kind,
            "path": path_text(&child_path),
            // Sorted answers must come from this call: without a timestamp the
            // model has to ask for metadata once per file, which means one
            // permission decision per file.
            "modifiedAt": modified_millis(&metadata),
            "systemEntry": is_system_noise(&name) || hidden_attributes(&metadata)
        });
        if !is_dir {
            entry["size"] = json!(metadata.len());
        }
        entries.push(entry);
    }
    entries.sort_by(|left, right| {
        let left_dir = left.get("kind").and_then(Value::as_str) == Some("directory");
        let right_dir = right.get("kind").and_then(Value::as_str) == Some("directory");
        right_dir
            .cmp(&left_dir)
            .then_with(|| {
                left.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .cmp(
                        &right
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_ascii_lowercase(),
                    )
            })
    });
    Ok(json!({
        "path": path_text(path),
        "entries": entries,
        "truncated": truncated
    }))
}

/// Answers "what are the N newest files here" in one privileged call: enumerate,
/// drop directories and hidden/system entries, sort by modification time. The
/// model used to do this with one metadata call per file, which meant one
/// permission decision per file.
fn list_recent_files(path: &Path, args: &Value) -> Result<Value, ToolFailure> {
    let limit = recent_limit(args);
    let include_system = args
        .get("includeSystemEntries")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let read_dir = fs::read_dir(path).map_err(|error| with_path(io_failure(error), path))?;
    let mut candidates: Vec<(Option<i64>, Value)> = Vec::new();
    let mut skipped = 0usize;
    let mut scanned = 0usize;
    for child in read_dir {
        let Ok(child) = child else { continue };
        scanned += 1;
        if scanned > MAX_LIST_ENTRIES {
            break;
        }
        let name = child.file_name().to_string_lossy().to_string();
        let child_path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&child_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if is_sensitive_file(&name) {
            continue;
        }
        if !include_system && (is_system_noise(&name) || hidden_attributes(&metadata)) {
            skipped += 1;
            continue;
        }
        let modified = modified_millis(&metadata);
        candidates.push((
            modified,
            json!({
                "name": name,
                "path": path_text(&child_path),
                "kind": "file",
                "size": metadata.len(),
                "modifiedAt": modified,
                "extension": child_path
                    .extension()
                    .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default()
            }),
        ));
    }
    // Newest first; entries Windows did not give a timestamp for sort last
    // rather than pretending to be recent.
    candidates.sort_by(|left, right| match (left.0, right.0) {
        (Some(a), Some(b)) => b.cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let files: Vec<Value> = candidates
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry)
        .collect();
    let oldest = files
        .iter()
        .filter_map(|entry| entry.get("modifiedAt").and_then(Value::as_i64))
        .min();
    let newest = files
        .iter()
        .filter_map(|entry| entry.get("modifiedAt").and_then(Value::as_i64))
        .max();
    Ok(json!({
        "path": path_text(path),
        "files": files,
        "returned": files.len(),
        "matched": scanned,
        "skippedSystemEntries": skipped,
        "sortedBy": "lastModified",
        "newestModifiedAt": newest,
        "oldestModifiedAt": oldest,
        "note": "Ordered by last-modified time, newest first. Windows does not record a separate download time, so a file copied or edited later appears as newer."
    }))
}

fn read_file(path: &Path) -> Result<Value, ToolFailure> {
    let metadata = fs::metadata(path).map_err(|error| with_path(io_failure(error), path))?;
    if metadata.len() > MAX_READ_BYTES {
        return Err(ToolFailure {
            code: "file_too_large".into(),
            message: "That file is larger than the 256 KB read limit.".into(),
        });
    }
    let bytes = fs::read(path).map_err(|error| with_path(io_failure(error), path))?;
    if bytes.contains(&0) {
        return Err(ToolFailure {
            code: "binary_file".into(),
            message: "Only UTF-8 text files can be read.".into(),
        });
    }
    let content = String::from_utf8(bytes).map_err(|_| ToolFailure {
        code: "binary_file".into(),
        message: "Only UTF-8 text files can be read.".into(),
    })?;
    Ok(json!({
        "path": path_text(path),
        "name": path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        "size": metadata.len(),
        "content": content
    }))
}

fn read_metadata(path: &Path) -> Result<Value, ToolFailure> {
    let metadata = fs::metadata(path).map_err(|error| with_path(io_failure(error), path))?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);
    Ok(json!({
        "path": path_text(path),
        "name": path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        "kind": if metadata.is_dir() { "directory" } else { "file" },
        "size": metadata.len(),
        "readonly": metadata.permissions().readonly(),
        "modifiedAt": modified,
        "extension": path.extension().map(|value| value.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
    }))
}

struct SearchState<'a> {
    root: &'a Path,
    query: &'a str,
    max_depth: usize,
    max_results: usize,
    started: Instant,
    scanned: usize,
    entries: Vec<Value>,
    truncated: bool,
    timed_out: bool,
    cancelled: bool,
}

fn search_directory(
    state: &mut SearchState<'_>,
    directory: &Path,
    depth: usize,
    is_cancelled: &dyn Fn() -> bool,
) {
    if state.cancelled || is_cancelled() {
        state.cancelled = true;
        return;
    }
    if state.timed_out || state.entries.len() >= state.max_results || state.scanned >= MAX_SEARCH_ENTRIES {
        state.truncated = true;
        return;
    }
    if state.started.elapsed().as_millis() as u64 >= MAX_SEARCH_MS {
        state.timed_out = true;
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else {
        return;
    };
    for child in read_dir {
        if is_cancelled() {
            state.cancelled = true;
            return;
        }
        if state.timed_out || state.entries.len() >= state.max_results || state.scanned >= MAX_SEARCH_ENTRIES {
            state.truncated = true;
            return;
        }
        let Ok(child) = child else { continue };
        let name = child.file_name().to_string_lossy().to_string();
        let child_path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&child_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        state.scanned += 1;
        if metadata.is_dir() {
            if is_sensitive_dir(&name) || depth >= state.max_depth {
                if depth >= state.max_depth {
                    state.truncated = true;
                }
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&child_path) else {
                continue;
            };
            // `fs::canonicalize` answers in Windows verbatim form while the
            // search root arrives as a display path, so a bare `starts_with`
            // compares two encodings of the same folder and matches nothing.
            if !path_within(state.root, &canonical) {
                continue;
            }
            search_directory(state, &canonical, depth + 1, is_cancelled);
            if state.cancelled {
                return;
            }
            continue;
        }
        if !metadata.is_file() || is_sensitive_file(&name) {
            continue;
        }
        if name.to_ascii_lowercase().contains(&state.query.to_ascii_lowercase()) {
            state.entries.push(json!({
                "name": name,
                "kind": "file",
                "path": path_text(&display_path(&child_path)),
                "size": metadata.len()
            }));
            if state.entries.len() >= state.max_results {
                state.truncated = true;
                return;
            }
        }
    }
}

fn search_files(
    root: &Path,
    args: &Value,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Value, ToolFailure> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if query.is_empty() {
        return Err(ToolFailure {
            code: "invalid_arguments".into(),
            message: "The search tool needs a filename query.".into(),
        });
    }
    let max_depth = args
        .get("maxDepth")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(4)
        .clamp(1, MAX_SEARCH_DEPTH);
    let max_results = args
        .get("maxResults")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(50)
        .clamp(1, MAX_SEARCH_RESULTS);
    let mut state = SearchState {
        root,
        query,
        max_depth,
        max_results,
        started: Instant::now(),
        scanned: 0,
        entries: Vec::new(),
        truncated: false,
        timed_out: false,
        cancelled: false,
    };
    search_directory(&mut state, root, 0, is_cancelled);
    if state.cancelled {
        return Err(ToolFailure {
            code: "cancelled".into(),
            message: "The search was stopped at your request.".into(),
        });
    }
    Ok(json!({
        "root": path_text(root),
        "query": query,
        "entries": state.entries,
        "truncated": state.truncated,
        "timedOut": state.timed_out,
        "scanned": state.scanned
    }))
}

fn exec_failure(error: ExecError) -> ToolFailure {
    ToolFailure {
        code: error.code,
        message: error.message,
    }
}

fn cancelled_tool_failure() -> ToolFailure {
    ToolFailure {
        code: "cancelled".into(),
        message: "The operation was stopped at your request. Nothing further was run.".into(),
    }
}

struct ContentSearchState<'a> {
    root: &'a Path,
    query: &'a str,
    needle: String,
    case_sensitive: bool,
    max_depth: usize,
    max_results: usize,
    started: Instant,
    files_scanned: usize,
    bytes_scanned: u64,
    matches: Vec<Value>,
    truncated: bool,
    timed_out: bool,
    cancelled: bool,
}

fn content_search_directory(
    state: &mut ContentSearchState<'_>,
    directory: &Path,
    depth: usize,
    is_cancelled: &dyn Fn() -> bool,
) {
    if state.cancelled || is_cancelled() {
        state.cancelled = true;
        return;
    }
    if state.timed_out || state.matches.len() >= state.max_results {
        state.truncated = true;
        return;
    }
    if state.files_scanned >= MAX_CONTENT_SEARCH_FILES
        || state.bytes_scanned >= MAX_CONTENT_SEARCH_BYTES
        || state.started.elapsed().as_millis() as u64 >= MAX_CONTENT_SEARCH_MS
    {
        state.timed_out = state.started.elapsed().as_millis() as u64 >= MAX_CONTENT_SEARCH_MS;
        state.truncated = true;
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else {
        return;
    };
    for child in read_dir {
        if is_cancelled() {
            state.cancelled = true;
            return;
        }
        if state.timed_out
            || state.matches.len() >= state.max_results
            || state.files_scanned >= MAX_CONTENT_SEARCH_FILES
            || state.bytes_scanned >= MAX_CONTENT_SEARCH_BYTES
        {
            state.truncated = true;
            return;
        }
        let Ok(child) = child else { continue };
        let name = child.file_name().to_string_lossy().to_string();
        let child_path = child.path();
        let Ok(metadata) = fs::symlink_metadata(&child_path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if is_sensitive_dir(&name) || depth >= state.max_depth {
                continue;
            }
            let Ok(canonical) = fs::canonicalize(&child_path) else {
                continue;
            };
            if !path_within(state.root, &canonical) {
                continue;
            }
            content_search_directory(state, &canonical, depth + 1, is_cancelled);
            if state.cancelled {
                return;
            }
            continue;
        }
        if !metadata.is_file()
            || is_sensitive_file(&name)
            || binary_extension(&child_path)
            || metadata.len() > MAX_READ_BYTES
        {
            continue;
        }
        state.files_scanned += 1;
        let Ok(bytes) = fs::read(&child_path) else {
            continue;
        };
        // A NUL byte is the cheap signal that this is not a text file. Binary
        // formats are reported by read_file_metadata; they are not grepped.
        if bytes.contains(&0) {
            continue;
        }
        state.bytes_scanned += bytes.len() as u64;
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let hit = if state.case_sensitive {
                line.contains(state.query)
            } else {
                line.to_ascii_lowercase().contains(&state.needle)
            };
            if !hit {
                continue;
            }
            state.matches.push(json!({
                "path": path_text(&display_path(&child_path)),
                "name": name,
                "line": index + 1,
                "text": truncate_text(line.trim(), 240)
            }));
            if state.matches.len() >= state.max_results {
                state.truncated = true;
                return;
            }
        }
    }
}

fn search_file_contents(
    root: &Path,
    args: &Value,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Value, ToolFailure> {
    let query = required_str(args, "query", "The content search needs text to look for.")?;
    let case_sensitive = args
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let max_depth = args
        .get("maxDepth")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(5)
        .clamp(1, MAX_SEARCH_DEPTH);
    let max_results = args
        .get("maxResults")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(40)
        .clamp(1, 100);
    let mut state = ContentSearchState {
        root,
        query,
        needle: query.to_ascii_lowercase(),
        case_sensitive,
        max_depth,
        max_results,
        started: Instant::now(),
        files_scanned: 0,
        bytes_scanned: 0,
        matches: Vec::new(),
        truncated: false,
        timed_out: false,
        cancelled: false,
    };
    content_search_directory(&mut state, root, 0, is_cancelled);
    if state.cancelled {
        return Err(cancelled_tool_failure());
    }
    Ok(json!({
        "root": path_text(root),
        "query": query,
        "matches": state.matches,
        "filesScanned": state.files_scanned,
        "bytesScanned": state.bytes_scanned,
        "truncated": state.truncated,
        "timedOut": state.timed_out,
        "note": "Only UTF-8 text files up to 256 KB are searched; binary documents are not."
    }))
}

fn create_directory(path: &Path) -> Result<Value, ToolFailure> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.is_dir() {
            return Ok(json!({
                "path": path_text(path),
                "created": false,
                "alreadyExisted": true
            }));
        }
        return Err(ToolFailure {
            code: "path_exists".into(),
            message: format!("A file already exists at {}. Nothing was changed.", path_text(path)),
        });
    }
    fs::create_dir(path).map_err(|error| with_path(io_failure(error), path))?;
    Ok(json!({
        "path": path_text(path),
        "created": true,
        "alreadyExisted": false
    }))
}

fn current_size(path: &Path) -> u64 {
    fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0)
}

fn write_text_file(path: &Path, content: &str, append: bool) -> Result<Value, ToolFailure> {
    let existed = fs::symlink_metadata(path).is_ok();
    if existed {
        let metadata = fs::metadata(path).map_err(|error| with_path(io_failure(error), path))?;
        if metadata.is_dir() {
            return Err(ToolFailure {
                code: "path_exists".into(),
                message: format!("{} is a folder, not a file. Nothing was changed.", path_text(path)),
            });
        }
        let extra = if append { content.len() as u64 } else { 0 };
        if metadata.len() + extra > MAX_WRITE_BYTES as u64 {
            return Err(ToolFailure {
                code: "content_too_large".into(),
                message: "That write would make the file larger than the 2 MB limit. Nothing was changed."
                    .into(),
            });
        }
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(path)
        .map_err(|error| with_path(io_failure(error), path))?;
    file.write_all(content.as_bytes())
        .map_err(|error| with_path(io_failure(error), path))?;
    file.flush().map_err(|error| with_path(io_failure(error), path))?;
    let size = current_size(path);
    Ok(json!({
        "path": path_text(path),
        "name": path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default(),
        "bytesWritten": content.len(),
        "size": size,
        "created": !existed,
        "appended": append,
        "note": if append {
            "The text was appended; earlier contents were kept."
        } else if existed {
            "The file was overwritten."
        } else {
            "The file was created."
        }
    }))
}

fn edit_text_file(path: &Path, find: &str, replace: &str, all: bool) -> Result<Value, ToolFailure> {
    let bytes = fs::read(path).map_err(|error| with_path(io_failure(error), path))?;
    if bytes.contains(&0) {
        return Err(text_content_failure(path));
    }
    let text = String::from_utf8(bytes).map_err(|_| text_content_failure(path))?;
    let occurrences = text.matches(find).count();
    if occurrences == 0 {
        return Err(ToolFailure {
            code: "match_not_found".into(),
            message: format!(
                "The exact text to replace was not found in {}. Nothing was changed.",
                path_text(path)
            ),
        });
    }
    let updated = if all {
        text.replace(find, replace)
    } else {
        text.replacen(find, replace, 1)
    };
    validate_content(&updated)?;
    fs::write(path, updated.as_bytes()).map_err(|error| with_path(io_failure(error), path))?;
    Ok(json!({
        "path": path_text(path),
        "replacements": if all { occurrences } else { 1 },
        "bytesBefore": text.len(),
        "size": updated.len(),
        "note": "Only the matched text changed."
    }))
}

fn rename_entry(source: &Path, new_name: &str) -> Result<Value, ToolFailure> {
    let parent = source.parent().ok_or_else(|| ToolFailure {
        code: "invalid_path".into(),
        message: "That path has no parent folder.".into(),
    })?;
    let destination = parent.join(new_name);
    if path_text(source) == path_text(&destination) {
        return Ok(json!({
            "from": path_text(source),
            "to": path_text(&destination),
            "renamed": false,
            "note": "The name is unchanged."
        }));
    }
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(ToolFailure {
            code: "path_exists".into(),
            message: format!(
                "{} already exists. Nothing was overwritten.",
                path_text(&destination)
            ),
        });
    }
    fs::rename(source, &destination).map_err(|error| with_path(io_failure(error), source))?;
    Ok(json!({
        "from": path_text(source),
        "to": path_text(&destination),
        "renamed": true
    }))
}

#[derive(Default)]
struct CopyBudget {
    entries: usize,
    bytes: u64,
}

fn copy_entry(
    source: &Path,
    destination: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), ToolFailure> {
    if depth > MAX_COPY_DEPTH {
        return Err(ToolFailure {
            code: "too_deep".into(),
            message: "The folder tree is deeper than VupsRouter will copy. Nothing further was copied."
                .into(),
        });
    }
    let metadata = fs::symlink_metadata(source).map_err(|error| with_path(io_failure(error), source))?;
    if metadata.file_type().is_symlink() {
        return Err(ToolFailure {
            code: "symlink_rejected".into(),
            message: "Symbolic links and junctions are not copied.".into(),
        });
    }
    budget.entries += 1;
    if budget.entries > MAX_COPY_ENTRIES {
        return Err(ToolFailure {
            code: "too_many_entries".into(),
            message: format!(
                "That copy would exceed the {MAX_COPY_ENTRIES}-entry limit. Nothing further was copied."
            ),
        });
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(|error| with_path(io_failure(error), destination))?;
        let read_dir = fs::read_dir(source).map_err(|error| with_path(io_failure(error), source))?;
        for child in read_dir {
            let child = child.map_err(|error| with_path(io_failure(error), source))?;
            copy_entry(&child.path(), &destination.join(child.file_name()), depth + 1, budget)?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        let copied = fs::copy(source, destination)
            .map_err(|error| with_path(io_failure(error), source))?;
        budget.bytes += copied;
    }
    Ok(())
}

fn remove_tree(path: &Path, depth: usize, removed: &mut usize) -> Result<(), ToolFailure> {
    if depth > 128 {
        return Err(ToolFailure {
            code: "too_deep".into(),
            message: "The folder tree is deeper than VupsRouter will delete.".into(),
        });
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| with_path(io_failure(error), path))?;
    if metadata.file_type().is_symlink() {
        return Err(ToolFailure {
            code: "symlink_rejected".into(),
            message: "Symbolic links and junctions are not deleted by AI filesystem tools.".into(),
        });
    }
    if metadata.is_dir() {
        let read_dir = fs::read_dir(path).map_err(|error| with_path(io_failure(error), path))?;
        for child in read_dir {
            let child = child.map_err(|error| with_path(io_failure(error), path))?;
            remove_tree(&child.path(), depth + 1, removed)?;
        }
        fs::remove_dir(path).map_err(|error| with_path(io_failure(error), path))?;
    } else {
        fs::remove_file(path).map_err(|error| with_path(io_failure(error), path))?;
    }
    *removed += 1;
    Ok(())
}

fn move_entry(source: &Path, destination: &Path) -> Result<Value, ToolFailure> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(json!({
            "from": path_text(source),
            "to": path_text(destination),
            "moved": true,
            "crossVolume": false
        })),
        Err(error) if error.raw_os_error() == Some(17) => {
            // ERROR_NOT_SAME_DEVICE: Windows cannot rename across volumes, so
            // the move is a copy followed by a delete of the verified copy's
            // source. The source stays until the copy has fully succeeded.
            let mut budget = CopyBudget::default();
            copy_entry(source, destination, 0, &mut budget)?;
            let mut removed = 0usize;
            if let Err(error) = remove_tree(source, 0, &mut removed) {
                return Err(ToolFailure {
                    code: error.code,
                    message: format!(
                        "{} The copy exists at {}, but the original could not be removed.",
                        error.message,
                        path_text(destination)
                    ),
                });
            }
            Ok(json!({
                "from": path_text(source),
                "to": path_text(destination),
                "moved": true,
                "crossVolume": true,
                "entriesCopied": budget.entries,
                "bytesCopied": budget.bytes
            }))
        }
        Err(error) => Err(with_path(io_failure(error), source)),
    }
}

fn copy_entry_to(source: &Path, destination: &Path) -> Result<Value, ToolFailure> {
    let mut budget = CopyBudget::default();
    copy_entry(source, destination, 0, &mut budget)?;
    Ok(json!({
        "from": path_text(source),
        "to": path_text(destination),
        "copied": true,
        "entriesCopied": budget.entries,
        "bytesCopied": budget.bytes
    }))
}

fn delete_entry(path: &Path) -> Result<Value, ToolFailure> {
    let metadata = fs::symlink_metadata(path).map_err(|error| with_path(io_failure(error), path))?;
    let kind = if metadata.is_dir() { "directory" } else { "file" };
    let mut removed = 0usize;
    if metadata.is_dir() {
        remove_tree(path, 0, &mut removed)?;
    } else {
        fs::remove_file(path).map_err(|error| with_path(io_failure(error), path))?;
        removed = 1;
    }
    Ok(json!({
        "path": path_text(path),
        "kind": kind,
        "entriesDeleted": removed,
        "deleted": true,
        "recoverable": false,
        "note": "Permanently deleted. VupsRouter does not move items to the Recycle Bin."
    }))
}

fn run_resolved(
    request: &ResolvedRequest,
    processes: &ProcessRegistry,
    operation_id: &str,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Value, ToolFailure> {
    if is_cancelled() {
        return Err(cancelled_tool_failure());
    }
    match &request.prepared {
        Prepared::Launch(plan) => {
            return launch_plan(processes, operation_id, plan).map_err(exec_failure);
        }
        Prepared::Command { spec, background } => {
            if *background {
                let value = start_command(processes, operation_id, spec).map_err(exec_failure)?;
                if is_cancelled() {
                    if let Some(id) = value.get("processId").and_then(Value::as_str) {
                        let _ = stop_command(processes, id);
                    }
                    return Err(cancelled_tool_failure());
                }
                return Ok(value);
            }
            let outcome =
                run_command_blocking(processes, operation_id, spec, is_cancelled).map_err(exec_failure)?;
            if outcome.cancelled {
                return Err(cancelled_tool_failure());
            }
            return Ok(outcome.value);
        }
        Prepared::None => {}
    }
    match request.tool.as_str() {
        "get_windows_known_folder" => {
            let name = request
                .args
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("downloads")
                .trim()
                .to_ascii_lowercase();
            Ok(json!({
                "name": name,
                "path": path_text(&request.target),
                "exists": request.target.exists(),
                "source": "windows_known_folder"
            }))
        }
        "list_directory" => list_directory(&request.target),
        "list_recent_files" => list_recent_files(&request.target, &request.args),
        "read_file" => read_file(&request.target),
        "read_file_metadata" => read_metadata(&request.target),
        "search_files" => search_files(&request.target, &request.args, is_cancelled),
        "search_file_contents" => search_file_contents(&request.target, &request.args, is_cancelled),
        "create_directory" => create_directory(&request.target),
        "write_file" => write_text_file(&request.target, &content_arg(&request.args)?, false),
        "append_file" => write_text_file(&request.target, &content_arg(&request.args)?, true),
        "edit_file" => {
            let find = required_str(&request.args, "find", "The edit tool needs text to find.")?;
            let replace = request
                .args
                .get("replace")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The edit tool needs replacement text.".into(),
                })?;
            let all = request.args.get("all").and_then(Value::as_bool).unwrap_or(false);
            edit_text_file(&request.target, find, replace, all)
        }
        "rename_path" => {
            let name = validate_new_name(required_str(
                &request.args,
                "newName",
                "The rename tool needs the new name.",
            )?)?;
            rename_entry(&request.target, &name)
        }
        "move_path" | "copy_path" => {
            let destination = request.paths.get(1).cloned().ok_or_else(|| ToolFailure {
                code: "invalid_path".into(),
                message: "The destination path could not be resolved. Nothing was changed.".into(),
            })?;
            if request.tool == "move_path" {
                move_entry(&request.target, &destination)
            } else {
                copy_entry_to(&request.target, &destination)
            }
        }
        "delete_path" => delete_entry(&request.target),
        "open_path" => open_target(&request.target).map_err(exec_failure),
        "open_url" => {
            let url = validate_url(required_str(&request.args, "url", "The open tool needs a URL.")?)?;
            open_url(&url).map_err(exec_failure)
        }
        "list_installed_apps" => {
            let force = request
                .args
                .get("forceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let limit = request
                .args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(200)
                .clamp(1, 500);
            let mut apps = discover_apps(force).map_err(exec_failure)?;
            if let Some(query) = optional_str(&request.args, "query") {
                let needle = query.to_ascii_lowercase();
                apps.retain(|app| app.name.to_ascii_lowercase().contains(&needle));
            }
            apps.sort_by(|left, right| {
                left.name
                    .to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            });
            let total = apps.len();
            apps.truncate(limit);
            let returned = apps.len();
            Ok(json!({
                "apps": apps,
                "returned": returned,
                "total": total,
                "truncated": returned < total,
                "note": "Discovered from Windows App Paths and the Start Menu, not a fixed list. Use launch_app with the name or path."
            }))
        }
        "find_app" => {
            let query = required_str(&request.args, "name", "The app lookup needs an app name.")?;
            let apps = search_apps(false, query).map_err(exec_failure)?;
            if apps.is_empty() {
                return Err(ToolFailure {
                    code: "app_not_found".into(),
                    message: format!(
                        "No installed app matched \"{}\". VupsRouter did not launch anything.",
                        truncate_text(query, 120)
                    ),
                });
            }
            let total = apps.len();
            let best = apps.first().cloned();
            let matches: Vec<_> = apps.into_iter().take(10).collect();
            Ok(json!({
                "query": query,
                "best": best,
                "matches": matches,
                "total": total,
                "note": "Use launch_app with the exact name or path. Finding an app does not launch it."
            }))
        }
        "list_processes" => {
            let name = optional_str(&request.args, "name");
            let limit = request
                .args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(30);
            list_processes(processes, name, limit).map_err(exec_failure)
        }
        "close_app" => {
            let key = process_key(&request.args)?;
            let force = request.args.get("force").and_then(Value::as_bool).unwrap_or(false);
            close_app(processes, &key, force).map_err(exec_failure)
        }
        "command_output" => {
            let key = process_key(&request.args)?;
            let tail = request
                .args
                .get("tailLines")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(80);
            command_output(processes, &key, tail).map_err(exec_failure)
        }
        "stop_command" => {
            let key = process_key(&request.args)?;
            stop_command(processes, &key).map_err(exec_failure)
        }
        "open_with_app" => open_target(&request.target).map_err(exec_failure),
        _ => Err(ToolFailure {
            code: "unknown_tool".into(),
            message: "That local tool is not available.".into(),
        }),
    }
}

fn content_arg(args: &Value) -> Result<String, ToolFailure> {
    args.get("content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ToolFailure {
            code: "invalid_arguments".into(),
            message: "The write tool needs the text to write.".into(),
        })
}

/// The standing approvals for this account. "Allow once" is deliberately absent:
/// it authorizes only the call it answered, so the next operation asks again
/// instead of inheriting a decision the user made about different work.
#[derive(Clone, Default)]
struct ApprovedScope {
    grants: GrantStore,
}

impl ApprovedScope {
    fn covers(&mut self, policy: &ToolPolicy, prompt: &ApprovalPrompt) -> bool {
        // Only an exact file read or executable launch can be saved. Writes,
        // deletes, folder listings, commands and process control always ask.
        if !prompt.can_persist {
            return false;
        }
        // A path outside a workspace was already refused before this point, so
        // an exact-resource grant can never act as a second workspace.
        self.grants
            .covers(&policy.owner, &prompt.access, Path::new(&prompt.scope_path))
    }

    /// Only an explicit "Allow Always (Only for This File)" answer is stored,
    /// and only for the canonical resource the card showed.
    fn remember(
        &mut self,
        policy: &ToolPolicy,
        prompt: &ApprovalPrompt,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        if !prompt.can_persist {
            return Ok(());
        }
        match decision {
            ApprovalDecision::Denied | ApprovalDecision::Once => Ok(()),
            ApprovalDecision::AlwaysResource => self.grants.insert(ResourceGrant {
                id: uuid::Uuid::new_v4().to_string(),
                owner: policy.owner.clone(),
                path: path_text(&canonical_for_policy(Path::new(&prompt.scope_path))),
                kind: prompt.access.clone(),
                created_at: now_millis(),
            }),
        }
    }
}

/// `approve` is the only path to a decision. Production passes the in-chat
/// broker; tests pass a stub, which is what keeps the authorization order
/// (resolve, then gate, then approve, then touch the disk) under unit test.
#[cfg(test)]
fn execute_tool_with(
    policy: &ToolPolicy,
    request: &ToolRequest,
    scope: &mut ApprovedScope,
    approve: impl FnMut(&ApprovalPrompt) -> ApprovalDecision,
) -> ToolResponse {
    let processes = ProcessRegistry::default();
    execute_guarded(
        policy,
        request,
        scope,
        approve,
        &|| true,
        &|| false,
        &processes,
        operation_id_of(request).as_str(),
    )
}

fn policy_changed_failure(prompt: &ApprovalPrompt) -> ToolResponse {
    ToolResponse::failure(
        "policy_changed",
        format!(
            "The file access mode changed while this request was waiting, so {} did not run. \
             Ask again under the current mode.",
            prompt.scope_path
        ),
    )
}

fn cancelled_failure() -> ToolResponse {
    ToolResponse::failure(
        "cancelled",
        "The operation was stopped at your request. Nothing further was done.",
    )
}

fn outside_workspace_failure(root: &Path, target: &Path) -> ToolResponse {
    ToolResponse::failure(
        "outside_workspace",
        format!(
            "{} is outside the authorized workspace {}. Nothing was read or changed. Add that \
             folder as a workspace, or switch the permission mode.",
            path_text(target),
            path_text(root)
        ),
    )
}

/// `still_current` answers "is the policy that produced this decision still the
/// one in force?". `cancelled` answers "did the user stop this operation?".
/// Both are checked before the card, after the answer, and again immediately
/// before the disk or a process is touched, so a mode switch or a Stop that
/// lands while the card is on screen cannot authorize the operation.
fn execute_guarded(
    policy: &ToolPolicy,
    request: &ToolRequest,
    scope: &mut ApprovedScope,
    mut approve: impl FnMut(&ApprovalPrompt) -> ApprovalDecision,
    still_current: &dyn Fn() -> bool,
    cancelled: &dyn Fn() -> bool,
    processes: &ProcessRegistry,
    operation_id: &str,
) -> ToolResponse {
    let resolved = match resolve_request(policy, request) {
        Ok(resolved) => resolved,
        Err(error) => return ToolResponse::failure(&error.code, error.message),
    };
    if !still_current() {
        return policy_changed_failure(&resolved.approval);
    }
    if cancelled() {
        return cancelled_failure();
    }
    // Workspace mode is an authorization boundary, not a prompt: a path outside
    // the picked folder can never be reached by approving a card. It is
    // reported so the user can add the folder deliberately instead of the tool
    // silently widening the workspace. App launches and shell commands have no
    // file path here: a shell is not sandboxed to a folder, so it is authorized
    // by its own card that names the exact command.
    if policy.mode == ToolMode::Workspace {
        let Some(root) = policy.workspace_root.as_deref() else {
            return ToolResponse::failure(
                "workspace_required",
                "Agent (workspace) mode needs an authorized workspace folder. Pick a folder or \
                 switch modes. Nothing was read or changed.",
            );
        };
        for path in &resolved.paths {
            if !path_within(root, path) {
                return outside_workspace_failure(root, path);
            }
        }
    }
    if resolved.requires_approval {
        let prompt = &resolved.approval;
        let fresh = resolved
            .paths
            .iter()
            .any(|path| requires_fresh_approval(policy, path));
        if fresh || !scope.covers(policy, prompt) {
            if cancelled() {
                return cancelled_failure();
            }
            let granted = approve(prompt);
            if !still_current() {
                return policy_changed_failure(prompt);
            }
            if cancelled() {
                return cancelled_failure();
            }
            if granted == ApprovalDecision::Denied {
                return ToolResponse::failure(
                    "approval_denied",
                    format!(
                        "The user did not allow this operation on {}. Nothing was read or changed.",
                        prompt.scope_path
                    ),
                );
            }
            // A saved grant over a protected system location would turn "ask
            // every time" into "ask once", so that answer covers this call only.
            let remembered = if fresh && granted == ApprovalDecision::AlwaysResource {
                ApprovalDecision::Once
            } else {
                granted
            };
            if let Err(message) = scope.remember(policy, prompt, remembered) {
                return ToolResponse::failure("grant_store_failed", message);
            }
        }
        // Already authorized: recording it again would let a revocation be
        // shadowed by a copy of its own approval.
    }
    if !still_current() {
        return policy_changed_failure(&resolved.approval);
    }
    if cancelled() {
        return cancelled_failure();
    }
    match run_resolved(&resolved, processes, operation_id, cancelled) {
        Ok(data) => ToolResponse::success(data),
        Err(error) => ToolResponse::failure(&error.code, error.message),
    }
}

fn audit_target(request: &ToolRequest) -> String {
    for key in [
        "path",
        "root",
        "source",
        "destination",
        "url",
        "name",
        "query",
        "command",
        "processId",
    ] {
        if let Some(value) = request.args.get(key).and_then(Value::as_str) {
            return truncate_text(value.trim(), 300);
        }
    }
    String::new()
}

fn append_audit(
    app: &AppHandle,
    policy: &ToolPolicy,
    request: &ToolRequest,
    operation_id: &str,
    response: &ToolResponse,
) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("desktop-tool-audit.jsonl");
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_AUDIT_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, directory.join("desktop-tool-audit.1.jsonl"));
    }
    let line = json!({
        "at": now_millis(),
        "owner": truncate_text(&policy.owner, 128),
        "mode": policy.mode.as_str(),
        "operationId": truncate_text(operation_id, 80),
        "tool": truncate_text(&request.tool, 80),
        "target": audit_target(request),
        "ok": response.ok,
        "error": response.error.as_ref().map(|error| error.code.clone())
    });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondInput {
    request_id: String,
    decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    id: String,
    path: String,
    name: String,
    kind: String,
    created_at: i64,
}

/// No stored policy is a refusal, not a default. The app starts with tools
/// closed until the page that owns the saved mode installs it.
fn require_policy(slot: &Mutex<Option<ToolPolicy>>) -> Result<ToolPolicy, String> {
    let guard = slot
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    guard
        .clone()
        .ok_or_else(|| "Choose a filesystem permission mode before using local tools.".to_string())
}

fn policy_of(state: &State<'_, DesktopToolState>) -> Result<ToolPolicy, String> {
    require_policy(&state.policy)
}

#[tauri::command]
pub async fn desktop_tool_set_policy(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
    input: SetPolicyInput,
) -> Result<PolicyStatus, String> {
    let mode = ToolMode::parse(&input.mode)?;
    let owner = workspace::normalize_owner(&input.owner)?;
    let mut workspace_error = None;
    let workspace_root = if mode == ToolMode::Workspace {
        let id = input.workspace_id.unwrap_or_default();
        if id.trim().is_empty() {
            None
        } else {
            match workspace::workspace_path(&app, &owner, &id) {
                Ok(root) => Some(root),
                Err(message) => {
                    // A missing or unreadable workspace is not permission to
                    // roam the disk: the mode is still adopted, with no root,
                    // so every local tool call is refused until the folder is
                    // available again. The page is told why.
                    workspace_error = Some(message);
                    None
                }
            }
        }
    } else {
        None
    };
    let policy = ToolPolicy {
        owner,
        mode,
        workspace_root,
    };
    let grant_owner = policy.owner.clone();
    let status = policy.status();
    let transition = {
        let mut guard = state
            .policy
            .lock()
            .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
        let transition = policy_transition(guard.as_ref(), &policy);
        if transition.cancel_pending {
            *guard = Some(policy);
            state.generation.fetch_add(1, Ordering::SeqCst);
        }
        transition
    };
    if transition.cancel_pending {
        // Cards on screen describe a decision that is no longer being asked
        // for. Denying them first also releases a paused tool call before the
        // session state below is rewritten.
        state.broker.cancel_all();
        if transition.revoke_grants {
            if let Ok(mut scopes) = state.scopes.lock() {
                // A narrower mode must not inherit the saved file and
                // executable permissions handed out by the broader one.
                scopes.grants.ensure_loaded(&app);
                let _ = scopes.grants.clear(&grant_owner);
            }
        }
    }
    if let Some(message) = workspace_error {
        return Err(message);
    }
    Ok(status)
}

#[tauri::command]
pub async fn desktop_tool_policy_status(
    state: State<'_, DesktopToolState>,
) -> Result<PolicyStatus, String> {
    Ok(policy_of(&state)?.status())
}

#[tauri::command]
pub async fn desktop_tool_execute(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
    request: ToolRequest,
) -> Result<ToolResponse, String> {
    let policy = policy_of(&state)?;
    let audit_request = request.clone();
    let operation_id = request
        .operation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_text(value, 80))
        .unwrap_or_default();
    let cancel_flag = if operation_id.is_empty() {
        None
    } else {
        Some(state.cancels.begin(&operation_id))
    };
    let cancel_for_task = cancel_flag.clone();
    let broker = state.broker.clone();
    let scopes = state.scopes.clone();
    let generation = state.generation.clone();
    let started_at = generation.load(Ordering::SeqCst);
    let owner = policy.owner.clone();
    let scope_app = app.clone();
    let policy_for_execute = policy.clone();
    let processes = state.processes.clone();
    let operation_for_task = operation_id.clone();
    // The scope lock is taken inside the blocking task and held across the
    // approval wait on purpose: a concurrent duplicate then finds the decision
    // already recorded instead of asking a second time.
    let response = tauri::async_runtime::spawn_blocking(move || -> Result<ToolResponse, String> {
        let mut scope = scopes
            .lock()
            .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
        scope.grants.ensure_loaded(&scope_app);
        let app_for_prompt = scope_app.clone();
        let still_current = || generation.load(Ordering::SeqCst) == started_at;
        let cancelled = || {
            cancel_for_task
                .as_ref()
                .map(|flag| flag.load(Ordering::SeqCst))
                .unwrap_or(false)
        };
        Ok(execute_guarded(
            &policy_for_execute,
            &request,
            &mut scope,
            |prompt| broker.request(&app_for_prompt, &owner, prompt),
            &still_current,
            &cancelled,
            &processes,
            &operation_for_task,
        ))
    })
    .await
    .map_err(|_| "The Windows filesystem tool did not finish.".to_string())??;
    if !operation_id.is_empty() {
        state.cancels.finish(&operation_id);
    }
    append_audit(&app, &policy, &audit_request, &operation_id, &response);
    Ok(response)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOperationInput {
    operation_id: String,
}

/// Stop for one chat operation: deny its pending cards, flip the flag a running
/// tool checks between filesystem accesses, and kill the background commands
/// this turn started. Other operations keep their cards and continue untouched,
/// and an app the user explicitly asked to launch stays open.
#[tauri::command]
pub async fn desktop_tool_cancel_operation(
    state: State<'_, DesktopToolState>,
    input: CancelOperationInput,
) -> Result<Vec<String>, String> {
    let operation_id = input.operation_id.trim();
    if operation_id.is_empty() || operation_id.chars().count() > 80 {
        return Err("A valid operation id is required.".to_string());
    }
    let cancelled = state.broker.cancel_operation(operation_id);
    state.cancels.cancel(operation_id);
    let killed = state.processes.kill_operation(operation_id);
    let mut result = cancelled;
    for pid in killed {
        result.push(format!("process:{pid}"));
    }
    Ok(result)
}

#[tauri::command]
pub async fn desktop_tool_respond(
    state: State<'_, DesktopToolState>,
    input: RespondInput,
) -> Result<bool, String> {
    let policy = policy_of(&state)?;
    let decision = ApprovalDecision::parse(&input.decision)?;
    state
        .broker
        .respond(&policy.owner, input.request_id.trim(), decision)?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_tool_grants_list(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
) -> Result<Vec<GrantView>, String> {
    let policy = policy_of(&state)?;
    let mut scope = state
        .scopes
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    scope.grants.ensure_loaded(&app);
    Ok(scope
        .grants
        .for_owner(&policy.owner)
        .into_iter()
        .map(|grant| GrantView {
            id: grant.id,
            path: grant.path.clone(),
            name: folder_display_name(Path::new(&grant.path)),
            kind: grant.kind,
            created_at: grant.created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn desktop_tool_grant_revoke(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
    id: String,
) -> Result<bool, String> {
    let policy = policy_of(&state)?;
    let mut scope = state
        .scopes
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    scope.grants.ensure_loaded(&app);
    let Some(_grant) = scope.grants.revoke(&policy.owner, id.trim()) else {
        return Ok(false);
    };
    scope.grants.persist()?;
    Ok(true)
}

#[tauri::command]
pub async fn desktop_tool_grants_clear(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
) -> Result<usize, String> {
    let policy = policy_of(&state)?;
    state.broker.cancel_all();
    let mut scope = state
        .scopes
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    scope.grants.ensure_loaded(&app);
    scope.grants.clear(&policy.owner)
}

#[tauri::command]
pub async fn desktop_tool_approvals_cancel(
    state: State<'_, DesktopToolState>,
) -> Result<Vec<String>, String> {
    Ok(state.broker.cancel_all())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("vupsrouter-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test root");
        // Tests compare against the strings the tools echo back, and those are
        // display paths rather than Windows verbatim paths.
        display_path(
            &fs::canonicalize(&root).unwrap_or_else(|_| panic!("canonicalize {}", root.display())),
        )
    }

    fn write(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        let mut file = fs::File::create(path).expect("create file");
        file.write_all(content).expect("write file");
    }

    fn policy(mode: ToolMode, root: Option<&Path>) -> ToolPolicy {
        ToolPolicy {
            owner: "user_123".into(),
            mode,
            workspace_root: root.map(Path::to_path_buf),
        }
    }

    #[test]
    fn known_folders_use_the_windows_resolver_value() {
        let redirected = PathBuf::from(r"D:\OneDrive\Downloads");
        let (name, path) = known_folder_path("Downloads", |_| Some(redirected.clone())).unwrap();
        assert_eq!(name, "downloads");
        assert_eq!(path, redirected);
        assert!(known_folder_path("not-a-folder", |_| Some(redirected.clone())).is_err());
        assert!(known_folder_path("downloads", |_| None).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_known_folders_resolve_on_this_machine() {
        assert!(system_known_folder("downloads").is_some());
        assert!(system_known_folder("documents").is_some());
    }

    /// Runs the real task on this machine's own Downloads folder: one
    /// enumeration, newest first, names/dates/sizes only, never file bytes.
    #[cfg(windows)]
    #[test]
    fn the_real_downloads_folder_answers_the_five_file_task() {
        let downloads = system_known_folder("downloads").expect("Downloads resolves here");
        assert!(downloads.is_dir(), "{} is a directory", downloads.display());
        let data = list_recent_files(
            &downloads,
            &json!({ "path": downloads.to_string_lossy(), "limit": 5 }),
        )
        .expect("one enumeration of the real Downloads folder");
        let files = data["files"].as_array().expect("files array");
        assert!(files.len() <= 5, "at most the requested five");
        for entry in files {
            let name = entry["name"].as_str().unwrap_or_default();
            assert!(!is_system_noise(name), "{name} is not a real download");
            assert!(entry.get("content").is_none(), "no file bytes are read");
            eprintln!(
                "[real-downloads] {} · {} bytes · modified {}",
                name,
                entry["size"],
                entry["modifiedAt"]
            );
        }
        assert_eq!(data["sortedBy"].as_str(), Some("lastModified"));
    }

    #[test]
    fn permission_modes_enforce_workspace_boundaries() {
        let root = temp_root();
        let inside = root.join("inside.txt");
        let outside = std::env::temp_dir().join("outside-vupsrouter.txt");
        write(&inside, b"inside");
        write(&outside, b"outside");

        assert!(path_requires_approval(&policy(ToolMode::Ask, Some(&root)), &inside));
        assert!(!path_requires_approval(
            &policy(ToolMode::Workspace, Some(&root)),
            &inside
        ));
        assert!(path_requires_approval(
            &policy(ToolMode::Workspace, Some(&root)),
            &outside
        ));
        assert!(!path_requires_approval(&policy(ToolMode::Full, None), &inside));
        assert!(path_requires_approval(&policy(ToolMode::Workspace, None), &inside));

        fs::remove_dir_all(root).expect("remove test root");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn directory_listing_returns_metadata_and_skips_sensitive_files() {
        let root = temp_root();
        write(&root.join("notes.txt"), b"hello");
        write(&root.join(".env"), b"SECRET=1");
        fs::create_dir_all(root.join("src")).expect("create src");

        let result = list_directory(&root).expect("list directory");
        let entries = result.get("entries").and_then(Value::as_array).unwrap();
        assert!(entries.iter().any(|entry| entry["name"] == "notes.txt"));
        assert!(entries.iter().any(|entry| entry["name"] == "src"));
        assert!(!entries.iter().any(|entry| entry["name"] == ".env"));
        assert_eq!(entries[0]["kind"], "directory");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn read_is_bounded_and_rejects_sensitive_or_binary_files() {
        let root = temp_root();
        write(&root.join("notes.txt"), b"hello");
        write(&root.join(".env"), b"SECRET=1");
        write(&root.join("image.png"), b"\x89PNG");
        write(&root.join("large.txt"), &vec![b'a'; MAX_READ_BYTES as usize + 1]);

        let result = read_file(&root.join("notes.txt")).expect("read text");
        assert_eq!(result["content"], "hello");
        assert!(read_file(&root.join("image.png")).is_err());
        assert!(read_file(&root.join("large.txt")).is_err());

        let sensitive = resolve_request(
            &policy(ToolMode::Full, None),
            &ToolRequest {
                operation_id: None,
                tool: "read_file".into(),
                args: json!({ "path": root.join(".env").to_string_lossy() }),
            },
        );
        assert!(sensitive.is_err());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn metadata_does_not_read_file_contents() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let result = read_metadata(&file).expect("metadata");
        assert_eq!(result["name"], "notes.txt");
        assert_eq!(result["kind"], "file");
        assert!(result.get("content").is_none());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn search_is_bounded_and_skips_sensitive_directories() {
        let root = temp_root();
        write(&root.join("src").join("downloads.txt"), b"x");
        write(&root.join("src").join("other.txt"), b"x");
        write(&root.join(".ssh").join("downloads-key"), b"x");

        let result = search_files(
            &root,
            &json!({ "query": "downloads", "maxDepth": 4, "maxResults": 10 }),
            &|| false,
        )
        .expect("search");
        let entries = result.get("entries").and_then(Value::as_array).unwrap();
        assert!(entries.iter().any(|entry| entry["name"] == "downloads.txt"));
        assert!(!entries.iter().any(|entry| entry["name"] == "downloads-key"));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn traversal_and_relative_paths_are_rejected() {
        let root = temp_root();
        write(&root.join("notes.txt"), b"hello");
        let request = ToolRequest {
                operation_id: None,
            tool: "read_file".into(),
            args: json!({ "path": "../outside.txt" }),
        };
        assert!(resolve_request(&policy(ToolMode::Full, None), &request).is_err());
        let request = ToolRequest {
                operation_id: None,
            tool: "read_file".into(),
            args: json!({ "path": root.join("notes.txt").to_string_lossy() }),
        };
        assert!(resolve_request(&policy(ToolMode::Full, None), &request).is_ok());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn approval_denial_prevents_execution() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request = ToolRequest {
                operation_id: None,
            tool: "read_file".into(),
            args: json!({ "path": file.to_string_lossy() }),
        };
        let response = execute_tool_with(
            &policy(ToolMode::Ask, Some(&root)),
            &request,
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Denied,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "approval_denied");

        let response = execute_tool_with(
            &policy(ToolMode::Ask, Some(&root)),
            &request,
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(response.ok);
        assert_eq!(response.data.unwrap()["content"], "hello");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_mode_allows_inside_and_requires_approval_outside() {
        let root = temp_root();
        let inside = root.join("inside.txt");
        let outside = std::env::temp_dir().join(format!(
            "vupsrouter-outside-{}.txt",
            uuid::Uuid::new_v4()
        ));
        write(&inside, b"inside");
        write(&outside, b"outside");

        let inside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &ToolRequest {
                operation_id: None,
                tool: "read_file".into(),
                args: json!({ "path": inside.to_string_lossy() }),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Denied,
        );
        assert!(inside_response.ok);

        let mut outside_asked = 0usize;
        let outside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &ToolRequest {
                operation_id: None,
                tool: "read_file".into(),
                args: json!({ "path": outside.to_string_lossy() }),
            },
            &mut ApprovedScope::default(),
            |_| {
                outside_asked += 1;
                ApprovalDecision::Once
            },
        );
        assert_eq!(
            outside_asked, 0,
            "a path outside the workspace is refused, not offered to the user"
        );
        assert!(!outside_response.ok);
        assert_eq!(
            outside_response.error.as_ref().unwrap().code,
            "outside_workspace"
        );

        fs::remove_dir_all(root).expect("remove test root");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn invalid_tools_and_arguments_return_structured_errors() {
        let response = execute_tool_with(
            &policy(ToolMode::Full, None),
            &ToolRequest {
                operation_id: None,
                tool: "run_shell".into(),
                args: json!({}),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "unknown_tool");

        let response = execute_tool_with(
            &policy(ToolMode::Full, None),
            &ToolRequest {
                operation_id: None,
                tool: "read_file".into(),
                args: json!({}),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "invalid_arguments");
    }

    #[test]
    fn only_registered_tools_can_execute_and_invented_ones_never_prompt() {
        // A forged model or frontend request naming a tool that is not in the
        // registered set is rejected before any approval is asked, in every mode
        // including Full access. Names that merely look like ours are not ours.
        for name in [
            "delete_file",
            "move_file",
            "run_tests",
            "open_app",
            "shell_execute",
            "browser_navigate",
            "generate_image",
        ] {
            let mut asked = 0usize;
            let response = execute_tool_with(
                &policy(ToolMode::Full, None),
                &ToolRequest {
                    operation_id: Some("turn-forged".into()),
                    tool: name.into(),
                    args: json!({ "path": "C:\\temp" }),
                },
                &mut ApprovedScope::default(),
                |_| {
                    asked += 1;
                    ApprovalDecision::AlwaysResource
                },
            );
            assert_eq!(asked, 0, "{name} must not raise a permission card");
            assert!(!response.ok, "{name} must not execute");
            assert_eq!(response.error.expect("failure").code, "unknown_tool", "{name}");
        }

        // The tools this build actually advertises resolve, including the new
        // mutating, app and terminal capabilities.
        let root = temp_root();
        let resolved = resolve_request(
            &policy(ToolMode::Full, None),
            &tool(
                "write_file",
                json!({
                    "path": root.join("agent-test.txt").to_string_lossy(),
                    "content": "hello"
                }),
            ),
        )
        .expect("write_file is a registered tool");
        assert_eq!(resolved.tool, "write_file");
        assert_eq!(resolved.approval.access, "write");
        assert!(!resolved.approval.can_persist);
        fs::remove_dir_all(root).expect("remove test root");
    }

    fn tool(tool: &str, args: Value) -> ToolRequest {
        ToolRequest {
            operation_id: None,
            tool: tool.into(),
            args,
        }
    }

    #[test]
    fn allow_once_authorizes_only_the_operation_it_answered() {
        let root = temp_root();
        let downloads = root.join("Downloads");
        write(&downloads.join("a.txt"), b"a");
        write(&downloads.join("b.txt"), b"b");
        write(&downloads.join("desktop.ini"), b"[.ShellClassInfo]");

        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        for name in ["a.txt", "b.txt", "desktop.ini"] {
            let request = tool(
                "read_file_metadata",
                json!({ "path": downloads.join(name).to_string_lossy() }),
            );
            let response = execute_tool_with(&policy, &request, &mut scope, |prompt| {
                asked += 1;
                assert!(
                    prompt.scope_path.eq_ignore_ascii_case(&path_text(&downloads)),
                    "the decision is about the folder, not one file"
                );
                ApprovalDecision::Once
            });
            assert!(response.ok, "{}", name);
        }
        assert_eq!(
            asked, 3,
            "allow once covers the call it answered and nothing after it"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_one_time_approval_is_never_written_to_disk() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let request = tool(
            "read_file_metadata",
            json!({ "path": file.to_string_lossy() }),
        );
        let mut asked = 0usize;
        for _ in 0..2 {
            assert!(execute_tool_with(&policy, &request, &mut scope, |_| {
                asked += 1;
                ApprovalDecision::Once
            })
            .ok);
        }
        assert_eq!(asked, 2, "the second operation asks again");
        assert!(scope.grants.grants.is_empty(), "nothing was persisted");

        // A fresh scope (app restart) still asks.
        let mut fresh = ApprovedScope::default();
        let mut asked_after_restart = 0usize;
        execute_tool_with(&policy, &request, &mut fresh, |_| {
            asked_after_restart += 1;
            ApprovalDecision::Denied
        });
        assert_eq!(asked_after_restart, 1, "a restart has to ask again");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn an_exact_file_grant_survives_and_is_revocable() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let policy = policy(ToolMode::Ask, None);
        let request = tool("read_file", json!({ "path": file.to_string_lossy() }));

        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        for _ in 0..3 {
            let response = execute_tool_with(&policy, &request, &mut scope, |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "contents");
                assert!(prompt.can_persist, "one existing file is an exact resource");
                ApprovalDecision::AlwaysResource
            });
            assert!(response.ok);
        }
        assert_eq!(asked, 1, "the exact-file grant is reused");
        assert_eq!(scope.grants.grants.len(), 1);
        assert_eq!(scope.grants.grants[0].kind, CONTENT_SCOPE);
        assert_eq!(
            scope.grants.grants[0].path,
            path_text(&canonical_for_policy(&file))
        );

        // A restart keeps the persisted grant.
        let mut restarted = ApprovedScope {
            grants: scope.grants.clone(),
        };
        let mut asked_on_restart = 0usize;
        assert!(execute_tool_with(&policy, &request, &mut restarted, |_| {
            asked_on_restart += 1;
            ApprovalDecision::Denied
        })
        .ok);
        assert_eq!(asked_on_restart, 0, "the saved grant covers the restart");

        // Revoking brings the prompt back.
        let id = restarted.grants.grants[0].id.clone();
        restarted.grants.revoke(&policy.owner, &id).expect("revoke");
        assert!(restarted.grants.grants.is_empty());
        let mut asked_after = 0usize;
        execute_tool_with(&policy, &request, &mut restarted, |_| {
            asked_after += 1;
            ApprovalDecision::Denied
        });
        assert_eq!(asked_after, 1);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn an_exact_file_grant_cannot_reach_another_file_a_folder_or_the_parent() {
        let root = temp_root();
        let folder = root.join("Downloads");
        let sibling = root.join("DownloadsEvil");
        let approved = folder.join("a.txt");
        let other = folder.join("b.txt");
        write(&approved, b"a");
        write(&other, b"b");
        write(&sibling.join("secret.txt"), b"s");

        let mut grants = GrantStore::default();
        grants.grants.push(ResourceGrant {
            id: "g1".into(),
            owner: "user_123".into(),
            path: path_text(&canonical_for_policy(&approved)),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        });
        assert!(grants.covers("user_123", CONTENT_SCOPE, &approved));
        assert!(!grants.covers("user_123", CONTENT_SCOPE, &other));
        assert!(!grants.covers("user_123", CONTENT_SCOPE, &folder));
        assert!(!grants.covers("user_123", CONTENT_SCOPE, &root));
        assert!(!grants.covers("user_123", CONTENT_SCOPE, &sibling.join("secret.txt")));
        // A launch grant is not a read grant, even for the same path.
        assert!(!grants.covers("user_123", LAUNCH_SCOPE, &approved));
        // Case differences name the same file.
        assert!(grants.covers("user_123", CONTENT_SCOPE, &folder.join("A.TXT")));
        // Another account's identical path gets nothing.
        assert!(!grants.covers("user_999", CONTENT_SCOPE, &approved));
        // A traversal alias is a different component sequence and never matches.
        assert!(!grants.covers(
            "user_123",
            CONTENT_SCOPE,
            &folder.join("a.txt").join("..").join("b.txt")
        ));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn an_exact_file_grant_never_unlocks_its_folder_or_other_files() {
        let root = temp_root();
        let file = root.join("notes.txt");
        let other = root.join("other.txt");
        write(&file, b"hello");
        write(&other, b"secret");
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        // Approve the exact read once, saving it for notes.txt only.
        let first = execute_tool_with(
            &policy,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::AlwaysResource
            },
        );
        assert!(first.ok);
        assert_eq!(asked, 1);
        assert_eq!(scope.grants.grants.len(), 1);

        // The same file is covered.
        assert!(execute_tool_with(
            &policy,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        )
        .ok);
        assert_eq!(asked, 1);

        // Another file in the same folder still asks.
        let second = execute_tool_with(
            &policy,
            &tool("read_file", json!({ "path": other.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert_eq!(asked, 2, "a sibling file is not the approved resource");
        assert_eq!(second.error.as_ref().unwrap().code, "approval_denied");

        // Listing the folder still asks, and cannot be saved at all.
        let mut listing_asked = 0usize;
        execute_tool_with(
            &policy,
            &tool("list_directory", json!({ "path": root.to_string_lossy() })),
            &mut scope,
            |prompt| {
                listing_asked += 1;
                assert!(!prompt.can_persist, "a folder is not an exact resource");
                ApprovalDecision::Once
            },
        );
        assert_eq!(listing_asked, 1);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn folder_listings_metadata_writes_and_commands_cannot_be_saved() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let ask = policy(ToolMode::Ask, None);

        for (tool_name, args, expected_action) in [
            ("list_directory", json!({ "path": root.to_string_lossy() }), "list"),
            (
                "read_file_metadata",
                json!({ "path": file.to_string_lossy() }),
                "metadata",
            ),
            (
                "write_file",
                json!({ "path": root.join("new.txt").to_string_lossy(), "content": "x" }),
                "create",
            ),
            (
                "run_command",
                json!({ "command": "Write-Output hi", "shell": "powershell", "cwd": root.to_string_lossy() }),
                "command",
            ),
        ] {
            let resolved = resolve_request(&ask, &tool(tool_name, args)).expect("resolve");
            assert_eq!(resolved.approval.action, expected_action);
            assert!(
                !resolved.approval.can_persist,
                "{tool_name} must not offer Allow Always"
            );
        }

        let read = resolve_request(&ask, &tool("read_file", json!({ "path": file.to_string_lossy() })))
            .expect("resolve read");
        assert!(read.approval.can_persist, "one existing file can be saved");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn legacy_folder_grants_are_dropped_instead_of_widened() {
        let legacy = br#"{
            "version": 1,
            "grants": [
                {
                    "id": "old-folder",
                    "owner": "user_123",
                    "root": "C:\\Users\\Vishnu\\Downloads",
                    "scope": "read",
                    "createdAt": 1
                }
            ]
        }"#;
        let file: GrantFile = serde_json::from_slice(legacy).expect("legacy file still parses");
        assert!(
            !file.grants.iter().any(valid_resource_grant),
            "a folder grant from the previous build is never loaded as a file grant"
        );

        // A hand-edited entry naming a folder as a contents grant is rejected:
        // the path is absolute but the value is not an existing file.
        let folder_as_file = ResourceGrant {
            id: "forged".into(),
            owner: "user_123".into(),
            path: path_text(&std::env::temp_dir()),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        };
        assert!(
            !exact_resource_can_persist(Path::new(&folder_as_file.path)),
            "only a real file can back an exact-resource grant"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_reparse_point_cannot_back_a_saved_file_grant() {
        let root = temp_root();
        let target = root.join("real-folder");
        fs::create_dir_all(&target).expect("target folder");
        // Junctions need no elevation, unlike directory symlinks, so an
        // ordinary user can create this reparse point.
        let junction = root.join("alias");
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !created {
            eprintln!("[skip] this machine cannot create a junction");
            fs::remove_dir_all(root).ok();
            return;
        }

        assert!(
            !exact_resource_can_persist(&junction),
            "a reparse point is never eligible for a saved grant"
        );

        // Even a forged store naming the junction cannot unlock a path through
        // it: tool resolution rejects the link before any grant is consulted.
        let mut grants = GrantStore::default();
        grants.grants.push(ResourceGrant {
            id: "g-junction".into(),
            owner: "user_123".into(),
            path: path_text(&canonical_for_policy(&junction)),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        });
        let mut asked = 0usize;
        let response = execute_tool_with(
            &policy(ToolMode::Ask, None),
            &tool(
                "read_file",
                json!({ "path": junction.join("secret.txt").to_string_lossy() }),
            ),
            &mut ApprovedScope { grants },
            |_| {
                asked += 1;
                ApprovalDecision::Once
            },
        );
        assert!(!response.ok, "a junction is not a path to a granted file");
        assert_eq!(asked, 0, "the link is refused before a card is raised");
        assert_eq!(response.error.expect("failure").code, "symlink_rejected");

        let _ = fs::remove_dir(&junction);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn recent_files_sorts_newest_first_and_drops_system_noise() {
        let root = temp_root();
        write(&root.join("old.txt"), b"old");
        write(&root.join("new.txt"), b"new");
        write(&root.join("desktop.ini"), b"[.ShellClassInfo]");
        write(&root.join("Thumbs.db"), b"thumb");
        fs::create_dir_all(root.join("sub")).expect("create sub");

        let touched = SystemTime::now() - Duration::from_secs(3_600);
        let file = root.join("old.txt");
        let handle = fs::OpenOptions::new().write(true).open(&file).expect("open");
        handle.set_modified(touched).expect("set modified");
        drop(handle);

        let result = list_recent_files(&root, &json!({ "limit": 5 })).expect("recent");
        let files = result.get("files").and_then(Value::as_array).unwrap();
        assert_eq!(files.len(), 2, "only the two real files");
        assert_eq!(files[0]["name"], "new.txt", "newest first");
        assert_eq!(files[1]["name"], "old.txt");
        assert!(files[0]["modifiedAt"].as_i64().unwrap() > files[1]["modifiedAt"].as_i64().unwrap());
        assert!(files[0]["size"].as_u64().is_some());
        assert!(
            result["skippedSystemEntries"]
                .as_u64()
                .map(|count| count >= 1)
                .unwrap_or(false),
            "folder noise is counted, not silently dropped"
        );
        let names: Vec<&str> = files
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert!(!names.contains(&"desktop.ini"));
        assert!(!names.contains(&"Thumbs.db"));
        assert_eq!(result["sortedBy"], "lastModified");

        let with_system = list_recent_files(
            &root,
            &json!({ "limit": 5, "includeSystemEntries": true }),
        )
        .expect("recent with system");
        let names: Vec<&str> = with_system["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"desktop.ini"));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn recent_files_limit_is_bounded_and_metadata_needs_no_extra_call() {
        let root = temp_root();
        for index in 0..8 {
            write(&root.join(format!("f{}.txt", index)), b"x");
        }
        let result = list_recent_files(&root, &json!({ "limit": 3 })).expect("recent");
        assert_eq!(result["files"].as_array().unwrap().len(), 3);
        assert_eq!(result["returned"], 3);

        let listed = list_directory(&root).expect("list");
        let entries = listed["entries"].as_array().unwrap();
        assert!(
            entries
                .iter()
                .all(|entry| entry.get("modifiedAt").is_some()),
            "a listing must carry the timestamp so the model never asks per file"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn the_broker_answers_one_pending_request_exactly_once() {
        let broker = ApprovalBroker::default();
        let entry = Arc::new(PendingApproval {
                operation_id: String::new(),
            request_id: "req-1".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        broker
            .pending
            .lock()
            .unwrap()
            .insert("k".into(), entry.clone());

        // A joiner waits on the same entry the leader is waiting on.
        let joined = entry.clone();
        let waiter = std::thread::spawn(move || ApprovalBroker::await_decision(&joined, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(50));
        broker
            .respond("user_123", "req-1", ApprovalDecision::Once)
            .expect("respond");
        assert_eq!(waiter.join().unwrap(), ApprovalDecision::Once);

        // The entry is gone, so the same id can never authorize anything again.
        assert!(broker.respond("user_123", "req-1", ApprovalDecision::Once).is_err());
        assert!(broker.respond("user_123", "req-unknown", ApprovalDecision::Once).is_err());
    }

    #[test]
    fn another_account_cannot_answer_a_pending_request() {
        let broker = ApprovalBroker::default();
        let entry = Arc::new(PendingApproval {
                operation_id: String::new(),
            request_id: "req-2".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        broker
            .pending
            .lock()
            .unwrap()
            .insert("k2".into(), entry.clone());
        assert!(broker
            .respond("user_999", "req-2", ApprovalDecision::Once)
            .is_err());
        assert!(entry.decision.lock().unwrap().is_none());
        assert!(broker.pending.lock().unwrap().contains_key("k2"));
    }

    #[test]
    fn an_unanswered_request_expires_as_a_denial() {
        let entry = Arc::new(PendingApproval {
                operation_id: String::new(),
            request_id: "req-3".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        let joined = entry.clone();
        assert_eq!(
            ApprovalBroker::await_decision(&joined, Duration::from_millis(40)),
            ApprovalDecision::Denied
        );
    }

    #[test]
    fn cancelling_pending_approvals_denies_them() {
        let broker = ApprovalBroker::default();
        let entry = Arc::new(PendingApproval {
                operation_id: String::new(),
            request_id: "req-4".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        let joined = entry.clone();
        broker
            .pending
            .lock()
            .unwrap()
            .insert("k4".into(), entry);
        assert_eq!(broker.cancel_all(), vec!["req-4".to_string()]);
        assert_eq!(
            ApprovalBroker::await_decision(&joined, Duration::from_millis(40)),
            ApprovalDecision::Denied
        );
    }

    #[test]
    fn stopping_one_operation_denies_only_its_own_cards() {
        let broker = ApprovalBroker::default();
        let first = Arc::new(PendingApproval {
            operation_id: "turn-a".into(),
            request_id: "req-a".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        let second = Arc::new(PendingApproval {
            operation_id: "turn-b".into(),
            request_id: "req-b".into(),
            owner: "user_123".into(),
            decision: Mutex::new(None),
            ready: Condvar::new(),
        });
        {
            let mut pending = broker.pending.lock().unwrap();
            pending.insert("key-a".into(), first.clone());
            pending.insert("key-b".into(), second.clone());
        }
        assert_eq!(broker.cancel_operation("turn-a"), vec!["req-a".to_string()]);
        assert_eq!(
            first.decision.lock().unwrap().unwrap_or(ApprovalDecision::Once),
            ApprovalDecision::Denied,
            "the stopped operation is denied"
        );
        assert!(
            second.decision.lock().unwrap().is_none(),
            "another chat's card is still waiting for its own answer"
        );
        assert_eq!(broker.cancel_operation("turn-b"), vec!["req-b".to_string()]);
        assert!(broker.cancel_operation("turn-missing").is_empty());
    }

    #[test]
    fn cancel_flags_are_scoped_to_one_operation() {
        let registry = CancelRegistry::default();
        let first = registry.begin("turn-a");
        let second = registry.begin("turn-b");

        assert!(registry.cancel("turn-a"));
        assert!(first.load(Ordering::SeqCst));
        assert!(
            !second.load(Ordering::SeqCst),
            "stopping one chat leaves another chat's running work alone"
        );

        // A turn that already finished has no flag left, so a late Stop cannot
        // mark a future call for the same id as cancelled.
        registry.finish("turn-a");
        assert!(!registry.cancel("turn-a"));
        assert!(!second.load(Ordering::SeqCst));

        assert!(registry.cancel("turn-b"));
        assert!(second.load(Ordering::SeqCst));
    }

    #[test]
    fn a_stop_before_the_answer_prompts_nobody_and_reads_nothing() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request = tool("read_file", json!({ "path": file.to_string_lossy() }));
        let mut asked = 0usize;
        let mut scope = ApprovedScope::default();

        let response = execute_guarded(
            &policy(ToolMode::Ask, None),
            &request,
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Once
            },
            &|| true,
            &|| true,
            &ProcessRegistry::default(),
            "",
        );

        assert_eq!(asked, 0, "a stopped call never raises a card");
        assert_eq!(response.error.expect("failure").code, "cancelled");
        assert!(response.data.is_none(), "no file bytes were returned");
        assert!(scope.grants.grants.is_empty());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_stop_after_the_answer_but_before_execution_reads_nothing() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request = tool("read_file", json!({ "path": file.to_string_lossy() }));
        let mut scope = ApprovedScope::default();
        let stopped = std::cell::Cell::new(false);
        let mut asked = 0usize;

        // The user presses Stop in the same moment the card is answered.
        let response = execute_guarded(
            &policy(ToolMode::Ask, None),
            &request,
            &mut scope,
            |_| {
                asked += 1;
                stopped.set(true);
                ApprovalDecision::Once
            },
            &|| true,
            &|| stopped.get(),
            &ProcessRegistry::default(),
            "",
        );

        assert_eq!(asked, 1, "the card is answered exactly once");
        assert_eq!(response.error.expect("failure").code, "cancelled");
        assert!(response.data.is_none(), "the approved read still never happened");
        assert!(scope.grants.grants.is_empty());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_stop_during_a_search_returns_no_partial_results() {
        let root = temp_root();
        let folder = root.join("Many");
        for index in 0..20 {
            write(&folder.join(format!("match{index}.txt")), b"x");
        }
        let calls = std::cell::Cell::new(0usize);

        let result = search_files(&folder, &json!({ "query": "match" }), &|| {
            calls.set(calls.get() + 1);
            calls.get() > 2
        });

        let failure = result.expect_err("a stopped search never reports success");
        assert_eq!(failure.code, "cancelled");
        assert!(calls.get() > 2, "the scan noticed the stop instead of finishing");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_denied_request_prompts_again_rather_than_staying_silent() {
        let root = temp_root();
        let folder = root.join("Downloads");
        write(&folder.join("a.txt"), b"a");
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let request = tool(
            "list_directory",
            json!({ "path": folder.to_string_lossy() }),
        );
        for round in 0..2 {
            let mut asked = 0usize;
            let response = execute_tool_with(&policy, &request, &mut scope, |_| {
                asked += 1;
                ApprovalDecision::Denied
            });
            assert_eq!(asked, 1, "denial is not cached as a grant (round {})", round);
            assert_eq!(response.error.as_ref().unwrap().code, "approval_denied");
        }
        assert!(scope.grants.grants.is_empty());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn prompts_name_the_folder_scope_and_the_read_only_action() {
        let root = temp_root();
        let folder = root.join("Downloads");
        write(&folder.join("a.txt"), b"a");
        let policy = policy(ToolMode::Ask, None);
        let resolved = resolve_request(
            &policy,
            &tool("read_file_metadata", json!({ "path": folder.join("a.txt").to_string_lossy() })),
        )
        .expect("resolve");
        assert_eq!(resolved.approval.action, "metadata");
        assert!(resolved.approval.read_only);
        assert_eq!(resolved.approval.scope_path, path_text(&folder));
        assert!(resolved.approval.summary.contains(&path_text(&folder)));
        assert!(!resolved.approval.request_id.is_empty());
        assert!(resolved.approval.expires_at > now_millis() - 1_000);

        let recent = resolve_request(
            &policy,
            &tool("list_recent_files", json!({ "path": folder.to_string_lossy(), "limit": 5 })),
        )
        .expect("resolve recent");
        assert_eq!(recent.approval.action, "recent");
        assert!(recent.approval.summary.contains(&path_text(&folder)));
        assert!(
            recent
                .approval
                .details
                .iter()
                .any(|detail| detail.contains("Newest 5 files")),
            "the card still states how many files the call returns: {:?}",
            recent.approval.details
        );
        assert_eq!(recent.approval.scope_path, path_text(&folder));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn resolving_a_known_folder_path_asks_for_no_permission() {
        // The 45-second stall the user saw was a modal waiting on a click for a
        // request that only asked Windows where the Downloads folder is.
        let policy = policy(ToolMode::Ask, None);
        let resolved = resolve_request(
            &policy,
            &tool("get_windows_known_folder", json!({ "name": "downloads" })),
        )
        .expect("resolve known folder");
        assert!(!resolved.requires_approval, "a path lookup reads no file");
        assert_eq!(resolved.approval.action, "locate");
        assert_eq!(resolved.approval.access, READ_SCOPE);
    }

    #[test]
    fn the_recent_files_fast_path_prompts_once_for_the_folder() {
        let root = temp_root();
        let folder = root.join("Downloads");
        for name in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "desktop.ini"] {
            write(&folder.join(name), b"x");
        }
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        let recent = execute_tool_with(
            &policy,
            &tool("list_recent_files", json!({ "path": folder.to_string_lossy(), "limit": 5 })),
            &mut scope,
            |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "recent");
                assert_eq!(prompt.scope_path, path_text(&folder));
                ApprovalDecision::Once
            },
        );
        assert!(recent.ok, "one enumeration answers the task");
        assert_eq!(asked, 1, "seven entries, one prompt");
        let data = recent.data.expect("recent data");
        assert_eq!(data["returned"].as_u64(), Some(5));
        assert!(
            data["files"]
                .as_array()
                .expect("files")
                .iter()
                .all(|entry| !is_system_noise(entry["name"].as_str().unwrap_or_default())),
            "system noise never reaches the answer"
        );
        assert_eq!(
            data["skippedSystemEntries"].as_u64(),
            Some(1),
            "the skipped entry is reported, not silently dropped"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_denied_folder_approval_runs_no_filesystem_read() {
        let root = temp_root();
        let folder = root.join("Downloads");
        write(&folder.join("a.txt"), b"secret");
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let response = execute_tool_with(
            &policy,
            &tool("list_recent_files", json!({ "path": folder.to_string_lossy(), "limit": 5 })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().expect("error").code, "approval_denied");
        assert!(
            scope.grants.grants.is_empty(),
            "a denial grants nothing and writes nothing"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn verbatim_windows_paths_never_reach_the_user() {
        assert_eq!(
            path_text(&display_path(Path::new(r"\\?\C:\Users\Vishnu\Downloads"))),
            r"C:\Users\Vishnu\Downloads"
        );
        assert_eq!(
            path_text(&display_path(Path::new(r"\\?\UNC\fileserv\Downloads"))),
            r"\\fileserv\Downloads"
        );
        assert_eq!(
            path_text(&display_path(Path::new(r"D:\OneDrive\Downloads"))),
            r"D:\OneDrive\Downloads"
        );
    }

    #[test]
    fn a_genuine_access_denial_keeps_the_windows_detail() {
        let failure = io_failure(std::io::Error::from_raw_os_error(5));
        assert_eq!(failure.code, "access_denied");
        assert!(
            failure.message.contains("os error 5"),
            "the OS wording is the evidence: {}",
            failure.message
        );
        assert!(failure.message.contains("not a VupsRouter setting"));
        assert!(failure.message.contains("No elevation or permission change was attempted"));

        let detailed = with_path(failure, Path::new(r"D:\OneDrive\Downloads"));
        assert!(
            detailed.message.ends_with(r"Path: D:\OneDrive\Downloads"),
            "{}",
            detailed.message
        );
    }

    #[test]
    fn a_missing_folder_is_denied_nothing_and_prompts_nobody() {
        let root = temp_root();
        let missing = root.join("Nope");
        let mut asked = 0usize;
        let response = execute_tool_with(
            &policy(ToolMode::Ask, None),
            &tool("list_recent_files", json!({ "path": missing.to_string_lossy(), "limit": 5 })),
            &mut ApprovedScope::default(),
            |_| {
                asked += 1;
                ApprovalDecision::Once
            },
        );
        assert!(!response.ok);
        let failure = response.error.expect("failure");
        assert_eq!(failure.code, "path_not_found");
        assert!(
            failure.message.contains("os error 2"),
            "Windows detail preserved: {}",
            failure.message
        );
        assert_eq!(asked, 0, "a path that does not exist is not a permission event");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_file_asked_as_a_directory_names_the_path_it_rejected() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"x");
        let response = execute_tool_with(
            &policy(ToolMode::Ask, None),
            &tool(
                "list_recent_files",
                json!({ "path": file.to_string_lossy(), "limit": 5 }),
            ),
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        let failure = response.error.expect("failure");
        assert_eq!(failure.code, "not_a_directory");
        assert!(failure.message.contains(&path_text(&file)), "{}", failure.message);
        assert!(
            !failure.message.contains(r"\\?\"),
            "verbatim paths stay out of user-facing text: {}",
            failure.message
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_symlink_cannot_carry_a_read_outside_the_workspace() {
        let root = temp_root();
        let outside = temp_root();
        write(&outside.join("secret.txt"), b"secret");
        write(&root.join("inside.txt"), b"inside");
        let link = root.join("escape");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(&outside, &link).is_ok();
        #[cfg(not(windows))]
        let created = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if !created {
            eprintln!("[skip] this account cannot create directory links; nothing to escape through");
            fs::remove_dir_all(root).ok();
            fs::remove_dir_all(outside).ok();
            return;
        }

        let response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &tool("list_directory", json!({ "path": link.to_string_lossy() })),
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(!response.ok);
        assert_eq!(response.error.expect("failure").code, "symlink_rejected");

        // A workspace listing never follows the link either.
        let listing = list_directory(&root).expect("list workspace");
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect();
        assert!(!names.contains(&"escape"), "the link is not followed: {names:?}");

        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_cannot_carry_a_read_outside_the_workspace() {
        let root = temp_root();
        let outside = temp_root();
        write(&outside.join("secret.txt"), b"secret");
        // Junctions need no elevation, unlike directory symlinks, so the escape
        // path is reachable for an ordinary user and must be blocked on its own.
        let junction = root.join("escape");
        let created = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !created {
            eprintln!("[skip] this machine cannot create a junction; nothing to escape through");
            fs::remove_dir_all(root).ok();
            fs::remove_dir_all(outside).ok();
            return;
        }

        let response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &tool(
                "read_file",
                json!({ "path": junction.join("secret.txt").to_string_lossy() }),
            ),
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(!response.ok, "a junction is not a way outside the workspace");
        let code = response.error.expect("failure").code;
        assert!(
            code == "symlink_rejected" || code == "outside_workspace",
            "the escape is reported as a link or as outside the workspace, got {code}"
        );
        assert!(response.data.is_none(), "no file bytes were returned");

        let _ = fs::remove_dir(&junction);
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn no_stored_policy_means_no_tool_access() {
        let slot = Mutex::new(None);
        assert!(require_policy(&slot).is_err(), "closed until a mode is chosen");
        slot.lock()
            .unwrap()
            .replace(policy(ToolMode::Ask, None));
        assert_eq!(require_policy(&slot).unwrap().mode, ToolMode::Ask);
    }

    #[test]
    fn policy_changes_invalidate_pending_approvals() {
        let ask = policy(ToolMode::Ask, None);
        assert_eq!(
            policy_transition(None, &ask),
            PolicyTransition {
                cancel_pending: true,
                revoke_grants: false
            }
        );
        // Re-sending the mode the app already runs must not throw away a card
        // the user is looking at.
        let same = policy_transition(Some(&ask), &ask);
        assert!(!same.cancel_pending);
        assert!(!same.revoke_grants);

        let full = policy(ToolMode::Full, None);
        let stricter = policy_transition(Some(&full), &ask);
        assert!(stricter.cancel_pending);
        assert!(stricter.revoke_grants, "Full to Ask is a narrowing switch");

        let root = temp_root();
        let workspace = policy(ToolMode::Workspace, Some(&root));
        assert!(
            policy_transition(Some(&full), &workspace).revoke_grants,
            "Full to Workspace is a narrowing switch"
        );
        assert!(
            !policy_transition(Some(&ask), &full).revoke_grants,
            "widening the mode does not revoke what was already approved"
        );

        let narrowed = policy(ToolMode::Workspace, Some(&root));
        let widened = policy(ToolMode::Workspace, None);
        let moved = policy_transition(Some(&narrowed), &widened);
        assert!(
            moved.cancel_pending,
            "a workspace switch cancels cards raised under the old workspace"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn switching_modes_changes_what_is_asked_and_once_is_never_reused() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request = tool("read_file", json!({ "path": file.to_string_lossy() }));

        // Full access reads a normal folder without a card and leaves nothing behind.
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        assert!(execute_tool_with(&policy(ToolMode::Full, None), &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Once
        })
        .ok);
        assert_eq!(asked, 0);

        // Ask mode asks for the very next read.
        assert!(execute_tool_with(&policy(ToolMode::Ask, None), &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Once
        })
        .ok);
        assert_eq!(asked, 1, "the broader mode left no approval behind");

        // The one-time approval is not reused by the following operation.
        assert!(execute_tool_with(&policy(ToolMode::Ask, None), &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Once
        })
        .ok);
        assert_eq!(asked, 2, "allow once never authorizes a second operation");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_policy_change_while_a_card_is_open_abandons_the_read() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request = tool("read_file", json!({ "path": file.to_string_lossy() }));

        let mut scope = ApprovedScope::default();
        // `Cell` keeps both closures on a shared borrow, which is what lets the
        // approve stub flip the policy while it is being answered.
        let current = std::cell::Cell::new(true);
        let mut asked = 0usize;
        let response = execute_guarded(
            &policy(ToolMode::Ask, None),
            &request,
            &mut scope,
            |_| {
                asked += 1;
                // The user switches mode while the card is on screen.
                current.set(false);
                ApprovalDecision::Once
            },
            &|| current.get(),
            &|| false,
            &ProcessRegistry::default(),
            "",
        );

        assert_eq!(asked, 1);
        let failure = response.error.expect("failure");
        assert_eq!(failure.code, "policy_changed");
        assert!(response.data.is_none(), "no file bytes were returned");
        assert!(
            scope.grants.grants.is_empty(),
            "an answer for the old mode is never persisted"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_mode_ignores_saved_file_grants_made_outside_it() {
        let root = temp_root();
        let workspace = root.join("work");
        let outside = root.join("elsewhere");
        write(&workspace.join("inside.txt"), b"inside");
        write(&outside.join("outside.txt"), b"outside");

        // An exact-file grant saved earlier in a broader mode must not become
        // permission to cross the workspace boundary.
        let mut grants = GrantStore::default();
        grants.grants.push(ResourceGrant {
            id: "outside".into(),
            owner: "user_123".into(),
            path: path_text(&canonical_for_policy(&outside.join("outside.txt"))),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        });
        let mut narrowed = ApprovedScope { grants };
        let mut asked = 0usize;
        let outside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&workspace)),
            &tool(
                "read_file",
                json!({ "path": outside.join("outside.txt").to_string_lossy() }),
            ),
            &mut narrowed,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert_eq!(
            asked, 0,
            "outside the workspace is refused; a saved grant cannot widen it"
        );
        assert_eq!(
            outside_response.error.expect("failure").code,
            "outside_workspace"
        );
        assert!(outside_response.data.is_none());

        // Inside the workspace nothing is asked.
        let mut inside_asked = 0usize;
        assert!(execute_tool_with(
            &policy(ToolMode::Workspace, Some(&workspace)),
            &tool(
                "read_file",
                json!({ "path": workspace.join("inside.txt").to_string_lossy() }),
            ),
            &mut narrowed,
            |_| {
                inside_asked += 1;
                ApprovalDecision::Denied
            },
        )
        .ok);
        assert_eq!(inside_asked, 0);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_mode_without_a_root_is_stricter_than_ask() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");

        let mut scope = ApprovedScope::default();
        // A saved exact-file permission exists, but no workspace root does.
        scope.grants.grants.push(ResourceGrant {
            id: "g1".into(),
            owner: "user_123".into(),
            path: path_text(&canonical_for_policy(&file)),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        });

        let mut asked = 0usize;
        let response = execute_tool_with(
            &policy(ToolMode::Workspace, None),
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert_eq!(
            asked, 0,
            "a missing workspace never means the whole computer, and no card can grant it"
        );
        assert_eq!(response.error.expect("failure").code, "workspace_required");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(windows)]
    #[test]
    fn full_access_still_asks_for_a_protected_system_file() {
        let windows = PathBuf::from(r"C:\Windows");
        assert!(windows.is_dir(), "C:\\Windows exists on this machine");
        assert!(
            is_protected_system_path(Path::new(r"c:\windows\system32")),
            "protected folders are matched case-insensitively"
        );
        let protected_file = windows.join("win.ini");
        assert!(protected_file.is_file(), "C:\\Windows\\win.ini exists");
        let full = policy(ToolMode::Full, None);
        let request = tool(
            "read_file",
            json!({ "path": protected_file.to_string_lossy() }),
        );

        // A saved file grant inside a protected location must not silence the
        // fresh-approval rule, and the card must not offer to save it again.
        let resolved = resolve_request(&full, &request).expect("resolve protected read");
        assert!(!resolved.approval.can_persist);
        assert!(requires_fresh_approval(&full, &protected_file));

        let mut scope = ApprovedScope::default();
        scope.grants.grants.push(ResourceGrant {
            id: "protected".into(),
            owner: "user_123".into(),
            path: path_text(&canonical_for_policy(&protected_file)),
            kind: CONTENT_SCOPE.into(),
            created_at: 0,
        });
        let mut asked = 0usize;
        execute_tool_with(&full, &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::AlwaysResource
        });
        assert_eq!(asked, 1, "a protected location always asks");
        assert!(
            scope.grants.grants.len() == 1,
            "the pre-seeded grant is not duplicated and no new one is stored"
        );
    }

    #[test]
    fn a_request_cannot_carry_its_own_mode() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let request: ToolRequest = serde_json::from_value(json!({
            "tool": "read_file",
            "args": { "path": file.to_string_lossy() },
            "mode": "full",
            "owner": "someone_else",
        }))
        .expect("extra fields are ignored, not honoured");

        let mut asked = 0usize;
        let response = execute_tool_with(&policy(ToolMode::Ask, None), &request, &mut ApprovedScope::default(), |_| {
            asked += 1;
            ApprovalDecision::Denied
        });
        assert_eq!(asked, 1, "the stored policy decides, not the request payload");
        assert_eq!(response.error.expect("failure").code, "approval_denied");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn file_creation_append_edit_and_read_change_the_real_file() {
        let root = temp_root();
        let file = root.join("agent-test.txt");
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        let created = execute_tool_with(
            &full,
            &tool(
                "write_file",
                json!({ "path": file.to_string_lossy(), "content": "alpha\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(created.ok);
        assert_eq!(asked, 0, "Full access does not prompt for an ordinary write");
        assert_eq!(created.data.unwrap()["created"], true);
        assert_eq!(fs::read_to_string(&file).expect("read back"), "alpha\n");

        let appended = execute_tool_with(
            &full,
            &tool(
                "append_file",
                json!({ "path": file.to_string_lossy(), "content": "beta\n" }),
            ),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(appended.ok);
        assert_eq!(appended.data.unwrap()["appended"], true);
        assert_eq!(fs::read_to_string(&file).expect("read back"), "alpha\nbeta\n");

        let edited = execute_tool_with(
            &full,
            &tool(
                "edit_file",
                json!({
                    "path": file.to_string_lossy(),
                    "find": "beta",
                    "replace": "gamma"
                }),
            ),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(edited.ok);
        assert_eq!(edited.data.unwrap()["replacements"], 1);
        assert_eq!(fs::read_to_string(&file).expect("read back"), "alpha\ngamma\n");

        let read = execute_tool_with(
            &full,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(read.ok);
        assert_eq!(read.data.unwrap()["content"], "alpha\ngamma\n");

        let metadata = execute_tool_with(
            &full,
            &tool("read_file_metadata", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(metadata.ok);
        assert_eq!(metadata.data.unwrap()["size"], 12, "the real size after both edits");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_allows_writes_inside_but_delete_asks_and_outside_is_refused() {
        let root = temp_root();
        let inside = root.join("inside.txt");
        let outside_root = temp_root();
        let outside = outside_root.join("outside.txt");
        let workspace = policy(ToolMode::Workspace, Some(&root));
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        let written = execute_tool_with(
            &workspace,
            &tool(
                "write_file",
                json!({ "path": inside.to_string_lossy(), "content": "inside\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(written.ok);
        assert_eq!(asked, 0, "an ordinary workspace edit is not a prompt");
        assert_eq!(fs::read_to_string(&inside).expect("inside written"), "inside\n");

        let denied = execute_tool_with(
            &workspace,
            &tool("delete_path", json!({ "path": inside.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(!denied.ok);
        assert_eq!(denied.error.expect("failure").code, "approval_denied");
        assert_eq!(asked, 1, "a delete asks even inside the workspace");
        assert!(inside.exists(), "a denied delete removes nothing");

        let blocked = execute_tool_with(
            &workspace,
            &tool(
                "write_file",
                json!({ "path": outside.to_string_lossy(), "content": "nope\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::AlwaysResource
            },
        );
        assert!(!blocked.ok);
        assert_eq!(blocked.error.expect("failure").code, "outside_workspace");
        assert_eq!(asked, 1, "the boundary is not a card that can be approved away");
        assert!(!outside.exists(), "nothing outside the workspace was created");

        let allowed = execute_tool_with(
            &workspace,
            &tool("delete_path", json!({ "path": inside.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Once
            },
        );
        assert!(allowed.ok);
        assert_eq!(asked, 2);
        assert!(!inside.exists());

        fs::remove_dir_all(root).expect("remove test root");
        fs::remove_dir_all(outside_root).expect("remove outside root");
    }

    #[test]
    fn writes_are_never_converted_into_a_standing_permission() {
        let root = temp_root();
        let file = root.join("notes.txt");
        let ask = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        for content in ["one\n", "two\n"] {
            let response = execute_tool_with(
                &ask,
                &tool("write_file", json!({ "path": file.to_string_lossy(), "content": content })),
                &mut scope,
                |_| {
                    asked += 1;
                    ApprovalDecision::AlwaysResource
                },
            );
            assert!(response.ok);
        }
        assert_eq!(asked, 2, "every write asks, even after an always answer");
        assert!(
            scope.grants.grants.is_empty(),
            "a write answer never becomes a standing grant"
        );
        assert_eq!(fs::read_to_string(&file).expect("read back"), "two\n");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rename_copy_and_move_operate_on_the_real_paths() {
        let root = temp_root();
        let nested = root.join("nested");
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        let mut approve = |_: &ApprovalPrompt| {
            asked += 1;
            ApprovalDecision::Denied
        };

        let folder = execute_tool_with(
            &full,
            &tool("create_directory", json!({ "path": nested.to_string_lossy() })),
            &mut scope,
            &mut approve,
        );
        assert!(folder.ok);
        assert_eq!(folder.data.unwrap()["created"], true);

        let file = root.join("a.txt");
        let created = execute_tool_with(
            &full,
            &tool("write_file", json!({ "path": file.to_string_lossy(), "content": "payload" })),
            &mut scope,
            &mut approve,
        );
        assert!(created.ok);

        let renamed = execute_tool_with(
            &full,
            &tool(
                "rename_path",
                json!({ "path": file.to_string_lossy(), "newName": "b.txt" }),
            ),
            &mut scope,
            &mut approve,
        );
        assert!(renamed.ok);
        let renamed_to = root.join("b.txt");
        assert!(!file.exists());
        assert_eq!(fs::read_to_string(&renamed_to).expect("renamed file"), "payload");

        let copied_to = nested.join("copy.txt");
        let copied = execute_tool_with(
            &full,
            &tool(
                "copy_path",
                json!({
                    "source": renamed_to.to_string_lossy(),
                    "destination": copied_to.to_string_lossy()
                }),
            ),
            &mut scope,
            &mut approve,
        );
        assert!(copied.ok);
        assert_eq!(copied.data.unwrap()["copied"], true);
        assert_eq!(fs::read_to_string(&copied_to).expect("copied file"), "payload");

        let moved_to = nested.join("moved.txt");
        let moved = execute_tool_with(
            &full,
            &tool(
                "move_path",
                json!({
                    "source": copied_to.to_string_lossy(),
                    "destination": moved_to.to_string_lossy()
                }),
            ),
            &mut scope,
            &mut approve,
        );
        assert!(moved.ok);
        assert_eq!(moved.data.unwrap()["moved"], true);
        assert!(!copied_to.exists());
        assert_eq!(fs::read_to_string(&moved_to).expect("moved file"), "payload");

        let duplicate = execute_tool_with(
            &full,
            &tool(
                "copy_path",
                json!({
                    "source": moved_to.to_string_lossy(),
                    "destination": moved_to.to_string_lossy()
                }),
            ),
            &mut scope,
            &mut approve,
        );
        assert!(!duplicate.ok);
        assert!(
            matches!(duplicate.error.expect("failure").code.as_str(), "invalid_arguments" | "path_exists"),
            "copying onto itself is refused"
        );
        assert_eq!(asked, 0, "Full access does not prompt for ordinary file work");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn content_search_returns_text_matches_and_skips_binary_files() {
        let root = temp_root();
        let src = root.join("src");
        write(&src.join("notes.md"), b"first line\nneedle on line two\n");
        write(&src.join("blob.bin"), b"\0needle in binary");
        write(&src.join("fake.pdf"), b"needle in a binary format");
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();

        let result = execute_tool_with(
            &full,
            &tool(
                "search_file_contents",
                json!({ "root": root.to_string_lossy(), "query": "needle" }),
            ),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(result.ok);
        let data = result.data.expect("matches");
        let matches = data["matches"].as_array().expect("match array");
        assert_eq!(matches.len(), 1, "binary extensions and NUL files are not searched");
        assert!(matches[0]["path"].as_str().unwrap().ends_with("notes.md"));
        assert_eq!(matches[0]["line"], 2);
        assert!(matches[0]["text"].as_str().unwrap().contains("needle"));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn binary_formats_are_metadata_and_open_only() {
        let root = temp_root();
        let pdf = root.join("report.pdf");
        write(&pdf, b"%PDF-1.7\nneedle-like text that is not really a text document");
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();

        let read = execute_tool_with(
            &full,
            &tool("read_file", json!({ "path": pdf.to_string_lossy() })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(!read.ok);
        assert_eq!(read.error.expect("failure").code, "unsupported_format");

        let write = execute_tool_with(
            &full,
            &tool("write_file", json!({ "path": pdf.to_string_lossy(), "content": "replaced" })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(!write.ok);
        assert_eq!(write.error.expect("failure").code, "unsupported_format");
        assert_eq!(
            fs::read(&pdf).expect("unchanged file"),
            b"%PDF-1.7\nneedle-like text that is not really a text document",
            "a refused binary write changes nothing"
        );

        let metadata = execute_tool_with(
            &full,
            &tool("read_file_metadata", json!({ "path": pdf.to_string_lossy() })),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(metadata.ok, "metadata is still allowed for binary formats");
        assert_eq!(metadata.data.unwrap()["kind"], "file");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(windows)]
    #[test]
    fn a_real_powershell_command_returns_its_version_and_exit_code() {
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();
        let result = execute_tool_with(
            &full,
            &tool(
                "run_command",
                json!({ "command": "$PSVersionTable.PSVersion.ToString()", "shell": "powershell" }),
            ),
            &mut scope,
            |_| ApprovalDecision::Denied,
        );
        assert!(result.ok, "{:?}", result.error);
        let data = result.data.expect("command result");
        assert_eq!(data["status"], "exited");
        assert_eq!(data["exitCode"], 0);
        let stdout = data["stdout"].as_str().unwrap_or("").trim();
        assert!(
            stdout.split('.').count() >= 2,
            "PowerShell printed its real version, got {stdout:?}"
        );
        assert_eq!(data["stderr"], "", "a clean command has no stderr");
    }

    #[cfg(windows)]
    #[test]
    fn stopping_an_operation_kills_only_its_background_command() {
        let full = policy(ToolMode::Full, None);
        let processes = ProcessRegistry::default();
        let request = ToolRequest {
            operation_id: Some("turn-stop".into()),
            tool: "start_command".into(),
            args: json!({ "command": "Start-Sleep -Seconds 30", "shell": "powershell" }),
        };
        let started = execute_guarded(
            &full,
            &request,
            &mut ApprovedScope::default(),
            |_| panic!("Full access must not prompt for an ordinary command"),
            &|| true,
            &|| false,
            &processes,
            "turn-stop",
        );
        assert!(started.ok, "{:?}", started.error);
        let data = started.data.expect("start result");
        let pid = data["pid"].as_u64().expect("pid") as u32;
        let process_id = data["processId"].as_str().expect("processId").to_string();
        assert_eq!(data["running"], true);

        assert_eq!(processes.kill_operation("another-turn"), Vec::<u32>::new());
        let killed = processes.kill_operation("turn-stop");
        assert!(killed.contains(&pid), "Stop kills the command this turn started");

        let snapshot = command_output(&processes, &process_id, 20).expect("output");
        assert_eq!(snapshot["running"], false);
        assert_eq!(snapshot["kind"], "command");
    }

    #[cfg(windows)]
    #[test]
    fn protected_roots_cannot_be_deleted_even_in_full_access() {
        let full = policy(ToolMode::Full, None);
        let error = resolve_request(
            &full,
            &tool("delete_path", json!({ "path": r"C:\Windows" })),
        )
        .expect_err("a Windows root is not a deletable target");
        assert_eq!(error.code, "protected_root");
        assert!(
            error.message.contains("Nothing was changed"),
            "the refusal says the folder was untouched"
        );
    }

    /// Acceptance C, executed against the real disk in an authorized workspace:
    /// create, append, read, edit, rename, inspect and delete the same
    /// `agent-test.txt`. Ordinary workspace edits do not prompt; the permanent
    /// delete is the one card, answered once.
    #[cfg(windows)]
    #[test]
    fn acceptance_workspace_agent_test_txt_lifecycle_on_disk() {
        let root = temp_root();
        let workspace = policy(ToolMode::Workspace, Some(&root));
        let file = root.join("agent-test.txt");
        let renamed = root.join("agent-test-renamed.txt");
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        let written = execute_tool_with(
            &workspace,
            &tool(
                "write_file",
                json!({
                    "path": file.to_string_lossy(),
                    "content": "created by the VupsRouter acceptance test\n"
                }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(written.ok, "{:?}", written.error);
        assert_eq!(asked, 0, "an ordinary workspace write is not a prompt");
        assert_eq!(
            fs::read_to_string(&file).expect("the file exists on disk"),
            "created by the VupsRouter acceptance test\n"
        );

        let appended = execute_tool_with(
            &workspace,
            &tool(
                "append_file",
                json!({ "path": file.to_string_lossy(), "content": "second line\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(appended.ok, "{:?}", appended.error);

        let read = execute_tool_with(
            &workspace,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(read.ok, "{:?}", read.error);
        assert_eq!(
            read.data.expect("read result")["content"],
            "created by the VupsRouter acceptance test\nsecond line\n"
        );

        let edited = execute_tool_with(
            &workspace,
            &tool(
                "edit_file",
                json!({
                    "path": file.to_string_lossy(),
                    "find": "acceptance test",
                    "replace": "real acceptance edit"
                }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(edited.ok, "{:?}", edited.error);

        let after_edit = execute_tool_with(
            &workspace,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(after_edit.ok, "{:?}", after_edit.error);
        assert_eq!(
            after_edit.data.expect("read result")["content"],
            "created by the VupsRouter real acceptance edit\nsecond line\n"
        );

        let renamed_result = execute_tool_with(
            &workspace,
            &tool(
                "rename_path",
                json!({ "path": file.to_string_lossy(), "newName": "agent-test-renamed.txt" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(renamed_result.ok, "{:?}", renamed_result.error);
        assert!(!file.exists(), "the original name is gone");
        assert!(renamed.is_file(), "the renamed file is on disk");

        let metadata = execute_tool_with(
            &workspace,
            &tool("read_file_metadata", json!({ "path": renamed.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(metadata.ok, "{:?}", metadata.error);
        assert_eq!(metadata.data.expect("metadata")["kind"], "file");

        let deleted = execute_tool_with(
            &workspace,
            &tool("delete_path", json!({ "path": renamed.to_string_lossy() })),
            &mut scope,
            |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "delete");
                assert_eq!(prompt.scope_path, path_text(&renamed));
                ApprovalDecision::Once
            },
        );
        assert!(deleted.ok, "{:?}", deleted.error);
        assert_eq!(asked, 1, "the permanent delete is the only approval");
        assert!(!renamed.exists(), "the file is really deleted");
        assert!(
            deleted.data.expect("delete result")["recoverable"] == false,
            "permanent delete is reported honestly"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    /// Acceptance F: inside the picked folder succeeds, a path outside it is
    /// refused as a boundary (not offered as an approval card).
    #[cfg(windows)]
    #[test]
    fn acceptance_workspace_inside_succeeds_and_outside_is_refused() {
        let root = temp_root();
        let outside_root = temp_root();
        let inside = root.join("allowed.txt");
        let outside = outside_root.join("denied.txt");
        let workspace = policy(ToolMode::Workspace, Some(&root));
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        let allowed = execute_tool_with(
            &workspace,
            &tool(
                "write_file",
                json!({ "path": inside.to_string_lossy(), "content": "inside\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert!(allowed.ok, "{:?}", allowed.error);
        assert_eq!(fs::read_to_string(&inside).expect("inside file"), "inside\n");

        let denied = execute_tool_with(
            &workspace,
            &tool(
                "write_file",
                json!({ "path": outside.to_string_lossy(), "content": "outside\n" }),
            ),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::AlwaysResource
            },
        );
        assert!(!denied.ok);
        assert_eq!(denied.error.expect("refusal").code, "outside_workspace");
        assert_eq!(asked, 0, "the workspace boundary is not an approval card");
        assert!(!outside.exists(), "nothing outside the workspace was created");

        fs::remove_dir_all(root).expect("remove test root");
        fs::remove_dir_all(outside_root).expect("remove outside root");
    }

    /// Acceptance G: Full Access repeats ordinary work with no card at all.
    #[cfg(windows)]
    #[test]
    fn acceptance_full_access_repeats_file_work_without_prompts() {
        let root = temp_root();
        let full = policy(ToolMode::Full, None);
        let file = root.join("full-access.txt");
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        for copy in 0..3 {
            let written = execute_tool_with(
                &full,
                &tool(
                    "write_file",
                    json!({
                        "path": file.to_string_lossy(),
                        "content": format!("run {copy}\n")
                    }),
                ),
                &mut scope,
                |_| {
                    asked += 1;
                    ApprovalDecision::Denied
                },
            );
            assert!(written.ok, "{:?}", written.error);

            let read = execute_tool_with(
                &full,
                &tool("read_file", json!({ "path": file.to_string_lossy() })),
                &mut scope,
                |_| {
                    asked += 1;
                    ApprovalDecision::Denied
                },
            );
            assert!(read.ok, "{:?}", read.error);
            assert_eq!(read.data.expect("read")["content"], format!("run {copy}\n"));
        }
        assert_eq!(asked, 0, "Full Access does not re-prompt for ordinary work");
        assert!(scope.grants.grants.is_empty());

        fs::remove_dir_all(root).expect("remove test root");
    }

    /// Acceptance I: a protected Windows location fails with the OS's own
    /// permission error. It is never bypassed, and no elevation is attempted.
    #[cfg(windows)]
    #[test]
    fn acceptance_system_volume_information_shows_the_real_windows_denial() {
        let protected = Path::new(r"C:\System Volume Information");
        assert!(protected.exists(), "this acceptance machine has the folder");
        let full = policy(ToolMode::Full, None);
        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;

        let result = execute_tool_with(
            &full,
            &tool(
                "list_directory",
                json!({ "path": protected.to_string_lossy() }),
            ),
            &mut scope,
            |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "list");
                ApprovalDecision::Once
            },
        );
        assert!(!result.ok, "Windows itself refuses this folder");
        let error = result.error.expect("failure");
        assert_eq!(error.code, "access_denied");
        assert!(
            error.message.contains("Windows itself refused"),
            "the error names Windows, not VupsRouter: {}",
            error.message
        );
        assert!(
            error.message.contains("not a VupsRouter setting"),
            "{}",
            error.message
        );
        assert!(
            error.message.contains("No elevation or permission change was attempted"),
            "{}",
            error.message
        );
        assert!(
            error.message.to_ascii_lowercase().contains("access is denied")
                || error.message.contains("os error 5"),
            "the real Windows detail is preserved: {}",
            error.message
        );
        assert!(asked <= 1, "at most one card, and it grants a read attempt only");
        assert!(
            protected.exists(),
            "the folder is untouched and still present"
        );
    }

    #[cfg(windows)]
    fn acceptance_process_running(pid: u32) -> bool {
        let output = std::process::Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        match output {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
            }
            _ => false,
        }
    }

    /// Discovery is used rather than a hardcoded path: the same tool the model
    /// calls resolves the installed app on this PC.
    #[cfg(windows)]
    fn acceptance_discovered_app(query: &str) -> Option<String> {
        let full = policy(ToolMode::Full, None);
        let found = execute_tool_with(
            &full,
            &tool("find_app", json!({ "name": query })),
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Denied,
        );
        let data = found.data?;
        let path = data.get("best")?.get("path")?.as_str()?.to_string();
        Path::new(&path).is_file().then_some(path)
    }

    /// A test that launches a real app must not orphan it when an assertion
    /// fails. The guard force-closes only the exact process tree the registry
    /// recorded for this launch.
    #[cfg(windows)]
    struct AcceptanceLaunchGuard<'a> {
        registry: &'a ProcessRegistry,
        process_id: String,
        armed: bool,
    }

    #[cfg(windows)]
    impl<'a> AcceptanceLaunchGuard<'a> {
        fn new(registry: &'a ProcessRegistry, process_id: String) -> Self {
            Self {
                registry,
                process_id,
                armed: true,
            }
        }
    }

    #[cfg(windows)]
    impl Drop for AcceptanceLaunchGuard<'_> {
        fn drop(&mut self) {
            if self.armed {
                let _ = close_app(self.registry, &self.process_id, true);
            }
        }
    }

    /// Acceptance A: find the installed Blender through dynamic discovery,
    /// approve its launch even in Ask mode, verify the real process, and close
    /// it gracefully. The test does not touch any other process.
    #[cfg(windows)]
    #[test]
    #[ignore = "launches the real Blender installation on this PC; run with --ignored"]
    fn acceptance_blender_launch_is_approved_verified_and_closed() {
        let Some(exe) = acceptance_discovered_app("Blender") else {
            eprintln!("[acceptance-a] SKIPPED: Blender is not installed on this PC");
            return;
        };
        eprintln!("[acceptance-a] discovered Blender at {exe}");
        let ask = policy(ToolMode::Ask, None);
        let processes = ProcessRegistry::default();
        let mut scope = ApprovedScope::default();
        let mut prompts: Vec<ApprovalPrompt> = Vec::new();

        let launched = execute_guarded(
            &ask,
            &tool(
                "launch_app",
                json!({ "path": exe, "args": ["--factory-startup"] }),
            ),
            &mut scope,
            |prompt| {
                prompts.push(prompt.clone());
                ApprovalDecision::Once
            },
            &|| true,
            &|| false,
            &processes,
            "acceptance-a",
        );
        assert!(launched.ok, "Blender launch failed: {:?}", launched.error);
        assert_eq!(prompts.len(), 1, "launch asked for approval");
        assert_eq!(prompts[0].action, "launch");
        assert_eq!(prompts[0].scope_path, exe);
        let data = launched.data.expect("launch result");
        assert_eq!(data["verified"], true);
        assert_eq!(data["running"], true);
        assert!(
            data["note"]
                .as_str()
                .unwrap_or_default()
                .contains("does not drive the app's interface"),
            "the result distinguishes launching from GUI control"
        );
        let pid = data["pid"].as_u64().expect("pid") as u32;
        let process_id = data["processId"].as_str().expect("processId").to_string();
        let mut guard = AcceptanceLaunchGuard::new(&processes, process_id.clone());
        assert!(
            acceptance_process_running(pid),
            "Blender PID {pid} is really running"
        );

        let mut managed = false;
        let mut last_list = Value::Null;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let listed = execute_guarded(
                &ask,
                &tool("list_processes", json!({ "name": "blender", "limit": 20 })),
                &mut scope,
                |_| panic!("listing processes needs no approval"),
                &|| true,
                &|| false,
                &processes,
                "acceptance-a",
            );
            assert!(listed.ok, "{:?}", listed.error);
            let processes_data = listed.data.expect("process list");
            managed = processes_data["processes"]
                .as_array()
                .map(|entries| {
                    entries.iter().any(|entry| {
                        entry["pid"].as_u64() == Some(u64::from(pid))
                            && entry["managed"] == true
                            && entry["canClose"] == true
                    })
                })
                .unwrap_or(false);
            if managed {
                break;
            }
            last_list = processes_data;
            std::thread::sleep(Duration::from_millis(400));
        }
        assert!(
            managed,
            "the launched Blender PID is listed as managed and closable: {last_list}"
        );

        std::thread::sleep(Duration::from_secs(3));

        let closed = execute_guarded(
            &ask,
            &tool("close_app", json!({ "processId": process_id })),
            &mut scope,
            |prompt| {
                assert_eq!(prompt.action, "close");
                prompts.push(prompt.clone());
                ApprovalDecision::Once
            },
            &|| true,
            &|| false,
            &processes,
            "acceptance-a",
        );
        assert_eq!(prompts.len(), 2, "close asked exactly once");
        let close_ok = closed.ok && closed.data.as_ref().map(|data| data["closed"] == true).unwrap_or(false);
        if !close_ok {
            // Clean up only the exact process this test launched.
            let _ = close_app(&processes, &process_id, true);
            panic!(
                "Blender did not close gracefully: ok={} result={:?}",
                closed.ok, closed.data
            );
        }
        let closed_data = closed.data.expect("close result");
        assert_eq!(closed_data["pid"], pid);
        assert_eq!(closed_data["forced"], false);
        assert_eq!(closed_data["closed"], true);

        let deadline = Instant::now() + Duration::from_secs(10);
        while acceptance_process_running(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            !acceptance_process_running(pid),
            "Blender PID {pid} exited after the graceful close"
        );
        guard.armed = false;
    }

    /// Acceptance B: launch installed Chrome in an isolated profile, verify the
    /// real process, then close only the process tree this test launched.
    #[cfg(windows)]
    #[test]
    #[ignore = "launches the real Chrome installation on this PC; run with --ignored"]
    fn acceptance_chrome_launch_is_verified_and_closed_in_full_access() {
        let Some(exe) = acceptance_discovered_app("Google Chrome") else {
            eprintln!("[acceptance-b] SKIPPED: Chrome is not installed on this PC");
            return;
        };
        eprintln!("[acceptance-b] discovered Chrome at {exe}");
        let profile = temp_root().join("chrome-profile");
        fs::create_dir_all(&profile).expect("create isolated Chrome profile");
        let full = policy(ToolMode::Full, None);
        let processes = ProcessRegistry::default();
        let mut scope = ApprovedScope::default();

        let launched = execute_guarded(
            &full,
            &tool(
                "launch_app",
                json!({
                    "path": exe,
                    "args": [
                        format!("--user-data-dir={}", profile.display()),
                        "--no-first-run",
                        "--no-default-browser-check",
                        "--disable-background-networking",
                        "--disable-sync",
                        "about:blank"
                    ]
                }),
            ),
            &mut scope,
            |_| panic!("Full Access must not prompt for an ordinary app launch"),
            &|| true,
            &|| false,
            &processes,
            "acceptance-b",
        );
        assert!(launched.ok, "Chrome launch failed: {:?}", launched.error);
        let data = launched.data.expect("launch result");
        let pid = data["pid"].as_u64().expect("pid") as u32;
        let process_id = data["processId"].as_str().expect("processId").to_string();
        let mut guard = AcceptanceLaunchGuard::new(&processes, process_id.clone());
        assert_eq!(data["verified"], true);
        assert_eq!(data["running"], true);
        assert!(
            acceptance_process_running(pid),
            "Chrome PID {pid} is really running"
        );

        std::thread::sleep(Duration::from_secs(2));

        let closed = execute_guarded(
            &full,
            &tool("close_app", json!({ "processId": process_id })),
            &mut scope,
            |_| panic!("Full Access must not prompt for closing the app it launched"),
            &|| true,
            &|| false,
            &processes,
            "acceptance-b",
        );
        let close_ok = closed.ok && closed.data.as_ref().map(|data| data["closed"] == true).unwrap_or(false);
        if !close_ok {
            let _ = close_app(&processes, &process_id, true);
            let _ = fs::remove_dir_all(&profile);
            panic!(
                "Chrome did not close gracefully: ok={} result={:?}",
                closed.ok, closed.data
            );
        }
        let closed_data = closed.data.expect("close result");
        assert_eq!(closed_data["pid"], pid);
        assert_eq!(closed_data["closed"], true);
        guard.armed = false;

        for _ in 0..20 {
            if fs::remove_dir_all(&profile).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            !profile.exists(),
            "the isolated Chrome profile is cleaned up"
        );
    }

    /// Acceptance E: the agent command tool really runs both full suites and
    /// returns their exit code and output. Each suite runs in its own project
    /// folder through `run_command`, not through a test shortcut.
    #[cfg(windows)]
    #[test]
    #[ignore = "runs both full npm test suites through the agent; slow"]
    fn acceptance_agent_runs_the_client_and_server_suites() {
        let client = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("client folder")
            .to_path_buf();
        let server = client.parent().expect("repo root").join("server");
        let full = policy(ToolMode::Full, None);

        for (label, cwd) in [("client", client), ("server", server)] {
            assert!(cwd.join("package.json").is_file(), "{label} has a package.json");
            let result = execute_tool_with(
                &full,
                &tool(
                    "run_command",
                    json!({
                        "command": "npm test",
                        "cwd": cwd.to_string_lossy(),
                        "shell": "powershell",
                        "timeoutSeconds": 900
                    }),
                ),
                &mut ApprovedScope::default(),
                |_| panic!("Full Access must not prompt for the suite command"),
            );
            assert!(result.ok, "{label} suite could not run: {:?}", result.error);
            let data = result.data.expect("suite output");
            assert_eq!(data["status"], "exited", "{label}");
            assert_eq!(
                data["exitCode"], 0,
                "{label} suite exited non-zero.\nstdout:\n{}\nstderr:\n{}",
                data["stdout"], data["stderr"]
            );
            let stdout = data["stdout"].as_str().unwrap_or_default();
            assert!(
                stdout.contains("ℹ pass") || stdout.contains("# pass"),
                "{label} did not print node test totals:\n{stdout}"
            );
            assert!(
                stdout.contains("ℹ fail 0") || stdout.contains("# fail 0"),
                "{label} did not report zero failures:\n{stdout}"
            );
            eprintln!("[acceptance-e] {label} suite output tail:\n{}", stdout);
        }
    }
}
