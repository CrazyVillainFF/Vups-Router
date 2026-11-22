import { ACTIVITY_STATUS, formatElapsed, groupActivityRows, mergeActivityFiles } from "./activity.js";

export const PROGRESS_FALLBACK_LABEL = "Generating response";

const BRIEF_REQUEST_LIMIT = 110;
// The brief is a window onto the work, not a transcript: the newest lines answer
// "what is happening now", and the fold below the brief still holds every step.
const BRIEF_TIMELINE_LIMIT = 5;

// A tool line is named for the operation, so it never says how it ended; every
// other phase arrives already worded as its own result, and a suffix there would
// say the same thing twice.
const NEEDS_OUTCOME_SUFFIX = new Set(["tool"]);

const STATUS_SUFFIX = {
  [ACTIVITY_STATUS.FAILED]: " — failed",
  [ACTIVITY_STATUS.CANCELLED]: " — stopped"
};

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

function outcomeSuffix(status) {
  return STATUS_SUFFIX[status] || "";
}

function withFile(row) {
  const file = pathBaseName(row.filePath);
  return file ? `${row.label} — ${file}` : row.label;
}

/**
 * The status one group of work reports as a whole. Running wins while any
 * member is still open, then a failure, because a round whose third call failed
 * is not a round that finished.
 */
function groupStatus(rows) {
  if (rows.some(row => row.status === ACTIVITY_STATUS.RUNNING)) return ACTIVITY_STATUS.RUNNING;
  if (rows.some(row => row.status === ACTIVITY_STATUS.FAILED)) return ACTIVITY_STATUS.FAILED;
  if (rows.some(row => row.status === ACTIVITY_STATUS.CANCELLED)) return ACTIVITY_STATUS.CANCELLED;
  return ACTIVITY_STATUS.COMPLETED;
}

/**
 * One chronological line of the running brief. Every field is read from a row
 * the app or the server reported, so the brief can only ever say what really
 * happened: an open call reads as running, a settled one as its real outcome,
 * and a round of several calls as the one piece of work it was.
 */
function timelineLine(group) {
  const rows = group.rows;
  const first = rows[0];
  // The folder a task runs in is the brief's own context line, so the row that
  // only announces it would repeat it. Once that row carries a real stop or
  // failure, it is a fact the context line cannot state, so it is shown.
  if (
    first.phase === "task" &&
    first.status !== ACTIVITY_STATUS.FAILED &&
    first.status !== ACTIVITY_STATUS.CANCELLED
  ) {
    return null;
  }
  const status = groupStatus(rows);
  // Keyed to the first member so a round that grows from one call to four
  // updates the line it already has instead of mounting a new one.
  const id = `line:${first.id || ""}`;
  if (group.kind === "tools" && rows.length > 1) {
    const failed = rows.filter(row => row.status === ACTIVITY_STATUS.FAILED).length;
    const stopped = rows.filter(row => row.status === ACTIVITY_STATUS.CANCELLED).length;
    const note = [failed ? `${failed} failed` : "", stopped ? `${stopped} stopped` : ""]
      .filter(Boolean)
      .join(", ");
    return {
      id,
      kind: "tools",
      status,
      text: `${status === ACTIVITY_STATUS.RUNNING ? "Running" : "Ran"} ${rows.length} tools${
        note ? ` · ${note}` : ""
      }`
    };
  }
  if (first.phase === "model") return { id, kind: "narration", status, text: first.label };
  return {
    id,
    kind: first.phase === "command" ? "result" : "step",
    status,
    text: `${withFile(first)}${NEEDS_OUTCOME_SUFFIX.has(first.phase) ? outcomeSuffix(status) : ""}`
  };
}

/**
 * The running brief the reader sees above an answer while a task is in flight:
 * the request as taken, the folder and the access it has, then the work in the
 * order it really happened. Every line comes from state the app or the server
 * reported; a line is dropped rather than guessed when its source is missing.
 */
export function progressBrief({
  requestText = "",
  workspacePath = "",
  permissionLabel = "",
  events = []
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const context = [];
  const asked = briefRequest(requestText);
  if (asked) context.push({ id: "asked", kind: "context", status: "", text: `You asked: ${asked}` });
  // The folder comes from the chat's own binding, which is what the run was
  // pointed at; saying it out loud when nothing is bound is the honest answer.
  context.push({
    id: "folder",
    kind: "context",
    status: "",
    text: workspacePath
      ? `Working folder: ${workspacePath}`
      : "Working folder: none bound for this chat"
  });
  if (permissionLabel) {
    context.push({ id: "access", kind: "context", status: "", text: `Local access: ${permissionLabel}` });
  }
  const timeline = groupActivityRows(list).map(timelineLine).filter(Boolean);
  return [...context, ...timeline.slice(Math.max(0, timeline.length - BRIEF_TIMELINE_LIMIT))];
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
