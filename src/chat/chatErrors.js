import { contextModelName, isContextLimitError } from "./contextLimit.js";

const QUOTA_PATTERN = /quota|credits? (?:are )?(?:exhausted|depleted|used up)|insufficient (?:quota|credits?|balance|funds)|billing|payment required|usage limit|out of tokens|allowance/i;
const RATE_PATTERN = /rate.?limit|too many requests|requests per|try again (?:in|shortly)|overloaded|concurrency limit|token-per-minute/i;
// Match credential failures, not every sentence that happens to mention a key.
// The proxy's bare HTTP 400 fallback says "Check the API key, model ID, and API
// base URL"; that is a generic rejection, not evidence of a missing key.
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid (?:api )?key|missing (?:api )?key|api key (?:is )?(?:missing|invalid|expired|revoked|required)|api key required|no (?:api )?key (?:configured|set)|requires an api key|add or update (?:this )?provider'?s api key|rejected your api key|authentication (?:failed|required)|key_decryption/i;
const API_KEY_PATTERN = /invalid (?:api )?key|missing (?:api )?key|api key (?:is )?(?:missing|invalid|expired|revoked|required)|api key required|no (?:api )?key (?:configured|set)|requires an api key|add or update (?:this )?provider'?s api key|rejected your api key|key_decryption/i;
const MISSING_KEY_PATTERN = /missing (?:api )?key|no (?:api )?key (?:configured|set)|requires an api key|api key (?:is )?(?:missing|required|not configured)|api key required|add or update (?:this )?provider'?s api key/i;
const MISSING_KEY_CODES = new Set(["missing_api_key", "api_key_missing", "no_api_key"]);
const API_KEY_CODES = new Set([
  ...MISSING_KEY_CODES,
  "invalid_api_key",
  "key_decryption",
  "key_decryption_failed"
]);
const MODEL_PATTERN = /model.*(?:not found|unavailable|does not exist|not available|invalid)|invalid model|unknown model|no such model|not one of your saved/i;
const POLICY_PATTERN = /content policy|safety|moderation|blocked|violat/i;
const VISION_PATTERN = /image input|vision|does not accept image|support image|could not read that image/i;
const FIREWALL_PATTERN = /web application firewall|\bWAF\b/i;
const FIREWALL_PAGE_PATTERN = /403\s*-\s*Forbidden|Request ID:|Powered by Render/i;

export const REQUEST_BLOCKED_TITLE = "Let's continue in a new chat";
export const REQUEST_BLOCKED_MESSAGE =
  "This conversation can't continue in its current state. You can start a fresh chat and pick up where you left off.";
export const CONTINUE_NEW_CHAT_ACTION = "Continue with New Chat";

/**
 * Edge firewalls answer with an HTML page, not the JSON error contract. Treat a
 * WAF rejection as its own outcome so it is never reported as a provider or
 * credential failure.
 */
export function isFirewallBlockedResponse(contentType, body) {
  if (typeof body !== "string" || !body) return false;
  const type = String(contentType || "").toLowerCase();
  const looksHtml = type.includes("text/html") || /<html[\s>]/i.test(body);
  if (!looksHtml) return false;
  return FIREWALL_PATTERN.test(body) && FIREWALL_PAGE_PATTERN.test(body);
}

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

/**
 * Only provider authentication failures that actually mention a missing or
 * invalid key get the API-key recovery card. A generic 401/403 (for example a
 * disabled account) still falls back to the ordinary error card.
 */
function isMissingKeyEvidence(error) {
  const code = normalizedCode(error);
  if (MISSING_KEY_CODES.has(code)) return true;
  return hasPattern(String(error?.message || ""), MISSING_KEY_PATTERN);
}

export function isMissingApiKeyError(error) {
  if (!error) return false;
  const code = normalizedCode(error);
  if (API_KEY_CODES.has(code)) return true;
  return hasPattern(String(error?.message || ""), API_KEY_PATTERN);
}

/**
 * Single normalized taxonomy shared by JSON errors, stream errors, and local
 * fallbacks. Internal branches may still be more specific (quota, timeout,
 * oversize), but these are the categories the UI depends on.
 */
export function classifyChatError(error) {
  const code = normalizedCode(error);
  const message = String(error?.message || "");
  const status = Number(error?.status);
  const combined = `${code} ${message}`;

  if (isPersistenceFailureCode(code)) return "persist";
  // Context evidence always wins, including when a provider wraps it in 401/403.
  if (isContextLimitError(error)) return "context_limit";
  if (code === "request_blocked" || code === "firewall_blocked" || code === "vups_request_blocked") {
    return "request_blocked";
  }
  if (hasPattern(combined, VISION_PATTERN) || ["vision_unsupported", "vups_vision_rejected", "image_unsupported"].includes(code)) {
    return "vision";
  }
  if (code === "connection_unavailable" || code === "network_error") return "network_error";
  if (code === "timeout" || code === "request_timeout" || code === "vups_timeout" || status === 504) return "timeout";
  if (OVERSIZE_CODES.has(code) || status === 413 || hasPattern(combined, OVERSIZE_PATTERN)) return "oversize";
  if (hasPattern(combined, QUOTA_PATTERN) || ["insufficient_quota", "insufficient_credits", "quota_exhausted", "billing_error", "vups_quota_exhausted"].includes(code)) {
    return "quota";
  }
  if (status === 429 || hasPattern(combined, RATE_PATTERN) || code === "rate_limited" || code === "rate_limit_error") {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || hasPattern(combined, AUTH_PATTERN) || code === "unauthorized" || code === "invalid_api_key") {
    if (!isMissingApiKeyError(error)) return "access_denied";
    return isMissingKeyEvidence(error) ? "missing_api_key" : "invalid_api_key";
  }
  if (code.endsWith("_unavailable") || code === "provider_unavailable" || code === "upstream_unavailable") {
    return "server_error";
  }
  if (hasPattern(combined, MODEL_PATTERN) || code === "invalid_model" || code === "model_not_found") return "model";
  if (code === "empty_response" || code === "empty_stream") return "empty";
  if (code === "stream_interrupted" || code === "stream_error" || INTERRUPTED_CODES.has(code)) return "stream";
  if (code === "network_error" || hasPattern(message, /could not reach|network|connection/i)) return "network_error";
  if (hasPattern(combined, POLICY_PATTERN) || code === "content_policy_violation") return "policy";
  return "unknown_error";
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
  const code = normalizedCode(error);
  const model = contextModelName(error, modelLabel);
  const resetText = formatResetTime(error?.resetAt, now);
  const apiKey =
    (category === "missing_api_key" || category === "invalid_api_key") &&
    code !== "ai_disabled";

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
  } else if (category === "missing_api_key" || category === "invalid_api_key") {
    title = "API key required";
    message = model
      ? `The selected model (${model}) requires an API key. Add or update the provider's API key in Settings, or choose another model.`
      : "This provider requires an API key. Add or update the provider's API key in Settings, or choose another model.";
    retry = false;
  } else if (category === "access_denied") {
    if (code === "ai_disabled") {
      title = "Chat unavailable";
      message = "AI chat is disabled for your account. Contact your administrator.";
    } else {
      title = "Access denied";
      message = "The provider denied this request. Check its permissions in Settings, or choose another model.";
    }
    retry = false;
  } else if (category === "request_blocked") {
    title = REQUEST_BLOCKED_TITLE;
    message = REQUEST_BLOCKED_MESSAGE;
    retry = false;
    canSwitchModel = false;
  } else if (category === "vision") {
    title = "Images not supported";
    message = "This model can't read images. Choose a vision model.";
    retry = false;
  } else if (category === "context_limit") {
    title = "This chat is too long";
    message = "This chat is too long. Continue in a new chat to keep going.";
    retry = false;
    canSwitchModel = false;
  } else if (category === "model") {
    title = "Model unavailable";
    message = "This model is unavailable. Try another model.";
    retry = false;
  } else if (category === "timeout") {
    title = "Request timed out";
    message = "This is taking too long. Try again.";
  } else if (category === "oversize") {
    title = "Request too long";
    message = "Your request is too long. Shorten it and try again.";
    retry = false;
  } else if (category === "empty") {
    title = "No answer";
    message = "No answer received. Please try again.";
  } else if (category === "network_error") {
    title = "Connection problem";
    message = "Can't connect to Vups Router. Try again shortly.";
  } else if (category === "server_error") {
    title = "Model unavailable";
    message = "This model is unavailable. Try another model.";
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
    apiKey,
    requestId: typeof error?.requestId === "string" ? error.requestId : ""
  };
}
