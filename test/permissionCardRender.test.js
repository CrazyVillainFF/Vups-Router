import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cardSourcePath = path.join(root, "src", "native", "InChatPermissionCard.jsx");
// Each render test owns its scratch directory: node --test runs files in
// parallel processes, and two suites sharing one folder delete each other's
// in-flight esbuild output.
const workDir = path.join(root, "test", ".compiled-permcard");

// The card is plain JSX and this project has no bundler-driven test runner, so
// it is compiled with Vite's own esbuild pipeline into a directory under the
// project, where its bare `react` specifiers still resolve.
async function loadCard() {
  mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, "InChatPermissionCard.mjs");
  const { code } = await transformWithEsbuild(readFileSync(cardSourcePath, "utf8"), cardSourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  writeFileSync(outFile, code);
  return import(pathToFileURL(outFile).href);
}

let dom;
let React;
let ReactDOMClient;
const mounted = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  // `navigator` is a read-only accessor on Node's global, so these have to be
  // redefined rather than assigned.
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => { rootHandle.render(element); });
  return container;
}

const fileRequest = {
  requestId: "req-file",
  approvalKey: "u1|contents|c:\\users\\vishnu\\downloads\\notes.txt",
  tool: "read_file",
  action: "contents",
  scopePath: "C:\\Users\\Vishnu\\Downloads\\notes.txt",
  scopeName: "notes.txt",
  summary: "Read notes.txt",
  access: "contents",
  readOnly: true,
  canPersist: true
};

const buttons = container =>
  [...container.querySelectorAll(".vr-permission-card__actions button")].map(button => button.textContent.trim());

const buttonStates = container =>
  [...container.querySelectorAll(".vr-permission-card__actions button")].map(button => button.disabled);

function click(container, index) {
  const button = container.querySelectorAll(".vr-permission-card__actions button")[index];
  React.act(() => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
}

test("the compact card names the action, the file and its location", async () => {
  const { default: Card } = await loadCard();
  const container = render(React.createElement(Card, { request: fileRequest, busy: false, error: "", onRespond() {} }));

  const text = container.textContent;
  assert.match(text, /VupsRouter wants permission/);
  assert.match(text, /Read a file/);
  assert.match(text, /File/);
  assert.match(text, /notes\.txt/);
  assert.match(text, /Location/);
  assert.match(text, /C:\\Users\\Vishnu\\Downloads/);

  const pathNode = container.querySelector(".vr-permission-card__path");
  assert.equal(pathNode.textContent, "C:\\Users\\Vishnu\\Downloads");
  assert.equal(pathNode.getAttribute("title"), "C:\\Users\\Vishnu\\Downloads", "the full path stays available");
  assert.doesNotMatch(pathNode.textContent, /^\\\\\?\\/, "no verbatim Windows path in the UI");

  assert.deepEqual(buttons(container), ["Allow Once", "Allow Always (Only for This File)", "Deny"]);
  assert.deepEqual(buttonStates(container), [false, false, false], "an exact file can be remembered");

  // The previous card explained at length; the new one is only the request.
  assert.doesNotMatch(text, /Access requested|Changes your data|Approving this covers|Waiting for approval|Expires in/);
});

test("a button press reports the decision and nothing else", async () => {
  const { default: Card } = await loadCard();
  const sent = [];
  const container = render(
    React.createElement(Card, {
      request: fileRequest,
      busy: false,
      error: "",
      onRespond: decision => sent.push(decision)
    })
  );
  click(container, 0);
  click(container, 1);
  click(container, 2);
  assert.deepEqual(sent, ["once", "always", "deny"]);
});

test("folder requests keep Allow Always visible but cannot use it", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-folder",
        tool: "list_recent_files",
        action: "recent",
        access: "read",
        scopePath: "C:\\Users\\Vishnu\\Downloads",
        scopeName: "Downloads",
        canPersist: false
      },
      busy: false,
      error: "",
      onRespond() {}
    })
  );

  assert.match(container.textContent, /List recent files/);
  assert.match(container.textContent, /Folder/);
  assert.match(container.textContent, /Downloads/);
  assert.match(container.textContent, /Only a single file or app can be remembered/);
  assert.deepEqual(buttons(container), ["Allow Once", "Allow Always (Only for This File)", "Deny"]);
  assert.deepEqual(buttonStates(container), [false, true, false], "a folder is never a saved grant");

  const [folderLabel] = [...container.querySelectorAll(".vr-permission-card__row dt")].map(node => node.textContent);
  assert.equal(folderLabel, "Folder");
});

test("write, delete, command and terminate cards show the real target and risk", async () => {
  const { default: Card } = await loadCard();

  const write = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-write",
        tool: "write_file",
        action: "write",
        access: "write",
        scopePath: "C:\\tmp\\agent-test.txt",
        scopeName: "agent-test.txt",
        readOnly: false,
        modifiesData: true,
        canPersist: false
      },
      onRespond() {}
    })
  );
  assert.match(write.textContent, /Write a file/);
  assert.match(write.textContent, /agent-test\.txt/);
  assert.match(write.textContent, /C:\\tmp/);
  assert.match(write.textContent, /This changes a file on your PC\./);
  assert.deepEqual(buttons(write), ["Allow Once", "Allow Always (Only for This File)", "Deny"]);
  assert.deepEqual(buttonStates(write), [false, true, false]);

  const remove = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-delete",
        tool: "delete_path",
        action: "delete",
        access: "delete",
        scopePath: "C:\\tmp\\agent-test.txt",
        scopeName: "agent-test.txt",
        readOnly: false,
        destructive: true,
        canPersist: false
      },
      onRespond() {}
    })
  );
  assert.match(remove.textContent, /Delete an item permanently/);
  assert.match(remove.textContent, /This cannot be undone\./);
  assert.deepEqual(buttonStates(remove), [false, true, false]);

  const command = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-command",
        tool: "run_command",
        action: "command",
        access: "execute",
        scopePath: "C:\\project\\Vups Router",
        scopeName: "Vups Router",
        summary: "Run the client test suite",
        readOnly: false,
        modifiesData: true,
        command: "npm test",
        details: ["Shell: powershell", "Working folder: C:\\project\\Vups Router"],
        canPersist: false
      },
      onRespond() {}
    })
  );
  assert.match(command.textContent, /Run a command/);
  assert.match(command.textContent, /npm test/);
  assert.match(command.textContent, /Location/);
  assert.match(command.textContent, /C:\\project\\Vups Router/);
  assert.match(command.textContent, /This runs a command on your PC\./);
  assert.deepEqual(buttonStates(command), [false, true, false]);

  const terminate = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-terminate",
        tool: "close_app",
        action: "terminate",
        access: "launch",
        scopePath: "Process 4242",
        scopeName: "Process 4242",
        readOnly: false,
        destructive: true,
        canPersist: false
      },
      onRespond() {}
    })
  );
  assert.match(terminate.textContent, /Force-close an app/);
  assert.match(terminate.textContent, /Process 4242/);
  assert.match(terminate.textContent, /This cannot be undone\./);
  assert.doesNotMatch(terminate.textContent, /Location/, "a process id is not a filesystem location");
  assert.deepEqual(buttonStates(terminate), [false, true, false]);
});

test("an exact executable can be remembered, and its location is the containing folder", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, {
      request: {
        ...fileRequest,
        requestId: "req-launch",
        tool: "launch_app",
        action: "launch",
        access: "launch",
        scopePath: "C:\\ProgramData\\chocolatey\\bin\\blender.exe",
        scopeName: "Blender",
        readOnly: false,
        canPersist: true
      },
      onRespond() {}
    })
  );
  assert.match(container.textContent, /Launch an app/);
  assert.match(container.textContent, /App/);
  assert.match(container.textContent, /blender\.exe/, "the exact executable file is named");
  assert.match(container.textContent, /C:\\ProgramData\\chocolatey\\bin/);
  assert.deepEqual(buttonStates(container), [false, false, false], "one executable can be saved");
  assert.doesNotMatch(container.textContent, /This changes|This runs a command/);
});

test("while a decision is in flight the card is a loading state, not a result", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, { request: fileRequest, busy: true, error: "", onRespond() {} })
  );
  assert.match(container.textContent, /Applying…/);
  const all = [...container.querySelectorAll(".vr-permission-card__actions button")];
  assert.ok(all.every(button => button.disabled), "no second decision while one is being applied");
});

test("a delivery failure stays on the card instead of disappearing", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, {
      request: fileRequest,
      busy: false,
      error: "The local tool layer rejected that decision.",
      onRespond() {}
    })
  );
  const alert = container.querySelector('[role="alert"]');
  assert.equal(alert.textContent, "The local tool layer rejected that decision.");
});
