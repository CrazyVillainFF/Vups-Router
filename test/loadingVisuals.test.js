import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-loaders");
const read = relative => readFileSync(path.join(root, relative), "utf8");

// The loaders are JSX with a package import and two stylesheet imports, so the
// test compiles the React components into a sibling directory and drops the
// CSS (Node cannot import it). AgentActivity is compiled too so its active
// lifecycle can be rendered for real instead of only pattern-matched.
const COMPILED = {
  "components/LoadingVisuals.jsx": "LoadingVisuals.mjs",
  "components/AgentActivity.jsx": "AgentActivity.mjs",
  "components/reactbits/ThoughtLine.jsx": "ThoughtLine.mjs"
};

async function compileAll() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [relative, name] of Object.entries(COMPILED)) {
    const from = path.join(srcDir, relative);
    const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
      loader: "jsx",
      jsx: "automatic"
    });
    const withoutCss = code.replace(/^import\s+["'][^"']+\.css["'];\s*$/gm, "");
    const rewritten = withoutCss.replace(/from "(\.[^"]*)"/g, (match, specifier) => {
      if (specifier.endsWith(".css")) return match;
      const target = path.resolve(path.dirname(from), specifier);
      const targetRelative = path.relative(srcDir, target).split(path.sep).join("/");
      if (COMPILED[targetRelative]) return `from "./${COMPILED[targetRelative]}"`;
      return `from "${path.relative(outDir, target).split(path.sep).join("/")}"`;
    });
    writeFileSync(path.join(outDir, name), rewritten);
  }
}

let dom;
let React;
let ReactDOMClient;
let LoadingVisuals;
let AgentActivity;
const mounted = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: "https://vups.test/",
    pretendToBeVisual: true
  });
  const matchMedia = query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false
  });
  dom.window.matchMedia = matchMedia;
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeList: dom.window.NodeList,
    HTMLCollection: dom.window.HTMLCollection,
    SVGElement: dom.window.SVGElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    matchMedia,
    ResizeObserver: ResizeObserverStub,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  // `navigator` is a read-only accessor on Node's global, so these have to be
  // redefined rather than assigned.
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  await compileAll();
  LoadingVisuals = await import(pathToFileURL(path.join(outDir, "LoadingVisuals.mjs")).href);
  AgentActivity = (await import(pathToFileURL(path.join(outDir, "AgentActivity.mjs")).href)).default;
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
  dom.window.close();
  rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => {
    rootHandle.render(element);
  });
  return container;
}

function ldrsBox(wrapper) {
  return wrapper.firstElementChild;
}

test("Quantum is the centered page loader with the documented props", async () => {
  const container = render(
    React.createElement(LoadingVisuals.QuantumLoader, { label: "Checking your session" })
  );
  const status = container.querySelector('[role="status"]');
  assert.ok(status, "the page loader is a live status region");
  assert.equal(status.getAttribute("aria-label"), "Checking your session");
  assert.match(status.className, /vr-loader--quantum/);

  const box = ldrsBox(status);
  assert.match(box.className, /container_/, "the official Quantum component renders it");
  assert.equal(box.style.getPropertyValue("--uib-size"), "30px");
  assert.equal(box.style.getPropertyValue("--uib-speed"), "1.75s");
  assert.match(
    box.style.getPropertyValue("--uib-color"),
    /--vr-loader-color/,
    "the color follows the app theme token"
  );
  assert.equal(
    status.querySelectorAll('[class^="particle_"]').length,
    12,
    "Quantum's twelve orbiting particles are present"
  );
});

test("Quantum can stay decorative inside an existing status region", async () => {
  const container = render(React.createElement(LoadingVisuals.QuantumLoader, { decorative: true }));
  assert.equal(container.querySelector('[role="status"]'), null, "no second live region");
  const wrapper = container.querySelector(".vr-loader--quantum");
  assert.equal(wrapper.getAttribute("aria-hidden"), "true");
  assert.ok(ldrsBox(wrapper), "the animation still renders");
});

test("Bouncy is compact and hidden from assistive tech", async () => {
  const container = render(React.createElement(LoadingVisuals.ThinkingBouncy));
  const wrapper = container.querySelector(".vr-loader--bouncy");
  assert.ok(wrapper, "the thinking marker renders");
  assert.equal(wrapper.getAttribute("aria-hidden"), "true");
  const box = ldrsBox(wrapper);
  assert.match(box.className, /container_/);
  assert.equal(box.style.getPropertyValue("--uib-size"), "22px");
  assert.equal(box.style.getPropertyValue("--uib-speed"), "1.75s");
  const cubes = [...wrapper.querySelectorAll("div[class^='cube_']")].filter(
    node => !node.className.startsWith("cube__")
  );
  assert.equal(cubes.length, 3, "Bouncy's three bouncing cubes are present");
});

test("Bouncy exists only while the turn is active", async () => {
  const events = [
    {
      id: "step-1",
      phase: "responding",
      status: "running",
      label: "Generating response",
      startedAt: Date.now() - 1500,
      endedAt: null
    }
  ];
  const live = render(
    React.createElement(AgentActivity, { events, active: true, status: "streaming" })
  );
  assert.equal(
    live.querySelectorAll(".vr-activity__loader").length,
    1,
    "one thinking animation for the active request"
  );
  assert.match(live.querySelector(".vr-activity__loader").className, /vr-loader--bouncy/);

  const settled = render(
    React.createElement(AgentActivity, { events, active: false, status: "completed" })
  );
  assert.equal(settled.querySelectorAll(".vr-activity__loader").length, 0);
  assert.match(settled.textContent, /Generating response|Thought for|Done thinking/);

  const failed = render(
    React.createElement(AgentActivity, { events, active: false, status: "failed" })
  );
  assert.equal(failed.querySelectorAll(".vr-activity__loader").length, 0);

  const stopped = render(
    React.createElement(AgentActivity, { events, active: false, status: "cancelled" })
  );
  assert.equal(stopped.querySelectorAll(".vr-activity__loader").length, 0);

  const empty = render(React.createElement(AgentActivity, { events: [], active: false }));
  assert.equal(empty.textContent, "", "a finished turn with no steps leaves no indicator behind");
});

test("page-level loading states render Quantum and retire it with the real state", () => {
  const auth = read("src/components/RequireAuth.jsx");
  assert.match(auth, /import \{ QuantumLoader \} from "\.\/LoadingVisuals\.jsx";/);
  assert.match(auth, /if \(status === "loading"\)/);
  assert.match(auth, /<QuantumLoader label="Checking your session" \/>/);
  assert.doesNotMatch(auth, /CircularProgress/, "the old page spinner is gone");
  // The unavailable branch still owns the failure UI, so the loader is never permanent.
  assert.match(auth, /if \(status === "unavailable"\)/);
  assert.match(auth, /sessionError \|\| "Could not check your session\./);

  const app = read("src/App.jsx");
  assert.match(app, /import \{ QuantumLoader \} from "\.\/components\/LoadingVisuals\.jsx";/);
  assert.match(app, /<QuantumLoader label="Loading motion lab" \/>/);

  const desktopAuth = read("src/pages/DesktopAuthPage.jsx");
  assert.match(desktopAuth, /<QuantumLoader label="Checking your session" \/>/);

  const plugins = read("src/plugins/PluginsPage.jsx");
  assert.match(plugins, /import \{ QuantumLoader \} from "\.\.\/components\/LoadingVisuals\.jsx";/);
  assert.match(plugins, /<QuantumLoader decorative \/>/);
  assert.match(plugins, /className="vr-plugin-loading" role="status"/);
});

test("the chat wires Bouncy to the single real streaming turn", () => {
  const page = read("src/ChatPage.jsx");
  const agent = read("src/components/AgentActivity.jsx");

  assert.match(agent, /import \{ ThinkingBouncy \} from "\.\/LoadingVisuals\.jsx";/);
  assert.match(agent, /\{active \? <ThinkingBouncy className="vr-activity__loader" \/> : null\}/);
  // AgentActivity is rendered once per assistant turn and only the current turn
  // receives isStreaming, so a request can never stack two thinking animations.
  assert.equal((page.match(/<AgentActivity/g) || []).length, 1);
  assert.match(page, /active=\{isStreaming\}/);
  assert.doesNotMatch(page, /ThinkingBouncy/, "the animation lives in one component only");

  const visuals = read("src/components/LoadingVisuals.jsx");
  assert.match(visuals, /import \{ Quantum \} from "ldrs\/react";/);
  assert.match(visuals, /import "ldrs\/react\/Quantum\.css";/);
  assert.match(visuals, /import \{ Bouncy \} from "ldrs\/react";/);
  assert.match(visuals, /import "ldrs\/react\/Bouncy\.css";/);
  assert.match(visuals, /<Quantum size="30" speed="1\.75" color="var\(--vr-loader-color, var\(--accent, #6c9bff\)\)" \/>/);
  assert.match(visuals, /<Bouncy size="22" speed="1\.75" color="var\(--vr-loader-color, var\(--accent, #6c9bff\)\)" \/>/);
});

test("reduced motion pauses both loaders on a visible frame", () => {
  const css = read("src/components/LoadingVisuals.css");
  assert.match(css, /--vr-loader-color: var\(--accent, #6c9bff\)/);
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(reduce, /animation-play-state: paused !important/);
  assert.match(reduce, /animation-duration: var\(--uib-speed, 1\.75s\) !important/);
  assert.doesNotMatch(reduce, /display:\s*none|visibility:\s*hidden|opacity:\s*0/);
});
