import { streamComboChat } from "./comboApi.js";

// A Combo run reports its own event grammar. This maps each event onto the
// activity-row shape the single-model stream already uses, so the normal chat
// timeline renders the run without a second progress system.
export function comboActivityFor(event) {
  if (!event || typeof event !== "object") return null;
  switch (event.type) {
    case "stage":
      return {
        phase: typeof event.phase === "string" && event.phase ? event.phase : "working",
        message: typeof event.message === "string" ? event.message : ""
      };
    case "pool": {
      const active = Array.isArray(event.active) ? event.active.length : 0;
      const excluded = Array.isArray(event.excluded) ? event.excluded.length : 0;
      const deferred = Math.max(0, Number(event.deferredCount) || 0);
      const parts = [`${active} model${active === 1 ? "" : "s"} answered the availability check`];
      if (excluded > 0) parts.push(`${excluded} not working`);
      if (deferred > 0) parts.push(`${deferred} waiting for a free slot`);
      return { phase: "pool", message: parts.join(" - ") };
    }
    case "model": {
      const label = typeof event.label === "string" && event.label ? event.label : "A model";
      if (event.status === "started") {
        const ofTotal =
          Number(event.total) > 1 ? ` (${Math.max(1, Number(event.index) || 0) + 1} of ${event.total})` : "";
        return { phase: "model", message: `${label} is drafting${ofTotal}` };
      }
      if (event.status === "finished") {
        const seconds = Number(event.latencyMs);
        const timing = Number.isFinite(seconds) && seconds > 0 ? ` in ${(seconds / 1000).toFixed(1)}s` : "";
        return { phase: "model", message: `${label} answered${timing}` };
      }
      if (event.status === "failed") {
        return { phase: "model", message: `${label} did not answer - its share is skipped` };
      }
      return null;
    }
    default:
      return null;
  }
}

function comboTurnError(message, { code = null, partialContent = "", conversationId = "" } = {}) {
  const error = new Error(message);
  error.name = "ComboTurnError";
  error.code = code;
  error.partialContent = partialContent;
  if (conversationId) error.conversationId = conversationId;
  return error;
}

/**
 * Runs one Combo turn through the shared chat turn callbacks. Resolves with the
 * same fields the single-model stream returns; throws an Error carrying
 * `partialContent` so the chat can keep whatever the run already produced.
 */
export async function runComboTurn({
  messages,
  conversationId,
  assistantMessageId,
  signal,
  onChunk,
  onActivity,
  onMeta,
  onRunEvent
} = {}) {
  let content = "";
  let meta = null;

  const result = await streamComboChat({
    messages,
    ...(conversationId ? { conversationId } : {}),
    ...(assistantMessageId ? { assistantMessageId } : {}),
    signal,
    onEvent: event => {
      onRunEvent?.(event);
      if (event.type === "meta") {
        meta = {
          conversationId: typeof event.conversationId === "string" ? event.conversationId : "",
          messageId: typeof event.messageId === "string" ? event.messageId : ""
        };
        onMeta?.(meta);
        return;
      }
      if (event.type === "delta") {
        const chunk = typeof event.content === "string" ? event.content : "";
        if (!chunk) return;
        content += chunk;
        onChunk?.(chunk);
        return;
      }
      if (event.type === "done") {
        meta = {
          conversationId: typeof event.conversationId === "string" ? event.conversationId : meta?.conversationId || "",
          messageId: typeof event.messageId === "string" ? event.messageId : meta?.messageId || ""
        };
        return;
      }
      const activity = comboActivityFor(event);
      if (activity) onActivity?.(activity);
    }
  });

  if (result.error) {
    throw comboTurnError(result.error.message, {
      code: result.error.code,
      partialContent: content,
      conversationId: meta?.conversationId || ""
    });
  }
  // An empty run is a failure, not a blank answer: the chat must say so instead
  // of completing a turn that never produced anything.
  if (!content.trim()) {
    throw comboTurnError("Vups Combo AI finished without an answer. Try again or check its model availability.", {
      code: "combo_empty_answer",
      partialContent: content,
      conversationId: meta?.conversationId || ""
    });
  }

  return {
    content,
    messageId: meta?.messageId || "",
    conversationId: meta?.conversationId || "",
    finishReason: "combo",
    saveWarning: result.donePayload?.saveWarning || null
  };
}
