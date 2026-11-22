/**
 * Saving Local AI output into the active Windows project.
 *
 * A local answer that contains whole files is written into the chat's project
 * folder through the same native workspace commands the Files panel uses. The
 * date folder comes from the moment the task was submitted, and the task folder
 * keeps the structure the model produced. Existing files are never replaced:
 * an identical file stays as it is, a different one is reported as a conflict.
 */

import { NATIVE_SHELLS } from "../native/shell.js";
import { suggestProjectName, validateProjectName } from "../desktop/workspaceRequest.js";

export const LOCAL_PROJECT_SAVE_STORAGE_KEY = "vupsrouter.localsave.v1";

const LIMIT = 60;
const READ_BACK_BYTES = 128 * 1024;
const INVALID_FOLDER_CHARS = /[\\/:*?"<>|]/g;
const DOWNLOAD_REQUEST = /\b(download|downloadable|zip|zipped|archive|attachments?)\b/i;

function defaultStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function padded(value) {
  return String(value).padStart(2, "0");
}

function errorText(error) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return "";
}

export function utf8Bytes(text) {
  const value = String(text || "");
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  return unescape(encodeURIComponent(value)).length;
}

/** True only for a request that asks for a downloadable copy. */
export function wantsDownloadDelivery(text) {
  return DOWNLOAD_REQUEST.test(String(text || ""));
}

/** The automatic project save is a Windows-only delivery path. */
export function shouldAutoSaveProjectFiles(nativeShell, files) {
  if (nativeShell !== NATIVE_SHELLS.windows) return false;
  return Array.isArray(files) && files.some(isUsableFile);
}

function isUsableFile(file) {
  return Boolean(file && typeof file.path === "string" && String(file.content || "").trim());
}

export function normalizeProjectPath(path) {
  const parts = String(path || "")
    .split(/[\\/]+/)
    .map(part => part.trim())
    .filter(part => part && part !== ".");
  if (parts.some(part => part === "..")) return "";
  return parts.join("/");
}

function commonRoot(paths) {
  const split = paths.map(path => path.split("/")).filter(parts => parts.length > 0);
  if (!split.length || split.some(parts => parts.length < 2)) return "";
  const head = split[0][0];
  return split.every(parts => parts[0].toLowerCase() === head.toLowerCase()) ? head : "";
}

function cleanFolderName(value) {
  const cleaned = String(value || "")
    .replace(INVALID_FOLDER_CHARS, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 60);
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return validateProjectName(cleaned) ? "" : cleaned;
}

/** `DD-MM-YYYY`, from the local date of the submitted task, not the save time. */
export function saveDateFolder(submittedAt) {
  const parsed = new Date(submittedAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `${padded(date.getDate())}-${padded(date.getMonth() + 1)}-${date.getFullYear()}`;
}

/**
 * The folder inside the date folder. A shared top-level folder in the model's
 * own paths is reused, otherwise the task names it. Whitespace becomes a hyphen
 * so the folder matches the "<Task-Name>" shape the project browser shows.
 */
export function projectFolderFor(task, files) {
  const paths = (Array.isArray(files) ? files : [])
    .filter(isUsableFile)
    .map(file => normalizeProjectPath(file.path))
    .filter(Boolean);
  const root = commonRoot(paths);
  const rootName = root ? cleanFolderName(root) : "";
  if (rootName) return { name: rootName, stripPrefix: root };
  const suggested = cleanFolderName(String(suggestedName(task)).replace(/\s+/g, "-"));
  return { name: suggested || "Project", stripPrefix: "" };
}

// A task sentence normally ends with a period, which would make the last word
// invalid as a folder name; the retry drops trailing sentence dots only.
function suggestedName(task) {
  const direct = suggestProjectName(task);
  if (direct) return direct;
  return suggestProjectName(String(task || "").replace(/[.]+(?=\s|$)/g, " "));
}

/**
 * Every file mapped to `<DD-MM-YYYY>/<Project>/<relative path>`. Nested paths
 * keep their folders, and a common top-level folder is not repeated.
 */
export function buildProjectSavePlan({ task = "", files = [], submittedAt = "" } = {}) {
  const usable = (Array.isArray(files) ? files : [])
    .filter(isUsableFile)
    .map(file => ({ file, relative: normalizeProjectPath(file.path) }))
    .filter(entry => entry.relative);
  const { name, stripPrefix } = projectFolderFor(task, usable.map(entry => entry.file));
  const dateFolder = saveDateFolder(submittedAt);
  const prefix = stripPrefix ? `${stripPrefix}/` : "";
  const seen = new Set();
  const entries = [];
  for (const { file, relative: rawRelative } of usable) {
    const relative = prefix && rawRelative.toLowerCase().startsWith(prefix.toLowerCase())
      ? rawRelative.slice(prefix.length)
      : rawRelative;
    if (!relative) continue;
    const workspacePath = `${dateFolder}/${name}/${relative}`;
    const key = workspacePath.toLowerCase();
    // The same target twice in one answer is one file, not a conflict.
    if (seen.has(key)) continue;
    seen.add(key);
    const content = String(file.content || "");
    entries.push({
      path: relative,
      workspacePath,
      content,
      bytes: utf8Bytes(content)
    });
  }
  return {
    dateFolder,
    projectFolder: name,
    folderPath: `${dateFolder}/${name}`,
    entries
  };
}

export function joinProjectPath(base, relative) {
  const root = String(base || "").replace(/[\\/]+$/, "");
  const tail = String(relative || "");
  if (!root) return tail;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${tail.split("/").join(separator)}`;
}

async function verifyWrite({ bridge, owner, workspaceId, entry, result }) {
  const size = Number(result?.size);
  if (Number.isFinite(size) && size !== entry.bytes) {
    return {
      ok: false,
      message: `Windows saved ${size} bytes but ${entry.bytes} were expected.`
    };
  }
  if (entry.bytes <= READ_BACK_BYTES) {
    try {
      const read = await bridge.readText(owner, workspaceId, entry.workspacePath);
      if (read && read.truncated !== true && String(read.content ?? "") === entry.content) {
        return { ok: true, bytes: Number(read.size ?? entry.bytes), method: "content" };
      }
      return { ok: false, message: "The saved file did not match what was generated." };
    } catch {
      // A file too large for the text reader is still confirmed by its size.
      return {
        ok: true,
        bytes: Number.isFinite(size) ? size : entry.bytes,
        method: "size"
      };
    }
  }
  return {
    ok: true,
    bytes: Number.isFinite(size) ? size : entry.bytes,
    method: "size"
  };
}

async function saveOneFile({ bridge, owner, workspaceId, entry }) {
  try {
    const result = await bridge.createFile(owner, workspaceId, entry.workspacePath, entry.content);
    const verified = await verifyWrite({ bridge, owner, workspaceId, entry, result });
    if (!verified.ok) {
      return { path: entry.path, status: "failed", bytes: entry.bytes, message: verified.message };
    }
    return {
      path: entry.path,
      status: "created",
      bytes: verified.bytes,
      method: verified.method,
      nativePath: String(result?.path || entry.workspacePath)
    };
  } catch (error) {
    const message = errorText(error) || "Windows could not save this file.";
    let existing = null;
    try {
      existing = await bridge.readText(owner, workspaceId, entry.workspacePath);
    } catch {
      return { path: entry.path, status: "failed", bytes: entry.bytes, message };
    }
    if (existing && existing.truncated !== true && String(existing.content ?? "") === entry.content) {
      return {
        path: entry.path,
        status: "unchanged",
        bytes: entry.bytes,
        method: "content",
        nativePath: entry.workspacePath
      };
    }
    return {
      path: entry.path,
      status: "conflict",
      bytes: entry.bytes,
      message: "A different file already exists at this path, so it was left untouched."
    };
  }
}

/**
 * Writes a complete artifact into `<workspace>/<date>/<project>/...` through
 * the caller's native bridge. Never throws: a failed save is a record, because
 * the generated answer is still on screen and must stay retryable.
 */
export async function saveGeneratedFiles({
  bridge,
  owner,
  workspaceId,
  workspacePath = "",
  task = "",
  files = [],
  submittedAt = ""
} = {}) {
  const plan = buildProjectSavePlan({ task, files, submittedAt });
  const base = {
    dateFolder: plan.dateFolder,
    projectFolder: plan.projectFolder,
    folderPath: plan.folderPath,
    workspaceId: String(workspaceId || ""),
    workspacePath: String(workspacePath || ""),
    location: joinProjectPath(workspacePath, plan.folderPath)
  };
  if (plan.entries.length === 0) {
    return { ...base, status: "empty", files: [], error: "" };
  }
  if (!bridge || typeof bridge.createFile !== "function" || typeof bridge.readText !== "function") {
    return {
      ...base,
      status: "failed",
      files: plan.entries.map(entry => ({ path: entry.path, status: "failed", bytes: entry.bytes })),
      error: "The Windows file bridge is unavailable."
    };
  }

  const results = [];
  for (const entry of plan.entries) {
    results.push(await saveOneFile({ bridge, owner, workspaceId, entry }));
  }
  const failed = results.filter(file => file.status === "failed");
  const conflicts = results.filter(file => file.status === "conflict");
  const status = failed.length > 0 ? "failed" : conflicts.length > 0 ? "conflict" : "saved";
  return {
    ...base,
    status,
    files: results.map(({ method, ...file }) => file),
    error: failed[0]?.message || conflicts[0]?.message || ""
  };
}

function publicRecord(record) {
  return {
    taskId: String(record.taskId || record.messageId || ""),
    messageId: String(record.messageId || record.taskId || ""),
    conversationId: String(record.conversationId || ""),
    task: String(record.task || ""),
    submittedAt: String(record.submittedAt || ""),
    dateFolder: String(record.dateFolder || ""),
    projectFolder: String(record.projectFolder || ""),
    folderPath: String(record.folderPath || ""),
    workspaceId: String(record.workspaceId || ""),
    workspacePath: String(record.workspacePath || ""),
    location: String(record.location || ""),
    status: String(record.status || ""),
    error: String(record.error || ""),
    files: Array.isArray(record.files)
      ? record.files.map(file => ({
          path: String(file?.path || ""),
          status: String(file?.status || ""),
          bytes: Number(file?.bytes) || 0,
          ...(file?.message ? { message: String(file.message) } : {})
        }))
      : [],
    at: Number(record.at) || 0
  };
}

export function saveProjectSaveRecord(record, { owner = "", storage = defaultStorage() } = {}) {
  const id = String(record?.messageId || record?.taskId || "").trim();
  if (!id) return false;
  let log;
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_PROJECT_SAVE_STORAGE_KEY) || "null");
    log = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    log = {};
  }
  log[id] = {
    ...publicRecord({ ...record, messageId: id, taskId: record.taskId || id }),
    owner: String(owner || ""),
    at: Number(record.at) || Date.now()
  };
  const kept = Object.entries(log)
    .sort((left, right) => Number(right[1]?.at) - Number(left[1]?.at))
    .slice(0, LIMIT);
  try {
    storage?.setItem(LOCAL_PROJECT_SAVE_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
    return true;
  } catch {
    return false;
  }
}

/** One save record for one message, only for the signed-in account. */
export function readProjectSaveRecord(messageId, owner = "", storage = defaultStorage()) {
  const id = String(messageId || "").trim();
  if (!id) return null;
  let entry = null;
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_PROJECT_SAVE_STORAGE_KEY) || "null");
    const log = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    entry = log[id] || null;
  } catch {
    entry = null;
  }
  if (!entry || String(entry.owner || "") !== String(owner || "")) return null;
  return publicRecord(entry);
}

/** Every save record this account owns, keyed by message id. */
export function readProjectSaveMap(owner = "", storage = defaultStorage()) {
  const who = String(owner || "");
  const map = new Map();
  let log = {};
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_PROJECT_SAVE_STORAGE_KEY) || "null");
    log = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    log = {};
  }
  for (const entry of Object.values(log)) {
    if (!entry || String(entry.owner || "") !== who) continue;
    const id = String(entry.messageId || entry.taskId || "");
    if (id) map.set(id, publicRecord(entry));
  }
  return map;
}

export function resetProjectSaves(storage = defaultStorage()) {
  try {
    storage?.removeItem(LOCAL_PROJECT_SAVE_STORAGE_KEY);
  } catch {
    // No receipt is the same as no storage; the files themselves are on disk.
  }
}
