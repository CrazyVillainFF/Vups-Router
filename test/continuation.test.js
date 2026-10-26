import test from "node:test";
import assert from "node:assert/strict";
import {
  continuationTitle,
  createContinuationGuard,
  prepareContinuation
} from "../src/chat/continuation.js";
import { CONTEXT_HANDOFF_PREFIX } from "../src/chat/contextLimit.js";

function conversationFixture() {
  return [
    { id: "u1", role: "user", content: "Build an invoice dashboard with CSV export." },
    {
      id: "a1",
      role: "assistant",
      content: "I created src/InvoiceTable.jsx and wired filtering.",
      status: "completed",
      artifact: {
        files: [{ path: "src/InvoiceTable.jsx", complete: true, bytes: 4096 }]
      }
    },
    { id: "u2", role: "user", content: "Run `npm run build` before wrapping up." },
    {
      id: "a2",
      role: "assistant",
      content: "",
      status: "failed",
      error: { code: "request_blocked" }
    }
  ];
}

test("continuation titles are compact, descriptive, and bounded", () => {
  assert.equal(continuationTitle("Build an invoice dashboard."), "Continue: Build an invoice dashboard.");
  assert.equal(continuationTitle(""), "Continued chat");
  assert.ok(continuationTitle("x".repeat(200)).length <= 60);
});

test("a continuation persists the bounded handoff before any copy is shown", async () => {
  const messages = conversationFixture();
  const snapshot = JSON.parse(JSON.stringify(messages));
  const calls = [];
  const conversation = { id: "conv-123", title: "Continue: Build an invoice dashboard with CSV export." };

  const result = await prepareContinuation({
    messages,
    sourceId: "a2",
    modelLabel: "Selected Model",
    error: messages.at(-1).error,
    createConversation: async (payload) => {
      calls.push(payload);
      return conversation;
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].handoff, result.handoff.content);
  assert.ok(calls[0].handoff.startsWith(CONTEXT_HANDOFF_PREFIX));
  assert.equal(calls[0].title, result.title);
  assert.equal(result.conversation, conversation);
  assert.match(result.handoff.content, /Build an invoice dashboard with CSV export\./);
  assert.match(result.handoff.content, /src\/InvoiceTable\.jsx \(complete, 4 KB\)/);
  assert.doesNotMatch(result.handoff.content, /npm run build|`/);
  assert.match(result.handoff.content, /\[code omitted\]/);
  assert.deepEqual(messages, snapshot, "preparing a continuation must not mutate the source messages");
});

test("a deployment without the create endpoint still keeps the handoff for the first request", async () => {
  const unavailable = new Error("not found");
  unavailable.response = { status: 404 };

  const result = await prepareContinuation({
    messages: conversationFixture(),
    createConversation: async () => {
      throw unavailable;
    },
    isUnavailable: (error) => error?.response?.status === 404
  });

  assert.equal(result.conversation, null);
  assert.ok(result.handoff.content.startsWith(CONTEXT_HANDOFF_PREFIX));
  assert.match(result.handoff.content, /src\/InvoiceTable\.jsx/);
});

test("a real persistence failure stops the continuation and reports it", async () => {
  const failure = new Error("database offline");
  failure.response = { status: 500 };

  await assert.rejects(
    prepareContinuation({
      messages: conversationFixture(),
      createConversation: async () => {
        throw failure;
      },
      isUnavailable: (error) => error?.response?.status === 404
    }),
    /database offline/
  );
});

test("a create response without an id is treated as a failed continuation", async () => {
  await assert.rejects(
    prepareContinuation({
      messages: conversationFixture(),
      createConversation: async () => ({})
    }),
    /continuation_not_persisted/
  );
});

test("the continuation guard allows only one conversation per click burst", async () => {
  const guard = createContinuationGuard();
  let release;
  let calls = 0;

  const first = guard.run(async () => {
    calls += 1;
    await new Promise((resolve) => {
      release = resolve;
    });
    return "first";
  });
  const second = await guard.run(async () => {
    calls += 1;
    return "second";
  });

  assert.equal(guard.isRunning(), true);
  assert.deepEqual(second, { started: false, value: undefined });
  assert.equal(calls, 1);

  release();
  assert.deepEqual(await first, { started: true, value: "first" });
  assert.equal(guard.isRunning(), false);

  const third = await guard.run(async () => "third");
  assert.deepEqual(third, { started: true, value: "third" });
  assert.equal(calls, 1);
});
