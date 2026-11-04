import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "../src/services/api.js";
import {
  ComboApiError,
  createComboEventParser,
  streamComboChat
} from "../src/combo/comboApi.js";

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const originalBase = apiClient.defaults.baseURL;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  apiClient.defaults.baseURL = originalBase;
});

function sseResponse(parts, init = {}) {
  const bytes = parts.map(part => (typeof part === "string" ? encoder.encode(part) : part));
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of bytes) controller.enqueue(part);
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" }, ...init }
  );
}

test("event parser dispatches valid events and ignores noise", () => {
  const events = [];
  const parser = createComboEventParser(event => events.push(event));
  parser.push([
    ": keepalive",
    "",
    "data: not-json",
    "",
    'data: {"phase":"checking"}',
    "",
    'data: {"type":"stage","phase":"checking","message":"Checking selected models"}',
    ""
  ].join("\n"));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "stage");
  assert.equal(parser.eventCount, 1);
  assert.equal(parser.terminal, null);
});

test("event parser handles split chunks and multiple events per chunk", () => {
  const events = [];
  const parser = createComboEventParser(event => events.push(event.type));
  parser.push('data: {"type":"run","runId":"r1"}\n\ndata: {"type":"stage","phase":"check');
  parser.push('ing"}\n\ndata: {"type":"pool","active":[],"excluded":[]}\n\n');
  assert.deepEqual(events, ["run", "stage", "pool"]);
  assert.equal(parser.terminal, null);
});

test("event parser records terminal done and error events", () => {
  const done = createComboEventParser(() => {});
  done.push('data: {"type":"done","activeCount":2}\n\n');
  assert.equal(done.terminal, "done");
  assert.equal(done.lastError, null);

  const failed = createComboEventParser(() => {});
  failed.push('data: {"type":"error","code":"no_working_models","message":"None available"}\n\n');
  assert.equal(failed.terminal, "error");
  assert.deepEqual(failed.lastError, { code: "no_working_models", message: "None available" });
});

test("event parser survives a listener that throws", () => {
  const parser = createComboEventParser(() => {
    throw new Error("render failed");
  });
  assert.doesNotThrow(() => parser.push('data: {"type":"done"}\n\n'));
  assert.equal(parser.terminal, "done");
});

test("streamComboChat parses a real SSE run end to end", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return sseResponse([
      'data: {"type":"run","runId":"run-1"}\n\n',
      'data: {"type":"stage","phase":"checking","message":"Checking selected models"}\n\n',
      'data: {"type":"pool","active":[{"key":"a","label":"A"}],"excluded":[{"key":"b","label":"B"}],"deferredCount":0,"selectedCount":2}\n\n',
      'data: {"type":"model","key":"a","status":"started"}\n\n',
      'data: {"type":"model","key":"a","status":"finished","latencyMs":42}\n\n',
      "data: {\"type\":\"delta\",\"content\":\"Hello \"}\n\n",
      "data: {\"type\":\"delta\",\"content\":\"world\"}\n\n",
      'data: {"type":"done","activeCount":1,"excludedCount":1,"results":[{"status":"succeeded"}]}\n\n'
    ]);
  };

  const events = [];
  let text = "";
  const result = await streamComboChat({
    messages: [{ role: "user", content: "Hi" }],
    onEvent: event => {
      events.push(event);
      if (event.type === "delta") text += event.content;
    }
  });

  assert.equal(request.url, "http://backend.test/api/combo/chat");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.credentials, "include");
  assert.equal(request.init.headers.Accept, "text/event-stream");
  assert.deepEqual(JSON.parse(request.init.body), { messages: [{ role: "user", content: "Hi" }] });
  assert.equal(text, "Hello world");
  assert.equal(result.done, true);
  assert.equal(result.error, null);
  assert.equal(result.events, 8);
  assert.deepEqual(events.map(event => event.type), ["run", "stage", "pool", "model", "model", "delta", "delta", "done"]);
});

test("streamComboChat surfaces a terminal error event", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () => sseResponse([
    'data: {"type":"pool","active":[],"excluded":[],"selectedCount":0}\n\n',
    'data: {"type":"error","code":"no_working_models","message":"None of your selected models are available right now."}\n\n'
  ]);

  const result = await streamComboChat({ messages: [{ role: "user", content: "Hi" }] });
  assert.equal(result.done, false);
  assert.deepEqual(result.error, {
    code: "no_working_models",
    message: "None of your selected models are available right now."
  });
});

test("streamComboChat reports HTTP failures with the server message and code", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ message: "Vups Combo AI is disabled. Enable it in Combo settings.", code: "combo_disabled" }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
  await assert.rejects(
    () => streamComboChat({ messages: [{ role: "user", content: "Hi" }] }),
    error => {
      assert.ok(error instanceof ComboApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "combo_disabled");
      assert.match(error.message, /disabled/);
      return true;
    }
  );
});

test("streamComboChat reports an interrupted progress stream", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"run","runId":"run-1"}\n\n'));
        controller.error(new Error("socket closed"));
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
  await assert.rejects(
    () => streamComboChat({ messages: [{ role: "user", content: "Hi" }] }),
    error => {
      assert.ok(error instanceof ComboApiError);
      assert.match(error.message, /interrupted/);
      return true;
    }
  );
});
