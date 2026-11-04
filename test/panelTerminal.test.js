import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelDir = path.join(root, "src", "desktop", "panel");
const cssPath = path.join(panelDir, "workspacePanel.css");
const workDir = path.join(root, "test", ".compiled-terminal");

// The bridge is the only path to a real PowerShell process, so this suite drives
// the pane against a recording stub; panel_terminal.rs owns the process itself.
const BRIDGE_STUB = `
const s = () => globalThis.__terminalStub;
export const TERMINAL_OUTPUT_EVENT = "panel-terminal:output";
export const TERMINAL_EXIT_EVENT = "panel-terminal:exit";
export const TERMINAL_READY_EVENT = "panel-terminal:ready";
export function isTauriRuntime() { return true; }
function record(name, args) { s().calls.push({ name, ...args }); }
export function startTerminalSession(sessionId, cwd) { record("start", { sessionId, cwd }); return s().impl.start(sessionId, cwd); }
export function sendTerminalInput(sessionId, text) { record("send", { sessionId, text }); return s().impl.send(sessionId, text); }
export function terminalSessionStatus(sessionId) { record("status", { sessionId }); return s().impl.status(sessionId); }
export function listTerminalSessions() { record("list", {}); return s().impl.list(); }
export function stopTerminalSession(sessionId) { record("stop", { sessionId }); return s().impl.stop(sessionId); }
export function closeTerminalSession(sessionId) { record("close", { sessionId }); return s().impl.close(sessionId); }
export function onTerminalOutput(handler) { s().output.push(handler); return () => { s().drop("output", handler); }; }
export function onTerminalExit(handler) { s().exit.push(handler); return () => { s().drop("exit", handler); }; }
export function onTerminalReady(handler) { s().ready.push(handler); return () => { s().drop("ready", handler); }; }
`;

const WORKSPACE_STUB = `
export function useWorkspaces() { return globalThis.__workspaceStub; }
`;

const ICON_STUB = `
import React from "react";
function make(name) {
  return function Icon(props) {
    return React.createElement("svg", { "data-icon": name, "aria-hidden": "true", width: props.size || 16 });
  };
}
export const ArrowsClockwise = make("ArrowsClockwise");
export const Play = make("Play");
export const Stop = make("Stop");
export const Terminal = make("Terminal");
export const Trash = make("Trash");
`;

let dom;
let React;
let ReactDOMClient;
let PanelProvider;
let usePanel;
let TerminalPane;
let model;

before(async () => {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "bridgeStub.mjs"), BRIDGE_STUB);
  writeFileSync(path.join(workDir, "workspaceStub.mjs"), WORKSPACE_STUB);
  writeFileSync(path.join(workDir, "iconStub.mjs"), ICON_STUB);

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
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");

  const shared = code =>
    code
      .replace(/^import\s+"\.\/[^"]+\.css";\s*$/m, "")
      .replace(/from "\.\/panelModel\.js"/g, 'from "./panelModel.mjs"')
      .replace(/from "\.\/PanelContext\.jsx"/g, 'from "./PanelContext.mjs"');

  async function compile(fileName, rewrite) {
    const sourcePath = path.join(panelDir, fileName);
    const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
      loader: fileName.endsWith(".jsx") ? "jsx" : "js",
      jsx: "automatic"
    });
    const outFile = path.join(workDir, fileName.replace(/\.jsx?$/, ".mjs"));
    writeFileSync(outFile, rewrite(code));
    return import(pathToFileURL(outFile).href);
  }

  model = await compile("panelModel.js", shared);
  const context = await compile("PanelContext.jsx", shared);
  PanelProvider = context.PanelProvider;
  usePanel = context.usePanel;
  TerminalPane = (
    await compile("TerminalPane.jsx", code =>
      shared(code)
        .replace(/from "\.\.\/panelTerminalBridge\.js"/g, 'from "./bridgeStub.mjs"')
        .replace(/from "\.\.\/WorkspaceContext\.jsx"/g, 'from "./workspaceStub.mjs"')
        .replace(/from "@phosphor-icons\/react"/g, 'from "./iconStub.mjs"')
    )
  ).default;
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
  delete globalThis.__terminalStub;
  delete globalThis.__workspaceStub;
});

function snapshot(id, overrides) {
  return {
    sessionId: id,
    pid: 4242,
    cwd: "C:\\scratch\\demo",
    shell: "powershell.exe",
    startedAt: 1,
    endedAt: null,
    status: "running",
    running: true,
    exitCode: null,
    inputError: null,
    transcriptTruncated: false,
    transcript: "Windows PowerShell started (pid 4242) in C:\\scratch\\demo\n",
    reused: false,
    ...overrides
  };
}

function resetStub(impl = {}, workspace = {}) {
  const stub = {
    calls: [],
    output: [],
    exit: [],
    ready: [],
    dropped: []
  };
  stub.drop = (kind, handler) => {
    const index = stub[kind].indexOf(handler);
    if (index >= 0) stub[kind].splice(index, 1);
    stub.dropped.push(kind);
  };
  stub.impl = {
    start: id => Promise.resolve(snapshot(id)),
    send: id => Promise.resolve({ sessionId: id, accepted: true, bytes: 0 }),
    status: id => Promise.resolve(snapshot(id)),
    list: () => Promise.resolve({ sessions: [], limit: 4 }),
    stop: id => Promise.resolve(snapshot(id, { status: "stopped", running: false, killed: true })),
    close: id =>
      Promise.resolve(
        snapshot(id, { status: "exited", running: false, closed: true, graceful: true, killed: false })
      ),
    ...impl
  };
  globalThis.__terminalStub = stub;
  globalThis.__workspaceStub = {
    supported: true,
    owner: "user-1",
    activeWorkspace: { id: "ws-1", title: "demo", path: "C:\\project\\demo" },
    ...workspace
  };
  return stub;
}

async function setup(options = {}) {
  const stub = resetStub(options.impl, options.workspace);
  model.writePanelState(dom.window.localStorage, {
    open: true,
    activeTab: "terminal",
    width: 460
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });

  function TabSwitch() {
    const panel = usePanel();
    return React.createElement(
      "div",
      { className: "tab-switch" },
      React.createElement("button", { type: "button", onClick: () => panel.selectTab("files") }, "show files tab"),
      React.createElement("button", { type: "button", onClick: () => panel.selectTab("terminal") }, "show terminal tab")
    );
  }

  await React.act(async () => {
    rootHandle.render(
      React.createElement(PanelProvider, null, React.createElement(TerminalPane), React.createElement(TabSwitch))
    );
  });
  await flush();
  return { container, stub, unmount: () => rootHandle.unmount() };
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

function findButton(container, label) {
  return [...container.querySelectorAll("button")].find(node =>
    `${node.textContent} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.includes(label)
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

// React tracks the value it last rendered, so assigning `input.value` directly
// is invisible to onChange; the prototype setter has to be called.
function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
}

async function setField(container, selector, value) {
  const input = container.querySelector(selector);
  await React.act(async () => {
    setValue(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function runCommand(container, command) {
  await setField(container, '.vr-terminal-input input[aria-label="PowerShell command"]', command);
  await React.act(async () => {
    container
      .querySelector(".vr-terminal-input")
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function pressKey(container, key) {
  return React.act(async () => {
    container
      .querySelector('.vr-terminal-input input[aria-label="PowerShell command"]')
      .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function emit(stub, kind, payload) {
  return React.act(async () => {
    for (const handler of [...stub[kind]]) handler(payload);
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function logText(container) {
  return container.querySelector(".vr-terminal-log").textContent;
}

function callNames(stub) {
  return stub.calls.map(call => call.name);
}

test("the pane only offers the terminal inside the Windows app", async () => {
  const { container, stub } = await setup({ workspace: { supported: false } });
  assert.match(container.textContent, /available in the Windows app/);
  assert.equal(container.querySelector(".vr-terminal-input"), null);
  assert.deepEqual(callNames(stub), []);
});

test("the first command starts PowerShell in the workspace folder and sends the line", async () => {
  const { container, stub } = await setup();
  assert.deepEqual(callNames(stub), ["list"], "no process is spawned before the user types");
  assert.match(logText(container), /No session yet/);

  await runCommand(container, "Get-ChildItem");

  assert.deepEqual(callNames(stub), ["list", "start", "send"]);
  assert.deepEqual(stub.calls[1], { name: "start", sessionId: "panel", cwd: "C:\\project\\demo" });
  assert.deepEqual(stub.calls[2], { name: "send", sessionId: "panel", text: "Get-ChildItem\n" });
  assert.match(logText(container), /Windows PowerShell started \(pid 4242\)/);
  assert.equal(container.querySelector('.vr-terminal-input input').value, "", "the prompt clears after sending");
  assert.equal(container.querySelector(".vr-terminal-state").textContent, "running");
  assert.match(container.querySelector(".vr-terminal-meta").textContent, /C:\\scratch\\demo/);
});

test("further commands reuse the live session instead of spawning another shell", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "cd src");
  await runCommand(container, "npm test");

  assert.equal(stub.calls.filter(call => call.name === "start").length, 1);
  assert.deepEqual(
    stub.calls.filter(call => call.name === "send").map(call => call.text),
    ["cd src\n", "npm test\n"]
  );
});

test("streamed output appends live and never crosses between sessions", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "Get-Location");

  await emit(stub, "output", { sessionId: "panel", stream: "stdout", text: "Path\r\n----\r\nC:\\project\\demo\r\n", at: 2 });
  await emit(stub, "output", { sessionId: "panel", stream: "stderr", text: "warning: something\r\n", at: 3 });
  await emit(stub, "output", { sessionId: "panel-2", stream: "stdout", text: "OTHER SESSION\r\n", at: 4 });

  const log = logText(container);
  assert.match(log, /C:\\project\\demo/);
  assert.match(log, /warning: something/);
  assert.equal(log.includes("OTHER SESSION"), false);
});

test("an exit event records the real status and exit code", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "exit 3");

  await emit(stub, "exit", { sessionId: "panel", exitCode: 3, status: "exited", at: 5 });

  assert.equal(container.querySelector(".vr-terminal-state").textContent, "exited");
  assert.match(container.querySelector(".vr-terminal-meta").textContent, /exit 3/);
  assert.equal(findButton(container, "Stop").disabled, true, "a dead shell cannot be stopped");
});

test("stop kills the running shell and closes the session frees the slot", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "Start-Sleep -Seconds 600");

  const stop = findButton(container, "Stop");
  assert.equal(stop.disabled, false);
  await click(stop);
  assert.deepEqual(stub.calls.find(call => call.name === "stop"), { name: "stop", sessionId: "panel" });
  assert.equal(container.querySelector(".vr-terminal-state").textContent, "stopped");
  assert.equal(findButton(container, "Stop").disabled, true);

  await click(findButton(container, "Close"));
  assert.deepEqual(stub.calls.find(call => call.name === "close"), { name: "close", sessionId: "panel" });
  assert.equal(container.querySelector(".vr-terminal-state"), null);
  assert.match(logText(container), /No session yet/);
  assert.match(container.querySelector(".vr-terminal-meta").textContent, /not started/);
});

test("a native refusal is shown instead of a silent failure", async () => {
  const { container, stub } = await setup({
    impl: {
      start: id =>
        Promise.reject(
          new Error("The panel already has 4 terminal sessions open. Close one first.")
        )
    }
  });
  await runCommand(container, "whoami");

  assert.match(
    container.querySelector(".vr-inline-error").textContent,
    /already has 4 terminal sessions open/
  );
  assert.equal(container.querySelector(".vr-terminal-state"), null);
  assert.equal(callNames(stub).includes("send"), false, "a failed start must not send input");
});

test("a rejected command reports why and keeps the session", async () => {
  const { container, stub } = await setup({
    impl: {
      send: () => Promise.reject(new Error("That terminal session has already closed."))
    }
  });
  await runCommand(container, "Get-Date");
  assert.match(container.querySelector(".vr-inline-error").textContent, /session has already closed/);
  assert.equal(container.querySelector('.vr-terminal-input input').value, "Get-Date");
});

test("the prompt recalls earlier commands with the arrow keys", async () => {
  const { container } = await setup();
  await runCommand(container, "git status");
  await runCommand(container, "git diff");
  const input = () => container.querySelector('.vr-terminal-input input');

  await pressKey(container, "ArrowUp");
  assert.equal(input().value, "git diff");
  await pressKey(container, "ArrowUp");
  assert.equal(input().value, "git status");
  await pressKey(container, "ArrowDown");
  assert.equal(input().value, "git diff");
  await pressKey(container, "ArrowDown");
  assert.equal(input().value, "");
});

test("an empty prompt never reaches the shell", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "   ");
  assert.deepEqual(callNames(stub), ["list"]);
  assert.equal(findButton(container, "Run").disabled, true);
});

test("the start folder is editable before the session exists", async () => {
  const { container, stub } = await setup();
  const folder = container.querySelector('.vr-terminal-cwd input[aria-label="Terminal working folder"]');
  assert.ok(folder, "the pane offers an explicit working folder");
  assert.equal(folder.value, "C:\\project\\demo", "it defaults to the selected workspace");

  await setField(container, '.vr-terminal-cwd input', "C:\\Windows\\Temp");
  await click(findButton(container, "New terminal session"));

  assert.deepEqual(stub.calls.find(call => call.name === "start"), {
    name: "start",
    sessionId: "panel",
    cwd: "C:\\Windows\\Temp"
  });
  assert.equal(container.querySelector(".vr-terminal-cwd"), null, "the folder is fixed while a session runs");
});

test("a second session gets its own name, log and switcher", async () => {
  const seen = [];
  const { container, stub } = await setup({
    impl: {
      start: id => {
        seen.push(id);
        return Promise.resolve(snapshot(id, { cwd: `C:\\scratch\\${id}`, transcript: `shell ${id} ready\n` }));
      }
    }
  });
  await runCommand(container, "whoami");
  await click(findButton(container, "New terminal session"));
  await flush();

  assert.deepEqual(seen, ["panel", "panel-2"]);
  assert.deepEqual(
    stub.calls.filter(call => call.name === "send").map(call => call.sessionId),
    ["panel"],
    "the new session is not sent the previous command"
  );
  const chips = [...container.querySelectorAll(".vr-terminal-chip")];
  assert.deepEqual(
    chips.map(chip => chip.textContent.replace(/running$/, "")),
    ["panel", "panel-2"]
  );
  assert.match(logText(container), /shell panel-2 ready/);

  await click(chips[0]);
  assert.match(logText(container), /shell panel ready/);
  assert.equal(logText(container).includes("panel-2"), false, "logs are kept per session");
});

test("returning to the tab re-reads the real session list and status", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "Get-Process");
  assert.deepEqual(callNames(stub), ["list", "start", "send"]);

  await click(findButton(container, "show files tab"));
  await click(findButton(container, "show terminal tab"));
  await flush();

  assert.deepEqual(callNames(stub).slice(-2), ["list", "status"]);
  assert.deepEqual(stub.calls.at(-1), { name: "status", sessionId: "panel" });
  assert.match(logText(container), /Windows PowerShell started/);
});

test("switching tabs keeps the transcript, prompt and scrollback intact", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "cargo test");
  await emit(stub, "output", { sessionId: "panel", stream: "stdout", text: "103 passed\n", at: 9 });
  await setField(container, '.vr-terminal-input input', "half-typed comm");
  const logNode = container.querySelector(".vr-terminal-log");

  await click(findButton(container, "show files tab"));
  await click(findButton(container, "show terminal tab"));
  await flush();

  assert.equal(container.querySelector(".vr-terminal-log"), logNode, "the pane must not remount");
  assert.match(logNode.textContent, /103 passed/);
  assert.equal(container.querySelector('.vr-terminal-input input').value, "half-typed comm");
});

test("the pane unsubscribes from the native streams when it goes away", async () => {
  const { stub, unmount } = await setup();
  assert.equal(stub.output.length, 1);
  assert.equal(stub.exit.length, 1);

  await React.act(async () => {
    await unmount();
  });
  assert.deepEqual(stub.dropped.sort(), ["exit", "output"]);
  assert.equal(stub.output.length, 0);
  assert.equal(stub.exit.length, 0);
});

test("clear wipes the local transcript but leaves the shell alone", async () => {
  const { container, stub } = await setup();
  await runCommand(container, "ls");
  assert.ok(logText(container).includes("started"));

  await click(findButton(container, "Clear this terminal"));
  assert.equal(logText(container).includes("started"), false);
  assert.equal(callNames(stub).includes("close"), false);
  assert.equal(callNames(stub).includes("stop"), false);
  assert.equal(container.querySelector(".vr-terminal-state").textContent, "running");
});

test("terminal styles stay on tokens and wrap long lines", () => {
  const css = readFileSync(cssPath, "utf8");
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, "panel CSS must not hard-code hex colours");
  for (const selector of [
    ".vr-terminal-pane",
    ".vr-terminal-log",
    ".vr-terminal-input",
    ".vr-terminal-chip",
    ".vr-terminal-state[data-status=\"running\"]",
    ".vr-terminal-hint"
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.match(css, /\.vr-terminal-log\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /\.vr-terminal-log\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.vr-terminal-pane\s*\{[^}]*flex:\s*1/);
});
