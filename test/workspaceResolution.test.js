import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "src", "desktop");
// Own scratch directory: node --test runs files in parallel processes and two
// suites sharing a folder delete each other's in-flight esbuild output.
const workDir = path.join(root, "test", ".compiled-workspace-resolution");

const OWNER = "owner-1";
const OTHER_OWNER = "owner-2";
const ACTIVE_KEY = owner => `vupsrouter.desktop.active-workspace.${owner}.v1`;
const BINDINGS_KEY = owner => `vupsrouter.desktop.chat-workspace.${owner}.v1`;

const SITE = { id: "ws-site", title: "React Site", path: "D:\\work\\react-site" };
const API = { id: "ws-api", title: "API", path: "D:\\work\\api" };

let React;
let ReactDOMClient;
let Provider;
let useWorkspaces;

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
    'export function useAuth() { return { user: globalThis.__resolutionOwner }; }\n'
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
    "const s = () => globalThis.__resolutionBridge;",
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
  delete globalThis.__resolutionBridge;
  delete globalThis.__resolutionOwner;
});

function bridgeStub(options = {}) {
  return {
    supported: options.supported !== false,
    calls: [],
    responses: {
      listWorkspaces: () => Promise.resolve(options.list || []),
      ensureDefaultWorkspace: () => Promise.resolve(options.defaultWorkspace || null),
      ...(options.responses || {})
    }
  };
}

async function mount(options = {}) {
  const owner = options.user === null ? null : options.owner || OWNER;
  globalThis.__resolutionBridge = bridgeStub(options);
  globalThis.__resolutionOwner = owner ? { id: owner } : null;
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

function calls(name) {
  return globalThis.__resolutionBridge.calls.filter(call => call.name === name);
}

test("an empty registry stays empty: the app never invents a project folder", async () => {
  const { value } = await mount({ list: [] });
  const context = value();

  assert.equal(calls("pickWorkspace").length, 0, "no folder picker is opened before a user acts");
  assert.equal(
    calls("addWorkspacePath").length +
      calls("createWorkspaceFolder").length +
      calls("pickContainerFolder").length,
    0,
    "no folder is adopted or created behind the user's back"
  );
  assert.deepEqual(context.workspaces, [], "nothing is registered for a fresh account");
  assert.equal(context.activeWorkspace, null, "there is no project until one is chosen");
  assert.equal(context.loading, false);
  assert.equal(context.error, "", "an empty registry is not an error");
});

test("a first Windows session adopts the managed VupsRouter Files folder as its default", async () => {
  const managed = { id: "ws-vups-files", title: "VupsRouter Files", path: "C:\\Users\\owner\\Documents\\VupsRouter\\Files" };
  const { value } = await mount({ list: [], defaultWorkspace: managed });
  await React.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  assert.deepEqual(value().workspaces, [managed]);
  assert.equal(value().activeWorkspace?.id, managed.id);
  assert.deepEqual(calls("ensureDefaultWorkspace").map(call => call.args), [[OWNER]]);
  assert.equal(globalThis.window.localStorage.getItem(ACTIVE_KEY(OWNER)), managed.id);
});

test("a registry the user already filled keeps the first folder active", async () => {
  const { value } = await mount({ list: [SITE, API] });

  assert.equal(value().activeWorkspace?.id, SITE.id);
  assert.equal(calls("pickWorkspace").length, 0, "a valid folder is never re-asked for");
});

test("the active folder saved for this owner on this device is restored on launch", async () => {
  globalThis.window.localStorage.setItem(ACTIVE_KEY(OWNER), API.id);
  const { value } = await mount({ list: [SITE, API] });

  assert.equal(value().activeWorkspace?.id, API.id, "the saved choice wins over list order");
});

test("another account's saved folder is never adopted", async () => {
  globalThis.window.localStorage.setItem(ACTIVE_KEY(OTHER_OWNER), API.id);
  const { value } = await mount({ list: [SITE] });

  assert.equal(value().activeWorkspace?.id, SITE.id, "the first folder of this owner is used");
  assert.equal(
    globalThis.window.localStorage.getItem(ACTIVE_KEY(OTHER_OWNER)),
    API.id,
    "the other account's record is left untouched"
  );
  assert.deepEqual(calls("listWorkspaces").map(call => call.args), [[OWNER]]);
});

test("a saved folder that is gone is replaced by this owner's registry, never a borrowed path", async () => {
  globalThis.window.localStorage.setItem(ACTIVE_KEY(OWNER), "ws-deleted");
  const { value } = await mount({ list: [SITE] });

  assert.equal(value().activeWorkspace?.id, SITE.id);
  assert.equal(
    globalThis.window.localStorage.getItem(ACTIVE_KEY(OWNER)),
    SITE.id,
    "the stale id does not survive the load"
  );
});

test("an empty registry clears only this owner's stale active id", async () => {
  globalThis.window.localStorage.setItem(ACTIVE_KEY(OWNER), SITE.id);
  globalThis.window.localStorage.setItem(ACTIVE_KEY(OTHER_OWNER), API.id);
  const { value } = await mount({ list: [] });

  assert.equal(value().activeWorkspace, null);
  assert.equal(globalThis.window.localStorage.getItem(ACTIVE_KEY(OWNER)), null);
  assert.equal(
    globalThis.window.localStorage.getItem(ACTIVE_KEY(OTHER_OWNER)),
    API.id,
    "another account's selection is not cleared"
  );
});

test("switching accounts asks the new owner's registry, not the previous account's", async () => {
  const first = await mount({ list: [SITE] });
  assert.equal(first.value().activeWorkspace?.id, SITE.id);

  const second = await mount({ owner: OTHER_OWNER, list: [] });
  assert.equal(second.value().activeWorkspace, null, "the new account starts with no project");
  assert.deepEqual(
    calls("listWorkspaces").map(call => call.args),
    [[OTHER_OWNER]],
    "only the new account's registry is listed"
  );
  assert.equal(
    globalThis.window.localStorage.getItem(ACTIVE_KEY(OWNER)),
    SITE.id,
    "the first account's saved folder is not destroyed"
  );
});

test("validation resolves the id under this owner and applies the disk path it reports", async () => {
  const moved = { ...SITE, path: "E:\\moved\\react-site" };
  const { value } = await mount({
    list: [SITE],
    responses: { validateWorkspace: id => Promise.resolve(moved) }
  });
  let verified;
  await React.act(async () => {
    verified = await value().validateWorkspace(SITE.id);
  });

  const [check] = calls("validateWorkspace");
  assert.deepEqual(check.args, [OWNER, SITE.id], "the owner scopes the lookup");
  assert.equal(verified.path, moved.path);
  assert.equal(value().activeWorkspace?.path, moved.path, "the UI shows the validated path");
});

test("a chat's project binding is explicit, per owner, and survives a restart", async () => {
  const first = await mount({ list: [SITE, API] });
  await React.act(async () => {
    first.value().bindChatWorkspace("chat-1", API.id);
  });

  assert.equal(first.value().chatBindingFor("chat-1"), API.id);
  assert.equal(first.value().workspaceForChat("chat-1")?.path, API.path);
  const stored = JSON.parse(globalThis.window.localStorage.getItem(BINDINGS_KEY(OWNER)));
  assert.equal(stored["chat-1"], API.id, "the binding names a registry id, not a path");

  const second = await mount({ list: [SITE, API] });
  assert.equal(second.value().chatBindingFor("chat-1"), API.id, "the binding is restored on launch");
  assert.equal(second.value().workspaceForChat("chat-1")?.id, API.id);
});

test("a chat bound to a removed folder is detached instead of following another project", async () => {
  const { value } = await mount({ list: [SITE, API] });
  await React.act(async () => {
    value().bindChatWorkspace("chat-1", SITE.id);
  });
  await React.act(async () => {
    await value().removeWorkspace(SITE.id);
  });

  assert.equal(value().chatBindingFor("chat-1"), "", "no stale id is kept for the chat");
  assert.equal(value().workspaceForChat("chat-1"), null);
  assert.equal(value().activeWorkspace?.id, API.id, "the remaining folder becomes active");
});

test("the website never calls the native workspace layer", async () => {
  const { value } = await mount({ supported: false, list: [] });

  assert.equal(globalThis.__resolutionBridge.calls.length, 0);
  assert.equal(value().supported, false);
  assert.deepEqual(value().workspaces, []);
});

test("the bridge exposes only the managed default workspace command", () => {
  const bridge = readFileSync(path.join(desktopDir, "workspaceBridge.js"), "utf8");
  assert.match(bridge, /vups_root_default_workspace/);
  assert.doesNotMatch(bridge, /defaultTaskWorkspace|createTaskProject/);
  assert.doesNotMatch(bridge, /vups_root_project/);
});

test("production sources contain no developer-specific workspace paths", () => {
  // A path may appear in a local QA fixture, never in shipped code. These are
  // the developer's own folders and placeholder home paths; production must
  // derive every workspace from the signed-in user's explicit selection.
  const forbidden = /(?:VupsRouter-QA[\\/]|C:[\\/]+Users[\\/]+(?:Vishnu|username)|Documents[\\/]+Current Project)/i;
  const roots = [path.join(root, "src"), path.join(root, "src-tauri", "src")];
  const offenders = [];
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const source = readFileSync(full, "utf8");
      if (forbidden.test(source)) offenders.push(path.relative(root, full));
    }
  };
  for (const directory of roots) walk(directory);
  assert.deepEqual(offenders, [], "no shipped source names a developer or placeholder workspace path");
});
