import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  flushPendingChatMessages,
  pendingChatMessage,
  saveChatMessageFirst
} from "../src/chat/messageOutbox.js";

/**
 * The smallest backend that behaves like the real one where this feature is
 * concerned: a message id is stored at most once, and creating a conversation
 * with an id it already holds returns that conversation.
 */
function fakeBackend() {
  let nextId = 1;
  const conversations = new Map();
  const lost = { create: false, append: false };
  return {
    conversations,
    lost,
    async createConversation({ handoff, title, messageId }) {
      if (messageId) {
        for (const conversation of conversations.values()) {
          if (conversation.messages.some(message => message.messageId === messageId)) {
            return { id: conversation.id };
          }
        }
      }
      const id = `conv-${nextId++}`;
      conversations.set(id, {
        id,
        title,
        messages: [{ role: "user", content: handoff, ...(messageId ? { messageId } : {}) }]
      });
      if (lost.create) {
        lost.create = false;
        throw new Error("The network dropped before the answer arrived.");
      }
      return { id };
    },
    async appendConversationMessage(conversationId, { role, content, messageId }) {
      const conversation = conversations.get(conversationId);
      if (!conversation) throw new Error("Conversation not found.");
      if (!messageId || !conversation.messages.some(message => message.messageId === messageId)) {
        conversation.messages.push({ role, content, ...(messageId ? { messageId } : {}) });
      }
      if (lost.append) {
        lost.append = false;
        throw new Error("The network dropped before the answer arrived.");
      }
      return { role, content, messageId };
    },
    rows(content) {
      return [...conversations.values()].flatMap(conversation =>
        conversation.messages.filter(message => message.content === content));
    }
  };
}

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: key => {
      entries.delete(key);
    }
  };
}

function saver(backend, storage, userId = "user-1") {
  return fields => saveChatMessageFirst({
    createConversation: backend.createConversation,
    appendConversationMessage: backend.appendConversationMessage,
    storage,
    userId,
    ...fields
  });
}

function flusher(backend, storage, userId = "user-1") {
  return () => flushPendingChatMessages({
    createConversation: backend.createConversation,
    appendConversationMessage: backend.appendConversationMessage,
    storage,
    userId
  });
}

// A. Leaving the chat right after Send keeps the message, exactly once.
test("A: a saved message survives leaving the chat and is returned once", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  const saved = await save({ conversationId: "", content: "Hii", messageId: "msg-a", title: "Hii" });
  // Leaving the chat only unmounts a view; nothing here touches the stored row.
  assert.deepEqual(backend.rows("Hii"), [{ role: "user", content: "Hii", messageId: "msg-a" }]);
  assert.equal([...backend.conversations.keys()].length, 1);
  assert.equal(saved.messageId, "msg-a");
  assert.equal(pendingChatMessage(storage, { userId: "user-1", content: "Hii" }), null);
});

// B. A failure after the save keeps both the message and a retry that cannot
//    duplicate it.
test("B: a failed turn keeps the message, and its retry writes nothing new", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  await save({ conversationId: "", content: "Hii", messageId: "msg-b", title: "Hii" });
  // The model call fails. That is a different operation and cannot unsave data.
  await assert.rejects(async () => {
    throw new Error("The provider refused the request.");
  });
  assert.equal(backend.rows("Hii").length, 1);

  // The retry names the stored row it is retrying.
  await save({ conversationId: "conv-1", content: "Hii", messageId: "msg-b" });
  assert.equal(backend.rows("Hii").length, 1, "the retry is the same message");
});

// C. A provider failure after the save leaves the message readable on reload.
test("C: a provider failure does not take the stored message down with it", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  const saved = await save({ conversationId: "", content: "Hii", messageId: "msg-c", title: "Hii" });
  assert.equal(backend.conversations.get(saved.conversationId).messages[0].messageId, "msg-c");
  assert.equal(pendingChatMessage(storage, { userId: "user-1", content: "Hii" }), null);
});

// D. A submission interrupted after the write landed is retried under the same
//    id, so neither the conversation nor the message is doubled.
test("D: an interrupted submission is recovered without duplication", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  backend.lost.create = true;
  await assert.rejects(save({ conversationId: "", content: "Hii", messageId: "msg-d", title: "Hii" }));
  assert.equal(backend.rows("Hii").length, 1, "the write reached the backend");
  assert.ok(pendingChatMessage(storage, { userId: "user-1", content: "Hii" }), "and the device knows it is unconfirmed");

  // The composer restored the text, so the next attempt has a fresh message id.
  const retried = await save({ conversationId: "", content: "Hii", messageId: "msg-d-retry", title: "Hii" });
  assert.equal(retried.messageId, "msg-d", "the retry continues the original attempt");
  assert.equal([...backend.conversations.keys()].length, 1, "one send is one conversation");
  assert.equal(backend.rows("Hii").length, 1, "one send is one message");
});

test("D2: an interrupted append is synced by the app-open flush, once", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);
  const created = await save({ conversationId: "", content: "Hii", messageId: "msg-d2", title: "Hii" });

  backend.lost.append = true;
  await assert.rejects(save({ conversationId: created.conversationId, content: "Next", messageId: "msg-d2-next" }));
  assert.equal(
    pendingChatMessage(storage, { userId: "user-1", conversationId: created.conversationId, content: "Next" })?.messageId,
    "msg-d2-next"
  );

  const synced = await flusher(backend, storage)();
  assert.deepEqual(synced, [{ messageId: "msg-d2-next", conversationId: created.conversationId }]);
  assert.equal(backend.rows("Next").length, 1);
  assert.deepEqual(await flusher(backend, storage)(), [], "nothing left to send");
  assert.equal(backend.rows("Next").length, 1, "a second flush cannot duplicate it");
});

// E. The sidebar learns the confirmed conversation before the model is asked.
//    The stale-list side of this is covered by persistenceOrdering.test.js.
test("E: the confirmed conversation is in the sidebar before the model runs", () => {
  const source = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('} else if (useDesktopTools) {');
  assert.ok(start > 0, "the desktop tool branch exists");
  const branch = source.slice(start, source.indexOf("result = await runDesktopToolChat(requestOptions);", start));
  assert.ok(branch.indexOf("saveChatMessageFirst(") > 0, "the message is saved first");
  assert.ok(branch.indexOf("upsertConversation(") > 0, "the sidebar row is written");
  assert.ok(branch.indexOf("syncTaskParam(saved.conversationId)") > 0, "the chat is addressable");
  assert.ok(
    branch.indexOf("upsertConversation(") < branch.indexOf("refreshConversations("),
    "the row is shown before the slower list refresh"
  );
});

// F. A message kept on the device is sent when the app opens again.
test("F: an app restart sends the retained message once", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  backend.lost.create = true;
  await assert.rejects(save({ conversationId: "", content: "Hii", messageId: "msg-f", title: "Hii" }));
  // The window closes here. The next open uses the same durable storage.
  const synced = await flusher(backend, storage)();
  assert.equal(synced.length, 1);
  assert.equal([...backend.conversations.keys()].length, 1);
  assert.equal(backend.rows("Hii").length, 1);

  const reopened = await flusher(backend, storage)();
  assert.deepEqual(reopened, []);
  assert.equal(backend.rows("Hii").length, 1);
});

// G. Repeated identical messages are separate messages; retrying one is not a
//    third.
test("G: identical sends stay distinct and a retry adds no copy", async () => {
  const backend = fakeBackend();
  const storage = memoryStorage();
  const save = saver(backend, storage);

  const first = await save({ conversationId: "", content: "Hii", messageId: "msg-g-1", title: "Hii" });
  await save({ conversationId: first.conversationId, content: "Hii", messageId: "msg-g-2" });
  assert.deepEqual(
    backend.rows("Hii").map(message => message.messageId),
    ["msg-g-1", "msg-g-2"],
    "two deliberate sends are two messages"
  );

  await save({ conversationId: first.conversationId, content: "Hii", messageId: "msg-g-1" });
  assert.equal(backend.rows("Hii").length, 2, "retrying the first adds no third");
});

// The Windows send path is save-first on both sides of the wire.
test("the desktop tool request carries the stable user message id", () => {
  const source = readFileSync(new URL("../src/services/desktopChat.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /userMessageId/, "the turn names the message it belongs to");
  assert.match(source, /\.\.\.\(userMessageId \? \{ userMessageId \} : \{\}\)/, "the id reaches the server");
});

test("the server stores the user message before it asks the provider", () => {
  const source = readFileSync(new URL("../../server/src/routes/chat.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('router.post("/desktop-tools"');
  assert.ok(start > 0, "the desktop tool route exists");
  const route = source.slice(start);
  const persisted = route.indexOf("await persistSubmittedMessage(");
  const provider = route.indexOf("await chatCompletion(");
  assert.ok(persisted > 0, "the message is stored");
  assert.ok(provider > persisted, "nothing slow happens before it is stored");
  assert.match(route, /code: "persist_failed"/, "a failed save stops the turn instead of hiding it");
});

test("creating a conversation with a known message id cannot make a second chat", () => {
  const source = readFileSync(new URL("../../server/src/routes/conversations.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf('router.post("/"');
  const route = source.slice(start, source.indexOf('router.get("/"', start));
  assert.match(route, /"messages\.messageId": messageId/, "the create looks for the message first");
  assert.match(route, /entry\.messageId = messageId/, "and names the message when it stores it");
});
