/**
 * Assistant turn lifecycle.
 *
 * Every assistant turn has exactly one status. Once a turn reaches a terminal
 * status it is never rewritten by a late stream callback:
 *   completed and cancelled are final;
 *   interrupted and failed can only move forward through an explicit
 *   continuation or a brand-new request.
 */

export const TURN_STATUS = Object.freeze({
  PENDING: "pending",
  STREAMING: "streaming",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
  FAILED: "failed",
  CANCELLED: "cancelled"
});

const ACTIVE_STATUSES = new Set([TURN_STATUS.PENDING, TURN_STATUS.STREAMING]);
const LOCKED_STATUSES = new Set([TURN_STATUS.COMPLETED, TURN_STATUS.CANCELLED]);

export function isActiveTurn(status) {
  return ACTIVE_STATUSES.has(status);
}

export function isTerminalTurn(status) {
  return !isActiveTurn(status);
}

export function createAssistantTurn({ id, steps = [], status = TURN_STATUS.PENDING } = {}) {
  return {
    id,
    messageId: id,
    role: "assistant",
    content: "",
    steps: [...steps],
    status,
    error: null,
    saveWarning: null,
    truncated: null,
    artifact: null
  };
}

function mapTurn(messages, id, update) {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== id) return message;
    const updated = update(message);
    if (!updated || updated === message) return message;
    changed = true;
    return updated;
  });
  return changed ? next : messages;
}

function longerContent(current, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return current;
  return candidate.length >= current.length ? candidate : current;
}

export function appendTurnChunk(messages, id, chunk) {
  if (!chunk) return messages;
  return mapTurn(messages, id, (message) => {
    if (!isActiveTurn(message.status)) return message;
    return {
      ...message,
      status: TURN_STATUS.STREAMING,
      content: message.content + chunk
    };
  });
}

export function appendTurnStep(messages, id, step) {
  if (!step) return messages;
  return mapTurn(messages, id, (message) => {
    if (!isActiveTurn(message.status)) return message;
    if (message.steps?.includes(step)) return message;
    return { ...message, steps: [...(message.steps || []), step] };
  });
}

export function markTurnMeta(messages, id, { messageId, conversationId } = {}) {
  return mapTurn(messages, id, (message) => {
    if (!isActiveTurn(message.status)) return message;
    return {
      ...message,
      ...(messageId ? { messageId } : {}),
      ...(conversationId ? { conversationId } : {})
    };
  });
}

/**
 * Finalizes a turn as completed. A completed turn is immutable: later
 * cleanup, duplicate done events, or post-stream errors cannot change it.
 */
export function completeTurn(messages, id, { content, messageId, artifact, finishReason, saveWarning = null } = {}) {
  return mapTurn(messages, id, (message) => {
    if (LOCKED_STATUSES.has(message.status)) return message;
    return {
      ...message,
      status: TURN_STATUS.COMPLETED,
      content: longerContent(message.content, content),
      ...(messageId ? { messageId } : {}),
      ...(artifact ? { artifact } : {}),
      truncated: finishReason === "length" ? "length" : null,
      error: null,
      saveWarning
    };
  });
}

export function interruptTurn(messages, id, { content, messageId, artifact } = {}) {
  return mapTurn(messages, id, (message) => {
    if (LOCKED_STATUSES.has(message.status)) return message;
    return {
      ...message,
      status: TURN_STATUS.INTERRUPTED,
      content: longerContent(message.content, content),
      ...(messageId ? { messageId } : {}),
      ...(artifact ? { artifact } : {}),
      truncated: null,
      error: null,
      saveWarning: message.saveWarning || null
    };
  });
}

export function failTurn(messages, id, { error, content, messageId, artifact } = {}) {
  return mapTurn(messages, id, (message) => {
    if (LOCKED_STATUSES.has(message.status)) return message;
    return {
      ...message,
      status: TURN_STATUS.FAILED,
      content: longerContent(message.content, content),
      ...(messageId ? { messageId } : {}),
      ...(artifact ? { artifact } : {}),
      truncated: null,
      error: error || message.error,
      saveWarning: null
    };
  });
}

/**
 * Marks a user-initiated stop. Empty placeholders are removed entirely so
 * they can never be sent back to the backend as empty history.
 */
export function cancelTurn(messages, id) {
  let changed = false;
  const next = [];
  for (const message of messages) {
    if (message.id !== id) {
      next.push(message);
      continue;
    }
    if (message.status === TURN_STATUS.COMPLETED) {
      next.push(message);
      continue;
    }
    const hasOutput = Boolean(String(message.content || "").trim() || message.artifact);
    if (!hasOutput) {
      changed = true;
      continue;
    }
    changed = true;
    next.push({
      ...message,
      status: TURN_STATUS.CANCELLED,
      truncated: null,
      error: null
    });
  }
  return changed ? next : messages;
}

/** Explicit user action: a continuation may revive an interrupted turn. */
export function beginContinuation(messages, id, steps = []) {
  return mapTurn(messages, id, (message) => ({
    ...message,
    status: TURN_STATUS.STREAMING,
    steps: [...steps],
    error: null,
    saveWarning: null,
    truncated: null
  }));
}

export function hasRecoverableOutput(message) {
  return Boolean(String(message?.content || "").trim() || message?.artifact);
}

/**
 * History sent back to the provider must never contain empty assistant
 * messages: the backend rejects the whole request with
 * "Message content cannot be empty."
 */
export function sanitizeHistoryMessages(messages) {
  return (messages || []).filter((message) => {
    if (message?.role === "assistant") return hasRecoverableOutput(message);
    if (message?.role === "user") {
      return Boolean(String(message?.content || "").trim()) ||
        (Array.isArray(message?.images) && message.images.length > 0);
    }
    return false;
  });
}
