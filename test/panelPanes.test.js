import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelDir = path.join(root, "src", "desktop", "panel");
const workDir = path.join(root, "test", ".compiled-panes");

let dom;
let React;
let ReactDOMClient;
let PanelProvider;
let usePanel;
let FilesPane;
let ReviewPane;
let BrowserPane;
let model;

// Every call these three panes make is a real filesystem, git or webview
// operation, so the panes are driven against recorders; the Rust suites own the
// behaviour behind each command.
const WORKSPACE_STUB = `
export function useWorkspaces() { return globalThis.__workspaceStub; }
`;

const SHELL_STUB = `
export function isTauriRuntime() { return globalThis.__tauriRuntime === true; }
export function detectNativeShell() { return "windows"; }
`;

const ATTACHMENTS_STUB = `
export function formatBytes(value) { return \`\${value} B\`; }
`;

const WORKSPACE_BRIDGE_STUB = `
const s = () => globalThis.__workspaceBridgeStub;
function record(name, args) { s().calls.push({ name, ...args }); return s().result(name, args); }
export function listWorkspaceTree(owner, id, path) { return record("tree", { owner, id, path }); }
export function searchWorkspace(owner, id, query) { return record("search", { owner, id, query }); }
export function readWorkspaceText(owner, id, path) { return record("readText", { owner, id, path }); }
export function reviewWorkspaceGit(owner, id) { return record("reviewGit", { owner, id }); }
export function listWorkspaces(owner) { return record("list", { owner }); }
export function pickWorkspace(owner) { return record("pick", { owner }); }
export function renameWorkspace(owner, id, title) { return record("rename", { owner, id, title }); }
export function removeWorkspace(owner, id) { return record("remove", { owner, id }); }
export function scanWorkspace(owner, id) { return record("scan", { owner, id }); }
export function readWorkspaceFile(owner, id, path) { return record("readFile", { owner, id, path }); }
export function createWorkspaceFile(owner, id, path, content) { return record("createFile", { owner, id, path, content }); }
export function writeWorkspaceFile(owner, id, path, content) { return record("writeFile", { owner, id, path, content }); }
export function makeWorkspaceDirectory(owner, id, path) { return record("makeDirectory", { owner, id, path }); }
export function renameWorkspacePath(owner, id, path, newName) { return record("renamePath", { owner, id, path, newName }); }
export function moveWorkspacePath(owner, id, path, directory) { return record("movePath", { owner, id, path, directory }); }
export function deleteWorkspacePath(owner, id, path) { return record("deletePath", { owner, id, path }); }
`;

const BROWSER_BRIDGE_STUB = `
const s = () => globalThis.__browserBridgeStub;
export const isTauriRuntime = () => true;
function record(name, args) { s().calls.push({ name, ...args }); return s().result(name, args); }
export function createBrowserTab(tabId, url, bounds) { return record("create", { tabId, url, bounds }); }
export function setBrowserBounds(tabId, bounds) { return record("bounds", { tabId, bounds }); }
export function navigateBrowserTab(tabId, url) { return record("navigate", { tabId, url }); }
export function browserGoBack(tabId) { return record("back", { tabId }); }
export function browserGoForward(tabId) { return record("forward", { tabId }); }
export function browserReload(tabId) { return record("reload", { tabId }); }
export function browserStatus(tabId) { return record("status", { tabId }); }
export function browserInspect(tabId) { return record("inspect", { tabId }); }
export function browserClick(tabId, selector) { return record("click", { tabId, selector }); }
export function browserType(tabId, selector, text, submit) { return record("type", { tabId, selector, text, submit }); }
export function browserScroll(tabId, selector, deltaY) { return record("scroll", { tabId, selector, deltaY }); }
export function browserScreenshot(tabId, x, y, width, height) { return record("screenshot", { tabId, x, y, width, height }); }
export function closeBrowserTab(tabId) { return record("close", { tabId }); }
export function closeAllBrowserTabs() { return record("closeAll", {}); }
`;

const RECT = { left: 140, top: 96, width: 300, height: 420 };

before(async () => {
  mkdirSync(workDir, { recursive: true });

  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  // jsdom performs no layout, so the stage rect the pane measures is scripted.
  const originalRect = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function patched() {
    if (this.classList?.contains("vr-browser-stage")) {
      return {
        ...RECT,
        right: RECT.left + RECT.width,
        bottom: RECT.top + RECT.height,
        x: RECT.left,
        y: RECT.top
      };
    }
    return originalRect.call(this);
  };
  globalThis.__tauriRuntime = true;

  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  writeFileSync(path.join(workDir, "workspaceStub.mjs"), WORKSPACE_STUB);
  writeFileSync(path.join(workDir, "shellStub.mjs"), SHELL_STUB);
  writeFileSync(path.join(workDir, "attachmentsStub.mjs"), ATTACHMENTS_STUB);
  writeFileSync(path.join(workDir, "workspaceBridgeStub.mjs"), WORKSPACE_BRIDGE_STUB);
  writeFileSync(path.join(workDir, "browserBridgeStub.mjs"), BROWSER_BRIDGE_STUB);

  const shared = code =>
    code
      .replace(/^import\s+"\.\/[^"]+\.css";\s*$/m, "")
      .replace(/from "\.\/panelModel\.js"/g, 'from "./panelModel.mjs"')
      .replace(/from "\.\/PanelContext\.jsx"/g, 'from "./PanelContext.mjs"');

  // Phosphor ships hundreds of components; each pane only needs the handful it
  // imports, so its stub is generated from its own import list. The brace-free
  // character class keeps the match inside the phosphor statement instead of
  // swallowing the react / react/jsx-runtime imports that precede it.
  function stubIcons(code, stem) {
    const clauses = [
      ...new Set(
        [...code.matchAll(/import\s*\{([^{}]*)\}\s*from\s*"@phosphor-icons\/react"/g)]
          .flatMap(match => match[1].split(","))
          .map(part => part.trim())
          .filter(Boolean)
      )
    ];
    const exports = clauses.map(clause => {
      const [imported, local = imported] = clause.split(/\s+as\s+/).map(part => part.trim());
      return `export const ${local} = make("${imported}");`;
    });
    writeFileSync(
      path.join(workDir, `iconStub-${stem}.mjs`),
      `import React from "react";
function make(name) {
  return function Icon(props) {
    return React.createElement("svg", { "data-icon": name, "aria-hidden": "true", width: props.size || 16 });
  };
}
${exports.join("\n")}
`
    );
    return code.replace(/from "@phosphor-icons\/react"/g, `from "./iconStub-${stem}.mjs"`);
  }

  async function compile(fileName, rewrite) {
    const sourcePath = path.join(panelDir, fileName);
    const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
      loader: fileName.endsWith(".jsx") ? "jsx" : "js",
      jsx: "automatic"
    });
    const outFile = path.join(workDir, fileName.replace(/\.jsx?$/, ".mjs"));
    writeFileSync(outFile, rewrite(code));
    return import(pathToFileURL(outFile).href);
  }

  model = await compile("panelModel.js", shared);
  const context = await compile("PanelContext.jsx", shared);
  PanelProvider = context.PanelProvider;
  usePanel = context.usePanel;

  const filesystem = (code, stem) =>
    stubIcons(code, stem)
      .replace(/from "\.\.\/WorkspaceContext\.jsx"/g, 'from "./workspaceStub.mjs"')
      .replace(/from "\.\.\/workspaceBridge\.js"/g, 'from "./workspaceBridgeStub.mjs"')
      .replace(/from "\.\.\/\.\.\/chat\/attachments\.js"/g, 'from "./attachmentsStub.mjs"')
      // Name rules are the real ones: a pane that accepted a name Rust would reject
      // would offer a button that always fails, so the module is imported in place.
      .replace(
        /from "\.\.\/workspaceRequest\.js"/g,
        `from ${JSON.stringify(pathToFileURL(path.join(root, "src", "desktop", "workspaceRequest.js")).href)}`
      )
      .replace(/from "\.\.\/\.\.\/native\/shell\.js"/g, 'from "./shellStub.mjs"');

  FilesPane = (await compile("FilesPane.jsx", code => filesystem(shared(code), "files"))).default;
  ReviewPane = (await compile("ReviewPane.jsx", code => filesystem(shared(code), "review"))).default;
  BrowserPane = (
    await compile(
      "BrowserPane.jsx",
      code =>
        filesystem(shared(code), "browser").replace(
          /from "\.\.\/panelBrowserBridge\.js"/g,
          'from "./browserBridgeStub.mjs"'
        )
    )
  ).default;
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const mounted = [];

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
  dom.window.localStorage.clear();
  delete globalThis.__workspaceStub;
  delete globalThis.__workspaceBridgeStub;
  delete globalThis.__browserBridgeStub;
});

function fileEntry(name, filePath, kind, size, extra = {}) {
  return { name, path: filePath, kind, size, readable: true, restricted: false, ...extra };
}

const TREE = {
  path: "",
  entries: [
    fileEntry("src", "src", "directory", 0),
    fileEntry("private", "private", "directory", 0, { restricted: true }),
    fileEntry("README.md", "README.md", "file", 120),
    fileEntry("big.bin", "big.bin", "file", 9000, { readable: false })
  ],
  truncated: false
};

function workspaceStub(overrides = {}) {
  const stub = {
    supported: true,
    owner: "user-1",
    activeWorkspace: { id: "ws-1", title: "demo", path: "C:\\project\\demo" },
    addWorkspace: () => Promise.resolve(),
    // The real context holds a per-workspace revision counter that only a finished
    // native write bumps; the panes never poll for changes.
    revisions: {},
    touched: [],
    touchWorkspace(id) {
      stub.touched.push(id);
      stub.revisions = { ...stub.revisions, [id]: (stub.revisions[id] || 0) + 1 };
    },
    ...overrides
  };
  return stub;
}

function recorder(responses = {}) {
  return {
    calls: [],
    result(name, args) {
      const handler = responses[name];
      if (!handler) return Promise.resolve(null);
      const value = handler(args);
      return value instanceof Promise ? value : Promise.resolve(value);
    }
  };
}

async function setup(Pane, options = {}) {
  globalThis.__workspaceStub = workspaceStub(options.workspace);
  globalThis.__workspaceBridgeStub = options.workspaceBridge || recorder();
  globalThis.__browserBridgeStub = options.browserBridge || recorder();
  model.writePanelState(dom.window.localStorage, {
    open: true,
    activeTab: options.tab,
    width: 460
  });

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });

  const panel = { selectTab: () => {} };
  function TabSwitch() {
    const value = usePanel();
    panel.selectTab = value.selectTab;
    return null;
  }

  await React.act(async () => {
    rootHandle.render(
      React.createElement(PanelProvider, null, React.createElement(Pane), React.createElement(TabSwitch))
    );
  });
  await flush();
  return {
    container,
    workspace: globalThis.__workspaceBridgeStub,
    browser: globalThis.__browserBridgeStub,
    state: globalThis.__workspaceStub,
    selectTab: id => clickTab(id),
    // A completed native write lands in the shared context as a higher revision,
    // which re-renders the pane. This reproduces that signal with no click, no
    // poll and no remount, so a reload can only come from the revision effect.
    refresh: async () => {
      await React.act(async () => {
        rootHandle.render(
          React.createElement(PanelProvider, null, React.createElement(Pane), React.createElement(TabSwitch))
        );
      });
      await flush();
    }
  };

  async function clickTab(id) {
    await React.act(async () => {
      panel.selectTab(id);
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
    await flush();
  }
}

async function flush(times = 2) {
  for (let index = 0; index < times; index += 1) {
    await React.act(async () => {
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });
    });
  }
}

function findButton(container, label) {
  return [...container.querySelectorAll("button")].find(node =>
    `${node.textContent} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`.includes(label)
  );
}

function click(node) {
  return React.act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function setValue(input, value) {
  // React tracks the value it last rendered, so assigning `input.value` directly is
  // invisible to onChange; the prototype setter has to be called.
  const proto = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(input, value);
}

async function fill(container, inputSelector, value) {
  const input = container.querySelector(inputSelector);
  await React.act(async () => {
    setValue(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

async function fillAndSubmit(container, formSelector, inputSelector, value) {
  await fill(container, inputSelector, value);
  await React.act(async () => {
    container
      .querySelector(formSelector)
      .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

function names(stub) {
  return stub.calls.map(call => call.name);
}

function calls(stub, name) {
  return stub.calls.filter(call => call.name === name);
}

function rowFor(container, name) {
  return [...container.querySelectorAll(".vr-pane-row")].find(
    row => row.querySelector(".vr-pane-row__name")?.textContent === name
  );
}

function rowAction(container, label) {
  return container.querySelector(`button[aria-label="${label}"]`);
}

function inlineFormButton(container) {
  return container.querySelector(".vr-pane-inline-form .vr-panel-action");
}

/* ------------------------------------------------------------------ files */

test("the files pane asks for the Windows app when the shell is unavailable", async () => {
  const { container } = await setup(FilesPane, { tab: "files", workspace: { supported: false } });
  assert.match(container.textContent, /Workspace files are available in the Windows app/);
});

test("the files pane offers to choose a folder before any listing", async () => {
  let picked = 0;
  const { container } = await setup(FilesPane, {
    tab: "files",
    workspace: { activeWorkspace: null, addWorkspace: () => { picked += 1; return Promise.resolve(); } }
  });
  assert.match(container.textContent, /Choose a project folder/);
  await click(findButton(container, "Choose folder"));
  assert.equal(picked, 1);
  assert.deepEqual(names(globalThis.__workspaceBridgeStub), []);
});

test("the files pane lists the workspace with folders first and flags what it will not open", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({ tree: () => TREE })
  });
  assert.deepEqual(workspace.calls[0], { name: "tree", owner: "user-1", id: "ws-1", path: "" });
  const rows = [...container.querySelectorAll(".vr-pane-row")];
  // Folders first, then locale order, matching the native listing sort.
  assert.deepEqual(
    rows.map(row => row.querySelector(".vr-pane-row__name").textContent),
    ["private/", "src/", "big.bin", "README.md"]
  );
  // The reason a row cannot be opened is shown, not left implied by a blank cell.
  assert.deepEqual(
    rows.map(row => row.querySelector(".vr-pane-badge")?.textContent ?? ""),
    ["restricted", "", "not previewable", ""]
  );
  assert.equal(rows[3].querySelector(".vr-pane-row__path").textContent, "120 B");
  assert.equal(
    rowFor(container, "big.bin").querySelector(".vr-pane-row__main").disabled,
    true,
    "an unreadable file cannot be opened"
  );
  assert.equal(rowFor(container, "src/").querySelector(".vr-pane-row__main").disabled, false);
});

test("the files pane navigates into a folder and back out", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: args =>
        args.path === "src"
          ? { ...TREE, path: "src", entries: [fileEntry("app.js", "src/app.js", "file", 10)] }
          : TREE
    })
  });
  await click(findButton(container, "src/"));
  assert.deepEqual(workspace.calls.at(-1), { name: "tree", owner: "user-1", id: "ws-1", path: "src" });
  assert.match(container.querySelector(".vr-pane-crumb__path").textContent, /src/);

  await click(findButton(container, "Up one folder"));
  assert.deepEqual(workspace.calls.at(-1), { name: "tree", owner: "user-1", id: "ws-1", path: "" });
});

test("the files pane searches and can return to the folder listing", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      search: () => ({ hits: [{ name: "panelModel.js", path: "src/desktop/panel/panelModel.js", line: 12 }] })
    })
  });
  await fillAndSubmit(container, ".vr-pane-search", 'input[aria-label="Search workspace"]', "panelModel");
  assert.deepEqual(workspace.calls.find(call => call.name === "search").query, "panelModel");
  assert.match(container.textContent, /1 search result/);
  assert.match(container.querySelector(".vr-pane-row__path").textContent, /src\/desktop\/panel/);

  await click(findButton(container, "Back to folder"));
  assert.match(container.textContent, /README.md/);
});

test("the files pane previews a readable file and never opens a restricted one", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => ({ path: "README.md", content: "# Demo\n", truncated: false })
    })
  });
  await click(findButton(container, "README.md"));
  assert.deepEqual(workspace.calls.find(call => call.name === "readText"), {
    name: "readText",
    owner: "user-1",
    id: "ws-1",
    path: "README.md"
  });
  assert.match(container.querySelector(".vr-file-preview__body").textContent, /# Demo/);

  const unreadable = [...container.querySelectorAll(".vr-pane-row")].find(row =>
    row.textContent.includes("big.bin")
  );
  await click(unreadable);
  assert.equal(
    workspace.calls.filter(call => call.name === "readText").length,
    1,
    "an unreadable file must not be requested"
  );
});

test("the files pane surfaces the native refusal instead of an empty list", async () => {
  const { container } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => Promise.reject(new Error("That folder is outside the selected workspace."))
    })
  });
  assert.match(container.querySelector(".vr-inline-error").textContent, /outside the selected workspace/);
});

test("the files pane creates a real folder inside the one being browsed", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      makeDirectory: () => ({ path: "src/docs", kind: "directory", size: 0 })
    })
  });
  await click(findButton(container, "src/"));
  await click(findButton(container, "New folder in this location"));
  await fillAndSubmit(container, ".vr-pane-inline-form", 'input[aria-label="New folder name"]', "docs");

  assert.deepEqual(calls(workspace, "makeDirectory"), [
    { name: "makeDirectory", owner: "user-1", id: "ws-1", path: "src/docs" }
  ]);
  assert.match(container.textContent, /src\/docs was created on disk/);
  assert.deepEqual(state.touched, ["ws-1"], "a folder that now exists tells the explorer to re-read disk");
});

test("a new file is created empty at the browsed location", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      createFile: () => ({ path: "index.html", kind: "file", size: 0 })
    })
  });
  await click(findButton(container, "New file in this location"));
  await fillAndSubmit(container, ".vr-pane-inline-form", 'input[aria-label="New file name"]', "index.html");

  assert.deepEqual(calls(workspace, "createFile"), [
    { name: "createFile", owner: "user-1", id: "ws-1", path: "index.html", content: "" }
  ]);
  assert.equal(state.touched.length, 1);
  assert.equal(container.querySelector(".vr-pane-inline-form"), null, "the form closes once the file exists");
});

test("a name Windows would reject is stopped before anything reaches the disk", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({ tree: () => TREE })
  });
  await click(findButton(container, "New folder in this location"));
  const name = 'input[aria-label="New folder name"]';

  await fillAndSubmit(container, ".vr-pane-inline-form", name, "con");
  assert.match(container.querySelector(".vr-inline-error").textContent, /Windows reserves that name/);

  await fillAndSubmit(container, ".vr-pane-inline-form", name, "src/../../Windows");
  assert.match(container.querySelector(".vr-inline-error").textContent, /cannot contain/);

  assert.equal(calls(workspace, "makeDirectory").length, 0, "an illegal name must not be sent to the native layer");
  assert.deepEqual(state.touched, [], "nothing was created, so nothing reloads");
  assert.ok(container.querySelector(".vr-pane-inline-form"), "the form stays open so the name can be fixed");
});

test("rename sends only the new single segment for the chosen entry", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      renamePath: () => ({ path: "NOTES.md", kind: "file", size: 120 })
    })
  });
  await click(rowAction(container, "Rename README.md"));
  assert.equal(container.querySelector('input[aria-label="New name"]').value, "README.md");

  await fill(container, 'input[aria-label="New name"]', "NOTES.md");
  await click(inlineFormButton(container));

  assert.deepEqual(calls(workspace, "renamePath"), [
    { name: "renamePath", owner: "user-1", id: "ws-1", path: "README.md", newName: "NOTES.md" }
  ]);
  assert.match(container.textContent, /README.md is now named NOTES.md/);
  assert.equal(state.touched.length, 1);
});

test("move normalises the destination and refuses a folder outside the project", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      movePath: () => ({ path: "src/README.md", kind: "file", size: 120 })
    })
  });
  await click(rowAction(container, "Move README.md"));
  await fill(container, 'input[aria-label="Destination folder"]', "src\\");
  await click(inlineFormButton(container));

  assert.deepEqual(calls(workspace, "movePath"), [
    { name: "movePath", owner: "user-1", id: "ws-1", path: "README.md", directory: "src" }
  ]);

  await click(rowAction(container, "Move README.md"));
  await fill(container, 'input[aria-label="Destination folder"]', "C:\\Windows");
  await click(inlineFormButton(container));

  assert.match(container.querySelector(".vr-inline-error").textContent, /Choose a folder inside this project/);
  assert.equal(calls(workspace, "movePath").length, 1, "a destination outside the project is never sent");
  assert.equal(state.touched.length, 1, "the refused move reports no change");
});

test("delete is confirmed first and only then removes the real path", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      deletePath: () => ({ path: "src", kind: "directory", removed: true })
    })
  });
  await click(rowAction(container, "Delete src"));
  const confirm = container.querySelector(".vr-pane-confirm");
  assert.ok(confirm, "a destructive action asks before it acts");
  assert.match(confirm.textContent, /Delete src and everything inside it from disk/);
  assert.deepEqual(calls(workspace, "deletePath"), []);

  await click(confirm.querySelector(".vr-link-btn"));
  assert.equal(container.querySelector(".vr-pane-confirm"), null);
  assert.deepEqual(calls(workspace, "deletePath"), [], "keeping the folder must send nothing");

  await click(rowAction(container, "Delete src"));
  await click(container.querySelector(".vr-pane-confirm__danger"));

  assert.deepEqual(calls(workspace, "deletePath"), [
    { name: "deletePath", owner: "user-1", id: "ws-1", path: "src" }
  ]);
  assert.match(container.textContent, /src was deleted from disk/);
  assert.deepEqual(state.touched, ["ws-1"]);
});

test("editing a file writes the typed text back to the same path", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => ({ path: "README.md", content: "# Demo\n", size: 8, truncated: false }),
      writeFile: () => ({ path: "README.md", size: 40 })
    })
  });
  await click(findButton(container, "README.md"));
  await click(findButton(container, "Edit this file"));
  await fill(container, "textarea.vr-file-editor", "# Notes\n\nWritten in the panel.\n");
  await click(findButton(container, "Save"));

  assert.deepEqual(calls(workspace, "writeFile"), [
    { name: "writeFile", owner: "user-1", id: "ws-1", path: "README.md", content: "# Notes\n\nWritten in the panel.\n" }
  ]);
  assert.match(container.textContent, /README.md saved to disk/);
  assert.equal(container.querySelector("textarea.vr-file-editor"), null, "the editor closes once the write is done");
  assert.equal(state.touched.length, 1);
});

test("discarding keeps the file exactly as disk had it", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => ({ path: "README.md", content: "# Demo\n", size: 8, truncated: false })
    })
  });
  await click(findButton(container, "README.md"));
  await click(findButton(container, "Edit this file"));
  await fill(container, "textarea.vr-file-editor", "throwaway");
  await click(findButton(container, "Discard edits"));

  assert.equal(container.querySelector(".vr-file-preview__body").textContent, "# Demo\n");
  assert.deepEqual(calls(workspace, "writeFile"), []);
  assert.deepEqual(state.touched, []);
});

test("a truncated preview cannot be edited because saving would drop the tail", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => ({ path: "README.md", content: "# only the first part", size: 4_000_000, truncated: true })
    })
  });
  await click(findButton(container, "README.md"));
  const edit = findButton(container, "Edit");
  assert.equal(edit.disabled, true, "saving a partial read would overwrite the rest of the file");
  assert.match(edit.getAttribute("title"), /Too large to edit safely/);
  assert.equal(container.querySelector("textarea.vr-file-editor"), null);
  assert.deepEqual(calls(workspace, "writeFile"), []);
});

test("an agent write re-reads the folder the pane is actually showing", async () => {
  const nested = { ...TREE, path: "src", entries: [fileEntry("app.js", "src/app.js", "file", 10)] };
  const { container, workspace, state, refresh } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({ tree: args => (args.path === "src" ? nested : TREE) })
  });
  await click(findButton(container, "src/"));
  const before = calls(workspace, "tree").length;

  // Exactly what the chat page does when a native write finishes.
  state.touchWorkspace("ws-1");
  await refresh();

  assert.ok(calls(workspace, "tree").length > before, "the listing must be read again from disk");
  assert.deepEqual(calls(workspace, "tree").at(-1).path, "src", "the current folder is re-read, not the root");
});

test("a file already open in the preview is re-read when it changes on disk", async () => {
  let reads = 0;
  const { container, workspace, state, refresh } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => {
        reads += 1;
        return { path: "README.md", content: reads === 1 ? "# Demo\n" : "# Changed by the agent\n", size: 8, truncated: false };
      }
    })
  });
  await click(findButton(container, "README.md"));
  assert.match(container.querySelector(".vr-file-preview__body").textContent, /# Demo/);

  state.touchWorkspace("ws-1");
  await refresh();

  assert.deepEqual(calls(workspace, "readText").map(call => call.path), ["README.md", "README.md"]);
  assert.match(container.querySelector(".vr-file-preview__body").textContent, /Changed by the agent/);
});

test("a background reload never overwrites text the user has not saved", async () => {
  const { container, workspace, state, refresh } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      readText: () => ({ path: "README.md", content: "# Demo\n", size: 8, truncated: false })
    })
  });
  await click(findButton(container, "README.md"));
  await click(findButton(container, "Edit this file"));
  await fill(container, "textarea.vr-file-editor", "# half written by me");

  state.touchWorkspace("ws-1");
  await refresh();

  assert.equal(calls(workspace, "readText").length, 1, "an unsaved edit must not be replaced by the disk copy");
  assert.equal(container.querySelector("textarea.vr-file-editor").value, "# half written by me");
});

test("a change to a different workspace does not reload this folder", async () => {
  const { workspace, state, refresh } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({ tree: () => TREE })
  });
  const before = calls(workspace, "tree").length;

  state.touchWorkspace("ws-9");
  await refresh();

  assert.equal(calls(workspace, "tree").length, before, "another project's files must not disturb this pane");
});

test("a refused write is reported as a refusal, not as a change", async () => {
  const { container, workspace, state } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({
      tree: () => TREE,
      makeDirectory: () => Promise.reject(new Error("A file named docs already exists here."))
    })
  });
  await click(findButton(container, "New folder in this location"));
  await fillAndSubmit(container, ".vr-pane-inline-form", 'input[aria-label="New folder name"]', "docs");

  assert.match(container.querySelector(".vr-inline-error").textContent, /A file named docs already exists here/);
  assert.equal(calls(workspace, "makeDirectory").length, 1, "the attempt was really made");
  assert.equal(container.textContent.includes("was created on disk"), false, "a failure must not claim a file exists");
  assert.deepEqual(state.touched, [], "nothing changed on disk, so the explorer must not pretend it did");
  assert.ok(container.querySelector(".vr-pane-inline-form"), "the form stays open to be corrected");
});

test("the refresh button re-reads disk without waiting for a change", async () => {
  const { container, workspace } = await setup(FilesPane, {
    tab: "files",
    workspaceBridge: recorder({ tree: () => TREE })
  });
  const before = calls(workspace, "tree").length;
  await click(findButton(container, "Refresh files"));
  assert.equal(calls(workspace, "tree").length, before + 1);
});

test("row operations stay reachable without a mouse", () => {
  const css = readFileSync(path.join(panelDir, "workspacePanel.css"), "utf8");
  assert.match(
    css,
    /\.vr-pane-row:focus-within\s+\.vr-pane-row__actions\s*\{[^}]*opacity:\s*1/,
    "Rename, Move and Delete must appear on keyboard focus, not only on hover"
  );
  for (const selector of [".vr-pane-row__main", ".vr-pane-inline-form", ".vr-pane-confirm", ".vr-file-editor"]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});

/* ----------------------------------------------------------------- review */

const REVIEW = {
  branch: "feature/panel",
  head: "1a2b3c4d5e6f7g8h",
  truncated: false,
  files: [
    { path: "src/a.js", kind: "modified", indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false },
    { path: "src/b.js", kind: "added", indexStatus: "A", worktreeStatus: "A", staged: false, unstaged: true },
    { path: "src/c.js", kind: "deleted", indexStatus: " ", worktreeStatus: "D", staged: false, unstaged: true },
    { path: "src/d.js", kind: "renamed", indexStatus: "R", worktreeStatus: " ", staged: true, unstaged: false }
  ],
  stagedDiff: "diff --git a/src/a.js b/src/a.js\n+added line\n",
  unstagedDiff: "diff --git a/src/b.js b/src/b.js\n-removed line\n",
  diagnostics: ["git: warning: unstable whitespace"]
};

test("the review pane reads real git status once its tab is active", async () => {
  const { container, workspace } = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({ reviewGit: () => REVIEW })
  });
  assert.deepEqual(workspace.calls, [{ name: "reviewGit", owner: "user-1", id: "ws-1" }]);
  assert.match(container.querySelector(".vr-pane-title").textContent, /feature\/panel/);
  assert.match(container.textContent, /4 changed files/);
  assert.match(container.querySelector(".vr-review-head__sha").textContent, /1a2b3c4d/);
});

test("the review pane names every change kind it is shown", async () => {
  const { container } = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({ reviewGit: () => REVIEW })
  });
  assert.deepEqual(
    [...container.querySelectorAll(".vr-review-file__status")].map(node => node.textContent),
    ["modified", "added", "deleted", "renamed"]
  );
});

test("the review pane renders the real staged and unstaged diffs", async () => {
  const { container } = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({ reviewGit: () => REVIEW })
  });
  assert.deepEqual(
    [...container.querySelectorAll(".vr-review-diff pre")].map(node => node.textContent),
    [REVIEW.stagedDiff, REVIEW.unstagedDiff]
  );
  assert.match(container.querySelector(".vr-review-diagnostics").textContent, /unstable whitespace/);
});

test("the review pane reports a clean tree and refreshes on demand", async () => {
  const { container, workspace } = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({
      reviewGit: () => ({
        branch: "main",
        head: "",
        files: [],
        stagedDiff: "",
        unstagedDiff: "",
        truncated: false,
        diagnostics: []
      })
    })
  });
  assert.match(container.textContent, /Working tree is clean/);
  await click(findButton(container, "Refresh Git status"));
  assert.equal(
    workspace.calls.filter(call => call.name === "reviewGit").length,
    2
  );
});

test("the review pane shows a truncation note and a git failure", async () => {
  const { container } = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({ reviewGit: () => ({ ...REVIEW, stagedDiff: "", truncated: true }) })
  });
  assert.match(container.textContent, /diff was truncated/);
  assert.equal(container.querySelectorAll(".vr-review-diff").length, 1);

  const failing = await setup(ReviewPane, {
    tab: "review",
    workspaceBridge: recorder({ reviewGit: () => Promise.reject(new Error("This folder is not a git repository.")) })
  });
  assert.match(failing.container.querySelector(".vr-inline-error").textContent, /not a git repository/);
});

test("the review pane has no path to staging, committing or resetting", () => {
  const source = readFileSync(path.join(panelDir, "ReviewPane.jsx"), "utf8");
  for (const forbidden of [
    /git\s+(add|commit|push|pull|reset|clean|checkout|restore|stash|merge|rebase)/i,
    /\bstage\b/i,
    /\bcommit\b/i,
    /\bdiscard\b/i,
    /\brevert\b/i
  ]) {
    assert.equal(forbidden.test(source), false, `ReviewPane must not contain ${forbidden}`);
  }
});

/* ---------------------------------------------------------------- browser */

function browserBridge(overrides = {}) {
  return recorder({
    create: () => ({ ok: true }),
    bounds: () => ({ ok: true }),
    navigate: () => ({ ok: true }),
    status: () => ({
      title: "Example Domain",
      url: "https://example.com/",
      loading: false,
      canGoBack: true,
      canGoForward: false
    }),
    inspect: () => ({
      headings: [{ level: 1, text: "Example Domain" }],
      links: [{ text: "More information…", href: "https://www.iana.org/domains/example" }],
      title: "Example Domain"
    }),
    screenshot: () => "data:image/png;base64,AAAA",
    click: () => ({ ok: true }),
    type: () => ({ ok: true }),
    scroll: () => ({ ok: true }),
    close: () => ({ ok: true }),
    ...overrides
  });
}

async function browserSetup(bridge) {
  const view = await setup(BrowserPane, {
    tab: "browser",
    browserBridge: bridge || browserBridge()
  });
  view.openPage = () =>
    fillAndSubmit(view.container, ".vr-browser-bar", 'input[aria-label="Web address"]', "https://example.com");
  return view;
}

test("the browser pane is Windows-only", async () => {
  globalThis.__tauriRuntime = false;
  const { container, browser, openPage } = await browserSetup();
  assert.match(container.textContent, /available in the Windows app/);
  assert.deepEqual(names(browser), []);
  globalThis.__tauriRuntime = true;
});

test("the browser pane creates the webview inside the stage rect", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();

  const create = browser.calls.find(call => call.name === "create");
  assert.equal(create.tabId, "panel-main");
  assert.equal(create.url, "https://example.com");
  assert.deepEqual(create.bounds, { x: 140, y: 96, width: 300, height: 420, visible: true });
  assert.ok(names(browser).includes("status"));
  assert.match(container.querySelector(".vr-browser-status").textContent, /Example Domain/);
});

test("a second address navigates the same webview instead of creating another", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();
  await fillAndSubmit(container, ".vr-browser-bar", 'input[aria-label="Web address"]', "https://vups.test/");

  assert.equal(
    browser.calls.filter(call => call.name === "create").length,
    1
  );
  assert.deepEqual(browser.calls.find(call => call.name === "navigate").url, "https://vups.test/");
});

test("back, forward and reload drive the real webview", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();
  browser.calls.length = 0;

  await click(findButton(container, "Back"));
  await click(findButton(container, "Forward"));
  await click(findButton(container, "Reload"));
  assert.deepEqual(names(browser), ["back", "forward", "reload"]);
  assert.deepEqual(
    browser.calls.map(call => call.tabId),
    ["panel-main", "panel-main", "panel-main"]
  );
});

test("reading a page shows its headings and lets a link be followed", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();
  await click(findButton(container, "Read page"));

  assert.ok(names(browser).includes("inspect"));
  assert.match(container.querySelector(".vr-inspect-headings").textContent, /Example Domain/);
  browser.calls.length = 0;

  await click(findButton(container, "More information"));
  assert.deepEqual(browser.calls.find(call => call.name === "navigate").url, "https://www.iana.org/domains/example");
});

test("a screenshot is captured from the stage rect and shown", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();
  await click(findButton(container, "Screenshot"));

  assert.deepEqual(browser.calls.find(call => call.name === "screenshot"), {
    name: "screenshot",
    tabId: "panel-main",
    x: 140,
    y: 96,
    width: 300,
    height: 420
  });
  assert.equal(container.querySelector(".vr-browser-shot").getAttribute("src"), "data:image/png;base64,AAAA");
});

test("click, type and scroll are sent to the inspected page", async () => {
  const { container, browser, openPage } = await browserSetup();
  await openPage();
  await click(findButton(container, "Read page"));
  await fill(container, 'input[aria-label="Element selector"]', "#search");
  await fill(container, 'input[aria-label="Text to enter"]', "vups");
  browser.calls.length = 0;

  await click(findButton(container, "Click"));
  await click(findButton(container, "Scroll"));
  await click(findButton(container, "Type"));

  // Every successful action is followed by a real status read-back.
  const actions = browser.calls.filter(call => call.name !== "status");
  assert.deepEqual(actions, [
    { name: "click", tabId: "panel-main", selector: "#search" },
    { name: "scroll", tabId: "panel-main", selector: "#search", deltaY: 300 },
    { name: "type", tabId: "panel-main", selector: "#search", text: "vups", submit: false }
  ]);
  assert.equal(
    browser.calls.filter(call => call.name === "status").length,
    3
  );
});

test("the webview hides when another tab is shown and reappears on return", async () => {
  const { browser, selectTab, openPage } = await browserSetup();
  await openPage();
  browser.calls.length = 0;

  await selectTab("files");
  assert.deepEqual(browser.calls.find(call => call.name === "bounds").bounds, {
    x: 140,
    y: 96,
    width: 300,
    height: 420,
    visible: false
  });

  browser.calls.length = 0;
  await selectTab("browser");
  assert.deepEqual(browser.calls.find(call => call.name === "bounds").bounds.visible, true);
});

test("unmounting the browser pane closes its native tab", async () => {
  const { browser, openPage } = await browserSetup();
  await openPage();
  browser.calls.length = 0;

  await React.act(async () => {
    await mounted.at(-1).root.unmount();
  });
  mounted.pop();
  assert.deepEqual(browser.calls.find(call => call.name === "close"), { name: "close", tabId: "panel-main" });
});

test("native refusals are shown where the page would be", async () => {
  const { container, browser } = await browserSetup(
    browserBridge({
      create: () => Promise.reject(new Error("Only http and https addresses can be opened."))
    })
  );
  await fillAndSubmit(container, ".vr-browser-bar", 'input[aria-label="Web address"]', "file:///C:/secrets");

  assert.match(container.querySelector(".vr-inline-error").textContent, /Only http and https addresses/);
  assert.equal(
    browser.calls.some(call => call.name === "bounds" && call.bounds.visible),
    false,
    "a refused page must not be shown"
  );
});
