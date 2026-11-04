import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "src", "desktop");
const workDir = path.join(root, "test", ".compiled-sidetask");

let dom;
let React;
let ReactDOMClient;
let SideTaskPane;
let helpers;
let catalog;

// The engine call is the same one the chat turn makes, so the pane is driven
// against a recorder: what has to be proven here is the identity, wiring and
// honest status the pane puts around a real run, not the network round trip.
const ENGINE_STUB = `
const s = () => globalThis.__engineStub;
export function runDesktopToolChat(args) { s().calls.push(args); return s().run(args); }
`;

const TOOLS_STUB = `
const s = () => globalThis.__toolsStub;
export function onDesktopToolApproval(onRequest) { return s().subscribe(onRequest); }
export function respondDesktopToolApproval(requestId, decision) {
  s().responses.push({ requestId, decision });
  return Promise.resolve({ ok: true });
}
export function cancelDesktopToolOperation(operationId) {
  s().cancellations.push(operationId);
  return Promise.resolve([]);
}
export function cancelDesktopToolApprovals() { return Promise.resolve([]); }
`;

const WORKSPACE_STUB = `
export function useWorkspaces() { return globalThis.__workspaceStub; }
`;

const MODEL_CATALOG_REEXPORT = `export * from ${JSON.stringify(pathToFileURL(path.join(root, "src", "chat", "modelCatalog.js")).href)};
`;

before(async () => {
  mkdirSync(workDir, { recursive: true });

  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    localStorage: dom.window.localStorage,
    AbortController: globalThis.AbortController,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  writeFileSync(path.join(workDir, "engineStub.mjs"), ENGINE_STUB);
  writeFileSync(path.join(workDir, "toolsStub.mjs"), TOOLS_STUB);
  writeFileSync(path.join(workDir, "workspaceStub.mjs"), WORKSPACE_STUB);
  writeFileSync(path.join(workDir, "modelCatalog.mjs"), MODEL_CATALOG_REEXPORT);
  catalog = await import(pathToFileURL(path.join(workDir, "modelCatalog.mjs")).href);

  async function compile(relativePath, rewrite) {
    const sourcePath = path.join(desktopDir, relativePath);
    const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
      loader: relativePath.endsWith(".jsx") ? "jsx" : "js",
      jsx: "automatic"
    });
    const outFile = path.join(workDir, `${relativePath.replace(/\.jsx?$/, "").replace(/[\\/]/g, "-")}.mjs`);
    writeFileSync(outFile, rewrite(code));
    return import(pathToFileURL(outFile).href);
  }

  helpers = await compile("sideTaskRun.js", code =>
    code
      .replace(/from "\.\.\/services\/desktopChat\.js"/g, 'from "./engineStub.mjs"')
      .replace(/from "\.\.\/chat\/modelCatalog\.js"/g, 'from "./modelCatalog.mjs"')
  );

  // Phosphor ships hundreds of components; the pane only needs its own import list.
  const iconClauses = [
    ...new Set(
      [...readFileSync(path.join(desktopDir, "panel", "SideTaskPane.jsx"), "utf8")
        .matchAll(/import\s*\{([^{}]*)\}\s*from\s*"@phosphor-icons\/react"/g)]
        .flatMap(match => match[1].split(","))
        .map(part => part.trim())
        .filter(Boolean)
    )
  ];
  writeFileSync(
    path.join(workDir, "iconStub.mjs"),
    `import React from "react";
function make(name) {
  return function Icon(props) {
    return React.createElement("svg", { "data-icon": name, "aria-hidden": "true", width: props.size || 16 });
  };
}
${iconClauses.map(clause => {
      const [imported, local = imported] = clause.split(/\s+as\s+/).map(part => part.trim());
      return `export const ${local} = make("${imported}");`;
    }).join("\n")}
`
  );

  const pane = await compile("panel/SideTaskPane.jsx", code =>
    code
      .replace(/from "@phosphor-icons\/react"/g, 'from "./iconStub.mjs"')
      .replace(/from "\.\.\/WorkspaceContext\.jsx"/g, 'from "./workspaceStub.mjs"')
      .replace(/from "[^"]*native\/desktopTools\.js"/g, 'from "./toolsStub.mjs"')
      .replace(/from "\.\.\/sideTaskRun\.js"/g, 'from "./sideTaskRun.mjs"')
  );
  SideTaskPane = pane.default;
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const mounted = [];

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  dom.window.localStorage.clear();
  delete globalThis.__workspaceStub;
  delete globalThis.__engineStub;
  delete globalThis.__toolsStub;
});

function storageFor(selection) {
  const key = catalog.MODEL_SELECTION_STORAGE_KEY;
  const values = selection ? new Map([[key, JSON.stringify(selection)]]) : new Map();
  return {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name)
  };
}

function workspaceStub(overrides = {}) {
  return {
    supported: true,
    owner: "user-1",
    activeWorkspace: { id: "ws-1", title: "demo", path: "C:\\project\\demo" },
    ...overrides
  };
}

function toolsStub() {
  const listeners = [];
  return {
    responses: [],
    cancellations: [],
    subscribe(onRequest) {
      listeners.push(onRequest);
      return () => {
        const index = listeners.indexOf(onRequest);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(prompt) {
      for (const listener of [...listeners]) listener(prompt);
    }
  };
}

function engineStub(run) {
  return { calls: [], run };
}

function settledEngine(result) {
  return engineStub(args => {
    args.onMeta?.({ conversationId: "conv-7" });
    return Promise.resolve(result);
  });
}

// A run that is still going. Activity is pushed while the engine call is being
// made, so the test never has to open a second React.act over the first.
function pendingEngine(options = {}) {
  return engineStub(args => {
    for (const entry of options.activity || []) args.onActivity?.(entry);
    if (options.meta) args.onMeta?.(options.meta);
    return new Promise((resolve, reject) => {
      args.signal?.addEventListener?.("abort", () =>
        reject(Object.assign(new Error("The side task was stopped."), { name: "AbortError" }))
      );
    });
  });
}

async function setup(options = {}) {
  globalThis.__workspaceStub = workspaceStub(options.workspace);
  globalThis.__toolsStub = options.tools || toolsStub();
  globalThis.__engineStub = options.engine || settledEngine({ content: "nothing to report" });
  if (options.selection) {
    dom.window.localStorage.setItem(catalog.MODEL_SELECTION_STORAGE_KEY, JSON.stringify(options.selection));
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });

  await React.act(async () => {
    rootHandle.render(React.createElement(SideTaskPane));
  });
  await flush();
  return { container, engine: globalThis.__engineStub, tools: globalThis.__toolsStub };
}

async function flush(times = 2) {
  for (let index = 0; index < times; index += 1) {
    await React.act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
  }
}

// A run settles in its own microtask chain, so the pane is polled rather than
// assumed to have rendered by a fixed number of flushes.
async function waitForStatus(container, status) {
  for (let round = 0; round < 30; round += 1) {
    if (container.querySelector(".vr-side-state")?.dataset.status === status) return;
    await flush(1);
  }
  assert.equal(container.querySelector(".vr-side-state")?.dataset.status, status);
}

function findButton(container, label) {
  return [...container.querySelectorAll("button")].find(node =>
    `${node.textContent} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.includes(
      label
    )
  );
}

function click(node) {
  return React.act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function submit(container, text) {
  const input = container.querySelector('input[aria-label="Side task instruction"]');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await React.act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
  await React.act(async () => {
    container
      .querySelector(".vr-side-input")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
  await flush(3);
}

function prompt(overrides = {}) {
  return {
    requestId: "req-1",
    approvalKey: "req-1",
    operationId: "sidetask_task-1-1",
    tool: "list_folder",
    action: "read",
    access: "read",
    scopePath: "C:\\project\\demo\\src",
    scopeName: "src",
    summary: "List src in the workspace",
    details: ["C:\\project\\demo\\src"],
    canPersist: true,
    chatScoped: true,
    readOnly: true,
    modifiesData: false,
    destructive: false,
    command: "",
    expiresAt: Date.now() + 60000,
    ...overrides
  };
}

test("the side task uses the model chat already picked", () => {
  assert.match(helpers.sideTaskModel(storageFor(null)).error, /Pick a model/i);

  const combo = helpers.sideTaskModel(storageFor({ kind: "combo" }));
  assert.match(combo.error, /Vups Combo AI cannot run a side task/);

  const vups = helpers.sideTaskModel(storageFor({ kind: "vups", model: "whatever" }));
  assert.equal(vups.model, catalog.VUPS_MODEL_ID);
  assert.equal(vups.vups, true);
  assert.equal(vups.label, "Vups v3 Galax");

  const saved = helpers.sideTaskModel(storageFor({ kind: "saved", model: "gpt-5-mini", configId: "cfg-1" }));
  assert.equal(saved.model, "gpt-5-mini");
  assert.equal(saved.configId, "cfg-1");
  assert.equal(saved.vups, undefined);

  const gateway = helpers.sideTaskModel(storageFor({ kind: "gateway", model: "deepseek-v3", source: "omniroute" }));
  assert.equal(gateway.model, "deepseek-v3");
  assert.equal(gateway.source, "omniroute");

  const shared = helpers.sideTaskModel(storageFor({ kind: "shared", model: "free-model" }));
  assert.equal(shared.model, "free-model");
  assert.equal(shared.configId, undefined);
});

test("operation ids name the task and turn, so Stop cannot reach another run", () => {
  assert.equal(helpers.sideTaskOperationId("task-1", 2), "sidetask_task-1-2");
  assert.equal(helpers.sideTaskChatId("task-1"), "sidetask_task-1");
  assert.equal(helpers.taskIdFromOperation("sidetask_task-1-2"), "task-1");
  assert.equal(helpers.taskIdFromOperation("sidetask_task-2b-11"), "task-2b");
  assert.equal(helpers.taskIdFromOperation("sidetask_"), "");
  assert.equal(helpers.taskIdFromOperation("op-chat-9"), "");
  assert.equal(helpers.isSideTaskOperation("sidetask_task-1-1"), true);
  assert.equal(helpers.isSideTaskOperation("op-chat-9"), false);
  assert.equal(helpers.isSideTaskOperation(undefined), false);
});

test("one side task turn carries its own operation, chat scope and workspace root", async () => {
  const onMeta = [];
  const activity = [];
  const engine = settledEngine({ content: " 12 files matched " });
  globalThis.__engineStub = engine;

  const result = await helpers.runSideTaskTurn({
    taskId: "task-1",
    turn: 2,
    conversationId: "conv-7",
    messages: [{ role: "user", content: "count them" }],
    userText: "count them",
    workspacePath: "C:\\project\\demo",
    storage: storageFor({ kind: "vups" }),
    onMeta: meta => onMeta.push(meta),
    onActivity: entry => activity.push(entry)
  });

  assert.equal(engine.calls.length, 1);
  const args = engine.calls[0];
  assert.equal(args.operationId, "sidetask_task-1-2");
  assert.equal(args.chatId, "sidetask_task-1");
  assert.equal(args.conversationId, "conv-7");
  assert.equal(args.model, catalog.VUPS_MODEL_ID);
  assert.equal(args.vups, true);
  assert.deepEqual(args.searchRoots, ["C:\\project\\demo"]);
  assert.equal(args.userText, "count them");
  assert.equal(result.content, " 12 files matched ");
});

test("a side task with no model chosen never reaches the tool engine", async () => {
  const engine = engineStub(() => Promise.resolve({ content: "should not run" }));
  globalThis.__engineStub = engine;

  await assert.rejects(
    () =>
      helpers.runSideTaskTurn({
        taskId: "task-1",
        turn: 1,
        messages: [],
        storage: storageFor(null)
      }),
    error => {
      assert.equal(error.code, "side_task_model_unset");
      assert.match(error.message, /Pick a model/i);
      return true;
    }
  );
  assert.equal(engine.calls.length, 0);
});

test("off Windows the side task says it needs the desktop app instead of pretending", async () => {
  const { container } = await setup({ workspace: workspaceStub({ supported: false }) });
  assert.match(container.textContent, /Windows app/);
  assert.equal(container.querySelector(".vr-side-input"), null);
  assert.equal(globalThis.__engineStub.calls.length, 0);
});

test("a run shows its own transcript, streams real activity and ends with the model answer", async () => {
  const engine = engineStub(args => {
    args.onActivity?.({ phase: "thinking", message: "Thinking" });
    args.onActivity?.({ phase: "tool", message: "Listing src" });
    args.onMeta?.({ conversationId: "conv-7" });
    return Promise.resolve({ content: "47 files" });
  });
  const { container } = await setup({
    selection: { kind: "vups" },
    engine,
    workspace: workspaceStub({ supported: true })
  });

  await submit(container, "count the files");

  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].operationId, "sidetask_task-1-1");
  assert.equal(engine.calls[0].chatId, "sidetask_task-1");
  assert.equal(engine.calls[0].model, catalog.VUPS_MODEL_ID);
  assert.equal(engine.calls[0].conversationId, undefined);
  assert.deepEqual(engine.calls[0].messages, [{ role: "user", content: "count the files" }]);

  const messages = [...container.querySelectorAll(".vr-side-msg")].map(node => node.textContent);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /count the files/);
  assert.match(messages[1], /47 files/);
  assert.equal(container.querySelector(".vr-side-result p").textContent, "47 files");
  assert.equal(container.querySelector(".vr-side-state").dataset.status, "done");
  assert.equal(container.querySelector(".vr-side-activity"), null);
  assert.equal(container.querySelector('input[aria-label="Side task instruction"]').value, "");
});

test("activity is displayed while the task runs and the stop button belongs to that run", async () => {
  const engine = pendingEngine({
    activity: [
      { phase: "thinking", message: "Thinking" },
      { phase: "tool", message: "Reading config" }
    ]
  });
  const { container, tools } = await setup({ selection: { kind: "vups" }, engine });

  await submit(container, "wait for it");

  assert.equal(container.querySelector(".vr-side-state").dataset.status, "running");
  assert.match(container.querySelector(".vr-side-state").textContent, /Running — Reading config/);
  assert.deepEqual(
    [...container.querySelectorAll(".vr-side-activity li")].map(node => node.textContent),
    ["Thinking", "Reading config"]
  );

  await click(findButton(container, "Stop"));

  assert.equal(tools.cancellations.length, 1);
  assert.equal(tools.cancellations[0], "sidetask_task-1-1");
  await waitForStatus(container, "stopped");
});

test("a failing run says what failed instead of an empty card", async () => {
  const engine = engineStub(() =>
    Promise.reject(
      Object.assign(new Error("The assistant used too many local filesystem tool rounds."), {
        toolSteps: [
          { ok: true, tool: "list_folder", label: "List src" },
          { ok: false, tool: "read_file", label: "Read .env" }
        ]
      })
    )
  );
  const { container } = await setup({ selection: { kind: "vups" }, engine });

  await submit(container, "read the secrets");

  await waitForStatus(container, "failed");
  assert.match(container.querySelector(".vr-inline-error").textContent, /too many local filesystem tool rounds/);
  assert.match(container.querySelector(".vr-inline-error").textContent, /Failed: Read \.env/);
  assert.equal(container.querySelector(".vr-side-result"), null);
});

async function emitPrompt(tools, overrides) {
  await React.act(async () => {
    tools.emit(prompt(overrides));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
  await flush();
}

test("a side-task approval is answered in this pane and a chat approval is left alone", async () => {
  const engine = pendingEngine();
  const tools = toolsStub();
  const { container } = await setup({ selection: { kind: "vups" }, engine, tools });

  await submit(container, "list the files");
  assert.equal(engine.calls.length, 1, "the run is waiting on its approval");

  await emitPrompt(tools, { requestId: "req-chat", operationId: "op-main-1", summary: "Chat wants to read src" });
  assert.equal(tools.responses.length, 0, "a chat prompt is not this pane's to answer");

  await emitPrompt(tools, { requestId: "req-other-task", operationId: "sidetask_task-4-1" });
  assert.equal(tools.responses.length, 0, "a prompt for a task that is gone grants nothing");

  await emitPrompt(tools, {});
  const cards = [...container.querySelectorAll(".vr-side-approval")];
  assert.equal(cards.length, 1);
  assert.match(cards[0].querySelector(".vr-side-approval__summary").textContent, /List src in the workspace/);
  assert.deepEqual(
    [...cards[0].querySelectorAll(".vr-side-approval__details li")].map(node => node.textContent),
    ["C:\\project\\demo\\src"]
  );
  assert.deepEqual(
    [...cards[0].querySelectorAll("button")].map(node => node.textContent),
    ["Allow once", "Allow always", "Deny"]
  );

  await click(findButton(container, "Allow once"));
  assert.deepEqual(tools.responses, [{ requestId: "req-1", decision: "once" }]);
  assert.equal(container.querySelectorAll(".vr-side-approval").length, 0);
});

test("'Allow always' only appears when the native layer offers it", async () => {
  const engine = pendingEngine();
  const tools = toolsStub();
  const { container } = await setup({ selection: { kind: "vups" }, engine, tools });

  await submit(container, "list the folder");
  await emitPrompt(tools, { canPersist: false });
  assert.deepEqual(
    [...container.querySelectorAll(".vr-side-approval button")].map(node => node.textContent),
    ["Allow once", "Deny"]
  );

  await click(findButton(container, "Deny"));
  assert.deepEqual(tools.responses, [{ requestId: "req-1", decision: "deny" }]);
});

test("every task keeps its own transcript and the next turn continues the same conversation", async () => {
  const calls = [];
  const engine = engineStub(args => {
    calls.push(args);
    args.onMeta?.({ conversationId: "conv-7" });
    return Promise.resolve({ content: `answer ${calls.length}` });
  });
  const { container } = await setup({ selection: { kind: "vups" }, engine });

  await submit(container, "first question");
  assert.equal(container.querySelector(".vr-side-result p").textContent, "answer 1");

  await click(findButton(container, "New side task"));
  assert.equal(container.querySelector(".vr-side-result"), null, "a new task starts from nothing");
  assert.match(container.querySelector(".vr-side-log").textContent, /Describe a job/);

  const chips = [...container.querySelectorAll(".vr-side-chip")];
  assert.equal(chips.length, 2);
  assert.equal(chips[1].className.includes("is-active"), true);

  await click(container.querySelectorAll(".vr-side-chip")[0]);
  assert.equal(container.querySelector(".vr-side-result p").textContent, "answer 1");

  await submit(container, "second question");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].operationId, "sidetask_task-1-2");
  assert.equal(calls[1].conversationId, "conv-7");
  assert.deepEqual(calls[1].messages.map(message => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(calls[1].messages.map(message => message.content), [
    "first question",
    "answer 1",
    "second question"
  ]);

  await click(findButton(container, "Delete this side task"));
  assert.equal(container.querySelectorAll(".vr-side-chip").length, 0, "one task left needs no switcher");
  assert.match(container.querySelector(".vr-side-log").textContent, /Describe a job/);
  assert.equal(calls.length, 2, "deleting a task does not re-run anything");
});

test("with no model picked the pane refuses the run instead of sending a blank request", async () => {
  const engine = engineStub(() => Promise.resolve({ content: "no" }));
  const { container } = await setup({ engine });

  assert.match(container.querySelector(".vr-inline-error").textContent, /Pick a model/i);
  assert.equal(container.querySelector(".vr-pane-title").textContent, "No model selected");
  assert.equal(findButton(container, "Run").disabled, true);

  await submit(container, "try anyway");
  assert.equal(engine.calls.length, 0);
});

test("ChatPage leaves side-task approvals to the panel and still denies its own stale ones", () => {
  const source = readFileSync(path.join(root, "src", "ChatPage.jsx"), "utf8");
  assert.match(source, /import \{ isSideTaskOperation \} from "\.\/desktop\/sideTaskRun\.js"/);

  const guard = source.indexOf("if (isSideTaskOperation(prompt.operationId)) return;");
  const deny = source.indexOf('respondDesktopToolApproval(prompt.requestId, "deny")');
  assert.ok(guard > -1, "the side-task guard exists");
  assert.ok(deny > -1, "the stale-approval denial exists");
  assert.ok(guard < deny, "a side-task prompt is skipped before ChatPage can deny it");

  const pane = readFileSync(path.join(desktopDir, "panel", "SideTaskPane.jsx"), "utf8");
  assert.match(pane, /if \(!isSideTaskOperation\(prompt\.operationId\)\) return;/);
});
