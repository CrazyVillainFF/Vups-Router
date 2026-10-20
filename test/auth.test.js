import test from "node:test";
import assert from "node:assert/strict";
import {
  apiClient,
  deleteConversation,
  deleteProviderConfig,
  fetchCurrentUser,
  fetchProviderConfig,
  fetchProviderModels,
  getApiErrorMessage,
  getConversation,
  listConversations,
  resolveApiBaseURL,
  requestPasswordReset,
  resetPassword,
  verifyResetCode,
  saveProviderConfig,
  signIn,
  signOut,
  signUp,
  testProviderConnection,
  testProviderModel
} from "../src/services/api.js";

function mockAdapter() {
  const requests = [];
  const originalBaseURL = apiClient.defaults.baseURL;
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    requests.push({
      method: config.method,
      url: config.url,
      baseURL: config.baseURL,
      data: config.data ? JSON.parse(config.data) : undefined
    });
    return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
  };
  return {
    requests,
    restore() {
      apiClient.defaults.baseURL = originalBaseURL;
      apiClient.defaults.adapter = originalAdapter;
    }
  };
}

test("configured API base URL is trimmed and normalized", () => {
  assert.equal(resolveApiBaseURL({ VITE_API_BASE_URL: " https://api.example.test/api/// " }), "https://api.example.test/api");
});

test("development defaults to localhost and production requires configuration", () => {
  assert.equal(resolveApiBaseURL({ DEV: true }), "http://localhost:4000/api");
  assert.equal(resolveApiBaseURL({ DEV: false }), "");
});

test("the API client sends cookies with every request", () => {
  assert.equal(apiClient.defaults.withCredentials, true);
});

test("auth methods use cookie sessions on the existing backend paths", async () => {
  const mock = mockAdapter();
  try {
    await signUp({ name: "Alex", email: "alex@example.com", password: "correct-horse" });
    await signIn({ email: "alex@example.com", password: "correct-horse" });
    await signOut();
    await fetchCurrentUser();
  } finally {
    mock.restore();
  }

  assert.deepEqual(mock.requests, [
    { method: "post", url: "/auth/signup", baseURL: "https://api.example.test/api", data: { name: "Alex", email: "alex@example.com", password: "correct-horse" } },
    { method: "post", url: "/auth/signin", baseURL: "https://api.example.test/api", data: { email: "alex@example.com", password: "correct-horse" } },
    { method: "post", url: "/auth/logout", baseURL: "https://api.example.test/api", data: undefined },
    { method: "get", url: "/auth/me", baseURL: "https://api.example.test/api", data: undefined }
  ]);
});

test("password recovery methods use the six-digit code endpoints", async () => {
  const mock = mockAdapter();
  try {
    await requestPasswordReset("alex@example.com");
    await verifyResetCode({ email: "alex@example.com", code: "012345" });
    await resetPassword({
      email: "alex@example.com",
      code: "012345",
      newPassword: "brand-new-password-1"
    });
  } finally {
    mock.restore();
  }

  assert.deepEqual(mock.requests, [
    { method: "post", url: "/forgot-password", baseURL: "https://api.example.test/api", data: { email: "alex@example.com" } },
    {
      method: "post",
      url: "/verify-code",
      baseURL: "https://api.example.test/api",
      data: { email: "alex@example.com", code: "012345" }
    },
    {
      method: "post",
      url: "/reset-password",
      baseURL: "https://api.example.test/api",
      data: {
        email: "alex@example.com",
        code: "012345",
        newPassword: "brand-new-password-1"
      }
    }
  ]);
});

test("provider configuration methods use the settings endpoints", async () => {
  const mock = mockAdapter();
  try {
    await fetchProviderConfig();
    await saveProviderConfig({ provider: "Fake", baseUrl: "https://p.example/v1", apiKey: "sk-1", model: "m1" });
    await testProviderConnection({ baseUrl: "https://p.example/v1", apiKey: "sk-1" });
    await testProviderModel({ baseUrl: "https://p.example/v1", apiKey: "sk-1", model: "m1" });
    await fetchProviderModels();
    await deleteProviderConfig();
  } finally {
    mock.restore();
  }

  assert.deepEqual(mock.requests.map(request => `${request.method} ${request.url}`), [
    "get /settings/provider",
    "put /settings/provider",
    "post /settings/provider/test",
    "post /settings/provider/test-model",
    "get /settings/models",
    "delete /settings/provider"
  ]);
});

test("conversation methods use the conversations endpoints", async () => {
  const mock = mockAdapter();
  try {
    await listConversations();
    await getConversation("abc123");
    await deleteConversation("abc123");
  } finally {
    mock.restore();
  }

  assert.deepEqual(mock.requests.map(request => `${request.method} ${request.url}`), [
    "get /conversations",
    "get /conversations/abc123",
    "delete /conversations/abc123"
  ]);
});

test("API errors show backend messages and connection failures", () => {
  assert.equal(getApiErrorMessage({ isAxiosError: true, response: { data: { message: "Email already exists." } } }), "Email already exists.");
  assert.match(getApiErrorMessage({ isAxiosError: true, request: {} }), /Could not reach/);
  assert.match(getApiErrorMessage(new Error("Set VITE_API_BASE_URL to your deployed backend API URL.")), /VITE_API_BASE_URL/);
});

// ─── Chat streaming service ─────────────────────────────────────────────────

const { streamChatResponse, ChatNetworkError } = await import("../src/services/chat.js");

function sse(...events) {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("streamChatResponse posts to the backend proxy and forwards SSE deltas", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  const chunks = [];
  const steps = [];
  let captured;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(sse(
      { type: "meta", conversationId: "conv-1" },
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo!" },
      { type: "done", conversationId: "conv-1" }
    ), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  try {
    const result = await streamChatResponse({
      conversationId: null,
      messages: [{ role: "user", content: "hi" }],
      model: "model-x",
      onChunk: chunk => chunks.push(chunk),
      onStep: step => steps.push(step)
    });
    assert.equal(result.content, "Hello!");
    assert.equal(result.conversationId, "conv-1");
    assert.deepEqual(chunks, ["Hel", "lo!"]);
    assert.deepEqual(steps, ["Sending request", "Waiting for model", "Receiving response", "Response complete"]);
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }

  assert.equal(captured.url, "https://api.example.test/api/chat");
  assert.equal(captured.options.credentials, "include");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, "model-x");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("streamChatResponse preserves finish_reason and does not end early on empty or usage-only chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  const chunks = [];
  globalThis.fetch = async () => new Response(sse(
    { type: "meta", conversationId: "conv-finish" },
    { type: "delta", content: "part" },
    { type: "delta" },
    { type: "delta", content: "ial" },
    { type: "usage", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    { type: "done", conversationId: "conv-finish", finishReason: "length", usage: { total_tokens: 5 } }
  ), { status: 200 });

  try {
    const result = await streamChatResponse({
      messages: [{ role: "user", content: "hi" }],
      model: "model-x",
      onChunk: chunk => chunks.push(chunk)
    });
    assert.equal(result.content, "partial", "empty deltas and usage-only chunks must not cut the stream short");
    assert.equal(result.conversationId, "conv-finish");
    assert.equal(result.finishReason, "length", "truncated answers must be distinguishable from complete ones");
    assert.deepEqual(chunks, ["part", "ial"]);
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }
});

test("streamChatResponse keeps content when the stream ends without a done event", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  globalThis.fetch = async () => new Response(sse(
    { type: "meta", conversationId: "conv-nodone" },
    { type: "delta", content: "answer without done" }
  ), { status: 200 });

  try {
    const result = await streamChatResponse({ messages: [{ role: "user", content: "hi" }], model: "m" });
    assert.equal(result.content, "answer without done");
    assert.equal(result.finishReason, null, "an unknown finish state must not be reported as complete");
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }
});

test("streamChatResponse surfaces provider errors sent mid-stream", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  globalThis.fetch = async () => new Response(sse(
    { type: "meta", conversationId: "conv-2" },
    { type: "delta", content: "partial" },
    { type: "error", message: "Rate limit exceeded (HTTP 429)." }
  ), { status: 200 });

  try {
    await assert.rejects(
      () => streamChatResponse({ messages: [{ role: "user", content: "hi" }], model: "m" }),
      error => {
        assert.ok(error instanceof ChatNetworkError);
        assert.match(error.message, /Rate limit/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }
});

test("streamChatResponse surfaces JSON errors from the backend", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Configure your AI provider in Settings first." }), {
    status: 400,
    headers: { "Content-Type": "application/json" }
  });

  try {
    await assert.rejects(
      () => streamChatResponse({ messages: [{ role: "user", content: "hi" }], model: "m" }),
      error => {
        assert.ok(error instanceof ChatNetworkError);
        assert.match(error.message, /Settings/);
        assert.equal(error.status, 400);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }
});

test("streamChatResponse rejects empty completions instead of faking an answer", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseURL = apiClient.defaults.baseURL;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  globalThis.fetch = async () => new Response(sse({ type: "meta", conversationId: "conv-3" }, { type: "done" }), { status: 200 });

  try {
    await assert.rejects(
      () => streamChatResponse({ messages: [{ role: "user", content: "hi" }], model: "m" }),
      /empty response/i
    );
  } finally {
    globalThis.fetch = originalFetch;
    apiClient.defaults.baseURL = originalBaseURL;
  }
});
