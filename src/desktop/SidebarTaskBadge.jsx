import React from "react";
import { sidebarTaskStatus } from "./sidebarTaskStatus.js";

/**
 * The state of the work behind one chat, beside its name.
 *
 * It renders from a persisted task state and nothing else, so two devices
 * reading the same record show the same badge, and a task that finished while
 * this app was closed comes back as an ordinary chat rather than an animation.
 */
export default function SidebarTaskBadge({ task, title = "" }) {
  const status = sidebarTaskStatus(task);
  if (!status) return null;
  const name = String(title || "This chat");
  return (
    <span
      className={`vr-conv-status vr-conv-status--${status.kind}${status.live ? " vr-conv-status--live" : ""}`}
      data-task-state={task.state}
      role="status"
      aria-label={`${name}: ${status.description}`}
      title={status.description}
    >
      <span className="vr-conv-status-dot" aria-hidden="true" />
      <span className="vr-conv-status-text">{status.label}</span>
    </span>
  );
}