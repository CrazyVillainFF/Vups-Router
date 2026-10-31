import test from "node:test";
import assert from "node:assert/strict";
import { AxiosError } from "axios";
import { apiClient, getApiErrorMessage } from "../src/services/api.js";
import { ChatNetworkError, CHAT_MESSAGES, streamChatResponse } from "../src/services/chat.js";
import { presentChatError } from "../src/chat/chatErrors.js";

const originalFetch = globalThis.fetch;
const originalBase = apiClient.defaults.baseURL;

test.beforeEach(() => {
  apiClient.defaults.baseURL = "https://api.example.test/api";
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  apiClient.defaults.baseURL = originalBase;
});

function abortablePending(signal) {
  return new Promise((resolve, reject) => {
    const fail = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

function streamThatStalls(signal, initial) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        if (initial) controller.enqueue(encoder.encode(initial));
        // Intentionally never closes: simulates a stalled provider.
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          try {
            controller.error(error);
          } catch {
            /* already closed */
          }
        }, { once: true });
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test("connection refusal reports a timeout-free connection message and never leaks a URL", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    streamChatResponse({ messages: [{ role: "user", content: "hi" }] }),
    error => {
      assert.ok(error instanceof ChatNetworkError);
      assert.equal(error.code, "connection_unavailable");
      assert.equal(error.message, CHAT_MESSAGES.connection);
      assert.doesNotMatch(error.message, /localhost|http/i);
      const presented = presentChatError(error);
      assert.equal(presented.message, "Can't connect to Vups Router. Try again shortly.");
      assert.doesNotMatch(presented.message, /localhost|http/i);
      return true;
    }
  );
});

test("a provider that takes longer than the old 30s window is still waited for, with one request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const encoder = new TextEncoder();
  let calls = 0;
  globalThis.fetch = (_url, options) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(': keepalive\n\ndata: {"type":"delta","content":"slow answer"}\n\n'));
                controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
                controller.close();
              }
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
        );
      }, 31000);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  };

  const pending = streamChatResponse({
    messages: [{ role: "user", content: "hi" }],
    timeouts: { idle: 120000, overall: 0 }
  });
  t.mock.timers.tick(31000);
  const result = await pending;

  assert.equal(result.content, "slow answer");
  assert.equal(calls, 1, "waiting must not duplicate the request");
  t.mock.timers.reset();
});

test("SSE keepalives keep an otherwise silent model alive past the idle window", async () => {
  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, options) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (let beat = 0; beat < 6; beat += 1) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (options.signal.aborted) {
              const error = new Error("aborted");
              error.name = "AbortError";
              controller.error(error);
              return;
            }
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
          controller.enqueue(encoder.encode('data: {"type":"delta","content":"alive"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
          controller.close();
        }
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );

  const result = await streamChatResponse({
    messages: [{ role: "user", content: "hi" }],
    timeouts: { idle: 60, overall: 0 }
  });
  assert.equal(result.content, "alive");
});

test("Stop while the provider is still queued cancels immediately", async () => {
  let calls = 0;
  globalThis.fetch = (_url, options) => {
    calls += 1;
    return abortablePending(options.signal);
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    streamChatResponse({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal
    }),
    error => {
      assert.equal(error.name, "AbortError");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("an idle stream preserves partial output and asks the user to continue", async () => {
  globalThis.fetch = async (_url, options) =>
    streamThatStalls(options.signal, 'data: {"type":"delta","content":"partial answer"}\n\n');
  await assert.rejects(
    streamChatResponse({
      messages: [{ role: "user", content: "hi" }],
      timeouts: { connect: 1000, idle: 40, overall: 3000 }
    }),
    error => {
      assert.ok(error instanceof ChatNetworkError);
      assert.equal(error.code, "stream_interrupted");
      assert.equal(error.deadline, "idle");
      assert.equal(error.partialContent, "partial answer");
      assert.match(error.message, /response stopped early/i);
      assert.equal(presentChatError(error).message, "The response stopped early. Continue or retry.");
      return true;
    }
  );
});

test("the overall deadline ends a request that never produces output", async () => {
  globalThis.fetch = async (_url, options) => streamThatStalls(options.signal);
  await assert.rejects(
    streamChatResponse({
      messages: [{ role: "user", content: "hi" }],
      timeouts: { connect: 1000, idle: 5000, overall: 40 }
    }),
    error => {
      assert.ok(error instanceof ChatNetworkError);
      assert.equal(error.code, "timeout");
      assert.equal(error.deadline, "overall");
      assert.equal(error.message, CHAT_MESSAGES.timeout);
      return true;
    }
  );
});

test("a user cancellation rejects as AbortError, not as a chat failure", async () => {
  globalThis.fetch = (_url, options) => abortablePending(options.signal);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    streamChatResponse({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      timeouts: { connect: 2000, overall: 4000 }
    }),
    error => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, undefined);
      return true;
    }
  );
});

test("HTTP failures keep their status but present a concise message without internals", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "Provider exploded: secret stack trace", requestId: "req-9" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  await assert.rejects(
    streamChatResponse({ messages: [{ role: "user", content: "hi" }] }),
    error => {
      assert.ok(error instanceof ChatNetworkError);
      assert.equal(error.status, 500);
      const presented = presentChatError(error);
      assert.doesNotMatch(presented.message, /stack|provider exploded|req-9/i);
      return true;
    }
  );
});

test("required user-facing copy is exact", () => {
  const cases = [
    ["connection_unavailable", "Can't connect to Vups Router. Try again shortly."],
    ["timeout", "The server stopped sending data before the answer finished. Continue or retry."],
    ["stream_interrupted", "The response stopped early. Continue or retry."],
    ["provider_unavailable", "This model is unavailable. Try another model."],
    ["empty_stream", "No answer received. Please try again."]
  ];
  for (const [code, expected] of cases) {
    const presented = presentChatError(new ChatNetworkError("internal detail", null, { code }));
    assert.equal(presented.message, expected, code);
    assert.doesNotMatch(presented.message, /localhost|request id|stack/i);
  }
});

test("API errors never echo the configured backend URL", () => {
  const error = new AxiosError("Network Error", "ERR_NETWORK", {
    baseURL: "http://localhost:4000/api"
  });
  const message = getApiErrorMessage(error);
  assert.match(message, /Could not reach/);
  assert.doesNotMatch(message, /localhost|4000/);
});
