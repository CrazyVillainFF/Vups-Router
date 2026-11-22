import {
  isOpenTaskState,
  isResumableTaskState,
  taskErrorCode
} from "../services/taskApi.js";
import { applyProgressRows } from "../chat/activity.js";
import { formatTaskClock, taskElapsedText } from "./taskProgress.js";

export { MAX_CLARIFICATION_ANSWER_CHARS } from "../services/taskApi.js";

/**
 * What a conversation can say about the durable run behind one of its turns.
 *
 * The turn itself only draws; every decision — which action the backend would
 * accept, which question is really waiting, which sentence a field supports —
 * is here, so it can be tested without a browser and so no screen has to guess.
 * Nothing in this file invents a fact: a line exists only because a field the
 * server wrote exists, and an absent field produces no line rather than an
 * estimate.
 */

/**
 * The colour of a run, decided by the outcome rather than by being unfinished.
 *
 * A finished task is not automatically good news: green for `failed` would read
 * as success. A run waiting on a person or a provider is amber, and a state the
 * client has never seen gets no colour claim at all.
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

export function taskRunIsLive(state) {
  return isOpenTaskState(state) && !isResumableTaskState(state);
}