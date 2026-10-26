import { TURN_STATUS } from "./turnLifecycle.js";

export const TURN_NOTICE = Object.freeze({
  NONE: "none",
  ERROR: "error",
  SAVE_WARNING: "save-warning",
  INTERRUPTED: "interrupted",
  CANCELLED: "cancelled",
  LENGTH: "length"
});

/**
 * Exactly one terminal notice may render for an assistant turn. The status
 * machine already keeps these exclusive; this resolver is the render-time
 * guarantee if persisted state is ever inconsistent.
 */
export function resolveTurnNotice(message = {}, isStreaming = false) {
  if (isStreaming) return TURN_NOTICE.NONE;
  if (message.error) return TURN_NOTICE.ERROR;
  if (message.saveWarning) return TURN_NOTICE.SAVE_WARNING;
  if (message.status === TURN_STATUS.INTERRUPTED) return TURN_NOTICE.INTERRUPTED;
  if (message.status === TURN_STATUS.CANCELLED) return TURN_NOTICE.CANCELLED;
  if (message.truncated === "length") return TURN_NOTICE.LENGTH;
  return TURN_NOTICE.NONE;
}
