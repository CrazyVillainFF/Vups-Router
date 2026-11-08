import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_TASK_PROMPT_CHARS,
  TASK_RUN_STORAGE_KEY,
  planTaskSend,
  readRunAsTask,
  taskAnswerNote,
  taskProgressEvents,
  taskRunBlocker,
  taskRunFor,
  taskRunRequest,
  taskRunsForConversation,
  taskRunSubmissionKey,
  writeRunAsTask
} from "../src/chat/taskRun.js";
import {
  describeTaskState,
  taskErrorLine,
  taskProgressLines,
  taskSummaryLine
} from "../src/tasks/taskProgress.js";
import {
  cancelTurn,
  completeTurn,
  createAssistantTurn,
  failTurn,
  recordTurnProgress,
  TURN_STATUS
} from "../src/chat/turnLifecycle.js";

/**
 * Sending a chat message as a durable task (#331).
 *
 * These are behaviour tests over the real modules ChatPage uses — the decision
 * logic, the wire body, the text the reader is shown and the row pipeline that
 * turns a persisted server event into a progress line. The final section reads
 * ChatPage's own source to prove the properties that only exist in how it is
 * wired: a task send makes one task request and no chat request, and the chat's
 * cancellation path never reaches a task.
 */

const chatPageSource = readFileSync(
  fileURLToPath(new URL("../src/ChatPage.jsx", import.meta.url)),
  "utf8"
).replace(/\r\n/g, "\n");

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    dump: () => new Map(data)
  };
}

function lockedStorage() {
  return {
    getItem() { throw new Error("storage is disabled"); },
    setItem() { throw new Error("storage is disabled"); },
    removeItem() { throw new Error("storage is disabled"); }
  };
}

/** A task record as the tracker holds it: the server row plus the entry's view. */
function trackedRecord(overrides = {}) {
  return {
    taskId: "tsk_1",
    state: "running",
    stage: "running",
    description: "Build the report",
    conversationId: "conv_1",
    createdAt: "2026-11-07T10:00:00.000Z",
    lastActivityAt: "2026-11-07T10:00:05.000Z",
    events: [],
    ...overrides
  };
}

function view(record, overrides = {}) {
  return {
    taskId: record.taskId,
    state: record.state,
    stage: record.stage,
    conversationId: record.conversationId,
    task: record,
    ...overrides
  };
}

/** Server-shaped progress rows, the way `taskEvents.js` stores them. */
function serverEvent(overrides = {}) {
  return {
    phase: "task",
    status: "running",
    message: "Working on the answer.",
    key: "responding",
    seq: 1,
    at: "2026-11-07T10:00:01.000Z",
    ...overrides
  };
}

function sourceSlice(startMarker, endMarker) {
  const start = chatPageSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} is still part of ChatPage.jsx`);
  const end = chatPageSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} still follows ${startMarker} in ChatPage.jsx`);
  return chatPageSource.slice(start, end);
}

/** Everything between a function's opening brace and its matching close. */
function functionBody(name) {
  const signature = `function ${name}(`;
  const start = chatPageSource.indexOf(signature);
  assert.notEqual(start, -1, `${name} is still part of ChatPage.jsx`);
  const open = chatPageSource.indexOf("{\n", start);
  let depth = 0;
  for (let index = open; index < chatPageSource.length; index += 1) {
    if (chatPageSource[index] === "{") depth += 1;
    if (chatPageSource[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return chatPageSource.slice(open, index + 1);
  }
  assert.fail(`${name} never closes`);
}

test("task mode is a choice, not a default", () => {
  assert.equal(readRunAsTask(createStorage()), false);
  assert.equal(readRunAsTask(createStorage({ [TASK_RUN_STORAGE_KEY]: "1" })), true);
  assert.equal(readRunAsTask(createStorage({ [TASK_RUN_STORAGE_KEY]: "0" })), false);
  assert.equal(readRunAsTask(createStorage({ [TASK_RUN_STORAGE_KEY]: "yes" })), false);
  assert.equal(readRunAsTask(null), false);
});

test("the task switch reports what storage kept, not what was asked", () => {
  const storage = createStorage();
  assert.equal(writeRunAsTask(true, storage), true);
  assert.equal(storage.getItem(TASK_RUN_STORAGE_KEY), "1");
  assert.equal(writeRunAsTask(false, storage), false);
  assert.equal(storage.dump().has(TASK_RUN_STORAGE_KEY), false);
  // A webview with storage disabled must not show an enabled switch.
  assert.equal(writeRunAsTask(true, lockedStorage()), false);
});

test("a brief a task cannot carry is refused instead of quietly degraded", () => {
  assert.match(String(taskRunBlocker({ prompt: "   " })), /needs a message/i);
  assert.equal(taskRunBlocker({ prompt: "Do the work" }), null);
  assert.equal(taskRunBlocker({ prompt: "x".repeat(MAX_TASK_PROMPT_CHARS) }), null);
  const tooLong = taskRunBlocker({ prompt: "x".repeat(MAX_TASK_PROMPT_CHARS + 1) });
  assert.match(tooLong, new RegExp(MAX_TASK_PROMPT_CHARS.toLocaleString("en-US")));
  assert.match(String(taskRunBlocker({ prompt: "go", combo: true })), /Combo/i);
  assert.match(String(taskRunBlocker({ prompt: "go", images: 1 })), /images/i);
  assert.match(String(taskRunBlocker({ prompt: "go", textFiles: 1 })), /attached files/i);
  // The brief never loses a real limitation: a task body has no attachment field.
  assert.equal(
    taskRunBlocker({ prompt: "go", combo: false, images: 0, textFiles: 0, workspacePath: "C:/x" }),
    null
  );
});

test("one intent names one task, however many times it is sent", () => {
  const first = taskRunSubmissionKey({ conversationId: "conv_1", prompt: "Build it" });
  assert.equal(taskRunSubmissionKey({ conversationId: "conv_1", prompt: "  Build it \n" }), first);
  assert.notEqual(taskRunSubmissionKey({ conversationId: "conv_2", prompt: "Build it" }), first);
  assert.notEqual(taskRunSubmissionKey({ conversationId: "conv_1", prompt: "Build it twice" }), first);
  assert.equal(
    taskRunSubmissionKey({ conversationId: null, prompt: "Build it" }),
    taskRunSubmissionKey({ conversationId: "", prompt: "Build it" })
  );
  // A component instance is not an intent: nothing here reads a ref, a counter
  // or a clock, so a remount under the same brief produces the same key.
  assert.match(first, /^task:conv_1:/);
});

test("the wire body carries only the fields the task route reads", () => {
  const body = taskRunRequest({
    prompt: "  Build the report  ",
    conversationId: "conv_1",
    reference: { model: "m-1", configId: "cfg_1", providerId: "prv_1", source: "shared", vups: true },
    model: "",
    mode: "motion",
    temperature: 0.3,
    workspacePath: "C:/project/Vups Router"
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "configId", "conversationId", "mode", "model", "prompt", "providerId",
    "source", "temperature", "vups", "workspacePath"
  ].sort());
  assert.equal(body.prompt, "Build the report");
  assert.equal(body.model, "m-1");
  assert.equal(body.mode, "motion");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.vups, true);

  // A draft chat has no id the backend could accept; the worker makes the
  // conversation and the record reports it later.
  assert.equal("conversationId" in taskRunRequest({ prompt: "go", conversationId: "" }), false);
  assert.equal(
    "conversationId" in taskRunRequest({ prompt: "go", conversationId: "local-1700000000" }),
    false
  );
  const bare = taskRunRequest({ prompt: "go" });
  assert.equal(bare.temperature, null);
  assert.equal(bare.mode, "general");
  assert.equal(bare.vups, false);
  assert.equal(bare.workspacePath, "");
  assert.equal(bare.configId, null);
});

test("no signal, controller or stream is part of a task submission", () => {
  const body = taskRunRequest({ prompt: "go", conversationId: "conv_1" });
  for (const forbidden of ["signal", "abortSignal", "controller", "messages", "attachments", "images"]) {
    assert.equal(forbidden in body, false, `a task body must not carry ${forbidden}`);
  }
  assert.equal(
    /AbortController|\.abort\(|signal:/.test(
      sourceSlice("async function submitTaskRun", "/**\n   * Adopt the conversation")
    ),
    false
  );
});

test("planning a send picks exactly one path", () => {
  const chat = planTaskSend({ runAsTask: false, prompt: "go", images: 2 });
  assert.deepEqual(chat, { mode: "chat" });

  const blocked = planTaskSend({ runAsTask: true, prompt: "go", images: 2 });
  assert.equal(blocked.mode, "blocked");
  assert.match(blocked.notice, /images/i);
  assert.equal("request" in blocked, false);
  assert.equal("key" in blocked, false);

  const task = planTaskSend({
    runAsTask: true,
    prompt: "go",
    conversationId: "conv_9",
    reference: { model: "m-9" },
    mode: "general",
    temperature: 0.7
  });
  assert.equal(task.mode, "task");
  assert.equal(task.key, taskRunSubmissionKey({ conversationId: "conv_9", prompt: "go" }));
  assert.equal(task.request.model, "m-9");
  assert.equal(task.request.conversationId, "conv_9");
});

test("a watched run is named by its task, so coming back finds the same turn", () => {
  const run = taskRunFor("tsk_9", "conv_9");
  assert.deepEqual(run, {
    taskId: "tsk_9",
    assistantId: "task-run-tsk_9",
    runId: "task-run-tsk_9",
    conversationId: "conv_9"
  });
  assert.deepEqual(taskRunFor("tsk_9", null).conversationId, "");
  assert.deepEqual(taskRunFor("tsk_9", "conv_9"), run);
});

test("a chat only watches the open tasks that belong to it", () => {
  const rows = [
    view(trackedRecord({ taskId: "a", state: "running", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "b", state: "queued", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "c", state: "completed", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "d", state: "failed", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "e", state: "running", conversationId: "conv_2" }))
  ];
  assert.deepEqual(taskRunsForConversation(rows, "conv_1").map(row => row.taskId), ["a", "b"]);
  assert.deepEqual(taskRunsForConversation(rows, "conv_2").map(row => row.taskId), ["e"]);
  assert.deepEqual(taskRunsForConversation(rows, ""), []);
  assert.deepEqual(taskRunsForConversation(rows, null), []);
  assert.deepEqual(taskRunsForConversation(null, "conv_1"), []);
  assert.deepEqual(taskRunsForConversation([null, undefined], "conv_1"), []);
});

test("a finished task says where its answer is, and never pretends to hold it", () => {
  assert.match(taskAnswerNote("conv_1", "conv_1"), /this conversation/i);
  assert.match(taskAnswerNote("conv_1", "conv_2"), /conversation it belongs to/i);
  assert.match(taskAnswerNote("", "conv_1"), /no conversation was saved/i);
});

test("status text comes only from fields the backend wrote", () => {
  assert.equal(taskSummaryLine(null), "");
  assert.equal(taskSummaryLine({}), "");
  assert.equal(taskSummaryLine(trackedRecord({ state: "queued", stage: "queued" })), "Waiting for a free slot");
  // An unknown state shows its own name rather than a label that could be wrong.
  assert.equal(taskSummaryLine(trackedRecord({ state: "suspended", stage: "suspended" })), "suspended");
  assert.equal(
    taskSummaryLine(trackedRecord({ state: "running", stage: "executing_tool" })),
    "Working — executing_tool"
  );
  // A terminal record keeps its label: the stage it ended on is not a status.
  assert.equal(taskSummaryLine(trackedRecord({ state: "completed", stage: "done" })), "Completed");
});

test("a wait is only promised when the task really carries one", () => {
  const now = Date.parse("2026-11-07T10:00:00.000Z");
  const waiting = trackedRecord({
    state: "retrying",
    stage: "retrying",
    retry: { attempts: 1, maxAttempts: 5, nextAttemptAt: "2026-11-07T10:00:30.000Z", lastCategory: "rate_limit_requests" }
  });
  const line = describeTaskState(waiting, { now });
  assert.match(line, /attempt 2 of 5/);
  assert.match(line, /retrying in 30s/);
  assert.match(line, /request limit/i);
  assert.equal(taskSummaryLine(waiting, { now }), line);
  // No schedule, no countdown: a bare retrying record says only what it is.
  assert.equal(
    describeTaskState(trackedRecord({ state: "retrying", retry: { attempts: 0, maxAttempts: 0, nextAttemptAt: null } }), { now }),
    "Waiting to retry"
  );
  // A schedule already passed is not reported as still waiting.
  assert.doesNotMatch(
    describeTaskState(
      trackedRecord({ state: "retrying", retry: { attempts: 1, maxAttempts: 3, nextAttemptAt: "2026-11-07T09:00:00.000Z" } }),
      { now }
    ),
    /retrying in/
  );
});

test("a wait for the reader names what it is waiting on", () => {
  assert.equal(
    describeTaskState(trackedRecord({ state: "waiting_for_permission", waitingOn: "write_file" })),
    "Waiting for permission: write_file"
  );
  assert.equal(
    describeTaskState(trackedRecord({ state: "waiting_for_user", waitingOn: "which branch?" })),
    "Waiting for you: which branch?"
  );
  assert.equal(taskSummaryLine(trackedRecord({ state: "waiting_for_user", waitingOn: "which branch?" })), "Waiting for you: which branch?");
  // The values the server actually writes are categories, not descriptions —
  // `waitingOn(task)` in server/src/taskStore.js returns "user", "permission",
  // "capacity", "provider" or "resume". Repeating one after a label that already
  // names the same party would print "Waiting for permission: permission".
  assert.equal(
    describeTaskState(trackedRecord({ state: "waiting_for_permission", waitingOn: "permission" })),
    "Waiting for permission"
  );
  assert.equal(
    describeTaskState(trackedRecord({ state: "waiting_for_user", waitingOn: "user" })),
    "Waiting for you"
  );
  assert.equal(taskSummaryLine(trackedRecord({ state: "waiting_for_user", waitingOn: "user" })), "Waiting for you");
  assert.equal(taskSummaryLine(trackedRecord({ state: "paused", waitingOn: "resume" })), "Paused");
  // A queued row parked on capacity says so in the words the list already uses.
  assert.equal(taskSummaryLine(trackedRecord({ state: "queued", waitingOn: "capacity" })), "Waiting for a free slot");
});

test("a parked question is what the wait now means", () => {
  const asked = trackedRecord({
    state: "waiting_for_user",
    stage: "waiting_for_user",
    waitingOn: "user",
    pendingClarification: { clarificationId: "clr_1", question: "Which branch should I use?" }
  });
  assert.equal(describeTaskState(asked), "Waiting for your answer");
  assert.equal(taskSummaryLine(asked), "Waiting for your answer");
  // A question with no text is not a question: the record still only says who it
  // waits on, because the words "Waiting for your answer" would promise a box the
  // reader has nothing to read.
  assert.equal(
    describeTaskState(trackedRecord({
      state: "waiting_for_user",
      waitingOn: "user",
      pendingClarification: { clarificationId: "clr_1", question: "   " }
    })),
    "Waiting for you"
  );
  // Only the user's own wait is renamed. A permission wait carries a live
  // question in this test to prove the state decides, not the field alone.
  assert.equal(
    describeTaskState(trackedRecord({
      state: "waiting_for_permission",
      waitingOn: "permission",
      pendingClarification: { clarificationId: "clr_1", question: "Which branch?" }
    })),
    "Waiting for permission"
  );
  // A finished record does not start asking questions again.
  assert.equal(
    describeTaskState(trackedRecord({
      state: "completed",
      stage: "done",
      pendingClarification: { clarificationId: "clr_1", question: "Which branch?" }
    })),
    "Completed"
  );
  // A value that is not a question row yields no text rather than a crash.
  assert.equal(
    describeTaskState(trackedRecord({ state: "waiting_for_user", waitingOn: "user", pendingClarification: "nope" })),
    "Waiting for you"
  );
});

test("a failure repeats the backend's own reason", () => {
  assert.equal(taskErrorLine(trackedRecord()), null);
  assert.equal(taskErrorLine(trackedRecord({ error: { code: "upstream_unavailable", message: "The model is down." } })), "The model is down. (upstream_unavailable)");
  assert.equal(taskErrorLine(trackedRecord({ error: { code: "no_route", message: "" } })), "Failed: no_route");
  assert.equal(taskErrorLine(trackedRecord({ error: { code: "", message: "Just a sentence." } })), "Just a sentence.");
  // An error the backend recorded outranks the stage the task died on.
  assert.equal(
    taskSummaryLine(trackedRecord({ state: "failed", stage: "responding", error: { code: "empty_response", message: "Nothing back." } })),
    "Nothing back. (empty_response)"
  );
  assert.equal(taskErrorLine(trackedRecord({ error: "a string" })), null);
});

test("progress lines exist only because events exist", () => {
  const bare = trackedRecord({ events: [] });
  const bareLines = taskProgressLines(bare);
  assert.deepEqual(bareLines.map(line => line.id), ["asked"]);
  assert.equal(
    bareLines.some(line => /%|progress of|estimated/i.test(line.text)),
    false
  );
  const running = trackedRecord({
    events: [
      serverEvent({ seq: 1, message: "Reading the folder.", status: "completed" }),
      serverEvent({ seq: 2, message: "Writing the answer.", status: "running" })
    ]
  });
  const lines = taskProgressLines(running);
  assert.match(lines[1].text, /^Now: Writing the answer\.$/);
  assert.equal(lines[1].id, "step:2");
  // A settled log is described as the last step, never as current work.
  const settled = trackedRecord({ state: "completed", events: [serverEvent({ seq: 3, status: "completed", message: "Saved." })] });
  const settledLines = taskProgressLines(settled);
  assert.match(settledLines[1].text, /^Last step: Saved\.$/);
  assert.match(settledLines[2].text, /^Answer: |^The answer is in the conversation\.$/);
  assert.equal(taskProgressLines(trackedRecord({ state: "failed", error: { message: "Boom." } })).at(-1).text, "Failed: Boom.");
  assert.ok(taskProgressLines(running).length <= 3);
});

test("the question takes the open step's place, not a line of its own", () => {
  const parked = trackedRecord({
    state: "waiting_for_user",
    stage: "waiting_for_user",
    waitingOn: "user",
    pendingClarification: { clarificationId: "clr_7", question: "Which quarter?" },
    events: [
      serverEvent({ seq: 1, message: "Reading the folder.", status: "completed" }),
      serverEvent({ seq: 2, message: "Writing the answer.", status: "running" })
    ]
  });
  const lines = taskProgressLines(parked);
  assert.deepEqual(lines.map(line => line.id), ["asked", "question:clr_7", "outcome"]);
  // The reader sees the question they must answer, not the step that stopped.
  assert.equal(lines[1].text, "Which quarter?");
  assert.equal(lines[2].text, "Waiting for your answer");
  assert.equal(
    lines.some(line => /^Now: /.test(line.text)),
    false
  );
  // The id names the question, so a re-parked task cannot reuse the previous
  // row's key and leave the old text on screen.
  assert.notEqual(taskProgressLines({
    ...parked,
    pendingClarification: { clarificationId: "clr_8", question: "Which year?" }
  })[1].id, lines[1].id);
  // Whitespace collapses; the server's words do not change.
  assert.equal(
    taskProgressLines({
      ...parked,
      pendingClarification: { clarificationId: "clr_9", question: "  Which branch?\n\n(main or dev)  " }
    })[1].text,
    "Which branch? (main or dev)"
  );
  // Without a question, the step line comes back — the park only replaces it
  // when there is something to read in its place.
  assert.equal(
    taskProgressLines({
      ...parked,
      pendingClarification: { clarificationId: "clr_7", question: "" }
    })[1].id,
    "step:2"
  );
});

test("task events become turn rows only through the server's own log", () => {
  assert.deepEqual(taskProgressEvents(null), []);
  assert.deepEqual(taskProgressEvents({ events: "nope" }), []);
  assert.deepEqual(taskProgressEvents({ events: [null, 3, serverEvent({ seq: 9 })] }), [serverEvent({ seq: 9 })]);
});

test("a task turn's rows are the backend's events, one line per operation", () => {
  const start = [
    { id: "user_1", role: "user", content: "Build it" },
    createAssistantTurn({ id: "task-run-tsk_1" })
  ];
  const events = [
    serverEvent({ seq: 1, message: "Waiting for a free slot.", key: "queued", status: "completed" }),
    serverEvent({ seq: 2, phase: "provider", message: "Asking the model.", key: "responding", status: "running" })
  ];
  let messages = recordTurnProgress(start, "task-run-tsk_1", events, { runId: "task-run-tsk_1" });
  const turn = messages[1];
  assert.equal(turn.status, TURN_STATUS.STREAMING);
  assert.deepEqual(turn.activity.map(row => row.label), ["Waiting for a free slot.", "Asking the model."]);
  assert.deepEqual(turn.activity.map(row => row.status), ["completed", "running"]);
  assert.equal(turn.content, "");

  // Replaying the same window changes nothing, so a reconnect cannot double a line.
  assert.equal(recordTurnProgress(messages, "task-run-tsk_1", events, { runId: "task-run-tsk_1" }), messages);

  // The same operation settling keeps its line and moves it forward.
  messages = recordTurnProgress(messages, "task-run-tsk_1", [
    serverEvent({ seq: 2, phase: "provider", message: "Asking the model.", key: "responding", status: "completed" })
  ], { runId: "task-run-tsk_1" });
  assert.deepEqual(messages[1].activity.map(row => row.status), ["completed", "completed"]);

  // A stale replay cannot reopen a settled line.
  messages = recordTurnProgress(messages, "task-run-tsk_1", [
    serverEvent({ seq: 2, phase: "provider", message: "Asking the model.", key: "responding", status: "running" })
  ], { runId: "task-run-tsk_1" });
  assert.deepEqual(messages[1].activity.map(row => row.status), ["completed", "completed"]);

  // Another task's rows never land in this turn.
  assert.equal(recordTurnProgress(messages, "task-run-tsk_other", events, { runId: "r" }), messages);
});

test("two tasks in one chat keep their own rows, turns and outcomes", () => {
  let messages = [
    createAssistantTurn({ id: "task-run-a" }),
    createAssistantTurn({ id: "task-run-b" })
  ];
  messages = recordTurnProgress(messages, "task-run-a", [serverEvent({ seq: 1, message: "First: working." })], { runId: "task-run-a" });
  messages = recordTurnProgress(messages, "task-run-b", [serverEvent({ seq: 1, message: "Second: working." })], { runId: "task-run-b" });
  assert.deepEqual(messages[0].activity.map(row => row.label), ["First: working."]);
  assert.deepEqual(messages[1].activity.map(row => row.label), ["Second: working."]);

  messages = completeTurn(messages, "task-run-a", { content: "Done in the conversation." });
  // A settled turn is finished: its own task's later events cannot restart it.
  const after = recordTurnProgress(messages, "task-run-a", [serverEvent({ seq: 2, message: "First: still working." })], { runId: "task-run-a" });
  assert.equal(after, messages);
  assert.equal(after[0].status, TURN_STATUS.COMPLETED);
  // and the other task is untouched by that outcome.
  assert.equal(after[1].status, TURN_STATUS.STREAMING);
  assert.deepEqual(after[1].activity.map(row => row.label), ["Second: working."]);
});

test("terminal states settle a task turn, and a stop leaves no empty reply", () => {
  const messages = completeTurn([createAssistantTurn({ id: "t" })], "t", {
    content: taskAnswerNote("conv_1", "conv_1")
  });
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.match(messages[0].content, /this conversation/i);

  const failed = failTurn([createAssistantTurn({ id: "t" })], "t", {
    error: { title: "Task failed", message: taskErrorLine(trackedRecord({ error: { code: "no_route", message: "" } })) || "", retry: false, canSwitchModel: false }
  });
  assert.equal(failed[0].status, TURN_STATUS.FAILED);
  assert.equal(failed[0].error.retry, false);
  assert.equal(failed[0].error.canSwitchModel, false);

  // A cancelled task with a log but no answer text is removed, exactly like a
  // cancelled chat turn: nothing is left claiming an answer arrived.
  const withRows = recordTurnProgress([createAssistantTurn({ id: "t" })], "t", [serverEvent()], { runId: "t" });
  assert.equal(withRows[0].status, TURN_STATUS.STREAMING);
  assert.equal(cancelTurn(withRows, "t").length, 0);
});

test("a task send returns before the chat turn begins", () => {
  const branch = sourceSlice('if (plan.mode === "task") {', "const history = requestHistory");
  assert.match(branch, /await submitTaskRun\(/);
  assert.match(branch, /return;/);
  assert.equal(/beginRequest\(|streamChatResponse|runComboTurn|setLoading\(true\)/.test(branch), false);
  // A refused task send stops there too — it must not fall through to a chat turn.
  const blocked = sourceSlice('if (plan.mode === "blocked") {', 'if (plan.mode === "task") {');
  assert.match(blocked, /return;/);
  assert.match(blocked, /setComposerWarning\(plan\.notice\)/);
});

test("submitting a task begins no chat request and keeps nothing to abort", () => {
  const body = functionBody("submitTaskRun");
  for (const forbidden of ["beginRequest", "setLoading", "streamingIdRef", "abortRef", "signal", "controller", "streamChatResponse"]) {
    assert.equal(body.includes(forbidden), false, `submitTaskRun must not touch ${forbidden}`);
  }
  assert.match(body, /submitTrackedTask\(plan\.request, \{ key: plan\.key \}\)/);
  // The uncertain outcome is reported as uncertain, not offered as a resend.
  assert.match(body, /taskSubmissionUncertain/);
  assert.match(body, /may already have started/);
});

test("leaving a chat or pressing Stop cannot interrupt a durable task", () => {
  // The chat's own cancellation path — the one Stop, a conversation switch and
  // unmount all run — must not reach into the task watches it does not own.
  const invalidate = functionBody("invalidateInFlight");
  for (const forbidden of ["taskRun", "cancelTask", "cancelTrackedTask", "trackedTasks"]) {
    assert.equal(invalidate.includes(forbidden), false, `invalidateInFlight must not touch ${forbidden}`);
  }
  const stop = functionBody("handleStop");
  assert.equal(stop.includes("taskRun"), false, "Stop ends the chat turn, never a task");
  // Detaching a watch is the most a conversation switch or a sign-out may do.
  assert.match(functionBody("loadTask"), /setTaskRuns\(\{\}\)/);
  assert.match(functionBody("resetConversation"), /setTaskRuns\(\{\}\)/);
});

test("a finished task re-reads only its own conversation, and only when it is safe", () => {
  const body = functionBody("settleTaskRun");
  assert.match(body, /conversationId !== String\(activeConvId \|\| ""\)/);
  assert.match(body, /sendingRef\.current \|\| loading/);
  assert.match(body, /loadTask\(conversationId\)/);
  assert.equal(body.includes("loadTask(activeConvId"), false);
  // The answer itself is never copied out of the task record.
  assert.equal(body.includes("record.result"), false);
  const adopt = functionBody("adoptTaskRunConversation");
  assert.match(adopt, /if \(activeConvId \|\| loading \|\| sendingRef\.current\) return;/);
  assert.match(adopt, /messages\.some\(message => message\.id === run\.assistantId\)/);
});

test("the composer states the mode it will use and the task status it was given", () => {
  assert.match(chatPageSource, /const watchedTaskLines = Object\.keys\(taskRuns\)/);
  assert.match(chatPageSource, /taskSummaryLine\(view\.task\)/);
  // The status line the composer shows is joined from the tracked tasks' own
  // summaries — the formatters above, reading the backend record — and it is
  // announced as a live status region, with a way to the page that owns them.
  assert.match(
    chatPageSource,
    /<div className="vr-notice" role="status">\s*<span>\{watchedTaskLines\.join\(" · "\)\}<\/span>\s*<Link to="\/tasks">Tasks<\/Link>/
  );
  // The mode switch is a real control group, so the send path is visible and
  // the state the reader picked is the state reported to assistive tech.
  assert.match(chatPageSource, /<span className="vr-mode-switch__label">Send as<\/span>/);
  assert.match(chatPageSource, /Runs on the server and keeps going when you leave this chat/);
});
