import { contextModelName, isContextLimitError } from "./contextLimit.js";

// A provider can say "rate limit or quota" in one sentence without meaning
// that the account is out of quota. Only explicit exhaustion wording counts;
// the machine-readable code is checked first below.
const QUOTA_PATTERN = /insufficient (?:quota|credits?|balance|funds)|credits? (?:are )?(?:exhausted|depleted|used up)|credit balance|billing (?:hard )?limit|payment required|exceeded (?:your|the) (?:current )?quota|quota (?:is )?(?:exhausted|depleted)|out of quota|usage limit|out of tokens|allowance|free-models-per-day|free models per day|requests per day|tokens per day|\bRPD\b|\bTPD\b|monthly limit|daily limit|per[- ]day/i;
const RATE_PATTERN = /rate.?limit|too many requests|requests per|try again (?:in|shortly)|overloaded|concurrency limit|token-per-minute/i;
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "insufficient_credits",
  "quota_exhausted",
  "quota_exceeded",
  "daily_quota_exceeded",
  "free_quota_exhausted",
  "shared_quota_exhausted",
  "vups_quota_exhausted",
  "omniroute_insufficient_credits",
  "billing_error",
  "billing_hard_limit",
  "payment_required"
]);
const RATE_CODES = new Set([
  "rate_limited",
  "rate_limit_error",
  "rate_limit_requests",
  "rate_limit_tokens",
  "concurrency_limit",
  "ambiguous_rate_limit",
  "shared_model_rate_limited",
  "vups_rate_limited",
  "vups_token_rate_limited",
  "vups_concurrency_limited",
  "omniroute_rate_limited"
]);
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
  "eof_without_terminal",
  "cancelled"
]);

const OVERSIZE_CODES = new Set([
  "too_large",
  "response_too_large",
  "artifact_too_large",
  "continuation_too_large",
  "request_too_large"
]);
const OVERSIZE_PATTERN = /cannot exceed \d+ characters/i;

// Backend request validation. These sentences are written for users, so they
// can be shown as-is instead of collapsing into "Something went wrong".
const VALIDATION_PATTERN =
  /message content cannot be empty|last message must come from the user|images can only be attached|messages must be a non-empty array|content must be a string|role must be|unsupported image|too many images|message id/i;
// A shipped shell talking to a server that does not know its origin. The
// provider is not involved, so it must not read as a provider denial.
const ORIGIN_BLOCKED_PATTERN = /origin not allowed/i;
// The backend relays the provider's own sentence after "Provider said:". When no
// category fits, that sentence is real evidence and must not be replaced by an
// invented apology. The relay is already sanitised and length-capped server side.
const PROVIDER_RELAY = /Provider said:\s*(.+)$/i;
const CREDIT_CODES = new Set(["insufficient_credits", "billing_hard_limit", "payment_required", "billing_error"]);
// OpenRouter documents this limit source on the 429 it returns for free models.
const OPENROUTER_FREE_DAILY = "openrouter_free_tier_daily";

function providerSaid(error) {
  const match = String(error?.message || "").match(PROVIDER_RELAY);
  return (match?.[1] || "").trim().slice(0, 300);
}

// Qoder Cloud Agents keeps the conversation on its own side, so its failures
// name a session, a scope or a workspace object rather than a model. These codes
// are only ever produced by that adapter, and the backend's own sentence for
// them states the fix, so it is shown instead of a invented generic card.
const SESSION_BUSY_CODES = new Set(["session_busy"]);
const SESSION_STATE_CODES = new Set(["provider_conflict", "qoder_no_session"]);
const PROVIDER_SCOPE_CODES = new Set(["insufficient_scope"]);
const PROVIDER_SETUP_CODES = new Set(["qoder_no_environment", "qoder_no_agent"]);

function backendAdvice(error) {
  return String(error?.message || "").trim().slice(0, 300);
}

// The shared catalog answers with its own codes. Each one needs a different
// next action, so none of them may fall through to the generic card.
const SHARED_MODEL_CODES = new Set(["shared_model_unavailable"]);
const SHARED_REJECTED_CODES = new Set(["shared_request_rejected"]);
const SHARED_CONFIG_CODES = new Set(["shared_auth_failed", "shared_disabled", "shared_not_configured"]);

// Desktop local-file tools are a client/server feature pair. When the server
// half is missing the user's message is still valid, so it must not read as a
// model outage or a generic failure.
const DESKTOP_TOOL_CODES = new Set(["desktop_tools_unavailable", "desktop_chat_failed", "invalid_tool_response"]);

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
  // Codes are authoritative. A provider's 429 message often mentions both
  // "rate limit" and "quota"; only an explicit exhaustion code or status 402
  // may become the quota card. This prevents a transient upstream 429 from
  // being reported as a fabricated usage limit.
  if (status === 402 || QUOTA_CODES.has(code)) return "quota";
  if (RATE_CODES.has(code)) return "rate_limit";
  if (hasPattern(combined, QUOTA_PATTERN)) return "quota";
  if (status === 429 || hasPattern(combined, RATE_PATTERN)) return "rate_limit";
  // Before the credential branch: an unallowlisted app origin answers 403, but
  // no provider key or permission is involved.
  if (hasPattern(message, ORIGIN_BLOCKED_PATTERN)) return "origin_blocked";
  // Also before the credential branch: Qoder answers 403 for a credential that
  // is valid but lacks the Cloud Agents scope, and 409 for a session that is
  // busy or wedged. None of those are fixed by pasting a new key.
  if (SESSION_BUSY_CODES.has(code)) return "session_busy";
  if (SESSION_STATE_CODES.has(code)) return "session_conflict";
  if (PROVIDER_SCOPE_CODES.has(code)) return "provider_scope";
  if (PROVIDER_SETUP_CODES.has(code)) return "provider_setup";
  if (status === 400 && hasPattern(combined, VALIDATION_PATTERN)) return "request_invalid";
  // Before the credential branch: the shared-catalog messages mention a key,
  // but the user has no key to fix — the server does.
  if (SHARED_MODEL_CODES.has(code)) return "model";
  if (SHARED_REJECTED_CODES.has(code)) return "request_rejected";
  if (SHARED_CONFIG_CODES.has(code)) return "shared_config";
  if (status === 401 || status === 403 || hasPattern(combined, AUTH_PATTERN) || code === "unauthorized" || code === "invalid_api_key") {
    if (!isMissingApiKeyError(error)) return "access_denied";
    return isMissingKeyEvidence(error) ? "missing_api_key" : "invalid_api_key";
  }
  // After the credential branch so an expired session keeps its own card.
  // Anything the desktop tool service raised is about local tools, whatever code
  // the server attached, so a new server-side failure cannot become "Something
  // went wrong".
  if (DESKTOP_TOOL_CODES.has(code) || code === "tool_round_limit" || error?.name === "DesktopChatError") {
    return "desktop_tools";
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
    const limitSource = String(error?.diagnostic?.limitSource || "");
    if (CREDIT_CODES.has(code)) {
      title = "Out of credits";
      message =
        providerSaid(error) ||
        "Your provider account has no credit left for this model. Top it up with the provider, or choose another model.";
    } else if (limitSource === OPENROUTER_FREE_DAILY) {
      title = "Free-model limit reached";
      message =
        "OpenRouter only allows a fixed number of free-model requests per day for accounts without credits. The limit resets at midnight UTC, or add credits to lift it.";
    } else {
      title = "Usage limit reached";
      message = resetText
        ? `This model's usage limit is reached. It should reset ${resetText}.`
        : "This model's usage limit is reached. Reset time not provided by provider.";
    }
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
  } else if (category === "session_busy") {
    title = "Qoder is still answering";
    message =
      backendAdvice(error) ||
      "Qoder is still working on the previous reply here. Wait for it to finish, or press Stop and send again.";
    canSwitchModel = false;
  } else if (category === "session_conflict") {
    title = "Qoder's session is stuck";
    message =
      backendAdvice(error) ||
      "Qoder's session for this conversation can't continue from its current state. Start a new chat and send it again.";
    retry = false;
    canSwitchModel = false;
  } else if (category === "provider_scope") {
    title = "Qoder credential lacks access";
    message =
      backendAdvice(error) ||
      "The saved Qoder credential cannot use Cloud Agents. Create a new token that allows it in Settings.";
    retry = false;
  } else if (category === "provider_setup") {
    title = "Qoder has nothing to run this on";
    message =
      backendAdvice(error) ||
      "Qoder Cloud Agents has no environment or agent for this account. Create one in your Qoder console and retry.";
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
    message = model
      ? `${model} is not available right now. Pick another model from the menu, or add your own provider key in Settings.`
      : "This model is unavailable. Try another model.";
    retry = false;
  } else if (category === "request_rejected") {
    title = "Request rejected";
    message = model
      ? `${model} rejected this request as invalid. Sending it again will not change the outcome — pick another model, or start a new chat.`
      : "This model rejected the request as invalid. Sending it again will not change the outcome — pick another model, or start a new chat.";
    retry = false;
  } else if (category === "shared_config") {
    title = "Shared models unavailable";
    message =
      "The shared model service is not working on the server, so no shared model will answer right now. Add your own provider key in Settings, or contact your administrator.";
    retry = false;
  } else if (category === "request_invalid") {
    title = "Message not sent";
    message =
      "This message was rejected before it reached the model, so nothing was sent. Start a new chat, or remove the attachment that triggered it and send it again.";
    retry = false;
    canSwitchModel = false;
  } else if (category === "origin_blocked") {
    title = "This app cannot reach the server";
    message =
      "The VupsRouter server does not accept requests from this app address. Update to the latest build, or open VupsRouter in your browser instead.";
    retry = false;
    canSwitchModel = false;
  } else if (category === "desktop_tools") {
    title = "Local file tools unavailable";
    message =
      code === "tool_round_limit"
        ? "The assistant used too many local file steps for one request. Ask for fewer files, or send the request again without the workspace folder."
        : "The local file tools could not run against the connected server, so nothing was read from your workspace. Send the message again, or remove the workspace folder to chat without tools.";
    canSwitchModel = false;
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
  } else if (category === "unknown_error" && providerSaid(error)) {
    // No category fit, but the provider explained the failure in its own words.
    // Those words are evidence; replacing them with "please try again" sends the
    // user back to the same rejected request.
    title = "The provider refused this request";
    message = providerSaid(error);
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
    requestId: typeof error?.requestId === "string" ? error.requestId : "",
    resetSource: typeof error?.resetSource === "string" ? error.resetSource : "",
    retryAfterSeconds: Number.isFinite(error?.retryAfterSeconds) ? error.retryAfterSeconds : null
  };
}
