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
// Own scratch directory: node --test runs files in parallel processes and two
// suites sharing a folder delete each other's in-flight esbuild output.
const workDir = path.join(root, "test", ".compiled-panel");

async function loadPanelModule(fileName) {
  mkdirSync(workDir, { recursive: true });
  const sourcePath = path.join(panelDir, fileName);
  const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
    loader: fileName.endsWith(".jsx") ? "jsx" : "js",
    jsx: "automatic"
  });
  const outFile = path.join(workDir, fileName.replace(/\.jsx?$/, ".mjs"));
  writeFileSync(
    outFile,
    code
      .replace(/^import\s+"\.\/[^"]+\.css";\s*$/m, "")
      .replace(/from "\.\/panelModel\.js"/g, 'from "./panelModel.mjs"')
  );
  return import(pathToFileURL(outFile).href);
}

let model;
let PanelShell;
let PanelContext;
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
  model = await loadPanelModule("panelModel.js");
  PanelShell = (await loadPanelModule("PanelShell.jsx")).default;
  PanelContext = await loadPanelModule("PanelContext.jsx");
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  dom.window.localStorage.clear();
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  await React.act(async () => {
    rootHandle.render(element);
  });
  return container;
}

function nodeSelector(container, selector) {
  return [...container.querySelectorAll(selector)];
}

function byClass(container, className) {
  return nodeSelector(container, `.${className}`);
}

function buttonWithLabel(container, label) {
  return nodeSelector(container, "button").find(node =>
    `${node.textContent} ${node.getAttribute("aria-label") || ""}`.includes(label)
  );
}

function click(node) {
  return React.act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

const TABS = [
  { id: "files", label: "Workspace Files" },
  { id: "review", label: "Code Review" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "side-task", label: "Side Task" }
];

function shellProps(overrides = {}) {
  const calls = { toggles: 0, selections: [], resizeStarts: 0 };
  return {
    calls,
    props: {
      open: true,
      tabs: TABS,
      activeTab: "files",
      width: 460,
      icons: {},
      panes: Object.fromEntries(TABS.map(tab => [tab.id, tab.id])),
      onToggle: () => {
        calls.toggles += 1;
      },
      onSelectTab: id => calls.selections.push(id),
      onResizeStart: () => {
        calls.resizeStarts += 1;
      },
      ...overrides
    }
  };
}

test("the panel exposes exactly the five briefed panes, in order", () => {
  assert.deepEqual(
    model.PANEL_TABS.map(tab => tab.id),
    ["files", "review", "terminal", "browser", "side-task"]
  );
  assert.deepEqual(
    model.PANEL_TABS.map(tab => tab.label),
    ["Workspace Files", "Code Review", "Terminal", "Browser", "Side Task"]
  );
  assert.equal(model.DEFAULT_TAB, "files");
  assert.ok(Object.isFrozen(model.PANEL_TABS));
  assert.equal(model.isPanelTab("browser"), true);
  assert.equal(model.isPanelTab("chat"), false);
});

test("panel width is clamped to the usable range and to the viewport", () => {
  assert.equal(model.clampPanelWidth(120, 1600), model.PANEL_MIN_WIDTH);
  assert.equal(model.clampPanelWidth(5000, 1600), model.PANEL_MAX_WIDTH);
  assert.equal(model.clampPanelWidth(460, 1600), 460);
  // A narrow window caps the panel at 66% of the viewport.
  assert.equal(model.clampPanelWidth(800, 900), Math.floor(900 * 0.66));
  assert.equal(model.clampPanelWidth(800, 500), model.PANEL_MIN_WIDTH);
  assert.equal(model.clampPanelWidth("wide", 1600), model.PANEL_DEFAULT_WIDTH);
  assert.equal(model.clampPanelWidth(Number.NaN, Number.NaN), model.PANEL_DEFAULT_WIDTH);
  assert.equal(model.clampPanelWidth(undefined), model.PANEL_DEFAULT_WIDTH);
});

test("browser bounds map the stage rect to native logical pixels", () => {
  assert.deepEqual(
    model.toBrowserBounds({ left: 12.4, top: 8.6, width: 611.5, height: 399.4 }, true),
    { x: 12, y: 9, width: 612, height: 399, visible: true }
  );
  assert.deepEqual(
    model.toBrowserBounds({ left: 0, top: 0, width: 0, height: -5 }, false),
    { x: 0, y: 0, width: 1, height: 1, visible: false }
  );
});

test("panel state round-trips through storage and rejects bad values", () => {
  const area = dom.window.localStorage;
  assert.deepEqual(model.readPanelState(area), {
    open: false,
    activeTab: "files",
    width: model.PANEL_DEFAULT_WIDTH
  });

  model.writePanelState(area, { open: true, activeTab: "browser", width: 700 });
  assert.deepEqual(model.readPanelState(area), { open: true, activeTab: "browser", width: 700 });

  model.writePanelState(area, { open: "yes", activeTab: "nope", width: 5000 });
  assert.deepEqual(model.readPanelState(area), {
    open: true,
    activeTab: model.DEFAULT_TAB,
    width: model.PANEL_MAX_WIDTH
  });

  area.setItem("vupsrouter.desktop.workspace-panel.v1", "{not json");
  assert.deepEqual(model.readPanelState(area), {
    open: false,
    activeTab: "files",
    width: model.PANEL_DEFAULT_WIDTH
  });

  assert.deepEqual(model.readPanelState(undefined), {
    open: false,
    activeTab: "files",
    width: model.PANEL_DEFAULT_WIDTH
  });
  model.writePanelState(undefined, { open: true });
});

test("the shell collapses to a rail and reopens from it", async () => {
  const closed = shellProps({ open: false });
  const container = await render(React.createElement(PanelShell, closed.props));
  assert.equal(container.querySelector("aside.vr-workspace-panel"), null);
  const rail = buttonWithLabel(container, "Open workspace panel");
  assert.ok(rail, "closed panel must offer an accessible open control");
  assert.equal(rail.getAttribute("aria-expanded"), "false");
  assert.equal(byClass(container, "vr-panel-tab").length, 0);

  await click(rail);
  assert.equal(closed.calls.toggles, 1);

  const open = shellProps();
  const openContainer = await render(React.createElement(PanelShell, open.props));
  assert.ok(openContainer.querySelector("aside.vr-workspace-panel"));
  await click(buttonWithLabel(openContainer, "Close workspace panel"));
  assert.equal(open.calls.toggles, 1);
});

test("the shell renders one tab per pane and shows only the active pane", async () => {
  const { calls, props } = shellProps();
  const container = await render(React.createElement(PanelShell, props));

  const tabs = nodeSelector(container, '[role="tab"]');
  const panels = nodeSelector(container, '[role="tabpanel"]');
  assert.equal(tabs.length, 5);
  assert.equal(panels.length, 5);
  assert.deepEqual(
    tabs.map(node => node.textContent),
    TABS.map(tab => tab.label)
  );
  // All panes stay mounted; inactive ones are hidden, not unmounted.
  assert.deepEqual(
    panels.map(node => node.hasAttribute("hidden")),
    [false, true, true, true, true]
  );
  assert.deepEqual(
    panels.map(node => node.textContent),
    TABS.map(tab => tab.id)
  );
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(tabs[1].getAttribute("aria-selected"), "false");
  for (const tab of tabs) {
    const id = tab.getAttribute("id").replace("vr-tab-", "");
    assert.equal(tab.getAttribute("aria-controls"), `vr-panel-${id}`);
    const panel = container.querySelector(`#vr-panel-${id}`);
    assert.equal(panel.getAttribute("aria-labelledby"), tab.getAttribute("id"));
  }
  assert.equal(
    container.querySelector("aside.vr-workspace-panel").style.getPropertyValue("--vr-panel-width"),
    "460px"
  );

  await click(tabs[3]);
  assert.deepEqual(calls.selections, ["browser"]);
});

test("switching tabs keeps pane state, selection and the pane instance", async () => {
  const mounts = { count: 0 };
  function Probe() {
    const [value, setValue] = React.useState("half-typed command");
    mounts.count += 1;
    return React.createElement("input", {
      className: "probe",
      value,
      onChange: event => setValue(event.target.value)
    });
  }
  const panes = { ...shellProps().props.panes, files: React.createElement(Probe) };
  const { props } = shellProps({ panes });

  let active = "files";
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  await React.act(async () => {
    rootHandle.render(React.createElement(PanelShell, { ...props, activeTab: active }));
  });

  const input = container.querySelector(".probe");
  assert.equal(mounts.count, 1);
  await React.act(async () => {
    input.value = "npm run build &&";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelector(".probe").value, "npm run build &&");

  active = "terminal";
  await React.act(async () => {
    rootHandle.render(React.createElement(PanelShell, { ...props, activeTab: active }));
  });
  const visible = nodeSelector(container, '[role="tabpanel"]').filter(node => !node.hasAttribute("hidden"));
  assert.deepEqual(
    visible.map(node => node.getAttribute("id")),
    ["vr-panel-terminal"]
  );
  assert.equal(visible[0].textContent, "terminal");
  const filesPanel = container.querySelector("#vr-panel-files");
  assert.equal(filesPanel.hasAttribute("hidden"), true);

  active = "files";
  await React.act(async () => {
    rootHandle.render(React.createElement(PanelShell, { ...props, activeTab: active }));
  });
  assert.equal(mounts.count, 1, "pane must not remount when switching tabs");
  assert.equal(container.querySelector(".probe"), input, "pane DOM node must be reused");
  assert.equal(container.querySelector(".probe").value, "npm run build &&");
  assert.equal(container.querySelector("#vr-panel-files").hasAttribute("hidden"), false);
});

test("the shell drives resizing from the handle", async () => {
  const { calls, props } = shellProps();
  const container = await render(React.createElement(PanelShell, props));
  const handle = container.querySelector('[role="separator"]');
  assert.ok(handle);
  assert.equal(handle.getAttribute("aria-label"), "Resize workspace panel");
  assert.equal(handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(handle.getAttribute("tabindex"), "0");
  await React.act(async () => {
    handle.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  });
  assert.equal(calls.resizeStarts, 1);
});

test("the provider owns open/tab/width and persists them across remounts", async () => {
  const { PanelProvider, usePanel } = PanelContext;
  const seen = [];
  function Reader() {
    const panel = usePanel();
    seen.push(panel);
    return React.createElement(
      "button",
      {
        type: "button",
        onClick: () => panel.selectTab("browser")
      },
      "pick browser"
    );
  }

  const container = await render(React.createElement(PanelProvider, null, React.createElement(Reader)));
  assert.equal(seen[seen.length - 1].open, false);
  assert.equal(seen[seen.length - 1].activeTab, "files");

  await click(buttonWithLabel(container, "pick browser"));
  const latest = () => seen[seen.length - 1];
  assert.equal(latest().activeTab, "browser");
  assert.equal(
    JSON.parse(dom.window.localStorage.getItem("vupsrouter.desktop.workspace-panel.v1")).activeTab,
    "browser"
  );

  await React.act(async () => {
    latest().setOpen(true);
  });
  assert.equal(latest().open, true);

  await React.act(async () => {
    latest().toggle();
  });
  assert.equal(latest().open, false);

  await React.act(async () => {
    latest().setWidth(9000);
  });
  assert.equal(latest().width, model.clampPanelWidth(9000, dom.window.innerWidth));
  assert.ok(latest().width <= model.PANEL_MAX_WIDTH);

  await React.act(async () => {
    latest().selectTab("not-a-tab");
  });
  assert.equal(latest().activeTab, "browser", "unknown tab ids are ignored");

  // A fresh provider instance reads the same state back: tab, open flag and
  // width survive a reload of the desktop window.
  const reopened = await render(
    React.createElement(PanelProvider, null, React.createElement(Reader))
  );
  assert.ok(reopened);
  const restored = seen[seen.length - 1];
  assert.equal(restored.activeTab, "browser");
  assert.equal(restored.open, false);
  assert.equal(restored.width, model.clampPanelWidth(9000, dom.window.innerWidth));
});

test("panel styles use design tokens and stay responsive", () => {
  const css = readFileSync(cssPath, "utf8");
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false, "panel CSS must not hard-code hex colours");
  assert.ok(/background(-image)?\s*:\s*linear-gradient/.test(css) === false, "no gradient paint");
  assert.ok(css.includes("--vr-panel-width"), "width is driven by a custom property");
  assert.match(css, /@media[^{]*max-width\s*:\s*720px/, "panel goes full-width on narrow windows");
  assert.ok(css.includes(".vr-panel-pane[hidden]"), "hidden panes are display:none");
});
