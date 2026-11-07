//! Local skill packages under `Documents\VupsRouter\Skills`.
//!
//! `docs/VupsRouter-Skill-Package-Spec.md` is the normative format. This module
//! is the only reader and writer of that folder: it validates, installs,
//! discovers, enables, uninstalls and loads packages. It never executes a file
//! from a package. Skill text leaves this module only as data inside a tool
//! result, which the desktop tool prompt already defines as untrusted input, so
//! a package can never widen a permission or replace a system instruction.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const MANIFEST_FILE: &str = "skill.json";
pub const MANIFEST_VERSION: u32 = 1;
pub const SKILLS_SUBDIR: &str = "Skills";
pub const STATE_FILE: &str = "skills-state-v1.json";
pub const STATE_VERSION: u32 = 1;
pub const MAX_SKILL_READ_BYTES: u64 = 256 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 128 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 2_000;
pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_ARCHIVE_DEPTH: usize = 32;
pub const MAX_REFERENCES: usize = 32;
pub const MAX_DECLARED_PATH_CHARS: usize = 512;
pub const MAX_ID_CHARS: usize = 64;

/// The installer's own staging folders live inside `Skills` so the swap is a
/// same-volume rename. Discovery skips this prefix and this prefix only.
const STAGING_PREFIX: &str = "~vups-skill-";

/// A permission a package may declare. These are the access classes the approval
/// engine already has (`desktop_tools.rs::action_access`); a declaration grants
/// nothing, it only tells the user what the skill is written around.
pub const PERMISSION_VOCABULARY: [&str; 8] = [
    "read", "contents", "write", "delete", "launch", "execute", "app", "system",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: String,
    pub message: String,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }

    fn io(what: &str, path: &Path, error: &std::io::Error) -> Self {
        Self::new(
            "skill_io",
            format!("{what} could not be read at {}: {error}", path.display()),
        )
    }

    fn escape(declared: &str) -> Self {
        Self::new(
            "skill_path_escape",
            format!(
                "`{}` does not name a file inside this skill package, so nothing was read.",
                clip(declared, 120)
            ),
        )
    }

    fn link(path: &Path) -> Self {
        Self::new(
            "skill_symlink_rejected",
            format!(
                "`{}` is a link or junction. VupsRouter reads only real files inside the \
                 package folder, so nothing was read.",
                name_of(path)
            ),
        )
    }

    fn too_large(what: &str, limit: &str) -> Self {
        Self::new(
            "skill_package_too_large",
            format!(
                "The package is over the {what} limit ({limit}). Installation stopped and \
                 nothing was installed."
            ),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReference {
    pub path: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityEntry {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integrity {
    pub algorithm: String,
    pub files: Vec<IntegrityEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    #[serde(rename = "manifestVersion")]
    pub manifest_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: String,
    pub instructions: String,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub references: Vec<SkillReference>,
    #[serde(default)]
    pub integrity: Option<Integrity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub id: String,
    pub version: String,
    pub installed_at: i64,
    pub source_kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub version: u32,
    #[serde(default)]
    pub disabled: Vec<String>,
    #[serde(default)]
    pub installs: Vec<InstallRecord>,
    #[serde(default)]
    pub last_scan: Option<ScanSummary>,
    /// The record this run could not read. `read_state` never presents damaged
    /// data as "nothing disabled", because that would silently re-enable a skill
    /// the user turned off.
    #[serde(default, skip)]
    pub corrupted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub at: i64,
    pub folders: usize,
    pub ready: usize,
    pub invalid: usize,
    pub disabled: usize,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub path: String,
    pub status: String,
    pub enabled: bool,
    pub error_code: String,
    pub errors: Vec<String>,
    pub permissions: Vec<String>,
    pub capabilities: Vec<String>,
    pub references: Vec<String>,
    pub instructions_path: String,
    pub bytes: u64,
    pub integrity: String,
    pub installed_at: Option<i64>,
    pub source_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub root: String,
    pub skills: Vec<SkillRecord>,
    pub scan: ScanSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSkill {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub path: String,
    pub instructions_path: String,
    pub instructions: String,
    pub bytes: u64,
    pub integrity: String,
    pub permissions: Vec<String>,
    pub capabilities: Vec<String>,
    pub references: Vec<String>,
}

/// What the app just did, reported next to the list it changed. This is the
/// result of the call, not stored state: an install that was refused never
/// appears here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub kind: String,
    pub message: String,
    pub skill: Option<SkillRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsStatus {
    pub root_path: String,
    pub state_path: String,
    pub manifest_version: u32,
    pub skills: Vec<SkillRecord>,
    pub scan: ScanSummary,
    pub last_scan: Option<ScanSummary>,
    pub state_corrupted: bool,
    pub action: Option<ActionResult>,
    pub note: String,
}

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn clip(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= limit {
        return value.to_string();
    }
    let mut out: String = chars[..limit].iter().collect();
    out.push('…');
    out
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// Only the manifest `id` character class keeps a package key from becoming a
/// path, so it is checked by hand rather than with a regex crate.
fn is_safe_id(id: &str) -> bool {
    let chars: Vec<char> = id.chars().collect();
    if chars.is_empty() || chars.len() > MAX_ID_CHARS {
        return false;
    }
    if !chars[0].is_ascii_lowercase() && !chars[0].is_ascii_digit() {
        return false;
    }
    chars[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
}

fn semver_shape(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
}

fn label_ok(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| c.is_control())
}

fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn normalise_separators(value: &str) -> String {
    value.replace('\\', "/")
}

/// The seven ordered checks of spec section 4, as far as a path can be judged
/// without touching the filesystem. `None` means the declared path may not be
/// opened at all.
fn declared_parts(value: &str) -> Option<Vec<String>> {
    let chars = value.chars().count();
    if chars == 0 || chars > MAX_DECLARED_PATH_CHARS {
        return None;
    }
    if value.chars().any(|c| c.is_control()) {
        return None;
    }
    let unified = value.replace('\\', "/");
    // A colon means a drive letter, a `file:` URL or an alternate data stream;
    // a leading slash means a rooted or UNC path.
    if unified.contains(':') || unified.starts_with('/') {
        return None;
    }
    let mut parts = Vec::new();
    for part in unified.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        if part.chars().count() > 255 {
            return None;
        }
        parts.push(part.to_string());
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

fn within_package(root: &Path, target: &Path) -> bool {
    fn key(path: &Path) -> Vec<String> {
        path.components()
            .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    }
    let base = key(root);
    let full = key(target);
    full.len() >= base.len() && full[..base.len()] == base[..]
}

pub fn package_path_under(package_root: &Path, declared: &str) -> Result<PathBuf, Failure> {
    let parts = declared_parts(declared).ok_or_else(|| Failure::escape(declared))?;
    let mut target = package_root.to_path_buf();
    for part in &parts {
        target.push(part);
    }
    if !within_package(package_root, &target) {
        return Err(Failure::escape(declared));
    }
    Ok(target)
}

/// Rejects a symlink or junction anywhere from the package folder down. The
/// check is per component on purpose: canonicalising first and hoping to notice
/// later would resolve a junction to an ordinary-looking path.
pub fn check_reparse_within(package_root: &Path, target: &Path) -> Result<(), Failure> {
    if crate::vups_root::is_reparse_point(package_root) {
        return Err(Failure::link(package_root));
    }
    if !within_package(package_root, target) {
        return Err(Failure::escape(&target.display().to_string()));
    }
    let Ok(rest) = target.strip_prefix(package_root) else {
        return Err(Failure::escape(&target.display().to_string()));
    };
    let mut current = package_root.to_path_buf();
    for part in rest.components() {
        current.push(part.as_os_str());
        if crate::vups_root::is_reparse_point(&current) {
            return Err(Failure::link(&current));
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct Codes {
    missing: &'static str,
    not_text: &'static str,
}

const INSTRUCTIONS_CODES: Codes = Codes {
    missing: "skill_instructions_missing",
    not_text: "skill_instructions_invalid",
};

const REFERENCE_CODES: Codes = Codes {
    missing: "skill_reference_invalid",
    not_text: "skill_reference_invalid",
};

/// Read one text file under the size cap. An over-cap file is refused instead of
/// truncated, because half a procedure is worse than no procedure.
fn read_bounded_text(path: &Path, codes: Codes) -> Result<(String, u64), Failure> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        Failure::new(
            codes.missing,
            format!("`{}` is declared by the manifest but is not in the package.", name_of(path)),
        )
    })?;
    if !metadata.is_file() {
        return Err(Failure::new(
            codes.missing,
            format!("`{}` is not a regular file.", name_of(path)),
        ));
    }
    if metadata.len() > MAX_SKILL_READ_BYTES {
        return Err(Failure::new(
            "skill_file_too_large",
            format!(
                "`{}` is {} bytes and VupsRouter reads at most {MAX_SKILL_READ_BYTES} for one \
                 skill file. Nothing was loaded.",
                name_of(path),
                metadata.len()
            ),
        ));
    }
    let bytes = fs::read(path).map_err(|error| Failure::io("The skill text", path, &error))?;
    let text = String::from_utf8(bytes).map_err(|_| {
        Failure::new(
            codes.not_text,
            format!(
                "`{}` is not UTF-8 text, so VupsRouter cannot read it and will not guess at it.",
                name_of(path)
            ),
        )
    })?;
    Ok((text, metadata.len()))
}

pub fn validate_manifest(value: &Value, _folder_name: &str) -> Result<SkillManifest, Failure> {
    let Some(map) = value.as_object() else {
        return Err(Failure::new(
            "skill_manifest_invalid",
            format!("{MANIFEST_FILE} must hold one JSON object."),
        ));
    };
    // The folder name is deliberately not compared with `id`: a folder the user
    // copied in by hand keeps its own name and is still the skill its manifest
    // says it is (spec section 8).
    let manifest_version = map.get("manifestVersion").and_then(Value::as_u64);
    if manifest_version != Some(MANIFEST_VERSION as u64) {
        return Err(Failure::new(
            "skill_version_unsupported",
            format!(
                "This package declares skill manifest version {}; this build reads version \
                 {MANIFEST_VERSION} only.",
                manifest_version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ),
        ));
    }
    let id = map.get("id").and_then(Value::as_str).unwrap_or_default();
    if !is_safe_id(id) {
        return Err(Failure::new(
            "skill_id_invalid",
            format!(
                "The manifest needs an `id` of up to {MAX_ID_CHARS} lowercase letters, digits, \
                 dots, dashes or underscores. It is used as a folder name, so it cannot hold a \
                 path separator."
            ),
        ));
    }
    let name = map.get("name").and_then(Value::as_str).unwrap_or_default();
    if !label_ok(name, 120) {
        return Err(Failure::new(
            "skill_name_invalid",
            "The manifest needs a `name` of 1-120 characters with no control characters.",
        ));
    }
    let description = map
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !label_ok(description, 500) {
        return Err(Failure::new(
            "skill_description_invalid",
            "The manifest needs a `description` of 1-500 characters; it is how a model decides \
             whether the skill is relevant.",
        ));
    }
    let version = map.get("version").and_then(Value::as_str).unwrap_or_default();
    if !semver_shape(version) {
        return Err(Failure::new(
            "skill_semver_invalid",
            format!(
                "`version` must be three dot-separated numbers so a conflict can be decided; \
                 this package says `{}`.",
                clip(version, 60)
            ),
        ));
    }
    let author = match map.get("author") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) if label_ok(text, 120) => text.clone(),
        _ => {
            return Err(Failure::new(
                "skill_author_invalid",
                "When present, `author` must be text of at most 120 characters.",
            ))
        }
    };
    let instructions = map
        .get("instructions")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if declared_parts(instructions).is_none() {
        return Err(Failure::new(
            "skill_instructions_invalid",
            "The manifest needs `instructions`: a relative path inside the package naming the \
             entry instruction file.",
        ));
    }
    let mut permissions: Vec<String> = Vec::new();
    match map.get("permissions") {
        None => {
            return Err(Failure::new(
                "skill_permissions_invalid",
                "The manifest must declare `permissions`. An empty array is allowed and honest; \
                 no list at all is not.",
            ))
        }
        Some(Value::Array(list)) => {
            for entry in list {
                let Some(word) = entry.as_str() else {
                    return Err(Failure::new(
                        "skill_permissions_invalid",
                        "`permissions` must hold only strings.",
                    ));
                };
                if !PERMISSION_VOCABULARY.contains(&word) {
                    return Err(Failure::new(
                        "skill_permission_unknown",
                        format!(
                            "`{word}` is not a permission this app can honour. The list is: {}.",
                            PERMISSION_VOCABULARY.join(", ")
                        ),
                    ));
                }
                if !permissions.iter().any(|seen| seen == word) {
                    permissions.push(word.to_string());
                }
            }
        }
        _ => {
            return Err(Failure::new(
                "skill_permissions_invalid",
                "`permissions` must be an array of permission names.",
            ))
        }
    }
    let mut capabilities: Vec<String> = Vec::new();
    match map.get("capabilities") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for entry in list {
                let Some(text) = entry.as_str() else {
                    return Err(Failure::new(
                        "skill_capabilities_invalid",
                        "`capabilities` must hold only strings.",
                    ));
                };
                if text.is_empty() || text.chars().count() > 60 || text.chars().any(|c| c.is_control())
                {
                    return Err(Failure::new(
                        "skill_capabilities_invalid",
                        "Each capability is 1-60 characters of text.",
                    ));
                }
                capabilities.push(text.to_string());
            }
        }
        _ => {
            return Err(Failure::new(
                "skill_capabilities_invalid",
                "`capabilities` must be an array of strings.",
            ))
        }
    }
    let mut references: Vec<SkillReference> = Vec::new();
    match map.get("references") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.len() > MAX_REFERENCES {
                return Err(Failure::new(
                    "skill_reference_invalid",
                    format!("A package may declare at most {MAX_REFERENCES} reference files."),
                ));
            }
            for entry in list {
                let Some(object) = entry.as_object() else {
                    return Err(Failure::new(
                        "skill_reference_invalid",
                        "Each reference needs an object with a `path`.",
                    ));
                };
                let path = object.get("path").and_then(Value::as_str).unwrap_or_default();
                if declared_parts(path).is_none() {
                    return Err(Failure::new(
                        "skill_reference_invalid",
                        format!(
                            "The reference path `{}` is not a plain relative path inside the \
                             package.",
                            clip(path, 120)
                        ),
                    ));
                }
                let description = object
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if description.chars().any(|c| c.is_control()) {
                    return Err(Failure::new(
                        "skill_reference_invalid",
                        "A reference description cannot hold control characters.",
                    ));
                }
                references.push(SkillReference {
                    path: normalise_separators(path),
                    description: clip(description, 200),
                });
            }
        }
        _ => {
            return Err(Failure::new(
                "skill_reference_invalid",
                "`references` must be an array of objects with a `path`.",
            ))
        }
    }
    let mut integrity: Option<Integrity> = None;
    match map.get("integrity") {
        None | Some(Value::Null) => {}
        Some(Value::Object(object)) => {
            let algorithm = object
                .get("algorithm")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if algorithm != "sha256" {
                return Err(Failure::new(
                    "skill_integrity_invalid",
                    format!(
                        "`integrity.algorithm` must be \"sha256\"; this package says `{}`. \
                         VupsRouter does not fall back to another hash.",
                        clip(algorithm, 40)
                    ),
                ));
            }
            let mut files: Vec<IntegrityEntry> = Vec::new();
            match object.get("files") {
                Some(Value::Object(entries)) => {
                    for (key, digest) in entries {
                        let path = normalise_separators(key);
                        if declared_parts(&path).is_none() {
                            return Err(Failure::new(
                                "skill_integrity_invalid",
                                format!(
                                    "The integrity block hashes `{}`, which is not a path inside \
                                     the package.",
                                    clip(key, 120)
                                ),
                            ));
                        }
                        let Some(text) = digest.as_str() else {
                            return Err(Failure::new(
                                "skill_integrity_invalid",
                                "Each integrity digest must be a string.",
                            ));
                        };
                        if !hex64(text) {
                            return Err(Failure::new(
                                "skill_integrity_invalid",
                                format!(
                                    "The integrity digest for `{path}` is not 64 lowercase hex \
                                     characters."
                                ),
                            ));
                        }
                        files.push(IntegrityEntry { path, sha256: text.to_string() });
                    }
                }
                _ => {
                    return Err(Failure::new(
                        "skill_integrity_invalid",
                        "`integrity.files` must be an object of package path to sha256 digest.",
                    ))
                }
            }
            files.sort_by(|first, second| first.path.cmp(&second.path));
            integrity = Some(Integrity { algorithm: "sha256".to_string(), files });
        }
        _ => {
            return Err(Failure::new(
                "skill_integrity_invalid",
                "`integrity` must be an object with `algorithm` and `files`.",
            ))
        }
    }
    Ok(SkillManifest {
        manifest_version: MANIFEST_VERSION,
        id: id.to_string(),
        name: name.to_string(),
        version: version.to_string(),
        description: description.to_string(),
        author,
        instructions: normalise_separators(instructions),
        permissions,
        capabilities,
        references,
        integrity,
    })
}

fn read_manifest_value(package_root: &Path) -> Result<Value, Failure> {
    if crate::vups_root::is_reparse_point(package_root) {
        return Err(Failure::link(package_root));
    }
    let path = package_root.join(MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&path).map_err(|_| {
        Failure::new(
            "skill_manifest_missing",
            format!(
                "There is no {MANIFEST_FILE} in `{}`, so this folder is not a skill package.",
                name_of(package_root)
            ),
        )
    })?;
    if !metadata.is_file() {
        return Err(Failure::new(
            "skill_manifest_missing",
            format!("{MANIFEST_FILE} is not a regular file."),
        ));
    }
    if crate::vups_root::is_reparse_point(&path) {
        return Err(Failure::link(&path));
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(Failure::new(
            "skill_file_too_large",
            format!(
                "{MANIFEST_FILE} is {} bytes and the manifest limit is {MAX_MANIFEST_BYTES}.",
                metadata.len()
            ),
        ));
    }
    let bytes = fs::read(&path).map_err(|error| Failure::io("The manifest", &path, &error))?;
    serde_json::from_slice(&bytes).map_err(|error| {
        Failure::new(
            "skill_manifest_invalid",
            format!("{MANIFEST_FILE} is not valid JSON: {error}"),
        )
    })
}

pub fn read_manifest(package_root: &Path) -> Result<SkillManifest, Failure> {
    let value = read_manifest_value(package_root)?;
    let folder_name = package_root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    validate_manifest(&value, &folder_name)
}

pub fn verify_integrity(
    package_root: &Path,
    manifest: &SkillManifest,
) -> Result<String, Failure> {
    let Some(integrity) = &manifest.integrity else {
        return Ok("not declared".to_string());
    };
    let mut declared: Vec<&str> = vec![manifest.instructions.as_str()];
    declared.extend(manifest.references.iter().map(|entry| entry.path.as_str()));
    for entry in &integrity.files {
        if !declared.contains(&entry.path.as_str()) {
            return Err(Failure::new(
                "skill_integrity_invalid",
                format!(
                    "The integrity block hashes `{}`, which the manifest never declares as a \
                     skill file.",
                    clip(&entry.path, 120)
                ),
            ));
        }
        let target = package_path_under(package_root, &entry.path)?;
        check_reparse_within(package_root, &target)?;
        let (text, _) = read_bounded_text(&target, REFERENCE_CODES)?;
        let actual = sha256_hex(text.as_bytes());
        if !actual.eq_ignore_ascii_case(&entry.sha256) {
            return Err(Failure::new(
                "skill_integrity_mismatch",
                format!(
                    "`{}` no longer matches the digest the package published (expected {}, \
                     found {}). Nothing was loaded.",
                    entry.path,
                    &entry.sha256[..12.min(entry.sha256.len())],
                    &actual[..12]
                ),
            ));
        }
    }
    Ok("verified".to_string())
}

/// Read a package exactly as it is on disk right now. There is no cache: a load
/// that returned prose from the last run would report a file nobody read.
fn read_package(package_root: &Path) -> Result<LoadedSkill, Failure> {
    check_reparse_within(package_root, package_root)?;
    let manifest = read_manifest(package_root)?;
    let integrity = verify_integrity(package_root, &manifest)?;
    let instructions = package_path_under(package_root, &manifest.instructions)?;
    check_reparse_within(package_root, &instructions)?;
    let (text, bytes) = read_bounded_text(&instructions, INSTRUCTIONS_CODES)?;
    let mut references: Vec<String> = Vec::new();
    for entry in &manifest.references {
        let path = package_path_under(package_root, &entry.path)?;
        check_reparse_within(package_root, &path)?;
        read_bounded_text(&path, REFERENCE_CODES)?;
        references.push(entry.path.clone());
    }
    Ok(LoadedSkill {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        author: manifest.author.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        path: package_root.display().to_string(),
        instructions_path: manifest.instructions.clone(),
        instructions: text,
        bytes,
        integrity,
        permissions: manifest.permissions.clone(),
        capabilities: manifest.capabilities.clone(),
        references,
    })
}

pub fn load_package(package_root: &Path, enabled: bool) -> Result<LoadedSkill, Failure> {
    if !enabled {
        return Err(Failure::new(
            "skill_disabled",
            format!(
                "The skill `{}` is switched off in Settings, so its instructions were not loaded.",
                name_of(package_root)
            ),
        ));
    }
    read_package(package_root)
}

pub fn load_reference(
    package_root: &Path,
    manifest: &SkillManifest,
    declared: &str,
) -> Result<String, Failure> {
    let normalised = normalise_separators(declared);
    let target = package_path_under(package_root, &normalised)?;
    check_reparse_within(package_root, &target)?;
    if !manifest.references.iter().any(|entry| entry.path == normalised) {
        return Err(Failure::new(
            "skill_reference_invalid",
            format!(
                "`{}` is not declared in this package's manifest, so VupsRouter will not read it.",
                clip(&normalised, 120)
            ),
        ));
    }
    let (text, _) = read_bounded_text(&target, REFERENCE_CODES)?;
    Ok(text)
}

fn is_disabled(state: &State, id: &str) -> bool {
    state.disabled.iter().any(|entry| entry == id)
}

fn package_dirs(skills_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(skills_root) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with(STAGING_PREFIX) {
            continue;
        }
        let path = entry.path();
        let looks_like_folder = entry
            .file_type()
            .map(|kind| kind.is_dir() || kind.is_symlink())
            .unwrap_or(false)
            || path.is_dir();
        if looks_like_folder {
            out.push(path);
        }
    }
    out.sort_by_key(|path| {
        path.file_name()
            .map(|value| value.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    out
}

fn install_of<'a>(state: &'a State, id: &str) -> Option<&'a InstallRecord> {
    state.installs.iter().find(|entry| entry.id == id)
}

fn ready_record(dir: &Path, loaded: &LoadedSkill, state: &State) -> SkillRecord {
    let install = install_of(state, &loaded.id);
    SkillRecord {
        id: loaded.id.clone(),
        name: loaded.name.clone(),
        version: loaded.version.clone(),
        description: loaded.description.clone(),
        author: loaded.author.clone(),
        path: dir.display().to_string(),
        status: "ready".to_string(),
        enabled: !is_disabled(state, &loaded.id),
        error_code: String::new(),
        errors: Vec::new(),
        permissions: loaded.permissions.clone(),
        capabilities: loaded.capabilities.clone(),
        references: loaded.references.clone(),
        instructions_path: loaded.instructions_path.clone(),
        bytes: loaded.bytes,
        integrity: loaded.integrity.clone(),
        installed_at: install.map(|entry| entry.installed_at),
        source_kind: install
            .map(|entry| entry.source_kind.clone())
            .unwrap_or_else(|| "discovered".to_string()),
    }
}

fn invalid_record(dir: &Path, error: &Failure, state: &State) -> SkillRecord {
    let folder_name = name_of(dir);
    // Show what the manifest can still say, because a folder the user made by
    // hand is easier to fix when it is named.
    let manifest = read_manifest(dir).ok();
    let id = manifest
        .as_ref()
        .map(|value| value.id.clone())
        .unwrap_or_else(|| folder_name.clone());
    SkillRecord {
        name: manifest
            .as_ref()
            .map(|value| value.name.clone())
            .unwrap_or_else(|| folder_name.clone()),
        version: manifest
            .as_ref()
            .map(|value| value.version.clone())
            .unwrap_or_default(),
        description: manifest
            .as_ref()
            .map(|value| value.description.clone())
            .unwrap_or_default(),
        author: manifest.as_ref().map(|value| value.author.clone()).unwrap_or_default(),
        id,
        path: dir.display().to_string(),
        status: "invalid".to_string(),
        enabled: false,
        error_code: error.code.clone(),
        errors: vec![error.message.clone()],
        permissions: manifest
            .as_ref()
            .map(|value| value.permissions.clone())
            .unwrap_or_default(),
        capabilities: Vec::new(),
        references: Vec::new(),
        instructions_path: manifest
            .as_ref()
            .map(|value| value.instructions.clone())
            .unwrap_or_default(),
        bytes: 0,
        integrity: "not checked".to_string(),
        installed_at: install_of(state, &name_of(dir)).map(|entry| entry.installed_at),
        source_kind: install_of(state, &folder_name)
            .map(|entry| entry.source_kind.clone())
            .unwrap_or_else(|| "discovered".to_string()),
    }
}

fn summary_of(at: i64, folders: usize, ready: usize, invalid: usize, disabled: usize) -> ScanSummary {
    let note = if folders == 0 {
        "No skill package folders are in the Skills folder.".to_string()
    } else if invalid == 0 && disabled == 0 {
        format!(
            "All {folders} package {n} read as usable skills.",
            n = if folders == 1 { "folder" } else { "folders" }
        )
    } else {
        format!(
            "{ready} of {folders} package folders read as valid skills; {invalid} could not be \
             loaded and {disabled} are switched off."
        )
    };
    ScanSummary { at, folders, ready, invalid, disabled, note }
}

pub fn scan_directory(skills_root: &Path, state: &State) -> Result<ScanResult, Failure> {
    if skills_root.exists() && !skills_root.is_dir() {
        return Err(Failure::new(
            "skill_root_unavailable",
            format!(
                "{} is a file, so it cannot hold skill packages.",
                skills_root.display()
            ),
        ));
    }
    let mut records: Vec<SkillRecord> = Vec::new();
    for dir in package_dirs(skills_root) {
        match read_package(&dir) {
            Ok(loaded) => records.push(ready_record(&dir, &loaded, state)),
            Err(error) => records.push(invalid_record(&dir, &error, state)),
        }
    }
    let mut claims: BTreeMap<String, usize> = BTreeMap::new();
    for record in &records {
        *claims.entry(record.id.clone()).or_default() += 1;
    }
    if !claims.is_empty() {
        for record in &mut records {
            if claims.get(&record.id).copied().unwrap_or(0) > 1 {
                record.status = "conflict".to_string();
                record.error_code = "skill_duplicate_id".to_string();
                record.enabled = !is_disabled(state, &record.id);
                record.errors.push(format!(
                    "More than one folder in this Skills directory claims the id `{}`. VupsRouter \
                     will not load either one until only a single folder carries that id.",
                    record.id
                ));
            }
        }
    }
    let folders = records.len();
    let ready = records.iter().filter(|record| record.status == "ready").count();
    let disabled = records
        .iter()
        .filter(|record| record.status != "invalid" && !record.enabled)
        .count();
    let invalid = folders - ready;
    Ok(ScanResult {
        root: skills_root.display().to_string(),
        scan: summary_of(now_millis(), folders, ready, invalid, disabled),
        skills: records,
    })
}

/// If the stage holds one folder that carries the manifest, that folder is the
/// package. This is what lets a zip of a folder work without asking the user to
/// re-pack it.
fn normalise_stage(stage_root: &Path) -> Result<PathBuf, Failure> {
    if stage_root.join(MANIFEST_FILE).is_file() {
        return Ok(stage_root.to_path_buf());
    }
    let inside = package_dirs(stage_root);
    if inside.len() == 1 && inside[0].join(MANIFEST_FILE).is_file() {
        return Ok(inside[0].clone());
    }
    Err(Failure::new(
        "skill_manifest_missing",
        format!(
            "No {MANIFEST_FILE} was found in the package, or in the single folder inside it.",
        ),
    ))
}

struct Budget {
    files: usize,
    bytes: u64,
}

impl Budget {
    fn file(&mut self, size: u64) -> Result<(), Failure> {
        if self.files >= MAX_ARCHIVE_ENTRIES {
            return Err(Failure::too_large("file count", &MAX_ARCHIVE_ENTRIES.to_string()));
        }
        if size > MAX_ARCHIVE_ENTRY_BYTES {
            return Err(Failure::too_large(
                "per-file size",
                &format!("{MAX_ARCHIVE_ENTRY_BYTES} bytes"),
            ));
        }
        if self.bytes + size > MAX_ARCHIVE_BYTES {
            return Err(Failure::too_large(
                "total unpacked size",
                &format!("{MAX_ARCHIVE_BYTES} bytes"),
            ));
        }
        self.files += 1;
        self.bytes += size;
        Ok(())
    }
}

fn copy_tree(source: &Path, target: &Path, budget: &mut Budget) -> Result<(), Failure> {
    if crate::vups_root::is_reparse_point(source) {
        return Err(Failure::link(source));
    }
    fs::create_dir_all(target)
        .map_err(|error| Failure::io("The staging folder", target, &error))?;
    for entry in fs::read_dir(source).map_err(|error| Failure::io("The package", source, &error))?
    {
        let entry = entry.map_err(|error| Failure::io("The package", source, &error))?;
        let path = entry.path();
        let name = entry.file_name();
        let next = target.join(&name);
        if crate::vups_root::is_reparse_point(&path) {
            return Err(Failure::link(&path));
        }
        if path.is_dir() {
            copy_tree(&path, &next, budget)?;
            continue;
        }
        let size = fs::metadata(&path)
            .map_err(|error| Failure::io("A package file", &path, &error))?
            .len();
        budget.file(size)?;
        fs::copy(&path, &next).map_err(|error| Failure::io("A package file", &path, &error))?;
    }
    Ok(())
}

pub fn stage_folder(source: &Path, stage_root: &Path) -> Result<PathBuf, Failure> {
    if crate::vups_root::is_reparse_point(source) {
        return Err(Failure::link(source));
    }
    if !source.is_dir() {
        return Err(Failure::new(
            "skill_source_missing",
            format!(
                "{} is not a folder, so there is no package to install from it.",
                source.display()
            ),
        ));
    }
    fs::create_dir_all(stage_root)
        .map_err(|error| Failure::io("The staging folder", stage_root, &error))?;
    let copied = stage_root.join("package");
    let mut budget = Budget { files: 0, bytes: 0 };
    let staged = copy_tree(source, &copied, &mut budget).map(|_| copied.clone());
    if staged.is_err() {
        let _ = fs::remove_dir_all(&copied);
        return staged;
    }
    normalise_stage(stage_root)
}

fn entry_is_link(mode: Option<u32>) -> bool {
    mode.map(|value| value & 0o170_000 == 0o120_000).unwrap_or(false)
}

pub fn stage_archive(source: &Path, stage_root: &Path) -> Result<PathBuf, Failure> {
    let file = fs::File::open(source)
        .map_err(|_| Failure::new("skill_source_missing", format!("{} cannot be opened.", source.display())))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        Failure::new(
            "skill_archive_invalid",
            format!("{} is not a readable .zip package: {error}", source.display()),
        )
    })?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(Failure::too_large(
            "entry count",
            &format!("{MAX_ARCHIVE_ENTRIES} entries in one archive"),
        ));
    }
    // Every name and size is judged before a single byte is written, so an
    // escaped entry is refused rather than partially unpacked.
    let mut planned: Vec<(Vec<String>, bool, u64)> = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| Failure::new("skill_archive_invalid", error.to_string()))?;
        let raw_name = entry.name().to_string();
        let is_dir = entry.is_dir();
        if entry_is_link(entry.unix_mode()) {
            return Err(Failure::new(
                "skill_symlink_rejected",
                format!(
                    "The archive entry `{}` is a link. Links are not created during install, so \
                     nothing was unpacked.",
                    clip(&raw_name, 120)
                ),
            ));
        }
        let trimmed = raw_name.replace('\\', "/").trim_end_matches('/').to_string();
        let parts = declared_parts(&trimmed).ok_or_else(|| Failure::escape(&raw_name))?;
        if parts.len() > MAX_ARCHIVE_DEPTH {
            return Err(Failure::too_large(
                "folder depth",
                &format!("{MAX_ARCHIVE_DEPTH} levels"),
            ));
        }
        let size = entry.size();
        if !is_dir && size > MAX_ARCHIVE_ENTRY_BYTES {
            return Err(Failure::too_large(
                "per-file size",
                &format!("{MAX_ARCHIVE_ENTRY_BYTES} bytes"),
            ));
        }
        planned.push((parts, is_dir, size));
    }
    let mut budget = Budget { files: 0, bytes: 0 };
    for (_, is_dir, size) in &planned {
        if !is_dir {
            budget.file(*size)?;
        }
    }
    fs::create_dir_all(stage_root)
        .map_err(|error| Failure::io("The staging folder", stage_root, &error))?;
    for (index, (parts, is_dir, _)) in planned.iter().enumerate() {
        let mut destination = stage_root.to_path_buf();
        for part in parts {
            destination.push(part);
        }
        if !within_package(stage_root, &destination) {
            return Err(Failure::escape(&destination.display().to_string()));
        }
        if *is_dir {
            fs::create_dir_all(&destination)
                .map_err(|error| Failure::io("A package folder", &destination, &error))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| Failure::io("A package folder", parent, &error))?;
        }
        let mut reader = archive
            .by_index(index)
            .map_err(|error| Failure::new("skill_archive_invalid", error.to_string()))?;
        let mut out = fs::File::create(&destination)
            .map_err(|error| Failure::io("A package file", &destination, &error))?;
        let mut written: u64 = 0;
        let mut chunk = [0_u8; 65_536];
        loop {
            let read = reader
                .read(&mut chunk)
                .map_err(|error| Failure::io("A package file", &destination, &error))?;
            if read == 0 {
                break;
            }
            written += read as u64;
            if written > MAX_ARCHIVE_ENTRY_BYTES {
                drop(out);
                let _ = fs::remove_file(&destination);
                return Err(Failure::too_large(
                    "per-file size",
                    &format!("{MAX_ARCHIVE_ENTRY_BYTES} bytes"),
                ));
            }
            out.write_all(&chunk[..read])
                .map_err(|error| Failure::io("A package file", &destination, &error))?;
        }
    }
    normalise_stage(stage_root)
}

pub fn install_staged(
    package_root: &Path,
    skills_root: &Path,
    state: &mut State,
    source_kind: &str,
    overwrite: bool,
) -> Result<SkillRecord, Failure> {
    let loaded = read_package(package_root)?;
    let target = skills_root.join(&loaded.id);
    if !within_package(skills_root, &target) {
        return Err(Failure::new(
            "skill_id_invalid",
            "The package id cannot be used as a folder name inside the Skills directory.",
        ));
    }
    let current = if target.is_dir() { read_manifest(&target).ok() } else { None };
    if let Some(existing) = &current {
        if !overwrite {
            if existing.version == loaded.version {
                return Err(Failure::new(
                    "skill_already_installed",
                    format!(
                        "`{}` version {} is already installed. Choose replace to overwrite it.",
                        loaded.id, loaded.version
                    ),
                ));
            }
            return Err(Failure::new(
                "skill_version_conflict",
                format!(
                    "`{}` is already installed as version {} and this package is version {}. \
                     Choose replace to overwrite it; VupsRouter will not change a version quietly.",
                    loaded.id, existing.version, loaded.version
                ),
            ));
        }
    } else if let Some(record) = install_of(state, &loaded.id) {
        if !overwrite && record.version != loaded.version {
            return Err(Failure::new(
                "skill_version_conflict",
                format!(
                    "`{}` is recorded as version {} and this package is version {}. Choose \
                     replace to overwrite it.",
                    loaded.id, record.version, loaded.version
                ),
            ));
        }
    }
    fs::create_dir_all(skills_root)
        .map_err(|error| Failure::io("The Skills folder", skills_root, &error))?;
    let fresh = skills_root.join(format!("{}new-{}", STAGING_PREFIX, Uuid::new_v4()));
    let mut budget = Budget { files: 0, bytes: 0 };
    if let Err(error) = copy_tree(package_root, &fresh, &mut budget) {
        let _ = fs::remove_dir_all(&fresh);
        return Err(error);
    }
    if let Err(error) = read_package(&fresh) {
        let _ = fs::remove_dir_all(&fresh);
        return Err(error);
    }
    let retired = skills_root.join(format!("{}old-{}", STAGING_PREFIX, Uuid::new_v4()));
    let replaced = target.exists();
    if replaced {
        if let Err(error) = fs::rename(&target, &retired) {
            let _ = fs::remove_dir_all(&fresh);
            return Err(Failure::io("The previous copy could not be set aside", &target, &error));
        }
    }
    if let Err(error) = fs::rename(&fresh, &target) {
        if replaced {
            let _ = fs::rename(&retired, &target);
        }
        let _ = fs::remove_dir_all(&fresh);
        return Err(Failure::io("The package could not be put in place", &target, &error));
    }
    if replaced {
        let _ = fs::remove_dir_all(&retired);
    }
    let landed = read_package(&target)?;
    let installed_at = now_millis();
    state.installs.retain(|entry| entry.id != landed.id);
    state.installs.push(InstallRecord {
        id: landed.id.clone(),
        version: landed.version.clone(),
        installed_at,
        source_kind: source_kind.to_string(),
    });
    Ok(SkillRecord {
        installed_at: Some(installed_at),
        source_kind: source_kind.to_string(),
        ..ready_record(&target, &landed, &*state)
    })
}

/// The folder that actually carries this id. Installed packages live at
/// `Skills\<id>`; a hand-copied folder may be named anything, so a manifest
/// search is the fallback. An unreadable manifest at `Skills\<id>` is returned
/// as-is, because "this folder is broken" is a truer answer than "no such skill".
fn resolve_package_folder(skills_root: &Path, id: &str) -> Result<PathBuf, Failure> {
    if !is_safe_id(id) {
        return Err(Failure::new(
            "skill_id_invalid",
            format!("`{}` is not a skill identifier.", clip(id, 80)),
        ));
    }
    let direct = skills_root.join(id);
    if crate::vups_root::is_reparse_point(&direct) {
        return Err(Failure::link(&direct));
    }
    if direct.is_dir() {
        match read_manifest(&direct) {
            Ok(manifest) if manifest.id == id => return Ok(direct),
            Ok(_) => {}
            Err(_) => return Ok(direct),
        }
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for dir in package_dirs(skills_root) {
        if dir == direct {
            continue;
        }
        if let Ok(manifest) = read_manifest(&dir) {
            if manifest.id == id {
                found.push(dir);
            }
        }
    }
    if found.len() == 1 {
        return Ok(found.remove(0));
    }
    if found.len() > 1 {
        return Err(Failure::new(
            "skill_duplicate_id",
            format!(
                "More than one folder claims the id `{id}`, so VupsRouter will not guess which \
                 one you mean.",
            ),
        ));
    }
    Err(Failure::new(
        "skill_not_installed",
        format!("There is no skill package with the id `{id}` in {}.", skills_root.display()),
    ))
}

pub fn uninstall_package(skills_root: &Path, state: &mut State, id: &str) -> Result<(), Failure> {
    let dir = resolve_package_folder(skills_root, id)?;
    if dir.parent().map(|value| value != skills_root).unwrap_or(true) {
        return Err(Failure::new(
            "skill_path_escape",
            "Only a folder directly inside the Skills directory can be uninstalled.",
        ));
    }
    if crate::vups_root::is_reparse_point(&dir) {
        return Err(Failure::link(&dir));
    }
    if !dir.is_dir() {
        return Err(Failure::new(
            "skill_not_installed",
            format!("`{}` is not a package folder, so nothing was removed.", dir.display()),
        ));
    }
    fs::remove_dir_all(&dir)
        .map_err(|error| Failure::io("The package could not be removed", &dir, &error))?;
    state.installs.retain(|entry| entry.id != id);
    state.disabled.retain(|entry| entry != id);
    Ok(())
}

pub fn read_state(path: &Path) -> State {
    if !path.exists() {
        return State { version: STATE_VERSION, ..State::default() };
    }
    let Ok(bytes) = fs::read(path) else {
        return State { version: STATE_VERSION, corrupted: true, ..State::default() };
    };
    match serde_json::from_slice::<State>(&bytes) {
        Ok(mut state) => {
            if state.version == 0 {
                state.version = STATE_VERSION;
            }
            if state.version > STATE_VERSION {
                // Written by a newer app. Its values are kept rather than
                // dropped, but the UI is told this run could not trust the file.
                state.corrupted = true;
            }
            state
        }
        Err(_) => State { version: STATE_VERSION, corrupted: true, ..State::default() },
    }
}

pub fn write_state(path: &Path, state: &State) -> Result<(), String> {
    let mut payload = state.clone();
    payload.version = STATE_VERSION;
    payload.corrupted = false;
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "The skills settings path has no folder.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!("{}.{}.tmp", STATE_FILE, Uuid::new_v4()));
    fs::write(&temp, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn set_enabled(
    skills_root: &Path,
    state: &mut State,
    id: &str,
    enabled: bool,
) -> Result<SkillRecord, Failure> {
    let dir = resolve_package_folder(skills_root, id)?;
    let key = read_manifest(&dir)
        .map(|manifest| manifest.id)
        .unwrap_or_else(|_| id.to_string());
    if enabled {
        state.disabled.retain(|entry| entry != &key);
    } else if !state.disabled.iter().any(|entry| entry == &key) {
        state.disabled.push(key);
    }
    match read_package(&dir) {
        Ok(loaded) => Ok(ready_record(&dir, &loaded, state)),
        Err(error) => Ok(invalid_record(&dir, &error, state)),
    }
}

pub fn list_for_tool(skills_root: &Path, state: &State) -> Result<Value, Failure> {
    let scan = scan_directory(skills_root, state)?;
    let mut skills: Vec<Value> = Vec::new();
    let mut unavailable: Vec<Value> = Vec::new();
    for record in &scan.skills {
        if record.status == "ready" && record.enabled {
            skills.push(json_index_of(record));
        } else {
            unavailable.push(json!({
                "id": record.id,
                "name": record.name,
                "status": if record.status == "ready" { "disabled" } else { record.status.as_str() },
                "errorCode": record.error_code,
                "permissions": record.permissions,
            }));
        }
    }
    Ok(Value::Object({
        let mut map = Map::new();
        map.insert("count".to_string(), json!(skills.len()));
        map.insert("skills".to_string(), json!(skills));
        map.insert("unavailable".to_string(), json!(unavailable));
        map.insert("note".to_string(), json!(scan.scan.note));
        map
    }))
}

/// The chooser's view of a skill: enough to decide relevance, and never the
/// instruction body, which is only ever returned by `use_skill`.
fn json_index_of(record: &SkillRecord) -> Value {
    Value::Object({
        let mut map = Map::new();
        map.insert("id".to_string(), json!(record.id));
        map.insert("name".to_string(), json!(record.name));
        map.insert("version".to_string(), json!(record.version));
        map.insert("description".to_string(), json!(record.description));
        map.insert("permissions".to_string(), json!(record.permissions));
        map.insert("capabilities".to_string(), json!(record.capabilities));
        map.insert("references".to_string(), json!(record.references));
        map.insert("integrity".to_string(), json!(record.integrity));
        map
    })
}

pub fn use_skill(skills_root: &Path, state: &State, id: &str) -> Result<Value, Failure> {
    let dir = resolve_package_folder(skills_root, id)?;
    let loaded = load_package(&dir, !is_disabled(state, id))?;
    serde_json::to_value(loaded).map_err(|error| Failure::new("skill_io", error.to_string()))
}

pub fn read_skill_reference(
    skills_root: &Path,
    state: &State,
    id: &str,
    declared: &str,
) -> Result<Value, Failure> {
    let dir = resolve_package_folder(skills_root, id)?;
    if is_disabled(state, id) {
        return Err(Failure::new(
            "skill_disabled",
            format!("The skill `{id}` is switched off in Settings, so nothing was read."),
        ));
    }
    let manifest = read_manifest(&dir)?;
    let text = load_reference(&dir, &manifest, declared)?;
    Ok(Value::Object({
        let mut map = Map::new();
        map.insert("id".to_string(), json!(manifest.id));
        map.insert("name".to_string(), json!(manifest.name));
        map.insert("reference".to_string(), json!(normalise_separators(declared)));
        map.insert("text".to_string(), json!(text));
        map.insert("bytes".to_string(), json!(text.len() as u64));
        map.insert("packagePath".to_string(), json!(dir.display().to_string()));
        map
    }))
}

/// The declared permissions of one id, for the approval card. Reading them is a
/// manifest read inside the Skills folder and grants nothing by itself.
pub fn declared_permissions(skills_root: &Path, id: &str) -> Vec<String> {
    let Ok(dir) = resolve_package_folder(skills_root, id) else { return Vec::new() };
    match read_manifest(&dir) {
        Ok(manifest) => manifest.permissions,
        Err(_) => Vec::new(),
    }
}

pub fn skills_root() -> Result<PathBuf, Failure> {
    let documents = crate::vups_root::documents_directory()
        .map_err(|error| Failure::new("skill_root_unavailable", error))?;
    let root = crate::vups_root::vups_root_in(&documents).join(SKILLS_SUBDIR);
    if crate::vups_root::is_reparse_point(&root) {
        return Err(Failure::link(&root));
    }
    if !root.is_dir() {
        fs::create_dir_all(&root)
            .map_err(|error| Failure::io("The Skills folder", &root, &error))?;
    }
    Ok(root)
}

/// Remembered once from the real app-data directory so the tool engine, which
/// runs without an `AppHandle`, never has to guess where its own record is.
static STATE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn configure(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = STATE_DIR.set(dir);
    }
}

fn state_store() -> Result<PathBuf, Failure> {
    STATE_DIR
        .get()
        .map(|dir| dir.join(STATE_FILE))
        .ok_or_else(|| {
            Failure::new(
                "skill_state_unavailable",
                "VupsRouter has not set up its skills settings folder yet.",
            )
        })
}

fn state_now() -> Result<State, Failure> {
    Ok(read_state(&state_store()?))
}

// ---- model-facing tools, called by the desktop tool engine ----

pub fn tool_list() -> Result<Value, Failure> {
    list_for_tool(&skills_root()?, &state_now()?)
}

pub fn tool_use(id: &str) -> Result<Value, Failure> {
    use_skill(&skills_root()?, &state_now()?, id)
}

pub fn tool_reference(id: &str, path: &str) -> Result<Value, Failure> {
    read_skill_reference(&skills_root()?, &state_now()?, id, path)
}

// ---- Settings commands ----

fn status_with(persist: bool, action: Option<ActionResult>, mut state: State) -> Result<SkillsStatus, Failure> {
    let root = skills_root()?;
    let store = state_store()?;
    let scan = scan_directory(&root, &state)?;
    let last_scan = state.last_scan.clone();
    if persist {
        state.last_scan = Some(scan.scan.clone());
        write_state(&store, &state).map_err(|error| {
            Failure::new(
                "skill_state_unwritable",
                format!("The scan is shown, but VupsRouter could not record it: {error}"),
            )
        })?;
    }
    Ok(SkillsStatus {
        root_path: root.display().to_string(),
        state_path: store.display().to_string(),
        manifest_version: MANIFEST_VERSION,
        skills: scan.skills,
        scan: scan.scan,
        last_scan,
        state_corrupted: state.corrupted,
        action,
        note: format!(
            "Skills are read from this folder only. VupsRouter never downloads a catalog and \
             never runs a file from a package.",
        ),
    })
}

#[tauri::command]
pub async fn skills_status(app: AppHandle) -> Result<SkillsStatus, Failure> {
    configure(&app);
    let state = state_now()?;
    status_with(false, None, state)
}

/// Re-reads and re-validates the folder and records the summary. It changes no
/// package: a rescan that rewrote anyone's files would not be a scan.
#[tauri::command]
pub async fn skills_scan(app: AppHandle) -> Result<SkillsStatus, Failure> {
    configure(&app);
    let state = state_now()?;
    status_with(true, None, state)
}

/// `source` is an absolute local path to a package folder or to a `.zip`. The
/// package is staged and validated first, so a rejected package never reaches
/// the Skills folder and never replaces a working one.
#[tauri::command]
pub async fn skills_install(
    app: AppHandle,
    source: String,
    overwrite: Option<bool>,
) -> Result<SkillsStatus, Failure> {
    configure(&app);
    let source = PathBuf::from(source.trim().trim_matches('"'));
    if source.as_os_str().is_empty() {
        return Err(Failure::new(
            "skill_source_missing",
            "Choose a skill package folder or a .zip file first.",
        ));
    }
    let stage_parent = std::env::temp_dir().join(format!("vupsrouter-skill-install-{}", Uuid::new_v4()));
    fs::create_dir_all(&stage_parent)
        .map_err(|error| Failure::io("The staging folder", &stage_parent, &error))?;
    let is_folder = source.is_dir();
    let staged = if is_folder {
        stage_folder(&source, &stage_parent)
    } else {
        stage_archive(&source, &stage_parent)
    };
    let staged = match staged {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage_parent);
            return Err(error);
        }
    };
    let result = (|| -> Result<SkillRecord, Failure> {
        let root = skills_root()?;
        let store = state_store()?;
        let mut state = read_state(&store);
        let kind = if is_folder { "folder" } else { "archive" };
        let record = install_staged(&staged, &root, &mut state, kind, overwrite.unwrap_or(false))?;
        write_state(&store, &state).map_err(|error| {
            Failure::new(
                "skill_state_unwritable",
                format!("The package is installed, but VupsRouter could not record it: {error}"),
            )
        })?;
        Ok(record)
    })();
    let _ = fs::remove_dir_all(&stage_parent);
    let record = result?;
    let message = format!(
        "Installed {} version {} from {}.",
        record.name,
        record.version,
        if is_folder { "a package folder" } else { "a .zip package" }
    );
    let state = state_now()?;
    status_with(
        true,
        Some(ActionResult { kind: "install".to_string(), message, skill: Some(record) }),
        state,
    )
}

/// Removes exactly one package folder. Sibling skills, files the user put in the
/// Skills folder themselves, and every other package are left untouched.
#[tauri::command]
pub async fn skills_uninstall(app: AppHandle, id: String) -> Result<SkillsStatus, Failure> {
    configure(&app);
    let root = skills_root()?;
    let store = state_store()?;
    let mut state = read_state(&store);
    let id = id.trim().to_string();
    uninstall_package(&root, &mut state, &id)?;
    write_state(&store, &state)
        .map_err(|error| Failure::new("skill_state_unwritable", error))?;
    let state = read_state(&store);
    status_with(
        true,
        Some(ActionResult {
            kind: "uninstall".to_string(),
            message: format!("Removed the skill package `{id}`. Nothing else in the folder changed."),
            skill: None,
        }),
        state,
    )
}

/// The flag is the only thing this writes, and it is only remembered when the
/// state file could actually be written.
#[tauri::command]
pub async fn skills_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<SkillsStatus, Failure> {
    configure(&app);
    let root = skills_root()?;
    let store = state_store()?;
    let mut state = read_state(&store);
    let record = set_enabled(&root, &mut state, id.trim(), enabled)?;
    write_state(&store, &state)
        .map_err(|error| Failure::new("skill_state_unwritable", error))?;
    let state = read_state(&store);
    status_with(
        true,
        Some(ActionResult {
            kind: if enabled { "enable".to_string() } else { "disable".to_string() },
            message: format!(
                "{} {} — its instructions {} loaded again by a chat task.",
                record.name,
                if enabled { "is switched on" } else { "is switched off" },
                if enabled { "will be" } else { "will not be" }
            ),
            skill: Some(record),
        }),
        state,
    )
}

/// Lets Settings hand the user the real Windows picker instead of a text box
/// they have to type a path into.
#[tauri::command]
pub async fn skills_pick_source(archive: bool) -> Result<Option<String>, Failure> {
    if archive {
        let chosen = rfd::AsyncFileDialog::new()
            .set_title("Choose a skill package (.zip)")
            .add_filter("Skill package", &["zip"])
            .pick_file()
            .await;
        Ok(chosen.map(|handle| handle.path().to_string_lossy().to_string()))
    } else {
        let chosen = rfd::AsyncFileDialog::new()
            .set_title("Choose a skill package folder")
            .pick_folder()
            .await;
        Ok(chosen.map(|handle| handle.path().to_string_lossy().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("vupsrouter-skills-{}-{}", label, Uuid::new_v4()));
        fs::create_dir_all(&root).expect("scratch folder");
        root
    }

    fn manifest_value(id: &str, version: &str) -> Value {
        json!({
            "manifestVersion": 1,
            "id": id,
            "name": "Invoice summary",
            "description": "Summarise a stack of invoices into one table.",
            "version": version,
            "author": "QA fixture",
            "instructions": "SKILL.md",
            "permissions": ["read"],
            "capabilities": ["documents"],
            "references": [{ "path": "references/format.md", "description": "The table shape." }],
        })
    }

    /// A complete, valid package on disk, with instruction text distinctive enough
    /// to prove a load read this file and not a template.
    fn write_package(root: &Path, id: &str, version: &str) -> PathBuf {
        let package = root.join(id);
        fs::create_dir_all(package.join("references")).expect("package folders");
        fs::write(package.join(MANIFEST_FILE), serde_json::to_vec_pretty(&manifest_value(id, version)).unwrap())
            .expect("manifest");
        fs::write(
            package.join("SKILL.md"),
            format!("THIRTY-SEVEN MARKERS for {id}: emit one line per invoice, prefixed with QT-37.\n"),
        )
        .expect("instructions");
        fs::write(package.join("references").join("format.md"), "COLUMN ORDER: vendor, date, amount.\n")
            .expect("reference");
        package
    }

    fn state_with(disabled: &[&str]) -> State {
        State {
            version: STATE_VERSION,
            disabled: disabled.iter().map(|value| value.to_string()).collect(),
            installs: Vec::new(),
            last_scan: None,
            corrupted: false,
        }
    }

    // ---- 2.6 valid installation, discovery, and what lands on disk ----

    #[test]
    fn a_valid_package_installs_into_the_skills_folder_and_is_listed() {
        let stage_parent = scratch("install");
        let source = write_package(&stage_parent.join("source"), "invoice-summary", "1.0.0");
        let skills = stage_parent.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        let stage = stage_folder(&source, &stage_parent.join("stage")).expect("stage the folder");
        let mut state = state_with(&[]);
        let record = install_staged(&stage, &skills, &mut state, "folder", false).expect("install");

        assert_eq!(record.id, "invoice-summary");
        assert_eq!(record.status, "ready", "a valid package is not a partial success");
        assert_eq!(record.integrity, "not declared", "no integrity block was claimed");
        assert!(skills.join("invoice-summary").join(MANIFEST_FILE).is_file(), "the package landed");
        assert!(
            source.join(MANIFEST_FILE).is_file(),
            "installing copies a package, it never moves the user's own folder"
        );
        assert_eq!(state.installs.len(), 1, "the install is recorded");
        assert_eq!(state.installs[0].source_kind, "folder");

        let scan = scan_directory(&skills, &state).expect("scan");
        assert_eq!(scan.skills.len(), 1);
        assert_eq!(scan.scan.folders, 1);
        assert_eq!(scan.scan.ready, 1);
        assert_eq!(scan.scan.invalid, 0);

        fs::remove_dir_all(&stage_parent).ok();
    }

    #[test]
    fn a_manually_added_package_is_discovered_without_a_registration_step() {
        let root = scratch("manual");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "hand-made", "2.1.0");

        let state = state_with(&[]);
        let scan = scan_directory(&skills, &state).expect("scan");
        assert_eq!(scan.skills.len(), 1, "a folder the user dropped in is a skill");
        assert_eq!(scan.skills[0].id, "hand-made");
        assert_eq!(scan.skills[0].status, "ready");
        assert!(scan.skills[0].enabled, "discovered is not the same as installed, but it is usable");
        assert!(scan.skills[0].installed_at.is_none(), "the app did not install it, so it does not claim to");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.6 invalid package rejection (malformed manifests) ----

    #[test]
    fn a_package_without_a_manifest_is_invalid_and_says_so() {
        let root = scratch("no-manifest");
        let skills = root.join("Skills");
        fs::create_dir_all(skills.join("blank")).expect("skills root");
        fs::write(skills.join("blank").join("SKILL.md"), "instructions but no manifest\n").expect("text");

        let scan = scan_directory(&skills, &state_with(&[])).expect("scan");
        assert_eq!(scan.skills.len(), 1, "the folder is listed, not hidden");
        assert_eq!(scan.skills[0].status, "invalid");
        assert_eq!(scan.skills[0].error_code, "skill_manifest_missing");
        assert_eq!(scan.scan.invalid, 1);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn malformed_manifests_are_rejected_with_their_own_code() {
        let folder = "invoice-summary";
        let cases: Vec<(&str, Value, &str)> = vec![
            ("unreadable json", json!("not an object"), "skill_manifest_invalid"),
            (
                "a version this app cannot read",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["manifestVersion"] = json!(2);
                    value
                },
                "skill_version_unsupported",
            ),
            (
                "an id that is not a lowercase token",
                manifest_value("Invoice-Summary", "1.0.0"),
                "skill_id_invalid",
            ),
            (
                "an id that starts with a separator",
                manifest_value("-invoice", "1.0.0"),
                "skill_id_invalid",
            ),
            (
                "an id that could escape if it were a path",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["id"] = json!("..\\Windows");
                    value
                },
                "skill_id_invalid",
            ),
            (
                "a version that is not three numbers",
                manifest_value(folder, "latest"),
                "skill_semver_invalid",
            ),
            (
                "no description",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["description"] = json!("");
                    value
                },
                "skill_description_invalid",
            ),
            (
                "instructions that are not a path",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["instructions"] = json!(null);
                    value
                },
                "skill_instructions_invalid",
            ),
            (
                "a permission the engine does not have",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["permissions"] = json!(["everything"]);
                    value
                },
                "skill_permission_unknown",
            ),
            (
                "no permissions list at all",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value.as_object_mut().unwrap().remove("permissions");
                    value
                },
                "skill_permissions_invalid",
            ),
            (
                "an integrity block naming a hash this app does not do",
                {
                    let mut value = manifest_value(folder, "1.0.0");
                    value["integrity"] = json!({ "algorithm": "md5", "files": { "SKILL.md": "d41d8cd98f00b204e9800998ecf8427e" } });
                    value
                },
                "skill_integrity_invalid",
            ),
        ];

        for (label, value, expected) in cases {
            let error = validate_manifest(&value, folder).expect_err(&format!("{label} must be rejected"));
            assert_eq!(error.code, expected, "{label} reported {expected}");
        }
    }

    #[test]
    fn unknown_extra_fields_do_not_break_a_valid_manifest() {
        let mut value = manifest_value("invoice-summary", "1.0.0");
        value["homepage"] = json!("https://example.invalid");
        let manifest = validate_manifest(&value, "invoice-summary").expect("extra metadata is not malformed");
        assert_eq!(manifest.id, "invoice-summary");
        assert_eq!(manifest.instructions, "SKILL.md");
    }

    // ---- 2.2 traversal and symlink escape ----

    #[test]
    fn declared_paths_that_escape_the_package_are_rejected_before_reading() {
        let root = scratch("traversal");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let cases: Vec<(&str, &str)> = vec![
            ("parent walk", "../SKILL.md"),
            ("deep parent walk", "references/../../secrets.md"),
            ("absolute drive", "C:\\Windows\\win.ini"),
            ("leading separator", "\\Windows\\win.ini"),
            ("unc share", "\\\\server\\share\\file.md"),
            ("verbatim path", "\\\\?\\C:\\Windows\\win.ini"),
            ("file url", "file:///C:/Windows/win.ini"),
            ("empty", ""),
            ("current directory spelled out", "./../SKILL.md"),
        ];
        for (label, declared) in cases {
            let error = package_path_under(&package, declared)
                .expect_err(&format!("{label} must not resolve"));
            assert_eq!(error.code, "skill_path_escape", "{label} reported {error:?}");
        }
        let good = package_path_under(&package, "references/format.md").expect("a plain relative path");
        assert!(good.ends_with("format.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn backslashes_are_accepted_and_normalised() {
        let root = scratch("separators");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let forward = package_path_under(&package, "references/format.md").expect("forward");
        let backward = package_path_under(&package, r"references\format.md").expect("backslash");
        assert_eq!(forward, backward, "one file must not read as two paths");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_junction_inside_a_package_is_not_read() {
        let root = scratch("junction");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).expect("outside folder");
        fs::write(outside.join("stolen.md"), "SECRET TEXT THAT MUST NOT LEAK\n").expect("outside file");

        // Real Windows junction (an reparse point a plain user can create without
        // developer mode), created only when the OS allows it.
        let link = package.join("references").join("link.md");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.as_os_str())
            .arg(outside.as_os_str())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !made.map(|status| status.success()).unwrap_or(false) {
            eprintln!("junction could not be created on this machine; test recorded as skipped");
            fs::remove_dir_all(&root).ok();
            return;
        }

        let manifest = read_manifest(&package).expect("manifest");
        let error = load_reference(&package, &manifest, "references/link.md")
            .expect_err("a junction must not be followed");
        assert_eq!(error.code, "skill_symlink_rejected");
        assert!(
            !error.message.contains("SECRET TEXT"),
            "the rejection never echoes the file it refused"
        );

        // And as the declared entry file, which is the more dangerous shape.
        let mut escaped = manifest_value("invoice-summary", "1.0.0");
        escaped["instructions"] = json!("references/link.md");
        fs::write(package.join(MANIFEST_FILE), serde_json::to_vec_pretty(&escaped).unwrap()).expect("manifest");
        let error = load_package(&package, true).expect_err("a junction instruction file is refused");
        assert_eq!(error.code, "skill_symlink_rejected");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_junction_for_the_package_folder_itself_is_not_read() {
        let root = scratch("junction-root");
        let outside = root.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        write_package(&outside, "invoice-summary", "1.0.0");

        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        let link = skills.join("invoice-summary");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.as_os_str())
            .arg(outside.as_os_str())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !made.map(|status| status.success()).unwrap_or(false) {
            eprintln!("junction could not be created on this machine; test recorded as skipped");
            fs::remove_dir_all(&root).ok();
            return;
        }

        let scan = scan_directory(&skills, &state_with(&[])).expect("scan");
        assert_eq!(scan.skills.len(), 1, "the link is visible, not hidden");
        assert_eq!(scan.skills[0].status, "invalid");
        assert_eq!(scan.skills[0].error_code, "skill_symlink_rejected");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.2 duplicate ids and version conflicts ----

    #[test]
    fn the_same_id_installs_once_and_a_second_copy_is_a_visible_conflict() {
        let root = scratch("duplicate");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        let source = write_package(&root.join("source"), "invoice-summary", "1.0.0");
        let mut state = state_with(&[]);
        install_staged(
            &stage_folder(&source, &root.join("stage-a")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            false,
        )
        .expect("first install");

        let again = install_staged(
            &stage_folder(&source, &root.join("stage-b")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            false,
        )
        .expect_err("the same version cannot install twice quietly");
        assert_eq!(again.code, "skill_already_installed");

        let upgraded_source = {
            let package = write_package(&root.join("source2"), "invoice-summary", "1.1.0");
            package
        };
        let conflict = install_staged(
            &stage_folder(&upgraded_source, &root.join("stage-c")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            false,
        )
        .expect_err("a different version needs an explicit decision");
        assert_eq!(conflict.code, "skill_version_conflict");
        assert!(
            conflict.message.contains("1.0.0") && conflict.message.contains("1.1.0"),
            "the message names both versions: {}",
            conflict.message
        );

        let replaced = install_staged(
            &stage_folder(&upgraded_source, &root.join("stage-d")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            true,
        )
        .expect("an explicit overwrite replaces it");
        assert_eq!(replaced.version, "1.1.0");
        assert_eq!(state.installs.len(), 1, "one id is one install record");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn two_folders_claiming_one_id_are_both_reported_and_neither_wins() {
        let root = scratch("id-collision");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");
        let copy = write_package(&skills, "invoice-summary-copy", "1.0.0");
        fs::write(copy.join(MANIFEST_FILE), serde_json::to_vec_pretty(&manifest_value("invoice-summary", "1.0.0")).unwrap())
            .expect("manifest claiming the other folder's id");

        let scan = scan_directory(&skills, &state_with(&[])).expect("scan");
        let conflict_codes: Vec<String> = scan
            .skills
            .iter()
            .filter(|record| record.status != "ready")
            .map(|record| record.error_code.clone())
            .collect();
        assert!(
            conflict_codes.iter().all(|code| code == "skill_duplicate_id") && conflict_codes.len() == 2,
            "both copies of the colliding id are reported: {conflict_codes:?}"
        );
        let ready = scan.skills.iter().filter(|record| record.status == "ready").count();
        assert_eq!(ready, 0, "a colliding id is not silently resolved to one winner");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_failed_install_leaves_the_previous_working_skill_in_place() {
        let root = scratch("failed-overwrite");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        let good = write_package(&root.join("good"), "invoice-summary", "1.0.0");
        let mut state = state_with(&[]);
        install_staged(
            &stage_folder(&good, &root.join("stage-a")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            false,
        )
        .expect("first install");

        let broken = root.join("broken");
        fs::create_dir_all(&broken).expect("broken package");
        fs::write(broken.join(MANIFEST_FILE), b"{ not json").expect("bad manifest");
        let error = install_staged(
            &stage_folder(&broken, &root.join("stage-b")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            true,
        )
        .expect_err("a malformed package cannot overwrite a working one");
        assert_eq!(error.code, "skill_manifest_invalid");
        assert!(
            skills.join("invoice-summary").join(MANIFEST_FILE).is_file(),
            "the working skill is still there"
        );
        let loaded = load_package(&skills.join("invoice-summary"), true).expect("still loads");
        assert_eq!(loaded.version, "1.0.0");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.3 real loading: instructions and references ----

    #[test]
    fn loading_reads_the_real_instruction_file_from_disk() {
        let root = scratch("load");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let loaded = load_package(&package, true).expect("load");
        assert!(loaded.instructions.contains("THIRTY-SEVEN MARKERS"), "the text is the file's own");
        assert!(loaded.instructions.contains("invoice-summary"), "and this package's own, not a template");
        assert_eq!(loaded.bytes as usize, loaded.instructions.chars().count(), "bytes reported, not invented");
        assert!(loaded.instructions_path.ends_with("SKILL.md"));
        assert_eq!(loaded.references, vec!["references/format.md".to_string()]);
        assert_eq!(loaded.integrity, "not declared");

        fs::write(package.join("SKILL.md"), "EDITED AFTER THE FIRST READ\n").expect("edit");
        let second = load_package(&package, true).expect("reload");
        assert!(second.instructions.contains("EDITED AFTER"), "a load re-reads the file, it is not cached prose");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_instruction_file_is_a_real_error_not_an_empty_skill() {
        let root = scratch("missing-instructions");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        fs::remove_file(package.join("SKILL.md")).expect("remove the instructions");
        let error = load_package(&package, true).expect_err("nothing to load");
        assert_eq!(error.code, "skill_instructions_missing");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_oversized_instruction_file_is_refused_rather_than_truncated() {
        let root = scratch("oversized");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let huge = "x".repeat(MAX_SKILL_READ_BYTES as usize + 10);
        fs::write(package.join("SKILL.md"), huge).expect("big file");
        let error = load_package(&package, true).expect_err("over the cap");
        assert_eq!(error.code, "skill_file_too_large");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_declared_reference_loads_and_an_undeclared_one_does_not() {
        let root = scratch("reference");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        fs::write(package.join("references").join("undeclared.md"), "NOT IN THE MANIFEST\n").expect("extra file");

        let text = load_reference(
            &package,
            &read_manifest(&package).expect("manifest"),
            "references/format.md",
        )
        .expect("declared reference");
        assert!(text.contains("COLUMN ORDER"), "the real file content");

        let manifest = read_manifest(&package).expect("manifest");
        let error = load_reference(&package, &manifest, "references/undeclared.md").expect_err("undeclared");
        assert_eq!(error.code, "skill_reference_invalid");
        let error = load_reference(&package, &manifest, "../SKILL.md").expect_err("traversal");
        assert_eq!(error.code, "skill_path_escape");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.1 package integrity ----

    #[test]
    fn integrity_is_verified_when_declared_and_blocks_a_tampered_file() {
        let root = scratch("integrity");
        let package = write_package(&root, "invoice-summary", "1.0.0");
        let digest = sha256_hex(
            &fs::read(package.join("SKILL.md")).expect("instructions"),
        );
        assert_eq!(digest.len(), 64, "a lowercase hex sha256");

        let mut value = manifest_value("invoice-summary", "1.0.0");
        value["integrity"] = json!({ "algorithm": "sha256", "files": { "SKILL.md": digest } });
        fs::write(package.join(MANIFEST_FILE), serde_json::to_vec_pretty(&value).unwrap()).expect("manifest");

        let loaded = load_package(&package, true).expect("a matching digest loads");
        assert_eq!(loaded.integrity, "verified");

        fs::write(package.join("SKILL.md"), "TAMPERED AFTER PUBLISHING\n").expect("tamper");
        let error = load_package(&package, true).expect_err("a changed file must not load");
        assert_eq!(error.code, "skill_integrity_mismatch");
        assert!(error.message.contains("SKILL.md"), "names the file: {}", error.message);

        // A digest that points outside the declared package files is invalid.
        let mut smuggled = manifest_value("invoice-summary", "1.0.0");
        smuggled["integrity"] = json!({ "algorithm": "sha256", "files": { "../../Windows/win.ini": "0".repeat(64) } });
        fs::write(package.join(MANIFEST_FILE), serde_json::to_vec_pretty(&smuggled).unwrap()).expect("manifest");
        let error = load_package(&package, true).expect_err("integrity may not name arbitrary paths");
        assert_eq!(error.code, "skill_integrity_invalid");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.2 enable, disable, uninstall, and preserving unrelated content ----

    #[test]
    fn a_disabled_skill_is_excluded_from_the_tool_list_and_cannot_be_loaded() {
        let root = scratch("disabled");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");
        write_package(&skills, "still-on", "1.0.0");

        let mut state = state_with(&["invoice-summary"]);
        let scan = scan_directory(&skills, &state).expect("scan");
        let off = scan.skills.iter().find(|record| record.id == "invoice-summary").expect("listed");
        assert!(!off.enabled, "the record says what the state file says");
        assert_eq!(off.status, "ready", "disabled is not the same as broken");
        assert_eq!(scan.scan.disabled, 1);

        let listed = list_for_tool(&skills, &state).expect("list");
        let ids: Vec<String> = listed["skills"]
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| entry["id"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(ids, vec!["still-on".to_string()], "a disabled skill is not offered to the model");

        let error = use_skill(&skills, &state, "invoice-summary").expect_err("refused");
        assert_eq!(error.code, "skill_disabled");
        let ok = use_skill(&skills, &state, "still-on").expect("the enabled one still loads");
        assert_eq!(ok["bytes"].as_u64().expect("bytes") > 0, true, "real bytes reported");

        state.disabled.clear();
        let enabled = set_enabled(&skills, &mut state, "invoice-summary", true).expect("enable");
        assert_eq!(enabled.status, "ready");
        assert!(use_skill(&skills, &state, "invoice-summary").is_ok(), "re-enabled and loadable");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn uninstall_removes_one_skill_and_preserves_everything_else() {
        let root = scratch("uninstall");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");
        write_package(&skills, "keep-me", "1.0.0");
        fs::write(skills.join("my-own-notes.txt"), "not a skill\n").expect("user file in Skills");
        fs::create_dir_all(skills.join("half-a-folder")).expect("junk folder");

        let mut state = state_with(&[]);
        let source = write_package(&root.join("source"), "invoice-summary", "1.0.0");
        install_staged(
            &stage_folder(&source, &root.join("stage")).expect("stage"),
            &skills,
            &mut state,
            "folder",
            true,
        )
        .ok();

        uninstall_package(&skills, &mut state, "invoice-summary").expect("uninstall");
        assert!(!skills.join("invoice-summary").exists(), "the package folder is gone");
        assert!(skills.join("keep-me").join(MANIFEST_FILE).is_file(), "a sibling skill survives");
        assert!(skills.join("my-own-notes.txt").is_file(), "an unrelated file survives");
        assert!(skills.join("half-a-folder").is_dir(), "a folder the app did not install survives");
        assert!(state.installs.iter().all(|entry| entry.id != "invoice-summary"), "its record is dropped");

        let missing = uninstall_package(&skills, &mut state, "invoice-summary").expect_err("already gone");
        assert_eq!(missing.code, "skill_not_installed");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn uninstall_refuses_a_target_that_is_not_a_direct_skill_folder() {
        let root = scratch("uninstall-guard");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");
        fs::write(skills.join("notes.txt"), "a file, not a folder\n").expect("file");
        let mut state = state_with(&[]);

        for id in ["..", "invoice-summary\\references", "notes.txt", "no-such-skill"] {
            let error = uninstall_package(&skills, &mut state, id).expect_err("refused");
            assert!(
                ["skill_not_installed", "skill_id_invalid"].contains(&error.code.as_str()),
                "{id} refused with {error:?}"
            );
        }
        assert!(skills.join("invoice-summary").is_dir(), "nothing was deleted");
        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.6 restart persistence ----

    #[test]
    fn state_written_by_one_run_is_read_back_by_the_next() {
        let root = scratch("restart");
        let store = root.join(STATE_FILE);
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");

        let mut state = state_with(&["invoice-summary"]);
        state.installs.push(InstallRecord {
            id: "invoice-summary".to_string(),
            version: "1.0.0".to_string(),
            installed_at: 1_762_400_000_000,
            source_kind: "folder".to_string(),
        });
        state.last_scan = Some(ScanSummary {
            at: 1_762_400_000_001,
            folders: 1,
            ready: 1,
            invalid: 0,
            disabled: 1,
            note: "1 of 1 folders are usable skills".to_string(),
        });
        write_state(&store, &state).expect("write state");

        let read_back = read_state(&store);
        assert_eq!(read_back.version, STATE_VERSION);
        assert_eq!(read_back.disabled, vec!["invoice-summary".to_string()], "disabled survived the restart");
        assert_eq!(read_back.installs.len(), 1, "the install record survived");
        assert_eq!(read_back.installs[0].source_kind, "folder");
        let scan = scan_directory(&skills, &read_back).expect("rescan after restart");
        assert!(!scan.skills[0].enabled, "the flag still applies to the folder on disk");
        assert_eq!(scan.scan.disabled, 1);

        // A damaged file is reported as unusable, not silently accepted as empty.
        fs::write(&store, b"{ truncated").expect("damage the store");
        let damaged = read_state(&store);
        assert!(damaged.corrupted, "the app knows it could not read its own record");

        fs::remove_dir_all(&root).ok();
    }

    // ---- 2.2 install from an archive ----

    #[test]
    fn a_zip_package_installs_and_an_entry_that_escapes_is_refused_before_extraction() {
        let root = scratch("archive");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");

        let build = scratch("archive-source");
        let package = write_package(&build, "invoice-summary", "1.0.0");
        let archive = root.join("invoice-summary.zip");
        write_zip(&archive, &package, false);

        let mut state = state_with(&[]);
        let staged = stage_archive(&archive, &root.join("stage")).expect("unpack");
        let record = install_staged(&staged, &skills, &mut state, "archive", false).expect("install from archive");
        assert_eq!(record.id, "invoice-summary");
        assert_eq!(record.status, "ready");
        assert_eq!(state.installs[0].source_kind, "archive");
        assert!(skills.join("invoice-summary").join("SKILL.md").is_file());
        assert!(!skills.join("invoice-summary.zip").exists(), "the archive itself is not kept in Skills");

        let evil = root.join("evil.zip");
        write_zip(&evil, &package, true);
        let error = stage_archive(&evil, &root.join("stage2")).expect_err("zip-slip must be refused");
        assert_eq!(error.code, "skill_path_escape");
        assert!(
            !root.join("stage2").join("..").join("evil-drop.txt").exists(),
            "nothing was written outside the stage"
        );
        assert!(!root.join("evil-drop.txt").exists(), "the escaped entry never reached the disk");

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&build).ok();
    }

    #[test]
    fn an_oversized_archive_is_refused() {
        let root = scratch("archive-cap");
        let archive = root.join("big.zip");
        let mut entries = Vec::new();
        for index in 0..(MAX_ARCHIVE_ENTRIES + 5) {
            entries.push((format!("folder-{index}/"), Vec::new()));
        }
        entries.push(("skill.json".to_string(), br#"{"manifestVersion":1}"#.to_vec()));
        write_zip_entries(&archive, &entries);

        let error = stage_archive(&archive, &root.join("stage")).expect_err("over the entry cap");
        assert_eq!(error.code, "skill_package_too_large");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_archive_entry_that_is_a_link_is_refused_and_extracts_nothing() {
        let root = scratch("archive-link");
        let build = scratch("archive-link-source");
        let package = write_package(&build, "invoice-summary", "1.0.0");
        let archive = root.join("with-link.zip");
        write_zip_with_link(&archive, &package);

        let error = stage_archive(&archive, &root.join("stage")).expect_err("a link is never unpacked");
        assert_eq!(error.code, "skill_symlink_rejected");
        assert!(
            !root.join("stage").join("skill.json").exists(),
            "the ordinary entries beside the link were not unpacked either"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&build).ok();
    }

    // ---- the tool-facing shapes ----

    #[test]
    fn the_tool_list_carries_the_metadata_a_model_needs_to_choose() {
        let root = scratch("tool-list");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        write_package(&skills, "invoice-summary", "1.0.0");

        let listed = list_for_tool(&skills, &state_with(&[])).expect("list");
        let entry = &listed["skills"].as_array().expect("array")[0];
        assert_eq!(entry["id"], json!("invoice-summary"));
        assert_eq!(entry["name"], json!("Invoice summary"));
        assert_eq!(entry["version"], json!("1.0.0"));
        assert_eq!(entry["permissions"], json!(["read"]));
        assert_eq!(entry["capabilities"], json!(["documents"]));
        assert_eq!(entry["references"], json!(["references/format.md"]));
        assert!(
            entry.get("instructions").is_none(),
            "the index must not ship instruction bodies"
        );
        assert_eq!(listed["count"], json!(1));

        let loaded = use_skill(&skills, &state_with(&[]), "invoice-summary").expect("use");
        assert!(loaded["instructions"].as_str().expect("text").contains("THIRTY-SEVEN MARKERS"));
        assert_eq!(loaded["id"], json!("invoice-summary"));
        assert!(loaded["path"].as_str().expect("path").contains("invoice-summary"), "the real folder");

        let missing = use_skill(&skills, &state_with(&[]), "not-installed").expect_err("unknown id");
        assert_eq!(missing.code, "skill_not_installed");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_invalid_package_is_not_offered_to_the_model_but_is_listed_in_settings() {
        let root = scratch("tool-invalid");
        let skills = root.join("Skills");
        fs::create_dir_all(&skills).expect("skills root");
        let package = write_package(&skills, "invoice-summary", "1.0.0");
        fs::write(package.join(MANIFEST_FILE), b"{ broken").expect("broken manifest");

        let listed = list_for_tool(&skills, &state_with(&[])).expect("list");
        assert_eq!(listed["skills"].as_array().expect("array").len(), 0, "nothing to offer");
        let scan = scan_directory(&skills, &state_with(&[])).expect("scan");
        assert_eq!(scan.skills.len(), 1, "the user still sees the folder they made");
        assert_eq!(scan.skills[0].error_code, "skill_manifest_invalid");

        let error = use_skill(&skills, &state_with(&[]), "invoice-summary").expect_err("cannot pretend");
        assert_eq!(error.code, "skill_manifest_invalid");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_skills_root_is_the_phase_one_layout_folder_and_is_created_from_it() {
        let root = skills_root().expect("the app knows where its own Skills folder is");
        let text = root.to_string_lossy().replace('/', "\\");
        assert!(text.ends_with("\\Skills"), "the folder is the Skills entry of the layout: {text}");
        let parent = text.trim_end_matches("\\Skills");
        assert!(parent.ends_with("\\VupsRouter"), "directly under the app root: {parent}");
        assert!(root.is_dir(), "the bootstrap created it before the window opened");
    }

    // ---- archive fixtures ----

    fn write_zip(target: &Path, package: &Path, with_escaped_entry: bool) {
        let mut entries = Vec::new();
        for (name, bytes) in walk(package, package) {
            entries.push((name, bytes));
        }
        if with_escaped_entry {
            entries.push(("../../evil-drop.txt".to_string(), b"ESCAPED".to_vec()));
        }
        write_zip_entries(target, &entries);
    }

    fn walk(current: &Path, base: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for entry in fs::read_dir(current).expect("read dir") {
            let entry = entry.expect("entry");
            let path = entry.path();
            let relative = path
                .strip_prefix(base)
                .expect("relative")
                .to_string_lossy()
                .replace('\\', "/");
            if path.is_dir() {
                out.extend(walk(&path, base));
            } else {
                out.push((relative, fs::read(&path).expect("read file")));
            }
        }
        out
    }

    fn write_zip_entries(target: &Path, entries: &[(String, Vec<u8>)]) {
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let file = fs::File::create(target).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes) in entries {
            if bytes.is_empty() && name.ends_with('/') {
                writer.add_directory(name, options).expect("directory entry");
            } else {
                writer.start_file(name, options).expect("file entry");
                use std::io::Write;
                writer.write_all(bytes).expect("write");
            }
        }
        writer.finish().expect("finish zip");
    }

    /// The same package plus one entry carrying a link mode. `unix_permissions` masks
    /// the file-type bits away, so the crate's own `add_symlink` is the only way to
    /// produce the shape a third-party archive can arrive with.
    fn write_zip_with_link(target: &Path, package: &Path) {
        use std::io::Write;
        let options = zip::write::SimpleFileOptions::default();
        let file = fs::File::create(target).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes) in walk(package, package) {
            writer.start_file(name, options).expect("file entry");
            writer.write_all(&bytes).expect("write");
        }
        writer
            .add_symlink("outside-link", "C:\\Windows\\win.ini", options)
            .expect("link entry");
        writer.finish().expect("finish zip");
    }
}
