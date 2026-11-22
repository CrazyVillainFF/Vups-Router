import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TASK_RESUMABLE_STATES,
  TASK_STATES,
  isOpenTaskState,
  isResumableTaskState
} from "../src/services/taskApi.js";
import {
  isStaleAnswerError,
  MAX_CLARIFICATION_ANSWER_CHARS,
  taskActionsFor,
  taskCancelText,
  taskClarificationFor,
  taskConversationHref,
  taskDetailRows,
  taskDotTone,
  taskModelCalls,
  taskPlanProgress,
  taskResultText,
  taskTimeRows
} from "../src/tasks/taskRunView.js";

/**
 * Durable task controls now live in the conversation, not a standalone page.
 *
 * The retained `taskRunView.js` helpers keep their behaviour coverage: supported
 * actions, clarification, replay-safe events and field-backed details. Source
 * assertions cover the in-chat controls and the retired page's redirect without
 * keeping its list filters or notices alive.
 */

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const panelSource = read("../src/chat/TaskTurnPanel.jsx");
const chatSource = read("../src/ChatPage.jsx");
const appSource = read("../src/App.jsx");
const sidebarSource = read("../src/desktop/DesktopSidebar.jsx");
const layoutSource = read("../src/desktop/ProtectedAppLayout.jsx");

/** A tracker entry view, shaped exactly as `taskTracker.js` publishes it. */
function entry(state, overrides = {}) {
  const task = {
    taskId: "tsk_1",
    state,
    stage: "",
    description: "Build the quarterly report",
    conversationId: null,
    events: [],
    ...overrides.task
  };
  return {
    taskId: task.taskId,
    state: task.state,
    stage: task.stage,
    conversationId: task.conversationId,
    lastSeq: 0,
    offline: false,
    watchers: 1,
    task,
    ...overrides.view
  };
}

function serverEvent(overrides = {}) {
  return {
    phase: "task",
    status: "completed",
    message: "Planned the work.",
    seq: 1,
    at: "2026-11-07T10:00:01.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------- outcomes

test("a state this client has never seen gets no guessed outcome colour", () => {
  assert.equal(taskDotTone(entry("shipped_but_strange")), "unknown");
});

test("resume is offered only in the states the endpoint accepts", () => {
  for (const state of TASK_STATES) {
    assert.equal(
      taskActionsFor(entry(state).task).resume,
      isResumableTaskState(state),
      `${state} must not offer a resume the server would refuse`
    );
  }
  assert.deepEqual([...TASK_RESUMABLE_STATES].sort(), ["paused", "waiting_for_permission", "waiting_for_user"]);
});

test("a row is coloured by its outcome, so a failed task is never shown as success", () => {
  assert.equal(taskDotTone(entry("completed")), "ok");
  assert.equal(taskDotTone(entry("failed")), "error");
  assert.equal(taskDotTone(entry("cancelled")), "muted");
  assert.equal(taskDotTone(entry("running")), "live");
  assert.equal(taskDotTone(entry("retrying")), "warn");
  assert.equal(taskDotTone(entry("waiting_for_user")), "warn");
  assert.equal(taskDotTone(entry("paused")), "warn");
  assert.equal(taskDotTone(entry("queued")), "muted");
});

// ---------------------------------------------------------------- actions

test("cancel is offered only while the backend still has work to stop", () => {
  for (const state of TASK_STATES) {
    assert.equal(
      taskActionsFor(entry(state).task).cancel,
      isOpenTaskState(state),
      `${state} must not offer a cancel the server would answer with an unchanged record`
    );
  }
  assert.equal(taskActionsFor(entry("completed").task).cancel, false);
  assert.equal(taskActionsFor(entry("queued").task).resume, false, "queued is not a resumable state");
  assert.equal(taskActionsFor(entry("paused").task).resume, true);
});

test("a conversation link appears only once the worker has actually saved one", () => {
  assert.equal(taskActionsFor(entry("running").task).openConversation, false);
  const withConversation = entry("running", { task: { conversationId: "conv_9" } });
  assert.equal(taskActionsFor(withConversation.task).openConversation, true);
  assert.equal(taskActionsFor(withConversation.task).inspect, true);
  assert.equal(taskActionsFor({}).inspect, false, "a record with no state cannot be read");
});

test("the conversation link points at that task's own conversation, encoded", () => {
  assert.equal(taskConversationHref("6543210abcdef"), "/chat?task=6543210abcdef");
  assert.equal(taskConversationHref("a/b?c"), "/chat?task=a%2Fb%3Fc");
  assert.equal(taskConversationHref(null), "");
  assert.equal(taskConversationHref(""), "");
  assert.equal(taskConversationHref(undefined), "");
});

// ------------------------------------------------------------- clarification

function parked(overrides = {}) {
  return entry(
    "waiting_for_user",
    {
      task: {
        taskId: "tsk_ask",
        state: "waiting_for_user",
        stage: "awaiting_clarification",
        pendingClarification: {
          clarificationId: "clr_1",
          question: "Which quarter should the report cover?",
          options: ["Q1", "Q2 "],
          askedAt: "2026-11-07T10:02:00.000Z",
          blockedSteps: ["Draft the summary"],
          ...overrides
        }
      }
    }
  );
}

test("a question is read from the field the server wrote, and nothing else", () => {
  const asked = taskClarificationFor(parked().task);
  assert.equal(asked.clarificationId, "clr_1");
  assert.equal(asked.question, "Which quarter should the report cover?");
  assert.deepEqual([...asked.options], ["Q1", "Q2"]);
  assert.deepEqual([...asked.blockedSteps], ["Draft the summary"]);

  // No field at all, or a deployment that does not have this feature.
  assert.equal(taskClarificationFor(entry("waiting_for_user").task), null);
  assert.equal(taskClarificationFor(undefined), null);
  assert.equal(taskClarificationFor({ pendingClarification: null }), null);
  assert.equal(taskClarificationFor({ pendingClarification: "nonsense" }), null);
});

test("a question with nothing to answer it with produces no card", () => {
  // An id is what the answer route addresses; without one the text is decoration.
  assert.equal(taskClarificationFor({ pendingClarification: { question: "Which one?" } }), null);
  assert.equal(taskClarificationFor({ pendingClarification: { clarificationId: "", question: "Which one?" } }), null);
  // A question with no words cannot be answered either.
  assert.equal(taskClarificationFor({ pendingClarification: { clarificationId: "clr_1", question: "   " } }), null);
  assert.equal(taskClarificationFor({ pendingClarification: { clarificationId: "clr_1" } }), null);
  // Junk in the optional arrays is dropped, not drawn.
  const trimmed = taskClarificationFor({
    pendingClarification: { clarificationId: "clr_1", question: "Which?", options: [null, 7, " Q3 ", ""], blockedSteps: [3, "x"] }
  });
  assert.deepEqual([...trimmed.options], ["Q3"]);
  assert.deepEqual([...trimmed.blockedSteps], ["x"]);
});

test("the answer the reader sends cannot be edited by the page", () => {
  const asked = taskClarificationFor(parked().task);
  assert.throws(() => {
    asked.question = "rewritten";
  }, TypeError);
  assert.throws(() => {
    asked.options.push("Q4");
  }, TypeError);
});

test("a parked task offers the answer, not a resume the server would refuse", () => {
  const actions = taskActionsFor(parked().task);
  assert.equal(actions.answer, true);
  assert.equal(actions.resume, false, "POST /resume answers 409 clarification_required here");
  assert.equal(actions.cancel, true, "cancelling a parked task stays legal");

  // Answering one state that does not wait for a person would be a dead control:
  // the answer route refuses a non-waiting record with 409 state_conflict.
  for (const state of ["paused", "waiting_for_permission", "queued", "running", "completed", "failed", "cancelled"]) {
    const view = entry(state, {
      task: { taskId: `tsk_${state}`, state, pendingClarification: { clarificationId: "clr_1", question: "Which?" } }
    });
    const acts = taskActionsFor(view.task);
    assert.equal(acts.answer, state === "waiting_for_user", `${state} must not offer an answer form`);
  }
});

test("a pending question suppresses Resume in every state, because /resume checks it first", () => {
  // POST /:taskId/resume refuses with clarification_required whenever a pending
  // row exists — not only while the task is parked on it — so no resumable state
  // may show a control the server will reject.
  for (const state of TASK_RESUMABLE_STATES) {
    const asked = taskActionsFor({
      state,
      pendingClarification: { clarificationId: "clr_1", question: "Which?" }
    });
    assert.equal(asked.resume, false, `${state} with a live question cannot resume`);
    assert.equal(asked.resume && asked.answer, false, `${state} must not offer both controls`);
  }
  // Without a question, Resume comes back for all three states.
  for (const state of TASK_RESUMABLE_STATES) {
    assert.equal(taskActionsFor({ state }).resume, true, `${state} alone is resumable`);
    assert.equal(taskActionsFor({ state }).answer, false);
  }
});

test("only a refusal that means the record moved triggers a re-read", () => {
  const refusal = (code, status = 409) => ({ response: { status, data: { code } } });
  assert.equal(isStaleAnswerError(refusal("clarification_answered")), true);
  assert.equal(isStaleAnswerError(refusal("state_conflict")), true);
  assert.equal(isStaleAnswerError(refusal("task_terminal", 409)), true);
  // A dropped connection may still have delivered the answer; that is not "stale".
  assert.equal(isStaleAnswerError(new Error("socket hang up")), false);
  assert.equal(isStaleAnswerError(refusal("answer_too_long", 413)), false);
  assert.equal(isStaleAnswerError(refusal("answer_required", 400)), false);
  assert.equal(isStaleAnswerError(refusal("unauthorized", 401)), false);
  assert.equal(isStaleAnswerError(null), false);
});

test("the answer box is bounded by the same cap the route enforces", () => {
  assert.equal(MAX_CLARIFICATION_ANSWER_CHARS, 4000);
});

// ---------------------------------------------------------------- detail rows

test("one event sequence is one line, even when a replay sends it twice", () => {
  const task = {
    taskId: "tsk_9",
    events: [serverEvent({ seq: 1 }), serverEvent({ seq: 1 }), serverEvent({ seq: 2, message: "Ran a step." })]
  };
  const rows = taskDetailRows(task);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.id), ["task:tsk_9:seq:1", "task:tsk_9:seq:2"]);
});

test("two tasks that both have a sequence 3 do not share a line", () => {
  const one = taskDetailRows({ taskId: "tsk_a", events: [serverEvent({ seq: 3, message: "First task step." })] });
  const two = taskDetailRows({ taskId: "tsk_b", events: [serverEvent({ seq: 3, message: "Second task step." })] });
  assert.notEqual(one[0].id, two[0].id);
  assert.equal(one[0].label, "First task step.");
  assert.equal(two[0].label, "Second task step.");
});

test("a settled step is never reopened by a replayed running line", () => {
  const settledFirst = taskDetailRows({
    taskId: "tsk_9",
    events: [
      serverEvent({ seq: 3, status: "completed", message: "Read the file." }),
      serverEvent({ seq: 3, status: "running", message: "Reading the file." })
    ]
  });
  assert.equal(settledFirst.length, 1);
  assert.equal(settledFirst[0].status, "completed", "a late running line must not undo the outcome");
  assert.equal(settledFirst[0].label, "Read the file.");
});

test("an event with no message draws no line", () => {
  assert.deepEqual(taskDetailRows({ taskId: "tsk_9", events: [serverEvent({ message: "" })] }), []);
  assert.deepEqual(taskDetailRows({ taskId: "tsk_9" }), []);
  assert.deepEqual(taskDetailRows(null), []);
});

test("a failure line carries the code the server wrote, and a file line its path", () => {
  const rows = taskDetailRows({
    taskId: "tsk_9",
    events: [
      serverEvent({ seq: 5, status: "failed", message: "Could not write.", code: "disk_full", path: "C:\\app\\src\\a.js" })
    ]
  });
  assert.equal(rows[0].summary, "Failed: disk_full");
  assert.equal(rows[0].filePath, "C:\\app\\src\\a.js");
  assert.equal(rows[0].endedAt, Date.parse("2026-11-07T10:00:01.000Z"));
});

// ---------------------------------------------------------------- field-backed prose

test("plan progress is only claimed when the record holds a plan", () => {
  assert.equal(taskPlanProgress(entry("running").task), null);
  const plan = [
    { id: "prepare", title: "Prepare", status: "completed" },
    { id: "draft", title: "Draft", status: "pending" },
    { id: "check", title: "Check", status: "blocked" }
  ];
  const fromStatuses = taskPlanProgress({ plan });
  assert.deepEqual(
    { total: fromStatuses.total, done: fromStatuses.done, pending: fromStatuses.pending },
    { total: 3, done: 1, pending: 2 }
  );
  const fromServerCounts = taskPlanProgress({ plan, completedSteps: 3, pendingSteps: 0 });
  assert.deepEqual(
    { total: fromServerCounts.total, done: fromServerCounts.done, pending: fromServerCounts.pending },
    { total: 3, done: 3, pending: 0 },
    "the counts the server wrote outrank a client recount"
  );
  assert.equal(taskPlanProgress({ plan: [] }), null);
});

test("model calls are read from the detail field only, never inferred from a step count", () => {
  assert.equal(taskModelCalls(entry("running").task), null, "a summary row carries no model request log");
  assert.equal(taskModelCalls({ steps: 4 }), null, "steps is not a count of model calls");
  const calls = taskModelCalls({
    modelRequests: [
      { requestId: "r1", status: "completed" },
      { requestId: "r2", status: "failed" },
      { requestId: "r3", status: "failed" }
    ]
  });
  assert.deepEqual({ total: calls.total, failed: calls.failed }, { total: 3, failed: 2 });
  assert.equal(taskModelCalls({ modelRequests: [] }), null);
});

test("the answer line quotes the stored summary and never invents one", () => {
  assert.equal(taskResultText(entry("running").task), "", "an unfinished task has no answer to show");
  assert.equal(taskResultText(entry("completed", { task: { result: { summary: "Report written to report.md." } } }).task), "Report written to report.md.");
  const noSummary = entry("completed", { task: { taskId: "tsk_1", result: {}, conversationId: "conv_1" } });
  assert.match(taskResultText(noSummary.task), /saved in the conversation/i);
  assert.equal(taskResultText(entry("completed").task), "", "no summary and no conversation is nothing to say");
  assert.equal(taskResultText(entry("failed", { task: { result: { summary: "Written before it failed." } } }).task), "");
});

test("timestamps appear as rows only when the record carries them", () => {
  assert.deepEqual(taskTimeRows(entry("queued").task), []);
  const rows = taskTimeRows({
    createdAt: "2026-11-07T10:00:00.000Z",
    startedAt: "2026-11-07T10:00:02.000Z",
    lastActivityAt: "2026-11-07T10:05:00.000Z",
    completedAt: "2026-11-07T10:05:00.000Z"
  });
  assert.deepEqual(rows.map(row => row.label), ["Created", "Started", "Last activity", "Finished", "Ran for"]);
  assert.equal(rows.at(-1).text, "4m 58s");
  const unfinished = taskTimeRows({ createdAt: "2026-11-07T10:00:00.000Z", startedAt: "2026-11-07T10:00:02.000Z" });
  assert.deepEqual(unfinished.map(row => row.label), ["Created", "Started"], "a running task has no finish time to print");
});

test("a cancellation is reported from the fields that recorded it", () => {
  assert.equal(taskCancelText(entry("cancelled").task), "");
  const requested = entry("cancelled", {
    task: { taskId: "tsk_1", state: "cancelled", cancelRequestedAt: "2026-11-07T10:04:00.000Z", cancelRequestedBy: "user_1" }
  });
  assert.match(taskCancelText(requested.task), /^Cancellation requested by user_1 at /);
  const anonymous = entry("cancelled", {
    task: { taskId: "tsk_1", state: "cancelled", cancelRequestedAt: "2026-11-07T10:04:00.000Z" }
  });
  assert.match(taskCancelText(anonymous.task), /^Cancellation requested at /);
});

// ------------------------------------------------------------- in-chat wiring

test("every turn control acts on the task that shows it, by that task's own id", () => {
  assert.match(panelSource, /const taskId = String\(task\.taskId \|\| view\?\.taskId \|\| ""\)/);
  assert.match(panelSource, /onClick=\{\(\) => onCancel\(taskId\)\}/);
  assert.match(panelSource, /onClick=\{\(\) => onResume\(taskId\)\}/);
  assert.match(panelSource, /onClick=\{\(\) => onRefresh\(taskId\)\}/);
  assert.match(chatSource, /async function actOnTaskTurn\(taskId, action, request\)/);
  assert.match(chatSource, /await request\(taskId\)/);
  assert.match(chatSource, /onCancel=\{id => actOnTaskTurn\(id, "cancel", cancelTaskRun\)\}/);
  assert.match(chatSource, /onResume=\{id => actOnTaskTurn\(id, "resume", resumeTaskRun\)\}/);
  assert.match(chatSource, /onRefresh=\{id => actOnTaskTurn\(id, "refresh", refreshTaskRun\)\}/);
  assert.doesNotMatch(panelSource, /on(?:Cancel|Resume|Refresh)\(\)/, "an action may never be sent without a task id");
});

test("the turn only offers actions the retained helper says the server accepts", () => {
  assert.match(panelSource, /const actions = taskActionsFor\(task\)/);
  for (const action of ["cancel", "resume", "refresh"]) {
    assert.match(panelSource, new RegExp(`actions\\.${action} \\? \\(\\s*<button`));
  }
});

test("the panel draws a tracker-owned view and holds no task data of its own", () => {
  assert.match(panelSource, /const task = view\?\.task \|\| \{\}/);
  assert.match(
    chatSource,
    /cancel: cancelTaskRun,[\s\S]{0,120}resume: resumeTaskRun,[\s\S]{0,120}answer: answerTaskRun,[\s\S]{0,120}refresh: refreshTaskRun\s*\} = useTaskTracker\(\)/
  );
  assert.doesNotMatch(panelSource, /from "\.\.\/services\/taskApi\.js"/, "task calls belong to the tracker, not the panel");
  assert.doesNotMatch(panelSource, /apiClient|axios|fetch\(/);
  assert.doesNotMatch(panelSource, /mock|dummy|lorem|sampleTask|placeholderProgress|fake/i);
  assert.doesNotMatch(panelSource, /setTimeout|setInterval|Math\.random/);
  assert.doesNotMatch(panelSource, /%\s*\}?\s*complete|progress\w*\s*=\s*\d/i, "no percentage the server never wrote");
  assert.match(panelSource, /\{view\.offline \?/, "a run kept from a failed read is labelled as one");
});

test("pending actions lock the turn controls and identify the busy action", () => {
  assert.match(chatSource, /if \(taskActionRef\.current\) return false;/);
  assert.match(chatSource, /const token = `\$\{taskId\}:\$\{action\}`/);
  assert.match(chatSource, /taskActionRef\.current = token;\s*setTaskActionPending\(token\)/);
  assert.match(panelSource, /const busy = token => pending === `\$\{taskId\}:\$\{token\}`/);
  assert.match(panelSource, /disabled=\{Boolean\(pending\)\}/);
  assert.match(panelSource, /aria-busy=\{busy\("cancel"\)\}/);
  assert.match(panelSource, /aria-busy=\{busy\("resume"\)\}/);
  assert.match(panelSource, /aria-busy=\{busy\("refresh"\)\}/);
  // Sending an answer must not race another pending action.
  assert.match(panelSource, /const locked = Boolean\(pending\)/);
  assert.match(panelSource, /if \(locked\) return;/);
  assert.match(panelSource, /disabled=\{locked \|\| !draft\.trim\(\)\}/);
});

test("a refused action shows the backend's own sentence in its turn", () => {
  assert.match(chatSource, /setTaskActionError\([\s\S]{0,160}getApiErrorMessage\(error\)/);
  assert.match(panelSource, /\{error \? <div className="vr-inline-error">\{error\}<\/div>/);
});

test("the retired Task Center redirects to chat without a page or sidebar navigation", () => {
  assert.match(appSource, /<Route path="\/tasks" element=\{<Navigate to="\/chat" replace \/>\} \/>/);
  assert.doesNotMatch(appSource, /TaskCenterPage/);
  assert.doesNotMatch(sidebarSource, /(?:to=|navClass\()["']\/tasks["']/);
  assert.doesNotMatch(sidebarSource, /ListBullets/);
  assert.equal(existsSync(new URL("../src/tasks/TaskCenterPage.jsx", import.meta.url)), false);
  assert.equal(existsSync(new URL("../src/tasks/taskCenterView.js", import.meta.url)), false);
  assert.match(layoutSource, /<TaskTrackerProvider>/, "the tracker must still live above the router outlets");
});

test("the turn has no controls without a task id from its tracker view", () => {
  assert.match(panelSource, /if \(!taskId\) return null;/);
  assert.doesNotMatch(panelSource, /selectedTaskId|<TaskDetail|onSelect\(/);
});

// ---------------------------------------------------------- clarification form

test("the answer card exists only because the server's record says a question waits", () => {
  // The question is a field the backend wrote, never a line the panel composes.
  assert.match(panelSource, /<TaskClarification[\s\S]{0,120}clarification=\{asked\}/);
  assert.match(panelSource, /const asked = actions\.answer \? taskClarificationFor\(task\) : null/);
  assert.match(panelSource, /function TaskClarification\(\{ taskId, clarification, pending, onAnswer \}\)/);
  assert.match(panelSource, /\{clarification\.question\}/);
  // Without a question there is no card, no form and no submit control.
  assert.match(panelSource, /asked \? \(\s*<TaskClarification/);
  assert.doesNotMatch(panelSource, /question \|\| "Please provide more information/);
});

test("an answer is sent to the question it answers, and a refusal keeps what was typed", () => {
  // The clarification id travels with the text, so an answer cannot land on a
  // question the reader never saw.
  assert.match(panelSource, /await onAnswer\(taskId, clarification\.clarificationId, draft\)/);
  assert.match(chatSource, /answerTaskTurn[\s\S]{0,80}\(taskId, clarificationId, text\)/);
  assert.match(chatSource, /actOnTaskTurn\(taskId, "answer", async id =>/);
  assert.match(chatSource, /return await answerTaskRun\(id, clarificationId, text\)/);
  assert.match(chatSource, /onAnswer=\{answerTaskTurn\}/);
  // The draft clears only on the server's acceptance.
  assert.match(panelSource, /const accepted = await onAnswer/);
  assert.match(panelSource, /if \(accepted\) setDraft\(""\)/);
  assert.doesNotMatch(panelSource, /setDraft\(""\)[\s\S]{0,40}await onAnswer/);
  assert.match(panelSource, /maxLength=\{MAX_CLARIFICATION_ANSWER_CHARS\}/);
});

test("a stale answer is settled by re-reading the record, not by guessing a new state", () => {
  assert.match(chatSource, /if \(isStaleAnswerError\(error\)\) await refreshTaskRun\(id\)\.catch\(\(\) => \{\}\)/);
  // The refusal still reaches the reader after the re-read.
  assert.match(chatSource, /if \(isStaleAnswerError\(error\)\)[\s\S]{0,100}throw error/);
});

