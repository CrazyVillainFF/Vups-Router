use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const MAX_OWNER_LEN: usize = 128;
const MAX_TITLE_CHARS: usize = 60;
const MAX_PATH_CHARS: usize = 1024;
const MAX_SEGMENT_CHARS: usize = 120;
const MAX_WRITE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_ENTRIES: usize = 1000;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_READ_BYTES: u64 = 128 * 1024;
const MAX_TREE_ENTRIES: usize = 800;
const MAX_SEARCH_FILES: usize = 2500;
const MAX_SEARCH_HITS: usize = 120;
const MAX_SEARCH_PREVIEW: usize = 200;
const MAX_DIFF_BYTES: usize = 400 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    id: String,
    title: String,
    path: String,
    added_at: i64,
    last_opened_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStore {
    version: u32,
    owners: HashMap<String, Vec<Workspace>>,
}

impl Default for WorkspaceStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            owners: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    path: String,
    kind: String,
    size: u64,
    readable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    entries: Vec<WorkspaceEntry>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    path: String,
    content: String,
    size: u64,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified_at: i64,
    readable: bool,
    restricted: bool,
    hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeResult {
    path: String,
    entries: Vec<TreeEntry>,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    path: String,
    kind: String,
    size: u64,
    modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    name: String,
    kind: String,
    line: Option<u64>,
    preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    hits: Vec<SearchHit>,
    scanned: usize,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    index_status: String,
    worktree_status: String,
    kind: String,
    staged: bool,
    unstaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReview {
    branch: String,
    head: String,
    files: Vec<GitFile>,
    staged_diff: String,
    unstaged_diff: String,
    diagnostics: Vec<String>,
    truncated: bool,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn normalize_owner(owner: &str) -> Result<String, String> {
    let owner = owner.trim();
    if owner.is_empty() {
        return Err("Sign in before adding a workspace.".into());
    }
    if owner.len() > MAX_OWNER_LEN {
        return Err("This account cannot use local workspaces.".into());
    }
    if !owner
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("This account cannot use local workspaces.".into());
    }
    Ok(owner.to_string())
}

pub(crate) fn normalize_title(title: &str) -> Result<String, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Enter a workspace name.".into());
    }
    let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
    Ok(title)
}

fn title_from_path(path: &Path) -> String {
    let title = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Workspace".into());
    title.chars().take(MAX_TITLE_CHARS).collect()
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("workspaces-v1.json"))
        .map_err(|_| "Local workspace storage is unavailable.".to_string())
}

/// Workspace mutations are read-modify-write over one JSON file, so every
/// load→change→save sequence holds this lock. Without it two commands started
/// in the same second would each write a whole store from a stale snapshot and
/// the later one would silently drop the earlier registration.
static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_guard() -> std::sync::MutexGuard<'static, ()> {
    STORE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Canonical Windows paths come back with a verbatim `\\?\` prefix. It is what
/// makes path comparisons exact, but it must never reach the store or the UI —
/// users read that as a broken path.
fn friendly_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    raw.strip_prefix(r"\\?\")
        .or_else(|| raw.strip_prefix(r"\\.\"))
        .unwrap_or(raw.as_ref())
        .to_string()
}

fn normalize_stored_path(path: &str) -> String {
    friendly_path(Path::new(path.trim()))
}

fn comparable_path(path: &str) -> String {
    let normalized = normalize_stored_path(path);
    let trimmed = normalized.trim_end_matches(|character| {
        character == '/' || character == '\\'
    });
    if trimmed.is_empty() {
        normalized
    } else {
        trimmed.to_string()
    }
    .to_ascii_lowercase()
}

fn same_stored_path(left: &str, right: &str) -> bool {
    comparable_path(left) == comparable_path(right)
}

fn load_store(app: &AppHandle) -> Result<WorkspaceStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(WorkspaceStore::default());
    }
    let raw =
        fs::read_to_string(&path).map_err(|_| "Could not read local workspaces.".to_string())?;
    let mut store: WorkspaceStore =
        serde_json::from_str(&raw).map_err(|_| "Local workspace data is damaged.".to_string())?;
    if store.version != STORE_VERSION {
        store.version = STORE_VERSION;
    }
    // Builds before this change wrote canonical (verbatim) paths. Rewriting them
    // on load is what lets the case-insensitive de-duplication below work for
    // folders that are already registered.
    for workspaces in store.owners.values_mut() {
        for workspace in workspaces {
            workspace.path = normalize_stored_path(&workspace.path);
        }
    }
    Ok(store)
}

fn save_store(app: &AppHandle, store: &WorkspaceStore) -> Result<(), String> {
    let path = store_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Local workspace storage is unavailable.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create local workspace storage.".to_string())?;
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|_| "Could not encode local workspaces.".to_string())?;
    // A unique temporary name, then one rename: the previous fixed name let two
    // owners collide, and deleting the real file first left a window in which a
    // crash would cost every registered workspace.
    let temporary = path.with_file_name(format!("workspaces-v1.{}.json.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, &encoded)
            .map_err(|_| "Could not save local workspaces.".to_string())?;
        fs::rename(&temporary, &path).map_err(|_| "Could not save local workspaces.".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn find_workspace<'a>(
    store: &'a WorkspaceStore,
    owner: &str,
    id: &str,
) -> Result<&'a Workspace, String> {
    if id.trim().is_empty() {
        return Err("Workspace not found.".into());
    }
    store
        .owners
        .get(owner)
        .and_then(|workspaces| workspaces.iter().find(|workspace| workspace.id == id))
        .ok_or_else(|| "Workspace not found.".to_string())
}

pub(crate) fn workspace_path(app: &AppHandle, owner: &str, id: &str) -> Result<PathBuf, String> {
    let owner = normalize_owner(owner)?;
    let store = load_store(app)?;
    let workspace = find_workspace(&store, &owner, id)?;
    canonical_directory(Path::new(&workspace.path))
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|_| "That workspace folder is unavailable.".to_string())?;
    if !canonical.is_dir() {
        return Err("That workspace folder is unavailable.".into());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn component_eq(left: &Component<'_>, right: &Component<'_>) -> bool {
    match (left, right) {
        (Component::Prefix(a), Component::Prefix(b)) => component_text(a.as_os_str()) == component_text(b.as_os_str()),
        (Component::RootDir, Component::RootDir) => true,
        (Component::CurDir, Component::CurDir) => true,
        (Component::Normal(a), Component::Normal(b)) => component_text(a) == component_text(b),
        _ => false,
    }
}

fn component_text(value: &std::ffi::OsStr) -> String {
    value.to_string_lossy().to_ascii_lowercase()
}

/// `Path::starts_with` compares bytes, so `c:\project` does not contain
/// `C:\project\src` even though Windows treats those drives as the same letter.
/// Every containment decision here is component-wise and case-folded.
fn within_root(root: &Path, candidate: &Path) -> bool {
    let mut root_parts = root.components();
    let mut candidate_parts = candidate.components();
    loop {
        match (root_parts.next(), candidate_parts.next()) {
            (None, _) => return true,
            (Some(_), None) => return false,
            (Some(left), Some(right)) => {
                if !component_eq(&left, &right) {
                    return false;
                }
            }
        }
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    within_root(left, right) && within_root(right, left)
}

/// Junctions, mount points and symlinks all report as plain directories until
/// they are followed, so a path is only inside the workspace while every
/// existing ancestor is a real directory.
fn reject_link_ancestors(path: &Path) -> Result<(), String> {
    let mut cursor = path.to_path_buf();
    loop {
        if let Ok(metadata) = fs::symlink_metadata(&cursor) {
            if metadata.file_type().is_symlink() {
                return Err("That path passes through a link, which workspaces never follow.".into());
            }
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        if parent.as_os_str().is_empty() {
            break;
        }
        cursor = parent.to_path_buf();
    }
    Ok(())
}

pub(crate) fn skipped_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".svn"
            | ".hg"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | ".next"
            | ".nuxt"
            | ".cache"
            | ".turbo"
            | "coverage"
            | "vendor"
            | "venv"
            | ".venv"
            | "__pycache__"
            | ".idea"
            | ".vscode"
            | "pods"
            | ".gradle"
            | ".terraform"
            | ".ssh"
            | ".aws"
            | ".azure"
            | ".gnupg"
            | ".kube"
            | ".docker"
            | ".npm"
            | ".cargo"
            | ".m2"
    )
}

/// Credentials and private-key material. Kept separate from the broader
/// `skipped_file` list: a PDF is not a secret, it is just not text, and the
/// agent must report those two situations differently.
pub(crate) fn sensitive_file(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let exact = matches!(
        name.as_str(),
        ".env"
            | ".npmrc"
            | ".netrc"
            | ".pypirc"
            | ".htpasswd"
            | "credentials"
            | "credentials.json"
            | "secrets.json"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
    );
    if exact || name.starts_with(".env.") {
        return true;
    }
    if name.starts_with("secret") || name.starts_with("credential") {
        return true;
    }
    [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".der"]
        .iter()
        .any(|extension| name.ends_with(extension))
}

pub(crate) fn skipped_file(name: &str) -> bool {
    if sensitive_file(name) {
        return true;
    }
    let name = name.to_ascii_lowercase();
    let exact = matches!(
        name.as_str(),
        "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "cargo.lock"
    );
    if exact {
        return true;
    }
    if [
        ".crt", ".cer", ".map", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
        ".avif", ".heic", ".svg", ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".avi", ".mkv",
        ".webm", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".pdf", ".doc",
        ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".exe", ".dll", ".so", ".dylib", ".bin",
        ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".sqlite", ".sqlite3", ".db", ".class",
        ".jar", ".pyc", ".o", ".a", ".lib", ".obj",
    ]
    .iter()
    .any(|extension| name.ends_with(extension))
    {
        return true;
    }
    false
}

fn known_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "rs" | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "cjs"
            | "json"
            | "jsonc"
            | "md"
            | "mdx"
            | "txt"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "ps1"
            | "bat"
            | "cmd"
            | "py"
            | "rb"
            | "go"
            | "java"
            | "kt"
            | "kts"
            | "swift"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "cs"
            | "php"
            | "sql"
            | "graphql"
            | "gql"
            | "vue"
            | "svelte"
            | "astro"
            | "csv"
            | "tsv"
            | "log"
            | "gitignore"
            | "gitattributes"
            | "dockerignore"
            | "editorconfig"
    )
}

fn looks_like_text(path: &Path, extension: &str) -> bool {
    if known_text_extension(extension) {
        return true;
    }
    if !extension.is_empty() {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none(),
    }
}

fn scan_root(root: &Path) -> ScanResult {
    let mut entries = Vec::new();
    let mut truncated = false;
    walk_directory(root, root, 0, &mut entries, &mut truncated);
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    ScanResult { entries, truncated }
}

fn walk_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<WorkspaceEntry>,
    truncated: &mut bool,
) {
    if entries.len() >= MAX_SCAN_ENTRIES {
        *truncated = true;
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else {
        return;
    };
    let mut children: Vec<_> = read_dir.filter_map(Result::ok).collect();
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        if entries.len() >= MAX_SCAN_ENTRIES {
            *truncated = true;
            return;
        }
        let path = child.path();
        let name = child.file_name().to_string_lossy().to_string();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if skipped_directory(&name) {
                continue;
            }
            if depth >= MAX_SCAN_DEPTH {
                *truncated = true;
                continue;
            }
            if !within_root(root, &path) {
                continue;
            }
            walk_directory(root, &path, depth + 1, entries, truncated);
            continue;
        }
        if !metadata.is_file() || skipped_file(&name) || metadata.len() > MAX_READ_BYTES {
            continue;
        }
        let extension = path
            .extension()
            .map(|value| value.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !looks_like_text(&path, &extension) || !within_root(root, &path) {
            continue;
        }
        let Some(relative) = relative_path(root, &path) else {
            continue;
        };
        entries.push(WorkspaceEntry {
            path: relative,
            kind: "file".into(),
            size: metadata.len(),
            readable: true,
        });
    }
}

fn safe_components(requested: &str) -> Result<Vec<String>, String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PATH_CHARS {
        return Err("That file path is not valid.".into());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("That file is outside the workspace.".into());
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("That file is outside the workspace.".into())
            }
        }
    }
    if parts.is_empty() {
        return Err("That file path is not valid.".into());
    }
    Ok(parts)
}

fn read_workspace_path(root: &Path, requested: &str) -> Result<ReadResult, String> {
    read_workspace_path_with(root, requested, false)
}

fn read_workspace_path_with(
    root: &Path,
    requested: &str,
    allow_empty: bool,
) -> Result<ReadResult, String> {
    let parts = safe_components(requested)?;
    if parts
        .iter()
        .take(parts.len().saturating_sub(1))
        .any(|part| skipped_directory(part))
    {
        return Err("This path is excluded from workspaces.".into());
    }
    let file_name = parts.last().expect("validated path");
    if skipped_file(file_name) {
        return Err("This file is excluded to protect secrets and binaries.".into());
    }

    let candidate = parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    let metadata =
        fs::symlink_metadata(&candidate).map_err(|_| "This file could not be read.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("This file could not be read.".into());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "This file could not be read.".to_string())?;
    if !within_root(root, &canonical) {
        return Err("This file is outside the workspace.".into());
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err("This file is larger than 128 KB.".into());
    }
    let bytes = fs::read(&canonical).map_err(|_| "This file could not be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("Only UTF-8 text files can be opened.".into());
    }
    let content =
        String::from_utf8(bytes).map_err(|_| "Only UTF-8 text files can be opened.".to_string())?;
    if content.is_empty() && !allow_empty {
        return Err("This file is empty or unreadable.".into());
    }

    Ok(ReadResult {
        path: parts.join("/"),
        size: metadata.len(),
        content,
        truncated: false,
    })
}

fn relative_display(root: &Path, path: &Path) -> String {
    relative_path(root, path).unwrap_or_default()
}

fn modified_at(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn resolve_workspace_directory(root: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() {
        return Ok(root.to_path_buf());
    }
    let parts = safe_components(requested)?;
    if parts.iter().any(|part| skipped_directory(part)) {
        return Err("This folder is excluded from workspaces.".into());
    }
    let candidate = parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    let metadata = fs::symlink_metadata(&candidate)
        .map_err(|_| "This workspace folder is unavailable.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("That workspace item is not a folder.".into());
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "This workspace folder is unavailable.".to_string())?;
    if !within_root(root, &canonical) {
        return Err("That folder is outside the workspace.".into());
    }
    Ok(canonical)
}

/// A project folder name is the one piece of this flow the user types, so it is
/// checked against what Windows itself refuses: path separators, the reserved
/// characters, trailing dots and spaces, and the reserved device names.
fn validate_segment(name: &str, max_chars: usize) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Enter a name first.".into());
    }
    if name.chars().count() > max_chars {
        return Err(format!("Keep the name to {max_chars} characters or fewer."));
    }
    if name == "." || name == ".." {
        return Err("That name is reserved.".into());
    }
    if name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err("A name cannot contain \\ / : * ? \" < > |.".into());
    }
    if name.chars().any(|character| (character as u32) < 0x20) {
        return Err("A name cannot contain control characters.".into());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("A name cannot end with a dot or a space.".into());
    }
    let stem = name.split('.').next().unwrap_or_default().to_ascii_lowercase();
    if matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    ) {
        return Err("Windows reserves that name.".into());
    }
    Ok(name)
}

fn mutation_parts(requested: &str) -> Result<Vec<String>, String> {
    let parts = safe_components(requested)?;
    if let Some(part) = parts.iter().find(|part| skipped_directory(part)) {
        return Err(format!(
            "{part} is managed outside VupsRouter, so it cannot be changed here."
        ));
    }
    if parts.last().is_some_and(|part| sensitive_file(part)) {
        return Err("Credential and key files are not edited from the workspace panel.".into());
    }
    Ok(parts)
}

fn candidate_under(root: &Path, parts: &[String]) -> PathBuf {
    parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// Re-checks the real path immediately before a mutation: the link guard above
/// reads the path as asked, this one reads it as it exists now.
fn confirm_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    reject_link_ancestors(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "That path is no longer available.".to_string())?;
    if !within_root(root, &canonical) {
        return Err("That path is outside the workspace.".into());
    }
    Ok(canonical)
}

fn guard_text(content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_WRITE_BYTES {
        return Err("Keep saved files under 2 MB.".into());
    }
    if content.contains('\0') {
        return Err("Only UTF-8 text files can be saved.".into());
    }
    Ok(())
}

/// A half-written file is worse than a failed save, so the new text is written
/// beside the target and renamed over it.
fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let temporary = path.with_file_name(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        fs::write(&temporary, content.as_bytes())
            .map_err(|_| "Windows could not write that file.".to_string())?;
        fs::rename(&temporary, path).map_err(|_| "Windows could not save that file.".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn mutation_result(root: &Path, canonical: &Path) -> Result<MutationResult, String> {
    let metadata =
        fs::symlink_metadata(canonical).map_err(|_| "The change could not be confirmed.".to_string())?;
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    Ok(MutationResult {
        path: relative_display(root, canonical),
        kind: kind.to_string(),
        size: metadata.len(),
        modified_at: modified_at(&metadata),
    })
}

pub(crate) fn create_project_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let folder = validate_segment(name, MAX_TITLE_CHARS)?;
    let canonical_parent = canonical_directory(parent)
        .map_err(|_| "That location no longer exists. Choose a folder that exists.".to_string())?;
    if !canonical_parent
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
    {
        return Err("Windows does not let a project sit at a drive or network root. Choose a folder inside the drive.".into());
    }
    let target = canonical_parent.join(&folder);
    if fs::symlink_metadata(&target).is_ok() {
        return Err(
            "A folder with that name already exists there. Open the existing one instead."
                .into(),
        );
    }
    fs::create_dir_all(&target)
        .map_err(|_| "Windows could not create the project folder. Check the location and try again.".to_string())?;
    let canonical = canonical_directory(&target)
        .map_err(|_| "The folder was created but Windows will not open it.".to_string())?;
    if !within_root(&canonical_parent, &canonical) {
        return Err("Windows redirected that location outside the folder you chose.".into());
    }
    Ok(canonical)
}

fn create_workspace_directory(root: &Path, requested: &str) -> Result<MutationResult, String> {
    let parts = mutation_parts(requested)?;
    let candidate = candidate_under(root, &parts);
    if fs::symlink_metadata(&candidate).is_ok() {
        return Err("A folder with that name already exists.".into());
    }
    reject_link_ancestors(&candidate)?;
    fs::create_dir_all(&candidate).map_err(|_| "Windows could not create that folder.".to_string())?;
    let canonical = confirm_inside(root, &candidate)?;
    mutation_result(root, &canonical)
}

fn create_workspace_file(
    root: &Path,
    requested: &str,
    content: &str,
) -> Result<MutationResult, String> {
    let parts = mutation_parts(requested)?;
    guard_text(content)?;
    let candidate = candidate_under(root, &parts);
    if fs::symlink_metadata(&candidate).is_ok() {
        return Err("A file with that name already exists — open it instead of replacing it.".into());
    }
    reject_link_ancestors(&candidate)?;
    if let Some(parent) = candidate.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "Windows could not create the folder for that file.".to_string())?;
    }
    write_text_atomic(&candidate, content)?;
    let canonical = confirm_inside(root, &candidate)?;
    mutation_result(root, &canonical)
}

fn write_workspace_file(root: &Path, requested: &str, content: &str) -> Result<MutationResult, String> {
    let parts = mutation_parts(requested)?;
    guard_text(content)?;
    let candidate = candidate_under(root, &parts);
    let metadata =
        fs::symlink_metadata(&candidate).map_err(|_| "That file no longer exists.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Only regular files can be saved from the workspace panel.".into());
    }
    let canonical = confirm_inside(root, &candidate)?;
    write_text_atomic(&canonical, content)?;
    mutation_result(root, &canonical)
}

fn rename_workspace_path(root: &Path, requested: &str, new_name: &str) -> Result<MutationResult, String> {
    let parts = mutation_parts(requested)?;
    let candidate = candidate_under(root, &parts);
    let canonical = confirm_inside(root, &candidate)?;
    if relative_path(root, &canonical).is_none() {
        return Err("The workspace folder itself cannot be renamed here.".into());
    }
    let name = validate_segment(new_name, MAX_SEGMENT_CHARS)?;
    let parent = canonical
        .parent()
        .ok_or_else(|| "That item has no folder to rename inside.".to_string())?;
    let target = parent.join(&name);
    if fs::symlink_metadata(&target).is_ok() {
        return Err("An item with that name already exists here.".into());
    }
    fs::rename(&canonical, &target).map_err(|_| "Windows could not rename that item.".to_string())?;
    let moved = confirm_inside(root, &target)?;
    mutation_result(root, &moved)
}

fn move_workspace_path(root: &Path, requested: &str, directory: &str) -> Result<MutationResult, String> {
    let parts = mutation_parts(requested)?;
    let candidate = candidate_under(root, &parts);
    let canonical = confirm_inside(root, &candidate)?;
    if relative_path(root, &canonical).is_none() {
        return Err("The workspace folder itself cannot be moved.".into());
    }
    let trimmed = directory.trim();
    let destination = if trimmed.is_empty() || trimmed == "." {
        root.to_path_buf()
    } else {
        let destination_parts = mutation_parts(trimmed)?;
        confirm_inside(root, &candidate_under(root, &destination_parts))?
    };
    if !destination.is_dir() {
        return Err("Choose a folder to move the item into.".into());
    }
    let name = canonical
        .file_name()
        .ok_or_else(|| "That item cannot be moved.".to_string())?;
    let target = destination.join(name);
    if same_path(&canonical, &target) {
        return Err("That item is already in this folder.".into());
    }
    if canonical.is_dir() && within_root(&canonical, &target) {
        return Err("A folder cannot be moved inside itself.".into());
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err("An item with that name already exists in the destination.".into());
    }
    reject_link_ancestors(&target)?;
    fs::rename(&canonical, &target).map_err(|_| "Windows could not move that item.".to_string())?;
    let moved = confirm_inside(root, &target)?;
    mutation_result(root, &moved)
}

fn delete_workspace_path(root: &Path, requested: &str) -> Result<String, String> {
    let parts = mutation_parts(requested)?;
    let candidate = candidate_under(root, &parts);
    let canonical = confirm_inside(root, &candidate)?;
    let relative =
        relative_path(root, &canonical).ok_or_else(|| "The workspace folder itself cannot be deleted here.".to_string())?;
    let metadata =
        fs::symlink_metadata(&canonical).map_err(|_| "That item no longer exists.".to_string())?;
    let result = if metadata.is_dir() {
        fs::remove_dir_all(&canonical)
    } else {
        fs::remove_file(&canonical)
    };
    result.map_err(|_| "Windows could not delete that item.".to_string())?;
    if fs::symlink_metadata(&canonical).is_ok() {
        return Err("Windows reports the item is still there.".into());
    }
    Ok(relative)
}

pub(crate) fn register_directory(
    app: &AppHandle,
    owner: &str,
    directory: &Path,
    title: Option<&str>,
) -> Result<Workspace, String> {
    let canonical = canonical_directory(directory)?;
    let display = friendly_path(&canonical);
    let now = now_millis();
    let _guard = store_guard();
    let mut store = load_store(app)?;
    let workspaces = store.owners.entry(owner.to_string()).or_default();
    if let Some(existing) = workspaces
        .iter_mut()
        .find(|workspace| same_stored_path(&workspace.path, &display))
    {
        existing.last_opened_at = now;
        let updated = existing.clone();
        save_store(app, &store)?;
        return Ok(updated);
    }
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        title: match title {
            Some(title) => normalize_title(title)?,
            None => title_from_path(&canonical),
        },
        path: display,
        added_at: now,
        last_opened_at: now,
    };
    workspaces.push(workspace.clone());
    save_store(app, &store)?;
    Ok(workspace)
}

fn workspace_root(app: &AppHandle, owner: &str, id: &str) -> Result<PathBuf, String> {
    let owner = normalize_owner(owner)?;
    let store = load_store(app)?;
    let workspace = find_workspace(&store, &owner, id)?.clone();
    canonical_directory(Path::new(&workspace.path))
}

fn list_workspace_directory(root: &Path, directory: &Path) -> Result<TreeResult, String> {
    let read_dir = fs::read_dir(directory)
        .map_err(|_| "This workspace folder could not be listed.".to_string())?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for child in read_dir {
        if entries.len() >= MAX_TREE_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(child) = child else { continue };
        let path = child.path();
        let name = child.file_name().to_string_lossy().to_string();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_file() {
            "file"
        } else {
            continue;
        };
        let restricted = if kind == "directory" {
            skipped_directory(&name)
        } else {
            skipped_file(&name)
        };
        let readable = kind == "file"
            && !restricted
            && metadata.len() <= MAX_READ_BYTES
            && looks_like_text(
                &path,
                &path
                    .extension()
                    .map(|value| value.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default(),
            );
        entries.push(TreeEntry {
            path: relative_display(root, &path),
            hidden: name.starts_with('.'),
            name,
            kind: kind.to_string(),
            size: metadata.len(),
            modified_at: modified_at(&metadata),
            readable,
            restricted,
        });
    }
    entries.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_ascii_lowercase().cmp(&right.name.to_ascii_lowercase()))
    });
    Ok(TreeResult {
        path: relative_display(root, directory),
        entries,
        truncated,
    })
}

fn preview_line(line: &str) -> String {
    let trimmed = line.trim();
    let preview: String = trimmed.chars().take(MAX_SEARCH_PREVIEW).collect();
    if trimmed.chars().count() > MAX_SEARCH_PREVIEW {
        format!("{preview}…")
    } else {
        preview
    }
}

fn search_workspace(root: &Path, query: &str) -> Result<SearchResult, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            scanned: 0,
            truncated: false,
        });
    }
    let mut hits = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        if hits.len() >= MAX_SEARCH_HITS || scanned >= MAX_SEARCH_FILES {
            truncated = true;
            break;
        }
        let Ok(read_dir) = fs::read_dir(&directory) else {
            continue;
        };
        let mut children: Vec<_> = read_dir.filter_map(Result::ok).collect();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            if hits.len() >= MAX_SEARCH_HITS || scanned >= MAX_SEARCH_FILES {
                truncated = true;
                break;
            }
            let path = child.path();
            let name = child.file_name().to_string_lossy().to_string();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if skipped_directory(&name) || depth >= MAX_SCAN_DEPTH {
                    if depth >= MAX_SCAN_DEPTH {
                        truncated = true;
                    }
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_READ_BYTES {
                continue;
            }
            scanned += 1;
            let relative = relative_display(root, &path);
            if name.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: relative.clone(),
                    name: name.clone(),
                    kind: "name".into(),
                    line: None,
                    preview: String::new(),
                });
                if hits.len() >= MAX_SEARCH_HITS {
                    truncated = true;
                    break;
                }
            }
            if skipped_file(&name) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            if bytes.contains(&0) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            let mut content_hits = 0usize;
            for (index, line) in text.lines().enumerate() {
                if content_hits >= 3 {
                    break;
                }
                if line.to_lowercase().contains(&needle) {
                    content_hits += 1;
                    hits.push(SearchHit {
                        path: relative.clone(),
                        name: name.clone(),
                        kind: "content".into(),
                        line: Some(index as u64 + 1),
                        preview: preview_line(line),
                    });
                    if hits.len() >= MAX_SEARCH_HITS {
                        truncated = true;
                        break;
                    }
                }
            }
        }
    }
    Ok(SearchResult {
        hits,
        scanned,
        truncated,
    })
}

fn hide_git_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn git_output(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    command.args(["-c", "core.quotepath=false"]);
    command.args(args);
    hide_git_console(&mut command);
    let output = command.output().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "Git is not installed, or git.exe is not on PATH.".to_string()
        }
        _ => "Git could not be started for this workspace.".to_string(),
    })?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            "Git reported that this folder cannot be reviewed.".to_string()
        } else {
            format!("Git reported: {detail}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_git_status(raw: &[u8]) -> Vec<GitFile> {
    let mut files = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0).peekable();
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let index_status = record[0] as char;
        let worktree_status = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).to_string();
        // With --porcelain -z a rename record is followed by the old path.
        if index_status == 'R' || index_status == 'C' || worktree_status == 'R' || worktree_status == 'C'
        {
            let _ = fields.next();
        }
        if path.is_empty() {
            continue;
        }
        let staged = index_status != ' ' && index_status != '?';
        let unstaged = worktree_status != ' ' || index_status == '?';
        let kind = if index_status == '?' {
            "untracked"
        } else if index_status == 'U' || worktree_status == 'U' || (index_status == 'A' && worktree_status == 'A') || (index_status == 'D' && worktree_status == 'D') {
            "conflict"
        } else if index_status == 'R' || worktree_status == 'R' {
            "renamed"
        } else if index_status == 'A' {
            "added"
        } else if index_status == 'D' || worktree_status == 'D' {
            "deleted"
        } else {
            "modified"
        };
        files.push(GitFile {
            path,
            index_status: index_status.to_string(),
            worktree_status: worktree_status.to_string(),
            kind: kind.into(),
            staged,
            unstaged,
        });
    }
    files
}

fn limit_diff(text: String) -> (String, bool) {
    if text.len() <= MAX_DIFF_BYTES {
        return (text, false);
    }
    let mut boundary = MAX_DIFF_BYTES;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    (format!("{}\n… diff truncated …\n", &text[..boundary]), true)
}

fn review_workspace_git(root: &Path) -> Result<GitReview, String> {
    let scope = ".";
    if let Err(error) = git_output(root, &["rev-parse", "--is-inside-work-tree"]) {
        return Err(if error.contains("not a git repository") {
            "This workspace is not a Git repository.".to_string()
        } else {
            error
        });
    }
    let branch = git_output(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let head = git_output(root, &["rev-parse", "--short", "HEAD"])
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let status = git_output(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            scope,
        ],
    )?;
    let files = parse_git_status(status.as_bytes());
    let staged_raw = git_output(
        root,
        &[
            "--no-optional-locks",
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            scope,
        ],
    )?;
    let unstaged_raw = git_output(
        root,
        &[
            "--no-optional-locks",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=3",
            "--",
            scope,
        ],
    )?;
    let (staged_diff, staged_truncated) = limit_diff(staged_raw);
    let (unstaged_diff, unstaged_truncated) = limit_diff(unstaged_raw);
    let mut diagnostics = Vec::new();
    for args in [
        vec![
            "--no-optional-locks",
            "diff",
            "--check",
            "--",
            scope,
        ],
        vec![
            "--no-optional-locks",
            "diff",
            "--cached",
            "--check",
            "--",
            scope,
        ],
    ] {
        let result = git_output(root, &args);
        if let Ok(text) = result {
            for line in text.lines().take(40) {
                if !line.trim().is_empty() {
                    diagnostics.push(line.to_string());
                }
            }
        }
    }
    Ok(GitReview {
        branch,
        head,
        files,
        staged_diff,
        unstaged_diff,
        diagnostics,
        truncated: staged_truncated || unstaged_truncated,
    })
}

#[tauri::command]
pub async fn workspace_list(app: AppHandle, owner: String) -> Result<Vec<Workspace>, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let mut workspaces = store.owners.get(&owner).cloned().unwrap_or_default();
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.last_opened_at));
    Ok(workspaces)
}

/// Marks a registered folder as the most recently opened one. The list is
/// already sorted by `last_opened_at`; updating it on selection is what lets
/// the next launch restore the folder the user was actually working in, even
/// when browser storage is unavailable or the desktop origin changed.
#[tauri::command]
pub async fn workspace_touch(app: AppHandle, owner: String, id: String) -> Result<Workspace, String> {
    let owner = normalize_owner(&owner)?;
    let id = id.trim();
    if id.is_empty() {
        return Err("Choose a workspace.".into());
    }
    let _guard = store_guard();
    let mut store = load_store(&app)?;
    let workspaces = store
        .owners
        .get_mut(&owner)
        .ok_or_else(|| "That workspace is not registered.".to_string())?;
    let workspace = workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| "That workspace is not registered.".to_string())?;
    workspace.last_opened_at = now_millis();
    let updated = workspace.clone();
    save_store(&app, &store)?;
    Ok(updated)
}

#[tauri::command]
pub async fn workspace_pick(app: AppHandle, owner: String) -> Result<Option<Workspace>, String> {
    let owner = normalize_owner(&owner)?;
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Add a workspace folder")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    Ok(Some(register_directory(&app, &owner, folder.path(), None)?))
}

/// The parent half of "Create New Project Folder": the user chooses where the
/// project goes and nothing is registered yet, so cancelling leaves no workspace
/// behind.
#[tauri::command]
pub async fn workspace_pick_container() -> Result<Option<String>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Choose where to create the project")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let path = canonical_directory(folder.path())?;
    Ok(Some(friendly_path(&path)))
}

#[tauri::command]
pub async fn workspace_create(
    app: AppHandle,
    owner: String,
    parent: String,
    name: String,
) -> Result<Workspace, String> {
    let owner = normalize_owner(&owner)?;
    let requested = parent.trim().to_string();
    if requested.is_empty() {
        return Err("Choose the folder to create the project inside.".into());
    }
    let created = tauri::async_runtime::spawn_blocking(move || {
        create_project_directory(Path::new(&requested), &name)
    })
    .await
    .map_err(|_| "Could not create the project folder.".to_string())??;
    register_directory(&app, &owner, &created, None)
}

/// Registers a folder path the user named themselves. A path that does not exist
/// is refused rather than quietly swapped for a similar one.
#[tauri::command]
pub async fn workspace_add_path(
    app: AppHandle,
    owner: String,
    path: String,
    title: Option<String>,
) -> Result<Workspace, String> {
    let owner = normalize_owner(&owner)?;
    let requested = path.trim().to_string();
    if requested.is_empty() {
        return Err("Enter the folder to open.".into());
    }
    let canonical =
        tauri::async_runtime::spawn_blocking(move || canonical_directory(Path::new(&requested)))
            .await
            .map_err(|_| "Could not open that folder.".to_string())??;
    if !canonical
        .components()
        .any(|component| matches!(component, Component::Normal(_)))
    {
        return Err("VupsRouter does not open a whole drive as a workspace.".into());
    }
    register_directory(&app, &owner, &canonical, title.as_deref())
}

#[tauri::command]
pub async fn workspace_make_directory(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
) -> Result<MutationResult, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || create_workspace_directory(&root, &path))
        .await
        .map_err(|_| "Could not create that folder.".to_string())?
}

#[tauri::command]
pub async fn workspace_create_file(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
    content: String,
) -> Result<MutationResult, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || create_workspace_file(&root, &path, &content))
        .await
        .map_err(|_| "Could not create that file.".to_string())?
}

#[tauri::command]
pub async fn workspace_write_file(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
    content: String,
) -> Result<MutationResult, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || write_workspace_file(&root, &path, &content))
        .await
        .map_err(|_| "Could not save that file.".to_string())?
}

#[tauri::command]
pub async fn workspace_rename_path(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
    new_name: String,
) -> Result<MutationResult, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || rename_workspace_path(&root, &path, &new_name))
        .await
        .map_err(|_| "Could not rename that item.".to_string())?
}

#[tauri::command]
pub async fn workspace_move_path(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
    directory: String,
) -> Result<MutationResult, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || move_workspace_path(&root, &path, &directory))
        .await
        .map_err(|_| "Could not move that item.".to_string())?
}

#[tauri::command]
pub async fn workspace_delete_path(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
) -> Result<String, String> {
    let root = workspace_root(&app, &owner, &id)?;
    tauri::async_runtime::spawn_blocking(move || delete_workspace_path(&root, &path))
        .await
        .map_err(|_| "Could not delete that item.".to_string())?
}

#[tauri::command]
pub async fn workspace_rename(
    app: AppHandle,
    owner: String,
    id: String,
    title: String,
) -> Result<Workspace, String> {
    let owner = normalize_owner(&owner)?;
    let title = normalize_title(&title)?;
    let _guard = store_guard();
    let mut store = load_store(&app)?;
    let workspace = store
        .owners
        .get_mut(&owner)
        .and_then(|workspaces| workspaces.iter_mut().find(|workspace| workspace.id == id))
        .ok_or_else(|| "Workspace not found.".to_string())?;
    workspace.title = title;
    let updated = workspace.clone();
    save_store(&app, &store)?;
    Ok(updated)
}

#[tauri::command]
pub async fn workspace_remove(app: AppHandle, owner: String, id: String) -> Result<(), String> {
    let owner = normalize_owner(&owner)?;
    let _guard = store_guard();
    let mut store = load_store(&app)?;
    let Some(workspaces) = store.owners.get_mut(&owner) else {
        return Ok(());
    };
    workspaces.retain(|workspace| workspace.id != id);
    if workspaces.is_empty() {
        store.owners.remove(&owner);
    }
    save_store(&app, &store)
}

#[tauri::command]
pub async fn workspace_scan(
    app: AppHandle,
    owner: String,
    id: String,
) -> Result<ScanResult, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    tauri::async_runtime::spawn_blocking(move || scan_root(&root))
        .await
        .map_err(|_| "Could not scan the workspace folder.".to_string())
}

#[tauri::command]
pub async fn workspace_read(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
) -> Result<ReadResult, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    tauri::async_runtime::spawn_blocking(move || read_workspace_path(&root, &path))
        .await
        .map_err(|_| "Could not read this workspace file.".to_string())?
}

#[tauri::command]
pub async fn workspace_read_text(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
) -> Result<ReadResult, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    tauri::async_runtime::spawn_blocking(move || read_workspace_path_with(&root, &path, true))
        .await
        .map_err(|_| "Could not read this workspace file.".to_string())?
}

#[tauri::command]
pub async fn workspace_tree(
    app: AppHandle,
    owner: String,
    id: String,
    path: String,
) -> Result<TreeResult, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = resolve_workspace_directory(&root, &path)?;
        list_workspace_directory(&root, &directory)
    })
    .await
    .map_err(|_| "Could not list this workspace folder.".to_string())?
}

#[tauri::command]
pub async fn workspace_search(
    app: AppHandle,
    owner: String,
    id: String,
    query: String,
) -> Result<SearchResult, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    let query = query.trim().to_string();
    if query.chars().count() > 120 {
        return Err("Keep the search under 120 characters.".into());
    }
    tauri::async_runtime::spawn_blocking(move || search_workspace(&root, &query))
        .await
        .map_err(|_| "Could not search the workspace.".to_string())?
}

#[tauri::command]
pub async fn workspace_git_review(
    app: AppHandle,
    owner: String,
    id: String,
) -> Result<GitReview, String> {
    let owner = normalize_owner(&owner)?;
    let store = load_store(&app)?;
    let workspace = find_workspace(&store, &owner, &id)?.clone();
    let root = canonical_directory(Path::new(&workspace.path))?;
    tauri::async_runtime::spawn_blocking(move || review_workspace_git(&root))
        .await
        .map_err(|_| "Could not review this workspace's Git changes.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("vupsrouter-workspace-{}", Uuid::new_v4()));
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

    #[test]
    fn owner_and_title_validation_is_strict() {
        assert!(normalize_owner("user_123").is_ok());
        assert!(normalize_owner("").is_err());
        assert!(normalize_owner("user/../../x").is_err());
        assert!(normalize_owner(&"a".repeat(MAX_OWNER_LEN + 1)).is_err());
        assert_eq!(normalize_title("  My   Project  ").unwrap(), "My Project");
        assert!(normalize_title("   ").is_err());
        assert_eq!(
            normalize_title(&"x".repeat(MAX_TITLE_CHARS + 10))
                .unwrap()
                .chars()
                .count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        assert!(safe_components("../secret.txt").is_err());
        assert!(safe_components("src/../../secret.txt").is_err());
        assert!(safe_components("C:\\Windows\\win.ini").is_err());
        assert!(safe_components("/etc/passwd").is_err());
        assert!(safe_components("").is_err());
        assert_eq!(
            safe_components("src/main.rs").unwrap(),
            vec!["src", "main.rs"]
        );
    }

    #[test]
    fn scan_skips_secrets_dependencies_build_output_and_binaries() {
        let root = test_root();
        write(&root.join("src").join("main.rs"), b"fn main() {}\n");
        write(&root.join("README.md"), b"# Read me\n");
        write(&root.join(".env"), b"SECRET=1\n");
        write(
            &root.join("node_modules").join("pkg").join("index.js"),
            b"x\n",
        );
        write(&root.join("target").join("debug").join("app.exe"), b"x\n");
        write(&root.join("image.png"), b"not really an image");
        write(
            &root.join("large.txt"),
            &vec![b'a'; MAX_READ_BYTES as usize + 1],
        );

        let result = scan_root(&root);
        let paths: Vec<&str> = result
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"README.md"));
        assert!(!paths.iter().any(|path| path.contains(".env")));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert!(!paths.iter().any(|path| path.contains("target")));
        assert!(!paths.iter().any(|path| path.contains("image.png")));
        assert!(!paths.iter().any(|path| path.contains("large.txt")));
        assert!(!result.truncated);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn read_is_bounded_to_the_workspace_and_text_files() {
        let root = test_root();
        write(&root.join("src").join("main.rs"), b"fn main() {}\n");
        write(&root.join(".env"), b"SECRET=1\n");
        write(&root.join("image.png"), b"\x89PNG");
        write(
            &root.join("large.txt"),
            &vec![b'a'; MAX_READ_BYTES as usize + 1],
        );
        write(&root.join("empty.txt"), b"");

        let result = read_workspace_path(&root, "src/main.rs").expect("read source");
        assert_eq!(result.content, "fn main() {}\n");
        assert_eq!(result.path, "src/main.rs");
        assert!(read_workspace_path(&root, "../outside.txt").is_err());
        assert!(read_workspace_path(&root, ".env").is_err());
        assert!(read_workspace_path(&root, "image.png").is_err());
        assert!(read_workspace_path(&root, "large.txt").is_err());
        assert!(read_workspace_path(&root, "empty.txt").is_err());

        // The panel may open an empty file so it can be filled in, while the
        // agent-facing reader keeps refusing empty attachments.
        let empty = read_workspace_path_with(&root, "empty.txt", true).expect("read empty");
        assert_eq!(empty.content, "");
        assert_eq!(empty.size, 0);
        assert!(!empty.truncated);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn tree_lists_real_entries_and_marks_protected_ones() {
        let root = test_root();
        write(&root.join("src").join("main.rs"), b"fn main() {}\n");
        write(&root.join("README.md"), b"# Read me\n");
        write(&root.join(".env"), b"SECRET=1\n");
        write(&root.join("node_modules").join("pkg").join("index.js"), b"x\n");
        write(&root.join("image.png"), b"not an image");

        let result = list_workspace_directory(&root, &root).expect("list root");
        assert_eq!(result.path, "");
        let names: Vec<&str> = result.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(names.contains(&".env"));
        assert!(names.contains(&"node_modules"));
        assert!(names.contains(&"image.png"));
        // Directories are listed before files.
        assert_eq!(names[0], "node_modules");
        assert_eq!(names[1], "src");

        let env = result.entries.iter().find(|entry| entry.name == ".env").unwrap();
        assert!(env.restricted);
        assert!(!env.readable);
        assert!(env.hidden);
        let readme = result.entries.iter().find(|entry| entry.name == "README.md").unwrap();
        assert!(readme.readable);
        assert!(!readme.restricted);
        assert_eq!(readme.size, 10);
        let dependencies = result
            .entries
            .iter()
            .find(|entry| entry.name == "node_modules")
            .unwrap();
        assert!(dependencies.restricted);

        let nested = list_workspace_directory(&root, &root.join("src")).expect("list src");
        assert_eq!(nested.path, "src");
        assert_eq!(nested.entries[0].path, "src/main.rs");
        assert!(resolve_workspace_directory(&root, "node_modules").is_err());
        assert!(resolve_workspace_directory(&root, "src/../../").is_err());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn search_finds_file_names_and_text_but_never_secret_contents() {
        let root = test_root();
        write(&root.join("src").join("main.rs"), b"fn main() {\n    let marker = 1;\n}\n");
        write(&root.join("lookup-target.txt"), b"nothing to match here\n");
        write(&root.join("notes.md"), b"the marker appears here too\n");
        write(&root.join(".env"), b"marker=SECRET\n");
        write(
            &root.join("node_modules").join("pkg").join("index.js"),
            b"marker\n",
        );

        let by_name = search_workspace(&root, "LOOKUP-TARGET").expect("search name");
        assert_eq!(by_name.hits.len(), 1);
        assert_eq!(by_name.hits[0].path, "lookup-target.txt");
        assert_eq!(by_name.hits[0].kind, "name");

        let by_text = search_workspace(&root, "marker").expect("search content");
        assert!(by_text.hits.iter().any(|hit| hit.path == "notes.md" && hit.line == Some(1)));
        assert!(by_text.hits.iter().any(|hit| hit.path == "src/main.rs" && hit.line == Some(2)));
        assert!(!by_text.hits.iter().any(|hit| hit.path.contains(".env")));
        assert!(!by_text.hits.iter().any(|hit| hit.path.contains("node_modules")));

        let empty = search_workspace(&root, "   ").expect("empty query");
        assert!(empty.hits.is_empty());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn git_status_parsing_separates_staged_and_unstaged_files() {
        let files = parse_git_status(
            b" M src/app.js\0A  src/new.js\0?? notes.txt\0R  src/renamed.js\0src/old.js\0",
        );
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/app.js");
        assert!(!files[0].staged);
        assert!(files[0].unstaged);
        assert_eq!(files[0].kind, "modified");
        assert_eq!(files[1].path, "src/new.js");
        assert!(files[1].staged);
        assert!(!files[1].unstaged);
        assert_eq!(files[1].kind, "added");
        assert_eq!(files[2].path, "notes.txt");
        assert_eq!(files[2].kind, "untracked");
        assert!(files[2].unstaged);
        assert_eq!(files[3].path, "src/renamed.js");
        assert_eq!(files[3].kind, "renamed");
        assert!(files[3].staged);
    }

    #[test]
    fn git_review_reads_staged_and_unstaged_changes_without_touching_them() {
        let root = test_root();
        let setup = |args: &[&str]| {
            let status = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .expect("git");
            assert!(status.status.success(), "git {:?}", args);
        };
        setup(&["init"]);
        setup(&["config", "user.email", "panel-test@vupsrouter.invalid"]);
        setup(&["config", "user.name", "Panel Test"]);
        write(&root.join("app.js"), b"const value = 1;\n");
        setup(&["add", "app.js"]);
        setup(&["commit", "-m", "initial"]);
        write(&root.join("app.js"), b"const value = 2;\n");
        write(&root.join("staged.js"), b"export const staged = true;\n");
        setup(&["add", "staged.js"]);
        write(&root.join("untracked.js"), b"export const pending = true;\n");

        let review = review_workspace_git(&root).expect("review");
        assert!(review.files.iter().any(|file| file.path == "app.js" && file.unstaged));
        assert!(review.files.iter().any(|file| file.path == "staged.js" && file.staged));
        assert!(review.files.iter().any(|file| file.path == "untracked.js" && file.kind == "untracked"));
        assert!(review.staged_diff.contains("staged.js"));
        assert!(review.unstaged_diff.contains("app.js"));
        assert!(!review.unstaged_diff.contains("staged.js"));
        assert!(!review.head.is_empty());

        // Review is read-only: the working tree and index are exactly as left.
        let status_after = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain"])
            .output()
            .expect("git status");
        let text = String::from_utf8_lossy(&status_after.stdout);
        assert!(text.contains("M app.js"));
        assert!(text.contains("A  staged.js"));
        assert!(text.contains("?? untracked.js"));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn canonical_paths_are_stored_without_the_verbatim_prefix() {
        assert_eq!(friendly_path(Path::new(r"\\?\C:\project")), "C:\\project");
        assert_eq!(friendly_path(Path::new(r"\\?\UNC\server\share")), "\\\\server\\share");
        assert_eq!(friendly_path(Path::new(r"C:\project\My Site")), "C:\\project\\My Site");
        // Builds before this change persisted the verbatim form; they must still
        // de-duplicate against the friendly one.
        assert!(same_stored_path(r"\\?\C:\Project", r"c:\project"));
        assert!(same_stored_path(r"C:\project\", "C:\\project"));
        assert!(!same_stored_path("C:\\project", "C:\\project-two"));
    }

    #[test]
    fn project_and_file_names_are_checked_against_what_windows_allows() {
        assert_eq!(validate_segment("  My   Website  ", MAX_TITLE_CHARS).unwrap(), "My Website");
        assert!(validate_segment("", MAX_TITLE_CHARS).is_err());
        assert!(validate_segment("..", MAX_TITLE_CHARS).is_err());
        assert!(validate_segment("a/b", MAX_TITLE_CHARS).is_err());
        assert!(validate_segment("a:b", MAX_TITLE_CHARS).is_err());
        assert!(validate_segment("notes?", MAX_SEGMENT_CHARS).is_err());
        assert!(validate_segment("trailing.", MAX_SEGMENT_CHARS).is_err());
        assert!(validate_segment("nul", MAX_SEGMENT_CHARS).is_err());
        assert!(validate_segment("COM3.log", MAX_SEGMENT_CHARS).is_err());
        assert!(validate_segment(&"x".repeat(MAX_TITLE_CHARS + 1), MAX_TITLE_CHARS).is_err());
    }

    #[test]
    fn containment_compares_components_and_ignores_windows_letter_case() {
        assert!(within_root(
            Path::new(r"C:\project"),
            Path::new(r"c:\project\src\main.rs")
        ));
        assert!(!within_root(Path::new(r"C:\project"), Path::new(r"D:\project\src")));
        // A sibling whose name merely starts with the root's name is not inside it.
        assert!(!within_root(Path::new(r"C:\project"), Path::new(r"C:\projects\src")));
        assert!(!within_root(Path::new(r"C:\project"), Path::new(r"C:\")));
        assert!(same_path(Path::new(r"c:\project"), Path::new(r"C:\PROJECT")));
    }

    #[test]
    fn creating_a_project_makes_a_real_folder_and_never_replaces_one() {
        let parent = test_root();
        let created = create_project_directory(&parent, "My Website").expect("create project");
        assert!(created.is_dir());
        assert_eq!(friendly_path(&created), format!("{}\\My Website", friendly_path(&parent)));
        // The same name must be opened, not overwritten.
        let again = create_project_directory(&parent, "My Website");
        assert!(again.is_err());
        assert!(create_project_directory(&parent, "../escape").is_err());
        assert!(create_project_directory(&parent, "  ").is_err());
        let missing = parent.join("gone");
        assert!(create_project_directory(&missing, "inside").is_err());
        // Nested names are created as one project folder, not silently as a tree.
        assert!(create_project_directory(&parent, "a\\b").is_err());
        fs::remove_dir_all(parent).expect("remove test root");
    }

    #[test]
    fn explorer_mutations_create_read_rename_move_and_delete_for_real() {
        let root = test_root();
        let directory = create_workspace_directory(&root, "src/components").expect("mkdir");
        assert_eq!(directory.path, "src/components");
        assert_eq!(directory.kind, "directory");
        assert!(root.join("src").join("components").is_dir());
        assert!(create_workspace_directory(&root, "src/components").is_err());

        let file = create_workspace_file(&root, "src/components/App.jsx", "export default 1;\n")
            .expect("create file");
        assert_eq!(file.path, "src/components/App.jsx");
        assert_eq!(file.kind, "file");
        assert_eq!(file.size, 18);
        assert!(create_workspace_file(&root, "src/components/App.jsx", "x").is_err());
        let saved = write_workspace_file(&root, "src/components/App.jsx", "export default 2;\n")
            .expect("save file");
        assert_eq!(saved.size, 18);
        assert_eq!(
            fs::read_to_string(root.join("src").join("components").join("App.jsx")).unwrap(),
            "export default 2;\n"
        );
        // A save must not leave its scratch file behind.
        let leftovers: Vec<_> = fs::read_dir(root.join("src").join("components"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind");
        assert!(write_workspace_file(&root, "src/missing.jsx", "x").is_err());

        let renamed = rename_workspace_path(&root, "src/components/App.jsx", "View.jsx").expect("rename");
        assert_eq!(renamed.path, "src/components/View.jsx");
        assert!(!root.join("src").join("components").join("App.jsx").exists());
        assert!(rename_workspace_path(&root, "src/components/View.jsx", "bad/name").is_err());
        assert!(rename_workspace_path(&root, "", "whatever").is_err());

        create_workspace_directory(&root, "pages").expect("mkdir pages");
        let moved = move_workspace_path(&root, "src/components/View.jsx", "pages").expect("move");
        assert_eq!(moved.path, "pages/View.jsx");
        assert!(root.join("pages").join("View.jsx").is_file());
        assert!(move_workspace_path(&root, "pages", "pages/src").is_err());
        assert!(move_workspace_path(&root, "src", "src/components").is_err());
        assert!(move_workspace_path(&root, "src", "").is_err());

        let deleted = delete_workspace_path(&root, "pages/View.jsx").expect("delete");
        assert_eq!(deleted, "pages/View.jsx");
        assert!(!root.join("pages").join("View.jsx").exists());
        assert!(delete_workspace_path(&root, "src").is_ok());
        assert!(!root.join("src").exists());
        assert!(root.is_dir(), "the workspace root itself survives");
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn explorer_mutations_cannot_leave_the_workspace_or_touch_protected_files() {
        let outside = test_root();
        let root = outside.join("project");
        fs::create_dir_all(&root).expect("create project");
        let root = fs::canonicalize(&root).expect("canonical project");

        for attempted in [
            "../escape",
            "src/../../escape",
            "C:\\Windows\\win.ini",
            "/etc/passwd",
            "\\\\server\\share\\x",
            "",
            ".",
        ] {
            assert!(
                create_workspace_directory(&root, attempted).is_err(),
                "{attempted} must not create anything outside the workspace"
            );
            assert!(create_workspace_file(&root, attempted, "x").is_err());
            assert!(write_workspace_file(&root, attempted, "x").is_err());
            assert!(rename_workspace_path(&root, attempted, "x").is_err());
            assert!(delete_workspace_path(&root, attempted).is_err());
        }
        assert!(!outside.join("escape").exists());

        // Excluded folders and credential files are refused even when the path is
        // inside the workspace, so a click cannot bypass the read guard.
        assert!(create_workspace_file(&root, "node_modules/pkg/index.js", "x").is_err());
        assert!(create_workspace_file(&root, ".env", "TOKEN=1").is_err());
        assert!(write_workspace_file(&root, ".env", "TOKEN=1").is_err());
        assert!(create_workspace_file(&root, "id_rsa", "key").is_err());
        assert!(delete_workspace_path(&root, ".git/config").is_err());
        assert!(delete_workspace_path(&root, "").is_err());

        fs::remove_dir_all(outside).expect("remove test root");
    }

    #[test]
    fn saved_files_are_bounded_and_text_only() {
        let root = test_root();
        create_workspace_directory(&root, "src").expect("mkdir");
        assert!(create_workspace_file(&root, "src/blob.bin", "has a NUL \0 here").is_err());
        assert!(create_workspace_file(&root, "src/huge.js", &"a".repeat(MAX_WRITE_BYTES as usize + 1))
            .is_err());
        fs::remove_dir_all(root).expect("remove test root");
    }
}
