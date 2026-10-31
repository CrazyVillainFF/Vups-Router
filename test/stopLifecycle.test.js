import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { apiClient, generateImage } from "../src/services/api.js";
import { runDesktopToolChat } from "../src/services/desktopChat.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const desktopChatSource = readFileSync(
  new URL("../src/services/desktopChat.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the loop to advance.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function toolRound(calls) {
  return {
    data: {
      type: "tool_calls",
      toolCalls: calls,
      assistantMessage: { role: "assistant", content: null }
    }
  };
}

// Stop during a native call racing its completion is the hardest case: the
// filesystem may already have answered, but the stopped turn must not feed that
// result to the model or start another request.
test("a native result that arrives after Stop is never handed back to the model", async () => {
  const original = apiClient.post;
  const calls = [];
  const chunks = [];
  const activity = [];
  const controller = new AbortController();
  let resolveTool;

  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    return toolRound([toolCall("call_slow", "list_directory", { path: "C:\\Users\\test" })]);
  };

  try {
    const run = runDesktopToolChat({
      messages: [{ role: "user", content: "Take a look at the folder for me." }],
      operationId: "turn-slow",
      signal: controller.signal,
      executeTool: () =>
        new Promise(resolve => {
          resolveTool = resolve;
        }),
      onChunk: chunk => chunks.push(chunk),
      onActivity: entry => activity.push(entry.message)
    });

    await waitFor(() => typeof resolveTool === "function");
    controller.abort();
    // The native layer finishes the very call Stop just abandoned.
    resolveTool({ ok: true, data: { path: "C:\\Users\\test", entries: [] } });

    await assert.rejects(run, error => {
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.equal(calls.length, 1, "no model request follows the stopped tool");
    assert.deepEqual(chunks, [], "nothing is painted as the answer");
    assert.ok(activity.some(line => /running/.test(line)));
    assert.ok(
      !activity.some(line => /completed|failed/.test(line)),
      "the abandoned call is never reported as finished work"
    );
  } finally {
    apiClient.post = original;
  }
});

test("Stop between two calls in one tool round runs nothing after the stop", async () => {
  const original = apiClient.post;
  const calls = [];
  const chunks = [];
  const activity = [];
  const executed = [];
  const controller = new AbortController();
  let rejectSecond;

  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    return toolRound([
      toolCall("call_one", "list_directory", { path: "C:\\one" }),
      toolCall("call_two", "list_directory", { path: "C:\\two" }),
      toolCall("call_three", "list_directory", { path: "C:\\three" })
    ]);
  };

  try {
    const run = runDesktopToolChat({
      messages: [{ role: "user", content: "Take a look at the folder for me." }],
      operationId: "turn-multi",
      signal: controller.signal,
      executeTool: (tool, args) => {
        executed.push(args.path);
        if (executed.length === 1) return Promise.resolve({ ok: true, data: { path: args.path, entries: [] } });
        return new Promise((resolve, reject) => {
          rejectSecond = reject;
        });
      },
      onChunk: chunk => chunks.push(chunk),
      onActivity: entry => activity.push(entry.message)
    });

    await waitFor(() => executed.length === 2);
    controller.abort();
    rejectSecond(new Error("The operation was stopped at your request."));

    await assert.rejects(run, error => {
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.deepEqual(executed, ["C:\\one", "C:\\two"], "the third call never starts");
    assert.equal(calls.length, 1, "the stopped round sends no write-up request");
    assert.deepEqual(chunks, []);
    assert.ok(activity.some(line => /completed/.test(line)), "the finished call keeps its real status");
  } finally {
    apiClient.post = original;
  }
});

// "After the action is announced, before it executes": the progress list has
// already said the tool is running, and Stop lands in that same frame.
test("a Stop during the running notice prevents the announced call from executing", async () => {
  const original = apiClient.post;
  const calls = [];
  const executed = [];
  const controller = new AbortController();

  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    return toolRound([toolCall("call_notice", "list_directory", { path: "C:\\Users\\test" })]);
  };

  try {
    const run = runDesktopToolChat({
      messages: [{ role: "user", content: "Take a look at the folder for me." }],
      operationId: "turn-notice",
      signal: controller.signal,
      executeTool: (tool, args) => {
        executed.push(args.path);
        return Promise.resolve({ ok: true, data: { path: args.path, entries: [] } });
      },
      onActivity: entry => {
        if (/— running/.test(entry.message)) controller.abort();
      }
    });

    await assert.rejects(run, error => {
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.deepEqual(executed, [], "the announced call never reaches the native layer");
    assert.equal(calls.length, 1);
  } finally {
    apiClient.post = original;
  }
});

test("Stop after the turn completed changes nothing and repeats no request", async () => {
  const original = apiClient.post;
  const calls = [];
  const chunks = [];
  const controller = new AbortController();

  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    return {
      data: {
        type: "final",
        content: "The folder has 3 entries.",
        conversationId: "conv-done",
        message: { messageId: "m-done" },
        finishReason: "stop"
      }
    };
  };

  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Take a look at the folder for me." }],
      operationId: "turn-done",
      signal: controller.signal,
      executeTool: () => Promise.resolve({ ok: true, data: {} }),
      onChunk: chunk => chunks.push(chunk)
    });
    controller.abort();

    assert.equal(result.content, "The folder has 3 entries.");
    assert.deepEqual(chunks, ["The folder has 3 entries."]);
    assert.equal(calls.length, 1);
  } finally {
    apiClient.post = original;
  }
});

test("the image request carries the Stop signal so the backend fetch is released", async () => {
  const original = apiClient.post;
  const controller = new AbortController();
  let seen = null;

  apiClient.post = (url, body, config) =>
    new Promise((resolve, reject) => {
      seen = { url, body, config };
      config.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("canceled");
          error.name = "CanceledError";
          reject(error);
        },
        { once: true }
      );
    });

  try {
    const pending = generateImage("a red fox in snow", controller.signal);
    await waitFor(() => Boolean(seen));
    controller.abort();
    await assert.rejects(pending, error => {
      assert.equal(error.name, "CanceledError");
      return true;
    });
    assert.equal(seen.url, "/images/generate");
    assert.equal(seen.config.signal, controller.signal, "the caller signal is the one axios aborts");
  } finally {
    apiClient.post = original;
  }
});

// ─── ChatPage guarantees ────────────────────────────────────────────────────
// The page owns the race: it must invalidate the turn before any await, abort
// every operation the turn started, and never let the abort path fall back into
// a retry or a failure card.

test("Stop invalidates the turn synchronously before aborting its requests", () => {
  const start = chatPageSource.indexOf("function handleStop()");
  const end = chatPageSource.indexOf("const CONTINUE_INSTRUCTION");
  assert.ok(start > 0 && end > start, "handleStop is present");
  const stop = chatPageSource.slice(start, end);

  const invalidate = stop.indexOf("requestSeqRef.current += 1");
  const abort = stop.indexOf("controller?.abort()");
  assert.ok(invalidate > 0, "the request sequence is invalidated");
  assert.ok(invalidate < abort, "no queued chunk can pass the guard once Stop is pressed");

  assert.match(stop, /const controller = abortRef\.current;\s*\n\s*abortRef\.current = null;/);
  assert.match(stop, /const imageController = imageAbortRef\.current;\s*\n\s*imageAbortRef\.current = null;/);
  assert.match(stop, /imageController\?\.abort\(\)/);
  assert.match(stop, /cancelDesktopToolOperation\(targetId\)/, "only this turn's native operation is cancelled");
  assert.match(stop, /clearApprovals\(\)/, "a card for the stopped turn is withdrawn");
  assert.match(stop, /sendingRef\.current = false;/);
  assert.match(stop, /setLoading\(false\)/);
  assert.match(stop, /setStreamingId\(null\)/);
  assert.match(stop, /setImageGenerating\(false\)/);
  assert.match(stop, /cancelTurn\(prev, targetId\)/, "the partial answer is kept as cancelled");
  assert.match(stop, /Stopped\. This turn was cancelled and nothing further will run for it\./);
  assert.match(stop, /Image generation was stopped\./);
});

test("an aborted send is cancelled, not retried or turned into an error card", () => {
  const catchAt = chatPageSource.indexOf("} catch (error) {\n      if (!isCurrentRequest(seq)) return;");
  assert.ok(catchAt > 0, "the send catch block is present");
  const tail = chatPageSource.slice(catchAt, catchAt + 2400);
  const abortBranch = tail.indexOf('if (error?.name === "AbortError")');
  const failureBranch = tail.indexOf("settleTurnFromError(prev, assistantId, {");
  assert.ok(abortBranch > 0, "a cancellation has its own branch");
  assert.ok(failureBranch > abortBranch, "a cancelled turn is never settled as a failure");

  // The desktop-tool fallback runs inside the try, so an AbortError rethrown by
  // that catch reaches the cancellation branch instead of resending the prompt.
  assert.match(chatPageSource, /const reason = DESKTOP_TOOL_FALLBACK_REASONS\[error\?\.code\];\s*\n\s*if \(!reason\) throw error;/);
});

test("a permission card that belongs to a stopped or foreign turn is denied natively", () => {
  const listenerAt = chatPageSource.indexOf("return onDesktopToolApproval(prompt => {");
  assert.ok(listenerAt > 0);
  const listener = chatPageSource.slice(listenerAt, listenerAt + 900);
  assert.match(listener, /const activeOperation = streamingIdRef\.current;/);
  assert.match(listener, /if \(!activeOperation \|\| \(prompt\.operationId && prompt\.operationId !== activeOperation\)\)/);
  assert.match(listener, /respondDesktopToolApproval\(prompt\.requestId, "deny"\)/);
});

test("the composer swaps Send for Stop for both chat and image generation", () => {
  assert.match(chatPageSource, /busy=\{loading \|\| imageGenerating\}/);
  assert.match(chatPageSource, /onStop=\{handleStop\}/);
  assert.match(chatPageSource, /operationId: assistantId/, "tool calls carry the turn id Stop cancels");
});

test("the desktop loop rechecks the signal before and after every native call", () => {
  const runAt = desktopChatSource.indexOf("async function runLocalTool(");
  assert.ok(runAt > 0);
  const body = desktopChatSource.slice(runAt, runAt + 2200);
  const checks = body.match(/if \(signal\?\.aborted\) throw abortError\(\);/g) || [];
  assert.equal(checks.length, 3, "before the notice, after the notice, and after the native result");
  assert.ok(
    body.indexOf("— running") < body.indexOf("await executeTool(tool, args)"),
    "the pre-execution check sits between the notice and the native call"
  );
});
