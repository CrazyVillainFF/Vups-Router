/**
 * The chat does not repeat itself when a run finishes.
 *
 * A completed run used to add a second thing to the conversation: a generic
 * sentence saying the run had finished, plus a card repeating the completion.
 * When the answer was already on screen that was noise, so it is gone: the
 * answer is the answer, and the card stays only for a run that has not
 * answered, where it is how the answer is found or read again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskRunHasAnswer } from "../src/chat/taskRun.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const chatPage = read("src/ChatPage.jsx");
const taskRun = read("src/chat/taskRun.js");
const taskPanel = read("src/chat/TaskTurnPanel.jsx");

test("there is no generic completion sentence anywhere in the client", () => {
  assert.ok(!/The run finished/.test(taskRun), "the note is gone from the module that made it");
  assert.ok(!/The run finished/.test(chatPage), "and from the chat that used it");
  assert.ok(!/taskAnswerNote/.test(chatPage), "the chat does not use it either");
  assert.ok(!/Its answer is saved in this conversation/.test(taskRun));
});

test("a finished run shows the answer and nothing else", () => {
  const settleStart = chatPage.indexOf("async function settleTaskRun(");
  const settle = chatPage.slice(settleStart, chatPage.indexOf("\n  useEffect(", settleStart));
  assert.match(settle, /content: answer,/);
  assert.ok(!/content: answer \|\|/.test(settle), "there is no fallback sentence behind the answer");
});

test("terminal settlement re-reads the durable answer before fencing the turn", () => {
  const settleStart = chatPage.indexOf("async function settleTaskRun(");
  const settle = chatPage.slice(settleStart, chatPage.indexOf("\n  useEffect(", settleStart));
  const refreshAt = settle.indexOf("record = await refreshTaskRun(run.taskId)");
  const settledAt = settle.indexOf("run.settledState = record.state");
  assert.ok(refreshAt >= 0, "terminal events perform an authoritative task read");
  assert.ok(settledAt > refreshAt, "the turn is not fenced before the answer read succeeds");
  assert.match(settle, /run\.settlingState === record\.state/);
  assert.match(settle, /run\.settlingState = \"\"/);
  assert.match(settle, /record\.state !== \"completed\"/);
  assert.match(settle, /conversationId = String\(record\.conversationId \|\| run\.conversationId \|\| conversationId \|\| \"\"\)/,
    "the authoritative read can supply the conversation binding");
  assert.match(settle, /if \(!answer && conversationId\)/,
    "a terminal task with metadata-only output reconciles the saved conversation");
});

test("active tasks keep an authoritative detail fallback when events are missed", () => {
  assert.match(chatPage, /authoritative detail read alive/);
  assert.match(chatPage, /refreshTaskRun\(taskId\)\.catch\(\(\) => \{\}\)/);
  assert.match(chatPage, /setInterval\(reconcile, 3000\)/);
  assert.match(chatPage, /isOpenTaskState\(view\.state\)/);
  assert.match(chatPage, /import \{ isOpenTaskState, isTerminalTaskState \} from "\.\/services\/taskApi\.js"/);
});

test("a run that answered needs no completion card of its own", () => {
  const panel = chatPage.slice(
    chatPage.indexOf("function taskPanelFor("),
    chatPage.indexOf("function taskPanelFor(") + 900
  );
  assert.match(panel, /taskRunHasAnswer\(view\.task\) && isTerminalTaskState\(view\.state\)/);
  assert.match(panel, /return null;/, "the card is skipped once the answer is on screen");
});

test("a run that has not answered keeps its card, so the answer can be read again", () => {
  assert.equal(taskRunHasAnswer({ output: { text: "An answer." } }), true);
  assert.equal(taskRunHasAnswer({ output: { text: "" } }), false);
  assert.equal(taskRunHasAnswer({ output: {} }), false);
  assert.equal(taskRunHasAnswer(null), false);
  assert.equal(taskRunHasAnswer(undefined), false);
});

test("the card still offers what a reader needs while a run is working", () => {
  assert.match(taskPanel, /className="vr-task-status"/, "the live status line stays");
  assert.match(taskPanel, /plan/, "the plan progress stays");
  assert.match(taskPanel, /Execution details/, "the execution details stay");
  assert.match(taskPanel, /onRefresh/, "the re-read control stays");
  assert.match(taskPanel, /onCancel/, "cancellation stays");
  assert.match(taskPanel, /onResume/, "resuming stays");
});

test("a failed or cancelled run still says so", () => {
  const settleStart = chatPage.indexOf("async function settleTaskRun(");
  const settle = chatPage.slice(settleStart, chatPage.indexOf("\n  useEffect(", settleStart));
  assert.match(settle, /failTurn\(previous, run\.assistantId/, "a failure is still shown");
  assert.match(settle, /cancelTurn\(previous, run\.assistantId, \{ keepEmpty: true \}\)/, "a cancellation is still shown");
});

test("the answer itself is still saved and rendered", () => {
  const settleStart = chatPage.indexOf("async function settleTaskRun(");
  const settle = chatPage.slice(settleStart, chatPage.indexOf("\n  useEffect(", settleStart));
  assert.match(settle, /messageId: record\.output\?\.messageId \|\| record\.assistantMessageId/, "the answer keeps its message id");
  assert.match(settle, /artifact: answer \? artifactFromResponse\(answer\) : undefined/, "the answer keeps its artifact");
  assert.match(chatPage, /restoreTaskTurn/, "a restored conversation still finds the saved answer");
});
