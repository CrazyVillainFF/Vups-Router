import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildContextHandoff,
  CONTEXT_HANDOFF_LABEL,
  CONTEXT_HANDOFF_PREFIX,
  contextHandoffGoal,
  isContextHandoffContent,
  isContextLimitError,
  MAX_HANDOFF_CHARS
} from "../src/chat/contextLimit.js";
import {
  classifyChatError,
  isMissingApiKeyError,
  presentChatError
} from "../src/chat/chatErrors.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function providerError(message, overrides = {}) {
  return { message, ...overrides };
}

test("provider context-window failures are recognized across common providers", () => {
  const cases = [
    providerError("", { code: "context_length_exceeded" }),
    providerError("prompt is too long: 250000 tokens > 200000 maximum"),
    providerError("This model's maximum context length is 4097 tokens. However, your messages resulted in 5000 tokens."),
    providerError("The input token count (300000) exceeds the maximum number of tokens allowed (200000)."),
    providerError("input length exceeds the context length"),
    providerError("The conversation is too large. Start a new chat or shorten your messages."),
    providerError("A request can contain at most 60 messages."),
    providerError("A single assistant message is too large to replay.")
  ];
  for (const error of cases) {
    assert.equal(isContextLimitError(error), true, error.message || error.code);
    assert.equal(classifyChatError(error), "context_limit", error.message || error.code);
  }
});

test("message and API-key limits are never misclassified as a context window", () => {
  const oversize = providerError("A single message cannot exceed 32000 characters.", { status: 400 });
  assert.equal(isContextLimitError(oversize), false);
  assert.equal(classifyChatError(oversize), "oversize");

  const missingKey = providerError("Add or update this provider's API key in Settings. Model: beam");
  assert.equal(isContextLimitError(missingKey), false);
  assert.equal(classifyChatError(missingKey), "missing_api_key");
  assert.equal(isMissingApiKeyError(missingKey), true);
});

test("only genuine missing-key failures get the API-key action card", () => {
  assert.equal(isMissingApiKeyError(providerError("", { code: "invalid_api_key" })), true);
  assert.equal(isMissingApiKeyError(providerError("", { code: "missing_api_key" })), true);
  assert.equal(isMissingApiKeyError(providerError("No key configured for this provider.")), true);
  assert.equal(
    isMissingApiKeyError(providerError("AI chat has been disabled for your account by an administrator.", { status: 403 })),
    false
  );
  assert.equal(isMissingApiKeyError(providerError("The model returned no tokens.")), false);
  assert.equal(isMissingApiKeyError(providerError("", { code: "context_length_exceeded" })), false);
});

test("the context alert uses only the compact copy and never claims a key problem", () => {
  const presentation = presentChatError(
    providerError("prompt is too long", { code: "prompt_too_long", model: "beam" }),
    { modelLabel: "fallback-model" }
  );
  assert.equal(presentation.category, "context_limit");
  assert.equal(presentation.title, "This chat is too long");
  assert.equal(
    presentation.message,
    "This chat is too long. Continue in a new chat to keep going."
  );
  assert.doesNotMatch(presentation.message, /api key|settings|another model/i);
  assert.equal(presentation.model, "beam");
  assert.equal(presentation.retry, false);
  assert.equal(presentation.canSwitchModel, false);
  assert.equal(presentation.apiKey, false);
});

test("a bare HTTP 400 with the proxy's API-key fallback is a context limit for a long conversation", () => {
  const generic400 = {
    status: 400,
    message:
      "The provider rejected the request (HTTP 400) and did not include details. Check the API key, model ID, and API base URL.",
    code: "bad_request",
    requestChars: 64000,
    messageCount: 40
  };
  assert.equal(isContextLimitError(generic400), true);
  const presentation = presentChatError(generic400, { modelLabel: "Vups v3 Galax" });
  assert.equal(presentation.category, "context_limit");
  assert.equal(presentation.apiKey, false);
  assert.doesNotMatch(presentation.message, /api key|open settings/i);

  // The same generic rejection on a short request is not evidence of either a
  // context limit or a credential failure.
  const short = { ...generic400, requestChars: 900, messageCount: 2 };
  assert.equal(isContextLimitError(short), false);
  assert.notEqual(classifyChatError(short), "missing_api_key");
  assert.notEqual(classifyChatError(short), "access_denied");
});

test("context details in a diagnostic payload are detected even when the message is generic", () => {
  const error = {
    status: 400,
    message: "The provider rejected the request (HTTP 400).",
    diagnostic: {
      providerErrorCode: "context_length_exceeded",
      providerMessage: "This model's maximum context length is 8192 tokens."
    }
  };
  assert.equal(isContextLimitError(error), true);
  assert.equal(classifyChatError(error), "context_limit");
});

test("a 401/403 credential rejection is never reclassified as a context limit", () => {
  const unauthorized = {
    status: 401,
    message: "The provider rejected your API key (HTTP 401). Check the key in Settings.",
    code: "invalid_api_key",
    requestChars: 90000,
    messageCount: 60
  };
  assert.equal(isContextLimitError(unauthorized), false);
  assert.equal(classifyChatError(unauthorized), "invalid_api_key");
  assert.equal(isMissingApiKeyError(unauthorized), true);
});

test("a 401/403 with explicit provider context evidence is a context limit", () => {
  const cases = [
    {
      status: 403,
      message: "The provider denied access (HTTP 403). Your key may lack permission for this model.",
      code: "forbidden",
      diagnostic: {
        category: "context_limit",
        providerErrorCode: "context_length_exceeded",
        providerMessage: "This model's maximum context length is 131072 tokens."
      }
    },
    {
      status: 403,
      message: "This model's maximum context length is 131072 tokens. However, your messages resulted in 160000 tokens."
    },
    {
      status: 401,
      message: "context_length_exceeded: input is too long for this model"
    }
  ];
  for (const error of cases) {
    assert.equal(isContextLimitError(error), true, error.message);
    const presentation = presentChatError(error, { modelLabel: "gpt-oss:120b" });
    assert.equal(presentation.category, "context_limit");
    assert.equal(presentation.title, "This chat is too long");
    assert.equal(
      presentation.message,
      "This chat is too long. Continue in a new chat to keep going."
    );
    assert.equal(presentation.apiKey, false);
    assert.equal(presentation.canSwitchModel, false);
  }
});

test("a bare 401/403 stays a credential or access error even for a large request", () => {
  const denied = {
    status: 403,
    message: "The provider denied access (HTTP 403). Your key may lack permission for this model.",
    code: "forbidden",
    requestChars: 90000,
    messageCount: 45
  };
  assert.equal(isContextLimitError(denied), false);
  const presentation = presentChatError(denied);
  assert.equal(presentation.category, "access_denied");
  assert.equal(presentation.title, "Access denied");
  assert.doesNotMatch(presentation.message, /too long/i);
  assert.equal(presentation.apiKey, false);

  const key = {
    status: 401,
    message: "The provider rejected your API key (HTTP 401). Check the key in Settings.",
    code: "invalid_api_key"
  };
  assert.equal(classifyChatError(key), "invalid_api_key");
  assert.equal(presentChatError(key).title, "API key required");
});

test("missing-key, rate-limit, network, and server failures keep normalized categories", () => {
  assert.equal(
    classifyChatError({ status: 401, code: "missing_api_key", message: "No key configured for this provider." }),
    "missing_api_key"
  );
  assert.equal(
    classifyChatError({ status: 401, code: "invalid_api_key", message: "Invalid API key provided." }),
    "invalid_api_key"
  );
  assert.equal(classifyChatError({ status: 429, code: "rate_limited" }), "rate_limit");
  assert.equal(classifyChatError({ code: "connection_unavailable" }), "network_error");
  assert.equal(classifyChatError({ code: "vups_upstream_unavailable" }), "server_error");
  assert.equal(classifyChatError({ code: "something_unknown" }), "unknown_error");
});

test("the API-key alert names the selected model and points at Settings", () => {
  const presentation = presentChatError(
    providerError("Add or update this provider's API key in Settings. Model: beam"),
    { modelLabel: "fallback-model" }
  );
  assert.equal(presentation.category, "missing_api_key");
  assert.equal(presentation.title, "API key required");
  assert.match(presentation.message, /^The selected model \(beam\) requires an API key\./);
  assert.match(presentation.message, /Add or update the provider's API key in Settings/);
  assert.match(presentation.message, /choose another model/);
  assert.equal(presentation.retry, false);
  assert.equal(presentation.canSwitchModel, true);
  assert.equal(presentation.apiKey, true);
});

test("a bare generic 400 never renders API-key guidance", () => {
  const presentation = presentChatError({
    status: 400,
    message:
      "The provider rejected the request (HTTP 400) and did not include details. Check the API key, model ID, and API base URL.",
    code: "bad_request",
    requestChars: 800,
    messageCount: 2
  });
  assert.equal(presentation.apiKey, false);
  assert.doesNotMatch(presentation.message, /api key/i);
  assert.notEqual(presentation.title, "API key required");
});

test("ordinary network and server failures retain their existing behavior", () => {
  const offline = presentChatError({ code: "connection_unavailable" });
  assert.equal(offline.category, "network_error");
  assert.equal(offline.title, "Connection problem");
  assert.equal(offline.retry, true);

  const timeout = presentChatError({ code: "vups_timeout" });
  assert.equal(timeout.category, "timeout");
  assert.equal(timeout.title, "Request timed out");

  const outage = presentChatError({ code: "vups_upstream_unavailable" });
  assert.equal(outage.category, "server_error");
  assert.equal(outage.title, "Model unavailable");
});

test("API-key copy never leaks provider internals", () => {
  const presentation = presentChatError(
    providerError(
      "Invalid API key sk-live-secret-123 for model beam. Add or update this provider's API key in Settings.",
      { status: 401 }
    )
  );
  assert.doesNotMatch(presentation.message, /sk-live-secret-123/);
  assert.match(presentation.message, /requires an API key/);
});

function conversationFixture() {
  const longRequest = "Refactor the authentication flow. ".repeat(40);
  return [
    { id: "u1", role: "user", content: "Build an invoice dashboard with CSV export." },
    {
      id: "a1",
      role: "assistant",
      content: "I created src/InvoiceTable.jsx and wired filtering.",
      status: "completed",
      artifact: {
        files: [
          { path: "src/InvoiceTable.jsx", complete: true, bytes: 4096 },
          { path: "src/exportCsv.js", complete: false, bytes: 512 }
        ]
      }
    },
    { id: "u2", role: "user", content: longRequest },
    {
      id: "a2",
      role: "assistant",
      content: "The CSV export is wired but the totals row still needs rounding.",
      status: "failed",
      error: { code: "context_length_exceeded", model: "beam" }
    }
  ];
}

test("the handoff keeps goal, recent requests, files, status, and next steps within budget", () => {
  const messages = conversationFixture();
  const snapshot = JSON.parse(JSON.stringify(messages));
  const handoff = buildContextHandoff({
    messages,
    modelLabel: "Selected Model",
    error: messages.at(-1).error,
    sourceId: "a2"
  });

  assert.ok(handoff.content.startsWith(`${CONTEXT_HANDOFF_PREFIX} `));
  assert.ok(handoff.content.includes(CONTEXT_HANDOFF_LABEL));
  assert.ok(handoff.content.length <= MAX_HANDOFF_CHARS);
  assert.equal(handoff.sourceId, "a2");
  assert.equal(handoff.model, "beam");
  assert.equal(handoff.messageCount, messages.length);
  assert.match(handoff.content, /Build an invoice dashboard with CSV export\./);
  assert.match(handoff.content, /src\/InvoiceTable\.jsx \(complete, 4 KB\)/);
  assert.match(handoff.content, /src\/exportCsv\.js \(incomplete, 512 B\)/);
  assert.match(handoff.content, /The CSV export is wired/);
  assert.match(handoff.content, /Last turn: failed/);
  assert.match(handoff.content, /Reason: the conversation exceeded this model's context window/);
  assert.match(handoff.content, /1 generated file is incomplete/);
  assert.match(handoff.content, /Next steps/);
  assert.match(handoff.content, /files were not copied into this conversation/);
  assert.match(handoff.content, /Do not repeat work that is already complete/);
  assert.deepEqual(messages, snapshot, "building a handoff must not mutate the original conversation");
});

test("handoffs are always bounded even when every excerpt is very long", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Step ${index}: ` + "word ".repeat(1200),
    status: "completed",
    ...(index === 19
      ? {
          artifact: {
            files: [
              { path: `src/${"deep-folder-".repeat(200)}file.js`, complete: false, bytes: 2048 }
            ]
          }
        }
      : {})
  }));
  const handoff = buildContextHandoff({ messages, error: { code: "context_length_exceeded" } });
  assert.equal(handoff.truncated, true);
  assert.ok(handoff.content.length <= MAX_HANDOFF_CHARS);
  assert.match(handoff.content, /Handoff shortened to fit the new conversation/);
});

test("a handoff made for an API-key failure does not claim the chat was too long", () => {
  const messages = conversationFixture().slice(0, 2);
  const handoff = buildContextHandoff({
    messages,
    error: { message: "Add or update this provider's API key in Settings. Model: beam" }
  });
  assert.doesNotMatch(handoff.content, /reached the model's context limit/);
  assert.doesNotMatch(handoff.content, /Reason: the conversation exceeded/);
  assert.match(handoff.content, /so the task can continue in a new conversation/);
  assert.equal(handoff.model, "beam");
});

test("persisted handoff messages are recognizable and never duplicate into later handoffs", () => {
  const first = buildContextHandoff({ messages: conversationFixture() });
  assert.equal(isContextHandoffContent(first.content), true);
  assert.equal(contextHandoffGoal(first.content), "Build an invoice dashboard with CSV export.");
  assert.equal(isContextHandoffContent("A normal user message"), false);

  const nested = buildContextHandoff({
    messages: [
      { role: "user", content: first.content, handoff: { goal: first.goal } },
      { role: "assistant", content: "Continuing the invoice work.", status: "completed" }
    ]
  });
  assert.equal(isContextHandoffContent(nested.content), true);
  const requestSection = nested.content.split("Latest assistant progress")[0];
  assert.equal((requestSection.match(/Continue this task:/g) || []).length, 1);
  assert.equal(nested.goal, "Build an invoice dashboard with CSV export.");
});

test("the chat wires the compact context alert without a generic error card", () => {
  const chat = read("src/ChatPage.jsx");
  const notices = read("src/components/ContextLimitNotice.jsx");
  const contextSection = notices.slice(
    notices.indexOf("export function ContextLimitNotice"),
    notices.indexOf("export function ApiKeyNotice")
  );
  const keySection = notices.slice(notices.indexOf("export function ApiKeyNotice"));

  assert.match(chat, /onContinueNewChat=\{handleContinueInNewChat\}/);
  assert.match(chat, /contextHandoffState=\{handoffState\}/);
  assert.match(chat, /onOpenSettings=\{\(\) => navigate\("\/settings"\)\}/);
  assert.match(chat, /!contextFailure &&\s*!apiKeyFailure &&\s*!requestBlockedFailure/);
  assert.match(chat, /presentation\?\.category === "context_limit"/);
  assert.match(chat, /presentation\?\.category === "missing_api_key"/);
  assert.match(chat, /presentation\?\.category === "invalid_api_key"/);
  assert.match(chat, /const apiKeyNotice = Boolean\(apiKeyFailure && onOpenSettings\)/);

  assert.match(
    contextSection,
    /This chat is too long\. Continue in a new chat to keep going\./
  );
  assert.match(contextSection, /CONTINUE_NEW_CHAT_ACTION/);
  assert.doesNotMatch(contextSection, /API key/i);
  assert.doesNotMatch(contextSection, /Open Settings/);
  assert.doesNotMatch(contextSection, /Try another model/);
  assert.doesNotMatch(contextSection, /won&rsquo;t fix a missing key/);
  assert.doesNotMatch(contextSection, /model=/);

  // Genuine key failures keep their full guidance.
  assert.match(keySection, /API key required/);
  assert.match(keySection, /Open Settings/);
  assert.match(keySection, /Starting a new chat won&rsquo;t fix a missing key/);
});

test("a firewall rejection replaces the generic card with one friendly continuation action", () => {
  const chat = read("src/ChatPage.jsx");
  const notices = read("src/components/ContextLimitNotice.jsx");
  const blockedSection = notices.slice(
    notices.indexOf("export function RequestBlockedNotice"),
    notices.indexOf("export function ContextLimitNotice")
  );

  assert.match(chat, /presentation\?\.category === "request_blocked"/);
  assert.match(
    chat,
    /const requestBlockedNotice = Boolean\(requestBlockedFailure && onContinueNewChat\)/
  );
  assert.match(chat, /const handoffTarget = contextLimit \|\| apiKeyNotice \|\| requestBlockedNotice;/);
  assert.match(chat, /<RequestBlockedNotice\s+busy=\{handoffBusy\}\s+error=\{handoffError\}/);
  assert.match(chat, /onContinue=\{\(\) => onContinueNewChat\(message\.id\)\}/);
  assert.match(chat, /onContinueNewChat=\{handleContinueInNewChat\}/);

  assert.match(blockedSection, /REQUEST_BLOCKED_TITLE/);
  assert.match(blockedSection, /REQUEST_BLOCKED_MESSAGE/);
  assert.match(blockedSection, /CONTINUE_NEW_CHAT_ACTION/);
  assert.doesNotMatch(blockedSection, /Start new chat|Continue in new chat/);
  assert.doesNotMatch(blockedSection, /Open Settings|Try another model|API key/i);
});

test("continue-in-new-chat is persisted, guarded, reusable after failure, and keeps the original chat reachable", () => {
  const chat = read("src/ChatPage.jsx");
  const notices = read("src/components/ContextLimitNotice.jsx");
  const continuation = read("src/chat/continuation.js");

  assert.match(chat, /continuationGuardRef\.current\.run\(async \(\) =>/);
  assert.match(chat, /const \{ handoff, conversation \} = await prepareContinuation\(\{/);
  assert.match(chat, /createConversation,/);
  assert.match(chat, /isUnavailable: isConversationCreateUnavailable/);
  assert.match(chat, /if \(conversation\?\.id\) syncTaskParam\(conversation\.id\)/);
  assert.match(chat, /preserveUnsyncedChat\(sourceMessages\)/);
  assert.match(
    chat,
    /status: "error",\s*sourceId,\s*error: "Could not prepare the new chat\. Your current conversation is unchanged\."/
  );
  assert.match(continuation, /if \(running\) return \{ started: false, value: undefined \};/);
  assert.match(continuation, /running = true;[\s\S]*await task\(\)/);
  assert.match(notices, /error \? "Try again" : CONTINUE_NEW_CHAT_ACTION/);
});

test("the chat request records its size so a bare 400 can be classified", () => {
  const service = read("src/services/chat.js");
  assert.match(service, /const requestChars = body\.messages\.reduce/);
  assert.match(service, /const messageCount = body\.messages\.length/);
  assert.match(service, /requestChars,\s*messageCount/);
});

test("the saved handoff is part of the first request and is restored after reload", () => {
  const chat = read("src/ChatPage.jsx");

  assert.match(chat, /isContextHandoffContent\(message\.content\)/);
  assert.match(chat, /const baseMessages = retryHistory \?\? \[\.\.\.messages, userMsg\]/);
  assert.match(chat, /const history = requestHistory\(baseMessages\)\.slice\(-40\)/);
  assert.match(chat, /messages: history,/);
  assert.match(chat, /content: handoff\.content,/);
});
