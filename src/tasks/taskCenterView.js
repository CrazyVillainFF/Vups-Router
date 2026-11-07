import {
  isOpenTaskState,
  isResumableTaskState,
  isTerminalTaskState,
  taskErrorCode
} from "../services/taskApi.js";
import { applyProgressRows } from "../chat/activity.js";
import { formatTaskClock, taskElapsedText } from "./taskProgress.js";

export { MAX_CLARIFICATION_ANSWER_CHARS } from "../services/taskApi.js";

/**
 * What the Task Center can say about the tracker's rows.
 *
 * The page itself only draws; every decision — which group a task belongs to,
 * which action the backend would accept for it, what the header may claim about
 * a failed read — is here, so it can be tested without a browser and so no
 * screen has to guess. Nothing in this file invents a fact: a line exists only
 * because a field the server wrote exists, and an absent field produces no
 * line rather than an estimate.
 */

/** The categories the task list is asked to separate, plus the honest catch-all. */
export const TASK_CENTER_FILTERS = Object.freeze([
  Object.freeze({ key: "all", label: "All" }),
  Object.freeze({ key: "active", label: "In progress" }),
  Object.freeze({ key: "queued", label: "Queued" }),
  Object.freeze({ key: "waiting", label: "Needs you" }),
  Object.freeze({ key: "finished", label: "Finished" }),
  Object.freeze({ key: "other", label: "Other" })
]);

/**
 * A state this build has never seen is not filed under a guess. It gets its own
 * group, and the row still prints the state the backend named.
 *
 * "Needs you" is exactly the states `POST /tasks/:id/resume` accepts, so the one
 * group a reader has to act on is the one group the backend can act on.
 */
export function taskSectionFor(view) {
  const state = String(view?.state || "");
  if (state === "queued") return "queued";
  if (isResumableTaskState(state)) return "waiting";
  if (isTerminalTaskState(state)) return "finished";
  if (isOpenTaskState(state)) return "active";
  return "other";
}

/**
 * The colour of a row, decided by the outcome rather than the group.
 *
 * A finished task is not automatically a good news: green for `failed` would
 * read as success. A task that is waiting on a person or a provider is amber,
 * and a state the client has never seen gets no colour claim at all.
 */
export function taskDotTone(view) {
  const state = String(view?.state || "");
  if (state === "completed") return "ok";
  if (state === "failed") return "error";
  if (state === "cancelled" || state === "queued") return "muted";
  if (isResumableTaskState(state) || state === "retrying") return "warn";
  if (isOpenTaskState(state)) return "live";
  return "unknown";
}

export function countTaskSections(views) {
  const rows = Array.isArray(views) ? views : [];
  const counts = { all: rows.length, active: 0, queued: 0, waiting: 0, finished: 0, other: 0 };
  for (const view of rows) counts[taskSectionFor(view)] += 1;
  return counts;
}

/** Filtering cannot disagree with grouping: both read `taskSectionFor`. */
export function filterTaskViews(views, filterKey = "all") {
  const rows = Array.isArray(views) ? views : [];
  if (!TASK_CENTER_FILTERS.some(item => item.key === filterKey) || filterKey === "all") return rows;
  return rows.filter(view => taskSectionFor(view) === filterKey);
}

/** Sections in a fixed order, empty ones left out so nothing decorative shows. */
export function groupTaskViews(views) {
  const rows = Array.isArray(views) ? views : [];
  const groups = new Map();
  for (const { key, label } of TASK_CENTER_FILTERS) {
    if (key === "all") continue;
    const items = rows.filter(view => taskSectionFor(view) === key);
    if (items.length > 0) groups.set(key, { key, label, items });
  }
  return [...groups.values()];
}

/**
 * Which actions the backend would accept for this record.
 *
 * Cancel only while the task is open, because a finished one answers with the
 * record unchanged and a button that changes nothing is a lie; resume only in
 * the states `POST /tasks/:id/resume` does not refuse with 409 — which excludes
 * a task parked on a question, since that route answers 409
 * `clarification_required` until the answer arrives; the conversation link only
 * once the worker has actually saved one.
 */
export function taskActionsFor(task) {
  const state = String(task?.state || "");
  const asked = taskClarificationFor(task);
  return Object.freeze({
    inspect: Boolean(state),
    refresh: Boolean(state),
    cancel: isOpenTaskState(state),
    resume: isResumableTaskState(state) && !asked,
    answer: Boolean(asked) && state === "waiting_for_user",
    openConversation: Boolean(task?.conversationId)
  });
}

/**
 * The question this record is waiting on, read from the field the server wrote.
 *
 * The payload arrives from three different routes with three different shapes —
 * a full one on the detail and event reads, a truncated one on list rows, and
 * nothing at all from a deployment without this feature — so it is normalised
 * here rather than trusted at each call site. Anything without an id yields no
 * card: an unanswerable question is not a question to display.
 */
export function taskClarificationFor(task) {
  const value = task?.pendingClarification;
  if (!value || typeof value !== "object") return null;
  const clarificationId = String(value.clarificationId || "");
  if (!clarificationId) return null;
  const question = typeof value.question === "string" ? value.question : "";
  if (!question.trim()) return null;
  return Object.freeze({
    clarificationId,
    question,
    options: Object.freeze(
      (Array.isArray(value.options) ? value.options : [])
        .filter(option => typeof option === "string" && option.trim())
        .map(option => option.trim())
    ),
    blockedSteps: Object.freeze(
      (Array.isArray(value.blockedSteps) ? value.blockedSteps : []).filter(step => typeof step === "string" && step)
    ),
    askedAt: value.askedAt ?? null
  });
}

/**
 * A refused answer that means this form is already out of date.
 *
 * These three codes all say the record moved — someone else answered, the task
 * left the waiting state, or it finished — so the only honest repair is to read
 * the task again instead of offering the same text a second time. A dropped
 * connection is not in this list on purpose: there the answer may or may not
 * have landed, and re-reading is the reader's own decision to make.
 */
export function isStaleAnswerError(error) {
  return ["clarification_answered", "state_conflict", "task_terminal"].includes(taskErrorCode(error));
}

/** The chat that owns this task's answer — by its id, never the current screen's. */
export function taskConversationHref(conversationId) {
  const id = String(conversationId || "");
  if (!id) return "";
  return `/chat?task=${encodeURIComponent(id)}`;
}

const NOTICE_BY_KIND = Object.freeze({
  unsupported: "This server does not have the background-task API, so there is nothing to list yet.",
  unauthorized: "Your session has ended. Sign in again to see your tasks.",
  forbidden: "This account is not allowed to read the task list.",
  server: "The task list could not be read. The server is responding but failing.",
  network: "The server could not be reached, so nothing has been read this session.",
  rate_limited: "Too many requests at the moment — the task list will be read again shortly.",
  not_found: "The task list could not be read.",
  rejected: "The task list could not be read.",
  unknown: "The task list could not be read."
});

/**
 * The one sentence the header is allowed to say about the read itself.
 *
 * An authentication failure is never reported as an unavailable API and an
 * unavailable API is never reported as a failed task: those send the reader to
 * fix different things. Rows already in hand stay on screen and are labelled as
 * what they are — the last thing the client actually read.
 */
export function taskCenterNotice(snapshot) {
  const hydration = snapshot?.hydration || {};
  const kind = String(snapshot?.errorKind || hydration.errorKind || "");
  const rows = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  if (hydration.state === "failed") {
    return {
      tone: kind === "unauthorized" ? "auth" : "error",
      text: NOTICE_BY_KIND[kind] || hydration.error || NOTICE_BY_KIND.unknown,
      stale: rows.length > 0
    };
  }
  if (rows.length === 0 && (hydration.state === "pending" || hydration.state === "idle")) {
    return { tone: "loading", text: "Reading your tasks…", stale: false };
  }
  if (rows.length === 0 && hydration.state === "ready") {
    return { tone: "empty", text: "No background tasks yet.", stale: false };
  }
  return null;
}

/** The last successful read, in words — or nothing, when there never was one. */
export function taskSyncTimeText(snapshot, { now = Date.now() } = {}) {
  const at = Number(snapshot?.lastSyncAt) || 0;
  if (at <= 0) return "";
  const ago = Math.max(0, now - at);
  if (ago < 5000) return "task list just read";
  if (ago < 60_000) return `task list read ${Math.round(ago / 1000)}s ago`;
  return `task list read ${Math.round(ago / 60_000)}m ago`;
}

/**
 * The event window, as rows.
 *
 * Reuses the merge the chat transcript uses — identity-keyed and forward-only —
 * so replaying a window that includes rows already shown cannot double a line or
 * reopen a settled one, and so the wording of a step is the same here as in the
 * conversation it belongs to.
 */
export function taskDetailRows(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  const runId = `task:${String(task?.taskId || "")}`;
  return applyProgressRows([], events, { runId });
}

/** Plan progress, only when the server wrote a plan. */
export function taskPlanProgress(task) {
  const plan = Array.isArray(task?.plan) ? task.plan : [];
  if (plan.length === 0) return null;
  const total = plan.length;
  const done = Number.isFinite(Number(task?.completedSteps))
    ? Number(task.completedSteps)
    : plan.filter(step => step?.status === "completed").length;
  const pending = Number.isFinite(Number(task?.pendingSteps))
    ? Number(task.pendingSteps)
    : plan.filter(step => step?.status === "pending" || step?.status === "blocked").length;
  return Object.freeze({ total, done, pending, steps: plan });
}

/**
 * The model calls the record lists.
 *
 * `modelRequests` only arrives on the detail read, and a task that has asked
 * nothing of a model has nothing to say here — `steps` is not counted as a call,
 * because the status line already reports it.
 */
export function taskModelCalls(task) {
  const calls = Array.isArray(task?.modelRequests) ? task.modelRequests : null;
  if (!calls || calls.length === 0) return null;
  const failed = calls.filter(row => row?.status === "failed").length;
  return Object.freeze({ total: calls.length, failed });
}

/** The answer the backend stored, in its own words. Never a paraphrase. */
export function taskResultText(task) {
  if (String(task?.state || "") !== "completed") return "";
  const summary = String(task?.result?.summary || "").trim();
  if (summary) return summary;
  return task?.conversationId
    ? "The answer is saved in the conversation this task belongs to."
    : "";
}

/** Every timestamp the record actually carries, as label/value pairs. */
export function taskTimeRows(task) {
  const rows = [];
  const add = (label, value) => {
    const text = formatTaskClock(value);
    if (text) rows.push({ id: label, label, text });
  };
  add("Created", task?.createdAt);
  add("Started", task?.startedAt);
  add("Last activity", task?.lastActivityAt);
  add("Finished", task?.completedAt);
  const elapsed = taskElapsedText(task);
  if (elapsed) rows.push({ id: "elapsed", label: "Ran for", text: elapsed });
  return rows;
}

/** A cancellation the server recorded, in the field it recorded it in. */
export function taskCancelText(task) {
  const at = formatTaskClock(task?.cancelRequestedAt);
  if (!at) return "";
  const by = String(task?.cancelRequestedBy || "").trim();
  return `Cancellation requested${by ? ` by ${by}` : ""} at ${at}.`;
}
