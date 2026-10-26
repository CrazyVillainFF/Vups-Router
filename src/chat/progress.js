import { ACTIVITY_STATUS, formatElapsed, mergeActivityFiles } from "./activity.js";

export const PROGRESS_FALLBACK_LABEL = "Generating response";

/**
 * Builds the one-line generation status from values the stream actually
 * delivered. Unknown metadata is omitted rather than estimated.
 */
export function generationProgress({
  events = [],
  files = [],
  active = false,
  startedAt = null,
  now = Date.now()
} = {}) {
  if (!active) return null;

  const list = Array.isArray(events) ? events : [];
  let current = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status === ACTIVITY_STATUS.RUNNING) {
      current = list[index];
      break;
    }
  }

  const fileList = (Array.isArray(files) ? files : []).filter(
    file => file && typeof file.path === "string" && String(file.content || "").trim()
  );
  const total = fileList.length;
  const complete = fileList.filter(file => file.complete !== false).length;
  const detail = total > 0 ? `${complete} / ${total} files` : "";

  const elapsedMs = Number.isFinite(startedAt) ? now - startedAt : null;

  return {
    label: current?.label || PROGRESS_FALLBACK_LABEL,
    detail,
    steps: mergeActivityFiles(list, fileList).length,
    elapsed: elapsedMs != null && elapsedMs >= 0 ? formatElapsed(elapsedMs) : ""
  };
}
