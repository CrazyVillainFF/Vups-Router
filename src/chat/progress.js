import { ACTIVITY_STATUS, formatElapsed, mergeActivityFiles } from "./activity.js";

export const PROGRESS_FALLBACK_LABEL = "Generating response";

const BRIEF_REQUEST_LIMIT = 110;

/** The file name only, for either separator Windows or a server path may use. */
export function pathBaseName(value) {
  const parts = String(value || "").split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function briefRequest(text) {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > BRIEF_REQUEST_LIMIT
    ? `${oneLine.slice(0, BRIEF_REQUEST_LIMIT - 1)}…`
    : oneLine;
}

/**
 * The step worth naming right now: work that is actually in flight, otherwise
 * the last thing that really finished. Nothing is invented for "what comes
 * next", because only the model knows that.
 */
function briefStep(events) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status === ACTIVITY_STATUS.RUNNING) return { row: list[index], live: true };
  }
  const last = list[list.length - 1];
  return last ? { row: last, live: false } : null;
}

/**
 * The running brief the reader sees above an answer while a task is in flight:
 * the request as taken, the folder it is bound to, the access it has, and the
 * step actually open. Every line comes from state the app or the server
 * reported; a line is dropped rather than guessed when its source is missing.
 */
export function progressBrief({
  requestText = "",
  workspacePath = "",
  permissionLabel = "",
  events = []
} = {}) {
  const lines = [];
  const asked = briefRequest(requestText);
  if (asked) lines.push({ id: "asked", text: `You asked: ${asked}` });
  lines.push(
    workspacePath
      ? { id: "folder", text: `Working folder: ${workspacePath}` }
      : { id: "folder", text: "Working folder: none bound for this chat" }
  );
  if (permissionLabel) lines.push({ id: "access", text: `Local access: ${permissionLabel}` });
  const step = briefStep(events);
  if (step) {
    const file = pathBaseName(step.row.filePath);
    const detail = file ? ` — ${file}` : "";
    lines.push({
      id: `step:${step.row.id || lines.length}`,
      text: step.live
        ? `Now: ${step.row.label}${detail}`
        : `${step.row.status === ACTIVITY_STATUS.FAILED ? "Last step failed" : "Last step"}: ${step.row.label}${detail}`
    });
  }
  return lines.slice(0, 4);
}

/**
 * Builds the one-line generation status from values the stream actually
 * delivered. Unknown metadata is omitted rather than estimated.
 */
export function generationProgress({
  events = [],
  files = [],
  active = false,
  startedAt = null,
  now = Date.now()
} = {}) {
  if (!active) return null;

  const list = Array.isArray(events) ? events : [];
  let current = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status === ACTIVITY_STATUS.RUNNING) {
      current = list[index];
      break;
    }
  }

  const fileList = (Array.isArray(files) ? files : []).filter(
    file => file && typeof file.path === "string" && String(file.content || "").trim()
  );
  const total = fileList.length;
  const complete = fileList.filter(file => file.complete !== false).length;
  const detail = total > 0 ? `${complete} / ${total} files` : "";

  const elapsedMs = Number.isFinite(startedAt) ? now - startedAt : null;

  return {
    label: current?.label || PROGRESS_FALLBACK_LABEL,
    detail,
    steps: mergeActivityFiles(list, fileList).length,
    elapsed: elapsedMs != null && elapsedMs >= 0 ? formatElapsed(elapsedMs) : ""
  };
}
