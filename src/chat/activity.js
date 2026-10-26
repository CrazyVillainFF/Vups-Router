import { safeFilePath } from "./codeFiles.js";

export const ACTIVITY_STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const PHASE_LABELS = {
  request: "Model request queued",
  waiting: "Connecting to model",
  responding: "Generating response",
  generating_code: "Generating code",
  preparing_files: "Preparing files"
};

const ACTIVE_TURN_STATUSES = new Set(["pending", "streaming"]);

/** Seconds between the real turn start and its end (or now while running). */
export function measuredSeconds({ startedAt = null, endedAt = null, now = Date.now() } = {}) {
  if (!Number.isFinite(startedAt)) return null;
  const end = Number.isFinite(endedAt) ? endedAt : now;
  if (!Number.isFinite(end) || end < startedAt) return null;
  return (end - startedAt) / 1000;
}

export function isActiveActivity(turnStatus) {
  return ACTIVE_TURN_STATUSES.has(turnStatus);
}

/** How long a settled turn keeps its steps on screen so they tick green first. */
export const ACTIVITY_COLLAPSE_HOLD_MS = 700;

/**
 * Whether a finished turn should fold its step list away by itself.
 *
 * A turn the reader never watched run (loaded from history) is already folded,
 * so it must not animate, and a reader who opened the steps themselves keeps
 * them open. A failed turn stays expanded because the failing step is the
 * answer to "what went wrong".
 */
export function shouldAutoCollapseActivity({
  active = false,
  status = ACTIVITY_STATUS.COMPLETED,
  userToggled = false,
  ranLive = false
} = {}) {
  if (active || !ranLive || userToggled) return false;
  return status !== ACTIVITY_STATUS.FAILED;
}

function cleanProgress(message) {
  return String(message || "")
    .replace(/(?:\uFFFD|â€¦|\u2026)[\s\S]*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function progressFilePath(message) {
  const text = cleanProgress(message);
  const match = /^Generating\s+(.+?)(?:\s*(?:\u2026|\.{3}))?$/i.exec(text);
  if (!match) return "";
  return safeFilePath(match[1]);
}

export function progressLabel(phase, message = "") {
  if (PHASE_LABELS[phase]) return PHASE_LABELS[phase];
  if (phase === "generating_file") {
    const path = progressFilePath(message);
    const name = path.split("/").pop();
    return name ? `Writing ${name}` : "Writing files";
  }
  return cleanProgress(message).replace(/Generating your code.*$/i, "Generating code").slice(0, 80) || "Working";
}

function eventKey(phase, path, label) {
  if (phase === "generating_file") return path ? `file:${path}` : "files";
  if (PHASE_LABELS[phase]) return phase;
  return `${phase || "progress"}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * Normalizes a stream progress update into one stable activity row. The id is
 * scoped to the request run so a continuation starts its own rows while older
 * completed rows remain in the conversation.
 */
export function progressEvent(progress = {}, { runId = "run", at = Date.now() } = {}) {
  const phase = String(progress.phase || "progress");
  if (phase === "complete" || phase === "done") return null;
  const label = progressLabel(phase, progress.message);
  const filePath = phase === "generating_file" ? progressFilePath(progress.message) : "";
  const id = `${runId}:${eventKey(phase, filePath, label)}`;
  return {
    id,
    phase,
    label,
    summary: (PHASE_LABELS[phase] || phase === "generating_file")
      ? ""
      : cleanProgress(progress.message).slice(0, 120),
    status: ACTIVITY_STATUS.RUNNING,
    startedAt: at,
    endedAt: null,
    filePath
  };
}

/**
 * Adds an operation. Starting a new operation closes the previous running one,
 * and repeated progress for the same phase/file updates the same row.
 */
export function applyActivityProgress(events = [], progress = {}, options = {}) {
  const event = progressEvent(progress, options);
  if (!event) return settleActivity(events, ACTIVITY_STATUS.COMPLETED, options.at);
  const list = Array.isArray(events) ? events : [];
  if (list.some(item => item.id === event.id)) return list;
  const at = options.at ?? Date.now();
  const closed = list.map(item =>
    item.status === ACTIVITY_STATUS.RUNNING
      ? { ...item, status: ACTIVITY_STATUS.COMPLETED, endedAt: at }
      : item
  );
  return [...closed, event];
}

export function settleActivity(events = [], status = ACTIVITY_STATUS.COMPLETED, at = Date.now()) {
  let changed = false;
  const next = (Array.isArray(events) ? events : []).map(event => {
    if (event.status !== ACTIVITY_STATUS.RUNNING) return event;
    changed = true;
    return { ...event, status, endedAt: at };
  });
  return changed ? next : events;
}

/** Completed turns restored from history expose their real generated files. */
export function activityFromArtifact(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter(file => file && typeof file.path === "string" && String(file.content || "").trim())
    .map(file => ({
      id: `artifact:${file.path}`,
      phase: "artifact",
      label: "Generated file",
      summary: "",
      status: file.complete === false ? ACTIVITY_STATUS.RUNNING : ACTIVITY_STATUS.COMPLETED,
      startedAt: null,
      endedAt: null,
      filePath: file.path
    }));
}

/**
 * Real generated files are shown as activity rows even when the stream did not
 * report every file operation (for example, history loaded from the backend).
 */
export function mergeActivityFiles(events = [], files = []) {
  const list = Array.isArray(events) ? events : [];
  const known = new Set(list.map(event => event?.filePath).filter(Boolean));
  const extras = activityFromArtifact(files).filter(event => !known.has(event.filePath));
  return extras.length > 0 ? [...list, ...extras] : list;
}

export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
