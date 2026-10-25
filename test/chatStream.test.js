import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "../src/services/api.js";
import { ChatNetworkError, streamChatResponse } from "../src/services/chat.js";

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

async function runStream(parts) {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () => sseResponse(parts);
  const chunks = [];
  const steps = [];
  let meta = null;
  try {
    const result = await streamChatResponse({
      messages: [{ role: "user", content: "Build it" }],
      vups: true,
      onChunk: chunk => chunks.push(chunk),
      onStep: step => steps.push(step),
      onMeta: value => {
        meta = value;
      }
    });
    return { result, chunks, steps, meta };
  } catch (error) {
    return { error, chunks, steps, meta };
  }
}

test("streamChatResponse joins split UTF-8 SSE data and requires the done event", async () => {
  const text = [
    'data: {"type":"meta","conversationId":"conv-1","model":"vups-v3-galax"}\n\n',
    ": keepalive\n\n",
    'data: {"type":"delta","content":"Hello "}\n\n',
    'data: {"type":"delta","content":"रोबोट 🌍"}\n\n',
    'data: {"type":"done","conversationId":"conv-1","finishReason":"stop"}\n\n'
  ].join("");
  const bytes = encoder.encode(text);
  const parts = [bytes.slice(0, 37), bytes.slice(37, 83), bytes.slice(83, 140), bytes.slice(140, 205), bytes.slice(205)];

  const { result, chunks, steps, meta, error } = await runStream(parts);
  assert.equal(error, undefined);
  assert.equal(result.content, "Hello रोबोट 🌍");
  assert.equal(result.conversationId, "conv-1");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(chunks, ["Hello ", "रोबोट 🌍"]);
  assert.deepEqual(meta, { conversationId: "conv-1" });
  assert.ok(steps.includes("Response complete"));
});

test("streamChatResponse flushes a final event without a trailing newline", async () => {
  const { result, error } = await runStream([
    'data: {"type":"delta","content":"A"}\n\n',
    'data: {"type":"done","finishReason":"stop"}'
  ]);
  assert.equal(error, undefined);
  assert.equal(result.content, "A");
});

test("an upstream error keeps partial content and exposes safe diagnostics", async () => {
  const { error, chunks } = await runStream([
    'data: {"type":"meta","conversationId":"conv-2"}\n\n',
    'data: {"type":"delta","content":"partial text"}\n\n',
    'data: {"type":"error","message":"The stream ended early.","code":"vups_stream_interrupted","requestId":"req-123","partial":true,"diagnostic":{"reason":"eof_without_terminal","contentChars":12}}\n\n'
  ]);
  assert.ok(error instanceof ChatNetworkError);
  assert.equal(error.message, "The stream ended early.");
  assert.equal(error.code, "vups_stream_interrupted");
  assert.equal(error.requestId, "req-123");
  assert.equal(error.partialContent, "partial text");
  assert.equal(error.diagnostic.reason, "eof_without_terminal");
  assert.deepEqual(chunks, ["partial text"]);
});

test("EOF without a done event is treated as an interrupted stream", async () => {
  const { error } = await runStream([
    'data: {"type":"delta","content":"unfinished code"}\n\n'
  ]);
  assert.ok(error instanceof ChatNetworkError);
  assert.equal(error.code, "stream_interrupted");
  assert.equal(error.partialContent, "unfinished code");
  assert.match(error.message, /partial answer was kept/i);
});

test("EOF before any output is an explicit empty-stream error", async () => {
  const { error } = await runStream([": keepalive\n\n"]);
  assert.ok(error instanceof ChatNetworkError);
  assert.equal(error.code, "empty_stream");
  assert.equal(error.partialContent, "");
});

test("non-OK JSON errors preserve the backend code and request ID", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        message: "Vups is rate-limited.",
        code: "vups_rate_limited",
        requestId: "req-http-1",
        diagnostic: { category: "rate_limit_requests" }
      }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  await assert.rejects(
    streamChatResponse({ messages: [{ role: "user", content: "Hi" }], vups: true }),
    error => {
      assert.ok(error instanceof ChatNetworkError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "vups_rate_limited");
      assert.equal(error.requestId, "req-http-1");
      assert.equal(error.diagnostic.category, "rate_limit_requests");
      return true;
    }
  );
});
