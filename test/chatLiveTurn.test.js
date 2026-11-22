import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

// A turn that outlived the screen that started it has no answer in the
// transcript yet: the server writes it when the turn settles. Reopening the chat
// has to show that turn as running rather than an idle, half-empty conversation.
test("opening a chat that is still answering adopts its running turn", () => {
  const load = functionBody("loadTask");
  assert.match(load, /if \(live && !live\.taskId && !live\.done && live\.messageId\)/);
  assert.match(load, /adoptLiveChatTurn\(id, live\.messageId, history\)/);
});

test("an adopted turn is shown as running and can still be stopped by name", () => {
  const adopt = functionBody("adoptLiveChatTurn");
  assert.match(adopt, /createAssistantTurn\(\{ id: messageId \}\)/, "the transcript shows the turn that is running");
  assert.match(adopt, /streamingIdRef\.current = messageId;/, "Stop names the server's turn, not a local id");
  assert.match(adopt, /serverOwnedTurnRef\.current = true;/, "leaving this chat again must not cancel it");
  assert.match(adopt, /setLoading\(true\)/);
  assert.match(adopt, /watchLiveChatTurn\(conversationId, messageId, seq\)/);
});

test("the watch re-reads the server until the turn really settles", () => {
  const watch = functionBody("watchLiveChatTurn");
  assert.match(watch, /getConversation\(conversationId\)/);
  assert.match(watch, /isCurrentRequest\(seq\)/, "a new request or a Stop ends the watch");
  assert.match(watch, /loadedTaskRef\.current === conversationId/, "the watch never writes into another chat");
  assert.match(watch, /loadTask\(conversationId\)/, "the settled answer comes from the persisted conversation");
  assert.equal(watch.includes("stopChatTurn"), false, "watching a turn is not cancelling it");
  assert.equal(watch.includes(".abort()"), false, "watching a turn is not cancelling it");
});

test("a read that fails leaves the watch running", () => {
  const watch = functionBody("watchLiveChatTurn");
  assert.match(watch, /catch \{[\s\S]*?continue;/, "a dropped request is retried, not treated as a finished turn");
});