import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
// Own scratch directory: node --test runs files in parallel processes and two
// render suites sharing one folder delete each other's in-flight output.
const workDir = path.join(root, "test", ".compiled-boundary");

/* The brief's §10 black-screen test. A crash inside the chat used to unmount the
   whole React tree, and because the dark palette paints #0f0e0c the reader was
   left with a black window and no action in it — in the Windows and Android
   shells, where there is no browser chrome to reload from. So this is not a
   styling check: the assertions below are that the document survives, the card
   states what happened in the user's own terms, and a real control brings the
   screen back. */

async function loadBoundary() {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "styleStub.mjs"), "export default {};\n");
  const outFile = path.join(workDir, "AppBoundary.mjs");
  const from = path.join(srcDir, "components", "AppBoundary.jsx");
  const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
    loader: "jsx",
    jsx: "automatic"
  });
  // jsdom does not resolve stylesheets; the CSS itself is checked from source.
  const rewritten = code.replace(/import "\.\/AppBoundary\.css";/, 'import "./styleStub.mjs";');
  writeFileSync(outFile, rewritten);
  return (await import(pathToFileURL(outFile).href)).default;
}

let dom;
let React;
let ReactDOMClient;
let AppBoundary;
const mounted = [];
let logged;

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
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  AppBoundary = await loadBoundary();
  // React re-reports a caught error through console.error, and the boundary
  // logs the stack there on purpose. Captured so the assertions can prove the
  // stack goes to the console and never into the visible card.
  logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  globalThis.__restoreConsole = () => { console.error = original; };
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      await entry.root.unmount();
      entry.container.remove();
    }
  });
});

after(() => {
  globalThis.__restoreConsole?.();
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => { rootHandle.render(element); });
  return container;
}

// The throwing child is driven by a flag rather than a closure so the same tree
// can be re-rendered after the boundary resets, exactly like a real screen
// recovering once the reason it crashed has gone away.
let breakScreen = true;
const CRASH_MESSAGE = "Cannot read properties of undefined (reading 'messages')";
const CRASH_STACK = "at BrokenScreen (hidden)\nsecret rendered stack line";

function BrokenScreen() {
  if (breakScreen) {
    throw Object.assign(new Error(CRASH_MESSAGE), { stack: CRASH_STACK });
  }
  return React.createElement("div", { className: "screen" }, "composer and transcript");
}

function Throws({ message }) {
  throw new Error(message);
}

function shell() {
  return React.createElement(
    "div",
    { className: "app-shell" },
    React.createElement("header", null, "VupsRouter sidebar stays"),
    React.createElement(AppBoundary, null, React.createElement(BrokenScreen)),
    React.createElement("footer", null, "status bar")
  );
}

function click(element) {
  React.act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

test("a crash inside the chat leaves the rest of the document standing", () => {
  breakScreen = true;
  const container = render(shell());
  assert.equal(container.querySelectorAll(".vr-boundary").length, 1, "the boundary replaced only its own subtree");
  assert.equal(container.querySelector("header").textContent, "VupsRouter sidebar stays");
  assert.equal(container.querySelector("footer").textContent, "status bar");
  assert.equal(container.querySelector(".screen"), null, "the crashed screen is gone, not half-painted");
});

test("the card is announced, says what happened, and offers a real action", () => {
  breakScreen = true;
  const container = render(shell());
  const card = container.querySelector(".vr-boundary");
  assert.equal(card.getAttribute("role"), "alert", "a screen that dies mid-conversation must interrupt politely");
  assert.match(card.querySelector(".vr-boundary__title").textContent, /stopped responding/i);
  assert.match(card.querySelector(".vr-boundary__copy").textContent, /conversation is saved/i);
  const buttons = [...card.querySelectorAll("button")];
  assert.deepEqual(buttons.map(b => b.textContent.trim()), ["Try again"],
    "an in-chat crash is recoverable without reloading the whole app");
  for (const button of buttons) assert.equal(button.getAttribute("type"), "button", "no implicit form submit");
});

test("the diagnostic shown is the provider's sentence, never the stack", () => {
  breakScreen = true;
  const container = render(shell());
  const detail = container.querySelector(".vr-boundary__detail code").textContent;
  assert.equal(detail, CRASH_MESSAGE);
  assert.ok(!container.textContent.includes("hidden"), "the component stack stays out of the DOM");
  assert.ok(!container.textContent.includes("secret rendered stack line"));
  assert.ok(logged.some(args => String(args[1]?.message || args[1]).includes("messages")),
    "the console keeps the real error for debugging");
});

test("an over-long provider message is capped instead of flooding the card", () => {
  breakScreen = true;
  const container = render(
    React.createElement(
      AppBoundary,
      null,
      React.createElement(Throws, { message: "x".repeat(900) })
    )
  );
  const detail = container.querySelector(".vr-boundary__detail code").textContent;
  assert.equal(detail.length, 240, `visible detail is truncated (${detail.length})`);
});

test("Try again re-renders the screen once the cause is gone", () => {
  breakScreen = true;
  const container = render(shell());
  assert.equal(container.querySelector(".screen"), null);
  const before = container.querySelector("header").textContent;

  breakScreen = false;
  click(container.querySelector(".vr-boundary__primary"));

  assert.ok(container.querySelector(".screen"), "the chat comes back without a reload");
  assert.equal(container.querySelector(".vr-boundary"), null, "the card retires on success");
  assert.equal(container.querySelector("header").textContent, before, "the shell was never remounted");
});

test("Try again on a screen that still crashes shows the card again, not a blank page", () => {
  breakScreen = true;
  const container = render(shell());
  click(container.querySelector(".vr-boundary__primary"));
  assert.ok(container.querySelector(".vr-boundary"), "retrying a live crash stays honest");
  assert.equal(container.querySelector(".screen"), null);
});

test("the page variant is the last resort for the whole app", () => {
  breakScreen = true;
  const container = render(
    React.createElement(
      AppBoundary,
      { variant: "page" },
      React.createElement(BrokenScreen)
    )
  );
  const card = container.querySelector(".vr-boundary");
  assert.match(card.className, /vr-boundary--page/, "full-height so the shell never shows bare background");
  assert.match(card.querySelector(".vr-boundary__title").textContent, /could not open this screen/i);
  assert.match(card.querySelector(".vr-boundary__copy").textContent, /Nothing you sent has been lost/i);
  assert.deepEqual(
    [...card.querySelectorAll("button")].map(b => b.textContent.trim()),
    ["Try again", "Reload the app"],
    "a dead app shell needs a reload path as well as a remount"
  );
});

test("the boundary wraps the chat route and the app root, not a decorative pane", () => {
  const app = readFileSync(path.join(srcDir, "App.jsx"), "utf8");
  const main = readFileSync(path.join(srcDir, "main.jsx"), "utf8");
  assert.match(
    app,
    /<Route path="\/chat" element=\{<>\s*<PageMeta[^>]*noIndex \/>\s*<AppBoundary><ChatPage \/><\/AppBoundary><\/>/,
    "the chat screen is the one that must survive a throw"
  );
  assert.match(main, /<AppBoundary variant="page">\s*<ThemedApp \/>\s*<\/AppBoundary>/,
    "the document root is guarded so a stale chunk cannot leave a black window");
});

test("the boundary is styled from tokens only", () => {
  const css = readFileSync(path.join(srcDir, "components", "AppBoundary.css"), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no raw colour literal outside tokens.css");
  for (const required of ["vr-boundary--page", "vr-boundary__primary", "vr-boundary__secondary"]) {
    assert.ok(css.includes(required), `.${required} is defined`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-theme="light"\] \.vr-boundary/);
});
