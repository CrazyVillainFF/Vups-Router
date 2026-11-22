import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as taskRunModule from "../src/chat/taskRun.js";
import {
  taskProgressEvents,
  taskRunFor,
  taskRunHasAnswer,
  taskRunsForConversation,
  restoreTaskTurn
} from "../src/chat/taskRun.js";
import {
  MAX_TASK_PROMPT_CHARS,
  durableChatRun,
  taskRunRequest,
  taskRunSubmissionKey
} from "../src/tasks/taskSubmission.js";
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
  syncTurnContent,
  TURN_STATUS
} from "../src/chat/turnLifecycle.js";

const chatPageSource = readFileSync(
  fileURLToPath(new URL("../src/ChatPage.jsx", import.meta.url)),
  "utf8"
).replace(/\r\n/g, "\n");

const taskPanelSource = readFileSync(
  fileURLToPath(new URL("../src/chat/TaskTurnPanel.jsx", import.meta.url)),
  "utf8"
).replace(/\r\n/g, "\n");

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

/** Everything between a function's opening brace and its matching close. */
function functionBody(name, source = chatPageSource) {
  const signature = `function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${name} is still part of the source`);
  const open = source.indexOf("{\n", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(open, index + 1);
  }
  assert.fail(`${name} never closes`);
}

test("normal chat, Combo and attachments automatically use durable execution", () => {
  assert.equal(MAX_TASK_PROMPT_CHARS, 2_000_000);
  assert.equal(durableChatRun({ prompt: "Do the work" }), true);
  assert.equal(durableChatRun({ prompt: "go", combo: true }), true);
  assert.equal(durableChatRun({ prompt: "go", images: [{}], textFiles: [{}] }), true);
  assert.equal(durableChatRun({ prompt: "", images: [{}] }), true);
  assert.equal(durableChatRun({ prompt: "x".repeat(MAX_TASK_PROMPT_CHARS) }), true);
  assert.equal(durableChatRun({ prompt: "x".repeat(MAX_TASK_PROMPT_CHARS + 1) }), false);
  assert.equal(durableChatRun({ prompt: "go", nativeTools: true }), false);
  assert.equal(durableChatRun({ prompt: "" }), false);
});

test("repeating the same text deliberately creates a new intent", () => {
  const input = { conversationId: "conv_1", prompt: "Continue", nonce: "send-1" };
  assert.equal(taskRunSubmissionKey(input), taskRunSubmissionKey({ ...input }));
  assert.notEqual(taskRunSubmissionKey(input), taskRunSubmissionKey({ ...input, nonce: "send-2" }));
});

test("replayed full output cannot duplicate or shorten an active answer", () => {
  const initial = [createAssistantTurn({ id: "a" }), createAssistantTurn({ id: "b" })];
  const first = syncTurnContent(initial, "a", "Hello");
  assert.equal(first[0].content, "Hello");
  assert.equal(first[0].status, TURN_STATUS.STREAMING);
  assert.equal(first[1], initial[1]);
  assert.equal(syncTurnContent(first, "a", "Hello"), first);
  assert.equal(syncTurnContent(first, "a", "He"), first);
  const next = syncTurnContent(first, "a", "Hello world");
  assert.equal(next[0].content, "Hello world");
  const done = completeTurn(next, "a", { content: "Hello world" });
  assert.equal(syncTurnContent(done, "a", "Late output ignored"), done);
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
    "combo", "configId", "conversationId", "mode", "model", "pluginTools", "prompt", "providerId",
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
  const image = { name: "photo.png", dataUrl: "data:image/png;base64,AA==" };
  const attached = taskRunRequest({ prompt: "Look", images: [image], combo: true, pluginTools: true });
  assert.deepEqual(attached.images, [image]);
  assert.equal(attached.combo, true);
  assert.equal(attached.pluginTools, true);
});

test("a retry names the message it repeats, and only then", () => {
  const retried = taskRunRequest({ prompt: "go", conversationId: "conv_1", retryUserMessageId: "msg_7" });
  assert.equal(retried.retryUserMessageId, "msg_7");
  assert.equal("retryUserMessageId" in taskRunRequest({ prompt: "go", conversationId: "conv_1" }), false);
  const handleRetry = functionBody("handleRetry");
  assert.match(handleRetry, /lastUser\.messageId/);
  assert.match(handleRetry, /retryUserMessageId/);
  assert.match(functionBody("handleSend"), /retryUserMessageId/);
});

test("the composer submits a durable run before any request-bound fallback", () => {
  const send = functionBody("handleSend");
  assert.match(send, /durableChatRun\(/);
  assert.match(send, /await submitTaskRun\(/);
  assert.match(send, /taskRunRequest\(/);
  assert.match(send, /idempotencyKey: key/);
  assert.ok(send.indexOf("await submitTaskRun(") < send.indexOf("await streamChatResponse("));
  assert.match(send, /sendingRef\.current = true/);
  assert.match(chatPageSource, /const DEFAULT_CHAT_MODE = "general";/);
  assert.equal(chatPageSource.includes("vr-mode-switch"), false);
  assert.equal(chatPageSource.includes("chatMode"), false);
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

test("reopening a run reuses its saved assistant and preserves the rest of the conversation", () => {
  const record = trackedRecord({ assistantMessageId: "saved_a", userMessageId: "saved_u" });
  const run = taskRunFor(record.taskId, record.conversationId);
  const messages = [
    { id: "u", messageId: "saved_u", role: "user", content: "Build it" },
    { ...createAssistantTurn({ id: "local_a" }), messageId: "saved_a", content: "Partial", status: TURN_STATUS.INTERRUPTED },
    { id: "other", role: "user", content: "Another message" }
  ];
  const restored = restoreTaskTurn(messages, run, record);
  assert.equal(restored.length, 3);
  assert.equal(restored[1].id, run.assistantId);
  assert.equal(restored[1].content, "Partial");
  assert.equal(restored[1].status, TURN_STATUS.STREAMING);
  assert.equal(restored[2], messages[2]);
  assert.equal(restoreTaskTurn(restored, run, record), restored);
  const absent = restoreTaskTurn([messages[0], messages[2]], run, record);
  assert.equal(absent[1].id, run.assistantId);
  assert.equal(absent[2], messages[2]);
  const stopped = cancelTurn(absent, run.assistantId, { keepEmpty: true });
  assert.equal(stopped[1].status, TURN_STATUS.CANCELLED);
  assert.equal(stopped[1].content, "");
});

test("a saved answer and the run's own placeholder are one turn, not two", () => {
  // The defect: the placeholder collects the run's progress while the saved
  // row carries the answer, and both are drawn — each with its own "Thought
  // for" header. Restoring must collapse them into the saved row.
  const record = trackedRecord({
    state: "completed",
    stage: "done",
    assistantMessageId: "saved_a",
    userMessageId: "saved_u",
    output: { text: "The answer.", messageId: "saved_a" }
  });
  const run = taskRunFor(record.taskId, record.conversationId);
  const saved = {
    ...createAssistantTurn({ id: "history_a" }),
    messageId: "saved_a",
    content: "The answer.",
    status: TURN_STATUS.COMPLETED,
    activity: [serverEvent({ seq: 3, message: "Saved the answer.", status: "completed" })]
  };
  const placeholder = {
    ...createAssistantTurn({ id: run.assistantId }),
    activity: [serverEvent({ seq: 1, message: "Asking the model." })]
  };
  const messages = [
    { id: "u", messageId: "saved_u", role: "user", content: "Build it" },
    placeholder,
    saved
  ];
  const restored = restoreTaskTurn(messages, run, record);
  assert.equal(restored.length, 2);
  assert.equal(restored[1].id, run.assistantId);
  assert.equal(restored[1].content, "The answer.");
  assert.equal(restored[1].messageId, "saved_a");
  assert.deepEqual(restored[1].activity, saved.activity);
  assert.equal(new Set(restored.map(message => message.id)).size, restored.length);
  // A remount or a navigation away and back restores the same list.
  assert.equal(restoreTaskTurn(restored, run, record), restored);
});

test("a placeholder already renamed to the saved row still merges with it", () => {
  // The submit path renames the placeholder as soon as the task reports an
  // assistantMessageId, so the placeholder itself matches the saved row's id.
  // The lookup must ignore it and find the row the server wrote.
  const record = trackedRecord({ state: "running", assistantMessageId: "saved_a", userMessageId: "saved_u" });
  const run = taskRunFor(record.taskId, record.conversationId);
  const placeholder = { ...createAssistantTurn({ id: run.assistantId }), messageId: "saved_a" };
  const saved = { ...createAssistantTurn({ id: "history_a" }), messageId: "saved_a", content: "Partial answer" };
  const restored = restoreTaskTurn([placeholder, saved], run, record);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, run.assistantId);
  assert.equal(restored[0].content, "Partial answer");
  assert.equal(restored[0].status, TURN_STATUS.STREAMING);
  assert.equal(restoreTaskTurn(restored, run, record), restored);
});

test("a terminal record settles its turn once, however often it is replayed", () => {
  // The tracker may report the same completed record on every poll; the
  // effect must hand it to settleTaskRun once per terminal state, not once
  // per render.
  const settleCall = /if \(isTerminalTaskState\(view\.state\) && run\.settledState !== view\.state\) settleTaskRun\(run, view\.task\);/;
  assert.match(chatPageSource, settleCall);
  assert.match(functionBody("settleTaskRun"), /settledState: record\.state/);
  // The completed turn keeps the server's message id, so a later restore
  // recognizes its own turn instead of inserting another.
  assert.match(functionBody("settleTaskRun"), /messageId: record\.output\?\.messageId \|\| record\.assistantMessageId \|\| undefined/);
});

test("a chat restores open and settled runs belonging to it", () => {
  const rows = [
    view(trackedRecord({ taskId: "a", state: "running", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "b", state: "queued", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "c", state: "completed", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "d", state: "failed", conversationId: "conv_1" })),
    view(trackedRecord({ taskId: "e", state: "running", conversationId: "conv_2" }))
  ];
  assert.deepEqual(taskRunsForConversation(rows, "conv_1").map(row => row.taskId), ["a", "b", "c", "d"]);
  assert.deepEqual(taskRunsForConversation(rows, "conv_2").map(row => row.taskId), ["e"]);
  assert.deepEqual(taskRunsForConversation(rows, ""), []);
  assert.deepEqual(taskRunsForConversation(rows, null), []);
  assert.deepEqual(taskRunsForConversation(null, "conv_1"), []);
  assert.deepEqual(taskRunsForConversation([null, undefined], "conv_1"), []);
});

test("a finished task shows its answer and needs no note of its own", () => {
  // There is no generic "the run finished" sentence any more: the answer is
  // the answer, and a run that produced one says nothing more.
  assert.equal(taskRunModule.taskAnswerNote, undefined);
  assert.equal(taskRunHasAnswer({ output: { text: "The answer." } }), true);
  assert.equal(taskRunHasAnswer({ output: { text: "   " } }), false);
  assert.equal(taskRunHasAnswer({ output: {} }), false);
  assert.equal(taskRunHasAnswer(null), false);
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
    content: "The answer the model gave."
  });
  assert.equal(messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(messages[0].content, "The answer the model gave.");

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

test("leaving a chat detaches while explicit Stop cancels its durable run", () => {
  const invalidate = functionBody("invalidateInFlight");
  assert.doesNotMatch(invalidate, /cancelTaskRun|cancelTrackedTask/);
  const stop = functionBody("handleStop");
  assert.match(stop, /durableSubmitRef\.current/);
  assert.match(stop, /cancelTaskRun/);
  assert.match(functionBody("loadTask"), /setTaskRuns\(\{\}\)/);
  assert.match(functionBody("resetConversation"), /setTaskRuns\(\{\}\)/);
});

test("completed output updates only its turn without reloading another active run", () => {
  const body = functionBody("settleTaskRun");
  assert.match(body, /record\.output\?\.text/);
  assert.match(body, /loadedTaskRef\.current !== conversationId/);
  assert.match(body, /completeTurn\(previous, run\.assistantId/);
  assert.match(body, /finishReason:/);
  assert.doesNotMatch(body, /loadTask\(/);
  assert.match(body, /retry: true/);
  const adopt = functionBody("adoptTaskRunConversation");
  assert.match(adopt, /if \(activeConvId \|\| loading \|\| sendingRef\.current\) return;/);
  assert.match(adopt, /messages\.some\(message => message\.id === run\.assistantId\)/);
});

test("progress, questions and controls stay beside the assistant turn", () => {
  assert.match(chatPageSource, /liveTaskTurnIds/);
  assert.match(chatPageSource, /<TaskTurnPanel/);
  assert.match(chatPageSource, /syncTurnContent\(previous, run\.assistantId, partial\)/);
  assert.match(taskPanelSource, /taskSummaryLine\(task\)/);
  assert.match(taskPanelSource, /onAnswer\(taskId, clarification\.clarificationId, draft\)/);
  assert.doesNotMatch(chatPageSource, /<Link to="\/tasks"/);
  assert.equal(chatPageSource.includes("Send as"), false);
});
