import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  answerTrackedClarification,
  cancelTrackedTask,
  configureTaskTrackerApi,
  getTaskTrackerOwner,
  getTaskTrackerSnapshot,
  getTrackedTask,
  hydrateTaskTracker,
  isTaskTrackerRunning,
  listTrackedTasks,
  pollTaskTrackerOnce,
  refreshTrackedTask,
  resetTaskTracker,
  resumeTrackedTask,
  setTaskTrackerOwner,
  startTaskTracker,
  stopTaskTracker,
  submitTrackedTask,
  subscribeToTaskTracker,
  taskTrackerStatus,
  watchTrackedTask
} from "../src/tasks/taskTracker.js";

/** Seeded rows share one timestamp so ordering assertions stay deterministic. */
const SEED_AT = "2026-11-07T10:00:00.000Z";

/**
 * A stand-in for the durable-task backend, shaped like the real routes.
 *
 * The summary/list read deliberately carries only `lastEvent` and the detail
 * read carries the log, because that difference is what forces the tracker to
 * replay rather than trust a cursor it was handed. Event pages come from the
 * stored log filtered by `after`, exactly like `taskEventsAfter`.
 */
function createBackend(seed = []) {
  const records = new Map();
  const calls = [];
  const errors = { list: null, submit: [], events: {}, detail: {} };
  const queuedPages = {};
  let scriptedList = null;
  let autoId = 0;

  function summary(record) {
    return {
      taskId: record.taskId,
      state: record.state,
      stage: record.stage || "",
      description: record.description || "",
      conversationId: record.conversationId ?? null,
      createdAt: record.createdAt || SEED_AT,
      lastActivityAt: record.lastActivityAt || record.createdAt || SEED_AT,
      steps: record.steps || 0,
      lastEvent: (record.events || []).slice(-1)[0] || null,
      eventCount: (record.events || []).length,
      retry: record.retry || { attempts: 0, maxAttempts: 0, nextAttemptAt: null, lastCode: "", lastCategory: "" },
      error: record.error || { code: "", message: "", kind: "", retryable: false, providerStatus: null },
      waitingOn: record.waitingOn ?? null,
      // The real routes attach this to every read. A list row gets the truncated
      // question, exactly like `clarificationPayload(row, { full: false })`.
      pendingClarification: clarificationPayload(record, { full: false })
    };
  }

  /** A pending question row, or null once it has been answered. */
  function clarificationPayload(record, { full = true } = {}) {
    const row = (record.clarifications || []).find(item => item.status === "pending") || null;
    if (!row) return null;
    return {
      clarificationId: row.clarificationId,
      question: full ? row.question : String(row.question || "").slice(0, 160),
      options: row.options || [],
      askedAt: row.askedAt || SEED_AT,
      blockedSteps: row.blockedSteps || []
    };
  }

  function detailOf(record) {
    return {
      ...summary(record),
      result: record.result || {},
      modelRequests: record.modelRequests || [],
      toolOperations: record.toolOperations || [],
      events: (record.events || []).slice(),
      lastSeq: (record.events || []).slice(-1)[0]?.seq || 0,
      pendingClarification: clarificationPayload(record, { full: true })
    };
  }

  for (const task of seed) {
    records.set(task.taskId, {
      taskId: task.taskId,
      state: task.state || "queued",
      stage: task.stage || task.state || "queued",
      description: task.description || "",
      conversationId: task.conversationId ?? null,
      createdAt: task.createdAt || SEED_AT,
      lastActivityAt: task.lastActivityAt || task.createdAt || SEED_AT,
      events: task.events || [],
      ...task
    });
  }

  const api = {
    async submitTask(input) {
      calls.push({ op: "submit", prompt: input.prompt, conversationId: input.conversationId ?? null });
      if (errors.submit.length > 0) {
        throw errors.submit.shift();
      }
      autoId += 1;
      const record = {
        taskId: `tsk_new_${autoId}`,
        state: "queued",
        stage: "queued",
        description: input.prompt,
        conversationId: input.conversationId ?? null,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        events: []
      };
      records.set(record.taskId, record);
      return summary(record);
    },
    async listTasks() {
      calls.push({ op: "list" });
      if (errors.list) throw errors.list;
      if (scriptedList) return scriptedList;
      return [...records.values()].map(summary);
    },
    async fetchTask(taskId) {
      calls.push({ op: "detail", taskId });
      if (errors.detail[taskId]) throw errors.detail[taskId];
      const record = records.get(taskId);
      if (!record) throw httpError(404, { code: "task_not_found" });
      return detailOf(record);
    },
    async fetchTaskEvents(taskId, { after = 0 } = {}) {
      calls.push({ op: "events", taskId, after });
      if (errors.events[taskId]) throw errors.events[taskId];
      const scripted = queuedPages[taskId];
      if (Array.isArray(scripted) && scripted.length > 0) return scripted.shift();
      const record = records.get(taskId);
      if (!record) throw httpError(404, { code: "task_not_found" });
      const held = record.events || [];
      return {
        taskId,
        state: record.state,
        stage: record.stage || "",
        conversationId: record.conversationId ?? null,
        done: false,
        lastSeq: held.slice(-1)[0]?.seq || 0,
        events: held.filter(event => Number(event.seq) > Number(after)),
        pendingClarification: clarificationPayload(record, { full: true })
      };
    },
    async cancelTask(taskId) {
      calls.push({ op: "cancel", taskId });
      const action = actions.cancel[taskId];
      if (action instanceof Error) throw action;
      if (action) return action;
      const record = records.get(taskId);
      if (!record) throw httpError(404, { code: "task_not_found" });
      if (["completed", "failed", "cancelled"].includes(record.state)) {
        throw httpError(409, { code: "task_terminal", message: "That task already finished." });
      }
      record.state = "cancelled";
      record.stage = "cancelled";
      return summary(record);
    },
    async resumeTask(taskId) {
      calls.push({ op: "resume", taskId });
      const action = actions.resume[taskId];
      if (action instanceof Error) throw action;
      if (action) return action;
      const record = records.get(taskId);
      if (!record) throw httpError(404, { code: "task_not_found" });
      // The route refuses a task with a live question before it queues anything.
      const asked = clarificationPayload(record, { full: true });
      if (asked) {
        throw httpError(409, { code: "clarification_required", clarificationId: asked.clarificationId });
      }
      record.state = "running";
      record.stage = "running";
      return summary(record);
    },
    /** Mirrors answerClarification in server/src/taskClarification.js, in its order of refusals. */
    async answerTaskClarification(taskId, clarificationId, answer) {
      calls.push({ op: "answer", taskId, clarificationId, answer });
      const action = actions.answer[taskId];
      if (action instanceof Error) throw action;
      if (action) return action;
      const record = records.get(taskId);
      if (!record) throw httpError(404, { code: "task_not_found" });
      if (["completed", "failed", "cancelled"].includes(record.state)) {
        throw httpError(409, { code: "task_terminal", message: "That task already finished." });
      }
      if (record.state !== "waiting_for_user") {
        throw httpError(409, { code: "state_conflict", message: `This task is ${record.state}.` });
      }
      const rows = record.clarifications || [];
      const index = rows.findIndex(row => row.clarificationId === String(clarificationId));
      if (index < 0) throw httpError(404, { code: "clarification_not_found", message: "No such question." });
      if (rows[index].status !== "pending") {
        throw httpError(409, { code: "clarification_answered", message: "That question is already answered." });
      }
      const text = typeof answer === "string" ? answer.trim() : "";
      if (!text) throw httpError(400, { code: "answer_required", message: "Write your answer first." });
      if (text.length > 4000) throw httpError(413, { code: "answer_too_long", message: "Too long." });
      rows[index] = { ...rows[index], status: "answered", answer: text };
      record.clarifications = rows;
      record.state = "queued";
      record.stage = "queued";
      const seq = (record.events.slice(-1)[0]?.seq || 0) + 1;
      record.events.push({
        seq,
        phase: "task",
        status: "completed",
        key: "clarification_answered",
        clarificationId: String(clarificationId),
        message: "Your answer was saved and the task is queued to carry on.",
        at: SEED_AT
      });
      return detailOf(record);
    }
  };

  const actions = { cancel: {}, resume: {}, answer: {} };

  return {
    api,
    calls,
    records,
    actions,
    errors,
    ops(op) {
      return calls.filter(call => call.op === op);
    },
    /** Append a real event row, in the shape the server writes. */
    push(taskId, message, extra = {}) {
      const record = records.get(taskId);
      if (!record) throw new Error(`No seeded task ${taskId}`);
      const seq = (record.events.slice(-1)[0]?.seq || 0) + 1;
      record.events.push({ seq, phase: "progress", status: "running", message, at: SEED_AT, ...extra });
      record.lastActivityAt = SEED_AT;
      return seq;
    },
    setState(taskId, state) {
      const record = records.get(taskId);
      record.state = state;
      record.stage = state;
    },
    /** Replace a task's event pages with an exact script, to deliver stale or trimmed data. */
    queueEvents(taskId, pages) {
      queuedPages[taskId] = pages;
    },
    /** Hand back exactly these summaries, to model a list that has capped out. */
    setList(taskIds) {
      scriptedList = taskIds
        .map(id => records.get(id))
        .filter(Boolean)
        .map(summary);
    },
    failNextSubmit(error) {
      errors.submit.push(error);
    },
    failList(error) {
      errors.list = error;
    },
    failEvents(taskId, error) {
      errors.events[taskId] = error;
    },
    failDetail(taskId, error) {
      errors.detail[taskId] = error;
    },
    refuseCancel(taskId, error) {
      actions.cancel[taskId] = error;
    },
    answerResume(taskId, value) {
      actions.resume[taskId] = value;
    },
    refuseAnswer(taskId, error) {
      actions.answer[taskId] = error;
    },
    /** Park a task on a question, the way `parkForClarification` does: supersede, then ask. */
    park(taskId, { question = "Which quarter should the report cover?", clarificationId = "clr_1", options = [], blockedSteps = [] } = {}) {
      const record = records.get(taskId);
      if (!record) throw new Error(`No seeded task ${taskId}`);
      record.clarifications = [
        ...(record.clarifications || []).map(row =>
          row.status === "pending" ? { ...row, status: "superseded" } : row
        ),
        { clarificationId, question, options, blockedSteps, status: "pending", answer: "", askedAt: SEED_AT }
      ];
      record.state = "waiting_for_user";
      record.stage = "awaiting_clarification";
      return this.push(taskId, question, { phase: "task", status: "waiting", key: "clarification_asked" });
    }
  };
}

function httpError(status, body = {}) {
  const error = new Error(body.message || `HTTP ${status}`);
  error.response = { status, data: body };
  return error;
}

const NETWORK_ERROR = new Error("socket hang up");

function begin(seed) {
  const backend = createBackend(seed);
  configureTaskTrackerApi(backend.api);
  resetTaskTracker();
  setTaskTrackerOwner("user_a");
  return backend;
}

test.beforeEach(() => {
  resetTaskTracker();
});

test("the tracker registry survives the view that created it", async () => {
  const backend = begin([
    { taskId: "tsk_a", state: "running", description: "index the archive", events: [{ seq: 1, message: "Listing files" }] }
  ]);

  const release = watchTrackedTask("tsk_a");
  await pollTaskTrackerOnce();
  assert.equal(getTrackedTask("tsk_a").task.events.length, 1);

  // What a closing view does: release its interest, and stop the loop entirely.
  release();
  stopTaskTracker();

  const held = getTrackedTask("tsk_a");
  assert.equal(held.state, "running");
  assert.equal(held.lastSeq, 1);
  assert.equal(held.watchers, 0);

  // The record is still here and still readable, so the next viewer sees the
  // progress that happened rather than a blank slate.
  backend.push("tsk_a", "Writing the index");
  await pollTaskTrackerOnce();
  const after = getTrackedTask("tsk_a");
  assert.equal(after.task.events.length, 2);
  assert.equal(after.lastSeq, 2);
});

test("nothing in the tracker can abort a submitted run", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/tasks/taskTracker.js", import.meta.url)), "utf8");
  // The file's own prose explains why there is no abort, so only code counts.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const forbidden of ["AbortController", "abortSignal", ".abort(", "signal:"]) {
    assert.equal(code.includes(forbidden), false, `taskTracker.js must not contain ${forbidden}`);
  }
});

test("startup hydrates from the server and replays an open task's log from zero", async () => {
  // A reload: the registry starts empty, the backend holds the truth.
  const backend = createBackend([
    {
      taskId: "tsk_reload",
      state: "running",
      description: "summarise the changelog",
      events: [
        { seq: 4, message: "Reading the changelog" },
        { seq: 5, message: "Drafting the summary" }
      ]
    }
  ]);
  configureTaskTrackerApi(backend.api);
  resetTaskTracker();
  setTaskTrackerOwner("user_reload");

  assert.equal(getTrackedTask("tsk_reload"), null);
  assert.equal(getTaskTrackerSnapshot().hydration.state, "idle");

  await hydrateTaskTracker();

  // The list hands over a summary with no log, so recovery has to ask for it.
  assert.equal(backend.ops("list").length, 1);
  const replay = backend.ops("events").find(call => call.taskId === "tsk_reload");
  assert.equal(replay.after, 0);
  const entry = getTrackedTask("tsk_reload");
  assert.deepEqual(entry.task.events.map(event => event.seq), [4, 5]);
  assert.equal(entry.lastSeq, 5);
  assert.equal(getTaskTrackerSnapshot().hydration.state, "ready");
});

test("a summary cursor is never trusted, so no progress row can be skipped", async () => {
  const backend = begin([
    {
      taskId: "tsk_cur",
      state: "running",
      events: [
        { seq: 7, message: "Row one" },
        { seq: 8, message: "Row two" }
      ]
    }
  ]);
  await hydrateTaskTracker();
  const summaryRead = backend.records.get("tsk_cur").events.slice(-1)[0];
  // The list gave lastEvent seq 8; the client must not have started its cursor there.
  assert.equal(summaryRead.seq, 8);
  assert.deepEqual(
    getTrackedTask("tsk_cur").task.events.map(event => event.seq),
    [7, 8]
  );
});

test("two running tasks keep their own events, cursors and outcomes", async () => {
  const backend = begin([
    { taskId: "tsk_one", state: "running", description: "first brief", events: [{ seq: 1, message: "One: start" }] },
    { taskId: "tsk_two", state: "running", description: "second brief", events: [{ seq: 1, message: "Two: start" }] }
  ]);
  await hydrateTaskTracker();

  backend.push("tsk_one", "One: writing");
  backend.push("tsk_two", "Two: reading");
  backend.setState("tsk_one", "completed");
  await pollTaskTrackerOnce();

  const one = getTrackedTask("tsk_one");
  const two = getTrackedTask("tsk_two");
  assert.deepEqual(one.task.events.map(e => e.message), ["One: start", "One: writing"]);
  assert.deepEqual(two.task.events.map(e => e.message), ["Two: start", "Two: reading"]);
  assert.equal(one.state, "completed");
  assert.equal(two.state, "running");
  assert.equal(one.lastSeq, 2);
  assert.equal(two.lastSeq, 2);
});

test("a page naming a different task is never applied", async () => {
  const backend = begin([
    { taskId: "tsk_x", state: "running", events: [{ seq: 1, message: "X: begin" }] },
    { taskId: "tsk_y", state: "running", events: [{ seq: 1, message: "Y: begin" }] }
  ]);
  await hydrateTaskTracker();

  // A crossed wire: the response for y arrives on x's read, carrying y's rows.
  backend.queueEvents("tsk_x", [
    { taskId: "tsk_y", state: "completed", stage: "completed", lastSeq: 9, events: [{ seq: 9, message: "Y leaked" }] }
  ]);
  await pollTaskTrackerOnce();

  const x = getTrackedTask("tsk_x");
  assert.equal(x.state, "running");
  assert.equal(x.lastSeq, 1);
  assert.equal(x.task.events.some(event => event.message === "Y leaked"), false);
});

test("duplicate and stale delivery change nothing and cannot pull the cursor back", async () => {
  const backend = begin([{ taskId: "tsk_dup", state: "running", events: [] }]);
  await hydrateTaskTracker();
  backend.push("tsk_dup", "Step 1");
  backend.push("tsk_dup", "Step 2");
  backend.push("tsk_dup", "Step 3");
  await pollTaskTrackerOnce();
  assert.equal(getTrackedTask("tsk_dup").lastSeq, 3);

  const logBefore = getTrackedTask("tsk_dup").task.events.slice();

  // The same batch again, plus one genuinely new row — a reconnect resending
  // what it already sent, arriving next to something this client has not seen.
  backend.queueEvents("tsk_dup", [
    {
      taskId: "tsk_dup",
      state: "running",
      lastSeq: 3,
      events: logBefore.map(event => ({ ...event, message: `${event.message} (resent)` }))
    }
  ]);
  await pollTaskTrackerOnce();

  const resent = getTrackedTask("tsk_dup");
  assert.equal(resent.lastSeq, 3);
  assert.deepEqual(resent.task.events.map(e => e.message), ["Step 1", "Step 2", "Step 3"]);
  assert.equal(resent.state, "running");

  backend.queueEvents("tsk_dup", [
    {
      taskId: "tsk_dup",
      state: "running",
      lastSeq: 4,
      events: [
        { seq: 2, message: "Step 2 (again)" },
        { seq: 3, message: "Step 3 (again)" },
        { seq: 4, message: "Step 4" }
      ]
    }
  ]);
  await pollTaskTrackerOnce();

  const after = getTrackedTask("tsk_dup");
  assert.equal(after.lastSeq, 4);
  assert.deepEqual(after.task.events.map(e => e.message), ["Step 1", "Step 2", "Step 3", "Step 4"]);
});

test("a trimmed server window falls back to the authoritative record, not a guess", async () => {
  const backend = begin([{ taskId: "tsk_trim", state: "running", events: [{ seq: 1, message: "Begin" }] }]);
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_trim").lastSeq, 1);

  // The server is at 4 but its retained window no longer holds 2 and 3.
  backend.records.get("tsk_trim").events = [
    { seq: 1, message: "Begin" },
    { seq: 2, message: "Hidden" },
    { seq: 3, message: "Hidden" },
    { seq: 4, message: "Now visible" }
  ];
  backend.queueEvents("tsk_trim", [
    { taskId: "tsk_trim", state: "running", lastSeq: 4, events: [] }
  ]);
  // ...and the detail read answers with only the newest row kept.
  backend.records.get("tsk_trim").events = [{ seq: 4, message: "Now visible" }];

  await pollTaskTrackerOnce();

  assert.equal(backend.ops("detail").some(call => call.taskId === "tsk_trim"), true);
  const entry = getTrackedTask("tsk_trim");
  assert.equal(entry.lastSeq, 4);
  assert.equal(entry.task.events.slice(-1)[0].message, "Now visible");
});

test("a finished record is not resurrected by weaker evidence than the record itself", async () => {
  const backend = begin([
    { taskId: "tsk_done", state: "completed", description: "wrap up", events: [{ seq: 3, message: "Done" }] }
  ]);
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_done").state, "completed");

  // A list row that is behind the cancel this client already saw. A capped,
  // cached, out-of-order summary must not restart finished work.
  backend.setState("tsk_done", "running");
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_done").state, "completed");

  backend.queueEvents("tsk_done", [{ taskId: "tsk_done", state: "running", lastSeq: 3, events: [] }]);
  await pollTaskTrackerOnce();
  assert.equal(getTrackedTask("tsk_done").state, "completed");

  // The two things that legitimately reopen a record: the backend's own answer
  // to a resume, and the single-record read that says so plainly.
  await resumeTrackedTask("tsk_done");
  assert.equal(getTrackedTask("tsk_done").state, "running");

  backend.setState("tsk_done", "completed");
  await refreshTrackedTask("tsk_done");
  assert.equal(getTrackedTask("tsk_done").state, "completed");
});

test("cancellation reports what the backend actually did", async () => {
  const backend = begin([{ taskId: "tsk_stop", state: "running", events: [{ seq: 1, message: "Working" }] }]);
  await hydrateTaskTracker();

  const record = await cancelTrackedTask("tsk_stop");
  assert.equal(record.state, "cancelled");
  assert.equal(getTrackedTask("tsk_stop").state, "cancelled");
  assert.equal(backend.ops("cancel").length, 1);
  assert.equal(backend.ops("cancel")[0].taskId, "tsk_stop");

  // A refused cancellation is an error the caller sees, not a silent success.
  backend.refuseCancel("tsk_stop", httpError(409, { code: "task_terminal" }));
  await assert.rejects(() => cancelTrackedTask("tsk_stop"));
  assert.equal(getTrackedTask("tsk_stop").state, "cancelled");
});

test("an action whose response names another task is refused", async () => {
  const backend = begin([
    { taskId: "tsk_mine", state: "running", events: [] },
    { taskId: "tsk_theirs", state: "running", events: [] }
  ]);
  await hydrateTaskTracker();

  backend.actions.cancel.tsk_mine = { taskId: "tsk_theirs", state: "cancelled" };
  await assert.rejects(
    () => cancelTrackedTask("tsk_mine"),
    error => error.code === "task_id_mismatch"
  );
  assert.equal(getTrackedTask("tsk_mine").state, "running");
  assert.equal(getTrackedTask("tsk_theirs").state, "running");
});

test("an expired session is never called an unavailable task API", async () => {
  const backend = begin([{ taskId: "tsk_auth", state: "running", events: [{ seq: 1, message: "Working" }] }]);
  await hydrateTaskTracker();
  assert.equal(taskTrackerStatus().status, "online");

  backend.failList(httpError(401, { code: "unauthorized" }));
  await assert.rejects(() => hydrateTaskTracker());
  const unauthorized = taskTrackerStatus();
  assert.equal(unauthorized.status, "unauthorized");
  assert.equal(unauthorized.errorKind, "unauthorized");
  assert.notEqual(unauthorized.status, "unsupported");

  // Nothing was disproved, so the cursor held its place and the missed rows
  // arrive as soon as the session does.
  const heldDuringAuthFailure = getTrackedTask("tsk_auth");
  assert.equal(heldDuringAuthFailure.lastSeq, 1);
  assert.equal(heldDuringAuthFailure.state, "running");
  assert.equal(heldDuringAuthFailure.task.events.length, 1);

  backend.push("tsk_auth", "Missed while signed out");
  backend.failList(httpError(404, {}));
  await assert.rejects(() => hydrateTaskTracker());
  assert.equal(taskTrackerStatus().status, "unsupported");

  await pollTaskTrackerOnce();
  const recovered = getTrackedTask("tsk_auth");
  assert.equal(recovered.lastSeq, 2);
  assert.deepEqual(recovered.task.events.map(e => e.message), ["Working", "Missed while signed out"]);
});

test("a task that answers not-found drops its own row and no other", async () => {
  const backend = begin([
    { taskId: "tsk_gone", state: "running", events: [{ seq: 1, message: "Before collection" }] },
    { taskId: "tsk_kept", state: "running", events: [{ seq: 1, message: "Still here" }] }
  ]);
  await hydrateTaskTracker();
  assert.equal(listTrackedTasks().length, 2);

  backend.records.delete("tsk_gone");
  await pollTaskTrackerOnce();

  assert.equal(getTrackedTask("tsk_gone"), null);
  assert.equal(getTrackedTask("tsk_kept").state, "running");
});

test("a task missing from a capped list is not treated as deleted", async () => {
  const backend = begin([
    { taskId: "tsk_offline", state: "running", events: [{ seq: 1, message: "Live" }] },
    { taskId: "tsk_other", state: "queued", description: "unrelated", events: [] }
  ]);
  await hydrateTaskTracker();
  assert.equal(listTrackedTasks().length, 2);

  // The list is capped: it now mentions only one of the two rows this client
  // holds. Absence is not evidence of deletion, so both survive.
  backend.setList(["tsk_other"]);
  await pollTaskTrackerOnce();

  assert.equal(getTrackedTask("tsk_offline")?.state, "running");
  assert.equal(getTrackedTask("tsk_other")?.state, "queued");
});

test("one submission intent creates exactly one task, however often it is called", async () => {
  const backend = begin([]);
  const [first, second] = await Promise.all([
    submitTrackedTask({ prompt: "triage the inbox", conversationId: "654f000000000000000000aa" }, { key: "intent-1" }),
    submitTrackedTask({ prompt: "triage the inbox", conversationId: "654f000000000000000000aa" }, { key: "intent-1" })
  ]);

  assert.equal(backend.ops("submit").length, 1);
  assert.equal(first.taskId, second.taskId);

  // A remount under the same intent must not send a third request either.
  const third = await submitTrackedTask({ prompt: "triage the inbox" }, { key: "intent-1" });
  assert.equal(backend.ops("submit").length, 1);
  assert.equal(third.taskId, first.taskId);

  // A different intent is a different task.
  await submitTrackedTask({ prompt: "triage the inbox" }, { key: "intent-2" });
  assert.equal(backend.ops("submit").length, 2);
});

test("a dropped submission is not re-sent blindly", async () => {
  const backend = begin([]);
  backend.failNextSubmit(NETWORK_ERROR);

  await assert.rejects(
    () => submitTrackedTask({ prompt: "rebuild the site", conversationId: "654f000000000000000000bb" }, { key: "intent-drop" }),
    error => error.taskSubmissionUncertain === true
  );

  // The server did create it before the connection died. The retry reads the
  // list, finds that task, and adopts it instead of asking for a second one.
  backend.records.set("tsk_created", {
    taskId: "tsk_created",
    state: "queued",
    stage: "queued",
    description: "rebuild the site",
    conversationId: "654f000000000000000000bb",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    events: []
  });

  const adopted = await submitTrackedTask({ prompt: "rebuild the site" }, { key: "intent-drop" });
  assert.equal(adopted.taskId, "tsk_created");
  assert.equal(backend.ops("submit").length, 1, "the unverified attempt must not be re-sent");
  assert.equal(backend.ops("list").length >= 1, true);
  assert.equal(getTrackedTask("tsk_created")?.state, "queued");
});

test("a server error on submission is treated as an outcome that may have landed", async () => {
  const backend = begin([]);
  backend.failNextSubmit(httpError(500, { message: "db write failed" }));
  await assert.rejects(
    () => submitTrackedTask({ prompt: "audit dependencies" }, { key: "intent-500" }),
    error => error.taskSubmissionUncertain === true
  );

  // Verified absent this time, so the only remaining step is to send it once.
  const created = await submitTrackedTask({ prompt: "audit dependencies" }, { key: "intent-500" });
  assert.equal(backend.ops("submit").length, 2);
  assert.equal(created.taskId, "tsk_new_1");
});

test("a refusal that created nothing is safe to send again without a list read", async () => {
  const backend = begin([]);
  backend.failNextSubmit(httpError(400, { code: "invalid_prompt" }));
  await assert.rejects(
    () => submitTrackedTask({ prompt: "  ", conversationId: "x" }, { key: "intent-bad" }),
    error => error.response?.data?.code === "invalid_prompt" || error.code === "invalid_prompt"
  );
  // A 400 that came from the backend's own validation is a definite "nothing
  // happened", so the retry must not be blocked or made to pay for a list read.
  const created = await submitTrackedTask({ prompt: "actually do the thing" }, { key: "intent-bad" });
  assert.equal(backend.ops("submit").length, 2);
  assert.equal(created.taskId, "tsk_new_1");
});

test("registry state is scoped to the signed-in account", async () => {
  const shared = createBackend([
    { taskId: "tsk_alpha", state: "running", description: "alpha work", events: [{ seq: 1, message: "Alpha step" }] }
  ]);
  configureTaskTrackerApi(shared.api);
  resetTaskTracker();
  setTaskTrackerOwner("user_alpha");
  assert.equal(getTaskTrackerOwner(), "user_alpha");
  await hydrateTaskTracker();
  assert.equal(listTrackedTasks().length, 1);

  // The same browser, a different account.
  const second = createBackend([
    { taskId: "tsk_beta", state: "queued", description: "beta work", events: [] }
  ]);
  configureTaskTrackerApi(second.api);
  setTaskTrackerOwner("user_beta");

  assert.equal(getTrackedTask("tsk_alpha"), null);
  assert.equal(listTrackedTasks().length, 0, "the previous account's rows must be gone before the new list arrives");
  assert.equal(getTaskTrackerSnapshot().hydration.state, "idle");

  await hydrateTaskTracker();
  assert.equal(listTrackedTasks().length, 1);
  assert.equal(getTrackedTask("tsk_beta").taskId, "tsk_beta");

  // Signing out takes the registry with it.
  setTaskTrackerOwner("");
  assert.equal(listTrackedTasks().length, 0);
  assert.equal(getTaskTrackerOwner(), "");
});

test("signing out does not stop a task that was already submitted", async () => {
  const backend = begin([]);
  const task = await submitTrackedTask({ prompt: "hold on through signout" }, { key: "intent-out" });
  assert.equal(backend.ops("submit").length, 1);

  setTaskTrackerOwner("");
  // The server still owns the run; the client merely forgot it. Sign back in and
  // the hydration read brings it back.
  setTaskTrackerOwner("user_a");
  await hydrateTaskTracker();
  assert.equal(getTrackedTask(task.taskId).state, "queued");
  assert.equal(backend.ops("submit").length, 1, "signing back in must not re-submit");
});

test("watching an unknown id reads the record, and not-found leaves nothing behind", async () => {
  const backend = begin([{ taskId: "tsk_watch", state: "paused", events: [{ seq: 2, message: "Paused here" }] }]);

  watchTrackedTask("tsk_watch");
  await new Promise(resolve => setImmediate(resolve));
  const watched = getTrackedTask("tsk_watch");
  assert.equal(watched.state, "paused");
  assert.equal(watched.task.events.length, 1);
  assert.equal(backend.ops("detail")[0].taskId, "tsk_watch");
  assert.equal(watched.watchers, 1);

  watchTrackedTask("tsk_never_existed");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getTrackedTask("tsk_never_existed"), null);
});

test("a temporary read failure keeps the entry and its cursor intact", async () => {
  const backend = begin([{ taskId: "tsk_blip", state: "running", events: [{ seq: 1, message: "Step 1" }] }]);
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_blip").lastSeq, 1);

  backend.failEvents("tsk_blip", NETWORK_ERROR);
  await pollTaskTrackerOnce();
  const during = getTrackedTask("tsk_blip");
  assert.equal(during.offline, true);
  assert.equal(during.lastSeq, 1);
  assert.equal(during.state, "running");

  // Recovery asks for exactly what was missed, nothing more.
  delete backend.errors.events.tsk_blip;
  backend.push("tsk_blip", "Step 2");
  await pollTaskTrackerOnce();
  const after = getTrackedTask("tsk_blip");
  assert.equal(after.offline, false);
  assert.equal(after.lastSeq, 2);
  assert.deepEqual(after.task.events.map(e => e.message), ["Step 1", "Step 2"]);
});

test("a read that fails is announced, so the view can label it without other news", async () => {
  const backend = begin([{ taskId: "tsk_label", state: "running", events: [{ seq: 1, message: "Step 1" }] }]);
  await hydrateTaskTracker();

  // The flag alone is not enough. `getTaskTrackerSnapshot` caches until touch(),
  // and React's useSyncExternalStore compares by identity, so a pass that sets
  // `offline` without invalidating renders nothing new: the Task Center keeps
  // showing the progress read before the network went away.
  const before = getTaskTrackerSnapshot();
  const seen = [];
  const unsubscribe = subscribeToTaskTracker(taskId => seen.push(taskId ?? "all"));
  backend.failEvents("tsk_label", NETWORK_ERROR);
  await pollTaskTrackerOnce();
  unsubscribe();

  assert.ok(seen.length > 0, "a failed event read must notify subscribers");
  const during = getTaskTrackerSnapshot();
  assert.notEqual(during, before, "a failed event read must replace the snapshot");
  assert.equal(during.tasks.find(task => task.taskId === "tsk_label").offline, true);

  // Asking for one record explicitly fails the same way and has to be announced
  // just as loudly.
  const beforeRefresh = getTaskTrackerSnapshot();
  backend.failDetail("tsk_label", NETWORK_ERROR);
  await assert.rejects(() => refreshTrackedTask("tsk_label"));
  assert.notEqual(getTaskTrackerSnapshot(), beforeRefresh, "a failed refresh must replace the snapshot");
});

test("overlapping polls share one pass and the list is read on a cadence", async () => {
  const backend = begin([{ taskId: "tsk_tick", state: "running", events: [] }]);

  await Promise.all([pollTaskTrackerOnce(), pollTaskTrackerOnce(), pollTaskTrackerOnce()]);
  assert.equal(backend.ops("list").length, 1, "three concurrent polls are one pass");

  for (let index = 0; index < 7; index += 1) await pollTaskTrackerOnce();
  assert.equal(backend.ops("list").length, 1, "ticks 1-7 must not re-read the list");

  await pollTaskTrackerOnce();
  assert.equal(backend.ops("list").length, 2, "tick 8 re-reads it");
});

test("starting and stopping the loop reports honestly and keeps the rows", async () => {
  const backend = begin([{ taskId: "tsk_timer", state: "running", events: [] }]);
  await hydrateTaskTracker();

  assert.equal(isTaskTrackerRunning(), false);
  assert.equal(startTaskTracker({ intervalMs: 60000 }), true);
  assert.equal(isTaskTrackerRunning(), true);
  assert.equal(startTaskTracker({ intervalMs: 60000 }), false, "a second start cannot double the loop");

  stopTaskTracker();
  assert.equal(isTaskTrackerRunning(), false);
  assert.equal(getTrackedTask("tsk_timer").taskId, "tsk_timer");
  void backend;
});

test("subscribers are told which task changed and a broken listener cannot stop the loop", async () => {
  const backend = begin([{ taskId: "tsk_listen", state: "running", events: [] }]);
  const seen = [];
  const unsubscribeBad = subscribeToTaskTracker(() => {
    throw new Error("listener exploded");
  });
  const unsubscribeGood = subscribeToTaskTracker(taskId => seen.push(taskId ?? "all"));

  await hydrateTaskTracker();
  backend.push("tsk_listen", "A new row");
  await pollTaskTrackerOnce();

  assert.equal(seen.length >= 2, true);
  unsubscribeBad();
  unsubscribeGood();
  const before = seen.length;
  backend.push("tsk_listen", "Another row");
  await pollTaskTrackerOnce();
  assert.equal(seen.length, before, "an unsubscribed listener stops hearing");
});

// ---------------------------------------------------------------- clarification

const LONG_QUESTION =
  "Which quarter should the report cover, and should the risks section name the vendors involved " +
  "or describe them only by category? The archive holds eleven months of records, so the choice " +
  "changes which folders the worker reads first and how long the summary can be.";

/**
 * The question is a field on the record, not a line in the log.
 *
 * These cases hold the two properties the Task Center depends on: a question only
 * ever arrives from a read the server answered, and a read that carries a weaker
 * copy of the same question cannot damage the copy already held.
 */
test("a weaker read cannot damage the question this client holds", async () => {
  const backend = begin([
    { taskId: "tsk_q", state: "waiting_for_user", stage: "awaiting_clarification", description: "Report", clarifications: [
      { clarificationId: "clr_1", question: LONG_QUESTION, options: ["Q1", "Q2"], blockedSteps: ["Draft the summary"], status: "pending", askedAt: SEED_AT }
    ], events: [{ seq: 1, message: "Listing the archive" }] }
  ]);
  const release = watchTrackedTask("tsk_q");
  await hydrateTaskTracker();
  await pollTaskTrackerOnce();

  const held = getTrackedTask("tsk_q");
  assert.equal(held.state, "waiting_for_user");
  assert.equal(held.stage, "awaiting_clarification");
  assert.equal(held.task.pendingClarification.clarificationId, "clr_1");
  // Whichever read won the race, the text is the server's own, never a mixture.
  assert.equal(LONG_QUESTION.startsWith(held.task.pendingClarification.question), true);
  assert.deepEqual([...held.task.pendingClarification.blockedSteps], ["Draft the summary"]);

  // The single-record read is the full text.
  await refreshTrackedTask("tsk_q");
  assert.equal(getTrackedTask("tsk_q").task.pendingClarification.question, LONG_QUESTION);

  // A page with no question field at all is a backend that does not know
  // clarifications; it must leave the held question untouched.
  backend.queueEvents("tsk_q", [
    { taskId: "tsk_q", state: "waiting_for_user", stage: "awaiting_clarification", done: false, lastSeq: 1, events: [] }
  ]);
  await pollTaskTrackerOnce();
  assert.equal(getTrackedTask("tsk_q").task.pendingClarification.question, LONG_QUESTION);

  // And a list row, which carries only the first 160 characters, must not
  // shorten the question the reader is part-way through answering.
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_q").task.pendingClarification.question, LONG_QUESTION);
  release();
});

test("a question that no longer waits is cleared by the server saying so", async () => {
  const backend = begin([
    { taskId: "tsk_clear", state: "waiting_for_user", clarifications: [
      { clarificationId: "clr_1", question: "Which quarter?", options: [], blockedSteps: [], status: "pending", askedAt: SEED_AT }
    ], events: [] }
  ]);
  const release = watchTrackedTask("tsk_clear");
  await hydrateTaskTracker();
  assert.equal(getTrackedTask("tsk_clear").task.pendingClarification.clarificationId, "clr_1");

  // Answered from another tab: the next read says queued with nothing outstanding.
  const record = backend.records.get("tsk_clear");
  record.clarifications[0].status = "answered";
  backend.setState("tsk_clear", "queued");
  await pollTaskTrackerOnce();
  await refreshTrackedTask("tsk_clear");
  const after = getTrackedTask("tsk_clear");
  assert.equal(after.task.pendingClarification, null);
  assert.equal(after.state, "queued");
  release();
});

test("a new question replaces the old one, because a row is never edited in place", async () => {
  const backend = begin([{ taskId: "tsk_two", state: "running", events: [] }]);
  const release = watchTrackedTask("tsk_two");
  await hydrateTaskTracker();

  backend.park("tsk_two", { clarificationId: "clr_1", question: "Which quarter?" });
  await refreshTrackedTask("tsk_two");
  assert.equal(getTrackedTask("tsk_two").task.pendingClarification.clarificationId, "clr_1");

  // The answer arrived as a second question, so the first one is superseded.
  backend.park("tsk_two", { clarificationId: "clr_2", question: LONG_QUESTION });
  await refreshTrackedTask("tsk_two");
  const after = getTrackedTask("tsk_two").task.pendingClarification;
  assert.equal(after.clarificationId, "clr_2");
  assert.equal(after.question, LONG_QUESTION, "a different id is a different question, not a shorter copy");
  assert.equal(getTrackedTask("tsk_two").state, "waiting_for_user");
  release();
});

test("an accepted answer moves the entry, and nothing moves before it is accepted", async () => {
  const backend = begin([
    { taskId: "tsk_ans", state: "waiting_for_user", clarifications: [
      { clarificationId: "clr_1", question: "Which quarter?", options: ["Q1"], blockedSteps: [], status: "pending", askedAt: SEED_AT }
    ], events: [] }
  ]);
  const release = watchTrackedTask("tsk_ans");
  await hydrateTaskTracker();

  // Hold the request open: an answer the backend has not taken may not be shown
  // as taken, because the reader would stop writing into a box that did nothing.
  let settle;
  const inFlight = new Promise(resolve => {
    settle = resolve;
  });
  backend.actions.answer.tsk_ans = inFlight;
  const sent = answerTrackedClarification("tsk_ans", "clr_1", "The second quarter.");
  await Promise.resolve();

  const during = getTrackedTask("tsk_ans");
  assert.equal(during.state, "waiting_for_user", "the answer has not been accepted yet");
  assert.equal(during.task.pendingClarification.clarificationId, "clr_1");

  // The server's own record is the only thing that changes the entry.
  const record = backend.records.get("tsk_ans");
  record.clarifications[0].status = "answered";
  record.clarifications[0].answer = "The second quarter.";
  record.state = "queued";
  record.stage = "queued";
  record.events.push({
    seq: 1,
    phase: "task",
    status: "completed",
    key: "clarification_answered",
    clarificationId: "clr_1",
    message: "Your answer was saved and the task is queued to carry on.",
    at: SEED_AT
  });
  settle(await backend.api.fetchTask("tsk_ans"));
  const task = await sent;

  assert.equal(task.state, "queued");
  assert.equal(backend.ops("answer").length, 1);
  assert.deepEqual(
    { id: backend.ops("answer")[0].clarificationId, text: backend.ops("answer")[0].answer },
    { id: "clr_1", text: "The second quarter." }
  );
  const after = getTrackedTask("tsk_ans");
  assert.equal(after.state, "queued", "the queueing is the backend's, applied from its record");
  assert.equal(after.task.pendingClarification, null, "the card goes when the question is answered");
  release();
});

test("a refused answer leaves the record exactly as it was", async () => {
  const backend = begin([
    { taskId: "tsk_refuse", state: "waiting_for_user", clarifications: [
      { clarificationId: "clr_1", question: "Which quarter?", options: [], blockedSteps: [], status: "pending", askedAt: SEED_AT }
    ], events: [] }
  ]);
  const release = watchTrackedTask("tsk_refuse");
  await hydrateTaskTracker();

  backend.refuseAnswer("tsk_refuse", httpError(409, { code: "clarification_answered", message: "That question is already answered." }));
  await assert.rejects(() => answerTrackedClarification("tsk_refuse", "clr_1", "Q2"));
  const held = getTrackedTask("tsk_refuse");
  assert.equal(held.state, "waiting_for_user");
  assert.equal(held.task.pendingClarification.clarificationId, "clr_1");

  // A dropped connection says nothing at all about the record.
  backend.refuseAnswer("tsk_refuse", NETWORK_ERROR);
  await assert.rejects(() => answerTrackedClarification("tsk_refuse", "clr_1", "Q2"));
  assert.equal(getTrackedTask("tsk_refuse").task.pendingClarification.clarificationId, "clr_1");
  release();
});

test("a parked task cannot be resumed into the queue behind its question", async () => {
  const backend = begin([
    { taskId: "tsk_resume", state: "waiting_for_user", clarifications: [
      { clarificationId: "clr_1", question: "Which quarter?", options: [], blockedSteps: [], status: "pending", askedAt: SEED_AT }
    ], events: [] }
  ]);
  const release = watchTrackedTask("tsk_resume");
  await hydrateTaskTracker();

  await assert.rejects(
    () => resumeTrackedTask("tsk_resume"),
    error => error.response?.data?.code === "clarification_required"
  );
  const held = getTrackedTask("tsk_resume");
  assert.equal(held.state, "waiting_for_user", "a refused resume must not queue the task locally");
  assert.equal(held.task.pendingClarification.clarificationId, "clr_1");
  assert.equal(backend.ops("resume").length, 1);
  release();
});

test("an answer cannot resurrect a task the backend has finished", async () => {
  const backend = begin([
    { taskId: "tsk_dead", state: "waiting_for_user", clarifications: [
      { clarificationId: "clr_1", question: "Which quarter?", options: [], blockedSteps: [], status: "pending", askedAt: SEED_AT }
    ], events: [] }
  ]);
  const release = watchTrackedTask("tsk_dead");
  await hydrateTaskTracker();

  // Cancelled between the two clicks, then a delayed response arrives claiming
  // the answer was accepted and the task is queued.
  backend.setState("tsk_dead", "cancelled");
  await refreshTrackedTask("tsk_dead");
  assert.equal(getTrackedTask("tsk_dead").state, "cancelled");

  const record = backend.records.get("tsk_dead");
  record.state = "queued";
  record.stage = "queued";
  record.clarifications[0].status = "answered";
  backend.actions.answer.tsk_dead = await backend.api.fetchTask("tsk_dead");

  await answerTrackedClarification("tsk_dead", "clr_1", "Q2");
  const after = getTrackedTask("tsk_dead");
  assert.equal(after.state, "cancelled", "a finished record does not restart on a read");
  assert.equal(after.task.state, "cancelled", "the record shown must tell the same story as the entry");
  assert.equal(after.task.pendingClarification, null);
  release();
});

test("refresh re-reads one record authoritatively and cancels nothing else", async () => {
  const backend = begin([
    { taskId: "tsk_r1", state: "running", events: [{ seq: 1, message: "r1 step" }] },
    { taskId: "tsk_r2", state: "running", events: [{ seq: 1, message: "r2 step" }] }
  ]);
  await hydrateTaskTracker();
  backend.push("tsk_r1", "r1 finished work");
  backend.setState("tsk_r1", "verifying");

  const refreshed = await refreshTrackedTask("tsk_r1");
  assert.equal(refreshed.state, "verifying");
  assert.equal(getTrackedTask("tsk_r1").lastSeq, 2);
  assert.equal(getTrackedTask("tsk_r2").lastSeq, 1);
  assert.equal(backend.ops("detail").filter(call => call.taskId === "tsk_r1").length, 1);
  assert.equal(backend.ops("cancel").length, 0);
});

test("a refresh of a task that no longer exists removes only that row", async () => {
  const backend = begin([
    { taskId: "tsk_d1", state: "running", events: [] },
    { taskId: "tsk_d2", state: "running", events: [] }
  ]);
  await hydrateTaskTracker();
  backend.failDetail("tsk_d1", httpError(404, { code: "task_not_found" }));

  await assert.rejects(() => refreshTrackedTask("tsk_d1"));
  assert.equal(getTrackedTask("tsk_d1"), null);
  assert.equal(getTrackedTask("tsk_d2").taskId, "tsk_d2");
});

test("a refresh asked for a task the tracker never held does not invent one", async () => {
  begin([]);
  await assert.rejects(() => refreshTrackedTask("tsk_unknown"), error => error.response?.status === 404);
  assert.equal(getTrackedTask("tsk_unknown"), null);
  assert.equal(listTrackedTasks().length, 0);
});
