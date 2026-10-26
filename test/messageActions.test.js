import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canPersistFeedback,
  feedbackRequest,
  nextFeedback,
  sharePayload
} from "../src/chat/messageActions.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CONVERSATION_ID = "6adefc59cae7da140c271ff9";

test("feedback toggles between like, dislike, and cleared", () => {
  assert.equal(nextFeedback(null, "like"), "like");
  assert.equal(nextFeedback("like", "dislike"), "dislike");
  assert.equal(nextFeedback("dislike", "like"), "like");
  assert.equal(nextFeedback("like", "like"), null);
  assert.equal(nextFeedback("dislike", "dislike"), null);
  assert.equal(nextFeedback("like", "other"), "like");
  assert.equal(nextFeedback(undefined, "invalid"), null);
});

test("sharing never invents a public conversation URL", () => {
  const content = "Full assistant answer with details.";
  const payload = sharePayload(content);
  assert.deepEqual(payload, { text: content });
  assert.equal("url" in payload, false);
});

test("persisted feedback requires a saved conversation and message", () => {
  assert.equal(canPersistFeedback({ conversationId: CONVERSATION_ID, messageId: "msg-1" }), true);
  assert.equal(canPersistFeedback({ conversationId: "local-abc", messageId: "msg-1" }), false);
  assert.equal(canPersistFeedback({ conversationId: CONVERSATION_ID, messageId: "" }), false);
  assert.equal(canPersistFeedback({}), false);

  assert.deepEqual(
    feedbackRequest({ conversationId: CONVERSATION_ID, messageId: "msg-1", value: "like" }),
    { conversationId: CONVERSATION_ID, messageId: "msg-1", value: "like" }
  );
  assert.deepEqual(
    feedbackRequest({ conversationId: CONVERSATION_ID, messageId: "msg-1", value: null }),
    { conversationId: CONVERSATION_ID, messageId: "msg-1", value: null }
  );
  assert.equal(
    feedbackRequest({ conversationId: "local-abc", messageId: "msg-1", value: "like" }),
    null
  );
  assert.equal(
    feedbackRequest({ conversationId: CONVERSATION_ID, messageId: "msg-1", value: "neutral" }),
    null
  );
});

test("the action row appears only after a successful assistant turn", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(
    page,
    /const showActions =\s*!isUser &&\s*!isStreaming &&\s*status === TURN_STATUS\.COMPLETED &&\s*Boolean\(message\.content\?\.trim\(\)\)/
  );
  assert.match(page, /className="vr-msg-actions"/);
  assert.match(page, /aria-label="Message actions"/);
  assert.match(page, /aria-pressed=\{reaction === "like"\}/);
  assert.match(page, /aria-pressed=\{reaction === "dislike"\}/);
  assert.match(page, /<ThumbsUp/);
  assert.match(page, /<ThumbsDown/);
  assert.match(page, /<ShareNetwork/);
});

test("copy uses the complete response and confirms success", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /await copyText\(message\.content\)/);
  assert.match(page, /markAction\("copied"\)/);
  assert.match(page, /markAction\("copy-failed"\)/);
  assert.match(page, /aria-label=\{copied \? "Copied" : "Copy response"\}/);
  assert.match(page, /<Check size=\{15\}/);
});

test("share prefers the native API and falls back to copying the response", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /typeof navigator\.share === "function"/);
  assert.match(page, /await navigator\.share\(sharePayload\(message\.content\)\)/);
  assert.match(page, /markAction\("share-copied"\)/);
  assert.match(page, /markAction\("share-failed"\)/);
  assert.doesNotMatch(page, /navigator\.share\([^)]*url/);
  assert.doesNotMatch(page, /shareUrl|publicShare|share-link/i);
});

test("like and dislike persist through the conversation API", () => {
  const page = read("src/ChatPage.jsx");
  const api = read("src/services/api.js");
  assert.match(page, /await saveMessageFeedback\(request\)/);
  assert.match(page, /markAction\("feedback-failed"\)/);
  assert.match(page, /setReaction\(previous\)/);
  assert.match(
    api,
    /export async function saveMessageFeedback\(\{ conversationId, messageId, value \}\)/
  );
  assert.match(
    api,
    /apiClient\.put\(\s*`\/conversations\/\$\{conversationId\}\/messages\/\$\{messageId\}\/feedback`,\s*\{ value \}\s*\)/s
  );
});
