use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

/// The folder the app owns inside Documents. Everything the product creates for
/// itself — projects, skills, plugins, logs — lives under this one root, so a
/// user can find, back up, or delete it in one place.
pub const ROOT_FOLDER_NAME: &str = "VupsRouter";
pub const LAYOUT_SUBDIRS: [&str; 6] = ["Workspaces", "Projects", "Files", "Skills", "Plugins", "Logs"];
pub const LAYOUT_VERSION: u32 = 1;
/// Where work with no project folder of its own is written. It is a subfolder of
/// the app's root, so a task left unbound never means the whole Documents tree.
pub const DEFAULT_TASK_SUBDIR: &str = "Files";
/// The sidebar names the app's own root rather than a bare "Files".
pub const DEFAULT_WORKSPACE_TITLE: &str = "VupsRouter Files";
const LAYOUT_MARKER_FILE: &str = "vupsrouter-layout.json";
const SETTINGS_FILE: &str = "vups-root-settings-v1.json";
const APP_LOG_FILE: &str = "vupsrouter.log";
const ROTATED_LOG_FILE: &str = "vupsrouter.log.1";
const MAX_LOG_BYTES: u64 = 64 * 1024;
const MAX_LOG_LINE_CHARS: usize = 200;
const MAX_ERROR_CHARS: usize = 400;
const MAX_LISTED_ENTRIES: usize = 200;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

/// Windows reports the Documents folder through the Known Folder API, which is
/// what makes a redirected or OneDrive-known Documents work without guessing a
/// path from the user name. A machine that does not report one gets an error,
/// never a fabricated location.
pub fn documents_directory() -> Result<PathBuf, String> {
    dirs::document_dir().ok_or_else(|| "Windows did not report a Documents folder for this user.".to_string())
}

pub fn vups_root_in(documents: &Path) -> PathBuf {
    documents.join(ROOT_FOLDER_NAME)
}

/// True when the path is a symlink or a junction rather than the folder itself.
/// Writing through one would let the app's own folder point anywhere on the
/// machine, so the bootstrap refuses it.
pub fn is_reparse_point(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
        };
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        attributes != INVALID_FILE_ATTRIBUTES
            && attributes & FILE_ATTRIBUTE_REPARSE_POINT as u32 != 0
    }
    #[cfg(not(windows))]
    {
        fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutMarker {
    pub version: u32,
    pub created_at: i64,
    pub migrated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutReport {
    root: String,
    first_run: bool,
    created: Vec<String>,
    existing: Vec<String>,
    conflicts: Vec<String>,
    layout_version: u32,
    /// The marker version this run replaced. Zero means a folder that pre-dated
    /// versioned markers and was adopted rather than created.
    migrated_from: Option<u32>,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSettings {
    version: u32,
    root_path: String,
    documents_path: String,
    layout_version: u32,
    status: String,
    initialized_at: i64,
    last_error: Option<String>,
    migration_count: u64,
    last_migration_at: i64,
    /// A VupsRouter layout this app recorded at another location, which still
    /// exists. Windows moves Documents on its own — taking the folder over to
    /// OneDrive does it — and the app has to follow the known folder, so the
    /// earlier one would otherwise be lost with the user's work still inside.
    #[serde(default)]
    previous_root_path: Option<String>,
}

/// Windows compares folder names without case, and a trailing separator is not
/// part of a folder's identity, so two spellings of one place must not read as
/// a move.
fn same_folder(first: &str, second: &str) -> bool {
    let plain = |value: &str| value.replace('/', "\\").trim_end_matches(['/', '\\']).to_lowercase();
    plain(first) == plain(second)
}

fn clip_error(value: &str) -> String {
    value.chars().take(MAX_ERROR_CHARS).collect()
}

fn read_marker(root: &Path) -> Option<LayoutMarker> {
    let raw = fs::read(root.join(LAYOUT_MARKER_FILE)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_marker(root: &Path, marker: &LayoutMarker) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(marker).map_err(|_| "Could not encode the folder record.".to_string())?;
    fs::write(root.join(LAYOUT_MARKER_FILE), encoded).map_err(|error| format!("Could not record the folder layout: {}", clip_error(&error.to_string())))
}

/// Creates whatever the layout is missing and records its version. Safe to call
/// on every launch: folders that exist are left alone, a file in a folder's
/// place is reported instead of deleted, and a record that is already current is
/// left untouched.
pub fn ensure_layout(root: &Path) -> Result<LayoutReport, String> {
    if is_reparse_point(root) {
        return Err(format!(
            "{}\\{} is a link to another folder, and VupsRouter will not write through a link.",
            ROOT_FOLDER_NAME, ROOT_FOLDER_NAME
        ));
    }
    let pre_existing = root.exists();
    if pre_existing && !root.is_dir() {
        return Err("A file is standing where the VupsRouter folder belongs.".to_string());
    }
    if !pre_existing {
        fs::create_dir_all(root).map_err(|error| format!("Could not create the VupsRouter folder: {}", clip_error(&error.to_string())))?;
    }

    let marker = read_marker(root);
    let migrated_from = match marker.as_ref() {
        None if pre_existing => Some(0),
        Some(found) if found.version < LAYOUT_VERSION => Some(found.version),
        _ => None,
    };

    let mut created = Vec::new();
    let mut existing = Vec::new();
    let mut conflicts = Vec::new();
    for name in LAYOUT_SUBDIRS {
        let entry = root.join(name);
        if entry.is_dir() {
            existing.push(name.to_string());
            continue;
        }
        if entry.exists() {
            conflicts.push(name.to_string());
            continue;
        }
        fs::create_dir_all(&entry).map_err(|error| format!("Could not create {}: {}", name, clip_error(&error.to_string())))?;
        created.push(name.to_string());
    }

    let timestamp = now_millis();
    let (layout_version, created_at) = if let Some(found) = marker.clone() {
        // A record that is already current, or newer than this build, is left
        // byte-for-byte as it is. An ordinary restart creates nothing, so it must
        // not rewrite the folder's own record either.
        if found.version >= LAYOUT_VERSION {
            (found.version, found.created_at)
        } else {
            let next = LayoutMarker {
                version: LAYOUT_VERSION,
                created_at: found.created_at,
                migrated_at: timestamp,
            };
            write_marker(root, &next)?;
            (next.version, next.created_at)
        }
    } else {
        let next = LayoutMarker {
            version: LAYOUT_VERSION,
            created_at: timestamp,
            migrated_at: timestamp,
        };
        write_marker(root, &next)?;
        (next.version, next.created_at)
    };

    Ok(LayoutReport {
        root: root.to_string_lossy().to_string(),
        first_run: !pre_existing,
        created,
        existing,
        conflicts,
        layout_version,
        migrated_from,
        created_at_ms: created_at,
    })
}

/// The folder work with no project of its own is written into:
/// `VupsRouter\Files`, made by the layout bootstrap. A link standing there is
/// refused rather than followed, because this path becomes the authorization
/// root for every local tool call made by a chat that has no project folder.
pub fn default_task_directory_in(documents: &Path) -> Result<PathBuf, String> {
    let root = vups_root_in(documents);
    ensure_layout(&root)?;
    let files = root.join(DEFAULT_TASK_SUBDIR);
    if is_reparse_point(&files) {
        return Err(format!(
            "{}\\{} is a link to another folder, and VupsRouter will not write through a link.",
            ROOT_FOLDER_NAME, DEFAULT_TASK_SUBDIR
        ));
    }
    if !files.is_dir() {
        return Err(format!(
            "{}\\{} is not a folder VupsRouter can write into.",
            ROOT_FOLDER_NAME, DEFAULT_TASK_SUBDIR
        ));
    }
    Ok(files)
}

/// The same folder for the machine Windows reported for this user.
pub fn default_files_directory() -> Result<PathBuf, String> {
    default_task_directory_in(&documents_directory()?)
}

fn default_settings(root: &Path, documents: &Path) -> RootSettings {
    RootSettings {
        version: 1,
        root_path: root.to_string_lossy().to_string(),
        documents_path: documents.to_string_lossy().to_string(),
        layout_version: 0,
        status: "not_initialized".to_string(),
        initialized_at: 0,
        last_error: None,
        migration_count: 0,
        last_migration_at: 0,
        previous_root_path: None,
    }
}

pub fn read_settings(store: &Path) -> Result<RootSettings, String> {
    match fs::read(store) {
        Ok(raw) => serde_json::from_slice(&raw).map_err(|_| "The saved folder settings could not be read.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RootSettings {
            version: 1,
            root_path: String::new(),
            documents_path: String::new(),
            layout_version: 0,
            status: "not_initialized".to_string(),
            initialized_at: 0,
            last_error: None,
            migration_count: 0,
            last_migration_at: 0,
            previous_root_path: None,
        }),
        Err(error) => Err(format!("Could not read the folder settings: {}", clip_error(&error.to_string()))),
    }
}

fn write_store(store: &Path, settings: &RootSettings) -> Result<(), String> {
    if let Some(parent) = store.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not open the settings folder: {}", clip_error(&error.to_string())))?;
    }
    let encoded = serde_json::to_vec_pretty(settings).map_err(|_| "Could not encode the folder settings.".to_string())?;
    fs::write(store, encoded).map_err(|error| format!("Could not save the folder settings: {}", clip_error(&error.to_string())))
}

/// Appends one stamped line to the app's own log under `Logs`. A link standing
/// there is refused rather than written through: this folder is inside the same
/// Documents tree a user might repoint anywhere on the machine.
pub fn append_log(root: &Path, message: &str) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("VupsRouter's own folder has not been resolved to a location, so nothing was logged.".to_string());
    }
    if is_reparse_point(root) {
        return Err(format!(
            "{} is a link to another folder, and VupsRouter will not write through a link.",
            ROOT_FOLDER_NAME
        ));
    }
    let logs = root.join("Logs");
    if is_reparse_point(&logs) {
        return Err(format!(
            "{}\\Logs is a link to another folder, and VupsRouter will not write through a link.",
            ROOT_FOLDER_NAME
        ));
    }
    fs::create_dir_all(&logs).map_err(|error| format!("Could not create the Logs folder: {}", clip_error(&error.to_string())))?;
    let path = logs.join(APP_LOG_FILE);
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::rename(&path, logs.join(ROTATED_LOG_FILE));
    }
    // One message is one entry: a reason that arrived from Windows can carry
    // newlines, and a caller that logged a whole file would otherwise grow the
    // log past both bounds at once.
    let flat = message.replace('\n', " ").replace('\r', " ");
    let clipped: String = flat.chars().take(MAX_LOG_LINE_CHARS).collect();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Could not open the app log: {}", clip_error(&error.to_string())))?;
    writeln!(file, "{} {}", now_millis(), clipped)
        .map_err(|error| format!("Could not write the app log: {}", clip_error(&error.to_string())))
}

/// Records where the app actually put its folders. A failed run keeps the last
/// known location so Settings can still show and open it.
pub fn record_bootstrap(store: &Path, root: &Path, report: &LayoutReport) -> Result<RootSettings, String> {
    let mut settings = read_settings(store)?;
    let timestamp = now_millis();
    if settings.initialized_at == 0 {
        settings.initialized_at = timestamp;
    }
    let earlier = settings.root_path.clone();
    settings.root_path = root.to_string_lossy().to_string();
    settings.previous_root_path = if earlier.is_empty()
        || same_folder(&earlier, &settings.root_path)
        || !Path::new(&earlier).is_dir()
    {
        None
    } else {
        Some(earlier)
    };
    settings.documents_path = root
        .parent()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    settings.layout_version = report.layout_version;
    settings.status = if report.conflicts.is_empty() {
        "ready".to_string()
    } else {
        "partial".to_string()
    };
    if report.migrated_from.is_some() {
        settings.migration_count += 1;
        settings.last_migration_at = timestamp;
    }
    settings.last_error = if report.conflicts.is_empty() {
        None
    } else {
        Some(format!("Not a folder: {}", report.conflicts.join(", ")))
    };
    write_store(store, &settings)?;
    if let Some(earlier) = settings.previous_root_path.as_deref() {
        let _ = append_log(
            root,
            &format!("workspace layout moved: a VupsRouter folder already exists at {}", earlier),
        );
    }
    if report.conflicts.is_empty() {
        let _ = append_log(
            root,
            &format!(
                "workspace layout ready ({} folders created, {} existing)",
                report.created.len(),
                report.existing.len()
            ),
        );
    } else {
        let _ = append_log(
            root,
            &format!("workspace layout partial: not a folder: {}", report.conflicts.join(", ")),
        );
    }
    Ok(settings)
}

pub fn record_bootstrap_error(store: &Path, root: &Path, message: &str) -> Result<RootSettings, String> {
    let mut settings = read_settings(store)?;
    if !settings.root_path.is_empty() || settings.initialized_at == 0 {
        settings.root_path = root.to_string_lossy().to_string();
    }
    settings.status = "failed".to_string();
    settings.last_error = Some(clip_error(message));
    write_store(store, &settings)?;
    let _ = append_log(root, &format!("workspace layout failed: {}", clip_error(message)));
    Ok(settings)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubdirState {
    name: String,
    kind: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    documents_path: String,
    root_path: String,
    previous_root_path: Option<String>,
    present: bool,
    layout_version: u32,
    status: String,
    initialized: bool,
    migration_count: u64,
    initialized_at: i64,
    last_error: Option<String>,
    subdirs: Vec<SubdirState>,
    recent_log_lines: Vec<String>,
    note: String,
}

fn subdir_states(root: &Path) -> Vec<SubdirState> {
    LAYOUT_SUBDIRS
        .iter()
        .map(|name| {
            let entry = root.join(name);
            let kind = if is_reparse_point(&entry) {
                "link"
            } else if entry.is_dir() {
                "folder"
            } else if entry.exists() {
                "file"
            } else {
                "missing"
            };
            SubdirState {
                name: name.to_string(),
                kind: kind.to_string(),
                path: entry.to_string_lossy().to_string(),
            }
        })
        .collect()
}

/// The last lines of the newest log in `Logs`, so a failure named in Settings is
/// a real file rather than a claim. Bounded by line count and by line length.
fn recent_logs(root: &Path) -> Vec<String> {
    let logs = root.join("Logs");
    let mut files: Vec<PathBuf> = match fs::read_dir(&logs) {
        Ok(entries) => entries.filter_map(|entry| entry.ok().map(|value| value.path())).collect(),
        Err(_) => return Vec::new(),
    };
    if files.len() > MAX_LISTED_ENTRIES {
        files.truncate(MAX_LISTED_ENTRIES);
    }
    files.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .unwrap_or(SystemTime::UNIX_EPOCH)
    });
    let newest = match files.pop() {
        Some(path) if path.is_file() => path,
        _ => return Vec::new(),
    };
    let file = match fs::File::open(&newest) {
        Ok(handle) => handle,
        Err(_) => return Vec::new(),
    };
    let mut lines: Vec<String> = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        lines.push(line.chars().take(240).collect());
        if lines.len() > 20 {
            lines.remove(0);
        }
    }
    lines
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "VupsRouter could not reach its own settings folder.".to_string())?;
    Ok(dir.join(SETTINGS_FILE))
}

/// Runs the bootstrap on the real Documents folder. Called before the window is
/// built, so the app is never presented as ready with nowhere to save.
pub fn bootstrap(app: &AppHandle) -> LayoutReport {
    let documents = match documents_directory() {
        Ok(path) => path,
        Err(error) => {
            let root = PathBuf::from(ROOT_FOLDER_NAME);
            if let Ok(store) = settings_path(app) {
                let _ = record_bootstrap_error(&store, &root, &error);
            }
            return LayoutReport {
                root: String::new(),
                first_run: false,
                created: Vec::new(),
                existing: Vec::new(),
                conflicts: Vec::new(),
                layout_version: 0,
                migrated_from: None,
                created_at_ms: 0,
            };
        }
    };
    let root = vups_root_in(&documents);
    match ensure_layout(&root) {
        Ok(report) => {
            if let Ok(store) = settings_path(app) {
                let _ = record_bootstrap(&store, &root, &report);
            }
            report
        }
        Err(error) => {
            if let Ok(store) = settings_path(app) {
                let _ = record_bootstrap_error(&store, &root, &error);
            }
            LayoutReport {
                root: root.to_string_lossy().to_string(),
                first_run: false,
                created: Vec::new(),
                existing: Vec::new(),
                conflicts: Vec::new(),
                layout_version: 0,
                migrated_from: None,
                created_at_ms: 0,
            }
        }
    }
}

/// Windows treats folder names case-insensitively, so `react site` is already
/// taken by `React Site`. Task wording repeats, and a repeated task must not be
/// sent into the earlier project, so the next free numbered name is chosen —
/// spelled the way the folder already on disk is spelled.
pub fn reserve_project_name(projects: &Path, name: &str) -> Result<String, String> {
    let wanted = crate::workspace::normalize_title(name)?;
    let entries: Vec<String> = fs::read_dir(projects)
        .map_err(|_| "VupsRouter's Projects folder is not available.".to_string())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            path.file_name().map(|value| value.to_string_lossy().to_string())
        })
        .collect();
    let taken = |candidate: &str| {
        let lower = candidate.to_lowercase();
        entries.iter().any(|found| found.to_lowercase() == lower)
    };
    if !taken(&wanted) {
        return Ok(wanted);
    }

    let lower = wanted.to_lowercase();
    let prefix = format!("{}-", lower);
    let family: Vec<(String, u64)> = entries
        .iter()
        .filter_map(|found| {
            let found_lower = found.to_lowercase();
            if found_lower == lower {
                return Some((found.clone(), 0));
            }
            let rest = found_lower.strip_prefix(&prefix)?;
            if rest.is_empty() || !rest.chars().all(|value| value.is_ascii_digit()) {
                return None;
            }
            Some((found.clone(), rest.parse().unwrap_or(0)))
        })
        .collect();
    let stem = family
        .iter()
        .find(|(_, index)| *index == 0)
        .map(|(found, _)| found.clone())
        .or_else(|| {
            family
                .iter()
                .min_by_key(|(found, _)| found.chars().count())
                .map(|(found, _)| strip_index_suffix(found))
        })
        .unwrap_or_else(|| wanted.clone());
    let highest = family.iter().map(|(_, index)| *index).max().unwrap_or(0);
    for index in (highest.max(1) + 1)..=(highest + 501) {
        let candidate = format!("{}-{}", stem, index);
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err("This Projects folder already holds too many projects with that name.".to_string())
}

fn strip_index_suffix(name: &str) -> String {
    match name.rfind('-') {
        Some(at) => {
            let tail = &name[at + 1..];
            if tail.is_empty() || !tail.chars().all(|value| value.is_ascii_digit()) {
                return name.to_string();
            }
            name[..at].to_string()
        }
        None => name.to_string(),
    }
}

pub fn create_project_folder(projects: &Path, name: &str) -> Result<PathBuf, String> {
    crate::workspace::create_project_directory(projects, name)
}

#[tauri::command]
pub async fn vups_root_status(app: AppHandle) -> Result<RootStatus, String> {
    let documents = documents_directory()?;
    let root = vups_root_in(&documents);
    let settings = match settings_path(&app) {
        Ok(store) => read_settings(&store).unwrap_or_else(|_| default_settings(&root, &documents)),
        Err(_) => default_settings(&root, &documents),
    };
    Ok(RootStatus {
        documents_path: documents.to_string_lossy().to_string(),
        root_path: settings.root_path.clone(),
        previous_root_path: settings.previous_root_path.clone(),
        present: root.is_dir(),
        layout_version: settings.layout_version,
        status: settings.status.clone(),
        initialized: settings.initialized_at != 0,
        migration_count: settings.migration_count,
        initialized_at: settings.initialized_at,
        last_error: settings.last_error.clone(),
        subdirs: subdir_states(&root),
        recent_log_lines: recent_logs(&root),
        note: "The path shown is the Documents folder Windows reported for this user.".to_string(),
    })
}

#[tauri::command]
pub async fn vups_root_ensure(app: AppHandle) -> Result<LayoutReport, String> {
    Ok(bootstrap(&app))
}

/// The folder a project task is saved into when the user did not name one:
/// `Documents\VupsRouter\Projects\<task name>`, registered as a workspace so the
/// Files panel, terminal and agent all point at the same real directory.
#[tauri::command]
pub async fn vups_root_project(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<crate::workspace::Workspace, String> {
    let owner = crate::workspace::normalize_owner(&owner)?;
    let root = vups_root_in(&documents_directory()?);
    let report = ensure_layout(&root)?;
    if let Ok(store) = settings_path(&app) {
        let _ = record_bootstrap(&store, &root, &report);
    }
    let projects = root.join("Projects");
    let reserved = reserve_project_name(&projects, &name)?;
    let created = tauri::async_runtime::spawn_blocking(move || create_project_folder(&projects, &reserved))
        .await
        .map_err(|_| "Windows could not create the project folder.".to_string())??;
    crate::workspace::register_directory(&app, &owner, &created, None)
}

/// The root an unbound chat, an unchosen panel and a test run all share. The
/// client calls this only when nothing is registered yet, and the registration
/// is keyed on the real folder, so repeating it returns the same workspace
/// instead of filling the list with copies of one directory.
#[tauri::command]
pub async fn vups_root_default_workspace(
    app: AppHandle,
    owner: String,
) -> Result<crate::workspace::Workspace, String> {
    let owner = crate::workspace::normalize_owner(&owner)?;
    let files = tauri::async_runtime::spawn_blocking(default_files_directory)
        .await
        .map_err(|_| "VupsRouter could not prepare its own folder.".to_string())??;
    crate::workspace::register_directory(&app, &owner, &files, Some(DEFAULT_WORKSPACE_TITLE))
}

#[tauri::command]
pub async fn vups_root_open(app: AppHandle) -> Result<String, String> {
    let root = vups_root_in(&documents_directory()?);
    let report = ensure_layout(&root)?;
    if let Ok(store) = settings_path(&app) {
        let _ = record_bootstrap(&store, &root, &report);
    }
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::open_path(root.to_string_lossy().to_string(), None::<&str>))
        .await
        .map_err(|_| "Windows could not open the folder.".to_string())?
        .map_err(|error| format!("Windows could not open the folder: {}", clip_error(&error.to_string())))?;
    Ok(report.root)
}

#[tauri::command]
pub async fn vups_root_reveal() -> Result<String, String> {
    let root = vups_root_in(&documents_directory()?);
    if !root.is_dir() {
        return Err("The VupsRouter folder does not exist yet.".to_string());
    }
    let shown = root.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", root.to_string_lossy()))
            .status()
    })
    .await
    .map_err(|_| "Windows could not reveal the folder.".to_string())?
    .map_err(|error| format!("Windows could not reveal the folder: {}", clip_error(&error.to_string())))?;
    Ok(shown)
}

/// Phase 1A/1B: the Documents\VupsRouter layout the app owns.
///
/// Every folder here is created from the Windows Known Folder value for
/// Documents, never from a guessed `C:\Users\<name>\Documents` string, and the
/// bootstrap is safe to re-run: a second pass creates nothing that already
/// exists and never touches a file the user put in the way.
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn temp_documents(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("vupsroot-{}-{}", label, Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp documents");
        fs::canonicalize(root).expect("canonicalize temp documents")
    }

    fn remove(root: &std::path::Path) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn the_root_sits_under_the_documents_folder_the_system_reports() {
        let documents = temp_documents("locate");
        let root = vups_root_in(&documents);
        assert_eq!(root, documents.join(ROOT_FOLDER_NAME));
        remove(&documents);
    }

    #[test]
    fn the_known_documents_folder_is_resolved_not_assumed() {
        let documents = documents_directory().expect("Windows must report a Documents folder");
        assert!(documents.is_absolute(), "the known folder must be absolute");
        assert!(documents.is_dir(), "the known folder must exist: {:?}", documents);
        assert!(!is_reparse_point(&documents), "Documents itself is not a stand-in");
        assert_ne!(documents, std::env::temp_dir(), "Documents is not a scratch folder");
    }

    #[test]
    fn a_first_bootstrap_creates_every_required_folder_once() {
        let documents = temp_documents("first");
        let root = vups_root_in(&documents);

        let first = ensure_layout(&root).expect("first bootstrap");
        assert!(first.first_run, "an absent root is a first run");
        assert_eq!(first.created.len(), LAYOUT_SUBDIRS.len());
        assert!(first.existing.is_empty());
        assert!(first.conflicts.is_empty());
        for name in LAYOUT_SUBDIRS {
            assert!(root.join(name).is_dir(), "{} must be a folder", name);
        }
        assert!(root.join(LAYOUT_MARKER_FILE).is_file(), "the layout must be marked");

        let second = ensure_layout(&root).expect("second bootstrap");
        assert!(!second.first_run);
        assert!(second.created.is_empty(), "a re-run must not re-create folders");
        assert_eq!(second.existing.len(), LAYOUT_SUBDIRS.len());
        assert_eq!(second.layout_version, LAYOUT_VERSION);

        remove(&documents);
    }

    #[test]
    fn a_bootstrap_closed_midway_completes_without_touching_saved_work() {
        let documents = temp_documents("partial");
        let root = vups_root_in(&documents);
        fs::create_dir_all(root.join("Workspaces")).expect("partial layout");
        fs::create_dir_all(root.join("Logs")).expect("partial layout");
        fs::write(root.join("Workspaces").join("notes.md"), b"kept by the user").expect("seed");

        let report = ensure_layout(&root).expect("finishing bootstrap");
        assert!(!report.first_run, "a half-built root is not a first run");
        assert_eq!(report.existing, vec!["Workspaces".to_string(), "Logs".to_string()]);
        assert_eq!(
            report.created,
            vec![
                "Projects".to_string(),
                "Files".to_string(),
                "Skills".to_string(),
                "Plugins".to_string()
            ]
        );
        assert_eq!(
            fs::read(root.join("Workspaces").join("notes.md")).expect("saved work"),
            b"kept by the user"
        );
        assert_eq!(report.migrated_from, Some(0), "an unmarked root is adopted once");

        remove(&documents);
    }

    #[test]
    fn a_user_file_in_place_of_a_folder_is_left_alone() {
        let documents = temp_documents("occupied");
        let root = vups_root_in(&documents);
        fs::create_dir_all(&root).expect("root");
        fs::write(root.join("Files"), b"my own file").expect("occupied name");

        let report = ensure_layout(&root).expect("a clash is reported, not fatal");
        assert_eq!(report.conflicts, vec!["Files".to_string()]);
        assert!(!report.created.contains(&"Files".to_string()));
        assert_eq!(
            fs::read(root.join("Files")).expect("user file"),
            b"my own file",
            "a file the user owns is never replaced by a folder"
        );

        remove(&documents);
    }

    #[test]
    fn the_marker_keeps_the_oldest_creation_and_the_newest_version() {
        let documents = temp_documents("marker");
        let root = vups_root_in(&documents);

        let first = ensure_layout(&root).expect("bootstrap");
        let marker = read_marker(&root).expect("marker written");
        assert_eq!(marker.version, LAYOUT_VERSION);
        assert_eq!(marker.created_at, first.created_at_ms);

        fs::remove_dir_all(&root).expect("drop the layout");
        fs::create_dir_all(&root).expect("root again");
        fs::write(
            root.join(LAYOUT_MARKER_FILE),
            serde_json::to_vec(&LayoutMarker {
                version: LAYOUT_VERSION + 5,
                created_at: 1,
                migrated_at: 1,
            })
            .expect("encode future marker"),
        )
        .expect("future marker");

        let newer = ensure_layout(&root).expect("bootstrap over a future marker");
        assert_eq!(newer.layout_version, LAYOUT_VERSION + 5);
        assert_eq!(newer.migrated_from, None, "a newer layout is never downgraded");
        assert_eq!(read_marker(&root).expect("marker").created_at, 1);

        remove(&documents);
    }

    #[test]
    fn an_ordinary_restart_leaves_the_layout_record_as_it_is() {
        let documents = temp_documents("restart-record");
        let root = vups_root_in(&documents);

        let first = ensure_layout(&root).expect("fresh install");
        let record = fs::read(root.join(LAYOUT_MARKER_FILE)).expect("marker written");
        let stamp = fs::metadata(root.join(LAYOUT_MARKER_FILE))
            .expect("marker metadata")
            .modified()
            .expect("marker mtime");

        let again = ensure_layout(&root).expect("restart");
        assert_eq!(
            fs::read(root.join(LAYOUT_MARKER_FILE)).expect("marker after restart"),
            record,
            "a restart that creates nothing must not rewrite the record"
        );
        assert_eq!(
            fs::metadata(root.join(LAYOUT_MARKER_FILE)).expect("mtime").modified().expect("mtime"),
            stamp,
            "an untouched record keeps the time it was last changed"
        );
        assert_eq!(again.created_at_ms, first.created_at_ms, "the original install date is kept");
        assert!(again.created.is_empty(), "nothing is recreated");
        assert!(again.migrated_from.is_none(), "a restart is not a migration");

        remove(&documents);
    }

    #[test]
    fn an_unmarked_existing_folder_is_adopted_and_recorded() {
        let documents = temp_documents("adopt");
        let root = vups_root_in(&documents);
        fs::create_dir_all(root.join("Projects")).expect("pre-existing layout");
        fs::write(root.join("Projects").join("app.rs"), b"fn main() {}").expect("seed");

        let report = ensure_layout(&root).expect("adoption bootstrap");
        assert!(!report.first_run, "an existing root is not a new install");
        assert!(report.existing.contains(&"Projects".to_string()));
        assert!(report.migrated_from.is_some(), "adopting is recorded as a migration");
        assert_eq!(read_marker(&root).expect("marker").version, LAYOUT_VERSION);
        assert!(root.join("Projects").join("app.rs").is_file(), "contents survive");

        remove(&documents);
    }

    #[test]
    fn a_junction_standing_in_for_the_root_is_refused() {
        let documents = temp_documents("junction");
        let target = documents.join("Elsewhere");
        fs::create_dir_all(&target).expect("junction target");
        let link = vups_root_in(&documents);
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link.to_string_lossy(), &target.to_string_lossy()])
            .output()
            .expect("mklink");
        if !made.status.success() {
            remove(&documents);
            panic!("this machine could not create a junction: {}", String::from_utf8_lossy(&made.stderr));
        }

        assert!(is_reparse_point(&link), "a junction must be recognisable");
        let error = ensure_layout(&link).expect_err("a repacked root is never written into");
        assert!(
            error.contains("link"),
            "the refusal must say the folder is a link: {}",
            error
        );
        assert!(!target.join("Workspaces").exists(), "nothing is created through the link");

        remove(&documents);
    }

    #[test]
    fn an_unbound_task_lands_in_the_apps_own_files_folder() {
        let documents = temp_documents("default-folder");
        let expected = vups_root_in(&documents).join(DEFAULT_TASK_SUBDIR);

        let first = default_task_directory_in(&documents).expect("the default folder is made on demand");
        assert_eq!(first, expected, "the default is the app's own Files folder");
        assert!(first.is_dir());

        let again = default_task_directory_in(&documents).expect("a second call needs no second folder");
        assert_eq!(again, first);
        assert_eq!(
            read_marker(&vups_root_in(&documents)).expect("marker").version,
            LAYOUT_VERSION
        );

        remove(&documents);
    }

    #[test]
    fn a_file_standing_in_for_the_default_folder_is_never_written_into() {
        let documents = temp_documents("default-file");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");
        fs::remove_dir(root.join(DEFAULT_TASK_SUBDIR)).expect("remove the folder");
        fs::write(root.join(DEFAULT_TASK_SUBDIR), b"not a folder").expect("plant a file");

        let error = default_task_directory_in(&documents).expect_err("a file is not a workspace root");
        assert!(
            error.contains(DEFAULT_TASK_SUBDIR),
            "the refusal names the folder it could not use: {}",
            error
        );
        assert_eq!(fs::read(root.join(DEFAULT_TASK_SUBDIR)).expect("file untouched"), b"not a folder");

        remove(&documents);
    }

    #[test]
    fn a_junction_in_place_of_the_default_folder_is_refused() {
        let documents = temp_documents("default-junction");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");
        let files = root.join(DEFAULT_TASK_SUBDIR);
        let target = documents.join("Elsewhere");
        fs::remove_dir(&files).expect("remove the folder");
        fs::create_dir_all(&target).expect("junction target");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &files.to_string_lossy(), &target.to_string_lossy()])
            .output()
            .expect("mklink");
        if !made.status.success() {
            remove(&documents);
            panic!("this machine could not create a junction: {}", String::from_utf8_lossy(&made.stderr));
        }

        let error = default_task_directory_in(&documents).expect_err("a linked default folder is not an authority");
        assert!(error.contains("link"), "the refusal says it is a link: {}", error);
        assert!(target.read_dir().expect("target empty").next().is_none(), "nothing was written through it");

        remove(&documents);
    }

    #[test]
    fn the_apps_own_log_folder_records_the_layout_once_per_record() {
        let documents = temp_documents("log");
        let store = documents.join("settings.json");
        let root = vups_root_in(&documents);

        let report = ensure_layout(&root).expect("layout");
        assert!(
            !root.join("Logs").join(APP_LOG_FILE).exists(),
            "making folders is not yet a recorded outcome"
        );
        record_bootstrap(&store, &root, &report).expect("recorded");

        let text = fs::read_to_string(root.join("Logs").join(APP_LOG_FILE)).expect("the log file is real");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1, "one recorded outcome is one line: {:?}", lines);
        assert!(lines[0].contains("workspace layout ready"), "the line names the state: {}", lines[0]);
        assert!(lines[0].starts_with(|c: char| c.is_ascii_digit()), "the line is stamped: {}", lines[0]);

        record_bootstrap_error(&store, &root, "Windows refused the folder.").expect("recorded");
        let after: Vec<String> = fs::read_to_string(root.join("Logs").join(APP_LOG_FILE))
            .expect("log")
            .lines()
            .map(|value| value.to_string())
            .collect();
        assert_eq!(after.len(), 2, "a second outcome adds a second line");
        assert!(after[1].contains("workspace layout failed"), "the failure is named: {}", after[1]);
        assert!(after[1].contains("Windows refused the folder"), "with its reason: {}", after[1]);

        remove(&documents);
    }

    #[test]
    fn a_log_line_is_one_line_and_a_bounded_length() {
        let documents = temp_documents("log-clip");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");

        append_log(&root, &format!("first line\nsecond line {}", "y".repeat(5000))).expect("appended");
        let text = fs::read_to_string(root.join("Logs").join(APP_LOG_FILE)).expect("log");
        assert_eq!(text.lines().count(), 1, "an embedded newline never makes a second entry");
        let written = text.lines().next().expect("the entry");
        assert!(
            written.chars().count() <= MAX_LOG_LINE_CHARS + 24,
            "a runaway message is clipped, not stored whole: {}",
            written.chars().count()
        );
        assert!(!written.contains(&"y".repeat(400)), "the runaway tail is dropped: {}", written);

        remove(&documents);
    }

    #[test]
    fn the_log_rotates_at_one_bound_instead_of_growing_forever() {
        let documents = temp_documents("log-rotation");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");
        let logs = root.join("Logs");
        fs::write(logs.join(APP_LOG_FILE), vec![b'x'; MAX_LOG_BYTES as usize + 16])
            .expect("an over-bound log");

        append_log(&root, "after rotation").expect("appended");
        let retired = fs::read(logs.join(ROTATED_LOG_FILE)).expect("the old log is kept, not truncated");
        assert_eq!(retired.len(), MAX_LOG_BYTES as usize + 16);
        let current = fs::read_to_string(logs.join(APP_LOG_FILE)).expect("a fresh log");
        assert!(current.contains("after rotation"), "and the new line is in the fresh file");

        for _ in 0..200 {
            append_log(&root, "again").expect("appended");
        }
        let mut names: Vec<String> = fs::read_dir(&logs)
            .expect("listing")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![APP_LOG_FILE.to_string(), ROTATED_LOG_FILE.to_string()],
            "200 appends never leave a pile of numbered logs"
        );
        let bytes = fs::metadata(logs.join(APP_LOG_FILE)).expect("metadata").len();
        assert!(bytes <= MAX_LOG_BYTES, "the active file stays inside its bound: {}", bytes);

        remove(&documents);
    }

    #[test]
    fn a_root_that_was_never_resolved_is_never_written_to() {
        // Windows not reporting Documents leaves the settings record holding a
        // bare folder name. Logging to that would build a VupsRouter folder
        // beside the exe, in whatever folder the process happened to start in.
        let error = append_log(Path::new(ROOT_FOLDER_NAME), "workspace layout failed").expect_err("a name is not a location");
        assert!(error.contains("folder"), "the refusal is about the missing location: {}", error);
        assert!(
            !vups_root_in(Path::new(".")).join("Logs").exists(),
            "nothing was created in the process folder"
        );
    }

    #[test]
    fn a_junction_in_place_of_the_log_folder_is_refused() {
        let documents = temp_documents("log-junction");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");
        let logs = root.join("Logs");
        let target = documents.join("Elsewhere");
        fs::remove_dir(&logs).expect("remove the folder");
        fs::create_dir_all(&target).expect("junction target");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &logs.to_string_lossy(), &target.to_string_lossy()])
            .output()
            .expect("mklink");
        if !made.status.success() {
            remove(&documents);
            panic!("this machine could not create a junction: {}", String::from_utf8_lossy(&made.stderr));
        }

        let error = append_log(&root, "into the link").expect_err("a linked Logs folder is not an authority");
        assert!(error.contains("link"), "the refusal says it is a link: {}", error);
        assert!(
            target.read_dir().expect("target listing").next().is_none(),
            "nothing was written through the link"
        );

        remove(&documents);
    }

    #[test]
    fn a_repeated_task_name_is_given_its_own_project_folder() {
        let documents = temp_documents("project");
        let root = vups_root_in(&documents);
        ensure_layout(&root).expect("layout");
        let projects = root.join("Projects");

        assert_eq!(
            reserve_project_name(&projects, "React Site").expect("first free name"),
            "React Site"
        );
        let first = create_project_folder(&projects, "React Site").expect("first project");
        assert!(first.is_dir());

        assert_eq!(
            reserve_project_name(&projects, "React Site").expect("second free name"),
            "React Site-2",
            "a second task with the same name is not sent into the first project"
        );
        assert!(create_project_folder(&projects, "React Site-2").expect("second project").is_dir());

        assert_eq!(
            reserve_project_name(&projects, "react site").expect("case clash"),
            "React Site-3",
            "Windows folder names are not case sensitive"
        );
        assert!(reserve_project_name(&projects, "   ").is_err(), "an empty name is refused");

        remove(&documents);
    }

    #[test]
    fn settings_record_the_folder_the_app_actually_resolved() {
        let documents = temp_documents("settings");
        let store = documents.join("settings.json");
        let root = vups_root_in(&documents);

        let report = ensure_layout(&root).expect("bootstrap");
        let settings = record_bootstrap(&store, &root, &report).expect("recorded");
        assert_eq!(settings.root_path, root.to_string_lossy());
        assert_eq!(settings.layout_version, LAYOUT_VERSION);
        assert_eq!(settings.status, "ready");
        assert!(settings.initialized_at > 0);

        let reread = read_settings(&store).expect("settings round trip");
        assert_eq!(reread.root_path, settings.root_path);
        assert_eq!(reread.migration_count, 0, "a first install migrates nothing");

        fs::write(
            root.join(LAYOUT_MARKER_FILE),
            serde_json::to_vec(&LayoutMarker {
                version: 0,
                created_at: 1,
                migrated_at: 1,
            })
            .expect("encode old marker"),
        )
        .expect("old marker");
        let upgraded = ensure_layout(&root).expect("upgrade bootstrap");
        let after_upgrade = record_bootstrap(&store, &root, &upgraded).expect("recorded upgrade");
        assert_eq!(upgraded.migrated_from, Some(0), "an older layout is a migration");
        assert_eq!(after_upgrade.migration_count, 1);
        assert_eq!(
            after_upgrade.initialized_at, settings.initialized_at,
            "an upgrade does not restart the install date"
        );

        let failing = record_bootstrap_error(&store, &root, "Documents is on a disconnected drive").expect("recorded");
        assert_eq!(failing.status, "failed");
        assert_eq!(read_settings(&store).expect("kept").last_error.as_deref().unwrap(), "Documents is on a disconnected drive");
        assert_eq!(read_settings(&store).expect("still kept").root_path, root.to_string_lossy());

        remove(&documents);
    }

    fn normalise_path(value: &str) -> String {
        value
            .trim_end_matches(['/', '\\'])
            .replace('/', "\\")
            .to_lowercase()
    }

    fn expand_registry_value(value: &str) -> Option<String> {
        let mut out = String::new();
        let mut rest = value;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            let end = after.find('%')?;
            out.push_str(&std::env::var(&after[..end]).ok()?);
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Some(out)
    }

    #[test]
    fn a_documents_folder_named_with_spaces_and_non_ascii_keeps_every_folder_with_it() {
        let base = temp_documents("unicode");
        let documents = base.join("My Documents — Ünïcode 日本語");
        fs::create_dir_all(&documents).expect("a documents folder named in another script");
        let root = vups_root_in(&documents);

        let report = ensure_layout(&root).expect("the layout follows the name it was given");
        assert_eq!(report.root, root.to_string_lossy());
        for name in LAYOUT_SUBDIRS {
            assert!(root.join(name).is_dir(), "{} is missing under the non-ascii root", name);
        }
        let listed: Vec<String> = fs::read_dir(&base)
            .expect("listing")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            listed,
            vec![documents.file_name().expect("name").to_string_lossy().to_string()],
            "Windows sees the folder that was named, not a mangled one"
        );

        let files = default_task_directory_in(&documents).expect("the default folder under a non-ascii name");
        assert_eq!(files, root.join(DEFAULT_TASK_SUBDIR));
        fs::write(files.join("note.txt"), b"kept").expect("writing through the non-ascii name");
        assert_eq!(
            fs::read(root.join(DEFAULT_TASK_SUBDIR).join("note.txt")).expect("read back"),
            b"kept".to_vec()
        );

        let store = documents.join("settings.json");
        record_bootstrap(&store, &root, &report).expect("the resolved name is recorded");
        assert_eq!(read_settings(&store).expect("settings").root_path, root.to_string_lossy());
        append_log(&root, "written under a name with spaces and accents").expect("the log survives the name");
        assert!(recent_logs(&root).join("|").contains("spaces and accents"));

        remove(&base);
    }

    #[test]
    fn a_path_windows_cannot_make_is_refused_and_leaves_nothing_behind() {
        let base = temp_documents("invalid");
        let blocker = base.join("not-a-folder");
        fs::write(&blocker, b"mine").expect("a file where a folder would be");

        let stuck = vups_root_in(&blocker.join("Documents"));
        let error = ensure_layout(&stuck).expect_err("a file cannot hold the app's folder");
        assert!(error.contains("Could not create"), "the refusal says what failed: {}", error);
        assert_eq!(fs::read(&blocker).expect("the user's file"), b"mine");
        assert!(!stuck.exists(), "nothing was built anyway");

        let illegal = base.join("documents?here");
        let second = ensure_layout(&vups_root_in(&illegal)).expect_err("a name Windows refuses is not a place");
        assert!(second.contains("Could not create"), "{}", second);
        assert!(!illegal.exists(), "the illegal folder was not made either");

        let occupied = base.join("home");
        fs::create_dir_all(&occupied).expect("parent");
        fs::write(occupied.join(ROOT_FOLDER_NAME), b"my notes").expect("a file standing as the root");
        let third = ensure_layout(&vups_root_in(&occupied)).expect_err("a file is never replaced by the app");
        assert!(third.contains("file"), "the refusal names the collision: {}", third);
        assert_eq!(
            fs::read(occupied.join(ROOT_FOLDER_NAME)).expect("still the user's file"),
            b"my notes"
        );

        remove(&base);
    }

    #[test]
    fn a_folder_windows_refuses_to_create_is_named_and_nothing_is_recorded() {
        let documents = temp_documents("denied");
        let root = vups_root_in(&documents);
        fs::create_dir_all(root.join("Workspaces")).expect("the folder made before the lock");
        fs::write(root.join("Workspaces").join("notes.md"), b"saved before the lock").expect("seed");

        let who = std::process::Command::new("whoami").output().expect("whoami");
        let user = String::from_utf8_lossy(&who.stdout).trim().to_string();
        let root_text = root.to_string_lossy().to_string();
        let rule = format!("{}:(OI)(CI)W", user);
        let locked = std::process::Command::new("icacls")
            .arg(&root_text)
            .arg("/deny")
            .arg(&rule)
            .output()
            .expect("icacls");
        if !locked.status.success() {
            remove(&documents);
            panic!(
                "this machine could not lock a test folder: {}",
                String::from_utf8_lossy(&locked.stderr)
            );
        }

        let outcome = ensure_layout(&root);
        let marker_after_failure = read_marker(&root).is_some();

        // The lock goes before any assertion, so a failing run cannot leave a
        // denied folder for the next one to trip over.
        let unlocked = std::process::Command::new("icacls")
            .arg(&root_text)
            .arg("/remove:d")
            .arg(&user)
            .output()
            .expect("icacls");
        assert!(
            unlocked.status.success(),
            "the test lock must be removable: {}",
            String::from_utf8_lossy(&unlocked.stderr)
        );

        let error = match outcome {
            Err(error) => error,
            Ok(report) => {
                remove(&documents);
                panic!("a folder Windows refuses to fill was reported as ready: {:?}", report.created);
            }
        };
        assert!(error.contains("Could not create"), "{}", error);
        assert!(
            LAYOUT_SUBDIRS.iter().any(|name| error.contains(name)),
            "the refusal names the folder it could not make: {}",
            error
        );
        assert!(!marker_after_failure, "a half layout is never recorded as finished");

        let retry = ensure_layout(&root).expect("once access is back the retry finishes the layout");
        assert!(retry.conflicts.is_empty());
        for name in LAYOUT_SUBDIRS {
            assert!(root.join(name).is_dir(), "{} is still missing after the retry", name);
        }
        assert_eq!(
            fs::read(root.join("Workspaces").join("notes.md")).expect("saved work"),
            b"saved before the lock"
        );

        remove(&documents);
    }

    #[test]
    fn the_layout_follows_the_documents_folder_the_registry_points_at() {
        // Redirecting Documents — to OneDrive or anywhere else — rewrites this one
        // value, and the Known Folder API is what reads it. Agreeing with it is the
        // proof that no `C:\Users\<name>\Documents` string is ever guessed back
        // together. This test only reads; making the real folders is the built
        // app's job, so the first-launch evidence stays intact.
        let query = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
                "/v",
                "Personal",
            ])
            .output()
            .expect("reg query");
        let printed = String::from_utf8_lossy(&query.stdout).to_string();
        let claimed: Option<String> = printed
            .lines()
            .map(str::trim_start)
            .find(|line| line.to_lowercase().starts_with("personal "))
            .and_then(|line| line.rsplit_once("REG_"))
            .map(|(_, tail)| tail.split_whitespace().skip(1).collect::<Vec<&str>>().join(" "));
        let documents = documents_directory().expect("Windows must report a Documents folder");

        let Some(claimed) = claimed else {
            let profile = std::env::var("USERPROFILE").expect("the user profile folder");
            assert_eq!(
                normalise_path(&documents.to_string_lossy()),
                normalise_path(&format!("{}\\Documents", profile)),
                "with no Personal value, Documents is the profile's own"
            );
            return;
        };
        let expanded = expand_registry_value(&claimed)
            .unwrap_or_else(|| panic!("the registry named a variable this test could not expand: {}", claimed));
        assert_eq!(
            normalise_path(&documents.to_string_lossy()),
            normalise_path(&expanded),
            "the app must build where Windows says Documents is, not where a username suggests"
        );
        assert!(
            vups_root_in(&documents).starts_with(Path::new(&expanded)),
            "the app's root belongs inside the folder the registry points at"
        );
    }

    #[test]
    fn a_documents_folder_that_moved_is_recorded_instead_of_silently_duplicated() {
        let store = std::env::temp_dir().join(format!("vupsroot-moved-{}.json", Uuid::new_v4()));
        let old_documents = temp_documents("moved-old");
        let new_documents = temp_documents("moved-new");
        let old_root = vups_root_in(&old_documents);

        let report = ensure_layout(&old_root).expect("the first layout");
        fs::write(old_root.join("Projects").join("app.rs"), b"fn main() {}").expect("work in the old layout");
        record_bootstrap(&store, &old_root, &report).expect("recorded");

        // Windows now reports a different Documents, which is what taking the
        // folder over to OneDrive does.
        let new_root = vups_root_in(&new_documents);
        let moved = ensure_layout(&new_root).expect("the layout follows the known folder");
        let after = record_bootstrap(&store, &new_root, &moved).expect("recorded at the new place");

        assert_eq!(
            after.root_path,
            new_root.to_string_lossy(),
            "the live layout is the one the app writes into"
        );
        assert_eq!(
            after.previous_root_path.as_deref(),
            Some(old_root.to_string_lossy().as_ref()),
            "the layout the user's work still sits in must not vanish from the record"
        );
        assert!(
            recent_logs(&new_root).join("|").contains("already exists"),
            "the app says out loud that a second layout was found: {:?}",
            recent_logs(&new_root)
        );
        assert_eq!(
            fs::read(old_root.join("Projects").join("app.rs")).expect("untouched"),
            b"fn main() {}",
            "the earlier layout is never emptied or moved"
        );

        // Once the earlier folder is gone there is nothing left to point at.
        remove(&old_documents);
        let again = ensure_layout(&new_root).expect("a re-run");
        let settled = record_bootstrap(&store, &new_root, &again).expect("recorded again");
        assert_eq!(settled.previous_root_path, None, "a stale pointer is not kept forever");

        let _ = fs::remove_file(&store);
        remove(&new_documents);
    }
}
