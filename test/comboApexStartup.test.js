import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

let dom;
let React;
let ReactDOMClient;
let useApexStartup;
let resetApexStartup;
let STARTUP_DURATION;
const mounted = [];
const media = { matches: false };

const SHELL_HTML = `
  <header class="combo-head">APEX</header>
  <section class="combo-stage__core"></section>
  <p class="combo-stage__note">Visual participation only.</p>
  <aside class="combo-panel"><button type="button">Model library</button></aside>
`;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: "https://vups.test/combo",
    pretendToBeVisual: true
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.PointerEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: callback => dom.window.requestAnimationFrame(callback),
    cancelAnimationFrame: handle => dom.window.cancelAnimationFrame(handle),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  dom.window.matchMedia = query => ({
    matches: query.includes("prefers-reduced-motion") && media.matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {}
  });
  // gsap reads the viewport size for its units; jsdom reports 0 without this.
  Object.defineProperty(dom.window, "innerWidth", { value: 1280, writable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 800, writable: true });

  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  // Imported only after the DOM exists, so gsap binds to jsdom rather than to
  // the headless fallback it would pick up at module load time.
  const hook = await import("../src/combo/hooks/useApexStartup.js");
  useApexStartup = hook.default;
  resetApexStartup = hook.resetApexStartup;
  STARTUP_DURATION = (await import("../src/combo/comboScene.js")).STARTUP_DURATION;
});

afterEach(async () => {
  media.matches = false;
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      entry.root.unmount();
      entry.container.remove();
      entry.shell?.remove();
    }
  });
});

after(() => {
  dom.window.close();
});

// GSAP runs on its own clock, so the sequence has to be given real time. The
// wait lives inside act() because the timeline's completion calls setRunning,
// and that update has to land in the same flush as the assertions after it.
async function advance(ms) {
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

function mountShell(props = { ready: true }, { strict = false } = {}) {
  // React removes any children already inside its own container, so the shell
  // markup and the hook live in separate elements, exactly as they do on a page
  // where the shell is rendered JSX and the ref merely points at it.
  const shell = dom.window.document.createElement("div");
  shell.className = "combo-page__shell";
  shell.innerHTML = SHELL_HTML;
  dom.window.document.body.appendChild(shell);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);

  const rootRef = { current: shell };
  const results = [];
  function Shell(liveProps) {
    results.push(useApexStartup(rootRef, liveProps));
    return null;
  }
  const root = ReactDOMClient.createRoot(host);
  React.act(() => {
    root.render(
      strict
        ? React.createElement(React.StrictMode, null, React.createElement(Shell, props))
        : React.createElement(Shell, props)
    );
  });
  mounted.push({ root, container: host, shell });
  return {
    shell,
    host,
    container: shell,
    root,
    driver: results[0].driverRef,
    isRunning: () => results[results.length - 1].running,
    render: nextProps => React.act(() => root.render(React.createElement(Shell, nextProps)))
  };
}

function hiddenState(container) {
  return [".combo-head", ".combo-stage__core", ".combo-panel", ".combo-stage__note"]
    .map(selector => container.querySelector(selector))
    .map(element => ({
      opacity: element.style.opacity,
      visibility: element.style.visibility
    }));
}

function isRevealed(container) {
  return hiddenState(container).every(
    entry => entry.opacity === "" || Number(entry.opacity) >= 0.99
  );
}

test("the first Apex mount powers on once, reveals every layer and leaves nothing hidden", async () => {
  resetApexStartup();
  const shell = mountShell();
  assert.equal(shell.container.dataset.apexStartup, "running", "the shell is flagged while booting");
  assert.equal(shell.driver.current, 0, "the machine driver starts cold");
  assert.equal(shell.isRunning(), true, "React knows a sequence is in flight");

  // GSAP writes the from-values on its first tick, so the hidden state is read a
  // frame later rather than synchronously with the commit.
  await advance(120);
  const panel = shell.container.querySelector(".combo-panel");
  const head = shell.container.querySelector(".combo-head");
  assert.equal(panel.style.opacity, "0", "the settings panel has not been revealed yet");
  assert.notEqual(panel.style.visibility, "hidden", "the library stays reachable during startup");
  assert.ok(
    Number(head.style.opacity) >= 0 && Number(head.style.opacity) < 1,
    `the header is mid-reveal, not skipped: ${head.style.opacity}`
  );
  assert.ok(
    hiddenState(shell.container).some(entry => entry.opacity === "0" || entry.visibility === "hidden"),
    "at least one layer really does begin hidden"
  );

  const trace = [];
  for (let round = 0; round < 40 && shell.container.dataset.apexStartup; round += 1) {
    trace.push(Number(shell.driver.current.toFixed(3)));
    await advance(80);
  }
  assert.equal(shell.container.dataset.apexStartup, undefined, "the flag retires when the run ends");
  assert.equal(shell.driver.current, 1, "the driver lands fully powered");
  assert.equal(shell.isRunning(), false, "the page stops reporting a startup");
  assert.ok(isRevealed(shell.container), "every layer ends visible");
  assert.equal(getComputedStyle(head).visibility, "visible", "autoAlpha releases visibility on completion");
  assert.doesNotMatch(head.getAttribute("style") || "", /opacity|visibility|transform/, "a finished layer is handed back with no inline residue");
  const monotonic = trace.every((value, index) => index === 0 || value >= trace[index - 1]);
  assert.ok(monotonic, `the driver only moves forward: ${trace.join(",")}`);
  assert.ok(trace.length > 3 && trace[trace.length - 1] > trace[0], "the driver actually interpolates");
});

test("an ordinary rerender does not replay the startup", async () => {
  resetApexStartup();
  const shell = mountShell();
  await advance(260);
  const midFlight = Number(shell.driver.current);
  assert.ok(midFlight > 0 && midFlight < 1, `expected a running sequence, saw ${midFlight}`);

  shell.render({ ready: true });
  shell.render({ ready: true });
  assert.equal(shell.driver.current, midFlight, "a rerender cannot restart the driver");
  assert.equal(shell.container.dataset.apexStartup, "running", "the same run keeps its flag");

  await advance(Math.max(100, STARTUP_DURATION * 1000 - 200));
  await advance(400);
  assert.equal(shell.driver.current, 1, "the original run still finishes");
  assert.ok(isRevealed(shell.container), "the rerendered shell is not hidden again");
});

test("a remount after the sequence has played shows a fully powered page immediately", async () => {
  resetApexStartup();
  const first = mountShell();
  await advance(STARTUP_DURATION * 1000 + 500);
  assert.equal(first.driver.current, 1, "the first run completed");
  await React.act(async () => {
    first.root.unmount();
    first.container.remove();
  });

  const second = mountShell();
  assert.equal(second.container.dataset.apexStartup, undefined, "no second boot is announced");
  assert.equal(second.driver.current, 1, "the machine is already on");
  assert.equal(second.isRunning(), false, "nothing is animating on the second mount");
  assert.ok(isRevealed(second.container), "the page is visible on arrival, never mid-fade");
});

test("StrictMode's double mount leaves the page visible, not rewound", async () => {
  resetApexStartup();
  // React 19 runs effect -> cleanup -> effect for one mount in development, and
  // main.jsx keeps StrictMode on, so this is the path a local preview takes.
  const shell = mountShell({ ready: true }, { strict: true });
  await advance(60);
  assert.equal(
    shell.container.dataset.apexStartup,
    "running",
    "the reattached effect keeps one startup in flight"
  );
  assert.ok(shell.driver.current > 0, "the driver is being driven, not left cold");

  await advance(STARTUP_DURATION * 1000 + 500);
  assert.equal(shell.driver.current, 1, "and it finishes");
  assert.ok(isRevealed(shell.container), "the double-mounted shell is visible");
  assert.equal(shell.container.dataset.apexStartup, undefined, "no flag is left behind");
});

test("leaving the page mid-boot does not rewind a later visit to a hidden shell", async () => {
  resetApexStartup();
  const shell = mountShell();
  await advance(320);
  assert.ok(shell.driver.current > 0 && shell.driver.current < 1, "the run is genuinely mid-flight");
  await React.act(async () => {
    shell.root.unmount();
  });
  assert.ok(isRevealed(shell.container), "the abandoned shell is cleared, not left faded out");
  assert.equal(shell.container.dataset.apexStartup, undefined, "the run leaves no flag behind");

  const next = mountShell();
  assert.equal(next.driver.current, 1, "the next visit arrives already powered on");
  assert.equal(next.container.dataset.apexStartup, undefined, "it does not replay the boot");
});

test("reduced motion skips the sequence and renders the finished state", async () => {
  media.matches = true;
  resetApexStartup();
  const shell = mountShell();
  assert.equal(shell.driver.current, 1, "the driver is settled without a timeline");
  assert.equal(shell.container.dataset.apexStartup, undefined, "no boot is announced");
  assert.equal(shell.isRunning(), false, "the page reports no animation in flight");
  assert.ok(
    hiddenState(shell.container).every(entry => entry.opacity === "" && entry.visibility === ""),
    "no inline reveal styles are written at all"
  );
  await advance(150);
  assert.ok(isRevealed(shell.container), "the static state survives a few frames");
});

test("startup waits for real providers before it begins", async () => {
  resetApexStartup();
  const shell = mountShell({ ready: false });
  assert.equal(shell.container.dataset.apexStartup, undefined, "an empty core does not boot");
  assert.equal(shell.driver.current, 0, "the driver stays cold until the network exists");

  shell.render({ ready: true });
  assert.equal(shell.container.dataset.apexStartup, "running", "the first real providers start the run");
  await advance(STARTUP_DURATION * 1000 + 500);
  assert.equal(shell.driver.current, 1, "and it still completes");
});
