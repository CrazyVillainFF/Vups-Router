/**
 * The sidebar's thinking indicator, held to the persisted task state.
 *
 * Three things are checked here, in the order they can go wrong. The view model
 * must name a status only for a state the backend actually publishes, and must
 * name none at all for a finished task — a badge that outlives its run is the
 * defect this replaces. The rendered badge must sit inside its own chat's row
 * and animate only while the task is really working. And the sidebar must read
 * that state from the server's conversation rows, not from whether a chat
 * component happens to be mounted.
 *
 * The badge is rendered for real through Vite's esbuild pipeline, the same way
 * the other component suites do it. The wiring around it is read from source,
 * which is how every other DesktopSidebar test in this project works.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { TASK_STATES } from "../src/services/taskApi.js";
import { conversationTask, sidebarTaskStatus, tasksByConversation } from "../src/desktop/sidebarTaskStatus.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-sidebar-status");
const read = relative => readFileSync(path.join(root, relative), "utf8");

const compiledBySource = new Map();

function resolveDependency(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.jsx`, `${base}.js`, path.join(base, "index.jsx"), path.join(base, "index.js")];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
  return found;
}

async function compileModule(absolute) {
  const existing = compiledBySource.get(absolute);
  if (existing) return existing;
  const out = path.join(workDir, `module${compiledBySource.size}.mjs`);
  compiledBySource.set(absolute, out);
  let source = readFileSync(absolute, "utf8").replace(/^\s*import\s+["'][^"']+\.css["'];?\s*$/gm, "");
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
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://vups.test/" });
  const { window } = dom;
  window.matchMedia = query => ({
    media: query,
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
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
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    if (!savedDescriptors.has(key)) savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return { window, container: window.document.getElementById("root") };
}

/** A conversation row as `GET /api/conversations` returns it. */
function row(id, task = null) {
  return { id, title: `Chat ${id}`, updatedAt: "2026-11-11T05:00:00.000Z", task };
}

/** A tracker entry view, shaped as `taskTracker.js` publishes it. */
function view(taskId, conversationId, state, lastActivityAt = 0) {
  return { taskId, state, conversationId, task: { taskId, conversationId, state, lastActivityAt } };
}

// ─── the view model ──────────────────────────────────────────────────────────

test("every state the backend can name is either given a badge or deliberately given none", () => {
  const finished = new Set(["completed", "cancelled"]);
  for (const state of TASK_STATES) {
    const status = sidebarTaskStatus({ state });
    if (finished.has(state)) {
      assert.equal(status, null, `${state} is finished and must not show a live badge`);
    } else {
      assert.ok(status, `${state} is open and the sidebar has to say so`);
      assert.ok(status.label && status.description, `${state} needs words a person can read`);
    }
  }
});

test("a state this client has never seen is shown as nothing, never guessed", () => {
  assert.equal(sidebarTaskStatus({ state: "shipped_but_strange" }), null);
  assert.equal(sidebarTaskStatus({ state: "" }), null);
  assert.equal(sidebarTaskStatus(null), null);
  assert.equal(sidebarTaskStatus(undefined), null);
});

test("only a task that is really working is marked live", () => {
  const working = ["planning", "running", "executing_tool", "verifying", "retrying", "recovering"];
  for (const state of working) {
    assert.equal(sidebarTaskStatus({ state }).live, true, `${state} is work in progress`);
  }
  // Queued is waiting for a slot, and the parked states are waiting for a person.
  // Neither is thinking, so neither may animate.
  for (const state of ["queued", "waiting_for_user", "waiting_for_permission", "paused", "failed"]) {
    assert.equal(sidebarTaskStatus({ state }).live, false, `${state} is not thinking`);
  }
});

test("the badge kinds separate thinking from waiting, approval and failure", () => {
  assert.equal(sidebarTaskStatus({ state: "running" }).kind, "thinking");
  assert.equal(sidebarTaskStatus({ state: "queued" }).kind, "queued");
  assert.equal(sidebarTaskStatus({ state: "waiting_for_permission" }).kind, "approval");
  assert.equal(sidebarTaskStatus({ state: "waiting_for_user" }).kind, "waiting");
  assert.equal(sidebarTaskStatus({ state: "paused" }).kind, "paused");
  assert.equal(sidebarTaskStatus({ state: "failed" }).kind, "failed");
});

test("a chat with no task carries no badge at all", () => {
  assert.equal(conversationTask(row("a"), null), null);
  assert.equal(sidebarTaskStatus(conversationTask(row("a"), null)), null);
});

test("the row's own persisted state is what shows when the tracker knows nothing", () => {
  const own = { taskId: "tsk_own", state: "running", lastActivityAt: 10 };
  assert.deepEqual(conversationTask(row("a", own), null), own);
});

test("a task the tracker is watching is used when the row has none yet", () => {
  const tracked = { taskId: "tsk_new", state: "queued", lastActivityAt: 50 };
  assert.deepEqual(conversationTask(row("a"), tracked), tracked);
});

test("the newer of the two readings wins, so a stale list cannot undo live progress", () => {
  const own = { taskId: "tsk_1", state: "running", lastActivityAt: 100 };
  const newer = { taskId: "tsk_1", state: "completed", lastActivityAt: 200 };
  assert.deepEqual(conversationTask(row("a", own), newer), newer);
  const older = { taskId: "tsk_1", state: "queued", lastActivityAt: 50 };
  assert.deepEqual(conversationTask(row("a", own), older), own);
});

test("each conversation is matched to its own task, and one task is never shared between two", () => {
  const map = tasksByConversation([
    view("tsk_a", "conv_a", "running", 10),
    view("tsk_b", "conv_b", "waiting_for_permission", 20),
    view("tsk_c", "conv_c", "completed", 30)
  ]);
  assert.equal(map.get("conv_a").taskId, "tsk_a");
  assert.equal(map.get("conv_b").taskId, "tsk_b");
  assert.equal(map.get("conv_c").taskId, "tsk_c");
  assert.equal(map.size, 3);
  assert.equal(sidebarTaskStatus(conversationTask(row("conv_a"), map.get("conv_a"))).kind, "thinking");
  assert.equal(sidebarTaskStatus(conversationTask(row("conv_b"), map.get("conv_b"))).kind, "approval");
  assert.equal(sidebarTaskStatus(conversationTask(row("conv_c"), map.get("conv_c"))), null);
});

test("a view with no conversation cannot be attributed to any chat", () => {
  const map = tasksByConversation([view("tsk_x", "", "running"), view("tsk_y", null, "running"), null, {}]);
  assert.equal(map.size, 0);
  assert.equal(tasksByConversation(null).size, 0);
});

test("the newest activity for one conversation is the one kept", () => {
  const map = tasksByConversation([
    view("tsk_new", "conv_a", "running", 90),
    view("tsk_old", "conv_a", "completed", 10)
  ]);
  assert.equal(map.get("conv_a").taskId, "tsk_new");
});

test("a newer terminal turn cannot hide an older open turn in the same chat", () => {
  for (const state of ["completed", "cancelled", "failed"]) {
    const open = view("tsk_open", "conv_a", "running", 10).task;
    const done = view("tsk_done", "conv_a", state, 90).task;
    const map = tasksByConversation([{ task: done }, { task: open }]);
    assert.equal(map.get("conv_a").taskId, "tsk_open");
    assert.deepEqual(conversationTask(row("conv_a", open), done), open);
    assert.deepEqual(conversationTask(row("conv_a", done), open), open);
  }
});

// ─── the rendered badge ──────────────────────────────────────────────────────

describe("the badge in the DOM", () => {
  let SidebarTaskBadge;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];

  before(async () => {
    mkdirSync(workDir, { recursive: true });
    SidebarTaskBadge = (await loadModule("src/desktop/SidebarTaskBadge.jsx")).default;
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
  });

  function render(element) {
    const rootHandle = ReactDOMClient.createRoot(dom.container);
    const entry = { root: rootHandle, disposed: false };
    trees.push(entry);
    React.act(() => { rootHandle.render(element); });
    return dom.container;
  }

  test("a running task renders a live badge naming its own chat", () => {
    const container = render(
      React.createElement(SidebarTaskBadge, { task: { state: "running" }, title: "Quarterly report" })
    );
    const badge = container.querySelector(".vr-conv-status");
    assert.ok(badge, "a running task has a badge");
    assert.equal(badge.dataset.taskState, "running");
    assert.ok(badge.classList.contains("vr-conv-status--thinking"));
    assert.ok(badge.classList.contains("vr-conv-status--live"));
    assert.equal(badge.getAttribute("role"), "status");
    assert.match(badge.getAttribute("aria-label"), /Quarterly report/);
    assert.match(badge.textContent, /Thinking/);
  });

  test("a completed task renders nothing at all", () => {
    for (const state of ["completed", "cancelled"]) {
      const container = render(React.createElement(SidebarTaskBadge, { task: { state }, title: "Done chat" }));
      assert.equal(container.querySelector(".vr-conv-status"), null, `${state} must leave no badge behind`);
      assert.equal(container.textContent, "");
    }
  });

  test("a queued task is shown without an animation", () => {
    const container = render(React.createElement(SidebarTaskBadge, { task: { state: "queued" }, title: "Waiting chat" }));
    const badge = container.querySelector(".vr-conv-status");
    assert.ok(badge.classList.contains("vr-conv-status--queued"));
    assert.equal(badge.classList.contains("vr-conv-status--live"), false);
    assert.match(badge.textContent, /Queued/);
  });

  test("an approval wait reads as approval, not as thinking", () => {
    const container = render(
      React.createElement(SidebarTaskBadge, { task: { state: "waiting_for_permission" }, title: "Needs a yes" })
    );
    const badge = container.querySelector(".vr-conv-status");
    assert.ok(badge.classList.contains("vr-conv-status--approval"));
    assert.equal(badge.classList.contains("vr-conv-status--live"), false);
    assert.match(badge.getAttribute("aria-label"), /permission/i);
  });

  test("two chats render two independent badges, each with its own state", () => {
    const container = render(
      React.createElement(
        "ul",
        null,
        React.createElement(
          "li",
          { key: "a" },
          React.createElement(SidebarTaskBadge, { task: { state: "running" }, title: "Chat A" })
        ),
        React.createElement(
          "li",
          { key: "b" },
          React.createElement(SidebarTaskBadge, { task: { state: "failed" }, title: "Chat B" })
        ),
        React.createElement(
          "li",
          { key: "c" },
          React.createElement(SidebarTaskBadge, { task: { state: "completed" }, title: "Chat C" })
        )
      )
    );
    const rows = [...container.querySelectorAll("li")];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector(".vr-conv-status").dataset.taskState, "running");
    assert.equal(rows[1].querySelector(".vr-conv-status").dataset.taskState, "failed");
    assert.equal(rows[2].querySelector(".vr-conv-status"), null);
  });

  test("a task changing state replaces the badge rather than adding a second one", () => {
    const rootHandle = ReactDOMClient.createRoot(dom.container);
    trees.push({ root: rootHandle, disposed: false });
    React.act(() => {
      rootHandle.render(React.createElement(SidebarTaskBadge, { task: { state: "running" }, title: "Chat" }));
    });
    assert.equal(dom.container.querySelectorAll(".vr-conv-status").length, 1);
    React.act(() => {
      rootHandle.render(React.createElement(SidebarTaskBadge, { task: { state: "completed" }, title: "Chat" }));
    });
    assert.equal(dom.container.querySelectorAll(".vr-conv-status").length, 0, "completion removes the badge");
  });
});

// ─── the wiring ──────────────────────────────────────────────────────────────

test("the sidebar reads task state from the tracker and the persisted rows, not from a mounted chat", () => {
  const sidebar = read("src/desktop/DesktopSidebar.jsx");
  assert.match(sidebar, /import \{ useTaskTracker \} from "\.\.\/tasks\/TaskTrackerContext\.jsx"/);
  assert.match(sidebar, /import \{ conversationTask, tasksByConversation \} from "\.\/sidebarTaskStatus\.js"/);
  assert.match(sidebar, /import SidebarTaskBadge from "\.\/SidebarTaskBadge\.jsx"/);
  assert.match(sidebar, /tasksByConversation\(trackedTasks\)/);
  // The badge belongs to the row's own id, so it cannot land on another chat.
  assert.match(sidebar, /conversationTask\(task, trackedByConversation\.get\(String\(task\.id\)\)\)/);
  // Nothing about the badge is derived from the open chat or from a local guess.
  const badgeProps = sidebar.slice(sidebar.indexOf("<SidebarTaskBadge"), sidebar.indexOf("/>", sidebar.indexOf("<SidebarTaskBadge")));
  assert.doesNotMatch(badgeProps, /activeTaskId|location|mounted|isThinking|Date\.now/);
});

test("the badge sits inside the chat link, beside the name and outside the hover actions", () => {
  const sidebar = read("src/desktop/DesktopSidebar.jsx");
  const link = sidebar.slice(sidebar.indexOf("to={taskHref(task.id)}"));
  const insideLink = link.slice(0, link.indexOf("</Link>"));
  assert.match(insideLink, /<SidebarTaskBadge/, "the badge is part of the row, so it shows without hovering");
  assert.ok(
    insideLink.indexOf("vr-conv-copy") < insideLink.indexOf("<SidebarTaskBadge"),
    "the badge follows the name rather than replacing it"
  );
  const actions = sidebar.slice(sidebar.indexOf('className="vr-conv-actions"'));
  assert.doesNotMatch(actions.slice(0, actions.indexOf("</span>")), /SidebarTaskBadge/);
});

test("the badge is styled from the token layer and only animates while live", () => {
  const css = read("src/desktop/desktop.css");
  const block = css.slice(css.indexOf(".vr-conv-status {"), css.indexOf(".vr-conv-actions {"));
  assert.ok(block.includes(".vr-conv-status--thinking"), "thinking has its own tone");
  assert.match(block, /color: var\(--accent\)/);
  assert.match(block, /color: var\(--warn\)/);
  assert.match(block, /color: var\(--error\)/);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, "no colour outside the token layer");
  // The animation is bound to the live modifier, never to the badge itself.
  assert.match(block, /\.vr-conv-status--live \.vr-conv-status-dot \{\s*animation:/);
  assert.doesNotMatch(block, /\.vr-conv-status \{[^}]*animation:/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)/);
});

test("the conversation list is refreshed on a timer and on return, so another device's task arrives", () => {
  const context = read("src/desktop/TaskContext.jsx");
  const effect = context.slice(context.indexOf("const timer = window.setInterval"), context.indexOf("const saveLocalChat"));
  assert.match(effect, /refreshConversations\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(effect, /visibilitychange/);
  const onVisible = effect.slice(effect.indexOf("const onVisible"));
  assert.match(onVisible, /refreshConversations/, "coming back to the app re-reads the list, not only usage");
});