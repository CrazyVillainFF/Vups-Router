import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyChatError,
  CONTINUE_NEW_CHAT_ACTION,
  formatResetTime,
  isFirewallBlockedResponse,
  presentChatError,
  REQUEST_BLOCKED_MESSAGE,
  REQUEST_BLOCKED_TITLE
} from "../src/chat/chatErrors.js";

const RENDER_WAF_PAGE = [
  "<!DOCTYPE html>",
  "<html><head><title>403 - Forbidden</title></head><body>",
  "<h1>403 - Forbidden</h1>",
  "<p>Your request was blocked by this site's web application firewall (WAF).</p>",
  "<p>Request ID: a507fc25be148632</p>",
  "<p>Powered by Render.</p>",
  "</body></html>"
].join("");

function error(overrides = {}) {
  return { message: "The provider could not complete the request.", ...overrides };
}

test("quota exhaustion is classified separately from a transient rate limit", () => {
  assert.equal(classifyChatError(error({ code: "quota_exhausted", message: "Quota exceeded for this model." })), "quota");
  assert.equal(classifyChatError(error({ code: "insufficient_credits", status: 402 })), "quota");
  assert.equal(classifyChatError(error({ code: "rate_limited", status: 429 })), "rate_limit");
  assert.equal(classifyChatError(error({ message: "Too many requests. Please retry later.", status: 429 })), "rate_limit");
});

test("a transient upstream 429 that mentions quota is still a rate limit", () => {
  const upstream = error({
    code: "rate_limited",
    status: 429,
    model: "recursive/flint-v1.0:free",
    message:
      "Rate limit or quota exceeded (HTTP 429). Wait a moment and try again. Provider said: recursive/flint-v1.0:free is temporarily rate-limited upstream."
  });
  assert.equal(classifyChatError(upstream), "rate_limit");
  const presentation = presentChatError(upstream);
  assert.equal(presentation.title, "Model is busy");
  assert.equal(presentation.model, "recursive/flint-v1.0:free");
  assert.doesNotMatch(presentation.message, /usage limit|reset time/i);
});

test("explicit quota and shared-rate codes keep their own categories", () => {
  assert.equal(
    classifyChatError(error({ code: "quota_exhausted", status: 429, message: "Rate limit reached." })),
    "quota"
  );
  assert.equal(
    classifyChatError(error({ code: "shared_quota_exhausted", status: 429 })),
    "quota"
  );
  assert.equal(
    classifyChatError(error({ code: "quota_exceeded", status: 429 })),
    "quota"
  );
  assert.equal(
    classifyChatError(error({ code: "shared_model_rate_limited", status: 429 })),
    "rate_limit"
  );
  assert.equal(
    classifyChatError(error({ code: "omniroute_insufficient_credits", status: 402 })),
    "quota"
  );
});

test("authentication, context, model, network, and empty failures get distinct types", () => {
  assert.equal(classifyChatError(error({ code: "invalid_api_key", status: 401 })), "invalid_api_key");
  assert.equal(classifyChatError(error({ code: "context_length_exceeded" })), "context_limit");
  assert.equal(classifyChatError(error({ code: "invalid_model", message: "The model does not exist." })), "model");
  assert.equal(classifyChatError(error({ code: "network_error", status: null })), "network_error");
  assert.equal(classifyChatError(error({ code: "empty_stream" })), "empty");
});

test("provider service outages are not mislabeled as a missing model", () => {
  assert.equal(
    classifyChatError(error({ code: "shared_unavailable", message: "The shared AI model is temporarily unavailable." })),
    "server_error"
  );
});

test("reset times are rendered in the viewer's local timezone", () => {
  const now = new Date(2026, 9, 25, 9, 0, 0);
  const laterToday = new Date(2026, 9, 25, 15, 30, 0);
  const tomorrow = new Date(2026, 9, 26, 8, 5, 0);
  const nextMonth = new Date(2026, 10, 3, 18, 45, 0);
  assert.match(formatResetTime(laterToday.toISOString(), now), /^today at /);
  assert.match(formatResetTime(tomorrow.toISOString(), now), /^tomorrow at /);
  assert.match(formatResetTime(nextMonth.toISOString(), now), /^on .*Nov.* at /);
  assert.equal(formatResetTime("not-a-date", now), "");
  assert.equal(formatResetTime(null, now), "");
});

test("quota errors show the affected model and never invent a reset time", () => {
  const presentation = presentChatError(
    error({ code: "quota_exhausted", status: 429, model: "free-model-x" }),
    { modelLabel: "Selected Model" }
  );
  assert.equal(presentation.title, "Usage limit reached");
  assert.equal(presentation.model, "free-model-x");
  assert.match(presentation.message, /Reset time not provided by provider/i);
  assert.equal(presentation.resetAt, "");
  assert.equal(presentation.retry, false);
  assert.equal(presentation.canSwitchModel, true);
});

test("a reliable Retry-After reset is shown as a local time", () => {
  const now = new Date(2026, 9, 25, 9, 0, 0);
  const resetAt = new Date(2026, 9, 25, 9, 17, 0).toISOString();
  const presentation = presentChatError(
    error({ code: "rate_limited", status: 429, resetAt, retryAfterSeconds: 1020, resetSource: "retry-after" }),
    { now, modelLabel: "My Model" }
  );
  assert.equal(presentation.category, "rate_limit");
  assert.equal(presentation.model, "My Model");
  assert.match(presentation.message, /today at /);
  assert.equal(presentation.retry, true);
});

test("auth and invalid-model failures do not offer a pointless retry but keep model switching", () => {
  const auth = presentChatError(error({ code: "invalid_api_key", status: 401 }));
  assert.equal(auth.retry, false);
  assert.equal(auth.canSwitchModel, true);
  const model = presentChatError(error({ code: "invalid_model" }));
  assert.equal(model.retry, false);
  assert.equal(model.canSwitchModel, true);
});

test("the presented copy is concise and does not echo provider internals", () => {
  const presentation = presentChatError(
    error({ code: "provider_error", message: "upstream host internal-key-123 failed with stack trace at line 42" })
  );
  assert.doesNotMatch(presentation.message, /internal-key-123|stack trace/);
  assert.ok(presentation.title.length < 40);
  assert.ok(presentation.message.length < 180);
});

test("backend size limits are explained without surfacing raw validation text", () => {
  assert.equal(
    classifyChatError(error({ message: "A single message cannot exceed 32000 characters.", status: 400 })),
    "oversize"
  );
  assert.equal(
    classifyChatError(error({ message: "The conversation is too large. Start a new chat or shorten your messages.", status: 400 })),
    "context_limit"
  );
  assert.equal(
    classifyChatError(error({
      message: "A single assistant message is too large to replay. Start a new chat or continue from the saved code artifact.",
      status: 400
    })),
    "context_limit"
  );
  assert.equal(
    classifyChatError(error({ message: "A request can contain at most 60 messages.", status: 400 })),
    "context_limit"
  );
});

test("an edge firewall rejection is its own outcome and never an access denial", () => {
  assert.equal(isFirewallBlockedResponse("text/html; charset=UTF-8", RENDER_WAF_PAGE), true);
  // Only HTML WAF pages qualify; JSON and generic HTML error pages do not.
  assert.equal(
    isFirewallBlockedResponse("application/json", '{"message":"blocked by this site\'s web application firewall (WAF)"}'),
    false
  );
  assert.equal(isFirewallBlockedResponse("text/html", "<html><body>403 - Forbidden</body></html>"), false);
  assert.equal(isFirewallBlockedResponse("text/html", ""), false);
  assert.equal(isFirewallBlockedResponse("text/html", null), false);

  assert.equal(
    classifyChatError({ status: 403, code: "request_blocked", message: REQUEST_BLOCKED_MESSAGE }),
    "request_blocked"
  );

  const presentation = presentChatError({
    status: 403,
    code: "request_blocked",
    message: REQUEST_BLOCKED_MESSAGE,
    model: "gpt-oss:120b"
  });
  assert.equal(presentation.title, REQUEST_BLOCKED_TITLE);
  assert.equal(presentation.title, "Let's continue in a new chat");
  assert.equal(presentation.message, REQUEST_BLOCKED_MESSAGE);
  assert.equal(
    presentation.message,
    "This conversation can't continue in its current state. You can start a fresh chat and pick up where you left off."
  );
  assert.equal(CONTINUE_NEW_CHAT_ACTION, "Continue with New Chat");
  assert.equal(presentation.retry, false);
  assert.equal(presentation.canSwitchModel, false);
  assert.doesNotMatch(
    presentation.message,
    /firewall|WAF|blocked|rejected|security|filter|request id|diagnostic|api key|another model|provider denied|Access denied/i
  );
});

test("an uncategorised provider rejection shows the provider's own sentence", () => {
  const presentation = presentChatError({
    status: 400,
    code: "bad_request",
    model: "deepseek-flash",
    message: "The provider rejected the request (HTTP 400). Provider said: Field 'model' must reference an available model."
  });
  assert.equal(presentation.category, "unknown_error");
  assert.equal(presentation.title, "The provider refused this request");
  assert.equal(presentation.message, "Field 'model' must reference an available model.");
  assert.equal(presentation.retry, false);
});

test("a rejection without a provider sentence keeps the ordinary fallback", () => {
  const presentation = presentChatError({ status: 500, code: "unexpected", message: "Something broke." });
  assert.equal(presentation.title, "Something went wrong");
  assert.equal(presentation.message, "Something went wrong. Please try again.");
  assert.equal(presentation.retry, true);
});

test("a 402 is reported as out of credits, not as a daily usage limit", () => {
  const presentation = presentChatError({
    status: 402,
    code: "insufficient_credits",
    model: "qfmodel",
    message:
      "Your provider account has insufficient credits (HTTP 402). Provider said: You have no available credit. Please renew your plan or purchase a resource package to continue."
  });
  assert.equal(presentation.category, "quota");
  assert.equal(presentation.title, "Out of credits");
  assert.equal(
    presentation.message,
    "You have no available credit. Please renew your plan or purchase a resource package to continue."
  );
  assert.doesNotMatch(presentation.message, /reset time not provided/i);
});

test("OpenRouter's documented free-tier daily limit says when it resets", () => {
  const presentation = presentChatError({
    status: 429,
    code: "quota_exhausted",
    model: "recursive/flint-v1.0:free",
    message:
      "The provider account has reached its usage limit (HTTP 429). Provider said: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
    diagnostic: { limitSource: "openrouter_free_tier_daily" }
  });
  assert.equal(presentation.category, "quota");
  assert.equal(presentation.title, "Free-model limit reached");
  assert.match(presentation.message, /midnight UTC/);
  assert.equal(presentation.retry, false);
});

test("a quota failure from another provider keeps the generic usage-limit card", () => {
  const presentation = presentChatError({ status: 429, code: "quota_exhausted", message: "Quota exhausted." });
  assert.equal(presentation.title, "Usage limit reached");
  assert.equal(presentation.message, "This model's usage limit is reached. Reset time not provided by provider.");
});
