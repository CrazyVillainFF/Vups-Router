import { apiClient, getApiErrorCode } from "./api.js";

/**
 * The task API (the client half of the durable task record).
 *
 * These are the only calls that may talk about a server task. Nothing here owns
 * a request's lifetime: a submitted task belongs to the backend worker, so no
 * caller passes an AbortController and no navigation can undo the work. The
 * tracker in ../tasks/taskTracker.js is what reads these; screens read the
 * tracker.
 */

// Mirrors server/src/taskState.js. Kept here rather than imported so the client
// never has to guess which strings the backend considers finished.
export const TASK_STATES = Object.freeze([
  "queued",
  "planning",
  "running",
  "executing_tool",
  "retrying",
  "waiting_for_user",
  "waiting_for_permission",
  "paused",
  "recovering",
  "verifying",
  "completed",
  "failed",
  "cancelled"
]);

export const TASK_TERMINAL_STATES = Object.freeze(["completed", "failed", "cancelled"]);

/** The states `POST /tasks/:id/resume` accepts — everything else answers 409. */
export const TASK_RESUMABLE_STATES = Object.freeze([
  "paused",
  "waiting_for_user",
  "waiting_for_permission"
]);

// Mirrors MAX_CLARIFICATION_ANSWER_CHARS in server/src/task.js, which the answer
// route enforces with a 413. The client caps what it sends to the same number so
// a long answer is trimmed at the form rather than refused on the wire.
export const MAX_CLARIFICATION_ANSWER_CHARS = 4000;

export function isTerminalTaskState(state) {
  return TASK_TERMINAL_STATES.includes(state);
}

export function isResumableTaskState(state) {
  return TASK_RESUMABLE_STATES.includes(state);
}

/** True while the backend still has work to report on for this task. */
export function isOpenTaskState(state) {
  return TASK_STATES.includes(state) && !isTerminalTaskState(state);
}

export async function submitTask(input = {}) {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw Object.assign(new Error("Say what the task should do."), { code: "invalid_prompt" });
  const { prompt: _prompt, conversationId, ...request } = input;
  const { data } = await apiClient.post("/tasks", {
    prompt,
    ...(conversationId ? { conversationId } : {}),
    ...request
  });
  return data.task;
}

export async function listTasks({ states = [], limit } = {}) {
  const params = {};
  if (states.length > 0) params.state = states.join(",");
  if (Number.isFinite(limit)) params.limit = limit;
  const { data } = await apiClient.get("/tasks", { params: Object.keys(params).length ? params : undefined });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function fetchTask(taskId) {
  const { data } = await apiClient.get(`/tasks/${encodeURIComponent(taskId)}`);
  return data.task;
}

/**
 * The replay cursor. `after` is an event sequence number, so a client that was
 * away asks for what it missed and cannot be shown a row twice.
 *
 * `pendingClarification` keeps the difference between absent and null. A
 * deployment that predates Phase 4 does not send the key at all, and that is not
 * the same fact as a server that sent `"pendingClarification": null` — the
 * second one means the question is gone. Losing the difference would let an old
 * backend erase a live question the client already holds.
 */
export async function fetchTaskEvents(taskId, { after = 0 } = {}) {
  const { data } = await apiClient.get(`/tasks/${encodeURIComponent(taskId)}/events`, {
    params: { after: Number(after) || 0 }
  });
  return {
    taskId: data.taskId,
    state: data.state,
    stage: data.stage || "",
    conversationId: data.conversationId ?? null,
    done: data.done === true,
    lastSeq: Number(data.lastSeq) || 0,
    events: Array.isArray(data.events) ? data.events : [],
    ...(data.pendingClarification === undefined ? {} : { pendingClarification: data.pendingClarification })
  };
}

/** Resolves with the backend's own record. A refused cancellation is a rejection the caller must show. */
export async function cancelTask(taskId) {
  const { data } = await apiClient.post(`/tasks/${encodeURIComponent(taskId)}/cancel`, {});
  return data.task;
}

export async function resumeTask(taskId) {
  const { data } = await apiClient.post(`/tasks/${encodeURIComponent(taskId)}/resume`, {});
  return data.task;
}

/**
 * Answering one question of one task (Phase 4).
 *
 * The two local guards use the backend's own codes because they enforce the
 * backend's own rules: an empty answer and an over-long one are refused by
 * `POST /tasks/:id/clarifications/:id/answer` with 400 `answer_required` and 413
 * `answer_too_long`, and a client that sent either would only learn it later.
 * Everything else — a question that already has its answer, a task that has
 * moved on, a task that is not this account's — is the server's to say, and its
 * rejection travels to the caller unchanged.
 */
export async function answerTaskClarification(taskId, clarificationId, answer) {
  const id = String(clarificationId || "");
  if (!id) throw Object.assign(new Error("That question does not have an id to answer."), { code: "invalid_clarification_id" });
  const text = typeof answer === "string" ? answer.trim() : "";
  if (!text) throw Object.assign(new Error("Write your answer first."), { code: "answer_required" });
  if (text.length > MAX_CLARIFICATION_ANSWER_CHARS) {
    throw Object.assign(
      new Error(`An answer is up to ${MAX_CLARIFICATION_ANSWER_CHARS} characters.`),
      { code: "answer_too_long" }
    );
  }
  const { data } = await apiClient.post(
    `/tasks/${encodeURIComponent(taskId)}/clarifications/${encodeURIComponent(id)}/answer`,
    { answer: text }
  );
  return data.task;
}

/**
 * What an error on the task API actually means, decided before anything else.
 *
 * These cases look similar at the transport level and mean different things to
 * the user, so they must never collapse into one message: a deployment without
 * the task routes, a session that expired, a task that is not this account's, a
 * backend that is up but failing, and a request that never arrived. Reporting a
 * 401 as "this build has no task API" would tell the user to upgrade instead of
 * to sign in again, which is worse than saying nothing.
 *
 * `unsupported` therefore requires a 404/405 that is not the backend's own
 * `task_not_found` answer — an unregistered route, not a missing record.
 */
export function taskErrorKind(error) {
  if (!error) return "unknown";
  const status = Number(error?.response?.status) || 0;
  const code = taskErrorCode(error);
  if (!error?.response) {
    // No response at all: the request may or may not have reached the server.
    return "network";
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 405) return code === "task_not_found" ? "not_found" : "unsupported";
  if (status >= 500) return "server";
  if (status >= 400) return "rejected";
  return "unknown";
}

/**
 * True when a submission may have been accepted even though this call failed:
 * the connection dropped, the backend errored after receiving the body, or it
 * answered 429. These are the only outcomes where retrying `POST /tasks` risks
 * a second task, so a caller must not treat them as "nothing happened".
 *
 * A 4xx with a code from the backend (`invalid_prompt`, `invalid_conversation_id`)
 * is a refusal that created nothing, and is safe to retry after fixing the input.
 */
export function isAmbiguousSubmissionError(error) {
  const kind = taskErrorKind(error);
  return kind === "network" || kind === "server" || kind === "rate_limited";
}

/**
 * A deployment that predates the task API answers the collection route with
 * 404/405. That is a fact about the server, not a failed task, and the UI has to
 * be able to say so instead of showing an empty list or a permanent error.
 */
export function isTaskApiUnavailable(error) {
  return taskErrorKind(error) === "unsupported";
}

/** The machine-readable code the backend chose, for branching without reading prose. */
export function taskErrorCode(error) {
  const fromBody = error?.response?.data?.code;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  return getApiErrorCode(error);
}
