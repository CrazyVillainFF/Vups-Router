import test from "node:test";
import assert from "node:assert/strict";
import { classifyChatError, formatResetTime, presentChatError } from "../src/chat/chatErrors.js";

function error(overrides = {}) {
  return { message: "The provider could not complete the request.", ...overrides };
}

test("quota exhaustion is classified separately from a transient rate limit", () => {
  assert.equal(classifyChatError(error({ code: "quota_exhausted", message: "Quota exceeded for this model." })), "quota");
  assert.equal(classifyChatError(error({ code: "insufficient_credits", status: 402 })), "quota");
  assert.equal(classifyChatError(error({ code: "rate_limited", status: 429 })), "rate_limit");
  assert.equal(classifyChatError(error({ message: "Too many requests. Please retry later.", status: 429 })), "rate_limit");
});

test("authentication, context, model, network, and empty failures get distinct types", () => {
  assert.equal(classifyChatError(error({ code: "invalid_api_key", status: 401 })), "auth");
  assert.equal(classifyChatError(error({ code: "context_length_exceeded" })), "context");
  assert.equal(classifyChatError(error({ code: "invalid_model", message: "The model does not exist." })), "model");
  assert.equal(classifyChatError(error({ code: "network_error", status: null })), "network");
  assert.equal(classifyChatError(error({ code: "empty_stream" })), "empty");
});

test("provider service outages are not mislabeled as a missing model", () => {
  assert.equal(
    classifyChatError(error({ code: "shared_unavailable", message: "The shared AI model is temporarily unavailable." })),
    "unavailable"
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
  assert.match(presentation.message, /No reliable reset time/i);
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
