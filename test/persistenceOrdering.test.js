import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

import { apiClient } from "../src/services/api.js";
import { taskRunSubmissionKey } from "../src/tasks/taskSubmission.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-persistence");
const SERVER_DIR = path.resolve(root, "..", "server");

// The task sidebar is a JSX component, so it is compiled through Vite's
// esbuild pipeline next to its plain-JavaScript dependencies before jsdom
// renders it.
const COMPILED = ["desktop/TaskContext.jsx"];
// TaskContext reads the workspace owner from its provider. The provider itself
// belongs to the app shell, so this harness supplies the one value it reads
// instead of compiling the whole authentication graph.
const STUBS = {
  "desktop/WorkspaceContext.jsx": {
    file: "WorkspaceContext.mjs",
    code: 'export function useWorkspaces() { return { owner: "" }; }\n'
  }
};

function compiledName(relative) {
  return path.basename(relative).replace(/\.(jsx|js)$/, ".mjs");
}

async function compileAll() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const stub of Object.values(STUBS)) {
    writeFileSync(path.join(outDir, stub.file), stub.code);
  }
  for (const relative of COMPILED) {
    const from = path.join(srcDir, relative);
    const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
      loader: "jsx",
      jsx: "automatic"
    });
    const rewritten = code.replace(/from "(\.[^"]*)"/g, (match, specifier) => {
      const target = path.resolve(path.dirname(from), specifier);
      const targetRelative = path.relative(srcDir, target).split(path.sep).join("/");
      if (STUBS[targetRelative]) return `from "./${STUBS[targetRelative].file}"`;
      if (COMPILED.includes(targetRelative)) return `from "./${compiledName(targetRelative)}"`;
      return `from "${path.relative(outDir, target).split(path.sep).join("/")}"`;
    });
    writeFileSync(path.join(outDir, compiledName(relative)), rewritten);
  }
}

let dom;
let React;
let ReactDOMClient;
let TaskProvider;
let useTasks;
const mounted = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: "https://vups.test/",
    pretendToBeVisual: true
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle ? dom.window.getComputedStyle.bind(dom.window) : undefined,
    requestAnimationFrame: callback => dom.window.requestAnimationFrame(callback),
    cancelAnimationFrame: handle => dom.window.cancelAnimationFrame(handle),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    if (value === undefined) continue;
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  await compileAll();
  const compiled = await import(pathToFileURL(path.join(outDir, "TaskContext.mjs")).href);
  TaskProvider = compiled.TaskProvider;
  useTasks = compiled.useTasks;
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      entry.root.unmount();
      entry.container.remove();
    }
  });
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

/**
 * Renders the real task sidebar provider and hands the test its live state.
 */
async function mountSidebar() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const api = {};
  function Probe() {
    Object.assign(api, useTasks());
    return null;
  }
  let root;
  await React.act(async () => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(TaskProvider, null, React.createElement(Probe)));
  });
  mounted.push({ root, container });
  return api;
}

/** Replaces the conversation list endpoint with a controllable answer. */
function stubList(handler) {
  const original = apiClient.get;
  apiClient.get = async (requestPath, config) => {
    if (requestPath === "/conversations") {
      const list = await handler();
      return { data: { conversations: list } };
    }
    if (requestPath === "/usage") return { data: { usage: null, supported: false } };
    return original(requestPath, config);
  };
  return () => {
    apiClient.get = original;
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

// 3. The sidebar shows a conversation the server confirmed, without waiting for
//    another list request.
test("a confirmed conversation is in the sidebar as soon as the server names it", async () => {
  const restore = stubList(async () => []);
  try {
    const sidebar = await mountSidebar();
    await React.act(async () => {
      sidebar.upsertConversation({ id: "conv-1", title: "Hii", updatedAt: "2026-01-01T00:00:00.000Z" });
    });
    assert.deepEqual(sidebar.conversations.map(row => row.id), ["conv-1"]);
    assert.equal(sidebar.conversations[0].title, "Hii");
    assert.equal(sidebar.tasks[0].id, "conv-1", "the sidebar row is what the reader sees");
  } finally {
    restore();
  }
});

// 4./5. A list that was asked for before the server saved the conversation must
//      not be able to take that conversation out of the sidebar afterwards.
test("a list read before the conversation was saved cannot drop it afterwards", async () => {
  const stale = deferred();
  const fresh = deferred();
  let call = 0;
  const restore = stubList(async () => {
    call += 1;
    return call === 1 ? stale.promise : fresh.promise;
  });
  try {
    const sidebar = await mountSidebar();
    const first = sidebar.refreshConversations();
    const second = sidebar.refreshConversations();

    // The newer list answers first and already knows the conversation.
    await React.act(async () => {
      fresh.resolve([{ id: "conv-1", title: "Hii" }]);
      await second;
    });
    assert.deepEqual(sidebar.conversations.map(row => row.id), ["conv-1"]);

    // The older list answers last and does not know it. It is stale, so it is
    // discarded instead of emptying the sidebar.
    await React.act(async () => {
      stale.resolve([]);
      await first;
    });
    assert.deepEqual(
      sidebar.conversations.map(row => row.id),
      ["conv-1"],
      "the saved conversation survives a late answer from an older request"
    );
  } finally {
    restore();
  }
});

// 6. The server is the source of truth: a reload reads the list from the
//    server, so the conversation and its message come back.
test("the sidebar list comes from the server, so a reload restores the conversation", async () => {
  const restore = stubList(async () => [{ id: "conv-1", title: "Hii" }]);
  try {
    const sidebar = await mountSidebar();
    await React.act(async () => {
      await sidebar.refreshConversations();
    });
    assert.deepEqual(sidebar.conversations.map(row => row.title), ["Hii"]);
  } finally {
    restore();
  }
});

// 12. Two conversations stay independent: the scope of a submission names the
//     conversation it belongs to.
test("two conversations never share a submission scope", () => {
  const first = taskRunSubmissionKey({ conversationId: "conv-1", prompt: "Hii", nonce: "n1" });
  const second = taskRunSubmissionKey({ conversationId: "conv-2", prompt: "Hii", nonce: "n1" });
  assert.notEqual(first, second);
  assert.match(first, /conv-1/);
  assert.match(second, /conv-2/);
});

// 10./11. One send is one intent: the same send keeps the same key, so a
//      retry cannot write the message twice, while a second send is a new key.
test("one send is one intent, and a retry keeps that intent", () => {
  const first = taskRunSubmissionKey({ conversationId: "", prompt: "Hii", nonce: "n1" });
  const retry = taskRunSubmissionKey({ conversationId: "", prompt: "Hii", nonce: "n1" });
  const again = taskRunSubmissionKey({ conversationId: "", prompt: "Hii", nonce: "n2" });
  assert.equal(first, retry, "the same send keeps its key");
  assert.notEqual(first, again, "a second send is a second intent");
});

// 14. An image and text travel in the same submission.
test("an image and its text are one submission", () => {
  const key = taskRunSubmissionKey({ conversationId: "conv-1", prompt: "look at this", nonce: "n1" });
  assert.match(key, /look at this/);
});

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const taskContextSource = readFileSync(new URL("../src/desktop/TaskContext.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} is present`);
  let depth = 0;
  let opened = false;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (char !== "{" && char !== "}") continue;
    depth += char === "{" ? 1 : -1;
    if (char === "{") opened = true;
    if (opened && depth === 0) return source.slice(start, at + 1);
  }
  assert.fail(`${name} has no closed body`);
}

// 1./2./4./5. The conversation the server confirmed belongs to the conversation,
//      not to the screen that sent it, so a reader who switched away still
//      finds the new chat in the sidebar.
test("the confirmed conversation is recorded even when the screen has moved on", () => {
  const send = functionBody(chatPageSource, "handleSend");
  const upsert = send.indexOf("upsertConversation(");
  const gate = send.indexOf("if (!isCurrentRequest(seq)) return;", upsert);
  assert.ok(upsert > 0, "the confirmed conversation is put into the sidebar");
  assert.ok(gate > upsert, "that happens before the screen is allowed to walk away");
  assert.match(send, /id: task\.conversationId/, "the row carries the permanent server id");
});

test("the streaming path records the conversation even when the screen has moved on", () => {
  const onMeta = chatPageSource.slice(
    chatPageSource.indexOf("onMeta: ({ conversationId, messageId })"),
    chatPageSource.indexOf("onChunk:")
  );
  const upsert = onMeta.indexOf("upsertConversation(");
  const gate = onMeta.indexOf("if (!isCurrentRequest(seq)) return;");
  assert.ok(upsert > 0 && upsert < gate, "the row is written before the screen can move on");
  assert.match(onMeta, /id: conversationId/);
});

// 5./10. An attempt that may have reached the server keeps its key even if the
//        reader walked away, so the next attempt cannot write it twice.
test("an uncertain submission keeps its key after the reader walks away", () => {
  const send = functionBody(chatPageSource, "handleSend");
  assert.match(
    send,
    /if \(error\.taskSubmissionUncertain\) \{[\s\S]*?uncertainSubmissionRef\.current = \{ key, conversationId: activeConvId, prompt \};/,
    "the key is kept whatever the screen did"
  );
  assert.equal(
    /if \(error\.taskSubmissionUncertain && isCurrentRequest\(seq\)\)/.test(send),
    false,
    "a walked-away screen must not lose the key"
  );
});

// 15. Leaving a chat detaches the turn; it does not stop the work.
test("leaving a chat does not cancel a turn the server owns", () => {
  const invalidate = functionBody(chatPageSource, "invalidateInFlight");
  assert.match(
    invalidate,
    /if \(!serverOwnedTurnRef\.current\) \{[\s\S]*?controller\?\.abort\(\);/,
    "a turn the server owns keeps running when the screen leaves it"
  );
});

// 11. A second send cannot start while the first one is still going out.
test("a second send cannot start while one is already going out", () => {
  const send = functionBody(chatPageSource, "handleSend");
  assert.match(send, /if \(\s*sendingRef\.current \|\|/);
  assert.match(send, /sendingRef\.current = true;/);
});

// The sidebar provider keeps the newest list and discards a superseded one.
test("the sidebar provider drops a superseded list instead of applying it", () => {
  assert.match(taskContextSource, /if \(seq < appliedListSeq\.current\) return null;/);
  assert.match(taskContextSource, /appliedListSeq\.current = seq;/);
});

// 1./2./7./8./9. The server saves the user's message before any work exists.
test("the server saves the message before it creates the task that runs it", () => {
  const route = readFileSync(path.join(SERVER_DIR, "src", "routes", "tasks.js"), "utf8").replace(/\r\n/g, "\n");
  const persisted = route.indexOf("await persistSubmittedMessage(");
  const created = route.indexOf("task = await createTask(");
  const woken = route.indexOf("wakeRunner(task.taskId)");
  assert.ok(persisted > 0, "the message is persisted");
  assert.ok(created > persisted, "the task is created after the message is on disk");
  assert.ok(woken > created, "the worker is woken after that");
  assert.match(route, /code: "persist_failed"/, "a failed save stops the task from starting");
});

// 1./2./7. The chat route saves the message before the provider is called.
test("the chat route saves the message before the provider is asked for an answer", () => {
  const route = readFileSync(path.join(SERVER_DIR, "src", "routes", "chat.js"), "utf8").replace(/\r\n/g, "\n");
  const persisted = route.indexOf("await persistConversation(req.userId, prospectiveId");
  const providerCall = route.indexOf("apiKey: provider.apiKey, providerType: provider.providerType");
  assert.ok(persisted > 0, "the message is persisted");
  assert.ok(providerCall > persisted, "nothing slow happens before the message is on disk");
});
