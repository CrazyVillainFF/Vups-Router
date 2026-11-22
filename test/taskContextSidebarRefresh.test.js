import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-task-context");

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

// The conversation list the server would return, and how often it was asked for.
const server = { conversations: [], listCalls: 0 };

describe("TaskProvider keeps the sidebar in step with submitted tasks", () => {
  let TaskProvider;
  let useTasks;
  let tracker;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];
  let seen = [];

  before(async () => {
    mkdirSync(workDir, { recursive: true });

    // TaskContext reads the conversation list through services/api.js. Replace
    // that one module with a fixture so the test measures the provider's
    // behaviour rather than axios, and leave every other module real.
    const apiStub = path.join(workDir, "api-stub.mjs");
    writeFileSync(apiStub, `
      export const server = { conversations: [], listCalls: 0 };
      export async function listConversations() {
        server.listCalls += 1;
        return server.conversations.map(entry => ({ ...entry }));
      }
      export async function fetchUsage() { return null; }
      export async function getConversation() { return null; }
      export async function deleteConversation() { return { ok: true }; }
      export async function renameConversation(id, title) { return { id, title }; }
      // taskApi.js imports these at module load. The tracker is driven through
      // configureTaskTrackerApi below, so neither is ever called here.
      export const apiClient = { get: async () => ({ data: {} }), post: async () => ({ data: {} }) };
      export function getApiErrorCode(error) { return error?.code || ""; }
    `);
    stubs.set(path.join(root, "src/services/api.js"), apiStub);

    // The workspace owner comes from the app-shell provider, which would pull
    // the authentication graph into this fixture. Only the owner is read here.
    const workspaceStub = path.join(workDir, "workspace-stub.mjs");
    writeFileSync(workspaceStub, 'export function useWorkspaces() { return { owner: "" }; }\n');
    stubs.set(path.join(root, "src/desktop/WorkspaceContext.jsx"), workspaceStub);

    const context = await loadModule("src/desktop/TaskContext.jsx");
    TaskProvider = context.TaskProvider;
    useTasks = context.useTasks;
    tracker = await loadModule("src/tasks/taskTracker.js");
    const apiModule = await import(pathToFileURL(apiStub).href);
    server.conversations = apiModule.server.conversations;
    Object.defineProperty(server, "listCalls", {
      get: () => apiModule.server.listCalls,
      set: value => { apiModule.server.listCalls = value; }
    });

    React = await import("react");
    ReactDOMClient = await import("react-dom/client");
  });

  after(async () => {
    await new Promise(resolve => { setTimeout(resolve, 50); });
    restoreGlobals();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  beforeEach(() => {
    dom = installDom();
    trees = [];
    seen = [];
    server.conversations.length = 0;
    server.listCalls = 0;
    tracker.resetTaskTracker();
    const submitted = new Map();
    tracker.configureTaskTrackerApi({
      submitTask: async input => {
        const task = {
          taskId: `tsk_${input.prompt}`,
          state: "queued",
          stage: "queued",
          conversationId: input.conversationId || null,
          description: input.prompt,
          createdAt: new Date().toISOString(),
          lastActivityAt: Date.now()
        };
        submitted.set(task.taskId, task);
        return { ...task };
      },
      listTasks: async () => [...submitted.values()].map(task => ({ ...task })),
      fetchTask: async id => ({ ...submitted.get(id), state: "running" }),
      fetchTaskEvents: async () => ({ events: [], lastSeq: 0 }),
      cancelTask: async id => ({ ...submitted.get(id), state: "cancelled" }),
      resumeTask: async id => ({ ...submitted.get(id), state: "queued" }),
      answerTaskClarification: async id => ({ ...submitted.get(id), state: "queued" })
    });
  });

  afterEach(async () => {
    await React.act(async () => {
      for (const entry of trees) {
        if (entry.disposed) continue;
        entry.disposed = true;
        entry.root.unmount();
      }
    });
    trees = [];
    tracker.stopTaskTracker();
    tracker.resetTaskTracker();
  });

  function Probe() {
    const { tasks } = useTasks();
    seen.push(tasks.map(task => task.id));
    return null;
  }

  function render() {
    const handle = ReactDOMClient.createRoot(dom.container);
    const entry = { root: handle, disposed: false };
    trees.push(entry);
    React.act(() => {
      handle.render(React.createElement(TaskProvider, null, React.createElement(Probe)));
    });
    return entry;
  }

  const flush = async () => {
    await React.act(async () => {
      await new Promise(resolve => { setTimeout(resolve, 0); });
    });
  };

  const lastSeen = () => seen[seen.length - 1] || [];

  test("a task submitted in the mounted shell puts its conversation in the sidebar", async () => {
    render();
    await flush();
    assert.deepEqual(lastSeen(), [], "the account starts with no conversations");
    const afterMount = server.listCalls;

    // The server has saved the conversation and the user message before it
    // answers the submit, which is what the 202 contract guarantees.
    server.conversations.push({
      id: "conv-1",
      title: "Keep running while I leave this chat",
      updatedAt: new Date().toISOString(),
      task: { taskId: "tsk_keep", state: "queued", done: false }
    });

    await React.act(async () => {
      await tracker.submitTrackedTask(
        { prompt: "keep", conversationId: "conv-1" },
        { key: "submit-keep" }
      );
    });
    await flush();

    assert.ok(
      server.listCalls > afterMount,
      "the provider must re-read the conversation list when a task is submitted"
    );
    assert.ok(
      lastSeen().includes("conv-1"),
      `the new conversation must be in the sidebar without a remount (saw ${JSON.stringify(lastSeen())})`
    );
  });

  test("further updates to the same task do not re-read the list", async () => {
    server.conversations.push({ id: "conv-1", title: "Keep", updatedAt: new Date().toISOString() });
    render();
    await flush();

    await React.act(async () => {
      await tracker.submitTrackedTask({ prompt: "keep", conversationId: "conv-1" }, { key: "submit-keep" });
    });
    await flush();
    const settled = server.listCalls;

    await React.act(async () => {
      await tracker.refreshTrackedTask("tsk_keep");
    });
    await flush();

    assert.equal(server.listCalls, settled, "a known conversation must not trigger another list read");
    assert.ok(lastSeen().includes("conv-1"));
  });

  test("a task with no conversation does not trigger a list read", async () => {
    render();
    await flush();
    const afterMount = server.listCalls;

    await React.act(async () => {
      await tracker.submitTrackedTask({ prompt: "detached" }, { key: "submit-detached" });
    });
    await flush();

    assert.equal(server.listCalls, afterMount, "nothing new can appear in the sidebar for this task");
  });

  test("a second conversation submitted later also arrives", async () => {
    render();
    await flush();

    server.conversations.push({ id: "conv-1", title: "First", updatedAt: new Date().toISOString() });
    await React.act(async () => {
      await tracker.submitTrackedTask({ prompt: "one", conversationId: "conv-1" }, { key: "submit-one" });
    });
    await flush();

    server.conversations.push({ id: "conv-2", title: "Second", updatedAt: new Date().toISOString() });
    await React.act(async () => {
      await tracker.submitTrackedTask({ prompt: "two", conversationId: "conv-2" }, { key: "submit-two" });
    });
    await flush();

    assert.ok(lastSeen().includes("conv-1"), "the first conversation stays");
    assert.ok(lastSeen().includes("conv-2"), "the second conversation arrives too");
  });
});