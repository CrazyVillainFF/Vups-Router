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
  return {
    supported: true,
    owner: "user-1",
    activeWorkspace: { id: "ws-1", title: "demo", path: "C:\\project\\demo" },
    addWorkspace: () => Promise.resolve(),
    ...overrides
  };
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
    selectTab: id => clickTab(id)
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
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
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
  assert.equal(rows[2].disabled, true, "an unreadable file cannot be opened");
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
