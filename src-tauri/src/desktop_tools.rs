use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

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

const DESKTOP_TOOL_NAMES: [&str; 5] = [
    "get_windows_known_folder",
    "list_directory",
    "read_file",
    "search_files",
    "read_file_metadata",
];

#[derive(Default)]
pub struct DesktopToolState {
    policy: Mutex<Option<ToolPolicy>>,
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
}

#[derive(Clone, Debug)]
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
            workspace_root: self
                .workspace_root
                .as_ref()
                .map(|path| path.to_string_lossy().to_string()),
        }
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
    summary: String,
    requires_approval: bool,
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
    path.to_string_lossy().to_string()
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
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    system_paths()
        .iter()
        .any(|system| canonical.starts_with(system))
}

fn path_requires_approval(policy: &ToolPolicy, path: &Path) -> bool {
    match policy.mode {
        ToolMode::Ask => true,
        ToolMode::Workspace => policy
            .workspace_root
            .as_ref()
            .map(|root| !canonical_for_policy(path).starts_with(root))
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
    let canonical = fs::canonicalize(path).map_err(io_failure)?;
    let metadata = fs::metadata(&canonical).map_err(io_failure)?;
    if want_dir && !metadata.is_dir() {
        return Err(ToolFailure {
            code: "not_a_directory".into(),
            message: "That path is not a directory.".into(),
        });
    }
    if !want_dir && !metadata.is_file() {
        return Err(ToolFailure {
            code: "not_a_file".into(),
            message: "That path is not a file.".into(),
        });
    }
    Ok(canonical)
}

fn io_failure(error: std::io::Error) -> ToolFailure {
    match error.kind() {
        ErrorKind::NotFound => ToolFailure {
            code: "path_not_found".into(),
            message: "That path does not exist or is unavailable.".into(),
        },
        ErrorKind::PermissionDenied => ToolFailure {
            code: "access_denied".into(),
            message: "Windows denied access to that path. VupsRouter does not bypass Windows permissions."
                .into(),
        },
        _ => ToolFailure {
            code: "filesystem_error".into(),
            message: "Windows could not complete that filesystem request.".into(),
        },
    }
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

fn resolve_request(policy: &ToolPolicy, request: &ToolRequest) -> Result<ResolvedRequest, ToolFailure> {
    if !DESKTOP_TOOL_NAMES.contains(&request.tool.as_str()) {
        return Err(ToolFailure {
            code: "unknown_tool".into(),
            message: format!("The filesystem tool \"{}\" is not available.", truncate_text(&request.tool, 80)),
        });
    }
    let args = request.args.clone();
    let (target, summary) = match request.tool.as_str() {
        "get_windows_known_folder" => {
            let name = args
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolFailure {
                    code: "invalid_arguments".into(),
                    message: "The known-folder tool needs a folder name.".into(),
                })?;
            let (normalized, path) = known_folder_path(name, system_known_folder)?;
            let summary = format!("Read the Windows {} folder location", normalized);
            (path, summary)
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
            let summary = format!("List files in {}", path_text(&target));
            (target, summary)
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
            let summary = format!("Read {}", path_text(&target));
            (target, summary)
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
            let summary = format!("Read metadata for {}", path_text(&target));
            (target, summary)
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
            let summary = format!("Search for \"{}\" under {}", query, path_text(&target));
            (target, summary)
        }
        _ => unreachable!(),
    };
    Ok(ResolvedRequest {
        tool: request.tool.clone(),
        args,
        requires_approval: path_requires_approval(policy, &target),
        target,
        summary,
    })
}

fn list_directory(path: &Path) -> Result<Value, ToolFailure> {
    let read_dir = fs::read_dir(path).map_err(io_failure)?;
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
            continue;
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
            "path": path_text(&child_path)
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

fn read_file(path: &Path) -> Result<Value, ToolFailure> {
    let metadata = fs::metadata(path).map_err(io_failure)?;
    if metadata.len() > MAX_READ_BYTES {
        return Err(ToolFailure {
            code: "file_too_large".into(),
            message: "That file is larger than the 256 KB read limit.".into(),
        });
    }
    let bytes = fs::read(path).map_err(io_failure)?;
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
    let metadata = fs::metadata(path).map_err(io_failure)?;
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
            if !canonical.starts_with(state.root) {
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
                "path": path_text(&child_path),
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
        "read_file" => read_file(&request.target),
        "read_file_metadata" => read_metadata(&request.target),
        "search_files" => search_files(&request.target, &request.args),
        _ => Err(ToolFailure {
            code: "unknown_tool".into(),
            message: "That filesystem tool is not available.".into(),
        }),
    }
}

fn confirm_native(summary: &str) -> bool {
    let description = format!(
        "{}\n\nVupsRouter will read only the requested location. This does not grant writes, shell commands, administrator rights, or access that Windows denies.",
        summary
    );
    matches!(
        rfd::MessageDialog::new()
            .set_title("Allow filesystem access?")
            .set_description(description)
            .set_buttons(rfd::MessageButtons::YesNo)
            .set_level(rfd::MessageLevel::Warning)
            .show(),
        rfd::MessageDialogResult::Yes
    )
}

fn execute_tool_with(
    policy: &ToolPolicy,
    request: &ToolRequest,
    approve: impl Fn(&str) -> bool,
) -> ToolResponse {
    let resolved = match resolve_request(policy, request) {
        Ok(resolved) => resolved,
        Err(error) => return ToolResponse::failure(&error.code, error.message),
    };
    if resolved.requires_approval && !approve(&resolved.summary) {
        return ToolResponse::failure(
            "approval_denied",
            "The user denied this filesystem request. No files were read.",
        );
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

#[tauri::command]
pub async fn desktop_tool_set_policy(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
    input: SetPolicyInput,
) -> Result<PolicyStatus, String> {
    let mode = ToolMode::parse(&input.mode)?;
    let owner = workspace::normalize_owner(&input.owner)?;
    let workspace_root = if mode == ToolMode::Workspace {
        let id = input.workspace_id.unwrap_or_default();
        if id.trim().is_empty() {
            None
        } else {
            Some(workspace::workspace_path(&app, &owner, &id)?)
        }
    } else {
        None
    };
    let policy = ToolPolicy {
        owner,
        mode,
        workspace_root,
    };
    let status = policy.status();
    let mut guard = state
        .policy
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    *guard = Some(policy);
    Ok(status)
}

#[tauri::command]
pub async fn desktop_tool_policy_status(
    state: State<'_, DesktopToolState>,
) -> Result<PolicyStatus, String> {
    let guard = state
        .policy
        .lock()
        .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
    guard
        .as_ref()
        .map(ToolPolicy::status)
        .ok_or_else(|| "Choose a filesystem permission mode before using local tools.".to_string())
}

#[tauri::command]
pub async fn desktop_tool_execute(
    app: AppHandle,
    state: State<'_, DesktopToolState>,
    request: ToolRequest,
) -> Result<ToolResponse, String> {
    let policy = {
        let guard = state
            .policy
            .lock()
            .map_err(|_| "Filesystem permission state is unavailable.".to_string())?;
        guard
            .clone()
            .ok_or_else(|| "Choose a filesystem permission mode before using local tools.".to_string())?
    };
    let audit_request = request.clone();
    let policy_for_execute = policy.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        execute_tool_with(&policy_for_execute, &request, confirm_native)
    })
    .await
    .map_err(|_| "The Windows filesystem tool did not finish.".to_string())?;
    append_audit(&app, &policy, &audit_request, &response);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("vupsrouter-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create test root");
        fs::canonicalize(root).expect("canonicalize test root")
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
        let response = execute_tool_with(
            &policy(ToolMode::Ask, Some(&root)),
            &ToolRequest {
                tool: "read_file".into(),
                args: json!({ "path": file.to_string_lossy() }),
            },
            |_| false,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "approval_denied");

        let response = execute_tool_with(
            &policy(ToolMode::Ask, Some(&root)),
            &ToolRequest {
                tool: "read_file".into(),
                args: json!({ "path": file.to_string_lossy() }),
            },
            |_| true,
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
            |_| false,
        );
        assert!(inside_response.ok);

        let outside_response = execute_tool_with(
            &policy(ToolMode::Workspace, Some(&root)),
            &ToolRequest {
                tool: "read_file".into(),
                args: json!({ "path": outside.to_string_lossy() }),
            },
            |_| false,
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
            |_| true,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "unknown_tool");

        let response = execute_tool_with(
            &policy(ToolMode::Full, None),
            &ToolRequest {
                tool: "read_file".into(),
                args: json!({}),
            },
            |_| true,
        );
        assert!(!response.ok);
        assert_eq!(response.error.as_ref().unwrap().code, "invalid_arguments");
    }
}
