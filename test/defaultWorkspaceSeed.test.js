import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "src", "desktop");
// Own scratch directory: node --test runs files in parallel processes and two
// suites sharing a folder delete each other's in-flight esbuild output.
const workDir = path.join(root, "test", ".compiled-default-seed");

let React;
let ReactDOMClient;
let Provider;
let useWorkspaces;

const DEFAULT_WORKSPACE = {
  id: "ws-app-files",
  title: "VupsRouter Files",
  path: "C:\\Users\\tester\\Documents\\VupsRouter\\Files"
};

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    // `navigator` is a read-only accessor on Node's global, so these have to be
    // redefined rather than assigned.
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");

  mkdirSync(workDir, { recursive: true });
  writeFileSync(
    path.join(workDir, "authStub.mjs"),
    'export function useAuth() { return { user: globalThis.__seedOwner }; }\n'
  );
  // The provider's own import list decides what the stub must export, so a new
  // bridge call in the provider cannot silently leave this suite behind.
  const sourcePath = path.join(desktopDir, "WorkspaceContext.jsx");
  const providerSource = readFileSync(sourcePath, "utf8");
  const bridgeNames = /import \{([^}]*)\} from "\.\/workspaceBridge\.js"/
    .exec(providerSource)[1]
    .split(",")
    .map(entry => entry.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);
  const stubSource = [
    "const s = () => globalThis.__seedBridge;",
    "function call(name, args) {",
    "  s().calls.push({ name, args });",
    "  const handler = s().responses[name];",
    "  return handler ? handler(...args) : Promise.resolve(null);",
    "}",
    // A runtime probe answers synchronously, and recording every render as a
    // native call would hide the calls that matter.
    "export function isTauriRuntime() { return s().supported; }"
  ]
    .concat(
      bridgeNames
        .filter(name => name !== "isTauriRuntime")
        .map(name => `export function ${name}(...args) { return call(${JSON.stringify(name)}, args); }`)
    )
    .join("\n");
  writeFileSync(path.join(workDir, "bridgeStub.mjs"), stubSource + "\n");

  const { code } = await transformWithEsbuild(providerSource, sourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  const outFile = path.join(workDir, "WorkspaceContext.mjs");
  writeFileSync(
    outFile,
    code
      .replace(/from "\.\.\/context\/AuthContext\.jsx"/g, 'from "./authStub.mjs"')
      .replace(/from "\.\/workspaceBridge\.js"/g, 'from "./bridgeStub.mjs"')
      .replace(
        /from "\.\/chatWorkspaceBindings\.js"/g,
        `from ${JSON.stringify(pathToFileURL(path.join(desktopDir, "chatWorkspaceBindings.js")).href)}`
      )
  );
  const mod = await import(pathToFileURL(outFile).href);
  Provider = mod.WorkspaceProvider;
  useWorkspaces = mod.useWorkspaces;
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const mounted = [];

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  globalThis.window.localStorage.clear();
  delete globalThis.__seedBridge;
  delete globalThis.__seedOwner;
});

function bridgeStub(options = {}) {
  const stub = {
    supported: options.supported !== false,
    calls: [],
    responses: {
      listWorkspaces: () => Promise.resolve(options.list || []),
      defaultTaskWorkspace: () => Promise.resolve(options.defaultWorkspace || null),
      ...(options.responses || {})
    }
  };
  return stub;
}

async function mount(options = {}) {
  globalThis.__seedBridge = bridgeStub(options);
  globalThis.__seedOwner = options.user === null ? null : { id: options.owner || "owner-1" };
  const container = globalThis.window.document.createElement("div");
  globalThis.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  let value = null;
  function Probe() {
    value = useWorkspaces();
    return null;
  }
  await React.act(async () => {
    rootHandle.render(React.createElement(Provider, null, React.createElement(Probe)));
  });
  await React.act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return { value: () => value, container };
}

const DEFAULT_RECORD = { ...DEFAULT_WORKSPACE, addedAt: 1, lastOpenedAt: 1 };

test("a machine with no registered folder is given the app's own folder instead of a question", async () => {
  const { value } = await mount({ list: [], defaultWorkspace: DEFAULT_RECORD });
  const context = value();

  const seeds = globalThis.__seedBridge.calls.filter(call => call.name === "defaultTaskWorkspace");
  assert.equal(seeds.length, 1, "the app resolves one default folder, once");
  assert.deepEqual(seeds[0].args, ["owner-1"], "the signed-in owner is the only argument");
  assert.equal(context.activeWorkspace?.id, "ws-app-files", "the Files panel, terminal and agent all have a root");
  assert.equal(
    context.activeWorkspace?.path,
    "C:\\Users\\tester\\Documents\\VupsRouter\\Files",
    "the path is the one Windows reported, not one the interface invented"
  );
  assert.equal(context.workspaces.length, 1, "the default folder is a real registered workspace");
  assert.equal(context.error, "", "nothing is asked for and nothing is wrong");
});

test("folders the user already chose are never displaced by the default", async () => {
  const chosen = [{ id: "ws-real", title: "React Site", path: "D:\\work\\react-site" }];
  const { value } = await mount({ list: chosen, defaultWorkspace: DEFAULT_RECORD });

  assert.equal(globalThis.__seedBridge.calls.filter(call => call.name === "defaultTaskWorkspace").length, 0);
  assert.equal(value().activeWorkspace?.id, "ws-real", "the first registered folder stays the active one");
});

test("a default folder that cannot be resolved is reported, not simulated", async () => {
  const { value } = await mount({
    list: [],
    responses: {
      defaultTaskWorkspace: () =>
        Promise.reject(new Error("Windows did not report a Documents folder for this user."))
    }
  });
  const context = value();

  assert.equal(context.activeWorkspace, null, "no folder is shown as if it existed");
  assert.equal(context.error, "Windows did not report a Documents folder for this user.");
  assert.equal(
    globalThis.__seedBridge.calls.filter(call => call.name === "defaultTaskWorkspace").length,
    1,
    "a failure is not retried on every render"
  );
});

test("the website never resolves a Windows folder", async () => {
  const { value } = await mount({ supported: false, list: [] });

  assert.equal(globalThis.__seedBridge.calls.length, 0, "no native call is made outside the app");
  assert.equal(value().supported, false);
});

test("a refresh that finds an empty registry re-adopts the app's folder once", async () => {
  const { value } = await mount({ list: [], defaultWorkspace: DEFAULT_RECORD });
  const before = globalThis.__seedBridge.calls.filter(call => call.name === "defaultTaskWorkspace").length;

  await React.act(async () => {
    await value().refresh();
  });

  const after = globalThis.__seedBridge.calls.filter(call => call.name === "defaultTaskWorkspace");
  assert.equal(after.length, before + 1, "the reload path behaves like the first load");
  assert.equal(value().workspaces.length, 1, "the same folder is adopted again, not duplicated in the list");
});

test("the bridge asks the native side for the default folder by its real command", () => {
  const bridge = readFileSync(path.join(desktopDir, "workspaceBridge.js"), "utf8");
  const command = /export async function defaultTaskWorkspace[\s\S]*?tauriInvoke\("([a-z_]+)"/.exec(bridge);
  assert.ok(command, "the bridge exposes the default folder to the app");
  assert.equal(command[1], "vups_root_default_workspace");
});
