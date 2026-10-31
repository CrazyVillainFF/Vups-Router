import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "src", "components", "ApplicationUpdates.jsx");
const workDir = path.join(root, "test", ".compiled-updates");

const release = {
  tag_name: "v1.0.9",
  published_at: "2026-10-30T12:00:00Z",
  body: "Faster chat.\nFixed downloads.",
  assets: [
    {
      name: "VupsRouter-android-release.apk",
      browser_download_url:
        "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-android-release.apk",
      size: 8_400_000
    },
    {
      name: "VupsRouter-windows-x64-setup.exe",
      browser_download_url:
        "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-windows-x64-setup.exe",
      size: 51_200_000
    }
  ]
};

async function loadComponent() {
  mkdirSync(workDir, { recursive: true });
  const outFile = path.join(workDir, "ApplicationUpdates.mjs");
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
  delete dom.window.Capacitor;
  delete dom.window.__TAURI_INTERNALS__;
  dom.window.localStorage.clear();
  delete globalThis.fetch;
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function android({ version = "1.0.8", build = 9, downloads = {}, app = {} } = {}) {
  const listeners = [];
  const calls = [];
  const downloadsPlugin = {
    calls,
    listeners,
    list: async () => ({ downloads: [] }),
    enqueue: async options => {
      calls.push(["enqueue", options]);
      return { id: "up-1" };
    },
    cancel: async options => calls.push(["cancel", options]),
    retry: async options => calls.push(["retry", options]),
    addListener: (event, callback) => {
      listeners.push({ event, callback });
      return { remove() {} };
    },
    ...downloads
  };
  const appPlugin = {
    info: async () => ({ version, build, packageId: "com.vupsrouter.app" }),
    installUpdate: async options => {
      calls.push(["installUpdate", options]);
      return { started: true };
    },
    ...app
  };
  dom.window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    Plugins: { VupsDownloads: downloadsPlugin, VupsAppInfo: appPlugin }
  };
  return { downloadsPlugin, appPlugin, calls, listeners };
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

function jsonResponse(body) {
  return { status: 200, ok: true, json: async () => body };
}

test("installed version and the current release produce an up-to-date status", async () => {
  android({ version: "1.0.9", build: 10 });
  globalThis.fetch = async () => jsonResponse(release);
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  assert.match(container.textContent, /Installed version/);
  assert.match(container.textContent, /Version 1\.0\.9 · build 10/);
  assert.match(container.textContent, /Not checked yet/);

  await click(button(container, "Check for updates"));
  assert.match(container.textContent, /Up to date — 1\.0\.9/);
  assert.equal(button(container, "Download update"), undefined);
});

test("a newer Android release downloads through the service, then opens the verified installer", async () => {
  const native = android();
  globalThis.fetch = async () => jsonResponse(release);
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await click(button(container, "Check for updates"));
  assert.match(container.textContent, /Update available — 1\.0\.9/);
  const download = button(container, "Download update");
  assert.ok(download);
  await click(download);

  assert.deepEqual(native.calls[0], [
    "enqueue",
    {
      url: "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-android-release.apk",
      filename: "VupsRouter-android-release.apk",
      mimeType: "application/vnd.android.package-archive"
    }
  ]);

  await React.act(async () => {
    native.listeners[0].callback({
      id: "up-1",
      filename: "VupsRouter-android-release.apk",
      status: "running",
      bytes: 4200,
      total: 8400,
      createdAt: 1
    });
  });
  const bar = container.querySelector('[role="progressbar"]');
  assert.ok(bar);
  assert.equal(bar.getAttribute("aria-valuenow"), "50");

  await React.act(async () => {
    native.listeners[0].callback({
      id: "up-1",
      filename: "VupsRouter-android-release.apk",
      status: "completed",
      bytes: 8400,
      total: 8400,
      createdAt: 1
    });
  });
  assert.match(container.textContent, /Update package ready/);
  await click(button(container, "Install update"));
  assert.deepEqual(native.calls[1], ["installUpdate", { id: "up-1" }]);
  assert.match(container.textContent, /Android's installer is open/);
});

test("a rejected install reports the native verification failure", async () => {
  const native = android({
    app: {
      installUpdate: async () => {
        throw new Error(
          "VupsAppInfo.installUpdate: This update is signed with a different certificate than the installed app."
        );
      }
    }
  });
  dom.window.localStorage.setItem(
    "vupsrouter.updates.androidDownload",
    JSON.stringify({ id: "up-2", version: "v1.0.9" })
  );
  native.downloadsPlugin.list = async () => ({
    downloads: [
      {
        id: "up-2",
        filename: "VupsRouter-android-release.apk",
        status: "completed",
        bytes: 8400,
        total: 8400,
        createdAt: 1,
        canOpen: true
      }
    ]
  });
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  assert.match(container.textContent, /Update package ready/);
  await click(button(container, "Install update"));
  assert.match(container.textContent, /Update installation failed: This update is signed with a different certificate/);
});

test("failed update downloads explain the failure and can be retried", async () => {
  const native = android();
  globalThis.fetch = async () => jsonResponse(release);
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await click(button(container, "Check for updates"));
  await click(button(container, "Download update"));
  await React.act(async () => {
    native.listeners[0].callback({
      id: "up-1",
      filename: "VupsRouter-android-release.apk",
      status: "failed",
      bytes: 0,
      total: 8400,
      error: "The download server is busy.",
      createdAt: 1,
      canRetry: true
    });
  });
  assert.match(container.textContent, /Update download failed: The download server is busy\./);
  await click(button(container, "Try again"));
  assert.deepEqual(native.calls[1], ["retry", { id: "up-1" }]);
});

test("an unreachable release feed says so and keeps the check available", async () => {
  android();
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  await click(button(container, "Check for updates"));
  assert.match(container.textContent, /Unable to check for updates\. Check your connection and try again\./);
  assert.ok(button(container, "Check for updates"));
});

test("checking twice is impossible while the first request is pending", async () => {
  android();
  let resolveFetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Promise(resolve => {
      resolveFetch = () => resolve(jsonResponse(release));
    });
  };
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  const check = button(container, "Check for updates");
  await click(check);
  assert.equal(check.disabled, true);
  assert.match(container.textContent, /Checking the official release feed/);
  assert.equal(requests, 1);

  await React.act(async () => {
    resolveFetch();
  });
  assert.match(container.textContent, /Update available/);
  assert.equal(requests, 1);
});

test("a completed update is restored after leaving settings, with data kept intact", async () => {
  const native = android();
  native.downloadsPlugin.list = async () => ({
    downloads: [
      {
        id: "up-3",
        filename: "VupsRouter-android-release.apk",
        status: "completed",
        bytes: 8400,
        total: 8400,
        createdAt: 1,
        canOpen: true
      }
    ]
  });
  dom.window.localStorage.setItem(
    "vupsrouter.updates.androidDownload",
    JSON.stringify({ id: "up-3", version: "v1.0.9" })
  );
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  assert.match(container.textContent, /Update package ready/);
  assert.match(container.textContent, /Installed version/);
});

test("Windows reports the release but never pretends an installer is wired up", async () => {
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async cmd => (cmd === "plugin:app|version" ? "1.0.8" : null)
  };
  globalThis.fetch = async () => jsonResponse(release);
  const { default: Component } = await loadComponent();
  const container = await render(Component);

  assert.match(container.textContent, /Windows app/);
  assert.match(container.textContent, /Version 1\.0\.8/);
  await click(button(container, "Check for updates"));
  assert.match(container.textContent, /Automatic installation is not configured in this Windows build/);
  assert.match(container.textContent, /signed update manifest/);
  assert.ok(button(container, "Open release page"));
  assert.equal(button(container, "Download update"), undefined);
  assert.equal(button(container, "Install update"), undefined);
});
