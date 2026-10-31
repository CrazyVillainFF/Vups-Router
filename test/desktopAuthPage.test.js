import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

import { apiClient } from "../src/services/api.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-authpage");
const TICKET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const APPROVAL = `/desktop-auth?ticket=${TICKET}&client=windows`;

// The approval page renders MUI and reads the session through AuthProvider, so
// it is compiled the way the plugin screens are: JSX becomes .mjs in one
// directory, relative specifiers point at their compiled twin or at the real
// source file, and bare imports keep resolving to the project's node_modules.
const COMPILED = {
  "pages/DesktopAuthPage.jsx": "DesktopAuthPage.mjs",
  "components/PageMeta.jsx": "PageMeta.mjs",
  "components/LoadingVisuals.jsx": "LoadingVisuals.mjs",
  "context/AuthContext.jsx": "AuthContext.mjs"
};

async function compile(relative) {
  mkdirSync(outDir, { recursive: true });
  const from = path.join(srcDir, relative);
  const to = path.join(outDir, COMPILED[relative]);
  const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, { loader: "jsx", jsx: "automatic" });
  const withoutCss = code.replace(/^import\s+["'][^"']+\.css["'];\s*$/gm, "");
  const rewritten = withoutCss.replace(/from "(\.[^"]*)"/g, (match, specifier) => {
    if (specifier.endsWith(".css")) return match;
    const target = path.resolve(path.dirname(from), specifier);
    const targetRelative = path.relative(srcDir, target).split(path.sep).join("/");
    if (COMPILED[targetRelative]) return `from "./${COMPILED[targetRelative]}"`;
    return `from "${path.relative(outDir, target).split(path.sep).join("/")}"`;
  });
  writeFileSync(to, rewritten);
  return to;
}

async function loadCompiled(relative) {
  return import(pathToFileURL(await compile(relative)).href);
}

let dom;
let React;
let ReactDOMClient;
let MemoryRouter;
let Routes;
let Route;
let useLocation;
let AuthProvider;
let DesktopAuthPage;

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://site.test${APPROVAL}` });
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
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame: id => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  ({ MemoryRouter, Routes, Route, useLocation } = await import("react-router-dom"));
  AuthProvider = (await loadCompiled("context/AuthContext.jsx")).AuthProvider;
  await loadCompiled("components/PageMeta.jsx");
  await loadCompiled("components/LoadingVisuals.jsx");
  DesktopAuthPage = (await loadCompiled("pages/DesktopAuthPage.jsx")).default;
  apiClient.defaults.baseURL = "https://api.test/api";
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
  delete apiClient.defaults.adapter;
  dom.window.close();
});

function Probe() {
  const location = useLocation();
  return React.createElement("div", null, `LANDING:${location.pathname}:${location.state?.from || "none"}`);
}

// The session check and the approval POST both resolve asynchronously, so the
// render is flushed until the screen settles on something visible.
async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

async function openApp(search) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  await React.act(async () => {
    root.render(
      React.createElement(
        AuthProvider,
        null,
        React.createElement(
          MemoryRouter,
          { initialEntries: [`/desktop-auth${search}`] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, { path: "/desktop-auth", element: React.createElement(DesktopAuthPage) }),
            React.createElement(Route, { path: "/signin", element: React.createElement(Probe) }),
            React.createElement(Route, { path: "/signup", element: React.createElement(Probe) })
          )
        )
      )
    );
  });
  await settle();
  return { root, container, text: () => container.textContent };
}

function axiosError(status, message) {
  return Object.assign(new Error(message || `HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data: message ? { message } : {} }
  });
}

function withBackend({ me, approve }, run) {
  const originalGet = apiClient.get;
  const originalPost = apiClient.post;
  const posts = [];
  apiClient.get = async url => {
    if (url !== "/auth/me") throw new Error(`unexpected GET ${url}`);
    if (me instanceof Error) throw me;
    return { status: 200, data: { user: me } };
  };
  apiClient.post = async (url, body) => {
    if (url !== "/auth/desktop/approve") throw new Error(`unexpected POST ${url}`);
    posts.push(body);
    if (approve instanceof Error) throw approve;
    return { status: 200, data: approve || { status: "approved" } };
  };
  const tracked = async () => {
    const result = await run(posts);
    for (const body of posts) assert.deepEqual(body, { ticket: TICKET }, "only the ticket is sent for approval");
    return result;
  };
  return tracked().finally(() => {
    apiClient.get = originalGet;
    apiClient.post = originalPost;
  });
}

test("an anonymous visitor is sent to sign in and returned to this approval page", async () => {
  return withBackend({ me: axiosError(401, "Sign in required") }, async posts => {
    const { root, text } = await openApp(`?ticket=${TICKET}&client=windows`);
    assert.equal(text(), `LANDING:/signin:${APPROVAL}`);
    assert.deepEqual(posts, [], "nothing is approved without a session");
    await React.act(async () => { root.unmount(); });
  });
});

test("a sign-up link sends the visitor to sign-up instead", async () => {
  const search = `?ticket=${TICKET}&client=windows&mode=signup`;
  return withBackend({ me: axiosError(401) }, async () => {
    const { root, text } = await openApp(search);
    assert.equal(text(), `LANDING:/signup:/desktop-auth${search}`);
    await React.act(async () => { root.unmount(); });
  });
});

test("a signed-in browser approves the app once and says what happens next", async () => {
  return withBackend({ me: { email: "owner@example.com", name: "Owner" } }, async posts => {
    const { root, container } = await openApp(`?ticket=${TICKET}&client=windows`);
    assert.equal(posts.length, 1, "the callback approves without any extra click");
    assert.deepEqual(posts[0], { ticket: TICKET });
    assert.match(container.textContent, /Return to the app/);
    assert.match(container.textContent, /finishes signing in automatically/);
    assert.match(container.textContent, /owner@example\.com/);
    assert.doesNotMatch(container.textContent, /token/i, "no credential is printed on the page");
    await React.act(async () => { root.unmount(); });
  });
});

test("a duplicate visit never sends a second approval", async () => {
  return withBackend({ me: { email: "owner@example.com", name: "Owner" } }, async posts => {
    const { root } = await openApp(`?ticket=${TICKET}&client=windows`);
    assert.equal(posts.length, 1);
    await settle();
    assert.equal(posts.length, 1, "the guard holds across re-renders");
    await React.act(async () => { root.unmount(); });
  });
});

test("an incomplete link is refused before anything is sent", async () => {
  return withBackend({ me: { email: "owner@example.com", name: "Owner" } }, async posts => {
    const { root, container } = await openApp("?ticket=short&client=windows");
    assert.deepEqual(posts, []);
    assert.match(container.textContent, /incomplete/);
    await React.act(async () => { root.unmount(); });
  });
});

test("a refused approval shows the server's reason instead of a blank spinner", async () => {
  return withBackend({
    me: { email: "owner@example.com", name: "Owner" },
    approve: axiosError(409, "This sign-in request was already used. Start again from the app.")
  }, async () => {
    const { root, container } = await openApp(`?ticket=${TICKET}&client=windows`);
    assert.match(container.textContent, /already used/);
    await React.act(async () => { root.unmount(); });
  });
});
