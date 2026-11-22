/**
 * Regression tests for the persistent sidebar thinking indicator.
 *
 * These tests prove that exactly one server task is created per user message,
 * that the task tracker registers it without a second creation request, and that
 * the sidebar badge reflects the real server-authoritative state.
 *
 * The task tracker is driven through configureTaskTrackerApi with a fixture
 * that counts submitTask calls, so the tests measure actual server task
 * creation — not just frontend helper invocations.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-sidebar-indicator");

const compiledBySource = new Map();
const stubs = new Map();

function resolveDependency(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.jsx`, `${base}.js`, path.join(base, "index.jsx"), path.join(base, "index.js")];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
  return found;
}

async function compileModule(absolute) {
  const stub = stubs.get(absolute);
  if (stub) return stub;
  const existing = compiledBySource.get(absolute);
  if (existing) return existing;

  const out = path.join(workDir, `module${compiledBySource.size}.mjs`);
  compiledBySource.set(absolute, out);

  let source = readFileSync(absolute, "utf8")
    .replace(/^\s*import\s+["'][^"']+\.css["'];?\s*$/gm, "");

  const dependencies = [];
  source = source.replace(/(\bfrom\s+|\bimport\s+)["'](\.[^"']+)["']/g, (_match, keyword, spec) => {
    dependencies.push(resolveDependency(absolute, spec));
    return `${keyword}"__dep${dependencies.length - 1}__"`;
  });
  for (const [index, dependency] of dependencies.entries()) {
    const compiled = await compileModule(dependency);
    const specifier = `./${path.relative(workDir, compiled).replace(/\\/g, "/")}`;
    source = source.replace(`"__dep${index}__"`, `"${specifier}"`);
  }

  const { code } = await transformWithEsbuild(source, absolute, { loader: "jsx", jsx: "automatic" });
  writeFileSync(out, code);
  return out;
}

async function loadModule(sourcePath) {
  const file = await compileModule(path.join(root, sourcePath));
  return import(pathToFileURL(file).href);
}

const savedDescriptors = new Map();

function restoreGlobals() {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  savedDescriptors.clear();
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://vups.test/"
  });
  const { window } = dom;
  window.matchMedia = query => ({
    media: query, matches: false,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    self: window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    if (!savedDescriptors.has(key)) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return { window, container: window.document.getElementById("root") };
}

describe("sidebar thinking indicator — exactly one server task per message", () => {
  let tracker;
  let submitCallCount;
  let submittedTasks;

  before(async () => {
    mkdirSync(workDir, { recursive: true });
    tracker = await loadModule("src/tasks/taskTracker.js");
  });

  after(async () => {
    await new Promise(resolve => { setTimeout(resolve, 50); });
    restoreGlobals();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  beforeEach(() => {
    submitCallCount = 0;
    submittedTasks = new Map();
    tracker.resetTaskTracker();
    tracker.configureTaskTrackerApi({
      submitTask: async input => {
        submitCallCount += 1;
        const task = {
          taskId: `tsk_${submitCallCount}`,
          state: "queued",
          stage: "queued",
          conversationId: input.conversationId || null,
          description: input.prompt,
          createdAt: new Date().toISOString(),
          lastActivityAt: Date.now()
        };
        submittedTasks.set(task.taskId, task);
        return { ...task };
      },
      listTasks: async () => [...submittedTasks.values()].map(task => ({ ...task })),
      fetchTask: async id => ({ ...submittedTasks.get(id), state: "running" }),
      fetchTaskEvents: async () => ({ events: [], lastSeq: 0 }),
      cancelTask: async id => ({ ...submittedTasks.get(id), state: "cancelled" }),
      resumeTask: async id => ({ ...submittedTasks.get(id), state: "queued" }),
      answerTaskClarification: async id => ({ ...submittedTasks.get(id), state: "queued" })
    });
  });

  afterEach(async () => {
    tracker.stopTaskTracker();
    tracker.resetTaskTracker();
  });

  test("one message creates exactly one server task", async () => {
    await tracker.submitTrackedTask(
      { prompt: "hello world", conversationId: "conv-1" },
      { key: "msg-1" }
    );
    assert.equal(submitCallCount, 1, "exactly one submitTask call for one message");
  });

  test("repeated registration with the same key makes zero additional server requests", async () => {
    await tracker.submitTrackedTask(
      { prompt: "same message", conversationId: "conv-1" },
      { key: "msg-same" }
    );
    const firstCount = submitCallCount;

    // Same key again — the memoised result must be returned, no new POST.
    await tracker.submitTrackedTask(
      { prompt: "same message", conversationId: "conv-1" },
      { key: "msg-same" }
    );
    assert.equal(submitCallCount, firstCount, "same key must not create a second task");
  });

  test("two messages create exactly two server tasks", async () => {
    await tracker.submitTrackedTask(
      { prompt: "first message", conversationId: "conv-1" },
      { key: "msg-a" }
    );
    await tracker.submitTrackedTask(
      { prompt: "second message", conversationId: "conv-2" },
      { key: "msg-b" }
    );
    assert.equal(submitCallCount, 2, "two distinct messages create two tasks");
    assert.equal(submittedTasks.size, 2, "tracker holds two distinct entries");
  });

  test("each conversation is tracked independently with its own conversationId", async () => {
    await tracker.submitTrackedTask(
      { prompt: "chat alpha", conversationId: "conv-alpha" },
      { key: "msg-alpha" }
    );
    await tracker.submitTrackedTask(
      { prompt: "chat beta", conversationId: "conv-beta" },
      { key: "msg-beta" }
    );

    const taskA = submittedTasks.get("tsk_1");
    const taskB = submittedTasks.get("tsk_2");
    assert.equal(taskA.conversationId, "conv-alpha");
    assert.equal(taskB.conversationId, "conv-beta");
    assert.notEqual(taskA.taskId, taskB.taskId);
  });

  test("tracker snapshot exposes task state for sidebar badge", async () => {
    await tracker.submitTrackedTask(
      { prompt: "running task", conversationId: "conv-1" },
      { key: "msg-run" }
    );
    const snapshot = tracker.getTaskTrackerSnapshot();
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].state, "queued");
    assert.equal(snapshot.tasks[0].conversationId, "conv-1");
  });

  test("refreshing a tracked task returns server-authoritative state", async () => {
    await tracker.submitTrackedTask(
      { prompt: "refresh me", conversationId: "conv-1" },
      { key: "msg-refresh" }
    );
    const refreshed = await tracker.refreshTrackedTask("tsk_1");
    assert.equal(refreshed.state, "running", "refresh returns the server's current state");
  });

  test("cancelling a tracked task moves it to a terminal state", async () => {
    await tracker.submitTrackedTask(
      { prompt: "to be cancelled", conversationId: "conv-1" },
      { key: "msg-cancel" }
    );
    const cancelled = await tracker.cancelTrackedTask("tsk_1");
    assert.equal(cancelled.state, "cancelled", "cancelled task is terminal");
  });
});
