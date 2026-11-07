/**
 * Assistant turn lifecycle.
 *
 * Every assistant turn has exactly one status. Once a turn reaches a terminal
 * status it is never rewritten by a late stream callback:
 *   completed and cancelled are final;
 *   interrupted and failed can only move forward through an explicit
 *   continuation or a brand-new request.
 */

import { ACTIVITY_STATUS, applyActivityProgress, applyProgressRows, settleActivity } from "./activity.js";

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

export function createAssistantTurn({ id, status = TURN_STATUS.PENDING, at = Date.now() } = {}) {
  return {
    id,
    messageId: id,
    role: "assistant",
    content: "",
    activity: [],
    startedAt: at,
    completedAt: null,
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

export function recordTurnActivity(messages, id, progress, { runId = "run", at = Date.now() } = {}) {
  return mapTurn(messages, id, (message) => {
    if (!isActiveTurn(message.status)) return message;
    return {
      ...message,
      status: message.status === TURN_STATUS.PENDING ? TURN_STATUS.STREAMING : message.status,
      activity: applyActivityProgress(message.activity, progress, { runId, at })
    };
  });
}

/**
 * Merge a batch of durable progress rows into the turn. These come from the
 * server's task log (or from the app's own native calls), each keyed to the
 * operation it describes, so one operation stays one line as it moves from
 * running to completed.
 */
export function recordTurnProgress(messages, id, events, { runId = "run", at = Date.now() } = {}) {
  return mapTurn(messages, id, (message) => {
    if (!isActiveTurn(message.status)) return message;
    const activity = applyProgressRows(message.activity, events, { runId, at });
    if (activity === message.activity) return message;
    return {
      ...message,
      status: message.status === TURN_STATUS.PENDING ? TURN_STATUS.STREAMING : message.status,
      activity
    };
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
export function completeTurn(messages, id, { content, messageId, artifact, finishReason, saveWarning = null, at = Date.now() } = {}) {
  return mapTurn(messages, id, (message) => {
    if (LOCKED_STATUSES.has(message.status)) return message;
    return {
      ...message,
      status: TURN_STATUS.COMPLETED,
      content: longerContent(message.content, content),
      ...(messageId ? { messageId } : {}),
      ...(artifact ? { artifact } : {}),
      activity: settleActivity(message.activity, ACTIVITY_STATUS.COMPLETED, at),
      completedAt: at,
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
      activity: settleActivity(message.activity, ACTIVITY_STATUS.CANCELLED),
      completedAt: Date.now(),
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
      activity: settleActivity(message.activity, ACTIVITY_STATUS.FAILED),
      completedAt: Date.now(),
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
      activity: settleActivity(message.activity, ACTIVITY_STATUS.CANCELLED),
      completedAt: Date.now(),
      truncated: null,
      error: null
    });
  }
  return changed ? next : messages;
}

/** Explicit user action: a continuation may revive an interrupted turn. */
export function beginContinuation(messages, id, { at = Date.now() } = {}) {
  return mapTurn(messages, id, (message) => ({
    ...message,
    status: TURN_STATUS.STREAMING,
    activity: settleActivity(message.activity, ACTIVITY_STATUS.COMPLETED, at),
    startedAt: at,
    completedAt: null,
    error: null,
    saveWarning: null,
    truncated: null
  }));
}

export function hasRecoverableOutput(message) {
  return Boolean(String(message?.content || "").trim() || message?.artifact);
}

const STORED_MESSAGE_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The id the backend recognises a message by. A saved message already carries
 * the server id; one that has never been stored uses the id this client gave it
 * at submission time, so a retry names the same message instead of creating a
 * second copy of it.
 */
export function storedMessageId(message) {
  const id = typeof message?.messageId === "string" ? message.messageId.trim() : "";
  if (STORED_MESSAGE_ID.test(id)) return id;
  const localId = typeof message?.id === "string" ? message.id.trim() : "";
  return STORED_MESSAGE_ID.test(localId) ? localId : "";
}

/**
 * History sent back to the provider must never contain empty assistant
 * messages: the backend rejects the whole request with
 * "Message content cannot be empty." Failed turns are dropped too — they stay
 * in the transcript so the user can read and retry them, but replaying "the
 * model did not answer" as an assistant message teaches the model to fail the
 * same way.
 */
export function sanitizeHistoryMessages(messages) {
  return (messages || []).filter((message) => {
    if (message?.role === "assistant") {
      return hasRecoverableOutput(message) && message.status !== TURN_STATUS.FAILED;
    }
    if (message?.role === "user") {
      return Boolean(String(message?.content || "").trim()) ||
        (Array.isArray(message?.images) && message.images.length > 0) ||
        (Array.isArray(message?.textFiles) && message.textFiles.length > 0);
    }
    return false;
  });
}
