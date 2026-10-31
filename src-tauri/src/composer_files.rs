use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
use uuid::Uuid;

// Composer folder attachments are metadata-first: picking a folder never reads
// file contents and never opens Chromium's directory-upload prompt. A bounded
// scan builds the tree, then the client asks for only the files it will send.
const MAX_SCAN_FILES: usize = 5000;
const MAX_SCAN_DEPTH: usize = 10;
const MAX_REPORT_ENTRIES: usize = 2000;
const MAX_READ_BATCH: usize = 50;
const MAX_READ_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_READ_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;

const SKIPPED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "target",
    "vendor",
    "coverage",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "__pycache__",
    ".venv",
    "venv",
    "out",
    "bin",
    "obj",
    ".svelte-kit",
    ".astro",
    "Library",
    "Temp",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "mdx", "json", "jsonc", "js", "jsx", "mjs", "cjs", "ts", "tsx",
    "mts", "cts", "css", "scss", "sass", "less", "html", "htm", "xml", "py", "rb", "go", "rs",
    "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "php", "sh", "bash",
    "zsh", "fish", "ps1", "bat", "cmd", "sql", "graphql", "gql", "yml", "yaml", "toml", "ini",
    "cfg", "conf", "csv", "tsv", "log", "vue", "svelte", "astro", "properties", "gradle", "cmake",
    "make", "env",
];

const TEXT_FILENAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "procfile",
    "readme",
    "license",
    "licence",
    "changelog",
    "authors",
    "notice",
    ".env",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".npmrc",
    ".nvmrc",
    ".babelrc",
    ".eslintrc",
    ".prettierrc",
];

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "jfif", "webp", "gif", "bmp", "svg", "avif", "heic", "heif",
];

#[derive(Default)]
pub struct ComposerFileState {
    roots: Mutex<HashMap<String, FolderRoot>>,
}

#[derive(Clone)]
struct FolderRoot {
    path: PathBuf,
    options: ScanOptions,
}

// Picking a folder is the user's inclusion decision, so the scan reads
// everything inside it, including hidden secret files and generated trees. The
// options remain for callers that deliberately request a narrower scan; the
// assistant's own permission mode is unchanged.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    include_generated: bool,
    include_secrets: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            include_generated: true,
            include_secrets: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    path: String,
    size: u64,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExcludedEntry {
    path: String,
    reason: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLimits {
    max_files: usize,
    max_depth: usize,
    max_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderReport {
    token: String,
    name: String,
    path: String,
    total_files: usize,
    supported_files: usize,
    total_bytes: u64,
    truncated: bool,
    listed_truncated: bool,
    entries: Vec<FolderEntry>,
    excluded: Vec<ExcludedEntry>,
    unreadable: usize,
    limits: ScanLimits,
    options: ScanOptions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPayload {
    path: String,
    kind: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn is_sensitive_name(name: &str) -> bool {
    let value = name.to_ascii_lowercase();
    matches!(
        value.as_str(),
        ".env" | ".npmrc" | ".pypirc" | ".netrc" | ".git-credentials" | "credentials" | "auth.json"
    ) || value.starts_with(".env.")
        || value.ends_with(".pem")
        || value.ends_with(".key")
        || value.ends_with(".pfx")
        || value.ends_with(".p12")
        || value.ends_with(".jks")
        || value.ends_with(".keystore")
        || value.starts_with("id_rsa")
        || value.starts_with("id_dsa")
        || value.starts_with("id_ecdsa")
        || value.starts_with("id_ed25519")
        || value.starts_with("secrets.")
        || value.starts_with("secret.")
}

fn extension(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.rfind('.') {
        Some(index) => lower[index + 1..].to_string(),
        None => String::new(),
    }
}

fn classification(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if is_sensitive_name(&lower) {
        return "secret";
    }
    if TEXT_FILENAMES.iter().any(|item| *item == lower.as_str()) {
        return "text";
    }
    let ext = extension(&lower);
    if IMAGE_EXTENSIONS.iter().any(|item| *item == ext.as_str()) {
        return "image";
    }
    if TEXT_EXTENSIONS.iter().any(|item| *item == ext.as_str()) {
        return "text";
    }
    "other"
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

struct ScanBudget {
    files: usize,
    supported: usize,
    bytes: u64,
    entries: Vec<FolderEntry>,
    excluded: Vec<ExcludedEntry>,
    unreadable: usize,
    truncated: bool,
    listed_truncated: bool,
}

fn scan_folder(root: &Path, options: ScanOptions) -> ScanBudget {
    let mut budget = ScanBudget {
        files: 0,
        supported: 0,
        bytes: 0,
        entries: Vec::new(),
        excluded: Vec::new(),
        unreadable: 0,
        truncated: false,
        listed_truncated: false,
    };
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    'walk: while let Some((directory, depth)) = stack.pop() {
        if budget.files >= MAX_SCAN_FILES {
            budget.truncated = true;
            break;
        }
        let read_dir = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                budget.unreadable += 1;
                continue;
            }
        };
        for item in read_dir {
            if budget.files >= MAX_SCAN_FILES {
                budget.truncated = true;
                break 'walk;
            }
            let Ok(item) = item else {
                budget.unreadable += 1;
                continue;
            };
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_string();
            let Ok(file_type) = item.file_type() else {
                budget.unreadable += 1;
                continue;
            };
            if file_type.is_symlink() {
                budget.excluded.push(ExcludedEntry {
                    path: relative_path(root, &path),
                    reason: "Symbolic link — not followed.".into(),
                    kind: "symlink".into(),
                });
                continue;
            }
            if file_type.is_dir() {
                let relative = format!("{}/", relative_path(root, &path));
                if !options.include_generated
                    && SKIPPED_DIRECTORIES.iter().any(|skip| *skip == name.as_str())
                {
                    budget.excluded.push(ExcludedEntry {
                        path: relative,
                        reason: "Generated or dependency directory — not scanned.".into(),
                        kind: "directory".into(),
                    });
                    continue;
                }
                if depth + 1 > MAX_SCAN_DEPTH {
                    budget.excluded.push(ExcludedEntry {
                        path: relative,
                        reason: "Nested deeper than the folder scan limit.".into(),
                        kind: "directory".into(),
                    });
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            budget.files += 1;
            let Ok(metadata) = item.metadata() else {
                budget.unreadable += 1;
                continue;
            };
            let size = metadata.len();
            budget.bytes = budget.bytes.saturating_add(size);
            let mut kind = classification(&name);
            if kind == "secret" {
                if !options.include_secrets {
                    budget.excluded.push(ExcludedEntry {
                        path: relative_path(root, &path),
                        reason: "Secret file — turn on \"Include secret files\" for this folder to add it.".into(),
                        kind: "secret".into(),
                    });
                    continue;
                }
                // The user opted in. Secret files are mostly text (.env, keys);
                // binary ones (keystores) surface a read error with a reason.
                kind = "text";
            }
            if kind != "other" {
                budget.supported += 1;
            }
            if budget.entries.len() < MAX_REPORT_ENTRIES {
                budget.entries.push(FolderEntry {
                    path: relative_path(root, &path),
                    size,
                    kind: kind.to_string(),
                });
            } else {
                budget.listed_truncated = true;
            }
        }
    }

    budget
        .entries
        .sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    budget
        .excluded
        .sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    budget
}

fn scan_report(token: String, root: &Path, budget: ScanBudget, options: ScanOptions) -> FolderReport {
    FolderReport {
        token,
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Folder".into()),
        path: root.to_string_lossy().to_string(),
        total_files: budget.files,
        supported_files: budget.supported,
        total_bytes: budget.bytes,
        truncated: budget.truncated,
        listed_truncated: budget.listed_truncated,
        entries: budget.entries,
        excluded: budget.excluded,
        unreadable: budget.unreadable,
        limits: ScanLimits {
            max_files: MAX_SCAN_FILES,
            max_depth: MAX_SCAN_DEPTH,
            max_entries: MAX_REPORT_ENTRIES,
        },
        options,
    }
}

#[tauri::command]
pub async fn composer_pick_folder(
    state: State<'_, ComposerFileState>,
) -> Result<Option<FolderReport>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Attach a folder")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = folder
        .path()
        .canonicalize()
        .map_err(|_| "That folder could not be opened.".to_string())?;
    if !root.is_dir() {
        return Err("Select a folder, not a file.".into());
    }
    let options = ScanOptions::default();
    let scan_root = root.clone();
    let budget = tauri::async_runtime::spawn_blocking(move || scan_folder(&scan_root, options))
        .await
        .map_err(|_| "The folder could not be scanned.".to_string())?;

    let token = Uuid::new_v4().to_string();
    if let Ok(mut roots) = state.roots.lock() {
        // Several folder cards can be attached at once; each keeps its own
        // user-picked root and scan options.
        roots.insert(
            token.clone(),
            FolderRoot {
                path: root.clone(),
                options,
            },
        );
    }

    Ok(Some(scan_report(token, &root, budget, options)))
}

#[tauri::command]
pub fn composer_release_folder(state: State<'_, ComposerFileState>, token: String) {
    if let Ok(mut roots) = state.roots.lock() {
        roots.remove(&token);
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[((first & 0x03) << 4 | second >> 4) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[((second & 0x0f) << 2 | third >> 6) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0x3f) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4e
        && bytes[3] == 0x47
        && bytes[4] == 0x0d
        && bytes[5] == 0x0a
        && bytes[6] == 0x1a
        && bytes[7] == 0x0a
    {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && &bytes[0..4] == b"GIF8" && (bytes[4] == 0x37 || bytes[4] == 0x39) && bytes[5] == 0x61 {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 2 && &bytes[0..2] == b"BM" {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        match &bytes[8..12] {
            b"avif" | b"avis" => return Some("image/avif"),
            b"heic" | b"heix" | b"hevc" | b"mif1" | b"msf1" => return Some("image/heic"),
            _ => {}
        }
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
    let trimmed = head.trim_start();
    if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && head.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}

fn safe_relative(path: &str) -> Result<Vec<String>, String> {
    let normalized = path.replace('\\', "/");
    let parsed = Path::new(&normalized);
    if parsed.is_absolute() {
        return Err("Absolute paths are not accepted.".into());
    }
    let mut parts = Vec::new();
    for component in parsed.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return Err("Relative paths cannot contain '..'.".into()),
        }
    }
    if parts.is_empty() {
        return Err("The file path is empty.".into());
    }
    Ok(parts)
}

fn read_one(root: &Path, path: &str, options: ScanOptions) -> ReadPayload {
    let failure = |message: &str| ReadPayload {
        path: path.to_string(),
        kind: "error".into(),
        size: 0,
        mime_type: None,
        text: None,
        base64: None,
        error: Some(message.to_string()),
    };

    let parts = match safe_relative(path) {
        Ok(parts) => parts,
        Err(message) => return failure(&message),
    };
    if !options.include_secrets && is_sensitive_name(parts.last().map(String::as_str).unwrap_or("")) {
        return failure("Secret file — turn on \"Include secret files\" for this folder to read it.");
    }
    let candidate = parts.iter().fold(root.to_path_buf(), |current, part| current.join(part));
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(_) => return failure("That file could not be read."),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return failure("That file could not be read.");
    }
    let canonical = match candidate.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => return failure("That file could not be read."),
    };
    if !canonical.starts_with(root) {
        return failure("That file is outside the selected folder.");
    }
    let name = candidate
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut kind = classification(&name);
    if kind == "secret" {
        if !options.include_secrets {
            return failure("Secret file — turn on \"Include secret files\" for this folder to read it.");
        }
        kind = "text";
    }
    if kind == "other" {
        return failure("Unsupported file type.");
    }
    if kind == "text" {
        if metadata.len() > MAX_READ_TEXT_BYTES {
            return failure("File is larger than 2 MB.");
        }
        let bytes = match fs::read(&canonical) {
            Ok(bytes) => bytes,
            Err(_) => return failure("That file could not be read."),
        };
        if bytes.contains(&0) {
            return failure("That file looks binary and cannot be attached.");
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return failure("That file is not UTF-8 text."),
        };
        if text.trim().is_empty() {
            return failure("That file appears to be empty.");
        }
        return ReadPayload {
            path: path.to_string(),
            kind: "text".into(),
            size: metadata.len(),
            mime_type: Some("text/plain".into()),
            text: Some(text),
            base64: None,
            error: None,
        };
    }
    if metadata.len() > MAX_READ_IMAGE_BYTES {
        return failure("Image is larger than the 20 MB folder limit.");
    }
    let bytes = match fs::read(&canonical) {
        Ok(bytes) => bytes,
        Err(_) => return failure("That image could not be read."),
    };
    let Some(mime) = sniff_image_mime(&bytes) else {
        return failure("That file is not a valid image.");
    };
    ReadPayload {
        path: path.to_string(),
        kind: "image".into(),
        size: metadata.len(),
        mime_type: Some(mime.to_string()),
        text: None,
        base64: Some(base64_encode(&bytes)),
        error: None,
    }
}

#[tauri::command]
pub async fn composer_read_files(
    state: State<'_, ComposerFileState>,
    token: String,
    paths: Vec<String>,
) -> Result<Vec<ReadPayload>, String> {
    if paths.len() > MAX_READ_BATCH {
        return Err(format!("Read at most {MAX_READ_BATCH} files per request."));
    }
    let selection = {
        let roots = state
            .roots
            .lock()
            .map_err(|_| "The folder selection is unavailable.".to_string())?;
        roots
            .get(&token)
            .cloned()
            .ok_or_else(|| "The folder selection expired. Pick the folder again.".to_string())?
    };
    let FolderRoot { path: root, options } = selection;
    tauri::async_runtime::spawn_blocking(move || {
        let mut total = 0u64;
        let mut payloads = Vec::with_capacity(paths.len());
        for path in paths {
            let payload = read_one(&root, &path, options);
            total = total.saturating_add(payload.size);
            if total > MAX_TOTAL_PAYLOAD_BYTES {
                payloads.push(ReadPayload {
                    path: payload.path,
                    kind: "error".into(),
                    size: 0,
                    mime_type: None,
                    text: None,
                    base64: None,
                    error: Some("This folder read exceeded the payload limit.".into()),
                });
                break;
            }
            payloads.push(payload);
        }
        payloads
    })
    .await
    .map_err(|_| "The folder contents could not be read.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions_and_secrets() {
        assert_eq!(classification("main.rs"), "text");
        assert_eq!(classification("photo.PNG"), "image");
        assert_eq!(classification("archive.zip"), "other");
        assert_eq!(classification("id_rsa"), "secret");
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(safe_relative("../secrets.txt").is_err());
        assert!(safe_relative("C:\\Windows\\win.ini").is_err());
        assert_eq!(safe_relative("assets/hero.png").unwrap(), vec!["assets", "hero.png"]);
    }

    #[test]
    fn base64_matches_reference_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn default_scan_includes_generated_and_secret_entries() {
        let root = std::env::temp_dir().join(format!("vups-scan-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();
        fs::write(root.join(".env"), "TOKEN=x").unwrap();
        fs::write(root.join("logo.png"), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).unwrap();
        fs::write(root.join("node_modules/pkg/ignored.js"), "x").unwrap();

        let report = scan_folder(&root, ScanOptions::default());
        let paths: Vec<_> = report.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&"src/main.rs"));
        assert!(paths.contains(&"index.html"));
        assert!(paths.contains(&"logo.png"));
        assert!(paths.contains(&"node_modules/pkg/ignored.js"));
        assert!(paths.contains(&".env"));
        assert!(report.excluded.is_empty(), "nothing readable is skipped by default");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn narrow_scan_options_still_exclude_generated_folders_and_secrets() {
        let root = std::env::temp_dir().join(format!("vups-narrow-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "module.exports = 1;").unwrap();
        fs::write(root.join(".env"), "TOKEN=abc").unwrap();
        fs::write(root.join("main.js"), "export {};").unwrap();

        let defaults = scan_folder(&root, ScanOptions::default());
        let default_paths: Vec<_> = defaults.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(default_paths.contains(&"node_modules/pkg/index.js"));
        assert!(default_paths.contains(&".env"));
        assert!(defaults.excluded.is_empty());

        let narrow = scan_folder(
            &root,
            ScanOptions {
                include_generated: false,
                include_secrets: false,
            },
        );
        let paths: Vec<_> = narrow.entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(!paths.contains(&"node_modules/pkg/index.js"));
        assert!(!paths.contains(&".env"));
        assert!(narrow.excluded.iter().any(|entry| entry.kind == "directory"));
        assert!(narrow.excluded.iter().any(|entry| entry.kind == "secret"));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn read_one_reads_secret_files_by_default_and_respects_narrow_options() {
        let root = std::env::temp_dir().join(format!("vups-read-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        // The real picker canonicalizes the root before any read, so the test
        // must too or the containment check compares against a non-verbatim path.
        let root = root.canonicalize().unwrap();
        fs::write(root.join(".env"), "TOKEN=abc").unwrap();
        fs::write(root.join("notes.md"), "hello").unwrap();

        let allowed = read_one(&root, ".env", ScanOptions::default());
        assert_eq!(allowed.text.as_deref(), Some("TOKEN=abc"));
        let denied = read_one(
            &root,
            ".env",
            ScanOptions {
                include_generated: false,
                include_secrets: false,
            },
        );
        assert!(denied.error.is_some(), "an explicitly narrow scan still refuses secrets");
        assert!(read_one(&root, "notes.md", ScanOptions::default()).error.is_none());
        fs::remove_dir_all(&root).unwrap();
    }
}
