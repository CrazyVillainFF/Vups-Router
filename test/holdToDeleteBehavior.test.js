import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Compiled modules have to live under the project so their bare `react` and
// `@phosphor-icons/react` specifiers still resolve against client/node_modules.
const workDir = path.join(root, "test", ".compiled");

// The component tree is plain JSX and this project has no bundler-driven test
// runner, so compile it with Vite's own esbuild pipeline. Each relative import is
// rewritten onto its compiled sibling inside workDir, keeping the graph loadable by
// plain Node.
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

// Each install replaces the same handful of globals, so the originals are captured
// once and restored only when the whole suite is finished. Tearing them down
// between tests would leave React's deferred cleanups pointing at a missing window.
const savedDescriptors = new Map();

function restoreGlobals() {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  savedDescriptors.clear();
}

function installDom({ reducedMotion = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://vups.test/"
  });
  const { window } = dom;
  let now = 1000;
  const frames = [];

  window.matchMedia = query => ({
    media: query,
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  window.requestAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  window.cancelAnimationFrame = id => {
    if (id > 0 && id <= frames.length) frames[id - 1] = undefined;
  };

  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    self: window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    // jsdom's window.performance is read-only, and the component calls bare
    // performance.now(), which resolves to this global instead.
    performance: {
      now: () => now,
      timeOrigin: 0,
      mark: () => {},
      measure: () => {},
      clearMarks: () => {},
      clearMeasures: () => {}
    },
    IS_REACT_ACT_ENVIRONMENT: true
  };
  // Several of these (navigator, performance) are read-only accessors on Node's
  // global, so they have to be redefined rather than assigned.
  for (const [key, value] of Object.entries(globals)) {
    if (!savedDescriptors.has(key)) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  const clock = {
    advance: ms => { now += ms; },
    runFrames: () => {
      const pending = frames.splice(0, frames.length);
      for (const frame of pending) frame?.(now);
    }
  };

  return {
    window,
    clock,
    container: window.document.getElementById("root")
  };
}

describe("hold-to-delete behaviour", () => {
  let HoldToDeleteButton;
  let HoldToDeleteDialog;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];

  before(async () => {
    mkdirSync(workDir, { recursive: true });
    HoldToDeleteButton = (await loadModule("src/components/HoldToDeleteButton.jsx")).default;
    HoldToDeleteDialog = (await loadModule("src/components/HoldToDeleteDialog.jsx")).default;
    React = await import("react");
    ReactDOMClient = await import("react-dom/client");
  });

  after(async () => {
    // Let any timer React still needs to clean up fire before the globals go away.
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
    const button = dom.container.querySelector("button.vr-hold-delete-button");
    return {
      button,
      unmount() {
        if (entry.disposed) return;
        entry.disposed = true;
        React.act(() => rootHandle.unmount());
      }
    };
  }

  const press = view => React.act(() => {
    view.button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });

  const release = view => React.act(() => {
    view.button.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: " ", bubbles: true }));
  });

  const holdFor = (view, ms, stepMs = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      dom.clock.advance(stepMs);
      React.act(() => { dom.clock.runFrames(); });
    }
  };

  const progressOf = view => Number(view.button.style.getPropertyValue("--hold-progress"));

  // The dialog awaits an async onConfirm, so the state update lands in a promise
  // continuation; it has to be driven from inside act() to be observable.
  const flush = async () => {
    await React.act(async () => {
      await new Promise(resolve => { setTimeout(resolve, 0); });
    });
  };

  test("releasing early cancels and never deletes", () => {
    let calls = 0;
    const view = render(React.createElement(HoldToDeleteButton, { onHold: () => { calls += 1; } }));

    press(view);
    holdFor(view, 800);
    assert.ok(progressOf(view) > 0, "the fill should advance while holding");
    assert.equal(calls, 0);

    release(view);
    assert.equal(view.button.dataset.phase, "idle");
    assert.equal(progressOf(view), 0, "releasing early must reset progress");

    holdFor(view, 3000);
    assert.equal(calls, 0, "a cancelled hold must never delete");
    view.unmount();
  });

  test("a complete hold fires the deletion exactly once", () => {
    let calls = 0;
    const view = render(React.createElement(HoldToDeleteButton, { onHold: () => { calls += 1; } }));

    press(view);
    holdFor(view, 1900);
    assert.equal(calls, 1);
    assert.equal(view.button.dataset.phase, "done");

    // Neither a stray key release nor a further hold may re-fire the deletion.
    release(view);
    press(view);
    holdFor(view, 3000);
    assert.equal(calls, 1, "a completed hold must not delete twice");
    view.unmount();
  });

  test("the hold threshold is the configured duration, not shorter", () => {
    let calls = 0;
    const view = render(
      React.createElement(HoldToDeleteButton, { onHold: () => { calls += 1; }, holdTime: 1600 })
    );

    press(view);
    holdFor(view, 1500);
    assert.equal(calls, 0, "deleting before the full hold would defeat the confirmation");
    holdFor(view, 200);
    assert.equal(calls, 1);
    view.unmount();
  });

  test("reduced motion steps the fill instead of sweeping it", () => {
    dom = installDom({ reducedMotion: true });
    const view = render(React.createElement(HoldToDeleteButton, { onHold: () => {} }));
    assert.equal(view.button.dataset.reducedMotion, "", "the component must observe the preference");

    press(view);
    dom.clock.advance(100); // raw progress 0.0625
    React.act(() => { dom.clock.runFrames(); });
    assert.equal(progressOf(view), 0.25, "progress should snap to a discrete step");

    dom.clock.advance(450); // raw progress 0.34375
    React.act(() => { dom.clock.runFrames(); });
    assert.equal(progressOf(view), 0.5);
    view.unmount();
  });

  test("a pointer release before the threshold deletes nothing", () => {
    let calls = 0;
    const view = render(React.createElement(HoldToDeleteButton, { onHold: () => { calls += 1; } }));

    React.act(() => {
      view.button.dispatchEvent(new dom.window.PointerEvent("pointerdown", {
        bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, clientX: 10, clientY: 10
      }));
    });
    holdFor(view, 700);
    React.act(() => {
      view.button.dispatchEvent(new dom.window.PointerEvent("pointerup", {
        bubbles: true, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10
      }));
    });
    assert.equal(calls, 0);
    assert.equal(view.button.dataset.phase, "idle");

    holdFor(view, 3000);
    assert.equal(calls, 0);
    view.unmount();
  });

  test("the dialog deletes once and reports success", async () => {
    let calls = 0;
    const view = render(
      React.createElement(HoldToDeleteDialog, {
        open: true,
        itemName: "Old notes",
        onConfirm: async () => { calls += 1; },
        onCancel: () => {}
      })
    );
    assert.equal(dom.container.querySelector(".vr-hold-delete-dialog").getAttribute("role"), "alertdialog");
    assert.match(dom.container.textContent, /Old notes/);

    press(view);
    holdFor(view, 1900);
    await flush();
    assert.equal(calls, 1);
    assert.match(dom.container.textContent, /Deleted/, "success must follow a real deletion");
    view.unmount();
  });

  test("a failed backend deletion reports the error and never claims success", async () => {
    let calls = 0;
    const view = render(
      React.createElement(HoldToDeleteDialog, {
        open: true,
        itemName: "Old notes",
        onConfirm: async () => {
          calls += 1;
          throw new Error("Server refused the delete.");
        },
        onCancel: () => {}
      })
    );

    press(view);
    holdFor(view, 1900);
    await flush();
    assert.equal(calls, 1);
    assert.match(dom.container.textContent, /Server refused the delete/, "backend failures must surface");
    assert.doesNotMatch(dom.container.textContent, /Deleted/, "a failed delete must not claim success");
    view.unmount();
  });
});
