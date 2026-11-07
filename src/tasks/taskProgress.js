import { isTerminalTaskState } from "../services/taskApi.js";

/**
 * Progress for a durable task, built only from what the server persisted.
 *
 * The brief for this phase forbids invented progress, so there is no timer here
 * and no percentage: a line exists because an event, a retry record, a plan step
 * or an error field exists on the task. A source that is missing makes the line
 * absent, never approximate.
 */

const STATE_LABELS = Object.freeze({
  queued: "Waiting for a free slot",
  planning: "Preparing",
  running: "Working",
  executing_tool: "Running a step",
  retrying: "Waiting to retry",
  waiting_for_user: "Waiting for you",
  waiting_for_permission: "Waiting for permission",
  paused: "Paused",
  recovering: "Recovering",
  verifying: "Checking the result",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped"
});

const CAUSE_LABELS = Object.freeze({
  rate_limit_requests: "the model service is at its request limit",
  rate_limit_tokens: "the model service is out of tokens for this minute",
  concurrency_limit: "the model service is at its concurrent-task limit",
  session_busy: "the model is still finishing its previous reply",
  ambiguous_rate_limit: "the model service is throttling requests",
  overloaded: "the model is busy with other work",
  upstream_unavailable: "the model service is temporarily unavailable",
  provider_unavailable: "the model service could not be reached",
  connection_refused: "the model service did not accept the connection",
  network_error: "the connection to the model dropped",
  timeout: "the model took too long to answer",
  invalid_response: "the model answered in a way that could not be read",
  empty_response: "the model answered with nothing",
  empty_stream: "the model's answer stopped before it finished"
});

const LINE_LIMIT = 3;

// The whole vocabulary `waitingOn` can hold today, from server/src/taskStore.js.
const WAITING_CATEGORIES = new Set(["user", "permission", "capacity", "provider", "resume"]);

function eventList(task) {
  if (Array.isArray(task?.events) && task.events.length > 0) return task.events;
  const last = task?.lastEvent;
  return last ? [last] : [];
}

/**
 * The question this task is parked on, exactly as the server wrote it.
 *
 * Only the text is read here: the id and the options belong to the form that
 * answers them, and repeating them in a status line would put the same fact in
 * two places.
 */
function questionOf(task) {
  const asked = task?.pendingClarification;
  if (!asked || typeof asked !== "object") return "";
  return String(asked.question || "").replace(/\s+/g, " ").trim();
}

/** A wait measured in words. Absent or past data yields no text rather than a guess. */
export function waitDurationText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value / 100) * 100}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function describeTaskState(task, { now = Date.now() } = {}) {
  const state = String(task?.state || "");
  const label = STATE_LABELS[state] || state || "Unknown";
  if (state === "retrying") {
    const retry = task?.retry || {};
    const until = Number(new Date(retry.nextAttemptAt || 0));
    const remaining = Number.isFinite(until) ? waitDurationText(until - now) : "";
    const attempt = Number(retry.attempts) > 0 && Number(retry.maxAttempts) > 0
      ? ` (attempt ${Number(retry.attempts) + 1} of ${Number(retry.maxAttempts)})`
      : "";
    const cause = CAUSE_LABELS[retry.lastCategory] || "";
    return `${label}${attempt}${remaining ? ` · retrying in ${remaining}` : ""}${cause ? ` · ${cause}` : ""}`;
  }
  if (state === "waiting_for_user" || state === "waiting_for_permission") {
    // A question on the record changes what the wait means: the task is not
    // idling, it stopped mid-work because the model needed something only the
    // reader has. That is the field the server wrote, so naming it is a fact.
    if (state === "waiting_for_user" && questionOf(task)) return "Waiting for your answer";
    const waitingOn = String(task?.waitingOn || "").trim();
    // The server's `waitingOn` is a category — "user", "permission", "capacity",
    // "provider", "resume" — not a description, so repeating it after a label
    // that already names the same party reads as noise ("Waiting for
    // permission: permission"). A value outside that list is the record saying
    // something the label does not, so it is shown as written.
    if (!waitingOn || WAITING_CATEGORIES.has(waitingOn)) return label;
    return `${label}: ${waitingOn}`;
  }
  if (state === "queued" && task?.waitingOn === "capacity") {
    return "Waiting for a free slot";
  }
  if (isTerminalTaskState(state) && Number(task?.steps) > 0) {
    return `${label} · ${Number(task.steps)} model ${Number(task.steps) === 1 ? "call" : "calls"}`;
  }
  return label;
}

/** The failure the backend recorded — its own message, not a paraphrase. */
export function taskErrorLine(task) {
  const error = task?.error;
  if (!error || typeof error !== "object") return null;
  const message = String(error.message || "").trim();
  const code = String(error.code || "").trim();
  if (!message && !code) return null;
  if (!message) return `Failed: ${code}`;
  return code ? `${message} (${code})` : message;
}

/**
 * One honest sentence for a header or a status row.
 *
 * The priority is deliberate: a recorded error outranks a wait, a wait outranks
 * a stage, and the state label alone is the floor. A stage the backend never
 * set, a wait it never scheduled and an error it never wrote stay unmentioned —
 * this line can only say what the record actually holds.
 */
export function taskSummaryLine(task, { now = Date.now() } = {}) {
  const state = String(task?.state || "");
  if (!state) return "";
  const terminal = isTerminalTaskState(state);
  const error = taskErrorLine(task);
  if (error && (terminal || state === "retrying")) return error;
  if (state === "retrying" || String(task?.waitingOn || "").trim()) return describeTaskState(task, { now });
  const stage = String(task?.stage || "").trim();
  const label = STATE_LABELS[state] || state;
  if (stage && stage !== state && !terminal) return `${label} — ${stage}`;
  return label;
}

/** The one line that names what is happening right now, straight from the event log. */
function currentStepLine(task) {
  const events = eventList(task);
  if (events.length === 0) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.status === "running") return events[index];
  }
  return events[events.length - 1];
}

function stepText(event) {
  const message = String(event?.message || "").trim();
  if (message) return message;
  const tool = String(event?.tool || "").trim();
  if (!tool) return "";
  return event?.status === "failed" ? `${tool} failed` : tool;
}

/**
 * Two or three lines: what was asked, the step the server actually has open,
 * and — only when it is true — the outcome or the reason it is waiting.
 */
export function taskProgressLines(task, { limit = LINE_LIMIT } = {}) {
  const lines = [];
  const asked = String(task?.description || "").replace(/\s+/g, " ").trim();
  if (asked) lines.push({ id: "asked", text: asked });

  const question = questionOf(task);
  if (question) {
    // The log row that announced the park ("The model asked you a question.")
    // says less than the question itself, and a row has three lines at most:
    // the question and the wait take the step's place rather than push the wait
    // off the end of the list.
    lines.push({
      id: `question:${String(task?.pendingClarification?.clarificationId || "")}`,
      text: question
    });
  } else {
    const step = currentStepLine(task);
    const stepMessage = stepText(step);
    if (stepMessage) {
      const live = step?.status === "running";
      lines.push({
        id: `step:${step?.seq ?? 0}`,
        text: live ? `Now: ${stepMessage}` : `Last step: ${stepMessage}`
      });
    }
  }

  const state = String(task?.state || "");
  if (state === "failed") {
    const message = String(task?.error?.message || "").trim() || "The task stopped with an error.";
    lines.push({ id: "outcome", text: `Failed: ${message}` });
  } else if (state === "cancelled") {
    lines.push({ id: "outcome", text: "Stopped before it finished." });
  } else if (state === "completed") {
    const summary = String(task?.result?.summary || "").trim();
    lines.push({ id: "outcome", text: summary ? `Answer: ${summary}` : "The answer is in the conversation." });
  } else if (state === "retrying") {
    lines.push({ id: "outcome", text: describeTaskState(task) });
  } else if (task?.waitingOn && state !== "queued") {
    lines.push({ id: "outcome", text: describeTaskState(task) });
  }

  return lines.filter(line => line.text).slice(0, Math.max(1, Number(limit) || LINE_LIMIT));
}

/** When the task last did something, in words a list row can show without a tooltip. */
export function taskActivityTime(task, { now = Date.now() } = {}) {
  const value = Number(new Date(task?.lastActivityAt ?? task?.updatedAt ?? task?.createdAt ?? 0));
  if (!Number.isFinite(value) || value <= 0) return "";
  const ago = now - value;
  if (ago < 60_000) return "just now";
  return `${waitDurationText(ago)} ago`;
}

export function formatTaskClock(value) {
  const time = Number(new Date(value || 0));
  if (!Number.isFinite(time) || time <= 0) return "";
  return new Date(time).toLocaleString();
}

/** How long a task ran, from the two timestamps the server wrote. */
export function taskElapsedText(task) {
  const start = Number(new Date(task?.startedAt || 0));
  const end = Number(new Date(task?.completedAt || 0));
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) return "";
  return waitDurationText(end - start) || "under 100ms";
}
