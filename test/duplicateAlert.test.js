import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "../src/services/api.js";
import { streamChatResponse } from "../src/services/chat.js";
import { artifactFromResponse } from "../src/chat/artifacts.js";
import { presentSaveWarning, settleTurnFromError } from "../src/chat/turnOutcome.js";
import { resolveTurnNotice, TURN_NOTICE } from "../src/chat/turnPresentation.js";
import {
  appendTurnChunk,
  beginContinuation,
  cancelTurn,
  completeTurn,
  createAssistantTurn,
  sanitizeHistoryMessages,
  TURN_STATUS
} from "../src/chat/turnLifecycle.js";

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const originalBase = apiClient.defaults.baseURL;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  apiClient.defaults.baseURL = originalBase;
});

function sseResponse(parts) {
  const bytes = parts.map(part => (typeof part === "string" ? encoder.encode(part) : part));
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of bytes) controller.enqueue(part);
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

// Mirrors ChatPage's success and failure paths for one assistant turn.
async function runTurn(parts, { id = "a1", messages = null } = {}) {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () => sseResponse(parts);
  let next = messages ? [...messages] : [createAssistantTurn({ id })];
  try {
    const result = await streamChatResponse({
      messages: [{ role: "user", content: "Hi" }],
      assistantMessageId: id,
      onChunk: chunk => {
        next = appendTurnChunk(next, id, chunk);
      }
    });
    next = completeTurn(next, id, {
      content: result.content,
      messageId: result.messageId,
      artifact: result.artifact,
      finishReason: result.finishReason,
      saveWarning: result.saveWarning ? presentSaveWarning(result.saveWarning.code) : null
    });
    return { result, messages: next, outcome: "completed" };
  } catch (error) {
    if (error?.name === "AbortError") {
      next = cancelTurn(next, id);
      return { error, messages: next, outcome: "cancelled" };
    }
    const partial = typeof error.partialContent === "string" ? error.partialContent : "";
    const settled = settleTurnFromError(next, id, {
      error,
      content: partial,
      recoverArtifact: status => (partial ? artifactFromResponse(partial, { status }) : null)
    });
    return { error, messages: settled.messages, outcome: settled.outcome };
  }
}

function notices(messages) {
  return messages
    .map(message => resolveTurnNotice(message))
    .filter(notice => notice !== TURN_NOTICE.NONE);
}

const ANSWER = "Hi! I am the VupsRouter assistant. How can I help you today?";

test("a successful answer followed by a clean stream close renders no alert", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: ANSWER })}\n\n`,
    'data: {"type":"done","finishReason":"stop"}\n\n'
  ]);
  assert.equal(outcome, "completed");
  assert.equal(messages[0].content, ANSWER);
  assert.deepEqual(notices(messages), []);
  assert.equal(messages.filter(message => message.role === "error").length, 0);
});

test("a done event followed by a late error stays completed with no alert", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: ANSWER })}\n\n`,
    'data: {"type":"done","finishReason":"stop"}\n\n',
    'data: {"type":"error","code":"stream_error","message":"late cleanup failure"}\n\n'
  ]);
  assert.equal(outcome, "completed");
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(messages[0].error, null);
  assert.deepEqual(notices(messages), []);
});

test("generation success with artifact persistence failure shows one save warning", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: ANSWER })}\n\n`,
    'data: {"type":"error","code":"artifact_persist_failed","message":"The generated code could not be saved to your history."}\n\n'
  ]);
  assert.equal(outcome, "save-warning");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(messages[0].content, ANSWER);
  assert.equal(messages[0].error, null);
  assert.equal(messages[0].artifact, null, "nothing may be marked as saved");
  assert.equal(messages[0].saveWarning.title, "Answer not saved");
  assert.deepEqual(notices(messages), [TURN_NOTICE.SAVE_WARNING]);
});

test("a done event carrying a structured saveWarning keeps the answer and warns once", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: ANSWER })}\n\n`,
    `data: ${JSON.stringify({
      type: "done",
      finishReason: "stop",
      saveWarning: { code: "artifact_persist_failed", message: "internal detail must not render" }
    })}\n\n`
  ]);
  assert.equal(outcome, "completed");
  assert.equal(messages[0].content, ANSWER);
  assert.equal(messages[0].saveWarning.title, "Answer not saved");
  assert.doesNotMatch(messages[0].saveWarning.message, /internal detail/);
  assert.deepEqual(notices(messages), [TURN_NOTICE.SAVE_WARNING]);
});

test("a genuine provider failure produces exactly one failure notice", async () => {
  const { outcome, messages } = await runTurn([
    'data: {"type":"error","code":"vups_stream_error","message":"The provider failed."}\n\n'
  ]);
  assert.equal(outcome, "failed");
  assert.equal(messages[0].error.title, "Response stopped");
  assert.deepEqual(notices(messages), [TURN_NOTICE.ERROR]);
  assert.equal(messages.filter(message => message.role === "error").length, 0);
});

test("a genuine failure after partial content keeps the text and shows one failure notice", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: "Half an answer" })}\n\n`,
    'data: {"type":"error","code":"vups_quota_exhausted","message":"Quota exhausted."}\n\n'
  ]);
  assert.equal(outcome, "failed");
  assert.equal(messages[0].content, "Half an answer");
  assert.deepEqual(notices(messages), [TURN_NOTICE.ERROR]);
});

test("an incomplete stream shows one interruption notice and keeps partial output", async () => {
  const { outcome, messages } = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: "First half" })}\n\n`
  ]);
  assert.equal(outcome, "interrupted");
  assert.equal(messages[0].status, TURN_STATUS.INTERRUPTED);
  assert.equal(messages[0].content, "First half");
  assert.equal(messages[0].error, null);
  assert.deepEqual(notices(messages), [TURN_NOTICE.INTERRUPTED]);
});

test("consecutive requests cannot leak an error into the next turn", async () => {
  const first = await runTurn([
    'data: {"type":"error","code":"vups_stream_error","message":"The provider failed."}\n\n'
  ]);
  assert.equal(first.outcome, "failed");

  const base = [
    ...first.messages,
    { id: "u2", role: "user", content: "Try again" },
    createAssistantTurn({ id: "a2" })
  ];
  const second = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: "Fresh answer" })}\n\n`,
    'data: {"type":"done","finishReason":"stop"}\n\n'
  ], { id: "a2", messages: base });

  assert.equal(second.outcome, "completed");
  const [failedTurn, , freshTurn] = second.messages;
  assert.equal(failedTurn.status, TURN_STATUS.FAILED);
  assert.equal(freshTurn.status, TURN_STATUS.COMPLETED);
  assert.equal(freshTurn.content, "Fresh answer");
  assert.equal(resolveTurnNotice(freshTurn), TURN_NOTICE.NONE);
  assert.deepEqual(notices(second.messages), [TURN_NOTICE.ERROR]);
});

test("empty assistant placeholders are never replayed as history", async () => {
  const failed = await runTurn([
    'data: {"type":"error","code":"vups_stream_error","message":"The provider failed."}\n\n'
  ]);
  const replay = sanitizeHistoryMessages([
    { id: "u1", role: "user", content: "Hi" },
    ...failed.messages
  ]);
  assert.deepEqual(replay, [{ id: "u1", role: "user", content: "Hi" }]);

  const interrupted = await runTurn([
    `data: ${JSON.stringify({ type: "delta", content: "usable partial" })}\n\n`
  ]);
  const keep = sanitizeHistoryMessages([...interrupted.messages]);
  assert.equal(keep.length, 1);
  assert.equal(keep[0].content, "usable partial");
});

test("Continue revives an interrupted answer without duplicating its notice", () => {
  const interrupted = [
    {
      ...createAssistantTurn({ id: "a1" }),
      status: TURN_STATUS.INTERRUPTED,
      content: "First half",
      messageId: "m1"
    }
  ];
  const revived = beginContinuation(interrupted, "a1");
  assert.equal(revived[0].status, TURN_STATUS.STREAMING);
  assert.equal(revived[0].content, "First half");
  assert.equal(resolveTurnNotice(revived[0]), TURN_NOTICE.NONE);

  const completed = completeTurn(revived, "a1", { content: "First half and the rest", finishReason: "stop" });
  assert.equal(completed[0].status, TURN_STATUS.COMPLETED);
  assert.equal(completed[0].content, "First half and the rest");
  assert.deepEqual(notices(completed), []);
});

test("a stale failure callback cannot add a second notice after completion", () => {
  let messages = [createAssistantTurn({ id: "a1" })];
  messages = appendTurnChunk(messages, "a1", "Final answer");
  messages = completeTurn(messages, "a1", { content: "Final answer", finishReason: "stop" });
  const settled = settleTurnFromError(messages, "a1", {
    error: { code: "stream_error", message: "late" },
    content: ""
  });
  assert.equal(settled.messages[0].status, TURN_STATUS.COMPLETED);
  assert.deepEqual(notices(settled.messages), []);
});

test("the notice resolver can never yield two notices for one turn", () => {
  const conflicting = {
    status: TURN_STATUS.COMPLETED,
    error: { title: "Problem", message: "bad" },
    saveWarning: { title: "Answer not saved", message: "warn" },
    truncated: "length"
  };
  assert.equal(resolveTurnNotice(conflicting), TURN_NOTICE.ERROR);
  assert.equal(resolveTurnNotice({ ...conflicting, error: null }), TURN_NOTICE.SAVE_WARNING);
  assert.equal(resolveTurnNotice({ ...conflicting, error: null, saveWarning: null }), TURN_NOTICE.LENGTH);
});
