import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { buildCoreLayout } from "../src/combo/comboCoreLayout.js";
import { buildProviderNetwork } from "../src/combo/comboProviders.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-combo");
const CORE_SIZE = { width: 960, height: 600 };

// The power core is JSX with a CSS import, so it is compiled through Vite's
// esbuild pipeline next to its plain-JavaScript dependencies; only the CSS is
// replaced with an empty module because jsdom does not resolve stylesheets.
const COMPILED = ["combo/ComboPowerCore.jsx", "components/VupsLogo.jsx"];

function compiledName(relative) {
  return path.basename(relative).replace(/\.(jsx|js)$/, ".mjs");
}

async function compileAll() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "comboCss.mjs"), "export default {};\n");
  for (const relative of COMPILED) {
    const from = path.join(srcDir, relative);
    const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
      loader: "jsx",
      jsx: "automatic"
    });
    const rewritten = code
      .replace(/import "\.\/combo\.css";/g, 'import "./comboCss.mjs";')
      .replace(/from "(\.[^"]*)"/g, (match, specifier) => {
        const target = path.resolve(path.dirname(from), specifier);
        if (target.endsWith(".css")) return 'from "./comboCss.mjs"';
        const targetRelative = path.relative(srcDir, target).split(path.sep).join("/");
        if (COMPILED.includes(targetRelative)) return `from "./${compiledName(targetRelative)}"`;
        return `from "${path.relative(outDir, target).split(path.sep).join("/")}"`;
      });
    writeFileSync(path.join(outDir, compiledName(relative)), rewritten);
  }
}

let dom;
let React;
let ReactDOMClient;
let ComboPowerCore;
const mounted = [];
const media = { matches: false };

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
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.PointerEvent,
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
  // jsdom has no matchMedia or layout engine: report the reduced-motion flag on
  // demand and give every element the same measured box so the core geometry is
  // the deterministic desktop viewBox.
  dom.window.matchMedia = query => ({
    matches: query.includes("prefers-reduced-motion") && media.matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  dom.window.Element.prototype.getBoundingClientRect = function rect() {
    return {
      x: 0, y: 0, left: 0, top: 0,
      right: CORE_SIZE.width, bottom: CORE_SIZE.height,
      width: CORE_SIZE.width, height: CORE_SIZE.height
    };
  };
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  await compileAll();
  ComboPowerCore = (await import(pathToFileURL(path.join(outDir, "ComboPowerCore.mjs")).href)).default;
});

afterEach(async () => {
  media.matches = false;
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      entry.root.unmount();
      entry.container.remove();
    }
  });
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
  // jsdom's visual clock owns a timer; without closing the window the test
  // process stays alive after the last assertion.
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

function saved(provider, providerId, modelId) {
  return {
    key: `saved:cfg-1:${modelId}`,
    kind: "saved",
    configId: "cfg-1",
    providerId,
    provider,
    providerType: "openai_compatible",
    model: modelId,
    label: modelId
  };
}

const SELECTED = [
  saved("OpenAI", "openai", "gpt-5"),
  saved("OpenAI", "openai", "gpt-4.1"),
  saved("Anthropic", "anthropic", "claude-opus-4.1"),
  saved("Google Gemini API", "google-gemini", "gemini-2.5-pro")
];

const NETWORK = buildProviderNetwork(SELECTED);
const LAYOUT = buildCoreLayout(NETWORK, CORE_SIZE);

function availabilityOf(entries) {
  return new Map(Object.entries(entries));
}

const ALL_WORKING = availabilityOf(
  Object.fromEntries(SELECTED.map(entry => [entry.key, { status: "working" }]))
);
const NONE_WORKING = availabilityOf(
  Object.fromEntries(SELECTED.map(entry => [entry.key, { status: "not_working" }]))
);

function renderCore(props = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => {
    rootHandle.render(React.createElement(ComboPowerCore, {
      models: SELECTED,
      availability: ALL_WORKING,
      activity: null,
      ...props
    }));
  });
  return container;
}

function nodeElements(container) {
  return [...container.querySelectorAll(".combo-provider-node")];
}

function wireOf(container, index) {
  return container.querySelector(`svg.combo-core__wires g:nth-of-type(${index + 1}) path.combo-wire__line`);
}

function offsetOf(element) {
  const match = /translate\(calc\(-50% \+ (-?[\d.]+)px\), calc\(-50% \+ (-?[\d.]+)px\)\)/.exec(element.style.transform || "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

async function frames(count) {
  let wait = Promise.resolve();
  for (let index = 0; index < count; index += 1) {
    wait = wait.then(() => new Promise(resolve => {
      dom.window.requestAnimationFrame(() => resolve());
    }));
  }
  return wait;
}

async function settle(container, max = 60) {
  const nodes = nodeElements(container);
  let previous = nodes.map(node => node.style.transform).join("|");
  for (let round = 0; round < max; round += 1) {
    await frames(2);
    const current = nodes.map(node => node.style.transform).join("|");
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

function pointer(container, element, type, x, y) {
  assert.equal(element.isConnected, true, "the node element is still mounted before it is driven");
  React.act(() => {
    element.dispatchEvent(new dom.window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y
    }));
  });
  void container;
}

function keyOn(element, key, options = {}) {
  React.act(() => {
    element.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
      ...options
    }));
  });
}

function watchWrites(element) {
  let writes = 0;
  // The elastic layer writes `style.transform`, which reaches a MutationObserver
  // as a change of the `style` attribute; the `is-dragging` class is a state
  // marker, not a repaint, so it is ignored.
  const observer = new dom.window.MutationObserver(records => {
    writes += records.filter(record => record.attributeName === "style").length;
  });
  observer.observe(element, { attributes: true, attributeOldValue: true });
  return {
    get count() { return writes; },
    stop() { observer.disconnect(); }
  };
}

test("every provider renders as one addressable node and no model name leaks in", async () => {
  const container = renderCore();
  const nodes = nodeElements(container);
  assert.equal(nodes.length, 3, "one node per unique provider");
  const names = nodes.map(node => node.getAttribute("aria-label"));
  assert.deepEqual(
    names.map(label => label.split(" provider node")[0]).sort(),
    ["Anthropic", "Google Gemini", "OpenAI"]
  );
  for (const label of names) {
    assert.match(label, /available/);
    assert.match(label, /Drag or use arrow keys to reposition/);
  }
  const text = `${container.textContent} ${names.join(" ")}`;
  for (const modelId of ["gpt-5", "gpt-4.1", "claude-opus-4.1", "gemini-2.5-pro"]) {
    assert.ok(!text.includes(modelId), `${modelId} must not appear in the network`);
  }
  assert.equal(container.querySelectorAll('[role="img"]').length, 0, "interactive children need a group, not an image role");
  await settle(container);
});

test("the center glow is driven by real connection state, not a permanent animation", async () => {
  const offline = renderCore({ availability: NONE_WORKING });
  const offlineRoot = offline.querySelector(".combo-core");
  assert.equal(offlineRoot.dataset.connected, "false");
  assert.equal(offlineRoot.style.getPropertyValue("--combo-connected"), "0");
  assert.equal(Number(offlineRoot.style.getPropertyValue("--combo-intensity")), 0);
  assert.equal(offline.querySelectorAll(".combo-wire__dot").length, 0, "no energy flow without a connected provider");
  await settle(offline);

  const oneAvailable = availabilityOf({
    [SELECTED[0].key]: { status: "working" },
    [SELECTED[1].key]: { status: "not_working" },
    [SELECTED[2].key]: { status: "not_working" },
    [SELECTED[3].key]: { status: "not_working" }
  });
  const online = renderCore({ availability: oneAvailable });
  const onlineRoot = online.querySelector(".combo-core");
  assert.equal(onlineRoot.dataset.connected, "true");
  assert.equal(onlineRoot.style.getPropertyValue("--combo-connected"), "1");
  assert.ok(Number(onlineRoot.style.getPropertyValue("--combo-intensity")) > 0);
  assert.equal(online.querySelectorAll(".combo-wire__dot").length, 0, "an available credential is a lit housing, not traffic");
  await settle(online);

  const running = renderCore({
    availability: oneAvailable,
    activity: new Map([[SELECTED[0].key, "working"]])
  });
  const owner = NETWORK.find(provider => provider.keys.includes(SELECTED[0].key));
  const dots = running.querySelectorAll(".combo-wire__dot");
  assert.equal(dots.length, 1, "a real run puts one pulse on the provider actually answering");
  assert.equal(dots[0].closest(".combo-wire").dataset.provider, owner.id);
  await settle(running);

  const css = readFileSync(path.join(srcDir, "combo/combo.css"), "utf8");
  const glow = /\.combo-core__glow \{([\s\S]*?)\}/.exec(css);
  assert.match(glow[1], /opacity: calc\(var\(--combo-connected, 0\)/, "glow opacity must depend on connection state");
});

test("a provider that never received a task is not shown as working", async () => {
  const container = renderCore({
    availability: NONE_WORKING,
    activity: new Map([[SELECTED[2].key, "working"]])
  });
  const live = nodeElements(container).filter(node => node.dataset.activity === "working");
  assert.equal(live.length, 1);
  const owner = NETWORK.find(provider => provider.keys.includes(SELECTED[2].key));
  assert.equal(live[0].dataset.provider, owner.id, "the node lit is the one that owns the running model");
  assert.equal(container.querySelectorAll(".combo-wire__dot").length, 1);
  await settle(container);
});

test("the status bar states only the counts the orchestrator actually reported", async () => {
  const container = renderCore({
    activity: new Map([
      [SELECTED[0].key, "done"],
      [SELECTED[2].key, "working"],
      [SELECTED[3].key, "failed"]
    ])
  });
  await settle(container);

  const spoken = container.querySelector(".combo-core__sr").textContent;
  assert.equal(
    spoken,
    "3 providers linked, 3 available, 1 answering, 1 answered, 1 failed.",
    "the announced sentence matches the real per-provider states"
  );
  assert.deepEqual(
    [...container.querySelectorAll(".combo-core__count")].map(node => Number(node.textContent)),
    [3, 3, 1],
    "the visible readout repeats those same numbers, nothing decorative"
  );

  const byProvider = new Map(
    nodeElements(container).map(node => [node.dataset.provider, node.dataset.activity || ""])
  );
  assert.equal(byProvider.get(NETWORK[0].id), "done", "the finished provider reads finished");
  assert.equal(byProvider.get(NETWORK[2].id), "failed", "the failed provider reads failed");
  const working = nodeElements(container).filter(node => node.dataset.activity === "working");
  assert.equal(working.length, 1, "exactly one provider is shown answering");
  assert.equal(working[0].dataset.provider, NETWORK[1].id);
  assert.equal(container.querySelectorAll(".combo-wire__dot").length, 1);
});

test("dragging a provider logo moves the logo and its wire follows continuously", async () => {
  const container = renderCore();
  await settle(container);
  const index = 1;
  const home = LAYOUT.nodes[index];
  const element = nodeElements(container)[index];
  const wire = wireOf(container, index);
  const startPath = wire.getAttribute("d");
  const startOffset = offsetOf(element);
  assert.deepEqual(startOffset, { x: 0, y: 0 }, "nodes start on their ring position");

  const targetX = Math.min(home.x + 120, LAYOUT.bounds.maxX - 4);
  const targetY = Math.min(home.y + 70, LAYOUT.bounds.maxY - 4);
  pointer(container, element, "pointerdown", home.x, home.y);
  const seen = new Set([wire.getAttribute("d")]);
  for (let step = 1; step <= 6; step += 1) {
    pointer(container, element, "pointermove", home.x + ((targetX - home.x) * step) / 6, home.y + ((targetY - home.y) * step) / 6);
    await frames(2);
    seen.add(wire.getAttribute("d"));
  }
  assert.ok(seen.size >= 4, `the wire must bend continuously, saw ${seen.size} shapes`);
  assert.notEqual(wire.getAttribute("d"), startPath, "the wire must follow the node");
  const dragging = offsetOf(element);
  assert.ok(dragging.x !== 0 || dragging.y !== 0, "the logo must leave its ring position");

  pointer(container, element, "pointerup", targetX, targetY);
  await settle(container);
  const released = offsetOf(element);
  assert.ok(Math.abs(released.x - (targetX - home.x)) < 1.5, `settled x ${released.x} near ${targetX - home.x}`);
  assert.ok(Math.abs(released.y - (targetY - home.y)) < 1.5, `settled y ${released.y} near ${targetY - home.y}`);
  const endPath = wire.getAttribute("d");
  const endpoint = /M ([\d.-]+) ([\d.-]+) Q ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/.exec(endPath);
  assert.ok(endpoint, `unexpected path grammar: ${endPath}`);
  const endX = Number(endpoint[5]);
  const endY = Number(endpoint[6]);
  const nodeX = home.x + released.x;
  const nodeY = home.y + released.y;
  const gap = Math.hypot(endX - nodeX, endY - nodeY);
  // A dragged node can end up anywhere on the stage, so the tip is clamped two
  // ways: it always falls inside the housing (no air gap) and it never runs past
  // the provider artwork, nor past a third of the remaining span toward the core.
  const span = Math.hypot(nodeX - LAYOUT.center.x, nodeY - LAYOUT.center.y);
  const bandFloor = Math.min(LAYOUT.nodeRadius * 0.8, span * 0.3);
  const coreGap = Math.hypot(Number(endpoint[1]) - LAYOUT.center.x, Number(endpoint[2]) - LAYOUT.center.y);
  assert.ok(gap <= LAYOUT.nodeRadius + 0.05, `wire tip plugs into the housing (${gap.toFixed(1)} of ${LAYOUT.nodeRadius.toFixed(1)})`);
  assert.ok(gap >= bandFloor - 0.05, `wire tip clears the artwork (${gap.toFixed(1)} >= ${bandFloor.toFixed(1)})`);
  assert.ok(coreGap <= LAYOUT.centerRadius + 0.05, "the core end stays inside the core housing");
  assert.ok(gap + coreGap < span, "neither end crosses the other");
  assert.notEqual(endPath, [...seen][0], "the curve relaxes after release instead of freezing");
});

test("a drag changes no model selection, availability, or credential", async () => {
  const before = SELECTED.map(entry => entry.key).join("|");
  const container = renderCore();
  await settle(container);
  const element = nodeElements(container)[0];
  const status = element.dataset.status;
  const beforeDots = container.querySelectorAll(".combo-wire__dot").length;

  pointer(container, element, "pointerdown", LAYOUT.nodes[0].x, LAYOUT.nodes[0].y);
  pointer(container, element, "pointermove", LAYOUT.nodes[0].x + 60, LAYOUT.nodes[0].y + 60);
  await frames(2);
  pointer(container, element, "pointerup", LAYOUT.nodes[0].x + 60, LAYOUT.nodes[0].y + 60);
  await settle(container);

  assert.equal(SELECTED.map(entry => entry.key).join("|"), before, "the selection array is untouched");
  assert.equal(nodeElements(container)[0].dataset.status, status, "connection state is unchanged by a visual drag");
  assert.equal(container.querySelectorAll(".combo-wire__dot").length, beforeDots);
  assert.equal(nodeElements(container).length, 3, "no node is added or removed by dragging");
});

test("a click fired after a real drag does not activate the provider, a plain click does", async () => {
  const activated = [];
  const container = renderCore({ onProviderSelect: provider => activated.push(provider.name) });
  await settle(container);
  const home = LAYOUT.nodes[1];
  const element = nodeElements(container)[1];

  pointer(container, element, "pointerdown", home.x, home.y);
  pointer(container, element, "pointermove", home.x + 45, home.y + 20);
  await frames(2);
  pointer(container, element, "pointerup", home.x + 45, home.y + 20);
  await settle(container);
  assert.ok(offsetOf(element).x > 30, "the node actually moved");

  // jsdom does not synthesise the click a real browser emits after pointerup, so
  // it is dispatched here to prove the drag guard suppresses the selection.
  React.act(() => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.equal(activated.length, 0, "releasing a dragged node must not fire the selection callback");

  const other = nodeElements(container)[2];
  React.act(() => {
    other.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(activated, [other.getAttribute("aria-label").split(" provider node,")[0]],
    "a click on an unmoved node selects its provider");
});

test("arrow keys reposition a node, Enter selects the provider and Escape returns it", async () => {
  const activated = [];
  const container = renderCore({ onProviderSelect: provider => activated.push(provider.name) });
  await settle(container);
  const element = nodeElements(container)[2];
  assert.equal(element.getAttribute("tabindex"), "0");
  keyOn(element, "ArrowRight");
  keyOn(element, "ArrowUp", { shiftKey: true });
  await settle(container);
  const moved = offsetOf(element);
  assert.ok(moved.x > 8 && moved.x <= 14, `minor step ${moved.x}`);
  assert.ok(moved.y < -35 && moved.y >= -42, `major step ${moved.y}`);

  keyOn(element, "Enter");
  await settle(container);
  assert.deepEqual(activated, [element.getAttribute("aria-label").split(" provider node,")[0]],
    "Enter fires the same primary action a click does");
  assert.deepEqual(offsetOf(element), moved, "activating a node does not move it");

  keyOn(element, "Escape");
  await settle(container);
  assert.deepEqual(offsetOf(element), { x: 0, y: 0 }, "Escape restores the default position");
  assert.equal(activated.length, 1, "returning a node to its ring does not re-select it");
});

test("double-click and the reset control restore the layout and disappear afterwards", async () => {
  const container = renderCore();
  await settle(container);
  assert.equal(container.querySelector(".combo-core__reset"), null, "no reset until something moved");

  for (const index of [0, 2]) {
    const home = LAYOUT.nodes[index];
    const element = nodeElements(container)[index];
    pointer(container, element, "pointerdown", home.x, home.y);
    pointer(container, element, "pointermove", Math.min(home.x + 70, LAYOUT.bounds.maxX - 2), home.y + 30);
    pointer(container, element, "pointerup", home.x + 70, home.y + 30);
  }
  await settle(container);
  const reset = container.querySelector(".combo-core__reset");
  assert.ok(reset, "an accessible reset control is offered");
  assert.match(reset.getAttribute("aria-label"), /reset provider positions/i);

  React.act(() => { reset.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  await settle(container);
  for (const element of nodeElements(container)) {
    assert.deepEqual(offsetOf(element), { x: 0, y: 0 }, "every node returns to its ring position");
  }
  assert.equal(container.querySelector(".combo-core__reset"), null, "the control retires once the layout is default");

  const single = nodeElements(container)[1];
  const singleHome = LAYOUT.nodes[1];
  pointer(container, single, "pointerdown", singleHome.x, singleHome.y);
  pointer(container, single, "pointermove", singleHome.x + 50, singleHome.y);
  pointer(container, single, "pointerup", singleHome.x + 50, singleHome.y);
  await settle(container);
  assert.ok(offsetOf(single).x > 40);
  React.act(() => {
    single.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  });
  await settle(container);
  assert.deepEqual(offsetOf(single), { x: 0, y: 0 }, "double-click resets one node");
});

test("the animation loop idles when nothing moves and stops completely on unmount", async () => {
  const container = renderCore();
  await settle(container);
  const element = nodeElements(container)[1];
  const home = LAYOUT.nodes[1];
  const watched = watchWrites(element);

  await frames(8);
  const idle = watched.count;
  await frames(8);
  assert.equal(watched.count, idle, "an idle network must not keep repainting the elastic layer");

  pointer(container, element, "pointerdown", home.x, home.y);
  pointer(container, element, "pointermove", home.x + 90, home.y + 40);
  await frames(4);
  pointer(container, element, "pointerup", home.x + 90, home.y + 40);
  assert.ok(watched.count > idle, "a drag repaints the layer");

  await settle(container);
  const settled = watched.count;
  await frames(8);
  assert.equal(watched.count, settled, "the loop stops once the spring is at rest");

  await React.act(async () => {
    mounted[0].root.unmount();
  });
  await frames(8);
  assert.equal(watched.count, settled, "unmount cancels the frame loop");
  watched.stop();
  mounted.shift();
});

test("reduced motion places logos and wires instantly with no interpolation frames", async () => {
  media.matches = true;
  const container = renderCore();
  const core = container.querySelector(".combo-core");
  assert.match(core.className, /combo-core--still/);
  assert.equal(container.querySelector(".combo-provider-node__disc").style.visibility, "");

  const element = nodeElements(container)[0];
  const watched = watchWrites(element);
  await frames(4);
  const idle = watched.count;
  await frames(6);
  assert.equal(watched.count, idle, "reduced motion must not run a paint loop");

  const home = LAYOUT.nodes[0];
  pointer(container, element, "pointerdown", home.x, home.y);
  pointer(container, element, "pointermove", home.x + 80, home.y + 40);
  await frames(1);
  assert.deepEqual(offsetOf(element), { x: 80, y: 40 }, "the node lands where the pointer is, immediately");
  assert.notEqual(wireOf(container, 0).getAttribute("d"), home.wire, "the wire is redrawn without animation");
  const placed = watched.count;
  assert.ok(placed > idle, "the drop is painted once");
  pointer(container, element, "pointerup", home.x + 80, home.y + 40);
  await frames(4);
  assert.deepEqual(offsetOf(element), { x: 80, y: 40 }, "no settle animation after release");
  assert.equal(watched.count, placed, "release adds no interpolation frames");
  watched.stop();
});
