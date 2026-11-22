import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { apiClient } from "../src/services/api.js";
import { stopChatTurn } from "../src/services/chat.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function functionBody(name) {
  const start = chatPageSource.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is present`);
  let depth = 0;
  let opened = false;
  for (let at = start; at < chatPageSource.length; at += 1) {
    const char = chatPageSource[at];
    if (char !== "{" && char !== "}") continue;
    depth += char === "{" ? 1 : -1;
    if (char === "{") opened = true;
    if (opened && depth === 0) return chatPageSource.slice(start, at + 1);
  }
  assert.fail(`${name} has no closed body`);
}

// Closing the socket is not a Stop. The server keeps generating and still saves
// the answer, so the button has to name the turn it means to end.
test("Stop is a request that names the turn, not just a closed connection", async () => {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async (path, body) => {
    calls.push({ path, body });
    return { data: { stopped: true } };
  };
  try {
    const result = await stopChatTurn("turn-42");
    assert.deepEqual(calls, [{ path: "/chat/stop", body: { messageId: "turn-42" } }]);
    assert.equal(result.stopped, true);
  } finally {
    apiClient.post = original;
  }
});

test("the Stop button tells the server which turn to end", () => {
  const stop = functionBody("handleStop");
  assert.match(stop, /stopChatTurn\(targetId\)/, "the turn is stopped on the server, not only on this screen");
  // The synchronous invalidation still comes first: a chunk already queued must
  // not paint after Stop, whatever the network does next.
  assert.ok(stop.indexOf("requestSeqRef.current += 1") < stop.indexOf("controller?.abort()"));
  assert.ok(stop.indexOf("controller?.abort()") < stop.indexOf("stopChatTurn(targetId)"));
  assert.match(stop, /serverOwnedTurnRef\.current = false;/);
});

test("leaving a chat detaches the turn instead of cancelling it", () => {
  const invalidate = functionBody("invalidateInFlight");
  assert.match(
    invalidate,
    /if \(!serverOwnedTurnRef\.current\) \{[\s\S]*?controller\?\.abort\(\);/,
    "a turn the server owns is left running when the screen leaves it"
  );
  assert.equal(invalidate.includes("stopChatTurn"), false, "navigation is not a Stop");
  // The screen still detaches: no late chunk may paint into another chat.
  assert.match(invalidate, /requestSeqRef\.current \+= 1;/);
  assert.match(invalidate, /streamingIdRef\.current = null;/);
  assert.match(invalidate, /setStreamingId\(null\)/);

  for (const name of ["loadTask", "resetConversation"]) {
    const body = functionBody(name);
    assert.match(body, /invalidateInFlight\(\)/, `${name} detaches the turn`);
    assert.equal(body.includes("stopChatTurn"), false, `${name} must never stop the turn`);
    assert.equal(body.includes(".abort()"), false, `${name} must never abort the turn directly`);
  }
});

test("a request-bound turn is still cancelled when the screen leaves it", () => {
  const invalidate = functionBody("invalidateInFlight");
  const guarded = invalidate.slice(invalidate.indexOf("if (!serverOwnedTurnRef.current)"));
  assert.match(guarded, /cancelDesktopToolOperation\(operationId\)/, "native work is bound to its request");
  // Only the plain chat route owns its turn past the socket. Native tools and
  // Combo still end with their request, so they must not be marked detachable.
  assert.match(chatPageSource, /serverOwnedTurnRef\.current = !useDesktopTools && !selectedRow\?\.combo;/);
});

test("a detached turn refreshes the sidebar when it really settles", () => {
  const start = chatPageSource.indexOf("async function handleSend(");
  assert.ok(start > 0);
  const body = chatPageSource.slice(start, chatPageSource.indexOf("function handleStop()"));
  const settle = body.lastIndexOf("} finally {");
  assert.ok(settle > 0);
  const tail = body.slice(settle);
  assert.match(tail, /if \(isCurrentRequest\(seq\)\)/);
  assert.match(
    tail,
    /\} else if \(serverOwned\) \{[\s\S]*?refreshConversations\(\)/,
    "the badge clears on the turn's real completion, not on a timer"
  );
});

// The row a send inserts locally carries no task state, so on its own it draws a
// chat that is generating with nothing beside its name. The indicator has to
// come from the server's own account of the turn, while the reader is still here.
test("the sidebar badge for a live chat turn is read from the server, not the optimistic row", () => {
  const start = chatPageSource.indexOf("async function handleSend(");
  assert.ok(start > 0);
  const body = chatPageSource.slice(start, chatPageSource.indexOf("function handleStop()"));
  const metaStart = body.indexOf("onMeta: ({ conversationId, messageId }) => {");
  assert.ok(metaStart > 0, "the stream names its conversation");
  const meta = body.slice(metaStart, body.indexOf("onChunk: (chunk) => {", metaStart));
  assert.ok(meta.length > 0);
  assert.match(meta, /upsertConversation\(\{/, "the row still appears the moment the chat is named");
  assert.match(
    meta,
    /if \(serverOwnedTurnRef\.current\) refreshConversations\(\)/,
    "a turn the server owns is re-read so the badge is the persisted state"
  );
  // A native or Combo turn ends with its request and has no live-turn record to
  // read, so it must not pay for a list refresh that can only answer null.
  const guard = meta.indexOf("if (serverOwnedTurnRef.current)");
  assert.ok(guard > meta.indexOf("upsertConversation({"), "the row is inserted before the read");
});