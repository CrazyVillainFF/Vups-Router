import { useState } from "react";
import { ArrowRight, ArrowsClockwise, PlayCircle, Prohibit } from "@phosphor-icons/react";
import {
  MAX_CLARIFICATION_ANSWER_CHARS,
  taskActionsFor,
  taskCancelText,
  taskClarificationFor,
  taskDotTone,
  taskPlanProgress,
  taskModelCalls,
  taskTimeRows
} from "../tasks/taskRunView.js";
import { taskSummaryLine } from "../tasks/taskProgress.js";

function TaskClarification({ taskId, clarification, pending, onAnswer }) {
  const [draft, setDraft] = useState("");
  const busy = pending === `${taskId}:answer`;
  const locked = Boolean(pending);

  async function send(event) {
    event.preventDefault();
    if (locked) return;
    const accepted = await onAnswer(taskId, clarification.clarificationId, draft);
    if (accepted) setDraft("");
  }

  return (
    <form className="vr-task-clarification" onSubmit={send}>
      <p className="vr-task-question">{clarification.question}</p>
      {clarification.options.length > 0 ? (
        <div className="vr-task-options" role="group" aria-label="Choices the model offered">
          {clarification.options.map(option => (
            <button
              type="button"
              key={option}
              className="vr-task-option"
              disabled={locked}
              onClick={() => setDraft(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <label className="vr-task-answer-label" htmlFor={`vr-task-answer-${taskId}`}>
        Your answer
      </label>
      <textarea
        id={`vr-task-answer-${taskId}`}
        className="vr-task-answer"
        rows={3}
        value={draft}
        maxLength={MAX_CLARIFICATION_ANSWER_CHARS}
        disabled={locked}
        onChange={event => setDraft(event.target.value)}
      />
      <button
        type="submit"
        className="vr-task-action vr-task-action--answer"
        disabled={locked || !draft.trim()}
        aria-busy={busy}
      >
        <ArrowRight size={14} aria-hidden="true" />
        <span>{busy ? "Sending…" : "Send answer"}</span>
      </button>
      {clarification.blockedSteps.length > 0 ? (
        <p className="vr-task-meta">
          {`This is standing in the way of ${clarification.blockedSteps.length} plan ${
            clarification.blockedSteps.length === 1 ? "step" : "steps"
          }.`}
        </p>
      ) : null}
    </form>
  );
}

export default function TaskTurnPanel({
  view,
  pending = "",
  error = "",
  onCancel,
  onResume,
  onRefresh,
  onAnswer
}) {
  const task = view?.task || {};
  const taskId = String(task.taskId || view?.taskId || "");
  if (!taskId) return null;
  const actions = taskActionsFor(task);
  const asked = actions.answer ? taskClarificationFor(task) : null;
  const plan = taskPlanProgress(task);
  const calls = taskModelCalls(task);
  const times = taskTimeRows(task);
  const cancelNote = taskCancelText(task);
  const busy = token => pending === `${taskId}:${token}`;

  return (
    <div className="vr-task-turn">
      <p className="vr-task-status" role="status">
        <span className={`vr-task-dot vr-task-dot--${taskDotTone(view)}`} aria-hidden="true" />
        <span>{taskSummaryLine(task) || "No status reported."}</span>
        {view.offline ? <span className="vr-task-offline">last read failed</span> : null}
      </p>
      {plan ? (
        <p className="vr-task-meta">
          {`${plan.done} of ${plan.total} plan steps done${plan.pending > 0 ? `, ${plan.pending} still to do` : ""}.`}
        </p>
      ) : null}
      {asked ? (
        <TaskClarification key={asked.clarificationId} taskId={taskId} clarification={asked} pending={pending} onAnswer={onAnswer} />
      ) : null}
      {cancelNote ? <p className="vr-task-meta">{cancelNote}</p> : null}
      <details className="vr-task-meta">
        <summary>Execution details</summary>
        {times.map(row => <p key={row.id}>{row.label}: {row.text}</p>)}
        {calls ? <p>{calls.total} model calls · {calls.failed} failed</p> : null}
        {plan ? <ul>{plan.steps.map((step, index) => (
          <li key={step.id || index}>{step.title || step.description} — {step.status}</li>
        ))}</ul> : null}
      </details>
      {error ? <div className="vr-inline-error">{error}</div> : null}
      <div className="vr-task-actions">
        {actions.resume ? (
          <button
            type="button"
            className="vr-task-action"
            disabled={Boolean(pending)}
            aria-busy={busy("resume")}
            onClick={() => onResume(taskId)}
            title="Put this waiting run back in the queue"
          >
            <PlayCircle size={14} aria-hidden="true" />
            <span>{busy("resume") ? "Resuming…" : "Resume"}</span>
          </button>
        ) : null}
        {actions.cancel ? (
          <button
            type="button"
            className="vr-task-action vr-task-action--danger"
            disabled={Boolean(pending)}
            aria-busy={busy("cancel")}
            onClick={() => onCancel(taskId)}
            title="Ask the server to stop this run"
          >
            <Prohibit size={14} aria-hidden="true" />
            <span>{busy("cancel") ? "Stopping…" : "Stop"}</span>
          </button>
        ) : null}
        {actions.refresh ? (
          <button
            type="button"
            className="vr-task-action"
            disabled={Boolean(pending)}
            aria-busy={busy("refresh")}
            onClick={() => onRefresh(taskId)}
            title="Re-read this run from the server"
          >
            <ArrowsClockwise size={14} aria-hidden="true" />
            <span>{busy("refresh") ? "Reading…" : "Re-read"}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}