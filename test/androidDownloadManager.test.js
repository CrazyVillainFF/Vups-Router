import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src", "components", "AndroidDownloadManager.jsx");
const workDir = path.join(root, "test", ".compiled-downloads");

async function loadPanel() {
  mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, "AndroidDownloadManager.mjs");
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

function plugin(overrides = {}) {
  const listeners = [];
  const calls = [];
  const base = {
    calls,
    listeners,
    list: async () => ({ downloads: [] }),
    notificationsStatus: async () => ({ granted: true, canRequest: false, enabled: true }),
    requestNotifications: async () => ({ granted: false, canRequest: false, enabled: false }),
    cancel: async options => calls.push(["cancel", options]),
    retry: async options => calls.push(["retry", options]),
    openFile: async options => calls.push(["openFile", options]),
    clearFinished: async () => calls.push(["clearFinished"]),
    addListener: (event, callback) => {
      listeners.push({ event, callback });
      return { remove() {} };
    },
    ...overrides
  };
  dom.window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: { VupsDownloads: base }
  };
  return base;
}

async function render(Panel) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  await React.act(async () => {
    rootHandle.render(React.createElement(Panel));
  });
  return container;
}

function click(container, selector) {
  const button = container.querySelector(selector);
  assert.ok(button, `${selector} must exist`);
  return React.act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

test("the panel stays absent outside the Android shell and when nothing was downloaded", async () => {
  const { default: Panel } = await loadPanel();

  delete dom.window.Capacitor;
  const web = await render(Panel);
  assert.equal(web.textContent.trim(), "");

  plugin();
  const empty = await render(Panel);
  assert.equal(empty.textContent.trim(), "");
});

test("active downloads show filename, percent, and a working cancel action", async () => {
  const native = plugin({
    list: async () => ({
      downloads: [
        {
          id: "dl-1",
          filename: "report.zip",
          mimeType: "application/zip",
          status: "running",
          bytes: 1536,
          total: 4096,
          speedBytesPerSecond: 2048,
          createdAt: 2,
          canOpen: false,
          canRetry: false
        }
      ]
    })
  });
  const { default: Panel } = await loadPanel();
  const container = await render(Panel);

  assert.match(container.textContent, /Downloads · 1 active/);
  assert.match(container.textContent, /report\.zip/);
  assert.match(container.textContent, /37% · 1\.5 KB of 4\.0 KB · 2\.0 KB\/s/);
  const bar = container.querySelector('[role="progressbar"]');
  assert.equal(bar.getAttribute("aria-valuenow"), "37");
  assert.equal(bar.getAttribute("aria-valuetext"), "37% downloaded");

  await click(container, '[aria-label="Cancel report.zip"]');
  assert.deepEqual(native.calls, [["cancel", { id: "dl-1" }]]);
});

test("bridge events update the panel through completion and removal", async () => {
  const native = plugin({
    list: async () => ({
      downloads: [
        { id: "dl-2", filename: "photo.jpg", status: "running", bytes: 10, total: 40, createdAt: 3 }
      ]
    })
  });
  const { default: Panel } = await loadPanel();
  const container = await render(Panel);
  assert.equal(native.listeners.length, 1);
  assert.equal(native.listeners[0].event, "download");

  await React.act(async () => {
    native.listeners[0].callback({
      id: "dl-2",
      filename: "photo.jpg",
      status: "completed",
      bytes: 40,
      total: 40,
      createdAt: 3,
      canOpen: true,
      canRetry: false
    });
  });
  assert.match(container.textContent, /Complete · 40 B/);
  assert.equal(container.querySelector('[role="progressbar"]'), null);
  await click(container, '[aria-label="Open photo.jpg"]');
  assert.deepEqual(native.calls, [["openFile", { id: "dl-2" }]]);

  await React.act(async () => {
    native.listeners[0].callback({ id: "dl-2", status: "removed" });
  });
  assert.equal(container.textContent.trim(), "");
});

test("failed downloads offer retry, and clearing finished entries empties the panel", async () => {
  const native = plugin({
    list: async () => ({
      downloads: [
        {
          id: "dl-3",
          filename: "video.mp4",
          status: "failed",
          bytes: 0,
          total: -1,
          error: "The server returned HTTP 503. Tap to retry.",
          createdAt: 4,
          canRetry: true
        }
      ]
    })
  });
  const { default: Panel } = await loadPanel();
  const container = await render(Panel);
  assert.match(container.textContent, /HTTP 503/);

  await click(container, '[aria-label="Retry video.mp4"]');
  assert.deepEqual(native.calls, [["retry", { id: "dl-3" }]]);

  await click(container, ".vr-downloads__clear");
  assert.deepEqual(native.calls, [["retry", { id: "dl-3" }], ["clearFinished"]]);
  assert.equal(container.textContent.trim(), "");
});

test("denied notifications keep downloads running and explain how to enable them", async () => {
  const native = plugin({
    notificationsStatus: async () => ({ granted: false, canRequest: true, enabled: false }),
    list: async () => ({
      downloads: [
        { id: "dl-4", filename: "notes.txt", status: "running", bytes: 1, total: 2, createdAt: 5 }
      ]
    })
  });
  const { default: Panel } = await loadPanel();
  const container = await render(Panel);

  assert.match(container.textContent, /Notifications are off/);
  await click(container, ".vr-downloads__permission button");
  assert.match(container.textContent, /Downloads still continue and stay visible in this panel/);
  assert.equal(native.calls.length, 0);
});
