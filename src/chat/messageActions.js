export const FEEDBACK_VALUES = Object.freeze(["like", "dislike"]);

/** Clicking the selected reaction clears it; otherwise it switches. */
export function nextFeedback(current, value) {
  if (!FEEDBACK_VALUES.includes(value)) return current ?? null;
  return current === value ? null : value;
}

/**
 * Sharing always sends the response text. The app has no public conversation
 * links, so a URL is never attached.
 */
export function sharePayload(content) {
  return { text: String(content ?? "") };
}

export function canPersistFeedback({ conversationId, messageId } = {}) {
  return Boolean(
    typeof conversationId === "string" &&
      /^[a-f0-9]{24}$/i.test(conversationId) &&
      typeof messageId === "string" &&
      messageId.trim()
  );
}

export function feedbackRequest({ conversationId, messageId, value } = {}) {
  if (!canPersistFeedback({ conversationId, messageId })) return null;
  if (value !== null && !FEEDBACK_VALUES.includes(value)) return null;
  return { conversationId, messageId: messageId.trim(), value };
}
