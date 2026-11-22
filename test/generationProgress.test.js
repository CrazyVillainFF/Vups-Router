import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVITY_STATUS,
  applyActivityProgress,
  applyProgressRows,
  groupActivityRows,
  settleActivity,
  UNREPORTED_APPROVAL_LABEL
} from "../src/chat/activity.js";
import {
  generationProgress,
  pathBaseName,
  progressBrief,
  PROGRESS_FALLBACK_LABEL
} from "../src/chat/progress.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function rowsFor(phases) {
  return phases.reduce(
    (rows, phase, index) =>
      applyActivityProgress(rows, { phase }, { runId: "run", at: 1000 + index * 100 }),
    []
  );
}

test("the progress bar follows the real waiting and generating phases", () => {
  const queued = rowsFor(["request"]);
  assert.equal(
    generationProgress({ events: queued, active: true, startedAt: 1000, now: 1500 }).label,
    "Waiting for model"
  );

  const connecting = rowsFor(["request", "waiting"]);
  assert.equal(
    generationProgress({ events: connecting, active: true, startedAt: 1000, now: 2000 }).label,
    "Waiting for model"
  );

  const generating = rowsFor(["request", "waiting", "responding"]);
  assert.equal(
    generationProgress({ events: generating, active: true, startedAt: 1000, now: 9000 }).label,
    "Generating response"
  );

  const code = rowsFor(["request", "waiting", "generating_code"]);
  assert.equal(
    generationProgress({ events: code, active: true, startedAt: 1000, now: 5000 }).label,
    "Generating code"
  );
});

test("a finished, failed, or cancelled turn removes the active bar", () => {
  for (const status of [ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.FAILED, ACTIVITY_STATUS.CANCELLED]) {
    const rows = settleActivity(rowsFor(["request", "responding"]), status, 9000);
    assert.equal(
      generationProgress({ events: rows, active: false, startedAt: 1000, now: 9000 }),
      null,
      `${status} must not keep a spinner`
    );
  }
  assert.equal(generationProgress({ active: false }), null);
});

test("missing progress metadata produces one honest label and no invented values", () => {
  const progress = generationProgress({ events: [], files: [], active: true });
  assert.equal(progress.label, PROGRESS_FALLBACK_LABEL);
  assert.equal(progress.detail, "");
  assert.equal(progress.elapsed, "");
  assert.equal(progress.steps, 0);
  assert.equal("estimate" in progress, false);
  assert.equal("tokens" in progress, false);
  assert.equal("total" in progress, false);
});

test("elapsed time uses only the real turn start", () => {
  const events = rowsFor(["request"]);
  assert.equal(generationProgress({ events, active: true, startedAt: 1000, now: 13500 }).elapsed, "12s");
  assert.equal(generationProgress({ events, active: true, now: 13500 }).elapsed, "");
  assert.equal(generationProgress({ events, active: true, startedAt: 5000, now: 4000 }).elapsed, "");
});

test("multi-file progress counts the files the stream actually produced", () => {
  const files = [
    { path: "index.html", content: "<h1>Hi</h1>" },
    { path: "style.css", content: "body { margin: 0; }" },
    { path: "app.js", content: "const ready = " , complete: false }
  ];
  const progress = generationProgress({
    events: rowsFor(["generating_code"]),
    files,
    active: true,
    startedAt: 1000,
    now: 3000
  });
  assert.equal(progress.detail, "2 / 3 files");
  assert.equal(progress.steps > 0, true);
});

test("a reported current file is named in the status even before the file list is known", () => {
  const rows = applyActivityProgress(
    rowsFor(["request", "waiting"]),
    { phase: "generating_file", message: "Generating src/components/Canvas.jsx…" },
    { runId: "run", at: 5000 }
  );
  const progress = generationProgress({ events: rows, files: [], active: true, startedAt: 1000, now: 6000 });
  assert.equal(progress.label, "Writing Canvas.jsx");
  assert.equal(progress.detail, "");
});

test("only the newest running operation is reported, so repeats cannot duplicate it", () => {
  let rows = rowsFor(["request"]);
  rows = applyActivityProgress(rows, { phase: "waiting" }, { runId: "run", at: 2000 });
  const repeated = applyActivityProgress(rows, { phase: "waiting" }, { runId: "run", at: 2500 });
  assert.equal(repeated, rows);
  const progress = generationProgress({ events: repeated, active: true, startedAt: 1000, now: 3000 });
  assert.equal(progress.label, "Waiting for model");
  assert.equal(progress.steps, 2);
});

test("the bar is one compact line and truncates long labels instead of wrapping", () => {
  const agent = read("src/components/AgentActivity.jsx");
  const css = read("src/components/AgentActivity.css");
  assert.match(agent, /generationProgress/);
  assert.match(agent, /<ThoughtLine/);
  assert.match(agent, /label=\{stateLabel\}/);
  assert.match(css, /\.vr-activity\[data-active\] \.vr-activity__head\s*\{[^}]*min-height:\s*30px/s);
  assert.match(css, /\.vr-activity__head\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.vr-activity__thought\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.vr-activity__meta\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*?\.vr-activity__meta[\s\S]*?display:\s*none/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*?\.vr-activity__count[\s\S]*?display:\s*none/);
  assert.match(css, /\.vr-activity__spin\s*\{[^}]*animation/s);
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.vr-activity__spin\s*\{[^}]*animation:\s*none/s);
  assert.doesNotMatch(agent, /Step \d|Estimated|estimated|token count|\+800/);
});

test("the thinking line rises with the assistant message instead of the composer", () => {
  const page = read("src/ChatPage.jsx");
  assert.equal(page.match(/<AgentActivity/g)?.length, 1, "one activity component in the source");
  const footer = page.indexOf('<footer className="vr-composer"');
  assert.ok(footer > 0);
  assert.equal(page.slice(footer).includes("<AgentActivity"), false, "the composer holds no second indicator");
  const activity = page.indexOf("<AgentActivity");
  const answer = page.indexOf("vr-msg-md", activity);
  assert.ok(activity > 0 && answer > activity, "thinking renders above the assistant answer");
  assert.match(page, /className="vr-activity--message"/);
  assert.match(page, /events=\{message\.activity \|\| \[\]\}/);
  assert.match(page, /files=\{activityFiles\}/);
  assert.match(page, /active=\{isStreaming\}/);
  assert.match(page, /const showActivity =\s*!isUser &&\s*\(isStreaming \|\| \(Array\.isArray\(message\.activity\)/);
  assert.doesNotMatch(page, /progressTurn|progressFiles|showProgress/);
  const css = read("src/components/AgentActivity.css");
  assert.match(css, /\.vr-activity--message\s*\{[^}]*margin:\s*0 0 10px/s);
  assert.match(css, /\.vr-activity--message \.vr-activity__thought\s*\{[^}]*max-width:\s*100%/s);
  assert.doesNotMatch(read("src/chat.css"), /\.vr-activity--composer/);
  assert.match(agentSource(), /if \(rows\.length === 0 && !active\) return null/);
  assert.match(agentSource(), /className="vr-activity__trace"/);
});

test("downloads stay hidden until a complete artifact is committed", () => {
  const page = read("src/ChatPage.jsx");
  const files = read("src/components/GeneratedFiles.jsx");
  assert.match(page, /artifact && !isStreaming \? \(/);
  // A Windows local answer saves into its project; only an explicit download
  // request keeps the download rows, and every other shell still gets them.
  assert.match(page, /nativeWindows && \(message\.local \|\| message\.localPlan\) \?/);
  assert.match(page, /wantsDownloadDelivery\(prompt\) \? <GeneratedFiles artifact=\{artifact\} \/> : null/);
  assert.match(page, /<ProjectSaveCard/);
  assert.match(files, /const hasIncomplete = artifact\?\.status !== "complete" \|\| files\.some\(file => file\.complete === false\)/);
  assert.match(files, /const actionsReady = !hasIncomplete/);
  assert.match(files, /\{actionsReady \? \(/);
  assert.match(files, /\{actionsReady && file\.complete !== false \? \(/);
  assert.match(files, /aria-label=\{actionsReady \? "Generated files" : "Partial generated files"\}/);
  assert.match(files, /if \(file\?\.complete === false\) return;/);
  assert.doesNotMatch(files, /Available when generation finishes|streaming prop|streaming = false/);
  const css = read("src/components/GeneratedFiles.css");
  assert.match(css, /\.vr-files__download:disabled/);
});

function agentSource() {
  return read("src/components/AgentActivity.jsx");
}

// ─── The continuous 3-4 line brief (PART 2) ─────────────────────────────────

function liveRows(events) {
  return applyProgressRows([], events, { runId: "run-1", at: 1000 });
}

test("the brief states the request, the bound folder, the real access and the open step", () => {
  const rows = liveRows([
    {
      key: "task",
      phase: "task",
      status: "running",
      path: "C:\\project\\demo",
      label: "Working folder",
      message: "Working in C:\\project\\demo"
    },
    {
      callId: "call-1",
      phase: "tool",
      status: "running",
      tool: "write_file",
      path: "C:\\project\\demo\\index.html",
      label: "Writing a local file",
      message: "write_file C:\\project\\demo\\index.html"
    }
  ]);
  assert.deepEqual(
    progressBrief({
      requestText: "Create   a landing\npage for my shop",
      workspacePath: "C:\\project\\demo",
      permissionLabel: "Ask every time",
      events: rows
    }).map(line => line.text),
    [
      "You asked: Create a landing page for my shop",
      "Working folder: C:\\project\\demo",
      "Local access: Ask every time",
      "Writing a local file — index.html"
    ]
  );
});

test("a missing source drops its line instead of guessing one", () => {
  // No folder is bound, so the brief says that out loud rather than naming one.
  assert.deepEqual(progressBrief({ events: [] }).map(line => line.text), [
    "Working folder: none bound for this chat"
  ]);
  // A browser session has no local access to report, so no access line appears.
  assert.equal(
    progressBrief({ workspacePath: "C:\\project\\demo", events: [] }).some(line =>
      /Local access/i.test(line.text)
    ),
    false
  );
  // With nothing running, the line names the last thing that really finished,
  // and says so on its own end rather than pretending it is still open.
  const settled = settleActivity(
    liveRows([
      {
        callId: "c",
        phase: "tool",
        status: "running",
        tool: "read_file",
        label: "Reading a local file",
        message: "read_file"
      }
    ]),
    ACTIVITY_STATUS.FAILED,
    2000
  );
  assert.deepEqual(progressBrief({ events: settled }).map(line => line.text), [
    "Working folder: none bound for this chat",
    "Reading a local file — failed"
  ]);
});

test("the brief quotes the request short and reads either path separator", () => {
  const brief = progressBrief({ requestText: "x".repeat(200), events: [] });
  assert.equal(brief[0].text.length, "You asked: ".length + 110);
  assert.match(brief[0].text, /…$/);
  assert.equal(pathBaseName("C:\\project\\Vups Router\\client\\src\\ChatPage.jsx"), "ChatPage.jsx");
  assert.equal(pathBaseName("src/components/AgentActivity.jsx"), "AgentActivity.jsx");
  assert.equal(pathBaseName(""), "");
});

test("no brief line is filler, a percentage or an estimate", () => {
  const rows = liveRows([
    { key: "task", phase: "task", status: "running", label: "Starting the task", message: "Starting the task" },
    { key: "provider:0", phase: "provider", status: "running", message: "Asking the model what to do next" }
  ]);
  const text = progressBrief({
    requestText: "hi",
    workspacePath: "C:\\work",
    permissionLabel: "Read-only",
    events: rows
  })
    .map(line => line.text)
    .join("\n");
  assert.doesNotMatch(text, /Working\.\.\.|Almost done|Processing|Please wait|up to you shortly/i);
  assert.doesNotMatch(text, /\d+ ?%|~\s*\d|estimat/i);
  assert.match(text, /Asking the model what to do next/);
});

test("the brief is painted live above the steps and only on a turn in flight", () => {
  const agent = read("src/components/AgentActivity.jsx");
  const css = read("src/components/AgentActivity.css");
  assert.match(
    agent,
    /active\s*\?\s*progressBrief\(\{ requestText, workspacePath, permissionLabel, events \}\)/
  );
  assert.match(agent, /className="vr-activity__brief" aria-live="polite"/);
  assert.ok(
    agent.indexOf("vr-activity__brief") < agent.indexOf("vr-activity__trace"),
    "the brief sits above the fold of steps"
  );
  assert.match(css, /\.vr-activity__brief\s*\{[^}]*list-style:\s*none/s);
  assert.match(css, /\.vr-activity__brief-line\s*\{[^}]*text-overflow:\s*ellipsis/s);
  // The three sources are the real ones: the user message that opened the turn,
  // the folder bound to this chat, and the access mode the app is running under.
  const page = read("src/ChatPage.jsx");
  assert.match(page, /requestText=\{prompt\}/);
  assert.match(page, /workspacePath=\{workspacePath\}/);
  assert.match(page, /permissionLabel=\{permissionLabel\}/);
  assert.match(page, /workspacePath=\{chatWorkspace\?\.path \|\| ""\}/);
});

// ─── The chronological timeline (PART 3) ────────────────────────────────────

test("only a run of tool calls groups, and anything between them stays visible", () => {
  const rows = [
    { id: "1", phase: "task", status: "running" },
    { id: "2", phase: "tool", status: "running" },
    { id: "3", phase: "tool", status: "completed" },
    { id: "4", phase: "command", status: "failed" },
    { id: "5", phase: "model", status: "completed" },
    { id: "6", phase: "tool", status: "running" },
    { id: "7", phase: "approval", status: "running" }
  ];
  assert.deepEqual(
    groupActivityRows(rows).map(group => [group.kind, group.rows.map(row => row.id)]),
    [
      ["row", ["1"]],
      // The command line is the reason the two calls above it are not folded
      // into a later group: it is a fact of its own, in the middle.
      ["tools", ["2", "3"]],
      ["row", ["4"]],
      ["row", ["5"]],
      ["tools", ["6"]],
      ["row", ["7"]]
    ]
  );
  assert.deepEqual(groupActivityRows([]), []);
  assert.deepEqual(groupActivityRows(null), []);
});

test("a round of several calls is one line, and a later round adds to the history", () => {
  const open = liveRows([
    {
      key: "task",
      phase: "task",
      status: "running",
      path: "C:\\work",
      label: "Working folder",
      message: "Working in C:\\work"
    },
    { callId: "a", phase: "tool", status: "running", tool: "read_file", path: "C:\\work\\a.ts", label: "Reading a local file", message: "read_file" },
    { callId: "b", phase: "tool", status: "running", tool: "read_file", path: "C:\\work\\b.ts", label: "Reading a local file", message: "read_file" },
    { callId: "c", phase: "tool", status: "running", tool: "write_file", path: "C:\\work\\c.ts", label: "Writing a local file", message: "write_file" }
  ]);
  assert.deepEqual(progressBrief({ workspacePath: "C:\\work", events: open }).map(line => line.text), [
    "Working folder: C:\\work",
    "Running 3 tools"
  ]);

  // The next round must extend the timeline, never replace what it showed.
  const next = applyProgressRows(
    settleActivity(open, ACTIVITY_STATUS.COMPLETED, 2000),
    [
      { key: "provider:1", phase: "provider", status: "running", message: "Asking the model what to do next" },
      { callId: "d", phase: "tool", status: "running", tool: "run_command", label: "Running a command", message: "run_command" },
      { callId: "e", phase: "tool", status: "running", tool: "list_directory", path: "C:\\work\\src", label: "Listing a local folder", message: "list_directory" }
    ],
    { runId: "run-1", at: 2100 }
  );
  assert.deepEqual(progressBrief({ workspacePath: "C:\\work", events: next }).map(line => line.text), [
    "Working folder: C:\\work",
    "Ran 3 tools",
    "Asking the model what to do next",
    "Running 2 tools"
  ]);
});

test("a command's real result is its own line under the call that ran it", () => {
  const rows = applyProgressRows(
    liveRows([
      { callId: "cmd", phase: "tool", status: "running", tool: "run_command", label: "Running a command", message: "run_command" }
    ]),
    [
      { callId: "cmd", phase: "tool", status: "completed", tool: "run_command", label: "Running a command", message: "run_command completed" },
      {
        callId: "cmd",
        phase: "command",
        status: "failed",
        tool: "run_command",
        code: "exit:1",
        message: "Tests failed: 3 of 716 (713 passed, exit 1)."
      }
    ],
    { runId: "run-1", at: 3000 }
  );
  assert.equal(rows.length, 2, "the call and the process outcome are two facts, not two copies");
  const brief = progressBrief({ events: rows });
  assert.deepEqual(brief.map(line => line.text), [
    "Working folder: none bound for this chat",
    "Running a command",
    "Tests failed: 3 of 716 (713 passed, exit 1)."
  ]);
  assert.equal(brief.at(-1).kind, "result");
  assert.equal(brief.at(-1).status, "failed");

  // A row that only passed is told apart from one that never ran the suite.
  const green = applyProgressRows([], [
    {
      callId: "cmd2",
      phase: "command",
      status: "completed",
      tool: "run_command",
      code: "exit:0",
      message: "Tests passed: 716 of 716 (exit 0)."
    }
  ], { runId: "run-1", at: 4000 });
  assert.equal(progressBrief({ events: green }).at(-1).text, "Tests passed: 716 of 716 (exit 0).");
});

test("the model's own sentence is a line, where it really was said", () => {
  const rows = applyProgressRows(
    liveRows([
      { callId: "n1", phase: "tool", status: "running", tool: "edit_file", path: "C:\\work\\a.ts", label: "Editing a local file", message: "edit_file" }
    ]),
    [
      { key: "model:2", phase: "model", status: "completed", message: "The implementation is complete. I am now running the backend regression tests." }
    ],
    { runId: "run-1", at: 2500 }
  );
  const brief = progressBrief({ workspacePath: "C:\\work", events: rows });
  assert.deepEqual(brief.map(line => line.text), [
    "Working folder: C:\\work",
    "Editing a local file — a.ts",
    "The implementation is complete. I am now running the backend regression tests."
  ]);
  assert.equal(brief.at(-1).kind, "narration");

  // The server owns that wording — its first sentence, never a code block and
  // never a credential — and its own suite pins it there. Here the client only
  // ever renders the line it was handed.
  const activity = read("src/chat/activity.js");
  assert.match(activity, /label: cleanProgress\(event\.label\)\.slice\(0, 80\) \|\| message\.slice\(0, 80\)/);
});

test("a round that grows keeps its line and the brief holds only the newest steps", () => {
  const one = progressBrief({
    workspacePath: "C:\\work",
    events: liveRows([
      { callId: "x", phase: "tool", status: "running", tool: "read_file", label: "Reading a local file", message: "read_file" }
    ])
  });
  const two = progressBrief({
    workspacePath: "C:\\work",
    events: liveRows([
      { callId: "x", phase: "tool", status: "running", tool: "read_file", label: "Reading a local file", message: "read_file" },
      { callId: "y", phase: "tool", status: "running", tool: "read_file", label: "Reading a local file", message: "read_file" }
    ])
  });
  assert.equal(one.at(-1).id, two.at(-1).id, "one line updated, not a second one mounted");
  assert.equal(two.at(-1).text, "Running 2 tools");

  const many = liveRows(
    Array.from({ length: 8 }, (_, index) => ({
      key: `provider:${index}`,
      phase: "provider",
      status: "completed",
      message: `Asking the model what to do next ${index}`
    }))
  );
  const brief = progressBrief({ workspacePath: "C:\\work", events: many });
  assert.equal(brief.length, 6, "the context line plus the five newest steps");
  assert.equal(brief.at(1).text, "Asking the model what to do next 3");
  assert.equal(brief.at(-1).text, "Asking the model what to do next 7");
});

test("a failed or stopped call is never drawn as work that finished", () => {
  const rows = applyProgressRows(
    liveRows([
      { callId: "s1", phase: "tool", status: "running", tool: "write_file", path: "C:\\work\\a.txt", label: "Writing a local file", message: "write_file" },
      { callId: "s2", phase: "tool", status: "running", tool: "copy_path", label: "Copying a local item", message: "copy_path" }
    ]),
    [
      { callId: "s1", phase: "tool", status: "failed", tool: "write_file", path: "C:\\work\\a.txt", code: "access_denied", label: "Writing a local file", message: "write_file failed: access_denied" },
      { callId: "s2", phase: "tool", status: "cancelled", tool: "copy_path", label: "Copying a local item", message: "copy_path cancelled" }
    ],
    { runId: "run-1", at: 5000 }
  );
  const line = progressBrief({ workspacePath: "C:\\work", events: rows }).at(-1);
  assert.equal(line.text, "Ran 2 tools · 1 failed, 1 stopped");
  assert.equal(line.status, ACTIVITY_STATUS.FAILED);

  // A single call states its own ending rather than a count of one.
  const solo = settleActivity(
    liveRows([
      { callId: "only", phase: "tool", status: "running", tool: "delete_path", path: "C:\\work\\a.txt", label: "Deleting a local item", message: "delete_path" }
    ]),
    ACTIVITY_STATUS.CANCELLED,
    6000
  );
  assert.equal(progressBrief({ workspacePath: "C:\\work", events: solo }).at(-1).text, "Deleting a local item — a.txt — stopped");
});

test("an approval wait is one line that the real decision settles", () => {
  const asked = liveRows([
    {
      key: "approval:r1",
      phase: "approval",
      status: "running",
      label: "Waiting for approval",
      path: "C:\\work\\a.txt",
      message: "Waiting for approval: write to C:\\work\\a.txt"
    }
  ]);
  assert.equal(progressBrief({ events: asked }).at(-1).text, "Waiting for approval — a.txt");

  const granted = applyProgressRows(
    asked,
    [{ key: "approval:r1", phase: "approval", status: "completed", label: "Approval granted", path: "C:\\work\\a.txt", message: "Access granted — resuming the local operation" }],
    { runId: "run-1", at: 4000 }
  );
  assert.equal(granted.length, 1, "the decision settles the wait instead of opening a second line");
  assert.equal(progressBrief({ events: granted }).at(-1).text, "Approval granted — a.txt");

  const declined = applyProgressRows(
    asked,
    [{ key: "approval:r1", phase: "approval", status: "cancelled", label: "Approval declined", path: "C:\\work\\a.txt", message: "Denied — the blocked file operation was cancelled" }],
    { runId: "run-1", at: 4000 }
  );
  const line = progressBrief({ events: declined }).at(-1);
  assert.equal(line.text, "Approval declined — a.txt");
  assert.equal(line.status, ACTIVITY_STATUS.CANCELLED);
});

test("a turn that ends with a permission wait open says the wait was never answered", () => {
  const open = applyProgressRows(
    [],
    [
      { key: "tool:1", phase: "tool", status: "running", tool: "write_file", path: "C:\\work\\a.txt", message: "write_file" },
      { key: "approval:r1", phase: "approval", status: "running", message: "Waiting for approval." }
    ],
    { runId: "run-1", at: 1000 }
  );

  // The turn finished and the app never reported what became of that card. The
  // line cannot inherit the turn's own outcome: nothing was granted, so nothing
  // ran, and "completed" would read as a step that succeeded.
  for (const status of [ACTIVITY_STATUS.COMPLETED, ACTIVITY_STATUS.FAILED, ACTIVITY_STATUS.CANCELLED]) {
    const closed = settleActivity(open, status, 5000);
    const approval = closed.find(row => row.phase === "approval");
    assert.equal(approval.status, ACTIVITY_STATUS.CANCELLED, `${status} does not decide how a wait ended`);
    assert.equal(approval.label, "The approval wait ended without a reported decision");
    assert.equal(closed.find(row => row.phase === "tool").status, status, "the call's own row still follows the turn");
    assert.equal(
      progressBrief({ events: closed }).find(l => l.text.startsWith("The approval wait")).status,
      ACTIVITY_STATUS.CANCELLED
    );
  }

  // The backend closes the same row in its stored log with the same words, so
  // the line a reader watched is the line a reload replays.
  assert.equal(
    UNREPORTED_APPROVAL_LABEL,
    "The approval wait ended without a reported decision"
  );
  assert.match(read("src/chat/approvalEvents.js"), /message: "Waiting for approval\."/);

  // An answered wait is never re-opened by a later replay of the same log.
  const answered = applyProgressRows(
    settleActivity(open, ACTIVITY_STATUS.COMPLETED, 5000),
    [{ key: "approval:r1", phase: "approval", status: "completed", message: "Approval granted." }],
    { runId: "run-1", at: 6000 }
  );
  assert.equal(answered.length, 2, "the decision belongs to the wait's own line");
  assert.equal(answered.find(row => row.phase === "approval").status, ACTIVITY_STATUS.COMPLETED);
});

test("only a tool row is renamed from its tool, so a result sentence survives", () => {
  // A command row carries the same tool name to say which process ran; if the
  // app relabelled it, "Tests failed: 3 of 716" would read "Running a command".
  const service = read("src/services/desktopChat.js");
  const body = service.slice(
    service.indexOf("function progressRowLabel"),
    service.indexOf("/**", service.indexOf("function progressRowLabel"))
  );
  assert.match(body, /if \(event\?\.phase === "tool" && event\?\.tool\) return desktopToolLabel\(event\.tool\);/);
  assert.ok(
    body.indexOf('phase === "skill"') < body.indexOf("event?.tool"),
    "a skill row is still left with its own sentence"
  );

  const agent = read("src/components/AgentActivity.jsx");
  const css = read("src/components/AgentActivity.css");
  assert.match(
    agent,
    /className="vr-activity__brief-line" data-kind=\{line\.kind\} data-status=\{line\.status \|\| undefined\}/
  );
  assert.match(css, /\.vr-activity__brief-line\[data-kind="narration"\]\s*\{[^}]*--font-sans/s);
  assert.match(css, /\.vr-activity__brief-line\[data-kind="result"\]\s*\{[^}]*color:\s*var\(--text\)/s);
  assert.match(css, /\.vr-activity__brief-line\[data-status="failed"\]\s*\{[^}]*color:\s*var\(--error\)/s);
  assert.match(css, /\.vr-activity__brief-line\[data-status="cancelled"\]\s*\{[^}]*color:\s*var\(--muted-soft\)/s);

  const activity = read("src/chat/activity.js");
  assert.match(activity, /export function groupActivityRows\(rows = \[\]\)/);
  assert.match(read("src/chat/progress.js"), /groupActivityRows\(list\)\.map\(timelineLine\)/);
});
