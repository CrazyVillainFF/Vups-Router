/**
 * The send path's local record of a message the backend has not confirmed yet.
 *
 * The user's message is written here before the network call, so a failed or
 * unanswered submission is retried under the same message id: the text is
 * never silently dropped, and a retry can never write it twice.
 */

const OUTBOX_KEY = "vupsrouter.chat.outbox.v1";
const OUTBOX_LIMIT = 20;

function readOutbox(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry === "object") : [];
  } catch {
    return [];
  }
}

function writeOutbox(storage, entries) {
  try {
    storage?.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-OUTBOX_LIMIT)));
  } catch {
    /* A device that cannot store the entry still has the draft in the composer. */
  }
}

function sameEntry(entry, { userId, messageId }) {
  return String(entry.userId) === String(userId) && entry.messageId === messageId;
}

function forget(storage, userId, messageId) {
  writeOutbox(storage, readOutbox(storage).filter(entry => !sameEntry(entry, { userId, messageId })));
}

/**
 * The pending record a retry should continue. An entry with the same id is the
 * same attempt; an entry with the same text in the same chat (or in the same
 * not-yet-created chat) is an attempt whose response was lost, and reusing its
 * id is what keeps a retry from creating a second copy.
 */
export function pendingChatMessage(storage, { userId, conversationId = "", content = "", messageId = "" } = {}) {
  return readOutbox(storage).find(entry => {
    if (String(entry.userId) !== String(userId)) return false;
    if (messageId && entry.messageId === messageId) return true;
    if (entry.content !== content) return false;
    if (conversationId) return entry.conversationId === conversationId;
    return !entry.conversationId;
  }) || null;
}

/**
 * Stores the message, then asks the backend to confirm it. Resolves with the
 * permanent conversation and message ids only after the backend answered; a
 * rejection leaves the entry in place for a safe retry.
 */
export async function saveChatMessageFirst({
  createConversation,
  appendConversationMessage,
  storage,
  userId,
  conversationId = "",
  content,
  messageId,
  title = "",
  store = "cloud"
} = {}) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("A message needs some text.");
  }
  if (!messageId) throw new Error("A message needs a stable id.");
  const pending = pendingChatMessage(storage, { userId, conversationId, content, messageId });
  const stableId = pending?.messageId || messageId;
  const knownConversationId = conversationId || pending?.conversationId || "";
  const entry = {
    userId,
    messageId: stableId,
    conversationId: knownConversationId,
    content,
    title: title || String(content).replace(/\s+/g, " ").trim().slice(0, 60),
    store: store === "local" ? "local" : "cloud",
    at: Date.now()
  };
  writeOutbox(storage, [
    ...readOutbox(storage).filter(item => !sameEntry(item, { userId, messageId: stableId })),
    entry
  ]);
  if (knownConversationId) {
    await appendConversationMessage(knownConversationId, { role: "user", content, messageId: stableId });
    forget(storage, userId, stableId);
    return { conversationId: knownConversationId, messageId: stableId };
  }
  const created = await createConversation({ handoff: content, title: entry.title, messageId: stableId });
  if (!created?.id) throw new Error("The conversation was not created.");
  forget(storage, userId, stableId);
  return { conversationId: created.id, messageId: stableId };
}

/**
 * Re-sends whatever the device still holds for this account. Runs when the app
 * opens: an entry that never reached the backend lands in its conversation
 * once, and the ids make that safe to attempt on every open.
 */
export async function flushPendingChatMessages({
  createConversation,
  appendConversationMessage,
  nativeCreateConversation = null,
  nativeAppendConversationMessage = null,
  storage,
  userId
} = {}) {
  const synced = [];
  for (const entry of readOutbox(storage)) {
    if (String(entry.userId) !== String(userId)) continue;
    const local = entry.store === "local";
    const create = local ? nativeCreateConversation : createConversation;
    const append = local ? nativeAppendConversationMessage : appendConversationMessage;
    if (typeof create !== "function" || typeof append !== "function") continue;
    try {
      if (entry.conversationId) {
        await append(entry.conversationId, {
          role: "user",
          content: entry.content,
          messageId: entry.messageId
        });
        synced.push({
          messageId: entry.messageId,
          conversationId: entry.conversationId,
          ...(local ? { store: "local" } : {})
        });
      } else {
        const created = await create({
          handoff: entry.content,
          title: entry.title || "",
          messageId: entry.messageId
        });
        if (!created?.id) continue;
        synced.push({
          messageId: entry.messageId,
          conversationId: created.id,
          ...(local ? { store: "local" } : {})
        });
      }
      forget(storage, userId, entry.messageId);
    } catch {
      /* Keep it: the next open tries again. */
    }
  }
  return synced;
}
