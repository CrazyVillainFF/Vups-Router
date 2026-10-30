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
  // The expiry countdown is a live interval, so every card has to unmount or the
  // process never drains.
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

const folderRequest = {
  requestId: "req-folder",
  approvalKey: "u1|read|c:\\users\\vishnu\\downloads",
  tool: "list_recent_files",
  action: "recent",
  scopePath: "C:\\Users\\Vishnu\\Downloads",
  scopeName: "Downloads",
  summary: "List the most recent files in C:\\Users\\Vishnu\\Downloads (newest 5 files)",
  access: "read",
  readOnly: true,
  expiresAt: Date.now() + 60_000
};

const buttons = container =>
  [...container.querySelectorAll(".vr-permission-card__actions button")].map(button => button.textContent.trim());

function click(container, index) {
  const button = container.querySelectorAll(".vr-permission-card__actions button")[index];
  React.act(() => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
}

test("the rendered card names the folder, the operation and the waiting state", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, { request: folderRequest, busy: false, error: "", onRespond() {} })
  );

  const text = container.textContent;
  assert.match(text, /VupsRouter wants to access Downloads/);
  assert.match(text, /List filenames and read file metadata/);
  assert.match(text, /Waiting for approval/);
  assert.doesNotMatch(text, /Access granted|Completed/, "a card that only asks grants nothing");

  const pathNode = container.querySelector(".vr-permission-card__path");
  assert.equal(pathNode.textContent, "C:\\Users\\Vishnu\\Downloads");
  assert.doesNotMatch(pathNode.textContent, /^\\\\\?\\/, "no verbatim Windows path in the UI");

  assert.deepEqual(buttons(container), ["Allow once", "Always allow for this folder", "Deny"]);
});

test("a button press reports the decision and nothing else", async () => {
  const { default: Card } = await loadCard();
  const sent = [];
  const container = render(
    React.createElement(Card, { request: folderRequest, busy: false, error: "", onRespond: decision => sent.push(decision) })
  );
  click(container, 0);
  click(container, 1);
  click(container, 2);
  assert.deepEqual(sent, ["once", "always", "deny"]);
});

test("a file-contents request never offers a folder-wide grant", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, {
      request: { ...folderRequest, requestId: "req-file", access: "contents", action: "contents", scopeName: "notes.txt" },
      busy: false,
      error: "",
      onRespond() {}
    })
  );
  assert.match(container.textContent, /VupsRouter wants to access notes\.txt/);
  assert.match(container.textContent, /Read the contents of one file/);
  assert.deepEqual(buttons(container), ["Allow once", "Deny"]);
});

test("while a decision is in flight the card is a loading state, not a result", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, { request: folderRequest, busy: true, error: "", onRespond() {} })
  );
  assert.match(container.textContent, /Applying your decision/);
  const all = [...container.querySelectorAll(".vr-permission-card__actions button")];
  assert.ok(all.every(button => button.disabled), "no second decision while one is being applied");
});

test("a delivery failure stays on the card instead of disappearing", async () => {
  const { default: Card } = await loadCard();
  const container = render(
    React.createElement(Card, {
      request: folderRequest,
      busy: false,
      error: "The local tool layer rejected that decision.",
      onRespond() {}
    })
  );
  const alert = container.querySelector('[role="alert"]');
  assert.equal(alert.textContent, "The local tool layer rejected that decision.");
});
