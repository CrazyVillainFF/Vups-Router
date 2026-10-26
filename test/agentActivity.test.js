import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVITY_STATUS,
  activityFromArtifact,
  applyActivityProgress,
  formatElapsed,
  mergeActivityFiles,
  progressEvent,
  progressFilePath,
  progressLabel,
  settleActivity
} from "../src/chat/activity.js";
import {
  TURN_STATUS,
  beginContinuation,
  completeTurn,
  createAssistantTurn,
  failTurn,
  interruptTurn,
  recordTurnActivity
} from "../src/chat/turnLifecycle.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("stream progress becomes stable, run-scoped activity rows", () => {
  const event = progressEvent(
    { phase: "generating_file", message: "Generating src/app.js…" },
    { runId: "run-1", at: 1000 }
  );
  assert.equal(event.id, "run-1:file:src/app.js");
  assert.equal(event.phase, "generating_file");
  assert.equal(event.label, "Writing app.js");
  assert.equal(event.filePath, "src/app.js");
  assert.equal(event.status, ACTIVITY_STATUS.RUNNING);
  assert.equal(event.startedAt, 1000);
  assert.equal(event.endedAt, null);
  assert.equal(progressEvent({ phase: "done" }), null);
});

test("each new operation closes the previous one and repeats never duplicate", () => {
  let rows = applyActivityProgress([], { phase: "request" }, { runId: "r", at: 1000 });
  rows = applyActivityProgress(rows, { phase: "waiting" }, { runId: "r", at: 1200 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, ACTIVITY_STATUS.COMPLETED);
  assert.equal(rows[0].endedAt, 1200);
  assert.equal(rows[1].status, ACTIVITY_STATUS.RUNNING);

  const repeated = applyActivityProgress(rows, { phase: "waiting" }, { runId: "r", at: 1500 });
  assert.equal(repeated, rows);

  const file = applyActivityProgress(rows, {
    phase: "generating_file",
    message: "Generating index.html…"
  }, { runId: "r", at: 1800 });
  assert.equal(file.length, 3);
  assert.equal(file[2].filePath, "index.html");
  const duplicateFile = applyActivityProgress(file, {
    phase: "generating_file",
    message: "Generating index.html…"
  }, { runId: "r", at: 2000 });
  assert.equal(duplicateFile, file);
});

test("settling only touches rows that are still running", () => {
  const rows = applyActivityProgress([], { phase: "request" }, { runId: "r", at: 10 });
  const settled = settleActivity(rows, ACTIVITY_STATUS.FAILED, 20);
  assert.equal(settled[0].status, ACTIVITY_STATUS.FAILED);
  assert.equal(settled[0].endedAt, 20);
  assert.equal(settleActivity(settled, ACTIVITY_STATUS.CANCELLED, 30), settled);
});

test("restored artifacts contribute real file rows without duplicates", () => {
  const files = [
    { path: "index.html", content: "<h1>Hi</h1>", bytes: 11 },
    { path: "app.js", content: "const a = 1;", bytes: 12, complete: false },
    { path: "blank.css", content: "   ", bytes: 0 }
  ];
  const restored = activityFromArtifact(files);
  assert.deepEqual(restored.map(row => row.filePath), ["index.html", "app.js"]);
  assert.equal(restored[0].status, ACTIVITY_STATUS.COMPLETED);
  assert.equal(restored[1].status, ACTIVITY_STATUS.RUNNING);

  const streamed = applyActivityProgress([], {
    phase: "generating_file",
    message: "Generating index.html"
  }, { runId: "r", at: 10 });
  const merged = mergeActivityFiles(streamed, files);
  assert.deepEqual(merged.map(row => row.filePath), ["index.html", "app.js"]);
  assert.equal(merged[0].id, "r:file:index.html");
  assert.equal(merged[1].id, "artifact:app.js");
  assert.equal(mergeActivityFiles(merged, files), merged);
});

test("progress text is cleaned without inventing filenames", () => {
  assert.equal(progressFilePath("Generating index.html…"), "index.html");
  assert.equal(progressFilePath("Generating src/app.js..."), "src/app.js");
  assert.equal(progressLabel("generating_file", "Generating app.js\ufffd??"), "Writing app.js");
  assert.equal(progressLabel("generating_code", "Generating your code…"), "Generating code");
  assert.equal(progressLabel("waiting"), "Connecting to model");
});

test("elapsed labels use real timestamps", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(12000), "12s");
  assert.equal(formatElapsed(65000), "1m 5s");
  assert.equal(formatElapsed(3723000), "1h 2m");
  assert.equal(formatElapsed(-1), "");
  assert.equal(formatElapsed(null), "");
});

test("assistant turns keep activity instead of invented steps", () => {
  const turn = createAssistantTurn({ id: "a1", at: 1000 });
  assert.deepEqual(turn.activity, []);
  assert.equal("steps" in turn, false);

  let messages = recordTurnActivity(
    [turn],
    "a1",
    { phase: "request", message: "Sending request" },
    { runId: "r1", at: 1000 }
  );
  assert.equal(messages[0].status, TURN_STATUS.STREAMING);
  assert.equal(messages[0].activity.length, 1);

  messages = recordTurnActivity(
    messages,
    "a1",
    { phase: "generating_file", message: "Generating index.html…" },
    { runId: "r1", at: 1400 }
  );
  assert.equal(messages[0].activity.length, 2);
  assert.equal(messages[0].activity[0].status, ACTIVITY_STATUS.COMPLETED);

  const completed = completeTurn(messages, "a1", { content: "<h1>Hi</h1>", at: 2000 });
  assert.equal(completed[0].activity.every(row => row.status === ACTIVITY_STATUS.COMPLETED), true);
  assert.equal(completed[0].completedAt, 2000);

  const failed = failTurn(messages, "a2", { error: { code: "stream_error" } });
  assert.equal(failed, messages);
  const failedTurn = failTurn(
    recordTurnActivity([turn], "a1", { phase: "request" }, { runId: "r2", at: 10 }),
    "a1",
    { error: { code: "stream_error" } }
  );
  assert.equal(failedTurn[0].activity[0].status, ACTIVITY_STATUS.FAILED);
});

test("a continuation starts a new run while old rows remain settled", () => {
  const active = recordTurnActivity(
    [createAssistantTurn({ id: "a1", at: 1000 })],
    "a1",
    { phase: "request" },
    { runId: "r1", at: 1000 }
  );
  const interrupted = interruptTurn(active, "a1", { content: "partial" });
  assert.equal(interrupted[0].activity[0].status, ACTIVITY_STATUS.CANCELLED);

  const resumed = beginContinuation(interrupted, "a1", { at: 5000 });
  assert.equal(resumed[0].startedAt, 5000);
  assert.equal(resumed[0].completedAt, null);
  const next = recordTurnActivity(resumed, "a1", { phase: "responding" }, { runId: "r2", at: 5000 });
  assert.deepEqual(next[0].activity.map(row => row.id), ["r1:request", "r2:responding"]);
});

test("the activity timeline uses real events, accessible controls, and no fake rows", () => {
  const agent = read("src/components/AgentActivity.jsx");
  assert.match(agent, /mergeActivityFiles\(events, files\)/);
  assert.match(agent, /aria-expanded=\{open\}/);
  assert.match(agent, /aria-controls=\{panelId\}/);
  assert.match(agent, /hidden=\{!open\}/);
  assert.match(agent, /role="status"/);
  assert.match(agent, /formatElapsed/);
  assert.match(agent, /if \(active\) setOpen\(true\)/);
  assert.match(agent, /if \(!pinned\) setOpen\(false\)/);
  assert.doesNotMatch(agent, /chain of thought|tool_calls|internal prompt/i);
});

test("chat forwards real activity into the assistant turn that produced it", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /onActivity: \(activity\) =>/);
  assert.match(page, /recordTurnActivity\(prev, assistantId, activity, \{ runId: activityRunId \}\)/);
  assert.match(page, /recordTurnActivity\(prev, targetId, activity, \{ runId: activityRunId \}\)/);
  assert.match(page, /<AgentActivity[\s\S]*?events=\{message\.activity \|\| \[\]\}/);
  assert.match(page, /files=\{activityFiles\}/);
  assert.match(page, /active=\{isStreaming\}/);
  assert.match(page, /pinned=\{pinned\}/);
  assert.doesNotMatch(page, /progressTurn|progressFiles|showProgress/);
  assert.doesNotMatch(page, /initialSteps|appendTurnStep/);
});
