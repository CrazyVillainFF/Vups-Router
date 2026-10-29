import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "../src/services/api.js";
import { ChatNetworkError, ChatPersistenceError, streamChatResponse } from "../src/services/chat.js";
import { classifyChatError, presentChatError } from "../src/chat/chatErrors.js";
import {
  appendTurnChunk,
  cancelTurn,
  completeTurn,
  createAssistantTurn,
  failTurn,
  interruptTurn,
  recordTurnActivity,
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

async function runStream(parts, options = {}) {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = options.fetch || (async () => sseResponse(parts));
  const chunks = [];
  try {
    const result = await streamChatResponse({
      messages: [{ role: "user", content: "Build it" }],
      vups: true,
      onChunk: chunk => chunks.push(chunk),
      ...(options.signal ? { signal: options.signal } : {})
    });
    return { result, chunks };
  } catch (error) {
    return { error, chunks };
  }
}

// ─── Stream terminal-event rules ────────────────────────────────────────────

test("a confirmation done event is final: a later error event never turns it into a failure", async () => {
  const { result, error } = await runStream([
    'data: {"type":"meta","conversationId":"conv-1","messageId":"msg-1"}\n\n',
    'data: {"type":"delta","content":"Complete answer"}\n\n',
    'data: {"type":"done","conversationId":"conv-1","messageId":"msg-1","finishReason":"stop"}\n\n',
    'data: {"type":"error","code":"stream_interrupted","message":"late cleanup failed"}\n\n'
  ]);
  assert.equal(error, undefined);
  assert.equal(result.content, "Complete answer");
  assert.equal(result.finishReason, "stop");
});

test("duplicate done events are idempotent", async () => {
  const { result, error } = await runStream([
    'data: {"type":"delta","content":"Answer"}\n\n',
    'data: {"type":"done","finishReason":"stop"}\n\n',
    'data: {"type":"done","finishReason":"stop"}\n\n'
  ]);
  assert.equal(error, undefined);
  assert.equal(result.content, "Answer");
});

test("a done event arriving after an error still wins because persistence succeeded", async () => {
  const { result, error } = await runStream([
    'data: {"type":"delta","content":"Kept answer"}\n\n',
    'data: {"type":"error","code":"stream_interrupted","message":"transient close"}\n\n',
    'data: {"type":"done","finishReason":"stop"}\n\n'
  ]);
  assert.equal(error, undefined);
  assert.equal(result.content, "Kept answer");
});

test("artifact persistence failure is a persistence error, not a generation failure", async () => {
  const { error } = await runStream([
    'data: {"type":"delta","content":"FILE: index.html\\n```html\\n<h1>Hi</h1>\\n```"}\n\n',
    'data: {"type":"error","code":"artifact_persist_failed","message":"The generated code could not be saved to your history.","messageId":"msg-1","conversationId":"conv-1"}\n\n'
  ]);
  assert.ok(error instanceof ChatPersistenceError);
  assert.ok(error instanceof ChatNetworkError);
  assert.equal(error.stage, "persist");
  assert.equal(error.code, "artifact_persist_failed");
  assert.match(error.partialContent, /<h1>Hi<\/h1>/);
});

test("an interrupted stream keeps partial output and is classified as interrupted", async () => {
  const { error } = await runStream([
    'data: {"type":"delta","content":"half a sentence"}\n\n'
  ]);
  assert.ok(error instanceof ChatNetworkError);
  assert.notEqual(error.name, "ChatPersistenceError");
  assert.equal(error.code, "stream_interrupted");
  assert.equal(error.partialContent, "half a sentence");
});

test("empty provider output produces one empty-response error", async () => {
  const { error } = await runStream([": keepalive\n\n"]);
  assert.equal(error.code, "empty_stream");
  assert.equal(presentChatError(error).title, "No answer");
});

test("an aborted request rejects with AbortError rather than a chat failure", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  const controller = new AbortController();
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      });
    });
  const promise = streamChatResponse({
    messages: [{ role: "user", content: "Hi" }],
    signal: controller.signal
  });
  controller.abort();
  await assert.rejects(promise, error => error.name === "AbortError");
});

// ─── Turn state machine ─────────────────────────────────────────────────────

function turnMessages(id = "t1") {
  return [createAssistantTurn({ id })];
}

test("a completed turn cannot be turned into a failure by a stale callback", () => {
  let messages = turnMessages();
  messages = appendTurnChunk(messages, "t1", "Done text");
  messages = completeTurn(messages, "t1", { content: "Done text", finishReason: "stop" });
  const after = failTurn(messages, "t1", {
    error: presentChatError(new Error("late failure")),
    content: "Done text"
  });
  assert.equal(after[0].status, TURN_STATUS.COMPLETED);
  assert.equal(after[0].error, null);
});

test("chunks and activity after completion are ignored", () => {
  let messages = completeTurn(turnMessages(), "t1", { content: "Final", finishReason: "stop" });
  const afterChunk = appendTurnChunk(messages, "t1", "more");
  assert.equal(afterChunk[0].content, "Final");
  const afterActivity = recordTurnActivity(afterChunk, "t1", { phase: "request" }, { runId: "late" });
  assert.equal(afterActivity[0].activity.length, 0);
});

test("finishReason error does not masquerade as a truncated response", () => {
  const messages = completeTurn(turnMessages(), "t1", {
    content: "Answer",
    finishReason: "error"
  });
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(messages[0].truncated, null);
});

test("length-limited answers stay completed but marked as length limited", () => {
  const messages = completeTurn(turnMessages(), "t1", {
    content: "Answer",
    finishReason: "length"
  });
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(messages[0].truncated, "length");
});

test("cancelling an empty placeholder removes it so it can never be replayed", () => {
  const messages = cancelTurn(turnMessages(), "t1");
  assert.deepEqual(messages, []);
});

test("cancelling a partial turn keeps the text and records a cancelled state", () => {
  let messages = appendTurnChunk(turnMessages(), "t1", "partial words");
  messages = cancelTurn(messages, "t1");
  assert.equal(messages[0].status, TURN_STATUS.CANCELLED);
  assert.equal(messages[0].content, "partial words");
  assert.equal(messages[0].error, null);
});

test("a late failure after cancellation is ignored", () => {
  let messages = appendTurnChunk(turnMessages(), "t1", "partial");
  messages = cancelTurn(messages, "t1");
  const after = failTurn(messages, "t1", { error: presentChatError(new Error("late")) });
  assert.equal(after[0].status, TURN_STATUS.CANCELLED);
});

test("interrupting keeps partial content and clears any failure", () => {
  const messages = interruptTurn(turnMessages(), "t1", { content: "first half" });
  assert.equal(messages[0].status, TURN_STATUS.INTERRUPTED);
  assert.equal(messages[0].content, "first half");
  assert.equal(messages[0].error, null);
});

test("history replay drops empty assistant turns and never sends an empty user message", () => {
  const history = sanitizeHistoryMessages([
    { role: "user", content: "Hi" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "   " },
    { role: "user", content: "" },
    { role: "assistant", content: "Hello", status: TURN_STATUS.COMPLETED }
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello", status: TURN_STATUS.COMPLETED }
  ]);
});

// ─── Error presentation ─────────────────────────────────────────────────────

test("save failures and generation failures are distinct categories", () => {
  assert.equal(classifyChatError({ code: "persist_failed" }), "persist");
  assert.equal(classifyChatError({ code: "artifact_persist_failed" }), "persist");
  assert.equal(classifyChatError({ code: "stream_interrupted" }), "stream");
  const persist = presentChatError({ code: "artifact_persist_failed" });
  assert.equal(persist.retry, false);
  assert.match(persist.message, /couldn't be saved/i);
});

test("rate limits, timeouts, image failures, and oversized requests are not mislabeled", () => {
  assert.equal(classifyChatError({ code: "vups_rate_limited", status: 429 }), "rate_limit");
  assert.equal(classifyChatError({ code: "vups_quota_exhausted", status: 429 }), "quota");
  assert.equal(classifyChatError({ status: 504 }), "timeout");
  assert.equal(classifyChatError({ code: "vups_vision_rejected", status: 400 }), "vision");
  assert.equal(classifyChatError({ code: "artifact_too_large", status: 413 }), "oversize");
});

test("quota notices do not invent reset times", () => {
  const presentation = presentChatError({ code: "quota_exhausted", status: 429 });
  assert.equal(presentation.title, "Usage limit reached");
  assert.match(presentation.message, /Reset time not provided by provider/i);
  assert.equal(presentation.resetAt, "");
});
