use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::workspace;

const MAX_LIST_ENTRIES: usize = 500;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_DEPTH: usize = 8;
const MAX_SEARCH_ENTRIES: usize = 5_000;
const MAX_SEARCH_MS: u64 = 5_000;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_PATH_CHARS: usize = 4_096;
const MAX_QUERY_CHARS: usize = 120;
const MAX_AUDIT_BYTES: u64 = 1_000_000;

const DESKTOP_TOOL_NAMES: [&str; 6] = [
    "get_windows_known_folder",
    "list_directory",
    "list_recent_files",
    "read_file",
    "search_files",
    "read_file_metadata",
];

/// How long an unanswered in-chat approval stays live before it is dropped.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// A one-time approval covers its folder for the rest of the task, not forever.
const SESSION_GRANT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_GRANTS: usize = 200;
const MAX_RECENT_FILES: usize = 50;

/// Read-only operations share one approval per folder: listing a directory and
/// reading the metadata of its children are the same question ("may the assistant
/// see what is in here?"), so asking twice is noise, not safety.
const READ_SCOPE: &str = "read";
const CONTENT_SCOPE: &str = "contents";

#[derive(Default)]
pub struct DesktopToolState {
    policy: Mutex<Option<ToolPolicy>>,
    /// Bumped on every real policy change. A tool call captures this before it
    /// runs and rechecks it before touching the disk, so a mode or workspace
    /// switch that lands while a card is on screen cannot authorize the old read.
    generation: Arc<AtomicU64>,
    broker: Arc<ApprovalBroker>,
    scopes: Arc<Mutex<ApprovedScope>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum ApprovalDecision {
    Denied,
    Once,
    AlwaysFolder,
}

impl ApprovalDecision {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "deny" | "denied" | "cancel" => Ok(Self::Denied),
            "once" | "allow_once" => Ok(Self::Once),
            "always" | "always_folder" | "allow_always" => Ok(Self::AlwaysFolder),
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
    tool: String,
    action: String,
    /// The folder the decision actually covers.
    scope_path: String,
    scope_name: String,
    summary: String,
    /// `read` or `contents`, so the card can name the access being granted.
    access: String,
    read_only: bool,
    expires_at: i64,
}

#[derive(Default)]
struct PendingApproval {
    request_id: String,
    owner: String,
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
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FolderGrant {
    id: String,
    owner: String,
    root: String,
    scope: String,
    created_at: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantFile {
    version: u32,
    grants: Vec<FolderGrant>,
}

#[derive(Clone, Default)]
struct GrantStore {
    loaded: bool,
    directory: Option<PathBuf>,
    grants: Vec<FolderGrant>,
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
                .filter(|grant| {
                    (grant.scope == READ_SCOPE || grant.scope == CONTENT_SCOPE)
                        && !grant.owner.trim().is_empty()
                        && !grant.root.trim().is_empty()
                })
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
            version: 1,
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

    fn insert(&mut self, grant: FolderGrant) -> Result<(), String> {
        self.grants.retain(|existing| existing.id != grant.id);
        self.grants
            .retain(|existing| !(existing.owner == grant.owner && existing.root == grant.root));
        self.grants.push(grant);
        if self.grants.len() > MAX_GRANTS {
            let overflow = self.grants.len() - MAX_GRANTS;
            self.grants.drain(0..overflow);
        }
        self.persist()
    }

    fn revoke(&mut self, owner: &str, id: &str) -> Option<FolderGrant> {
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

    /// Covers `target` only when a stored root is a real ancestor of it *after*
    /// canonicalization, so a sibling like `DownloadsOld` can never inherit the
    /// grant given to `Downloads`.
    fn covers(&self, owner: &str, scope: &str, target: &Path) -> bool {
        self.grants.iter().any(|grant| {
            grant.owner == owner
                && grant.scope == scope
                && path_within(Path::new(&grant.root), target)
        })
    }

    fn for_owner(&self, owner: &str) -> Vec<FolderGrant> {
        self.grants
            .iter()
            .filter(|grant| grant.owner == owner)
            .cloned()
            .collect()
    }
}

#[derive(Clone)]
struct SessionEntry {
    seen: Instant,
    root: String,
    scope: String,
}

/// Approvals given for the current task only. Nothing here reaches the disk, and
/// revoking a saved grant drops the matching entries so a revocation takes
/// effect immediately rather than when the task happens to end.
#[derive(Clone, Default)]
struct SessionScope {
    owner: String,
    approved: HashMap<String, SessionEntry>,
}

impl SessionScope {
    fn remember(&mut self, owner: &str, prompt: &ApprovalPrompt) {
        if self.owner != owner {
            self.owner = owner.to_string();
            self.approved.clear();
        }
        self.prune();
        self.approved.insert(
            prompt.approval_key.clone(),
            SessionEntry {
                seen: Instant::now(),
                root: prompt.scope_path.clone(),
                scope: access_scope_for(&prompt.action).to_string(),
            },
        );
    }

    fn covers(&mut self, owner: &str, key: &str) -> bool {
        if self.owner != owner {
            return false;
        }
        self.prune();
        self.approved.contains_key(key)
    }

    fn forget_within(&mut self, owner: &str, root: &str, scope: &str) {
        if self.owner != owner {
            return;
        }
        let boundary = Path::new(root);
        self.approved.retain(|_, entry| {
            !(entry.scope == scope && path_within(boundary, Path::new(&entry.root)))
        });
    }

    fn reset(&mut self) {
        self.owner.clear();
        self.approved.clear();
    }

    fn prune(&mut self) {
        self.approved.retain(|_, entry| entry.seen.elapsed() < SESSION_GRANT_TTL);
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
/// and workspace that asked the question. Saved "always allow" folders survive a
/// switch between equally broad modes, but a narrowing switch (Full → workspace
/// → Ask) revokes them: the stricter mode would have asked for those folders,
/// so keeping the broader mode's consent would quietly widen it.
#[derive(Debug, PartialEq, Eq)]
struct PolicyTransition {
    cancel_pending: bool,
    reset_session: bool,
    revoke_grants: bool,
}

fn policy_transition(current: Option<&ToolPolicy>, next: &ToolPolicy) -> PolicyTransition {
    let changed = current.map(|existing| existing != next).unwrap_or(true);
    let narrowed = current
        .map(|existing| next.mode.breadth() < existing.mode.breadth())
        .unwrap_or(false);
    PolicyTransition {
        cancel_pending: changed,
        reset_session: changed,
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
struct ResolvedRequest {
    tool: String,
    args: Value,
    target: PathBuf,
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

impl AccessScope {
    fn label(self) -> &'static str {
        match self {
            Self::Read => READ_SCOPE,
            Self::Contents => CONTENT_SCOPE,
        }
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
    workspace::skipped_file(name)
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

fn resolve_existing_path(raw: &str, want_dir: bool) -> Result<PathBuf, ToolFailure> {
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
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(ToolFailure {
            code: "invalid_path".into(),
            message: "Filesystem tools require an absolute path.".into(),
        });
    }
    reject_symlink_components(path)?;
    let canonical =
        fs::canonicalize(path).map_err(|error| with_path(io_failure(error), path))?;
    let readable = display_path(&canonical);
    let metadata =
        fs::metadata(&canonical).map_err(|error| with_path(io_failure(error), path))?;
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

/// Builds the approval question. It is always phrased around the folder the
/// decision covers, never around the single child file that happened to be
/// requested first, because approving a listing authorizes that folder's
/// metadata anyway.
fn build_prompt(
    policy: &ToolPolicy,
    tool: &str,
    action: &str,
    target: &Path,
    scope_root: &Path,
    access: AccessScope,
    detail: Option<&str>,
) -> ApprovalPrompt {
    let scope_text = path_text(scope_root);
    let summary = match action {
        "locate" => format!(
            "Find the Windows {} folder location",
            folder_display_name(scope_root).to_ascii_lowercase()
        ),
        "list" => format!("List the files and folders in {}", scope_text),
        "recent" => format!(
            "List the most recent files in {}{}",
            scope_text,
            detail.map(|value| format!(" ({})", value)).unwrap_or_default()
        ),
        "search" => format!(
            "Search file names in {}{}",
            scope_text,
            detail.map(|value| format!(" for \"{}\"", value)).unwrap_or_default()
        ),
        "metadata" => format!("Read file dates and sizes in {}", scope_text),
        "contents" => format!("Read the contents of {}", path_text(target)),
        _ => format!("Read {}", scope_text),
    };
    let scope_key = match access {
        AccessScope::Read => format!("{}|read|{}", policy.owner, scope_text.to_ascii_lowercase()),
        AccessScope::Contents => format!(
            "{}|contents|{}",
            policy.owner,
            path_text(target).to_ascii_lowercase()
        ),
    };
    ApprovalPrompt {
        request_id: uuid::Uuid::new_v4().to_string(),
        approval_key: scope_key,
        tool: tool.to_string(),
        action: action.to_string(),
        scope_path: match access {
            AccessScope::Read => scope_text,
            AccessScope::Contents => path_text(target),
        },
        scope_name: match access {
            AccessScope::Read => folder_display_name(scope_root),
            AccessScope::Contents => folder_display_name(target),
        },
        summary,
        access: access.label().to_string(),
        read_only: true,
        expires_at: now_millis() + APPROVAL_TIMEOUT.as_millis() as i64,
    }
}

fn resolve_request(policy: &ToolPolicy, request: &ToolRequest) -> Result<ResolvedRequest, ToolFailure> {
    if !DESKTOP_TOOL_NAMES.contains(&request.tool.as_str()) {
        return Err(ToolFailure {
            code: "unknown_tool".into(),
            message: format!("The filesystem tool \"{}\" is not available.", truncate_text(&request.tool, 80)),
        });
    }
    let args = request.args.clone();
    let (target, action, scope_root, access, detail) = match request.tool.as_str() {
        "get_windows_known_folder" => {
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The known-folder tool needs a folder name.".into(),
                })?;
            let (normalized, path) = known_folder_path(name, system_known_folder)?;
            let _ = normalized;
            (path.clone(), "locate", path, AccessScope::Read, None)
        }
        "list_directory" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The directory tool needs an absolute path.".into(),
                })?;
            let target = resolve_existing_path(path, true)?;
            (target, "list", PathBuf::new(), AccessScope::Read, None)
        }
        "list_recent_files" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The recent-files tool needs an absolute directory path.".into(),
                })?;
            let target = resolve_existing_path(path, true)?;
            let limit = recent_limit(&args);
            (
                target,
                "recent",
                PathBuf::new(),
                AccessScope::Read,
                Some(format!("newest {} files", limit)),
            )
        }
        "read_file" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The read tool needs an absolute file path.".into(),
                })?;
            let target = resolve_existing_path(path, false)?;
            if target
                .file_name()
                .map(|name| is_sensitive_file(&name.to_string_lossy()))
                .unwrap_or(false)
            {
                return Err(ToolFailure {
                    code: "sensitive_file".into(),
                    message: "That file is excluded to protect credentials and secrets.".into(),
                });
            }
            (target, "contents", PathBuf::new(), AccessScope::Contents, None)
        }
        "read_file_metadata" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The metadata tool needs an absolute path.".into(),
                })?;
            let target = resolve_existing_path(path, false)?;
            if target
                .file_name()
                .map(|name| is_sensitive_file(&name.to_string_lossy()))
                .unwrap_or(false)
            {
                return Err(ToolFailure {
                    code: "sensitive_file".into(),
                    message: "That file is excluded to protect credentials and secrets.".into(),
                });
            }
            let scope_root = target
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| target.clone());
            (target, "metadata", scope_root, AccessScope::Read, None)
        }
        "search_files" => {
            let root = args
                .get("root")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The search tool needs an absolute root folder.".into(),
                })?;
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The search tool needs a filename query.".into(),
                })?;
            if query.chars().count() > MAX_QUERY_CHARS {
                return Err(ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "Keep the filename search query under 120 characters.".into(),
                });
            }
            let target = resolve_existing_path(root, true)?;
            (target, "search", PathBuf::new(), AccessScope::Read, Some(query.to_string()))
        }
        _ => unreachable!(),
    };
    let scope_root = if scope_root.as_os_str().is_empty() {
        target.clone()
    } else {
        scope_root
    };
    let approval = build_prompt(
        policy,
        &request.tool,
        action,
        &target,
        &scope_root,
        access,
        detail.as_deref(),
    );
    // Resolving a known folder returns a path Windows already exposes and reads
    // no directory entry, so it is not an access request and must not cost the
    // user a prompt before the operation they actually asked for.
    let requires_approval = action != "locate" && path_requires_approval(policy, &target);
    Ok(ResolvedRequest {
        tool: request.tool.clone(),
        args,
        requires_approval,
        target,
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
}

fn search_directory(state: &mut SearchState<'_>, directory: &Path, depth: usize) {
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
            search_directory(state, &canonical, depth + 1);
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

fn search_files(root: &Path, args: &Value) -> Result<Value, ToolFailure> {
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
    };
    search_directory(&mut state, root, 0);
    Ok(json!({
        "root": path_text(root),
        "query": query,
        "entries": state.entries,
        "truncated": state.truncated,
        "timedOut": state.timed_out,
        "scanned": state.scanned
    }))
}

fn run_resolved(request: &ResolvedRequest) -> Result<Value, ToolFailure> {
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
        "search_files" => search_files(&request.target, &request.args),
        _ => Err(ToolFailure {
            code: "unknown_tool".into(),
            message: "That filesystem tool is not available.".into(),
        }),
    }
}

/// The approvals already given for this account: an expiring in-memory set for
/// "allow once" and the on-disk folder grants for "always allow".
#[derive(Clone, Default)]
struct ApprovedScope {
    session: SessionScope,
    grants: GrantStore,
}

impl ApprovedScope {
    fn covers(&mut self, policy: &ToolPolicy, prompt: &ApprovalPrompt) -> bool {
        if self.session.covers(&policy.owner, &prompt.approval_key) {
            return true;
        }
        let target = Path::new(&prompt.scope_path);
        // Workspace mode means "this folder and nothing else". A folder grant
        // given in a broader mode must not become an implicit second workspace.
        if policy.mode == ToolMode::Workspace
            && !policy
                .workspace_root
                .as_deref()
                .map(|root| path_within(root, target))
                .unwrap_or(false)
        {
            return false;
        }
        self.grants
            .covers(&policy.owner, access_scope_for(&prompt.action), target)
    }

    /// A one-time approval is never written to disk, and an always-folder
    /// approval is stored at the scope the user was actually shown.
    fn remember(
        &mut self,
        policy: &ToolPolicy,
        prompt: &ApprovalPrompt,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        match decision {
            ApprovalDecision::Denied => Ok(()),
            ApprovalDecision::Once => {
                self.session.remember(&policy.owner, prompt);
                Ok(())
            }
            ApprovalDecision::AlwaysFolder => {
                self.session.remember(&policy.owner, prompt);
                self.grants.insert(FolderGrant {
                    id: uuid::Uuid::new_v4().to_string(),
                    owner: policy.owner.clone(),
                    root: prompt.scope_path.clone(),
                    scope: access_scope_for(&prompt.action).to_string(),
                    created_at: now_millis(),
                })
            }
        }
    }
}

fn access_scope_for(action: &str) -> &'static str {
    if action == "contents" {
        CONTENT_SCOPE
    } else {
        READ_SCOPE
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
    execute_guarded(policy, request, scope, approve, &|| true)
}

fn policy_changed_failure(prompt: &ApprovalPrompt) -> ToolResponse {
    ToolResponse::failure(
        "policy_changed",
        format!(
            "The file access mode changed while this request was waiting, so {} was not read. \
             Ask again under the current mode.",
            prompt.scope_path
        ),
    )
}

/// `still_current` answers "is the policy that produced this decision still the
/// one in force?". It is checked before the card, after the answer, and again
/// immediately before the disk is touched, so a mode or workspace switch cannot
/// ride in on a decision the user made for a different mode.
fn execute_guarded(
    policy: &ToolPolicy,
    request: &ToolRequest,
    scope: &mut ApprovedScope,
    mut approve: impl FnMut(&ApprovalPrompt) -> ApprovalDecision,
    still_current: &dyn Fn() -> bool,
) -> ToolResponse {
    let resolved = match resolve_request(policy, request) {
        Ok(resolved) => resolved,
        Err(error) => return ToolResponse::failure(&error.code, error.message),
    };
    if !still_current() {
        return policy_changed_failure(&resolved.approval);
    }
    if resolved.requires_approval {
        let prompt = &resolved.approval;
        let fresh = requires_fresh_approval(policy, &resolved.target);
        if fresh || !scope.covers(policy, prompt) {
            let granted = approve(prompt);
            if !still_current() {
                return policy_changed_failure(prompt);
            }
            if granted == ApprovalDecision::Denied {
                return ToolResponse::failure(
                    "approval_denied",
                    format!(
                        "The user did not allow this access to {}. No files were read.",
                        prompt.scope_path
                    ),
                );
            }
            // A standing grant over a protected system folder would turn "ask
            // every time" into "ask once", so that answer covers this call only.
            let remembered = if fresh && granted == ApprovalDecision::AlwaysFolder {
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
    match run_resolved(&resolved) {
        Ok(data) => ToolResponse::success(data),
        Err(error) => ToolResponse::failure(&error.code, error.message),
    }
}

fn audit_target(request: &ToolRequest) -> String {
    for key in ["path", "root", "name"] {
        if let Some(value) = request.args.get(key).and_then(Value::as_str) {
            return truncate_text(value.trim(), 300);
        }
    }
    String::new()
}

fn append_audit(app: &AppHandle, policy: &ToolPolicy, request: &ToolRequest, response: &ToolResponse) {
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
    scope: String,
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
                    // so every path keeps asking. The page is told why.
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
        if transition.reset_session || transition.revoke_grants {
            if let Ok(mut scopes) = state.scopes.lock() {
                if transition.reset_session {
                    scopes.session.reset();
                }
                if transition.revoke_grants {
                    // A narrower mode must not inherit "always allow" folders
                    // handed out by the broader one.
                    scopes.grants.ensure_loaded(&app);
                    let _ = scopes.grants.clear(&grant_owner);
                }
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
    let broker = state.broker.clone();
    let scopes = state.scopes.clone();
    let generation = state.generation.clone();
    let started_at = generation.load(Ordering::SeqCst);
    let owner = policy.owner.clone();
    let scope_app = app.clone();
    let policy_for_execute = policy.clone();
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
        Ok(execute_guarded(
            &policy_for_execute,
            &request,
            &mut scope,
            |prompt| broker.request(&app_for_prompt, &owner, prompt),
            &still_current,
        ))
    })
    .await
    .map_err(|_| "The Windows filesystem tool did not finish.".to_string())??;
    append_audit(&app, &policy, &audit_request, &response);
    Ok(response)
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
            path: grant.root.clone(),
            name: folder_display_name(Path::new(&grant.root)),
            scope: grant.scope,
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
    let Some(grant) = scope.grants.revoke(&policy.owner, id.trim()) else {
        return Ok(false);
    };
    // A revocation that the current task could override by re-asking would not
    // be a revocation, so the matching in-memory approvals go too.
    scope.session.forget_within(&policy.owner, &grant.root, &grant.scope);
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
    scope.session.reset();
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
            tool: "read_file".into(),
            args: json!({ "path": "../outside.txt" }),
        };
        assert!(resolve_request(&policy(ToolMode::Full, None), &request).is_err());
        let request = ToolRequest {
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
                tool: "read_file".into(),
                args: json!({ "path": inside.to_string_lossy() }),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Denied,
        );
        assert!(inside_response.ok);

        let outside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &ToolRequest {
                tool: "read_file".into(),
                args: json!({ "path": outside.to_string_lossy() }),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Denied,
        );
        assert!(!outside_response.ok);
        assert_eq!(
            outside_response.error.as_ref().unwrap().code,
            "approval_denied"
        );

        fs::remove_dir_all(root).expect("remove test root");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn invalid_tools_and_arguments_return_structured_errors() {
        let response = execute_tool_with(
            &policy(ToolMode::Full, None),
            &ToolRequest {
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
                tool: "read_file".into(),
                args: json!({}),
            },
            &mut ApprovedScope::default(),
            |_| ApprovalDecision::Once,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "invalid_arguments");
    }

    fn tool(tool: &str, args: Value) -> ToolRequest {
        ToolRequest {
            tool: tool.into(),
            args,
        }
    }

    #[test]
    fn one_folder_approval_covers_every_child_metadata_read_in_that_task() {
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
        assert_eq!(asked, 1, "three metadata reads, one prompt");

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
        execute_tool_with(&policy, &request, &mut scope, |_| ApprovalDecision::Once);
        assert!(scope.grants.grants.is_empty());
        assert_eq!(scope.session.approved.len(), 1);

        // A fresh scope (new task after the session grant expires, or an app
        // restart) has to ask again.
        let mut fresh = ApprovedScope::default();
        let mut asked = 0usize;
        execute_tool_with(&policy, &request, &mut fresh, |_| {
            asked += 1;
            ApprovalDecision::Denied
        });
        assert_eq!(asked, 1, "a restart has to ask again");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn an_always_folder_grant_survives_and_is_revocable() {
        let root = temp_root();
        let folder = root.join("Downloads");
        write(&folder.join("a.txt"), b"a");
        let policy = policy(ToolMode::Ask, None);
        let request = tool(
            "list_directory",
            json!({ "path": folder.to_string_lossy() }),
        );

        let mut scope = ApprovedScope::default();
        let mut asked = 0usize;
        for _ in 0..3 {
            let response = execute_tool_with(&policy, &request, &mut scope, |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "list");
                ApprovalDecision::AlwaysFolder
            });
            assert!(response.ok);
        }
        assert_eq!(asked, 1, "the always grant is reused");
        assert_eq!(scope.grants.grants.len(), 1);
        assert_eq!(scope.grants.grants[0].scope, READ_SCOPE);

        // A restart keeps the persisted grant: the session set is gone but the
        // folder is still authorized.
        let mut restarted = ApprovedScope {
            session: SessionScope::default(),
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
        restarted.session.forget_within(&policy.owner, &path_text(&folder), READ_SCOPE);
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
    fn a_folder_grant_cannot_reach_a_sibling_or_the_parent() {
        let root = temp_root();
        let downloads = root.join("Downloads");
        let sibling = root.join("DownloadsEvil");
        write(&downloads.join("a.txt"), b"a");
        write(&sibling.join("secret.txt"), b"s");

        let mut grants = GrantStore::default();
        grants.grants.push(FolderGrant {
            id: "g1".into(),
            owner: "user_123".into(),
            root: path_text(&downloads),
            scope: READ_SCOPE.into(),
            created_at: 0,
        });
        assert!(grants.covers("user_123", READ_SCOPE, &downloads.join("a.txt")));
        assert!(!grants.covers("user_123", READ_SCOPE, &sibling.join("secret.txt")));
        assert!(!grants.covers("user_123", READ_SCOPE, &root));
        // Case differences must not defeat containment either.
        assert!(grants.covers("user_123", READ_SCOPE, &downloads.join("A.TXT")));
        // Another account's identical path gets nothing.
        assert!(!grants.covers("user_999", READ_SCOPE, &downloads.join("a.txt")));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn a_read_grant_never_unlocks_file_contents() {
        let root = temp_root();
        let file = root.join("notes.txt");
        write(&file, b"hello");
        let policy = policy(ToolMode::Ask, None);
        let mut scope = ApprovedScope::default();
        let listing = tool("list_directory", json!({ "path": root.to_string_lossy() }));
        execute_tool_with(&policy, &listing, &mut scope, |_| {
            ApprovalDecision::AlwaysFolder
        });

        let mut asked = 0usize;
        let response = execute_tool_with(
            &policy,
            &tool("read_file", json!({ "path": file.to_string_lossy() })),
            &mut scope,
            |prompt| {
                asked += 1;
                assert_eq!(prompt.action, "contents");
                assert_eq!(prompt.scope_path, path_text(&file));
                ApprovalDecision::Denied
            },
        );
        assert_eq!(asked, 1, "listing a folder is not reading its files");
        assert_eq!(response.error.as_ref().unwrap().code, "approval_denied");

        fs::remove_dir_all(root).expect("remove test root");
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
    fn a_session_grant_stops_at_its_account_and_its_folder() {
        let root = temp_root();
        let folder = root.join("Downloads");
        fs::create_dir_all(&folder).expect("create folder");
        let policy = policy(ToolMode::Ask, None);
        let resolved = resolve_request(
            &policy,
            &tool("list_directory", json!({ "path": path_text(&folder) })),
        )
        .expect("resolve");
        let key = resolved.approval.approval_key.clone();

        let mut session = SessionScope::default();
        session.remember(&policy.owner, &resolved.approval);
        assert!(session.covers(&policy.owner, &key));
        assert!(!session.covers("user_999", &key), "another account gains nothing");

        session.forget_within(&policy.owner, &path_text(&folder), READ_SCOPE);
        assert!(!session.covers(&policy.owner, &key), "revoking reaches the session");

        session.remember(&policy.owner, &resolved.approval);
        session.forget_within(&policy.owner, &path_text(&root.join("Other")), READ_SCOPE);
        assert!(
            session.covers(&policy.owner, &key),
            "revoking an unrelated folder must not clear this one"
        );

        session.reset();
        assert!(!session.covers(&policy.owner, &key));

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
        assert!(scope.session.approved.is_empty());
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
        assert!(recent.approval.summary.contains("newest 5 files"));
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
        assert!(scope.grants.grants.is_empty());
        assert!(scope.session.approved.is_empty(), "a denial grants nothing");

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
    fn policy_changes_invalidate_pending_and_session_approvals() {
        let ask = policy(ToolMode::Ask, None);
        assert_eq!(
            policy_transition(None, &ask),
            PolicyTransition {
                cancel_pending: true,
                reset_session: true,
                // The first policy of a session has nothing narrower to compare
                // against, so standing grants made under the saved mode survive
                // a restart.
                revoke_grants: false
            }
        );
        // Re-sending the mode the app already runs must not throw away a card
        // the user is looking at.
        let same = policy_transition(Some(&ask), &ask);
        assert!(!same.cancel_pending);
        assert!(!same.reset_session);
        assert!(!same.revoke_grants);

        let full = policy(ToolMode::Full, None);
        let stricter = policy_transition(Some(&full), &ask);
        assert!(stricter.cancel_pending && stricter.reset_session);
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
            moved.reset_session,
            "a workspace switch is a permission change even in the same mode"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn switching_modes_drops_the_approval_given_under_the_old_one() {
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
        assert_eq!(asked, 1, "the broader mode left no session approval behind");

        // The one-time approval covers the rest of the task...
        assert!(execute_tool_with(&policy(ToolMode::Ask, None), &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Once
        })
        .ok);
        assert_eq!(asked, 1, "an answered card is not asked twice");

        // ...until the policy changes, which is exactly what set_policy resets.
        scope.session.reset();
        assert!(execute_tool_with(&policy(ToolMode::Ask, None), &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Once
        })
        .ok);
        assert_eq!(asked, 2, "a mode change brings the card back");

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
        );

        assert_eq!(asked, 1);
        let failure = response.error.expect("failure");
        assert_eq!(failure.code, "policy_changed");
        assert!(response.data.is_none(), "no file bytes were returned");
        assert!(
            scope.session.approved.is_empty(),
            "an answer for the old mode is never remembered"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn workspace_mode_ignores_grants_made_for_folders_outside_it() {
        let root = temp_root();
        let workspace = root.join("work");
        let outside = root.join("elsewhere");
        write(&workspace.join("inside.txt"), b"inside");
        write(&outside.join("outside.txt"), b"outside");

        // A saved "always allow" grant for the outside folder, made earlier in
        // a broader mode and kept across the restart that follows a switch.
        let mut grants = GrantStore::default();
        grants.grants.push(FolderGrant {
            id: "outside".into(),
            owner: "user_123".into(),
            root: path_text(&outside),
            scope: READ_SCOPE.into(),
            created_at: 0,
        });
        let mut narrowed = ApprovedScope {
            session: SessionScope::default(),
            grants,
        };
        let mut asked = 0usize;
        let outside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&workspace)),
            &tool("list_directory", json!({ "path": outside.to_string_lossy() })),
            &mut narrowed,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert_eq!(asked, 1, "outside the workspace always asks");
        assert_eq!(
            outside_response.error.expect("failure").code,
            "approval_denied"
        );

        // Inside the workspace nothing is asked.
        let mut inside_asked = 0usize;
        assert!(execute_tool_with(
            &policy(ToolMode::Workspace, Some(&workspace)),
            &tool("list_directory", json!({ "path": workspace.to_string_lossy() })),
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
        // A saved grant for this very folder exists, but no workspace root does.
        scope.grants.grants.push(FolderGrant {
            id: "g1".into(),
            owner: "user_123".into(),
            root: path_text(&root),
            scope: READ_SCOPE.into(),
            created_at: 0,
        });

        let mut asked = 0usize;
        let response = execute_tool_with(
            &policy(ToolMode::Workspace, None),
            &tool("list_directory", json!({ "path": root.to_string_lossy() })),
            &mut scope,
            |_| {
                asked += 1;
                ApprovalDecision::Denied
            },
        );
        assert_eq!(asked, 1, "a missing workspace never means the whole computer");
        assert_eq!(response.error.expect("failure").code, "approval_denied");

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(windows)]
    #[test]
    fn full_access_still_asks_for_a_protected_system_folder() {
        let windows = PathBuf::from(r"C:\Windows");
        assert!(windows.is_dir(), "C:\\Windows exists on this machine");
        assert!(
            is_protected_system_path(Path::new(r"c:\windows\system32")),
            "protected folders are matched case-insensitively"
        );
        let full = policy(ToolMode::Full, None);
        let request = tool("list_directory", json!({ "path": windows.to_string_lossy() }));

        // A standing grant over a protected folder must not silence the card.
        let mut scope = ApprovedScope::default();
        scope.grants.grants.push(FolderGrant {
            id: "protected".into(),
            owner: "user_123".into(),
            root: path_text(&windows),
            scope: READ_SCOPE.into(),
            created_at: 0,
        });
        let mut asked = 0usize;
        let response = execute_tool_with(&full, &request, &mut scope, |_| {
            asked += 1;
            ApprovalDecision::Denied
        });
        assert_eq!(asked, 1);
        assert_eq!(response.error.expect("failure").code, "approval_denied");

        // Even "always allow" only covers the one call for a protected folder.
        let mut once_scope = ApprovedScope::default();
        let mut asked_again = 0usize;
        let allowed = execute_tool_with(&full, &request, &mut once_scope, |_| {
            asked_again += 1;
            ApprovalDecision::AlwaysFolder
        });
        assert_eq!(asked_again, 1);
        assert!(allowed.ok);
        assert!(
            once_scope.grants.grants.is_empty(),
            "no standing grant is stored for a protected system folder"
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
}
