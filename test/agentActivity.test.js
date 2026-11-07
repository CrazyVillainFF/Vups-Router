import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVITY_COLLAPSE_HOLD_MS,
  ACTIVITY_STATUS,
  activityFromArtifact,
  applyActivityProgress,
  applyProgressRows,
  formatElapsed,
  mergeActivityFiles,
  progressEvent,
  progressFilePath,
  progressLabel,
  settleActivity,
  shouldAutoCollapseActivity
} from "../src/chat/activity.js";
import {
  TURN_STATUS,
  beginContinuation,
  completeTurn,
  createAssistantTurn,
  failTurn,
  interruptTurn,
  recordTurnActivity,
  recordTurnProgress
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
  assert.equal(progressLabel("waiting"), "Waiting for model");
  assert.equal(progressLabel("responding"), "Generating response");
  assert.equal(progressLabel("plugin_tools"), "Running tools");
  assert.equal(progressLabel("approval"), "Waiting for approval");
  assert.equal(progressLabel("reconnecting"), "Reconnecting");
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
  assert.match(agent, /inert=\{open \? undefined : true\}/);
  assert.match(agent, /aria-hidden=\{open \? undefined : "true"\}/);
  assert.doesNotMatch(agent, /hidden=\{!open\}/, "display:none would skip the collapse animation");
  assert.match(agent, /role="status"/);
  assert.match(agent, /formatElapsed/);
  assert.doesNotMatch(agent, /chain of thought|tool_calls|internal prompt/i);
});

test("a settled turn folds its steps, a failure keeps them open", () => {
  assert.equal(ACTIVITY_COLLAPSE_HOLD_MS, 700);

  // Still streaming: expanded with live progress.
  assert.equal(shouldAutoCollapseActivity({ active: true, ranLive: true }), false);
  // The generating -> complete transition is what triggers the fold.
  assert.equal(
    shouldAutoCollapseActivity({ active: false, status: "completed", ranLive: true }),
    true
  );
  assert.equal(
    shouldAutoCollapseActivity({ active: false, status: TURN_STATUS.CANCELLED, ranLive: true }),
    true
  );
  // A turn the reader never watched run is history: already folded, never animated.
  assert.equal(
    shouldAutoCollapseActivity({ active: false, status: "completed", ranLive: false }),
    false
  );
  // A manual open wins for the rest of the message.
  assert.equal(
    shouldAutoCollapseActivity({
      active: false,
      status: "completed",
      ranLive: true,
      userToggled: true
    }),
    false
  );
  // Failure keeps the steps visible so the red row can be read.
  for (const status of [TURN_STATUS.FAILED, ACTIVITY_STATUS.FAILED]) {
    assert.equal(
      shouldAutoCollapseActivity({ active: false, status, ranLive: true }),
      false,
      `failed turns stay expanded (${status})`
    );
  }
});

test("the fold animates height and opacity instead of toggling display", () => {
  const agent = read("src/components/AgentActivity.jsx");
  const css = read("src/components/AgentActivity.css");
  assert.match(agent, /className="vr-activity__trace" data-open=\{open \? "" : undefined\}/);
  assert.match(agent, /className="vr-activity__fold"/);
  assert.match(
    css,
    /\.vr-activity__trace\s*\{[^}]*grid-template-rows:\s*0fr[^}]*transition:\s*grid-template-rows 250ms ease/s
  );
  assert.match(css, /\.vr-activity__trace\[data-open\]\s*\{[^}]*grid-template-rows:\s*1fr/s);
  assert.match(css, /\.vr-activity__fold\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.vr-activity__panel\s*\{[^}]*opacity:\s*0[^}]*transition:\s*opacity 250ms ease/s);
  assert.match(
    css,
    /\.vr-activity__trace\[data-open\] \.vr-activity__panel\s*\{[^}]*opacity:\s*1/s
  );
  assert.doesNotMatch(css, /\.vr-activity__panel\[hidden\]/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(reduced, /\.vr-activity__trace,[\s\S]*?transition:\s*none/);
});

test("the whole header row toggles the timeline", () => {
  const agent = read("src/components/AgentActivity.jsx");
  const css = read("src/components/AgentActivity.css");
  assert.match(agent, /className="vr-activity__head"[\s\S]*?aria-expanded=\{open\}/);
  assert.match(agent, /const toggle = \(\) => \{\s*setUserToggled\(true\);\s*setOpen\(value => !value\);/);
  assert.match(css, /\.vr-activity__head\s*\{[^}]*cursor:\s*pointer/s);
  assert.doesNotMatch(css, /\.vr-activity__toggle/);
});

test("chat forwards real activity into the assistant turn that produced it", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /onActivity: \(activity\) =>/);
  assert.match(page, /recordTurnActivity\(prev, assistantId, activity, \{ runId: activityRunId \}\)/);
  assert.match(page, /recordTurnActivity\(prev, targetId, activity, \{ runId: activityRunId \}\)/);
  assert.match(page, /<AgentActivity[\s\S]*?events=\{message\.activity \|\| \[\]\}/);
  assert.match(page, /files=\{activityFiles\}/);
  assert.match(page, /active=\{isStreaming\}/);
  assert.doesNotMatch(page, /pinned/);
  assert.doesNotMatch(page, /progressTurn|progressFiles|showProgress/);
  assert.doesNotMatch(page, /initialSteps|appendTurnStep/);
});

// ─── Continuous progress from real execution events (PART 2) ────────────────

const writeCall = {
  callId: "call-9",
  phase: "tool",
  status: "running",
  tool: "write_file",
  path: "C:\\work\\index.html",
  label: "Writing a local file",
  message: "write_file C:\\work\\index.html"
};
const writeResult = {
  seq: 4,
  callId: "call-9",
  phase: "tool",
  status: "completed",
  tool: "write_file",
  path: "C:\\work\\index.html",
  label: "Writing a local file",
  message: "write_file completed (C:\\work\\index.html)",
  at: "2026-11-04T10:00:02.000Z"
};

test("the line the app opened is the line the server settles", () => {
  const raised = applyProgressRows([], [writeCall], { runId: "run-9", at: 1000 });
  assert.equal(raised.length, 1);
  assert.equal(raised[0].id, "run-9:call:call-9");
  assert.equal(raised[0].status, ACTIVITY_STATUS.RUNNING);

  const reported = applyProgressRows(raised, [writeResult], { runId: "run-9", at: 2000 });
  assert.equal(reported.length, 1, "the authoritative result settles the line, it is not a second one");
  assert.equal(reported[0].status, ACTIVITY_STATUS.COMPLETED);
  assert.equal(reported[0].label, "Writing a local file", "the wording does not change when the result lands");
  assert.equal(reported[0].startedAt, 1000, "the line keeps the moment the operation really started");
  assert.equal(reported[0].seq, 4, "the position in the stored log survives the merge");

  const replayed = applyProgressRows(reported, [writeCall], { runId: "run-9", at: 3000 });
  assert.equal(replayed, reported, "a replayed running notice cannot reopen finished work");
});

test("a named run row is one line per round and a new run opens its own", () => {
  const open = {
    key: "task",
    phase: "task",
    status: "running",
    path: "C:\\work",
    label: "Working folder",
    message: "Working in C:\\work"
  };
  const rows = applyProgressRows([], [open], { runId: "r1", at: 100 });
  const settled = applyProgressRows(rows, [{ ...open, status: "completed", message: "task completed" }], {
    runId: "r1",
    at: 900
  });
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, ACTIVITY_STATUS.COMPLETED);
  const continuation = applyProgressRows(settled, [open], { runId: "r2", at: 1000 });
  assert.equal(continuation.length, 2, "a second run of the same task gets its own lines");
});

test("progress lands on the turn that is producing it, not on another message", () => {
  let messages = recordTurnProgress(
    [createAssistantTurn({ id: "a1", at: 1000 })],
    "a1",
    [{ key: "task", phase: "task", status: "running", path: "C:\\work", label: "Working folder", message: "Working in C:\\work" }],
    { runId: "r1", at: 1000 }
  );
  assert.equal(messages[0].status, TURN_STATUS.STREAMING);
  assert.equal(messages[0].activity.length, 1);

  messages = recordTurnProgress(messages, "a1", [writeCall, writeResult], { runId: "r1", at: 1400 });
  assert.equal(messages[0].activity.length, 2, "a notice and its result in one batch stay one line");
  assert.equal(messages[0].activity[1].status, ACTIVITY_STATUS.COMPLETED);

  const untouched = recordTurnProgress(messages, "no-such-turn", [writeCall], { runId: "r1", at: 1500 });
  assert.equal(untouched, messages, "an unknown turn id adds nothing");

  const done = completeTurn(messages, "a1", { content: "<h1>Hi</h1>", at: 2000 });
  assert.equal(done[0].activity.every(row => row.status === ACTIVITY_STATUS.COMPLETED), true);
  const afterClose = recordTurnProgress(done, "a1", [writeCall], { runId: "r1", at: 2100 });
  assert.equal(afterClose, done, "a settled turn is not reopened by a late event");
});

test("progress comes from execution events, never from a timer", () => {
  const service = read("src/services/desktopChat.js");
  const page = read("src/ChatPage.jsx");
  assert.doesNotMatch(service, /setInterval|requestAnimationFrame/);
  assert.match(service, /emitProgress\(onProgress, taskProgressRow\(workspacePath\)\)/);
  assert.match(service, /emitProgress\(onProgress, providerProgressRow\(providerStep\)\)/);
  assert.match(service, /emitProgress\(onProgress, toolProgressRow\(\{ callId: id, tool, path, status: "running" \}\)\)/);
  assert.match(service, /forwardProgress\(onProgress, data\?\.events\)/);
  assert.match(
    service,
    /const label = progressRowLabel\(event\);\s*return label \? \{ \.\.\.event, label \} : event;/
  );
  assert.match(page, /onProgress: \(events\) => \{/);
  assert.match(page, /recordTurnProgress\(prev, assistantId, events, \{ runId: activityRunId \}\)/);
});

test("an approval shows as a real wait and settles on the real decision", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /key: `approval:\$\{prompt\.requestId\}`/);
  assert.match(page, /key: `approval:\$\{request\.requestId\}`/);
  assert.match(page, /label: "Waiting for approval"/);
  assert.match(page, /status: decision === "deny" \? "cancelled" : "completed"/);
  // The waiting line quotes the native request, so a write or a command is
  // never presented as a read, and no text implies the grant already happened.
  assert.match(page, /message: `Waiting for approval: \$\{prompt\.summary/);
  assert.doesNotMatch(page, /Waiting for approval to read/);
});

test("a reloaded turn shows the steps it really ran", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /function storedActivity\(message\) \{/);
  assert.match(page, /if \(message\.role !== "assistant" \|\| !Array\.isArray\(message\.progress\)\) return null;/);
  assert.match(page, /applyProgressRows\(\[\], message\.progress, \{/);
  assert.match(page, /runId: `stored:\$\{message\.messageId \|\| ""\}`/);
  assert.match(page, /const storedProgress = storedActivity\(message\);/);
  assert.match(page, /\.\.\.\(storedProgress \? \{ activity: storedProgress \} : \{\}\)/);

  // The stored log settles a run's open lines; a row the server left running
  // reloads as running rather than being silently marked done.
  const rows = applyProgressRows([], [writeCall], { runId: "stored:m-1", at: 1000 });
  assert.equal(rows[0].id, "stored:m-1:call:call-9");
  assert.equal(rows[0].status, ACTIVITY_STATUS.RUNNING);
});
