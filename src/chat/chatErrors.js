const QUOTA_PATTERN = /quota|credit|billing|insufficient|allowance|usage limit|out of tokens|payment required/i;
const RATE_PATTERN = /rate.?limit|too many requests|requests per|try again (?:in|shortly)|overloaded/i;
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|api key/i;
const CONTEXT_PATTERN = /context (?:length|window)|too many tokens|prompt is too long|maximum context|token limit/i;
const MODEL_PATTERN = /model.*(?:not found|unavailable|does not exist|not available|invalid)|invalid model|unknown model|no such model|not one of your saved/i;
const POLICY_PATTERN = /content policy|safety|moderation|blocked|violat/i;

function hasPattern(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

export function classifyChatError(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "");
  const status = Number(error?.status);
  const combined = `${code} ${message}`;

  if (hasPattern(combined, QUOTA_PATTERN) || code === "insufficient_quota" || code === "quota_exhausted" || code === "billing_error") {
    return "quota";
  }
  if (status === 429 || hasPattern(combined, RATE_PATTERN) || code === "rate_limited" || code === "rate_limit_error") {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || hasPattern(combined, AUTH_PATTERN) || code === "unauthorized" || code === "invalid_api_key") {
    return "auth";
  }
  if (code.endsWith("_unavailable") || code === "provider_unavailable" || code === "shared_unavailable") {
    return "unavailable";
  }
  if (hasPattern(combined, CONTEXT_PATTERN) || code === "context_length_exceeded") return "context";
  if (hasPattern(combined, MODEL_PATTERN) || code === "invalid_model" || code === "model_not_found") return "model";
  if (code === "empty_response" || code === "empty_stream") return "empty";
  if (code === "stream_interrupted" || code === "stream_error") return "stream";
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
  const resetHint = resetText ? `It should be available again ${resetText}.` : "";

  let title = "Request failed";
  let message = "The model could not complete this request. Try again or choose another model.";
  let retry = true;

  if (category === "quota") {
    title = "Usage limit reached";
    message = resetHint
      ? `This model's usage allowance has been used up. ${resetHint}`
      : "This model's usage allowance has been used up. No reliable reset time was provided.";
    retry = false;
  } else if (category === "rate_limit") {
    title = "Too many requests";
    message = resetHint
      ? `The provider is temporarily limiting requests. ${resetHint}`
      : "The provider is temporarily limiting requests. Try again shortly or choose another model.";
  } else if (category === "auth") {
    title = "Provider authentication failed";
    message = "The saved API key for this provider was rejected. Update it in API settings, or choose another model.";
    retry = false;
  } else if (category === "context") {
    title = "Conversation too long";
    message = "This chat is too long for the selected model. Start a new chat or choose a model with a larger context window.";
    retry = false;
  } else if (category === "model") {
    title = "Model unavailable";
    message = "This model is not available for the selected provider. Choose another model from the model menu.";
    retry = false;
  } else if (category === "empty") {
    title = "No response";
    message = "The model returned an empty response. Try again or choose another model.";
  } else if (category === "network") {
    title = "Connection problem";
    message = "The VupsRouter backend could not be reached. Check your connection and try again.";
  } else if (category === "unavailable") {
    title = "Model service unavailable";
    message = "The model service is temporarily unavailable. Try again shortly or choose another model.";
  } else if (category === "stream") {
    title = "Response interrupted";
    message = "The response stream ended early. Try again or choose another model.";
  } else if (category === "policy") {
    title = "Request blocked";
    message = "The provider declined this request. Rephrase it or choose another model.";
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
    canSwitchModel: true,
    requestId: typeof error?.requestId === "string" ? error.requestId : ""
  };
}
