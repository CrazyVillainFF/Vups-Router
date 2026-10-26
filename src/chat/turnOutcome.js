import {
  isInterruptedError,
  isPersistenceError,
  isPersistenceFailureCode,
  presentChatError
} from "./chatErrors.js";
import { completeTurn, failTurn, interruptTurn } from "./turnLifecycle.js";

/**
 * Applies exactly one terminal outcome to an assistant turn after a failed
 * request. A completed answer whose secondary save failed stays completed with
 * a save warning; an interrupted stream with output keeps the partial answer;
 * everything else fails once.
 */
export function settleTurnFromError(messages, id, {
  error,
  modelLabel = "",
  content = "",
  messageId = null,
  artifact = null,
  recoverArtifact = null,
  preferArtifact = false
} = {}) {
  const text = preferArtifact ? "" : typeof content === "string" ? content : "";
  const presentation = presentChatError(error, { modelLabel });
  const resolvedMessageId = messageId || error?.messageId || null;
  const savedArtifact = error?.artifact || artifact || null;
  const recover = (status) =>
    savedArtifact || (typeof recoverArtifact === "function" ? recoverArtifact(status) : null);

  if (isPersistenceError(error)) {
    return {
      outcome: "save-warning",
      presentation,
      messages: completeTurn(messages, id, {
        content: text,
        messageId: resolvedMessageId,
        artifact: recover("complete"),
        finishReason: "stop",
        saveWarning: presentation
      })
    };
  }

  if (isInterruptedError(error) && (text || savedArtifact || recover("partial"))) {
    return {
      outcome: "interrupted",
      presentation: null,
      messages: interruptTurn(messages, id, {
        content: text,
        messageId: resolvedMessageId,
        artifact: recover("partial")
      })
    };
  }

  return {
    outcome: "failed",
    presentation,
    messages: failTurn(messages, id, {
      error: presentation,
      content: text,
      messageId: resolvedMessageId,
      artifact: savedArtifact
    })
  };
}

/** Save warnings always use the fixed "not saved" copy, never backend detail. */
export function presentSaveWarning(code) {
  return presentChatError({
    code: isPersistenceFailureCode(code) ? code : "persist_failed"
  });
}
