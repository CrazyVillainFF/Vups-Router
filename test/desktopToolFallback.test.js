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
    assert.equal(presented.title, "Local file tools unavailable", code);
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
  // with code "bad_request", which no client-side code list covered, so the turn
  // rendered the generic card.
  const error = new DesktopChatError(
    "The provider rejected the request (HTTP 400). Provider said: vups-v3-galax is not a valid model ID",
    "bad_request",
    400
  );
  assert.equal(classifyChatError(error), "desktop_tools");
  const presented = presentChatError(error, { modelLabel: "Vups v3 Galax" });
  assert.equal(presented.title, "Local file tools unavailable");
  assert.doesNotMatch(presented.message, /something went wrong/i);
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
    fallback.indexOf("if (useDesktopTools) {") + 1200
  );
  assert.match(block, /catch \(error\) \{/);
  assert.match(block, /DESKTOP_TOOL_FALLBACK_REASONS\[error\?\.code\]/);
  assert.match(block, /if \(!reason\) throw error;/);
  assert.match(block, /setComposerWarning\(reason\);/);
  // The fallback must reuse the same prompt and model, not a stripped request.
  assert.match(block, /result = await streamChatResponse\(requestOptions\);/);
});

test("a plain question on a server without the endpoint sends no warning card", () => {
  const source = chatPageSource.replace(/\r\n/g, "\n");
  // The card is only owed to the user when a project folder made tools the
  // point of the turn; otherwise every message would carry a feature notice.
  assert.match(source, /const warnAboutSkippedTools = Boolean\(activeWorkspace\?\.id\);/);
  assert.match(source, /if \(warnAboutSkippedTools\) setComposerWarning\(reason\);/);
  assert.doesNotMatch(source, /\n\s*setComposerWarning\(reason\);/);
});

test("a server without the tool endpoint is probed once per app session", () => {
  const source = chatPageSource.replace(/\r\n/g, "\n");
  assert.match(source, /const DESKTOP_TOOLS_MISSING_KEY = "vr\.desktopToolsMissing";/);

  const gate = source.slice(source.indexOf("const useDesktopTools ="), source.indexOf("const useDesktopTools =") + 320);
  assert.match(gate, /nativeShell === NATIVE_SHELLS\.windows/);
  assert.match(gate, /Boolean\(workspaceOwner\)/);
  assert.match(gate, /imagePayload\.length === 0/);
  assert.match(gate, /!serverLacksToolEndpoint/);

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
