import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

import {
  LINK_ERROR_EVENT,
  detectLinkRuntime,
  openExternalUrl,
  parseExternalUrl,
  reportLinkError
} from "../src/native/externalLinks.js";
import { PROVIDERS } from "../src/providers/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const workDir = path.join(root, "test", ".compiled-links");

// These components are plain JSX and the project has no bundler-driven test
// runner, so Vite's own esbuild step compiles them into a directory under the
// project. Relative specifiers are re-pointed at the real src tree so their
// helpers keep resolving.
async function loadComponent(name) {
  mkdirSync(workDir, { recursive: true });
  const sourcePath = path.join(root, "src", "components", `${name}.jsx`);
  const outFile = path.join(workDir, `${name}.mjs`);
  const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  writeFileSync(outFile, code.replace(/from "\.\.\//g, 'from "../../src/'));
  return import(pathToFileURL(outFile).href);
}

// The opener reads `window` at call time, so each scenario installs its own.
// A synchronous scenario restores on the same tick; an asynchronous one keeps
// the stub until its promise settles, so nothing leaks into the next test.
function withFakeWindow(properties, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const restore = () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  };
  Object.defineProperty(globalThis, "window", { value: properties, writable: true, configurable: true });
  let result;
  try {
    result = run(properties);
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === "function") return result.then(value => { restore(); return value; }, error => { restore(); throw error; });
  restore();
  return result;
}

test("only https and mail addresses are accepted as external links", () => {
  assert.equal(parseExternalUrl("https://openrouter.ai/settings/keys").hostname, "openrouter.ai");
  assert.equal(parseExternalUrl(" https://qoder.com/account/integrations ").pathname, "/account/integrations");
  assert.equal(parseExternalUrl("mailto:hi@example.com").protocol, "mailto:");

  for (const value of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/secrets.txt", "not a url", "", "ftp://example.com/x"]) {
    assert.throws(() => parseExternalUrl(value), Error, `expected rejection for ${value}`);
  }
  assert.throws(() => parseExternalUrl("https://user:pass@example.com/"), /credential/i);
  assert.throws(() => parseExternalUrl("mailto:hi@example.com", { allowMailto: false }), /https/i);
});

test("plain http is accepted for the developer's own machine and nowhere else", () => {
  assert.equal(parseExternalUrl("http://127.0.0.1:5173/desktop-auth?ticket=x").hostname, "127.0.0.1");
  assert.equal(parseExternalUrl("http://localhost:4000/api").hostname, "localhost");
  assert.throws(() => parseExternalUrl("http://example.com/desktop-auth"), /https/i);
  assert.throws(() => parseExternalUrl("http://169.254.169.254/latest/meta-data/"), /https/i);
});

test("runtime detection covers the Windows shell, the Android shell and a browser", () => {
  withFakeWindow({ __TAURI_INTERNALS__: {} }, () => assert.equal(detectLinkRuntime(), "tauri"));
  withFakeWindow({ Capacitor: { isNativePlatform: () => true } }, () => assert.equal(detectLinkRuntime(), "capacitor"));
  withFakeWindow({}, () => assert.equal(detectLinkRuntime(), "web"));
});

test("the Windows shell opens through the native opener exactly once", async () => {
  const calls = [];
  await withFakeWindow({ __TAURI_INTERNALS__: {} }, async () => {
    const opened = await openExternalUrl("https://console.anthropic.com/settings/keys", {
      runtime: "tauri",
      openUrl: url => { calls.push(url); return Promise.resolve(); }
    });
    assert.deepEqual(calls, ["https://console.anthropic.com/settings/keys"]);
    assert.equal(opened, "https://console.anthropic.com/settings/keys");
  });
});

test("a denied Windows open rejects with the reason instead of passing silently", async () => {
  await withFakeWindow({ __TAURI_INTERNALS__: {} }, async () => {
    await assert.rejects(() => openExternalUrl("https://console.groq.com/keys", {
      runtime: "tauri",
      openUrl: () => Promise.reject(new Error("opener:allow-open-url permission denied"))
    }), /permission denied/i);
  });
});

test("Android hands the link to the system browser through the WebView origin rule", async () => {
  const assigned = [];
  await withFakeWindow({ Capacitor: { isNativePlatform: () => true }, location: { assign: url => assigned.push(url) } }, async () => {
    const opened = await openExternalUrl("https://github.com/CrazyVillainFF/Vups-Router/releases/latest", {
      runtime: "capacitor"
    });
    assert.deepEqual(assigned, ["https://github.com/CrazyVillainFF/Vups-Router/releases/latest"]);
    assert.equal(opened, "https://github.com/CrazyVillainFF/Vups-Router/releases/latest");
  });
});

test("Android prefers the Browser plugin when the shell ships it", async () => {
  const calls = [];
  await withFakeWindow({
    Capacitor: { isNativePlatform: () => true, Plugins: { Browser: { open: arg => { calls.push(arg); return Promise.resolve(); } } } }
  }, async () => {
    await openExternalUrl("https://lmstudio.ai/docs/app/api", { runtime: "capacitor" });
    assert.deepEqual(calls, [{ url: "https://lmstudio.ai/docs/app/api" }]);
  });
});

test("a browser opens the link exactly once and reports a blocked popup", async () => {
  const calls = [];
  await withFakeWindow({ open: url => { calls.push(url); return { close() {} }; } }, async () => {
    await openExternalUrl("https://openrouter.ai/settings/keys", { runtime: "web" });
  });
  assert.deepEqual(calls, ["https://openrouter.ai/settings/keys"]);

  await withFakeWindow({ open: () => null }, async () => {
    await assert.rejects(() => openExternalUrl("https://openrouter.ai/settings/keys", { runtime: "web" }), /blocked/i);
  });
});

test("reportLinkError emits the shared event the toast listens for", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://vups.test/" });
  const seen = [];
  dom.window.addEventListener(LINK_ERROR_EVENT, event => seen.push(event.detail));
  return withFakeWindow(dom.window, () => {
    reportLinkError("The link could not be opened.", "https://example.com");
    assert.deepEqual(seen, [{ message: "The link could not be opened.", url: "https://example.com" }]);
    dom.window.close();
  });
});

let dom;
let React;
let ReactDOMClient;

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/settings" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
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

after(async () => {
  rmSync(workDir, { recursive: true, force: true });
  dom.window.close();
});

async function mountLink(props) {
  const { default: ExternalLink } = await loadComponent("ExternalLink");
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  await React.act(async () => { root.render(React.createElement(ExternalLink, props)); });
  return { root, anchor: container.querySelector("a") };
}

async function click(anchor, init = { bubbles: true, cancelable: true, button: 0 }) {
  const event = new dom.window.MouseEvent("click", init);
  await React.act(async () => { anchor.dispatchEvent(event); });
  return event;
}

test("the shared anchor stays a real link for keyboards, copy and middle click", async () => {
  const { root, anchor } = await mountLink({ href: "https://console.groq.com/keys", children: "Create a key" });
  assert.equal(anchor.getAttribute("href"), "https://console.groq.com/keys");
  assert.equal(anchor.target, "_blank");
  assert.equal(anchor.rel, "noopener noreferrer");
  assert.equal(anchor.textContent, "Create a key");
  await React.act(async () => { root.unmount(); });
});

test("a browser click is left to the browser so nothing double-opens", async () => {
  const opens = [];
  const { root, anchor } = await mountLink({
    href: "https://console.groq.com/keys",
    children: "Create a key",
    runtime: "web",
    onClick: () => opens.push("click"),
    onOpen: url => opens.push(`open:${url}`)
  });
  const event = await click(anchor);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(opens, ["click"]);
  await React.act(async () => { root.unmount(); });
});

test("the native shell intercepts the click and reports the opened link once", async () => {
  const opens = [];
  const { root, anchor } = await mountLink({
    href: "https://console.groq.com/keys",
    children: "Create a key",
    runtime: "tauri",
    onClick: () => opens.push("click"),
    open: async url => { opens.push(`open:${url}`); return url; },
    onOpen: url => opens.push(`done:${url}`)
  });
  const event = await click(anchor);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opens, [
    "click",
    "open:https://console.groq.com/keys",
    "done:https://console.groq.com/keys"
  ]);
  await React.act(async () => { root.unmount(); });
});

test("a middle click is never turned into a second window", async () => {
  const opened = [];
  const { root, anchor } = await mountLink({
    href: "https://console.groq.com/keys",
    children: "Create a key",
    runtime: "tauri",
    open: async url => { opened.push(url); return url; },
    onOpen: url => opened.push(url)
  });
  const event = await click(anchor, { bubbles: true, cancelable: true, button: 1 });
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(opened, []);
  await React.act(async () => { root.unmount(); });
});

test("a rejected native open raises the toast event with the link that failed", async () => {
  const details = [];
  const listener = event => details.push(event.detail);
  dom.window.addEventListener(LINK_ERROR_EVENT, listener);
  const { root, anchor } = await mountLink({ href: "javascript:alert(1)", children: "Bad link", runtime: "tauri" });
  await click(anchor);
  dom.window.removeEventListener(LINK_ERROR_EVENT, listener);
  assert.equal(details.length, 1);
  assert.match(details[0].message, /https/i);
  assert.equal(details[0].url, "javascript:alert(1)");
  await React.act(async () => { root.unmount(); });
});

test("every guide link in the app uses the shared opener", () => {
  const files = [
    "src/SettingsPage.jsx",
    "src/pages/DownloadPage.jsx",
    "src/plugins/PluginDetailView.jsx",
    "src/plugins/PluginsPage.jsx",
    "src/legal/LegalPages.jsx"
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /components\/ExternalLink\.jsx/, `${file} must import the shared opener`);
    assert.doesNotMatch(source, /<a\s[^>]*target="_blank"/, `${file} must not keep raw new-window anchors`);
  }
  assert.match(read("src/App.jsx"), /components\/LinkErrorToast\.jsx/);
});

test("provider guide URLs are real https destinations with honest labels", () => {
  const fields = ["keysUrl", "docsUrl", "pricingUrl", "website"];
  for (const provider of PROVIDERS) {
    for (const field of fields) {
      const value = provider[field];
      if (!value) continue;
      assert.ok(value.startsWith("https://"), `${provider.id}.${field} must be https, got ${value}`);
      assert.doesNotMatch(value, /localhost|127\.0\.0\.1/, `${provider.id}.${field} cannot point at a local machine`);
      assert.doesNotThrow(() => parseExternalUrl(value), `${provider.id}.${field} must be openable`);
    }
  }

  // Local runtimes issue no key, so they must not advertise a "Create a key" link.
  for (const id of ["ollama", "vllm", "localai", "lmstudio", "flagshiprouter"]) {
    assert.equal(PROVIDERS.find(entry => entry.id === id).keysUrl, undefined, `${id} does not issue API keys`);
  }

  const qoder = PROVIDERS.find(entry => entry.id === "qoder");
  assert.equal(qoder.keysUrl, "https://qoder.com/account/integrations");
  assert.equal(qoder.keysLabel, "Create a token");
  assert.match(read("src/SettingsPage.jsx"), /entry\.keysLabel \|\| "Create a key"/);
});

test("the Windows shell allows any secure link and mail, nothing else", () => {
  const capability = JSON.parse(read("src-tauri/capabilities/desktop-local.json"));
  const opener = capability.permissions.find(entry => entry?.identifier === "opener:allow-open-url");
  assert.deepEqual(opener.allow.map(entry => entry.url).sort(), ["https://*", "mailto:*"]);
  assert.deepEqual(capability.remote.urls, ["http://127.0.0.1:*"]);
  assert.equal(capability.local, false);
});
