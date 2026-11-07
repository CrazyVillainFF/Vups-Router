import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TASK_RESUMABLE_STATES,
  TASK_STATES,
  TASK_TERMINAL_STATES,
  isOpenTaskState,
  isResumableTaskState
} from "../src/services/taskApi.js";
import {
  TASK_CENTER_FILTERS,
  countTaskSections,
  filterTaskViews,
  groupTaskViews,
  isStaleAnswerError,
  MAX_CLARIFICATION_ANSWER_CHARS,
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
} from "../src/tasks/taskCenterView.js";

/**
 * The global Task Center (#332).
 *
 * `taskCenterView.js` is the whole decision layer and is tested as behaviour:
 * which group a record falls in, which action the backend would accept for it,
 * what the header is allowed to claim about a failed read, and which sentences
 * exist only because a field the server wrote exists. The last section reads the
 * page's source for the properties that only exist in how it is wired — a
 * control bound to its own row, no data of its own invention, and a route plus a
 * nav entry that make it reachable without any chat being open.
 */

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const pageSource = read("../src/tasks/TaskCenterPage.jsx");
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

function snapshot(overrides = {}) {
  return {
    version: 1,
    owner: "user_1",
    status: "online",
    error: "",
    errorKind: "",
    hydration: { state: "ready", error: "", errorKind: "", at: 0 },
    lastSyncAt: 0,
    running: false,
    tasks: [],
    ...overrides
  };
}

// ---------------------------------------------------------------- grouping

test("every state the backend can name lands in exactly one group, and the groups add up", () => {
  const views = TASK_STATES.map(state => entry(state));
  const counts = countTaskSections(views);
  assert.equal(
    TASK_CENTER_FILTERS.filter(item => item.key !== "all").reduce((sum, item) => sum + counts[item.key], 0),
    counts.all,
    "the groups must partition the list, not overlap"
  );
  assert.equal(counts.all, TASK_STATES.length);
});

test("a state this client has never seen is shown as itself and filed under Other, never guessed", () => {
  assert.equal(taskSectionFor(entry("shipped_but_strange")), "other");
  assert.equal(taskSectionFor({ state: "" }), "other");
  assert.equal(taskSectionFor(null), "other");
  assert.equal(taskDotTone(entry("shipped_but_strange")), "unknown");
});

test("the group a reader must act on is exactly the group the resume endpoint accepts", () => {
  for (const state of TASK_STATES) {
    assert.equal(
      taskSectionFor(entry(state)) === "waiting",
      isResumableTaskState(state),
      `${state}: "Needs you" has to mean "Resume works here"`
    );
  }
  assert.deepEqual([...TASK_RESUMABLE_STATES].sort(), ["paused", "waiting_for_permission", "waiting_for_user"]);
});

test("queued and terminal records are separated from in-progress work", () => {
  assert.equal(taskSectionFor(entry("queued")), "queued");
  for (const state of ["planning", "running", "executing_tool", "retrying", "recovering", "verifying"]) {
    assert.equal(taskSectionFor(entry(state)), "active");
  }
  for (const state of TASK_TERMINAL_STATES) {
    assert.equal(taskSectionFor(entry(state)), "finished");
  }
});

test("filtering and grouping can never disagree, because both read the same section", () => {
  const views = [...TASK_STATES.map(state => entry(state, { task: { taskId: `tsk_${state}` } })), entry("unknown_state")];
  for (const filter of TASK_CENTER_FILTERS) {
    const filtered = filterTaskViews(views, filter.key);
    const grouped = groupTaskViews(filtered);
    const fromGroups = grouped.flatMap(group => group.items);
    assert.equal(fromGroups.length, filtered.length, `${filter.key}: every filtered row must be drawn`);
    if (filter.key === "all") continue;
    assert.equal(grouped.length, 1, `${filter.key} shows one group only`);
    assert.equal(grouped[0].key, filter.key);
    assert.equal(filtered.length, countTaskSections(views)[filter.key]);
    for (const view of filtered) assert.equal(taskSectionFor(view), filter.key);
  }
});

test("an unknown or omitted filter shows the whole list rather than nothing", () => {
  const views = [entry("running"), entry("completed")];
  assert.deepEqual(filterTaskViews(views, "not_a_filter"), views);
  assert.deepEqual(filterTaskViews(views, "all"), views);
  assert.deepEqual(filterTaskViews(views), views);
});

test("groups come in a fixed order, empty ones are left out, and junk input is not a crash", () => {
  const views = [entry("completed"), entry("running"), entry("paused")];
  assert.deepEqual(groupTaskViews(views).map(group => group.key), ["active", "waiting", "finished"]);
  assert.deepEqual(groupTaskViews([]), []);
  assert.deepEqual(countTaskSections(undefined), { all: 0, active: 0, queued: 0, waiting: 0, finished: 0, other: 0 });
  assert.deepEqual(filterTaskViews("nonsense", "active"), []);
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

// ---------------------------------------------------------------- notices

test("an expired session says sign in, and never blames the API", () => {
  const notice = taskCenterNotice(snapshot({
    status: "unauthorized",
    errorKind: "unauthorized",
    hydration: { state: "failed", error: "Session expired.", errorKind: "unauthorized", at: 1 }
  }));
  assert.equal(notice.tone, "auth");
  assert.match(notice.text, /sign in again/i);
  assert.doesNotMatch(notice.text, /api/i, "a 401 must not be reported as an unavailable API");
});

test("a deployment without the task routes is told apart from every other failure", () => {
  const kinds = ["unsupported", "forbidden", "server", "network", "rate_limited", "unauthorized"];
  const notices = kinds.map(errorKind =>
    taskCenterNotice(snapshot({ errorKind, hydration: { state: "failed", error: "", errorKind, at: 1 } }))
  );
  const texts = notices.map(notice => notice.text);
  assert.equal(new Set(texts).size, kinds.length, "none of these failures may read the same");
  assert.equal(notices[kinds.indexOf("unauthorized")].tone, "auth");
  for (const kind of ["unsupported", "forbidden", "server", "network", "rate_limited"]) {
    assert.equal(notices[kinds.indexOf(kind)].tone, "error", `${kind} is not an auth problem`);
  }
  assert.match(notices[kinds.indexOf("unsupported")].text, /does not have the background-task API/);
  assert.match(notices[kinds.indexOf("forbidden")].text, /not allowed/i);
  assert.match(notices[kinds.indexOf("server")].text, /responding but failing/i);
  assert.match(notices[kinds.indexOf("network")].text, /could not be reached/i);
});

test("rows kept from an earlier read are labelled as stale instead of presented as current", () => {
  const views = [entry("running")];
  const notice = taskCenterNotice(snapshot({
    tasks: views,
    status: "offline",
    errorKind: "network",
    hydration: { state: "ready", error: "", errorKind: "", at: 1 }
  }));
  assert.equal(notice, null, "a healthy list that still has rows says nothing about the read");

  const failed = taskCenterNotice(snapshot({
    tasks: views,
    status: "offline",
    errorKind: "network",
    hydration: { state: "failed", error: "Could not reach the server.", errorKind: "network", at: 1 }
  }));
  assert.equal(failed.tone, "error");
  assert.equal(failed.stale, true);
});

test("an unmapped failure still prints the sentence the tracker carried", () => {
  const notice = taskCenterNotice(snapshot({
    errorKind: "",
    hydration: { state: "failed", error: "Something odd happened.", errorKind: "", at: 1 }
  }));
  assert.equal(notice.tone, "error");
  assert.equal(notice.text, "Something odd happened.");
});

test("empty because nothing was read is not empty because there is nothing", () => {
  const loading = taskCenterNotice(snapshot({
    hydration: { state: "pending", error: "", errorKind: "", at: 0 }
  }));
  assert.equal(loading.tone, "loading");
  assert.equal(taskCenterNotice(snapshot({ hydration: { state: "idle", error: "", errorKind: "", at: 0 } })).tone, "loading");

  const empty = taskCenterNotice(snapshot());
  assert.equal(empty.tone, "empty");
  assert.match(empty.text, /No background tasks yet/);

  assert.equal(taskCenterNotice(snapshot({ tasks: [entry("running")] })), null);
});

test("the sync line says when the list was read, or nothing at all", () => {
  const now = 1_700_000_000_000;
  assert.equal(taskSyncTimeText(snapshot({ lastSyncAt: 0 }), { now }), "");
  assert.equal(taskSyncTimeText(snapshot({ lastSyncAt: now - 1000 }), { now }), "task list just read");
  assert.equal(taskSyncTimeText(snapshot({ lastSyncAt: now - 30_000 }), { now }), "task list read 30s ago");
  assert.equal(taskSyncTimeText(snapshot({ lastSyncAt: now - 180_000 }), { now }), "task list read 3m ago");
  assert.equal(taskSyncTimeText(undefined), "", "no snapshot is not a claim about time");
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

// ------------------------------------------------------------- page wiring

test("every control acts on the row that shows it, by that row's own ids", () => {
  assert.match(pageSource, /const id = String\(task\?\.taskId \|\| ""\)/);
  assert.match(pageSource, /onClick=\{\(\) => onCancel\(id\)\}/);
  assert.match(pageSource, /onClick=\{\(\) => onResume\(id\)\}/);
  assert.match(pageSource, /onClick=\{\(\) => onRefresh\(id\)\}/);
  // The row hands up its own task id; the detail column is keyed by the selection.
  assert.match(pageSource, /onClick=\{\(\) => onSelect\(view\.taskId\)\}/);
  assert.match(pageSource, /<TaskDetail\s+taskId=\{selectedTaskId\}/);
  // One await, and it is awaited with the id the handler was given.
  assert.match(pageSource, /async function act\(taskId, action, request\)/);
  assert.match(pageSource, /await request\(taskId\)/);
  assert.doesNotMatch(pageSource, /onCancel\(\)[\s\S]{0,40}\}\s*<span>\{busy/, "an action may never be sent without a task id");
});

test("a task row navigates to its own conversation, never the one on screen", () => {
  assert.match(pageSource, /const href = taskConversationHref\(task\?\.conversationId\)/);
  assert.match(pageSource, /taskConversationHref\(task\.conversationId\)/);
  // Nothing on this page reaches a conversation through chat state or an API call.
  assert.doesNotMatch(pageSource, /useConversation|conversationsRef|setMessages\(/);
  assert.doesNotMatch(pageSource, /from "\.\.\/chat\//);
});

test("the page draws the tracker and holds no data of its own", () => {
  assert.match(
    pageSource,
    /const \{ tasks, cancel, resume, answer, refresh, poll, snapshot \} = useTaskTracker\(\)/
  );
  assert.doesNotMatch(pageSource, /from "\.\.\/services\/taskApi\.js"/, "task calls belong to the tracker, not a screen");
  assert.doesNotMatch(pageSource, /apiClient|axios|fetch\(/);
  // No invented rows, no simulated progress, no staged sample data.
  assert.doesNotMatch(pageSource, /mock|dummy|lorem|sampleTask|placeholderProgress|fake/i);
  assert.doesNotMatch(pageSource, /setTimeout|setInterval|Math\.random/);
  assert.doesNotMatch(pageSource, /%\s*\}?\s*complete|progress\w*\s*=\s*\d/i, "no percentage the server never wrote");
  assert.match(pageSource, /\{view\.offline \?/, "a row kept from a failed read is labelled as one");
});

test("an action cannot be pressed twice at once and says which row is busy", () => {
  assert.match(pageSource, /if \(pending\) return;/);
  assert.match(pageSource, /setPending\(`\$\{taskId\}:\$\{action\}`\)/);
  assert.match(pageSource, /disabled=\{Boolean\(pending\)\}/);
  assert.match(pageSource, /aria-busy=\{busy\("cancel"\)\}/);
  assert.match(pageSource, /aria-busy=\{busy\("resume"\)\}/);
});

test("a refused action shows the backend's own sentence", () => {
  assert.match(pageSource, /setActionError\(getApiErrorMessage\(error\)\)/);
  assert.match(pageSource, /\{actionError \? <div className="vr-inline-error">\{actionError\}<\/div>/);
});

test("the Task Center is reachable on its own: route, nav entry, and a provider that outlives every page", () => {
  assert.match(appSource, /import TaskCenterPage from "\.\/tasks\/TaskCenterPage\.jsx"/);
  assert.match(appSource, /<Route path="\/tasks" element=\{<><PageMeta title="Background tasks — VupsRouter" noIndex \/><TaskCenterPage \/><\/>\} \/>/);
  assert.match(sidebarSource, /<Link to="\/tasks" className=\{navClass\("\/tasks"\)} title="Background tasks"/);
  assert.match(sidebarSource, /ListBullets size=\{16\} aria-hidden="true" \/>/);
  assert.match(layoutSource, /<TaskTrackerProvider>/, "the tracker must live above the router outlets");
});

test("the detail column refuses to claim anything for a task the tracker does not have", () => {
  assert.match(pageSource, /function TaskDetail\(\{ taskId, pending, onCancel, onResume, onRefresh, onAnswer \}\)/);
  assert.match(pageSource, /const view = useTrackedTask\(taskId\)/);
  assert.match(pageSource, /if \(!view\)/);
  assert.match(pageSource, /That task is not readable/);
  assert.doesNotMatch(pageSource, /useTrackedTask\([a-zA-Z]+Id\)\s*\|\|\s*\{/, "no default task object");
});

// ---------------------------------------------------------- clarification form

test("the answer card exists only because the server's record says a question waits", () => {
  // The question is a field the backend wrote, never a line the page composes.
  assert.match(pageSource, /<TaskClarification[\s\S]{0,120}clarification=\{asked\}/);
  assert.match(pageSource, /const asked = taskActionsFor\(task\)\.answer \? taskClarificationFor\(task\) : null/);
  assert.match(pageSource, /function TaskClarification\(\{ taskId, clarification, pending, onAnswer \}\)/);
  assert.match(pageSource, /\{clarification\.question\}/);
  // Without a question there is no card, no form and no submit control.
  assert.match(pageSource, /asked \? \(\s*<TaskClarification/);
  assert.doesNotMatch(pageSource, /question \|\| "Please provide more information/);
});

test("an answer is sent to the question it answers, and a refusal keeps what was typed", () => {
  // The clarification id travels with the text, so an answer cannot land on a
  // question the reader never saw.
  assert.match(pageSource, /await onAnswer\(taskId, clarification\.clarificationId, draft\)/);
  assert.match(pageSource, /const runAnswer = \(taskId, clarificationId, text\) =>\s*act\(taskId, "answer", async id =>/);
  assert.match(pageSource, /return await answer\(id, clarificationId, text\)/);
  // The draft clears only on the server's acceptance.
  assert.match(pageSource, /const accepted = await onAnswer/);
  assert.match(pageSource, /if \(accepted\) setDraft\(""\)/);
  assert.doesNotMatch(pageSource, /setDraft\(""\)[\s\S]{0,40}await onAnswer/);
  // The textarea is bounded by the same cap the route enforces.
  assert.match(pageSource, /maxLength=\{MAX_CLARIFICATION_ANSWER_CHARS\}/);
});

test("a stale answer is settled by re-reading the record, not by guessing a new state", () => {
  assert.match(pageSource, /if \(isStaleAnswerError\(error\)\) await refresh\(id\)\.catch\(\(\) => \{\}\)/);
  // The refusal still reaches the reader after the re-read.
  assert.match(pageSource, /if \(isStaleAnswerError\(error\)\)[\s\S]{0,80}throw error/);
});

test("an unanswered question is reachable from its own row, and resumes cannot shadow it", () => {
  assert.match(pageSource, /const awaitingAnswer = taskActionsFor\(task\)\.answer/);
  assert.match(pageSource, /awaitingAnswer \? \(\s*<button[\s\S]{0,160}onClick=\{\(\) => onSelect\(view\.taskId\)\}/);
  // Two awaits on a busy page would let one answer race another action.
  assert.match(pageSource, /if \(pending\) return false;/);
  assert.match(pageSource, /disabled=\{locked \|\| !draft\.trim\(\)\}/);
  assert.match(pageSource, /aria-busy=\{busy\("cancel"\)\}/);
});

