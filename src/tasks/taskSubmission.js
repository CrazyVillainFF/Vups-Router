/**
 * What a durable run is asked for, in one place.
 *
 * An ordinary chat message is a durable run: the brief goes to `POST /api/tasks`,
 * the backend worker answers it into the same conversation, and the screen that
 * sent it only reads. Everything that decides *what goes on the wire* and *when
 * one intent is one task* lives here, so the composer and the tracker cannot
 * disagree about a request. What a run means to the reader is formatted in
 * `taskProgress.js`, and what a watched run means to a chat is in
 * `../chat/taskRun.js`.
 */

export const MAX_TASK_PROMPT_CHARS = 2_000_000;

// Native tools require a device executor.
export function durableChatRun({ prompt, images = [], nativeTools = false } = {}) {
  if (nativeTools) return false;
  const text = String(prompt || "").trim();
  if (!text && images.length === 0) return false;
  return text.length <= MAX_TASK_PROMPT_CHARS;
}

/**
 * One user intent, one task.
 *
 * `nonce` names the send itself — the turn the composer created for it — so two
 * messages with the same text in the same chat are two intents, while a remount,
 * a double click or a re-render inside one send is still one. The text is part of
 * the key so an uncertain attempt can be recognised when the same message is
 * sent again, and the conversation scopes it so one chat's retry can never adopt
 * another chat's work.
 */
export function taskRunSubmissionKey({ conversationId = null, prompt = "", nonce = "" } = {}) {
  const scope = String(conversationId || "new");
  const text = String(prompt || "").trim();
  return `task:${scope}:${String(nonce || "")}:${text.slice(0, 500)}`;
}

/**
 * The request body, built only from fields the task route reads.
 * `conversationId` is dropped unless it is a saved conversation: a draft chat has
 * no id the backend could accept, and the submission saves the conversation
 * before the record exists.
 *
 * Images travel as the same payload the chat route takes; the worker attaches
 * them to the message it re-reads from the conversation. Combo and the plugin
 * tool loop are the worker's to run, so a chat that uses them is durable too.
 */
export function taskRunRequest({
  prompt,
  conversationId = null,
  reference = {},
  model = "",
  mode = "general",
  temperature = null,
  workspacePath = "",
  images = [],
  combo = false,
  pluginTools = false,
  retryUserMessageId = ""
} = {}) {
  const saved = String(conversationId || "");
  const attached = Array.isArray(images) ? images.filter(image => image && typeof image === "object") : [];
  const retryOf = String(retryUserMessageId || "").trim();
  return {
    prompt: String(prompt || "").trim(),
    ...(saved && !saved.startsWith("local-") ? { conversationId: saved } : {}),
    ...(retryOf ? { retryUserMessageId: retryOf } : {}),
    model: String(model || reference.model || ""),
    configId: reference.configId || null,
    providerId: reference.providerId || null,
    source: reference.source || null,
    vups: reference.vups === true,
    mode: String(mode || "general"),
    temperature: Number.isFinite(temperature) ? temperature : null,
    workspacePath: String(workspacePath || ""),
    combo: combo === true,
    pluginTools: pluginTools === true,
    ...(attached.length > 0 ? { images: attached } : {})
  };
}