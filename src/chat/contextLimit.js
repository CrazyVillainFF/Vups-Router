const CONTEXT_CODES = new Set([
  "context_limit",
  "provider_context_limit",
  "context_length_exceeded",
  "context_limit_exceeded",
  "context_too_long",
  "context_window_exceeded",
  "max_context_length_exceeded",
  "maximum_context_length_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
  "input_too_long",
  "input_length_exceeded",
  "too_many_tokens",
  "token_limit_exceeded",
  "string_above_max_length",
  "conversation_too_long",
  "chat_too_long",
  "vups_context_exceeded"
]);

const CONTEXT_PATTERNS = [
  /context (?:length|window)[^.\n]{0,80}(?:exceed|too (?:long|large|small)|maximum|max|limit)/i,
  /(?:maximum|max|exceeded)[^.\n]{0,24}context (?:length|window)/i,
  /(?:prompt|input|messages?|conversation|chat)[^.\n]{0,80}\btoo (?:long|large|big)\b[^.\n]{0,80}(?:context|model|tokens?)/i,
  /(?:conversation|chat)\s+(?:is\s+)?too (?:long|large)/i,
  /(?:prompt|input|message)\s+(?:is\s+)?too long/i,
  /input length exceeds (?:the )?context/i,
  /exceed(?:s|ed)? (?:the )?(?:model'?s )?(?:maximum|max|available) (?:context|tokens|input)/i,
  /input token count[^.\n]{0,80}(?:exceed|maximum|max)/i,
  /maximum (?:number of )?tokens[^.\n]{0,80}(?:exceed|allowed|context)/i,
  /token (?:count|limit|length)[^.\n]{0,80}(?:exceed|maximum|max|too|allowed)/i,
  /too many tokens/i,
  /reduce (?:the )?(?:length|size) of (?:your )?(?:messages?|input|prompt)/i,
  /conversation is too large/i,
  /too large to replay/i,
  /request (?:is )?too (?:large|long) for (?:this )?(?:model|provider)/i,
  /at most \d+ messages/i,
  /string too long for (?:this )?model/i,
  /\bcontext_limit\b/i,
  /\bvups_context_exceeded\b/i
];

// A provider can reject an over-long conversation with a bare HTTP 400 that
// carries no readable detail. The proxy then falls back to text that mentions
// the API key, model ID, and base URL. That fallback is not a credential
// failure; when the rejected request itself was large, the limit is the cause.
const GENERIC_PROVIDER_REJECTION =
  /did not include details|check the api key, model id, and api base url/i;
const LARGE_REQUEST_CHARS = 32000;
const LARGE_REQUEST_MESSAGES = 30;

export const CONTEXT_HANDOFF_PREFIX = "Continue this task:";
export const CONTEXT_HANDOFF_LABEL = "Context handoff from the previous conversation";
export const MAX_HANDOFF_CHARS = 6000;

const MAX_GOAL_CHARS = 520;
const MAX_REQUEST_CHARS = 360;
const MAX_PROGRESS_CHARS = 760;
const MAX_RECENT_REQUESTS = 4;
const MAX_FILE_ROWS = 18;

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function cleanExcerpt(value, limit) {
  // Exact snippets stay in the original chat. Replaying code or shell commands
  // through a summary can be rejected by an edge filter before it reaches the
  // API, so the handoff references files and outcomes instead.
  const text = safeString(value)
    .replace(/\u0000/g, "")
    .replace(/```[\s\S]*?(?:```|$)/g, " [code omitted] ")
    .replace(/`[^`\n]*`/g, " [code omitted] ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}\u2026`;
}

function diagnosticText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  return [
    value.message,
    value.detail,
    value.reason,
    value.reasonText,
    value.category,
    value.classification,
    value.code,
    value.type,
    value.status,
    value.providerMessage,
    value.providerDetail,
    value.providerErrorCode,
    value.providerCode
  ]
    .filter(item => typeof item === "string" || typeof item === "number")
    .join(" ");
}

function errorText(error) {
  const parts = [
    safeString(error?.message),
    safeString(error?.code),
    safeString(error?.type),
    safeString(error?.reason),
    safeString(error?.detail),
    safeString(error?.error),
    safeString(error?.error?.message),
    safeString(error?.error?.code),
    safeString(error?.cause?.message),
    safeString(error?.cause?.code),
    safeString(error?.providerMessage),
    safeString(error?.providerDetail),
    safeString(error?.providerErrorCode),
    safeString(error?.providerCode),
    diagnosticText(error?.diagnostic),
    diagnosticText(error?.diagnostics),
    diagnosticText(error?.response?.data)
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function isLargeRejectedRequest(error) {
  const chars = Number(error?.requestChars);
  const messages = Number(error?.messageCount);
  return (
    (Number.isFinite(chars) && chars >= LARGE_REQUEST_CHARS) ||
    (Number.isFinite(messages) && messages >= LARGE_REQUEST_MESSAGES)
  );
}

/**
 * Only recognized context-window failures qualify. Transport, auth, quota,
 * rate-limit, and generic provider failures must never reach this branch.
 */
export function isContextLimitError(error) {
  if (!error) return false;
  const code = String(error.code || "").toLowerCase();
  if (CONTEXT_CODES.has(code)) return true;
  const status = Number(error.status);
  const text = errorText(error);
  const contextEvidence = Boolean(
    text && CONTEXT_PATTERNS.some(pattern => pattern.test(text))
  );
  // Providers sometimes attach a context-overflow body to HTTP 401/403.
  // Explicit structured or textual evidence wins; a bare credential status or
  // a large request alone is never enough to reclassify a permission failure.
  if (status === 401 || status === 403) return contextEvidence;
  if (contextEvidence) return true;
  return (
    status === 400 &&
    GENERIC_PROVIDER_REJECTION.test(text) &&
    isLargeRejectedRequest(error)
  );
}

function cleanModelName(value) {
  return safeString(value)
    .replace(/^[`"'([\s]+/, "")
    .replace(/[`"')\],.;]+$/, "")
    .trim();
}

/** Reads the affected model from the error, never from a hard-coded label. */
export function contextModelName(error, fallback = "") {
  for (const value of [error?.model, error?.modelId, error?.modelName]) {
    const name = cleanModelName(value);
    if (name) return name;
  }
  const text = errorText(error);
  const labeled = /\bmodel(?:\s+(?:id|name))?\s*[:=]\s*([^\s,;]+)/i.exec(text);
  if (labeled) {
    const name = cleanModelName(labeled[1]);
    if (name) return name;
  }
  const parenthesized = /\bmodel(?:\s+(?:id|name))?\s*\(([^)]+)\)/i.exec(text);
  if (parenthesized) {
    const name = cleanModelName(parenthesized[1]);
    if (name) return name;
  }
  return cleanModelName(fallback);
}

export function isContextHandoffContent(content) {
  const text = safeString(content);
  return text.startsWith(CONTEXT_HANDOFF_PREFIX) && text.includes(CONTEXT_HANDOFF_LABEL);
}

export function contextHandoffGoal(content) {
  if (!isContextHandoffContent(content)) return "";
  const firstLine = safeString(content).split("\n")[0] || "";
  return cleanExcerpt(firstLine.slice(CONTEXT_HANDOFF_PREFIX.length), MAX_GOAL_CHARS);
}

function bytesLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanExcerpt(value, MAX_REQUEST_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function collectFiles(messages) {
  const files = new Map();
  for (const message of messages) {
    const list = Array.isArray(message?.artifact?.files) ? message.artifact.files : [];
    for (const file of list) {
      const path = safeString(file?.path).trim();
      if (!path) continue;
      files.set(path, {
        path,
        complete: file.complete !== false,
        bytes: Number.isFinite(file.bytes) ? file.bytes : 0
      });
    }
  }
  return [...files.values()].slice(-MAX_FILE_ROWS);
}

/**
 * Deterministic, bounded handoff. It borrows excerpts and file paths the user
 * can already see; it never copies the full transcript or claims that files
 * were moved into the new conversation.
 */
export function buildContextHandoff({
  messages = [],
  modelLabel = "",
  error = null,
  sourceId = ""
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const userMessages = list.filter(
    message =>
      message?.role === "user" &&
      !message.handoff &&
      safeString(message.content).trim()
  );
  const assistantMessages = list.filter(
    message => message?.role === "assistant" && safeString(message.content).trim()
  );
  const goal = cleanExcerpt(
    userMessages[0]?.content || contextHandoffGoal(list.find(message => message?.handoff)?.content),
    MAX_GOAL_CHARS
  ) || "Resume the previous conversation.";
  const recentRequests = uniqueStrings(userMessages.map(message => message.content)).slice(
    -MAX_RECENT_REQUESTS
  );
  const progress = cleanExcerpt(assistantMessages.at(-1)?.content, MAX_PROGRESS_CHARS);
  const files = collectFiles(list);
  const incomplete = files.filter(file => !file.complete);
  const lastAssistant = [...list].reverse().find(message => message?.role === "assistant") || null;
  const status = safeString(lastAssistant?.status);
  const model = contextModelName(error || lastAssistant?.error, modelLabel);
  const contextFailure = isContextLimitError(error || lastAssistant?.error);

  const lines = [
    `${CONTEXT_HANDOFF_PREFIX} ${goal}`,
    "",
    CONTEXT_HANDOFF_LABEL,
    contextFailure
      ? "This summary was created because the previous chat reached the model's context limit. Continue the same task from these notes."
      : "This summary was created so the task can continue in a new conversation. Continue the same task from these notes.",
    "",
    "Goal and recent requests"
  ];

  const requestLines = recentRequests.length > 0 ? recentRequests : [goal];
  for (const request of requestLines) lines.push(`- ${request}`);

  if (progress) {
    lines.push("", "Latest assistant progress", progress);
  }

  if (files.length > 0) {
    lines.push("", "Generated files (still available in the previous chat)");
    for (const file of files) {
      const size = bytesLabel(file.bytes);
      const state = file.complete ? "complete" : "incomplete";
      lines.push(`- ${file.path} (${state}${size ? `, ${size}` : ""})`);
    }
  }

  lines.push("", "Status");
  if (status) lines.push(`- Last turn: ${status}`);
  if (model) lines.push(`- Model: ${model}`);
  if (contextFailure) {
    lines.push("- Reason: the conversation exceeded this model's context window.");
  }
  if (lastAssistant?.content?.trim()) {
    lines.push("- The partial or completed output above remains in the previous chat.");
  }
  if (incomplete.length > 0) {
    lines.push(`- ${incomplete.length} generated ${incomplete.length === 1 ? "file is" : "files are"} incomplete.`);
  }

  lines.push(
    "",
    "Next steps",
    "- Continue from the last request above.",
    ...(files.length > 0
      ? ["- If exact file contents are needed, open the previous chat; files were not copied into this conversation."]
      : []),
    "",
    "Guidelines",
    "- Keep prior decisions and constraints unless the user changes them.",
    "- Do not repeat work that is already complete.",
    "- Code and shell commands were omitted from this summary; open the previous chat for exact snippets.",
    "- If an important detail is missing, ask before guessing."
  );

  let content = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  let truncated = false;
  if (content.length > MAX_HANDOFF_CHARS) {
    truncated = true;
    let clipped = content.slice(0, MAX_HANDOFF_CHARS - 120);
    const lastBreak = clipped.lastIndexOf("\n");
    if (lastBreak > clipped.length * 0.6) clipped = clipped.slice(0, lastBreak);
    content = `${clipped.trimEnd()}\n\n[Handoff shortened to fit the new conversation.]`;
  }

  return {
    content,
    goal,
    model,
    files,
    sourceId,
    messageCount: list.length,
    truncated
  };
}
