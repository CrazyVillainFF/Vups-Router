import { isOpenTaskState } from "../services/taskApi.js";

/**
 * What a sidebar row says about the work behind it.
 *
 * Every badge here comes from a state the backend persisted — the task snapshot
 * on the conversation row, or the tracker's live reading of the same record.
 * Nothing is inferred from a mounted component, an open socket or a timer, so a
 * chat that is being looked at is not thereby "thinking", and one that finished
 * while the app was closed does not come back animating.
 *
 * A finished or stopped task has no entry: the row returns to being an ordinary
 * chat. An unrecognised state has no entry either, because inventing a badge for
 * a state this client cannot name would be a guess about someone else's work.
 */

// `live` drives the animation and nothing else. Queued is real but still: the
// server has accepted the work and no model has been asked yet. `label` is the
// word that fits beside a chat name; `description` is what a screen reader and
// the tooltip say, because a colour alone cannot carry the difference between
// waiting for a person and waiting for a retry.
const BADGES = Object.freeze({
  queued: Object.freeze({ kind: "queued", label: "Queued", description: "Queued, waiting for a free slot", live: false }),
  planning: Object.freeze({ kind: "thinking", label: "Preparing", description: "Preparing the conversation", live: true }),
  running: Object.freeze({ kind: "thinking", label: "Thinking", description: "Thinking", live: true }),
  executing_tool: Object.freeze({ kind: "thinking", label: "Executing", description: "Executing a step", live: true }),
  verifying: Object.freeze({ kind: "thinking", label: "Verifying", description: "Checking the result", live: true }),
  retrying: Object.freeze({ kind: "waiting", label: "Retrying", description: "Waiting to retry", live: true }),
  recovering: Object.freeze({ kind: "waiting", label: "Recovering", description: "Recovering after an interruption", live: true }),
  waiting_for_user: Object.freeze({ kind: "waiting", label: "Waiting", description: "Waiting for your answer", live: false }),
  waiting_for_permission: Object.freeze({ kind: "approval", label: "Approval", description: "Waiting for permission", live: false }),
  paused: Object.freeze({ kind: "paused", label: "Paused", description: "Paused", live: false }),
  failed: Object.freeze({ kind: "failed", label: "Failed", description: "Failed", live: false })
});

export function sidebarTaskStatus(task) {
  const state = typeof task?.state === "string" ? task.state : "";
  return BADGES[state] || null;
}

// Different turns prefer open work; readings of the same turn prefer the server's latest activity.
export function conversationTask(row, tracked) {
  const own = row?.task || null;
  if (!tracked) return own;
  if (!own) return tracked;
  if (own.taskId !== tracked.taskId) {
    const ownOpen = isOpenTaskState(own.state);
    const trackedOpen = isOpenTaskState(tracked.state);
    if (ownOpen !== trackedOpen) return trackedOpen ? tracked : own;
  }
  const ownAt = Number(own.lastActivityAt) || 0;
  const trackedAt = Number(tracked.lastActivityAt) || 0;
  return trackedAt >= ownAt ? tracked : own;
}

export function tasksByConversation(views) {
  const byConversation = new Map();
  for (const view of Array.isArray(views) ? views : []) {
    const task = view?.task;
    const id = String(task?.conversationId || "");
    if (!id) continue;
    byConversation.set(id, conversationTask({ task: byConversation.get(id) }, task));
  }
  return byConversation;
}