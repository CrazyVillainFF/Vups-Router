import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-authboot");

let dom;
let React;
let ReactDOMClient;
let AuthProvider;
let useAuth;
const mounted = [];

// The real connectivity store reaches for fetch/health endpoints. Boot and
// transition behavior only depends on the boolean it publishes, so the stub
// keeps that contract and lets a test flip it.
const CONN_STUB = `
import React from "react";
function subscribe(callback) {
  globalThis.__conn.listeners.add(callback);
  return () => globalThis.__conn.listeners.delete(callback);
}
export function useConnectivity() {
  const online = React.useSyncExternalStore(subscribe, () => globalThis.__conn.online, () => globalThis.__conn.online);
  return { online, offline: !online, localOnly: !online, refresh: () => {} };
}
export function isCloudOnline() {
  return globalThis.__conn.online;
}
`;

const API_STUB = `
const state = () => globalThis.__api;
export async function fetchCurrentUser() {
  state().calls.push("me");
  const result = state().me;
  if (result instanceof Error) throw result;
  return result;
}
export function getApiErrorMessage(error) {
  return error?.message || "Request failed.";
}
export function isUnauthorizedError(error) {
  return error?.response?.status === 401;
}
export async function signIn() { return state().me; }
export async function signUp() { return state().me; }
export async function signOut() { state().calls.push("signout"); return {}; }
`;

const SETTINGS_STUB = `
export function setSettingsUser() {}
export function invalidateSettings() {}
`;

function unauthorized() {
  return Object.assign(new Error("Sign in required"), {
    isAxiosError: true,
    response: { status: 401, data: { message: "Sign in required" } }
  });
}

async function settle() {
  for (let pass = 0; pass < 8; pass += 1) {
    await React.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://vups.test/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");

  globalThis.__conn = { online: true, listeners: new Set() };
  globalThis.__api = { calls: [], me: { id: "user-1", name: "Owner" } };
  globalThis.__auth = null;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "connStub.mjs"), CONN_STUB);
  writeFileSync(path.join(outDir, "apiStub.mjs"), API_STUB);
  writeFileSync(path.join(outDir, "settingsStub.mjs"), SETTINGS_STUB);

  const sourcePath = path.join(srcDir, "context", "AuthContext.jsx");
  const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  const outFile = path.join(outDir, "AuthContext.mjs");
  writeFileSync(
    outFile,
    code
      .replace(/from "\.\.\/services\/api\.js"/g, 'from "./apiStub.mjs"')
      .replace(/from "\.\.\/services\/settingsCache\.js"/g, 'from "./settingsStub.mjs"')
      .replace(/from "\.\.\/connectivity\/connectivity\.js"/g, 'from "./connStub.mjs"')
      .replace(
        /from "\.\.\/auth\/localProfile\.js"/g,
        `from ${JSON.stringify(pathToFileURL(path.join(srcDir, "auth", "localProfile.js")).href)}`
      )
      .replace(
        /from "\.\.\/desktop\/accountSessionState\.js"/g,
        `from ${JSON.stringify(pathToFileURL(path.join(srcDir, "desktop", "accountSessionState.js")).href)}`
      )
      .replace(
        /from "\.\.\/native\/shell\.js"/g,
        `from ${JSON.stringify(pathToFileURL(path.join(srcDir, "native", "shell.js")).href)}`
      )
  );
  ({ AuthProvider, useAuth } = await import(pathToFileURL(outFile).href));
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
  dom.window.close();
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  globalThis.window.localStorage.clear();
  globalThis.__api.calls.length = 0;
  globalThis.__api.me = { id: "user-1", name: "Owner" };
  globalThis.__conn.online = true;
  globalThis.__auth = null;
  Object.defineProperty(dom.window.navigator, "onLine", { value: true, configurable: true });
});

let authValue;

function AuthProbe() {
  authValue = useAuth();
  globalThis.__auth = authValue;
  return React.createElement("div", null, authValue.status);
}

async function mountAuth() {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = ReactDOMClient.createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(AuthProvider, null, React.createElement(AuthProbe)));
  });
  await settle();
  mounted.push({ root });
  return { root, container };
}

async function goOffline() {
  await React.act(async () => {
    globalThis.__conn.online = false;
    for (const listener of globalThis.__conn.listeners) listener();
  });
  await settle();
}

async function goOnline() {
  await React.act(async () => {
    globalThis.__conn.online = true;
    for (const listener of globalThis.__conn.listeners) listener();
  });
  await settle();
}

const LOCAL_KEY = "vupsrouter.profile.local.v1";
const ACCOUNT_KEY = "vupsrouter.profile.account.v1";

function writeLocalProfile(id = "local-device-1") {
  globalThis.window.localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({ id, kind: "local", name: "Offline local profile", savedAt: "2026-11-16T00:00:00.000Z" })
  );
}

function writeAccountProfile(id = "user-9") {
  globalThis.window.localStorage.setItem(
    ACCOUNT_KEY,
    JSON.stringify({
      id,
      kind: "account",
      name: "Owner",
      email: "owner@example.com",
      savedAt: "2026-11-16T00:00:00.000Z"
    })
  );
}

test("an existing local profile boots straight into local mode without asking the server", async () => {
  writeLocalProfile();
  globalThis.__conn.online = true;
  globalThis.__api.me = unauthorized();
  await mountAuth();
  assert.equal(authValue.status, "local");
  assert.equal(authValue.user.id, "local-device-1");
  assert.deepEqual(globalThis.__api.calls, [], "no /auth/me while a local profile is in force");
});

test("an online boot with no local profile still verifies the account session", async () => {
  globalThis.__conn.online = true;
  globalThis.__api.me = unauthorized();
  await mountAuth();
  assert.equal(authValue.status, "anonymous");
  assert.deepEqual(globalThis.__api.calls, ["me"]);
});

test("reconnecting does not verify or eject a local reader", async () => {
  writeLocalProfile();
  globalThis.__conn.online = true;
  await mountAuth();
  await goOffline();
  assert.equal(authValue.status, "local");
  await goOnline();
  assert.equal(authValue.status, "local");
  assert.equal(authValue.user.id, "local-device-1");
  assert.deepEqual(globalThis.__api.calls, [], "local mode has no server session to restore");
});

test("an offline account receipt is shown offline and verified on reconnect", async () => {
  writeAccountProfile();
  Object.defineProperty(dom.window.navigator, "onLine", { value: false, configurable: true });
  globalThis.__conn.online = false;
  await mountAuth();
  assert.equal(authValue.status, "offline");
  assert.equal(authValue.user.id, "user-9");
  globalThis.__api.me = { id: "user-9", name: "Owner", email: "owner@example.com" };
  await goOnline();
  assert.equal(authValue.status, "authenticated");
  assert.deepEqual(globalThis.__api.calls, ["me"]);
});

test("a first offline boot creates a local profile that survives the next online launch", async () => {
  Object.defineProperty(dom.window.navigator, "onLine", { value: false, configurable: true });
  globalThis.__conn.online = false;
  await mountAuth();
  assert.equal(authValue.status, "local");
  const createdId = globalThis.__auth.user.id;
  assert.match(createdId, /^local-/);
  const stored = JSON.parse(globalThis.window.localStorage.getItem(LOCAL_KEY));
  assert.equal(stored.id, createdId);

  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  globalThis.__api.calls.length = 0;
  Object.defineProperty(dom.window.navigator, "onLine", { value: true, configurable: true });
  globalThis.__conn.online = true;
  await mountAuth();
  assert.equal(authValue.status, "local");
  assert.equal(authValue.user.id, createdId);
  assert.deepEqual(globalThis.__api.calls, [], "the chosen local profile is not traded for a server check");
});
