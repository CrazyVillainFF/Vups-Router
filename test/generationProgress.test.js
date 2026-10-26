import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ACTIVITY_STATUS,
  applyActivityProgress,
  settleActivity
} from "../src/chat/activity.js";
import { generationProgress, PROGRESS_FALLBACK_LABEL } from "../src/chat/progress.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function rowsFor(phases) {
  return phases.reduce(
    (rows, phase, index) =>
      applyActivityProgress(rows, { phase }, { runId: "run", at: 1000 + index * 100 }),
    []
  );
}

test("the progress bar follows the real queued, connecting, and generating phases", () => {
  const queued = rowsFor(["request"]);
  assert.equal(
    generationProgress({ events: queued, active: true, startedAt: 1000, now: 1500 }).label,
    "Model request queued"
  );

  const connecting = rowsFor(["request", "waiting"]);
  assert.equal(
    generationProgress({ events: connecting, active: true, startedAt: 1000, now: 2000 }).label,
    "Connecting to model"
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
  assert.equal(progress.label, "Connecting to model");
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
  assert.match(page, /pinned=\{pinned\}/);
  assert.match(page, /const showActivity =\s*!isUser &&\s*\(isStreaming \|\| \(Array\.isArray\(message\.activity\)/);
  assert.doesNotMatch(page, /progressTurn|progressFiles|showProgress/);
  const css = read("src/components/AgentActivity.css");
  assert.match(css, /\.vr-activity--message\s*\{[^}]*margin:\s*0 0 10px/s);
  assert.match(css, /\.vr-activity--message \.vr-activity__thought\s*\{[^}]*max-width:\s*100%/s);
  assert.doesNotMatch(read("src/chat.css"), /\.vr-activity--composer/);
  assert.match(agentSource(), /if \(rows\.length === 0 && !active\) return null/);
  assert.match(agentSource(), /hidden=\{!open\}/);
});

test("downloads stay hidden until a complete artifact is committed", () => {
  const page = read("src/ChatPage.jsx");
  const files = read("src/components/GeneratedFiles.jsx");
  assert.match(page, /artifact && !isStreaming \? <GeneratedFiles artifact=\{artifact\} \/> : null/);
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
