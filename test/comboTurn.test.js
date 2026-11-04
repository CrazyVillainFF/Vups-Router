import test from "node:test";
import assert from "node:assert/strict";
import { apiClient } from "../src/services/api.js";
import { comboActivityFor, runComboTurn } from "../src/combo/comboTurn.js";

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
const originalBase = apiClient.defaults.baseURL;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  apiClient.defaults.baseURL = originalBase;
});

function sseResponse(events) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function stubComboStream(events) {
  apiClient.defaults.baseURL = "http://127.0.0.1:4000/api";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return sseResponse(events);
  };
  return calls;
}

function abortError() {
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
}

const TURN_EVENTS = [
  { type: "meta", conversationId: "conv-1", messageId: "msg-1", selectedCount: 4, strategy: "parallel" },
  { type: "stage", phase: "checking", message: "Checking which models work" },
  {
    type: "pool",
    active: [{ key: "saved:cfg-1:claude", label: "Claude" }, { key: "shared:llama", label: "Llama" }],
    excluded: [{ key: "vups:vups-v3-galax", label: "Vups v3 Galax" }],
    deferredCount: 1,
    selectedCount: 4
  },
  { type: "model", key: "saved:cfg-1:claude", label: "Claude", status: "started", index: 0, total: 2 },
  { type: "delta", content: "Synthesizing" },
  { type: "model", key: "shared:llama", label: "Llama", status: "finished", latencyMs: 1500 },
  { type: "delta", content: " the answer." },
  { type: "stage", phase: "synthesizing", message: "Apex is writing the combined answer" },
  { type: "done", conversationId: "conv-1", messageId: "msg-1", selectedCount: 4, durationMs: 4200 }
];

test("a composer send drives the real Combo run through the shared chat callbacks", async () => {
  stubComboStream(TURN_EVENTS);
  const chunks = [];
  const activities = [];
  const metas = [];
  const result = await runComboTurn({
    messages: [{ role: "user", content: "Build it" }],
    onChunk: chunk => chunks.push(chunk),
    onActivity: activity => activities.push(activity),
    onMeta: meta => metas.push(meta)
  });

  assert.equal(result.content, "Synthesizing the answer.");
  assert.deepEqual(chunks, ["Synthesizing", " the answer."]);
  assert.equal(result.finishReason, "combo");
  assert.equal(result.messageId, "msg-1");
  assert.equal(result.conversationId, "conv-1");
  assert.equal(result.saveWarning, null);
  assert.deepEqual(metas, [{ conversationId: "conv-1", messageId: "msg-1" }]);
  assert.deepEqual(activities.map(row => row.phase), ["checking", "pool", "model", "model", "synthesizing"]);
  assert.equal(activities[0].message, "Checking which models work");
});

test("the Combo request carries the turn ids so the answer is reloadable", async () => {
  const calls = stubComboStream(TURN_EVENTS);
  const controller = new AbortController();
  await runComboTurn({
    messages: [{ role: "user", content: "hi" }],
    conversationId: "conv-1",
    assistantMessageId: "msg-1",
    signal: controller.signal
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:4000/api/combo/chat");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.signal, controller.signal);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.conversationId, "conv-1");
  assert.equal(body.assistantMessageId, "msg-1");
  assert.equal(JSON.stringify(body).includes("apiKey"), false);
});

test("an absent turn id is omitted rather than sent as an empty string", async () => {
  const calls = stubComboStream(TURN_EVENTS);
  await runComboTurn({ messages: [{ role: "user", content: "hi" }] });
  const body = JSON.parse(calls[0].init.body);
  assert.equal("conversationId" in body, false);
  assert.equal("assistantMessageId" in body, false);
});

test("every raw Combo event reaches the live provider network", async () => {
  stubComboStream(TURN_EVENTS);
  const seen = [];
  await runComboTurn({ messages: [{ role: "user", content: "hi" }], onRunEvent: event => seen.push(event.type) });
  assert.deepEqual(seen, TURN_EVENTS.map(event => event.type));
});

test("a save warning on a completed run is reported, never hidden", async () => {
  stubComboStream([
    ...TURN_EVENTS.slice(0, 4),
    { type: "delta", content: "Answer" },
    {
      type: "done",
      conversationId: "conv-1",
      messageId: "msg-1",
      saveWarning: { code: "save_failed", message: "The answer is shown but could not be saved." }
    }
  ]);
  const result = await runComboTurn({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(result.content, "Answer");
  assert.equal(result.saveWarning.code, "save_failed");
});

test("a failed run keeps its real code and whatever it already produced", async () => {
  stubComboStream([
    { type: "meta", conversationId: "conv-9", messageId: "msg-9" },
    { type: "delta", content: "Partial" },
    { type: "error", code: "no_working_models", message: "None of your selected models answered." }
  ]);
  const error = await runComboTurn({ messages: [{ role: "user", content: "hi" }] }).catch(e => e);
  assert.equal(error.name, "ComboTurnError");
  assert.equal(error.code, "no_working_models");
  assert.equal(error.message, "None of your selected models answered.");
  assert.equal(error.partialContent, "Partial");
  assert.equal(error.conversationId, "conv-9");
});

test("a run that ends without an answer fails instead of completing blank", async () => {
  stubComboStream([
    { type: "meta", conversationId: "conv-1", messageId: "msg-1" },
    { type: "delta", content: "   " },
    { type: "done", conversationId: "conv-1", messageId: "msg-1" }
  ]);
  const error = await runComboTurn({ messages: [{ role: "user", content: "hi" }] }).catch(e => e);
  assert.equal(error.code, "combo_empty_answer");
  assert.equal(error.conversationId, "conv-1");
});

test("Stop passes the abort through instead of relabelling it as a server failure", async () => {
  apiClient.defaults.baseURL = "http://127.0.0.1:4000/api";
  globalThis.fetch = async () => {
    throw abortError();
  };
  const error = await runComboTurn({ messages: [{ role: "user", content: "hi" }] }).catch(e => e);
  assert.equal(error.name, "AbortError");
  assert.equal(error.code, undefined);
});

test("a network failure is surfaced as its own message", async () => {
  apiClient.defaults.baseURL = "http://127.0.0.1:4000/api";
  globalThis.fetch = async () => {
    throw new Error("socket hang up");
  };
  const error = await runComboTurn({ messages: [{ role: "user", content: "hi" }] }).catch(e => e);
  assert.equal(error.name, "ComboApiError");
  assert.match(error.message, /could not reach the server/);
});

test("comboActivityFor turns orchestration events into honest progress lines", () => {
  assert.deepEqual(comboActivityFor({ type: "stage", phase: "", message: "x" }), { phase: "working", message: "x" });
  assert.deepEqual(comboActivityFor({ type: "delta", content: "ignored" }), null);
  assert.deepEqual(comboActivityFor(null), null);
  assert.equal(
    comboActivityFor({
      type: "pool",
      active: [{ key: "a" }, { key: "b" }],
      excluded: [{ key: "c" }],
      deferredCount: 2,
      selectedCount: 5
    }).message,
    "2 models answered the availability check - 1 not working - 2 waiting for a free slot"
  );
  assert.equal(comboActivityFor({ type: "pool", active: [] }).message, "0 models answered the availability check");
  assert.equal(comboActivityFor({ type: "model", status: "started", label: "Claude", index: 1, total: 3 }).message, "Claude is drafting (2 of 3)");
  assert.equal(comboActivityFor({ type: "model", status: "started", label: "Claude", index: 0, total: 1 }).message, "Claude is drafting");
  assert.equal(comboActivityFor({ type: "model", status: "finished", label: "Claude", latencyMs: 2300 }).message, "Claude answered in 2.3s");
  assert.equal(comboActivityFor({ type: "model", status: "finished", label: "Claude" }).message, "Claude answered");
  assert.equal(
    comboActivityFor({ type: "model", status: "failed", label: "Claude" }).message,
    "Claude did not answer - its share is skipped"
  );
  assert.equal(comboActivityFor({ type: "model", status: "cancelled", label: "Claude" }), null);
});
