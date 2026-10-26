const QUOTA_PATTERN = /quota|credits? (?:are )?(?:exhausted|depleted|used up)|insufficient (?:quota|credits?|balance|funds)|billing|payment required|usage limit|out of tokens|allowance/i;
const RATE_PATTERN = /rate.?limit|too many requests|requests per|try again (?:in|shortly)|overloaded|concurrency limit|token-per-minute/i;
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|api key|key_decryption/i;
const CONTEXT_PATTERN = /context (?:length|window)|too many tokens|prompt is too long|maximum context|token limit|conversation is too large|too large to replay|at most \d+ messages/i;
const MODEL_PATTERN = /model.*(?:not found|unavailable|does not exist|not available|invalid)|invalid model|unknown model|no such model|not one of your saved/i;
const POLICY_PATTERN = /content policy|safety|moderation|blocked|violat/i;
const VISION_PATTERN = /image input|vision|does not accept image|support image|could not read that image/i;

const PERSISTENCE_CODES = new Set([
  "persist_failed",
  "vups_persist_failed",
  "artifact_persist_failed",
  "save_failed",
  "history_save_failed",
  "message_persist_failed"
]);

const INTERRUPTED_CODES = new Set([
  "stream_interrupted",
  "vups_stream_interrupted",
  "stream_error",
  "vups_stream_error",
  "eof_without_terminal"
]);

const OVERSIZE_CODES = new Set([
  "too_large",
  "response_too_large",
  "artifact_too_large",
  "continuation_too_large",
  "request_too_large"
]);
const OVERSIZE_PATTERN = /cannot exceed \d+ characters/i;

function hasPattern(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function normalizedCode(error) {
  return String(error?.code || "").toLowerCase();
}

export function isPersistenceFailureCode(code) {
  return PERSISTENCE_CODES.has(String(code || "").toLowerCase());
}

export function isPersistenceError(error) {
  return error?.stage === "persist" || isPersistenceFailureCode(error?.code);
}

export function isInterruptedError(error) {
  return INTERRUPTED_CODES.has(normalizedCode(error));
}

export function classifyChatError(error) {
  const code = normalizedCode(error);
  const message = String(error?.message || "");
  const status = Number(error?.status);
  const combined = `${code} ${message}`;

  if (isPersistenceFailureCode(code)) return "persist";
  if (hasPattern(combined, VISION_PATTERN) || ["vision_unsupported", "vups_vision_rejected", "image_unsupported"].includes(code)) {
    return "vision";
  }
  if (code === "timeout" || code === "vups_timeout" || status === 504) return "timeout";
  if (OVERSIZE_CODES.has(code) || status === 413 || hasPattern(combined, OVERSIZE_PATTERN)) return "oversize";
  if (hasPattern(combined, QUOTA_PATTERN) || ["insufficient_quota", "insufficient_credits", "quota_exhausted", "billing_error", "vups_quota_exhausted"].includes(code)) {
    return "quota";
  }
  if (status === 429 || hasPattern(combined, RATE_PATTERN) || code === "rate_limited" || code === "rate_limit_error") {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || hasPattern(combined, AUTH_PATTERN) || code === "unauthorized" || code === "invalid_api_key") {
    return "auth";
  }
  if (code.endsWith("_unavailable") || code === "provider_unavailable" || code === "upstream_unavailable") {
    return "unavailable";
  }
  if (hasPattern(combined, CONTEXT_PATTERN) || code === "context_length_exceeded") return "context";
  if (hasPattern(combined, MODEL_PATTERN) || code === "invalid_model" || code === "model_not_found") return "model";
  if (code === "empty_response" || code === "empty_stream") return "empty";
  if (code === "stream_interrupted" || code === "stream_error" || INTERRUPTED_CODES.has(code)) return "stream";
  if (code === "network_error" || hasPattern(message, /could not reach|network|connection/i)) return "network";
  if (hasPattern(combined, POLICY_PATTERN) || code === "content_policy_violation") return "policy";
  return "generic";
}

export function formatResetTime(resetAt, now = new Date()) {
  if (!resetAt) return "";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "";
  const base = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(base.getTime())) return "";

  const startOfDay = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const dayDiff = Math.round((startOfDay(date) - startOfDay(base)) / 86400000);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  if (dayDiff === -1) return `yesterday at ${time}`;
  if (date.getFullYear() === base.getFullYear()) {
    return `on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
  }
  return `on ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} at ${time}`;
}

export function presentChatError(error, { modelLabel = "", now = new Date() } = {}) {
  const category = classifyChatError(error);
  const model = typeof error?.model === "string" && error.model.trim()
    ? error.model.trim()
    : String(modelLabel || "").trim();
  const resetText = formatResetTime(error?.resetAt, now);

  let title = "Something went wrong";
  let message = "Something went wrong. Please try again.";
  let retry = true;
  let canSwitchModel = true;

  if (category === "persist") {
    title = "Answer not saved";
    message = "Your answer is complete, but it couldn't be saved to your history. Copy or download it now.";
    retry = false;
    canSwitchModel = false;
  } else if (category === "quota") {
    title = "Usage limit reached";
    message = resetText
      ? `This model's usage limit is reached. It should reset ${resetText}.`
      : "This model's usage limit is reached. Reset time unavailable.";
    retry = false;
  } else if (category === "rate_limit") {
    title = "Model is busy";
    message = resetText
      ? `This model is busy. Try again ${resetText} or choose another model.`
      : "This model is busy. Try again shortly or choose another model.";
  } else if (category === "auth") {
    title = "API key needed";
    message = "Add or update this provider's API key in Settings.";
    retry = false;
  } else if (category === "vision") {
    title = "Images not supported";
    message = "This model can't read images. Choose a vision model.";
    retry = false;
  } else if (category === "context") {
    title = "Conversation too long";
    message = "This chat is too long for this model. Start a new chat or choose a larger model.";
    retry = false;
  } else if (category === "model") {
    title = "Model unavailable";
    message = "This model isn't available. Choose another.";
    retry = false;
  } else if (category === "timeout") {
    title = "Request timed out";
    message = "That took too long. Try again.";
  } else if (category === "oversize") {
    title = "Request too long";
    message = "Your request is too long. Shorten it and try again.";
    retry = false;
  } else if (category === "empty") {
    title = "No answer";
    message = "The model returned no answer. Try again or switch models.";
  } else if (category === "network") {
    title = "Connection problem";
    message = "Couldn't reach VupsRouter. Check your connection and try again.";
  } else if (category === "unavailable") {
    title = "Provider unavailable";
    message = "This provider is unavailable. Try again shortly.";
  } else if (category === "stream") {
    title = "Response stopped";
    message = "The response stopped early. Continue or retry.";
  } else if (category === "policy") {
    title = "Request blocked";
    message = "This model declined the request. Rephrase it or choose another model.";
    retry = false;
  }

  return {
    category,
    title,
    message,
    model,
    resetAt: resetText ? error.resetAt : "",
    resetText,
    retry,
    canSwitchModel,
    requestId: typeof error?.requestId === "string" ? error.requestId : ""
  };
}
