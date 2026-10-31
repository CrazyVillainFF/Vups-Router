use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const MAX_OWNER_LEN: usize = 128;
const MAX_TITLE_CHARS: usize = 60;
const MAX_PATH_CHARS: usize = 1024;
const MAX_SCAN_ENTRIES: usize = 1000;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_READ_BYTES: u64 = 128 * 1024;

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

fn normalize_title(title: &str) -> Result<String, String> {
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
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, encoded).map_err(|_| "Could not save local workspaces.".to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|_| "Could not update local workspaces.".to_string())?;
    }
    fs::rename(&temporary, &path).map_err(|_| "Could not save local workspaces.".to_string())
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

fn within_root(root: &Path, path: &Path) -> bool {
    path.canonicalize()
        .map(|canonical| canonical.starts_with(root))
        .unwrap_or(false)
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
    [
        ".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".der",
    ]
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
        ".crt",
        ".cer",
        ".map",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".bmp",
        ".tiff",
        ".avif",
        ".heic",
        ".svg",
        ".mp3",
        ".wav",
        ".ogg",
        ".flac",
        ".mp4",
        ".mov",
        ".avi",
        ".mkv",
        ".webm",
        ".zip",
        ".gz",
        ".tgz",
        ".bz2",
        ".xz",
        ".7z",
        ".rar",
        ".tar",
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".bin",
        ".wasm",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".sqlite",
        ".sqlite3",
        ".db",
        ".class",
        ".jar",
        ".pyc",
        ".o",
        ".a",
        ".lib",
        ".obj",
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
    if !canonical.starts_with(root) {
        return Err("This file is outside the workspace.".into());
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err("This file is larger than 128 KB.".into());
    }
    let bytes = fs::read(&canonical).map_err(|_| "This file could not be read.".to_string())?;
    if bytes.contains(&0) {
        return Err("Only UTF-8 text files can be attached.".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "Only UTF-8 text files can be attached.".to_string())?;
    if content.trim().is_empty() {
        return Err("This file is empty or unreadable.".into());
    }

    Ok(ReadResult {
        path: parts.join("/"),
        size: metadata.len(),
        content,
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
    let path = canonical_directory(folder.path())?;
    let path_string = path.to_string_lossy().to_string();
    let now = now_millis();
    let mut store = load_store(&app)?;
    let workspaces = store.owners.entry(owner.clone()).or_default();

    if let Some(existing) = workspaces
        .iter_mut()
        .find(|workspace| workspace.path == path_string)
    {
        existing.last_opened_at = now;
        let workspace = existing.clone();
        save_store(&app, &store)?;
        return Ok(Some(workspace));
    }

    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        title: title_from_path(&path),
        path: path_string,
        added_at: now,
        last_opened_at: now,
    };
    workspaces.push(workspace.clone());
    save_store(&app, &store)?;
    Ok(Some(workspace))
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

        fs::remove_dir_all(root).expect("remove test root");
    }
}
