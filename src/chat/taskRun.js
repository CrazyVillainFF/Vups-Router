import { isOpenTaskState } from "../services/taskApi.js";

/**
 * Sending a message as a durable task.
 *
 * A task turn is not a chat turn: the brief goes to `POST /api/tasks`, the
 * backend worker runs it, and this screen only watches. Everything that decides
 * *whether* a send becomes a task and *what* goes on the wire lives here, so the
 * same rules hold in the chat and in the Task Center and neither one has to
 * guess. What a task means to the reader — its status, wait and error sentences —
 * is formatted in one place, `tasks/taskProgress.js`.
 */

export const TASK_RUN_STORAGE_KEY = "vupsrouter.chat.runAsTask";

// Mirrors the server's task description cap (MAX_TASK_DESCRIPTION_CHARS), so a
// brief is refused here for the same reason it would be refused there — and with
// the same number in the sentence.
export const MAX_TASK_PROMPT_CHARS = 20_000;

function taskBrowserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Off unless the reader switched it on: a task is a deliberate choice. */
export function readRunAsTask(storage = taskBrowserStorage()) {
  try {
    return storage?.getItem(TASK_RUN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Returns what the storage actually holds, because a switch must not lie. */
export function writeRunAsTask(value, storage = taskBrowserStorage()) {
  const enabled = value === true;
  try {
    if (enabled) storage?.setItem(TASK_RUN_STORAGE_KEY, "1");
    else storage?.removeItem(TASK_RUN_STORAGE_KEY);
  } catch {
    // Private mode, a full disk, a native webview without storage.
  }
  return readRunAsTask(storage);
}

/**
 * Why this send cannot become a task, in the user's terms, or null.
 *
 * The task record carries a model reference and a folder — not an image and not
 * an attached file — and Combo runs are orchestrated by this client, not by the
 * worker. Saying so before sending is the only honest option: silently dropping
 * an attachment would make the task do different work from the one asked for.
 */
export function taskRunBlocker({ prompt, combo = false, images = 0, textFiles = 0 } = {}) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) return "Task mode needs a message: say what the task should do.";
  if (text.length > MAX_TASK_PROMPT_CHARS) {
    return `A task description must be ${MAX_TASK_PROMPT_CHARS.toLocaleString("en-US")} characters or fewer. Shorten it, or attach the text as a file and send it as a chat.`;
  }
  if (combo) return "Vups Combo AI runs on this device, not as a background task. Pick a single model to send this as a task.";
  if (images > 0) return "A background task cannot carry images. Send this as a chat, or remove the images.";
  if (textFiles > 0) {
    return "A background task runs on its brief alone, so it cannot carry attached files. Send this as a chat, or remove the attachments.";
  }
  return null;
}

/**
 * One user intent, one task.
 *
 * The key is the brief itself plus the conversation it was sent from, so the
 * same message sent twice — double click, a re-render, a retry after a
 * connection that dropped — is recognised as the same intent, and the tracker
 * reconciles instead of asking the backend for a second task. It is deliberately
 * not the component's, because a screen that unmounts and comes back is the same
 * reader asking for the same work.
 */
export function taskRunSubmissionKey({ conversationId = null, prompt = "" } = {}) {
  const scope = String(conversationId || "new");
  const text = String(prompt || "").trim();
  return `task:${scope}:${text.slice(0, 500)}`;
}

/**
 * The request body, built only from fields the task route reads.
 * `conversationId` is dropped unless it is a saved conversation: a draft chat has
 * no id the backend could accept, and the worker creates the conversation itself.
 */
export function taskRunRequest({
  prompt,
  conversationId = null,
  reference = {},
  model = "",
  mode = "general",
  temperature = null,
  workspacePath = ""
} = {}) {
  const saved = String(conversationId || "");
  return {
    prompt: String(prompt || "").trim(),
    ...(saved && !saved.startsWith("local-") ? { conversationId: saved } : {}),
    model: String(model || reference.model || ""),
    configId: reference.configId || null,
    providerId: reference.providerId || null,
    source: reference.source || null,
    vups: reference.vups === true,
    mode: String(mode || "general"),
    temperature: Number.isFinite(temperature) ? temperature : null,
    workspacePath: String(workspacePath || "")
  };
}

/** The step lines themselves — every one is an event the backend wrote. */
export function taskProgressEvents(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  return events.filter(event => event && typeof event === "object");
}

/**
 * Decide what a send means, once, from the fields the screen already settled.
 *
 * `chat` is the ordinary turn. `task` is exactly one `POST /api/tasks` and no
 * chat request at all — the two paths are alternatives, never both, because a
 * task that also ran a chat turn would answer the same brief twice and charge
 * for it twice. `blocked` says why the chosen mode cannot carry this message
 * instead of quietly sending it some other way.
 */
export function planTaskSend(input = {}) {
  if (input.runAsTask !== true) return { mode: "chat" };
  const notice = taskRunBlocker(input);
  if (notice) return { mode: "blocked", notice };
  return {
    mode: "task",
    key: taskRunSubmissionKey(input),
    request: taskRunRequest(input)
  };
}

/**
 * The tasks this conversation is waiting on.
 *
 * Coming back to a chat has to show the work that went on while it was closed,
 * so the live rows are found by their own conversation id — not by whatever task
 * the screen happened to start. A conversation can hold more than one open task,
 * and each one keeps its own entry, so no task can consume another's events.
 */
export function taskRunsForConversation(tasks, conversationId) {
  const id = String(conversationId || "");
  if (!id) return [];
  return (Array.isArray(tasks) ? tasks : []).filter(
    view => String(view?.conversationId || "") === id && isOpenTaskState(view?.state)
  );
}

/**
 * Which turn in this transcript a task's progress belongs to.
 *
 * The ids are derived from the task itself so that a screen which left and came
 * back points at the same turn, and the run id keys the merged activity rows the
 * same way a streamed turn keys its own.
 */
export function taskRunFor(taskId, conversationId) {
  const id = String(taskId || "");
  const assistantId = `task-run-${id}`;
  return {
    taskId: id,
    assistantId,
    runId: assistantId,
    conversationId: String(conversationId || "")
  };
}

/**
 * Where a finished task's answer really is.
 *
 * The worker writes the answer into the conversation as its own message, so this
 * screen never copies an answer out of the task record. It either re-reads that
 * conversation or says, truthfully, which conversation holds it.
 */
export function taskAnswerNote(conversationId, currentConversationId) {
  const target = String(conversationId || "");
  if (!target) return "The task finished, but no conversation was saved for it. Check the task list.";
  if (String(currentConversationId || "") === target) {
    return "The task finished. Its answer is saved in this conversation.";
  }
  return "The task finished. Its answer is saved in the conversation it belongs to — open it from Tasks.";
}
