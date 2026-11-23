import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyChatError, presentChatError } from "../src/chat/chatErrors.js";
import { apiClient } from "../src/services/api.js";
import { DesktopChatError, requestError, runDesktopToolChat } from "../src/services/desktopChat.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8");

function httpError(status, data) {
  return { message: "Request failed with status code " + status, response: { status, data } };
}

test("a missing desktop tool endpoint is reported as an unavailable feature, not a failed message", () => {
  // The production backend predates /api/chat/desktop-tools, so every tool
  // turn answered 404 "That API route does not exist."
  const mapped = requestError(httpError(404, { message: "That API route does not exist." }));

  assert.ok(mapped instanceof DesktopChatError);
  assert.equal(mapped.code, "desktop_tools_unavailable");
  assert.equal(mapped.status, 404);
  assert.equal(requestError(httpError(405, {})).code, "desktop_tools_unavailable");
});

test("real desktop tool failures keep their server code", () => {
  assert.equal(requestError(httpError(400, { code: "tool_calling_unsupported", message: "no" })).code, "tool_calling_unsupported");
  assert.equal(requestError(httpError(500, { code: "tool_run_failed", message: "boom" })).code, "tool_run_failed");
  assert.equal(requestError(httpError(415, {})).code, "desktop_chat_failed");
});

test("desktop tool failures never fall through to the generic card", () => {
  for (const code of ["desktop_tools_unavailable", "desktop_chat_failed", "invalid_tool_response", "tool_round_limit"]) {
    const error = Object.assign(new Error("That API route does not exist."), { code, status: 404 });
    assert.equal(classifyChatError(error), "desktop_tools", code);
    const presented = presentChatError(error, { modelLabel: "Vups v3 Galax" });
    assert.match(presented.title, /Local (Windows tools unavailable|tools stopped)/, code);
    assert.doesNotMatch(presented.message, /something went wrong/i, code);
    assert.equal(presented.canSwitchModel, false, code);
  }
});

test("an expired session on the tool route keeps its own card", () => {
  const error = Object.assign(new Error("Session expired."), { code: "desktop_chat_failed", status: 401 });
  assert.equal(classifyChatError(error), "access_denied");
});

test("a server-side tool failure the client has never seen still explains itself", () => {
  // Reproduced against the deployed backend: the tool route answered
  // 400 "The provider rejected the request (HTTP 400)... not a valid model ID"
  // with code "bad_request", which no client-side code list covered. It must
  // not be relabelled as missing local tools — the provider's sentence is the
  // evidence the user needs.
  const error = new DesktopChatError(
    "The provider rejected the request (HTTP 400). Provider said: vups-v3-galax is not a valid model ID",
    "bad_request",
    400
  );
  assert.notEqual(classifyChatError(error), "desktop_tools");
  const presented = presentChatError(error, { modelLabel: "Vups v3 Galax" });
  assert.match(presented.message, /not a valid model ID/);
  assert.doesNotMatch(presented.title, /Local Windows tools unavailable/);
  assert.doesNotMatch(presented.message, /something went wrong/i);
});

test("a failure after real local work says what was kept instead of denying it", () => {
  const error = new DesktopChatError("The local tool request stopped while the round was running.", "desktop_chat_failed", 400);
  error.toolSteps = [
    { tool: "write_file", label: "Write index.html", ok: true },
    { tool: "write_file", label: "Write style.css", ok: true },
    { tool: "write_file", label: "Write script.js", ok: false }
  ];
  error.filesystemCompleted = true;

  const presented = presentChatError(error, { modelLabel: "Vups v3 Galax" });
  assert.equal(presented.title, "Local tools stopped partway");
  assert.match(presented.message, /2 local steps/);
  assert.match(presented.message, /finished and are kept/);
  assert.doesNotMatch(presented.message, /did not happen/);
  assert.match(presented.message, /stopped while the round was running/i);
});

test("a tool-route rejection with its own sentence shows that sentence", () => {
  const error = new DesktopChatError("A previous tool call names a local tool this server does not offer.", "desktop_chat_failed", 400);
  const presented = presentChatError(error);
  assert.equal(presented.title, "Local tools stopped");
  assert.match(presented.message, /does not offer/);
});

test("an exhausted busy run reads as a busy model, not a missing tool", () => {
  const presented = presentChatError(new DesktopChatError("This desktop tool run is already waiting for a model response.", "run_busy", 409));
  assert.equal(presented.category, "rate_limit");
  assert.match(presented.title, /busy/i);
  assert.doesNotMatch(presented.title, /unavailable/i);
});

test("transient tool rounds are retried before the turn fails", async () => {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async () => {
    calls.push(Date.now());
    if (calls.length === 1) {
      const error = new Error("Request failed with status code 409");
      error.response = { status: 409, data: { code: "run_busy", message: "This desktop tool run is already waiting for a model response." } };
      throw error;
    }
    return { data: { type: "final", content: "Recovered.", finishReason: "stop" } };
  };

  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Write the three files." }],
      operationId: "retry_operation_1"
    });
    assert.equal(result.content, "Recovered.");
    assert.equal(calls.length, 2, "one busy round is retried, then the answer arrives");
  } finally {
    apiClient.post = original;
  }
});

test("a dropped connection is retried and no local tool runs twice", async () => {
  const original = apiClient.post;
  const executed = [];
  let attempts = 0;
  apiClient.post = async () => {
    attempts += 1;
    if (attempts === 1) {
      // The response never arrived, so any tool calls it might have carried
      // were never executed by the app; retrying cannot duplicate work.
      throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    }
    if (attempts === 2) {
      return {
        data: {
          type: "tool_calls",
          toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"C:\\\\a.txt\"}" } }],
          assistantMessage: { role: "assistant", content: null }
        }
      };
    }
    return { data: { type: "final", content: "Done.", finishReason: "stop" } };
  };

  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Please continue writing the project." }],
      operationId: "retry_operation_2",
      executeTool: async (tool) => {
        executed.push(tool);
        return { ok: true, data: { content: "hello" } };
      }
    });
    assert.equal(result.content, "Done.");
    assert.equal(attempts, 3, "the dropped round was retried once, then the loop continued");
    assert.deepEqual(executed, ["read_file"], "the tool ran exactly once");
  } finally {
    apiClient.post = original;
  }
});

test("a 400 validation answer is not retried", async () => {
  const original = apiClient.post;
  let attempts = 0;
  apiClient.post = async () => {
    attempts += 1;
    const error = new Error("Request failed with status code 400");
    error.response = { status: 400, data: { message: "A previous tool call is larger than the server can replay." } };
    throw error;
  };

  try {
    await assert.rejects(
      () => runDesktopToolChat({ messages: [{ role: "user", content: "Continue." }], operationId: "retry_operation_3" }),
      (error) => {
        assert.match(error.message, /larger than the server can replay/i);
        return true;
      }
    );
    assert.equal(attempts, 1);
  } finally {
    apiClient.post = original;
  }
});

test("the too-many-steps card tells the user to narrow the request", () => {
  const presented = presentChatError(
    Object.assign(new Error("The assistant used too many local filesystem tool rounds."), { code: "tool_round_limit" }),
    { modelLabel: "Vups v3 Galax" }
  );
  assert.match(presented.message, /fewer files|without the workspace/i);
});

test("the chat page resends a tool turn as a plain chat when tools are unavailable", () => {
  const fallback = chatPageSource.replace(/\r\n/g, "\n");
  assert.match(fallback, /const DESKTOP_TOOL_FALLBACK_REASONS = \{/);
  assert.match(fallback, /tool_calling_unsupported:/);
  assert.match(fallback, /desktop_tools_unavailable:/);

  const block = fallback.slice(
    fallback.indexOf("if (useDesktopTools) {"),
    fallback.indexOf("if (useDesktopTools) {") + 3400
  );
  assert.match(block, /catch \(error\) \{/);
  assert.match(block, /DESKTOP_TOOL_FALLBACK_REASONS\[error\?\.code\]/);
  assert.match(block, /if \(!reason\) throw error;/);
  assert.match(block, /setComposerWarning\(reason\);/);
  // The fallback must reuse the same prompt and model, not a stripped request.
  assert.match(block, /result = await streamChatResponse\(requestOptions\);/);
});

test("an explicit Windows action is routed natively before a model can refuse it", async () => {
  const original = apiClient.post;
  let posted = false;
  apiClient.post = async () => {
    posted = true;
    return { data: { type: "final", content: "I cannot access your computer." } };
  };
  try {
    const calls = [];
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Open Notepad" }],
      userText: "Open Notepad",
      workspacePath: "C:\\Users\\test\\Documents\\VupsRouter\\Files",
      operationId: "native_action_test",
      executeTool: async (tool, args) => {
        calls.push({ tool, args });
        return { ok: true, data: { name: "Notepad", pid: 1234, running: true } };
      }
    });
    assert.equal(posted, false, "a direct action does not depend on provider tool calling");
    assert.deepEqual(calls, [{ tool: "launch_app", args: { name: "Notepad" } }]);
    assert.match(result.content, /Notepad launched/);
    assert.match(result.content, /PID 1234/);
  } finally {
    apiClient.post = original;
  }
});

test("a plain question on a server without the endpoint sends no warning card", () => {
  const source = chatPageSource.replace(/\r\n/g, "\n");
  // The card is only owed to the user when a project folder made tools the
  // point of the turn; otherwise every message would carry a feature notice.
  assert.match(source, /const warnAboutSkippedTools = Boolean\(sendWorkspace\?\.id\);/);
  assert.match(source, /if \(warnAboutSkippedTools\) setComposerWarning\(reason\);/);
  assert.doesNotMatch(source, /\n\s*setComposerWarning\(reason\);/);
});

test("a server without the tool endpoint is remembered, but explicit actions still retry it", () => {
  const source = chatPageSource.replace(/\r\n/g, "\n");
  assert.match(source, /const DESKTOP_TOOLS_MISSING_KEY = "vr\.desktopToolsMissing";/);

  const gate = source.slice(source.indexOf("const useDesktopTools ="), source.indexOf("const useDesktopTools =") + 700);
  assert.match(gate, /nativeShell === NATIVE_SHELLS\.windows/);
  assert.match(gate, /Boolean\(workspaceOwner\)/);
  assert.match(gate, /imagePayload\.length === 0/);
  assert.match(gate, /looksLikeDesktopActionRequest\(requestText\)/);
  assert.match(gate, /looksLikeDesktopActionRequest\(requestText\) \|\| !serverLacksToolEndpoint/);

  // Only the missing-endpoint code is a server-wide fact; a model that cannot
  // call tools must not disable the endpoint for the rest of the session.
  const record = source.slice(
    source.indexOf('if (error.code === "desktop_tools_unavailable") {'),
    source.indexOf('if (error.code === "desktop_tools_unavailable") {') + 220
  );
  assert.match(record, /setItem\(DESKTOP_TOOLS_MISSING_KEY, "1"\)/);
  assert.match(record, /setServerLacksToolEndpoint\(true\)/);
  // Session storage, not local storage: the next launch re-probes a redeployed backend.
  assert.match(source, /sessionBrowserStorage\(\)\?\.setItem\(DESKTOP_TOOLS_MISSING_KEY/);
  assert.doesNotMatch(source, /localBrowserStorage\(\)\?\.setItem\(DESKTOP_TOOLS_MISSING_KEY/);
});

test("the desktop service reports the production 404 as an unavailable endpoint", async () => {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    const error = new Error("Request failed with status code 404");
    error.response = { status: 404, data: { message: "That API route does not exist." } };
    throw error;
  };

  try {
    await assert.rejects(
      () => runDesktopToolChat({ messages: [{ role: "user", content: "hii" }], model: "vups-v3-galax", vups: true }),
      (error) => {
        assert.ok(error instanceof DesktopChatError);
        assert.equal(error.code, "desktop_tools_unavailable");
        assert.equal(error.status, 404);
        return true;
      }
    );
    assert.equal(calls.length, 1, "one request per turn, no retry loop");
    assert.equal(calls[0].url, "/chat/desktop-tools");
    assert.equal(calls[0].body.messages[0].content, "hii");
    assert.equal(calls[0].body.vups, true);
  } finally {
    apiClient.post = original;
  }
});

test("the desktop service still returns an answer when the endpoint exists", async () => {
  const original = apiClient.post;
  apiClient.post = async () => ({
    data: {
      type: "final",
      content: "VupsRouter works.",
      conversationId: "conv-1",
      message: { messageId: "m-1" },
      finishReason: "stop"
    }
  });

  try {
    const chunks = [];
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "hii" }],
      onChunk: (chunk) => chunks.push(chunk),
      onMeta: () => {}
    });
    assert.equal(result.content, "VupsRouter works.");
    assert.deepEqual(chunks, ["VupsRouter works."]);
    assert.equal(result.conversationId, "conv-1");
    assert.equal(result.messageId, "m-1");
  } finally {
    apiClient.post = original;
  }
});

/**
 * A round that had to be sent again is a phase of the turn the reader watched,
 * so it has to read as one. These rows are the app's own account of its link,
 * which is why they stay on this screen: a second device reading the same saved
 * log must not be told a connection it never held went down.
 */
function reconnectionRun(script, operationId = "reconnect_operation") {
  const rows = [];
  const calls = [];
  let attempts = 0;
  const original = apiClient.post;
  apiClient.post = async (url, body) => {
    attempts += 1;
    calls.push({ url, body });
    const outcome = script[`${attempts}`] || script.other;
    if (outcome === "network") throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    if (typeof outcome === "object" && outcome.status) {
      throw Object.assign(new Error(`Request failed with status code ${outcome.status}`), {
        response: { status: outcome.status, data: outcome.data || {} }
      });
    }
    return { data: outcome };
  };
  const run = () =>
    runDesktopToolChat({
      messages: [{ role: "user", content: "Add a footer to the landing page." }],
      operationId,
      executeTool: async () => ({ ok: true, data: { content: "hello" } }),
      onProgress: events => rows.push(...events)
    });
  const finish = () => {
    apiClient.post = original;
  };
  const lines = () => rows.filter(row => row.phase === "connection");
  return { run, finish, lines, rows, calls };
}

const FINAL = { type: "final", content: "Done.", finishReason: "stop" };
const ONE_CALL = {
  type: "tool_calls",
  toolCalls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"C:\\\\a.txt\"}" } }],
  assistantMessage: { role: "assistant", content: null }
};

test("a round the app had to send again opens a line and settles that same line when it lands", async () => {
  const harness = reconnectionRun({ 1: "network", other: FINAL });
  try {
    const result = await harness.run();
    assert.equal(result.content, "Done.");
    const lines = harness.lines();
    assert.equal(lines.length, 2, "the wait and what became of it are one line the reader watched move");
    assert.equal(lines[0].key, "connection:1");
    assert.equal(lines[0].status, "running");
    assert.match(lines[0].message, /connection to the server dropped/i);
    assert.equal(lines[1].key, lines[0].key, "the retry settles the line it opened instead of adding a second one");
    assert.equal(lines[1].status, "completed");
    assert.match(lines[1].message, /reconnected/i);
    // It reads in the order it happened: after the round it belongs to was
    // announced, so the line is not sitting above work that came before it.
    const providerIndex = harness.rows.findIndex(row => row.key === "provider:0");
    assert.ok(providerIndex >= 0, "the round announces itself");
    assert.ok(providerIndex < harness.rows.indexOf(lines[0]), "the retry line comes after the round it retried");
  } finally {
    harness.finish();
  }
});

test("a round the server refused to take is not reported as a lost connection", async () => {
  const harness = reconnectionRun({
    1: { status: 409, data: { code: "run_busy", message: "This desktop tool run is already waiting for a model response." } },
    other: FINAL
  });
  try {
    await harness.run();
    const [opened, settled] = harness.lines();
    assert.match(opened.message, /server did not answer/i, "a busy run is not a dead link, and the line says which");
    assert.doesNotMatch(opened.message, /connection/i);
    assert.match(settled.message, /retry was accepted/i);
    assert.doesNotMatch(settled.message, /reconnected/i);
  } finally {
    harness.finish();
  }
});

test("a turn whose retries ran out closes the line instead of leaving it running", async () => {
  const harness = reconnectionRun({ other: { status: 503, data: { message: "The server is busy." } } });
  try {
    await assert.rejects(() => harness.run(), error => error.status === 503);
    const lines = harness.lines();
    assert.equal(lines.length, 2, "one lost episode is one line, however many tries it took");
    assert.equal(lines[0].status, "running");
    assert.equal(lines[1].status, "failed", "a stopped round cannot be shown as a step still in flight");
    assert.equal(lines[1].key, lines[0].key, "the last try closes the line the first loss opened");
    assert.match(lines[1].message, /did not go through/i);
    assert.equal(harness.calls.length, 3, "one round and two retries, then the turn is failed");
  } finally {
    harness.finish();
  }
});

test("two rounds lost in one turn get two lines, not one line repainted", async () => {
  const harness = reconnectionRun({ 1: "network", 2: ONE_CALL, 3: "network", other: FINAL });
  try {
    const result = await harness.run();
    assert.equal(result.content, "Done.");
    assert.deepEqual(
      harness.lines().map(row => `${row.key}:${row.status}`),
      ["connection:1:running", "connection:1:completed", "connection:2:running", "connection:2:completed"],
      "a settled line is never reopened by the next loss, so each one keeps its own record"
    );
  } finally {
    harness.finish();
  }
});

test("a turn that never lost a round raises no connection line and uploads none of its own rows", async () => {
  const harness = reconnectionRun({ other: FINAL });
  try {
    await harness.run();
    assert.deepEqual(harness.lines(), [], "no loss happened, so no line claims one");
    assert.deepEqual([...new Set(harness.calls.map(call => call.url))], ["/chat/desktop-tools"]);
    assert.doesNotMatch(
      JSON.stringify(harness.calls.map(call => call.body)),
      /connection:|reconnected|retry was accepted/i,
      "the app's own connection lines are never sent to the durable log"
    );
  } finally {
    harness.finish();
  }
});
