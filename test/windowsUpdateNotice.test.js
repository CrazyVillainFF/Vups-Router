import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { __setWindowsUpdaterDepsForTest } from "../src/native/windowsUpdater.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src", "components", "WindowsUpdateNotice.jsx");
const workDir = path.join(root, "test", ".compiled-update-notice");

// The real delay is a boot courtesy, not something a suite should wait on.
// Only our own delay is captured, so timers React and jsdom rely on still run.
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let timers;
const DELAY = 20000;

function installFakeTimers() {
  const queue = [];
  timers = queue;
  globalThis.setTimeout = (fn, ms) => {
    if (ms !== DELAY) return originalSetTimeout(fn, ms);
    queue.push({ fn, ms, live: true });
    return queue.length;
  };
  globalThis.clearTimeout = id => {
    if (typeof id === "number" && queue[id - 1]) queue[id - 1] = { live: false };
    else originalClearTimeout(id);
  };
}

async function fireDueTimers() {
  for (const entry of timers.splice(0)) {
    if (entry.live) await React.act(async () => entry.fn());
  }
}

let dom;
let React;
let ReactDOMClient;
const mounted = [];

async function loadComponent() {
  mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, "WindowsUpdateNotice.mjs");
  const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  writeFileSync(
    outFile,
    code
      .replace(/^import\s+"\.\/[^"]+\.css";\s*$/m, "")
      .replace(/from "\.\.\//g, 'from "../../src/')
  );
  return import(pathToFileURL(outFile).href);
}

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
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  __setWindowsUpdaterDepsForTest(null);
  delete globalThis.setTimeout;
  delete globalThis.clearTimeout;
  delete dom.window.__TAURI_INTERNALS__;
  dom.window.localStorage.clear();
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tauriShell() {
  dom.window.__TAURI_INTERNALS__ = { invoke: async () => "1.0.8" };
}

function fakeUpdater(overrides = {}) {
  const calls = [];
  __setWindowsUpdaterDepsForTest({
    updater: {
      check: async () => {
        calls.push(["check"]);
        if (overrides.checkThrows) throw overrides.checkThrows;
        return overrides.update === undefined
          ? {
              version: "1.0.9",
              date: "2026-10-30T12:00:00.000Z",
              body: "Faster chat.\nSigned update.",
              close: async () => {},
              downloadAndInstall: async onEvent => {
                calls.push(["downloadAndInstall"]);
                onEvent({ event: "Started", data: { contentLength: 100 } });
                onEvent({ event: "Progress", data: { chunkLength: 100 } });
                onEvent({ event: "Finished" });
              }
            }
          : overrides.update;
      }
    },
    process: {
      relaunch: async () => {
        calls.push(["relaunch"]);
      }
    }
  });
  return calls;
}

async function render(Component) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  await React.act(async () => {
    rootHandle.render(React.createElement(Component));
  });
  return container;
}

function button(container, label) {
  return [...container.querySelectorAll("button")].find(node => node.textContent.includes(label));
}

async function click(node) {
  assert.ok(node, "button must exist");
  assert.equal(node.disabled, false, "button must be enabled");
  await React.act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("the notice waits for the app to settle before it spends the network", async () => {
  installFakeTimers();
  const calls = fakeUpdater();
  tauriShell();
  const { default: Component, STARTUP_DELAY_MS } = await loadComponent();
  const container = await render(Component);

  assert.equal(container.textContent, "", "nothing may appear before the delay");
  assert.deepEqual(calls, [], "the check must not race app boot");
  assert.ok(STARTUP_DELAY_MS >= 10000, `the delay should clear boot work, got ${STARTUP_DELAY_MS}`);
  assert.equal(timers.length, 1, "exactly one background check is scheduled");
  assert.equal(timers[0].ms, STARTUP_DELAY_MS);

  await fireDueTimers();
  assert.deepEqual(calls, [["check"]]);
  assert.match(container.textContent, /VupsRouter 1\.0\.9 is available/);
  assert.match(container.textContent, /Faster chat\./);
});

test("the web app never shows a Windows update notice", async () => {
  installFakeTimers();
  const calls = fakeUpdater();
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await fireDueTimers();
  assert.equal(container.textContent, "");
  assert.deepEqual(calls, [], "no updater request from a browser tab");
});

test("an app already on the newest published build stays quiet", async () => {
  installFakeTimers();
  const calls = fakeUpdater({ update: null });
  tauriShell();
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await fireDueTimers();
  assert.deepEqual(calls, [["check"]]);
  assert.equal(container.textContent, "", "up to date means silent, not a banner");
});

test("a background check that fails says nothing out loud", async () => {
  installFakeTimers();
  fakeUpdater({
    checkThrows: new Error("error sending request for url (https://github.com/.../latest.json)")
  });
  tauriShell();
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await fireDueTimers();
  assert.equal(container.textContent, "", "Settings stays the path that reports failures");
  assert.equal(container.querySelector("[role=alert]"), null);
});

test("dismissing a version keeps it quiet on the next launch", async () => {
  installFakeTimers();
  const calls = fakeUpdater();
  tauriShell();
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await fireDueTimers();
  await click(container.querySelector(".vr-update-notice__close"));
  assert.equal(container.textContent, "");
  assert.equal(dom.window.localStorage.getItem("vupsrouter.updates.dismissedWindowsVersion"), "1.0.9");

  const second = await render(Component);
  await fireDueTimers();
  assert.deepEqual(calls, [["check"], ["check"]]);
  assert.equal(second.textContent, "", "the dismissed build is not nagged about again");
});

test("the notice installs the signed update in place, tracks real progress, then restarts", async () => {
  installFakeTimers();
  const calls = [];
  let finishInstall;
  __setWindowsUpdaterDepsForTest({
    updater: {
      check: async () => {
        calls.push(["check"]);
        return {
          version: "1.0.9",
          body: "Signed update.",
          close: async () => {},
          downloadAndInstall: async onEvent => {
            calls.push(["downloadAndInstall"]);
            onEvent({ event: "Started", data: { contentLength: 100 } });
            onEvent({ event: "Progress", data: { chunkLength: 40 } });
            await new Promise(resolve => {
              finishInstall = resolve;
            });
            onEvent({ event: "Progress", data: { chunkLength: 60 } });
            onEvent({ event: "Finished" });
          }
        };
      }
    },
    process: {
      relaunch: async () => {
        calls.push(["relaunch"]);
      }
    }
  });
  tauriShell();
  const { default: Component } = await loadComponent();
  const container = await render(Component);
  await fireDueTimers();

  await click(button(container, "Update to 1.0.9"));
  const bar = container.querySelector('[role="progressbar"]');
  assert.ok(bar, "an in-flight install reports progress");
  assert.equal(bar.getAttribute("aria-valuenow"), "40");
  assert.match(container.textContent, /Installing/);
  assert.equal(container.querySelector(".vr-update-notice__close").disabled, true, "no fake cancel mid-install");

  await React.act(async () => {
    finishInstall();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
  assert.match(container.textContent, /Version 1\.0\.9 is installed\. Restart/);
  assert.deepEqual(calls, [["check"], ["downloadAndInstall"]]);

  await click(button(container, "Restart now"));
  assert.deepEqual(calls[2], ["relaunch"]);
});

test("a failed install reports the real cause and offers a retry", async () => {
  installFakeTimers();
  const calls = [];
  __setWindowsUpdaterDepsForTest({
    updater: {
      check: async () => {
        calls.push(["check"]);
        let attempt = 0;
        return {
          version: "1.0.9",
          body: "",
          close: async () => {},
          downloadAndInstall: async () => {
            attempt += 1;
            calls.push(["downloadAndInstall", attempt]);
            if (attempt === 1) throw new Error("invalid signature");
          }
        };
      }
    },
    process: { relaunch: async () => calls.push(["relaunch"]) }
  });
  tauriShell();
  const { default: Component } = await loadComponent();
  const container = await render(Component);
  await fireDueTimers();

  await click(button(container, "Update to 1.0.9"));
  const alert = container.querySelector("[role=alert]");
  assert.ok(alert);
  assert.match(alert.textContent, /could not be verified, so it was not installed/);
  assert.equal(button(container, "Restart now"), undefined, "a failed install never claims success");

  await click(button(container, "Try again"));
  assert.deepEqual(calls[2], ["downloadAndInstall", 2]);
});

test("App mounts the startup notice beside the other native background surfaces", () => {
  const app = readFileSync(path.join(root, "src", "App.jsx"), "utf8");
  assert.match(app, /import WindowsUpdateNotice from "\.\/components\/WindowsUpdateNotice\.jsx"/);
  assert.match(app, /<WindowsUpdateNotice \/>/);
});
