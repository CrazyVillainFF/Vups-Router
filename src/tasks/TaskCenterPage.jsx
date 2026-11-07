import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowsClockwise,
  PlayCircle,
  Prohibit,
  WarningCircle
} from "@phosphor-icons/react";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import { getApiErrorMessage } from "../services/api.js";
import { DesktopPage } from "../desktop/DesktopPages.jsx";
import { useTrackedTask, useTaskTracker } from "./TaskTrackerContext.jsx";
import { taskActivityTime, taskProgressLines, taskSummaryLine } from "./taskProgress.js";
import {
  MAX_CLARIFICATION_ANSWER_CHARS,
  TASK_CENTER_FILTERS,
  countTaskSections,
  filterTaskViews,
  groupTaskViews,
  isStaleAnswerError,
  taskActionsFor,
  taskCancelText,
  taskCenterNotice,
  taskClarificationFor,
  taskConversationHref,
  taskDetailRows,
  taskDotTone,
  taskModelCalls,
  taskPlanProgress,
  taskResultText,
  taskSectionFor,
  taskSyncTimeText,
  taskTimeRows
} from "./taskCenterView.js";

/**
 * The Task Center (#332): every durable task this account has, wherever it came
 * from.
 *
 * The page reads the tracker and never the chat: it is reachable on its own, its
 * rows are the server's records, and closing it stops nothing. Each control is
 * bound to the one row it appears on — the task id for the action, that row's
 * own conversation id for the link — so no click can refresh, cancel or navigate
 * some other task's conversation. A button only exists when the backend would
 * accept what it does, and every sentence here is a field the server wrote.
 */

function TaskActions({ task, pending, onCancel, onResume, onRefresh }) {
  const actions = taskActionsFor(task);
  const id = String(task?.taskId || "");
  const href = taskConversationHref(task?.conversationId);
  const busy = token => pending === `${id}:${token}`;
  return (
    <div className="vr-task-actions">
      {href ? (
        <Link className="vr-task-action" to={href} title="Open the conversation this task belongs to">
          <ArrowSquareOut size={14} aria-hidden="true" />
          <span>Open conversation</span>
        </Link>
      ) : null}
      {actions.resume ? (
        <button
          type="button"
          className="vr-task-action"
          disabled={Boolean(pending)}
          aria-busy={busy("resume")}
          onClick={() => onResume(id)}
          title="Put this waiting task back in the queue"
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
          onClick={() => onCancel(id)}
          title="Ask the server to stop this task"
        >
          <Prohibit size={14} aria-hidden="true" />
          <span>{busy("cancel") ? "Cancelling…" : "Cancel task"}</span>
        </button>
      ) : null}
      {actions.refresh ? (
        <button
          type="button"
          className="vr-task-action"
          disabled={Boolean(pending)}
          aria-busy={busy("refresh")}
          onClick={() => onRefresh(id)}
          title="Re-read this task from the server"
        >
          <ArrowsClockwise size={14} aria-hidden="true" />
          <span>{busy("refresh") ? "Reading…" : "Re-read"}</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * The question a parked task is waiting on, and the one way to answer it.
 *
 * The text is the model's own, sent by the server as a field rather than folded
 * into a progress row because a question can be far longer than a row and an
 * instruction the reader cannot actually answer is worse than none. Nothing here
 * is decided locally: the card exists because `pendingClarification` exists, it
 * disappears when the server's record says it has been answered, and the draft
 * only clears once the backend has accepted the text.
 */
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

function TaskRow({ view, selected, pending, onSelect, onCancel, onResume, onRefresh }) {
  const task = view?.task || {};
  const section = taskSectionFor(view);
  const line = taskSummaryLine(task);
  const steps = taskProgressLines(task, { limit: 2 });
  const awaitingAnswer = taskActionsFor(task).answer;
  return (
    <article
      className={`vr-card vr-task-row${selected ? " vr-task-row--selected" : ""}`}
      data-section={section}
    >
      <div className="vr-task-row-head">
        <button
          type="button"
          className="vr-task-brief"
          onClick={() => onSelect(view.taskId)}
          aria-expanded={selected}
          title="Show this task's log"
        >
          <span className="vr-task-brief-text">{task.description || view.taskId}</span>
        </button>
        <span className="vr-task-time">{taskActivityTime(task)}</span>
      </div>
      <p className="vr-task-status" role="status">
        <span className={`vr-task-dot vr-task-dot--${taskDotTone(view)}`} aria-hidden="true" />
        <span>{line || "No status reported."}</span>
        {view.offline ? <span className="vr-task-offline">last read failed</span> : null}
      </p>
      {steps.slice(1).length > 0 ? (
        <ul className="vr-task-steps">
          {steps.slice(1).map(step => (
            <li key={step.id}>{step.text}</li>
          ))}
        </ul>
      ) : null}
      {awaitingAnswer ? (
        <button
          type="button"
          className="vr-task-answer-link"
          onClick={() => onSelect(view.taskId)}
          title="Read the question in full and answer it"
        >
          <span>Answer this question</span>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      ) : null}
      <TaskActions
        task={task}
        pending={pending}
        onCancel={onCancel}
        onResume={onResume}
        onRefresh={onRefresh}
      />
    </article>
  );
}

function TaskDetail({ taskId, pending, onCancel, onResume, onRefresh, onAnswer }) {
  const view = useTrackedTask(taskId);
  if (!view) {
    return (
      <div className="vr-card vr-empty-card">
        <strong>That task is not readable</strong>
        <span>
          Its record is no longer in the list, so there is nothing to show. Reload the task list to read what this
          account has.
        </span>
      </div>
    );
  }
  const task = view.task || {};
  const rows = taskDetailRows(task);
  const steps = taskProgressLines(task, { limit: 3 });
  const asked = taskActionsFor(task).answer ? taskClarificationFor(task) : null;
  // The card below is where a question is read and answered, so the same text
  // is not printed twice in the same column.
  const stepLines = asked ? steps.filter(line => !String(line.id).startsWith("question:")) : steps;
  const plan = taskPlanProgress(task);
  const calls = taskModelCalls(task);
  const result = taskResultText(task);
  const cancelNote = taskCancelText(task);
  const times = taskTimeRows(task);
  const href = taskConversationHref(task.conversationId);
  const failed = rows.filter(row => row.status === "failed");
  return (
    <div className="vr-card vr-task-detail">
      <span className="vr-page-kicker">TASK {task.taskId}</span>
      <h2>{task.description || "This task has no description on file."}</h2>
      <p className="vr-task-status" role="status">
        <span className={`vr-task-dot vr-task-dot--${taskDotTone(view)}`} aria-hidden="true" />
        <span>{taskSummaryLine(task) || "No status reported."}</span>
      </p>
      {view.offline ? (
        <div className="vr-inline-error">
          The last read of this task failed. What is shown is what this device already holds.
        </div>
      ) : null}
      {stepLines.length > 0 ? (
        <ul className="vr-task-steps">
          {stepLines.map(step => (
            <li key={`summary:${step.id}`}>{step.text}</li>
          ))}
        </ul>
      ) : null}
      {asked ? (
        <TaskClarification
          taskId={task.taskId}
          clarification={asked}
          pending={pending}
          onAnswer={onAnswer}
        />
      ) : null}
      {result ? <p className="vr-task-result">{result}</p> : null}
      {plan ? (
        <p className="vr-task-meta">
          {`${plan.done} of ${plan.total} plan steps done${plan.pending > 0 ? `, ${plan.pending} still to do` : ""}.`}
        </p>
      ) : null}
      {calls ? (
        <p className="vr-task-meta">
          {`${calls.total} model ${calls.total === 1 ? "request" : "requests"} on file${
            calls.failed > 0 ? `, ${calls.failed} failed` : ""
          }.`}
        </p>
      ) : null}
      {cancelNote ? <p className="vr-task-meta">{cancelNote}</p> : null}
      {href ? (
        <Link className="vr-link-button" to={href}>
          Open the conversation this answer was written to <ArrowRight size={14} />
        </Link>
      ) : (
        <p className="vr-task-meta">
          This task has not saved a conversation{task.state === "completed" ? " that this client can see." : " yet."}
        </p>
      )}
      <h3>{`Progress log${rows.length > 0 ? ` (${rows.length})` : ""}`}</h3>
      {rows.length === 0 ? (
        <p className="vr-task-meta">
          No progress lines have been read for this task yet. The server writes one as each step starts.
        </p>
      ) : (
        <ul className="vr-task-log">
          {rows.map(row => (
            <li key={row.id} data-status={row.status}>
              <span className="vr-task-log-label">{row.label}</span>
              {row.filePath ? <span className="vr-task-log-path">{row.filePath}</span> : null}
              {row.summary ? <span className="vr-task-log-fail">{row.summary}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 ? (
        <p className="vr-task-meta">{`${failed.length} ${failed.length === 1 ? "step" : "steps"} in this log ended as failed.`}</p>
      ) : null}
      {times.length > 0 ? (
        <dl className="vr-task-times">
          {times.map(row => (
            <div key={row.id}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <TaskActions
        task={task}
        pending={pending}
        onCancel={onCancel}
        onResume={onResume}
        onRefresh={onRefresh}
      />
    </div>
  );
}

export default function TaskCenterPage() {
  const { tasks, cancel, resume, answer, refresh, poll, snapshot } = useTaskTracker();
  const [filter, setFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [pending, setPending] = useState("");
  const [actionError, setActionError] = useState("");

  const counts = useMemo(() => countTaskSections(tasks), [tasks]);
  const visible = useMemo(() => filterTaskViews(tasks, filter), [tasks, filter]);
  const groups = useMemo(() => groupTaskViews(visible), [visible]);
  const notice = taskCenterNotice(snapshot);

  // Whether the backend took the action, which the answer form needs to know:
  // a refused answer must not clear what the reader typed, because it never
  // left this device.
  async function act(taskId, action, request) {
    if (pending) return false;
    setPending(`${taskId}:${action}`);
    setActionError("");
    try {
      await request(taskId);
      return true;
    } catch (error) {
      // The backend's own sentence, so a refusal explains itself.
      setActionError(getApiErrorMessage(error));
      return false;
    } finally {
      setPending("");
    }
  }

  const runCancel = taskId => act(taskId, "cancel", cancel);
  const runResume = taskId => act(taskId, "resume", resume);
  const runRefresh = taskId => act(taskId, "refresh", refresh);
  const runAnswer = (taskId, clarificationId, text) =>
    act(taskId, "answer", async id => {
      try {
        return await answer(id, clarificationId, text);
      } catch (error) {
        // Three refusals all mean the same thing: the record has moved, so this
        // form is describing a question that no longer waits for an answer. One
        // re-read settles it rather than leaving a stale control on screen.
        if (isStaleAnswerError(error)) await refresh(id).catch(() => {});
        throw error;
      }
    });

  function reloadList() {
    if (pending) return;
    setPending("list:refresh");
    poll()
      .catch(error => setActionError(getApiErrorMessage(error)))
      .finally(() => setPending(""));
  }

  return (
    <DesktopPage
      kicker="TASKS"
      title="Background tasks"
      description="Tasks the server is running or has finished for this account, across every conversation. Leaving this page does not stop one."
      actions={
        <>
          <button
            type="button"
            className="vr-secondary-small"
            onClick={reloadList}
            disabled={Boolean(pending)}
            aria-busy={pending === "list:refresh"}
          >
            <ArrowsClockwise size={14} aria-hidden="true" />{" "}
            {pending === "list:refresh" ? "Reading…" : "Read again"}
          </button>
          <Link className="vr-primary-small" to="/chat" state={{ newTask: Date.now() }}>
            New chat <ArrowRight size={14} />
          </Link>
        </>
      }
    >
      {actionError ? <div className="vr-inline-error">{actionError}</div> : null}
      {notice?.tone === "loading" ? (
        <div className="vr-task-loading">
          <QuantumLoader label="Reading your tasks" />
          <span>{notice.text}</span>
        </div>
      ) : null}
      {notice && notice.tone !== "loading" && notice.tone !== "empty" ? (
        <div className={notice.tone === "auth" ? "vr-callout vr-callout--warning" : "vr-inline-error"} role="alert">
          {notice.tone === "auth" ? (
            <WarningCircle size={18} aria-hidden="true" />
          ) : (
            <Prohibit size={18} aria-hidden="true" />
          )}
          <div>
            <strong>{notice.tone === "auth" ? "Sign in again to read your tasks" : "Task list not read"}</strong>
            <span>{notice.text}</span>
            {notice.stale ? <span>The tasks below are what this device read before that.</span> : null}
          </div>
        </div>
      ) : null}

      <div className="vr-task-layout">
        <section className="vr-task-column" aria-label="Task list">
          {tasks.length > 0 ? (
            <div className="vr-task-filters" role="group" aria-label="Filter tasks">
              {TASK_CENTER_FILTERS.filter(item => item.key === "all" || counts[item.key] > 0).map(item => (
                <button
                  key={item.key}
                  type="button"
                  className="vr-task-filter"
                  data-active={filter === item.key ? "true" : "false"}
                  aria-pressed={filter === item.key}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}
                  <span className="vr-task-filter-count">{counts[item.key]}</span>
                </button>
              ))}
            </div>
          ) : null}
          {taskSyncTimeText(snapshot) ? (
            <p className="vr-task-sync" role="status">
              {taskSyncTimeText(snapshot)}
            </p>
          ) : null}
          {groups.length === 0 && tasks.length > 0 ? (
            <p className="vr-task-meta">No tasks in this group.</p>
          ) : null}
          {groups.map(group => (
            <div key={group.key} className="vr-task-group">
              <h2>{group.label}</h2>
              {group.items.map(view => (
                <TaskRow
                  key={view.taskId}
                  view={view}
                  selected={view.taskId === selectedTaskId}
                  pending={pending}
                  onSelect={setSelectedTaskId}
                  onCancel={runCancel}
                  onResume={runResume}
                  onRefresh={runRefresh}
                />
              ))}
            </div>
          ))}
          {notice?.tone === "empty" ? (
            <div className="vr-card vr-empty-card">
              <strong>No background tasks yet</strong>
              <span>A task keeps running on the server after you leave the chat that started it.</span>
              <ol className="vr-empty-steps">
                <li>Open a chat and write what you want done.</li>
                <li>Set “Send as” to Task.</li>
                <li>Leave when you like — the run continues, and shows up here.</li>
              </ol>
            </div>
          ) : null}
        </section>

        <aside className="vr-task-column" aria-label="Selected task">
          {selectedTaskId ? (
            <TaskDetail
              taskId={selectedTaskId}
              // A form belongs to the task it is open on: switching the
              // selection remounts it, so half-typed text cannot follow a
              // reader onto a different task's question.
              key={selectedTaskId}
              pending={pending}
              onCancel={runCancel}
              onResume={runResume}
              onRefresh={runRefresh}
              onAnswer={runAnswer}
            />
          ) : (
            <div className="vr-card vr-empty-card">
              <strong>No task selected</strong>
              <span>Choose a task to read its log, plan steps, retries and result.</span>
            </div>
          )}
        </aside>
      </div>
    </DesktopPage>
  );
}
