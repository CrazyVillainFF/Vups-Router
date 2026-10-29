import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const outDir = path.join(root, "test", ".compiled-plugins");

// The plugin screens are JSX with relative ESM imports, so each screen and the
// components it pulls in are compiled with Vite's esbuild pipeline into one
// directory where bare `react` still finds the project's node_modules. A
// relative specifier is rewritten to its sibling in that directory when it was
// compiled, and to the real source file when it is plain JavaScript.
const COMPILED = ["plugins/PluginDetailView.jsx", "plugins/PluginActionDialog.jsx", "components/ExternalLink.jsx"];

function compiledName(relative) {
  return path.basename(relative).replace(/\.(jsx|js)$/, ".mjs");
}

async function compileAll() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const relative of COMPILED) {
    const from = path.join(srcDir, relative);
    const to = path.join(outDir, compiledName(relative));
    const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
      loader: "jsx",
      jsx: "automatic"
    });
    const rewritten = code.replace(/from "(\.[^"]*)"/g, (match, specifier) => {
      const target = path.resolve(path.dirname(from), specifier);
      const targetRelative = path.relative(srcDir, target).split(path.sep).join("/");
      if (COMPILED.includes(targetRelative)) return `from "./${compiledName(targetRelative)}"`;
      return `from "${path.relative(outDir, target).split(path.sep).join("/")}"`;
    });
    writeFileSync(to, rewritten);
  }
}

let dom;
let React;
let ReactDOMClient;
let DetailView;
let ActionDialog;
const mounted = [];

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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
  await compileAll();
  DetailView = (await import(pathToFileURL(path.join(outDir, "PluginDetailView.mjs")).href)).default;
  ActionDialog = (await import(pathToFileURL(path.join(outDir, "PluginActionDialog.mjs")).href)).default;
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      entry.root.unmount();
      entry.container.remove();
    }
  });
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => { rootHandle.render(element); });
  return container;
}

function buttonByText(container, text) {
  return [...container.querySelectorAll("button")].find(node => node.textContent.trim() === text) || null;
}

function setValue(input, value) {
  const prototype = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

function labelInput(container, labelText) {
  const label = [...container.querySelectorAll("label")].find(node =>
    node.querySelector("span")?.textContent.trim().startsWith(labelText)
  );
  return label?.querySelector("input, textarea, select") || null;
}

const githubTools = [
  {
    name: "search_repositories",
    description: "Search GitHub repositories.",
    sensitive: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Repository search query." },
        limit: { type: "integer", description: "Number of results (1-10).", minimum: 1, maximum: 10 }
      },
      required: ["query"]
    }
  },
  {
    name: "repository",
    description: "Read metadata for one GitHub repository.",
    sensitive: false,
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"]
    }
  },
  {
    name: "list_issues",
    description: "List issues in a GitHub repository. Pull requests are excluded.",
    sensitive: false,
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"]
    }
  },
  {
    name: "create_issue",
    description: "Create an issue in a GitHub repository. Requires an access token and explicit confirmation.",
    sensitive: true,
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" }
      },
      required: ["owner", "repo", "title"]
    }
  }
];

const github = {
  id: "github",
  name: "GitHub",
  category: "developer",
  description: "Search repositories, inspect issues, and create issues with an optional token.",
  auth: {
    type: "optional_api_key",
    label: "Optional access token",
    fields: [{ key: "token", label: "Access token (optional)", type: "password", required: false, secret: true }]
  },
  website: "https://github.com",
  permissions: ["Read public repositories and issues", "Create issues only when you explicitly confirm"],
  tools: githubTools,
  installed: true,
  connection: "connected",
  lastTestAt: "2026-10-29T10:00:00.000Z",
  lastTestStatus: "connected",
  lastTestMessage: "GitHub token accepted.",
  lastError: "",
  credentialsConfigured: { token: true }
};

function renderDetail(plugin, overrides = {}) {
  const calls = { test: 0, connect: 0, disconnect: 0, run: [] };
  const container = render(
    React.createElement(DetailView, {
      plugin,
      testing: false,
      runDebug: async () => ({ result: {} }),
      onTest: () => { calls.test += 1; },
      onConnect: () => { calls.connect += 1; },
      onDisconnect: () => { calls.disconnect += 1; },
      onRunAction: name => calls.run.push(name),
      ...overrides
    })
  );
  return { container, calls };
}

test("the default detail screen never shows raw tool names; the advanced section does", () => {
  const { container } = renderDetail(github);
  const visible = [".vr-plugin-status-panel", ".vr-plugin-setup", ".vr-plugin-capabilities"]
    .map(selector => container.querySelector(selector)?.textContent || "")
    .join(" ");

  // `repository` and `list_issues` read as ordinary words in friendly copy, so
  // the identifiers that must not appear are checked as identifiers: no code
  // element and no action label equal to a tool name.
  for (const identifier of ["search_repositories", "create_issue", "list_issues"]) {
    assert.ok(!visible.includes(identifier), `${identifier} must stay out of the default view`);
  }
  assert.equal(container.querySelectorAll(".vr-plugin-capabilities code").length, 0);
  const labels = [...container.querySelectorAll(".vr-plugin-action-label")].map(node => node.textContent);
  for (const tool of githubTools) {
    assert.ok(!labels.includes(tool.name), `${tool.name} is not used as a label`);
  }

  const advanced = container.querySelector(".vr-plugin-advanced");
  assert.ok(advanced, "advanced details are available");
  assert.equal(advanced.hasAttribute("open"), false, "advanced details start collapsed");
  for (const tool of githubTools) {
    assert.ok(advanced.textContent.includes(tool.name), `${tool.name} is kept for debugging`);
  }
});

test("the status sentence and last successful check come from the real health check", () => {
  const { container } = renderDetail(github);
  const panel = container.querySelector(".vr-plugin-status-panel");
  assert.match(panel.textContent, /Connected/);
  assert.match(panel.textContent, /answered its most recent connection check/);
  assert.match(panel.textContent, /Last successful check/);
});

test("a failed last check reads as a problem and carries a redacted message", () => {
  const { container } = renderDetail({
    ...github,
    connection: "connected",
    lastTestStatus: "failed",
    lastTestMessage: "Bad credentials: ghp_abcdefghijklmnopqrstuvwxyz0123456789"
  });
  const panel = container.querySelector(".vr-plugin-status-panel");
  assert.match(panel.textContent, /Connection problem/);
  assert.doesNotMatch(panel.textContent, /(^|\s)Connected/);
  assert.ok(!panel.textContent.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(panel.textContent, /\[redacted\]/);
});

test("read access and write access are separate, and only writes ask first", () => {
  const { container } = renderDetail(github);
  const groups = [...container.querySelectorAll(".vr-plugin-capability-group")];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.getAttribute("data-kind")), ["read", "change"]);

  const readLabels = [...groups[0].querySelectorAll(".vr-plugin-action-label")].map(node => node.textContent);
  assert.deepEqual(readLabels, ["Find repositories", "View repository details", "View issues"]);
  assert.doesNotMatch(groups[0].textContent, /Asks you first/);

  const writeGroup = groups[1];
  assert.equal(writeGroup.querySelectorAll(".vr-plugin-action").length, 1);
  assert.match(writeGroup.textContent, /Create an issue/);
  assert.match(writeGroup.textContent, /Asks you first/);
  assert.match(writeGroup.textContent, /Needs a token/);
});

test("each action explains what it touches and whether it changes anything", () => {
  const { container } = renderDetail(github);
  const create = [...container.querySelectorAll(".vr-plugin-action")].find(node => node.dataset.tool === "create_issue");
  assert.ok(create);
  const body = create.querySelector(".vr-plugin-action-body");
  assert.match(body.textContent, /Changes /);
  assert.match(body.textContent, /Yes — only after you approve it\./);

  const search = [...container.querySelectorAll(".vr-plugin-action")].find(node => node.dataset.tool === "search_repositories");
  assert.match(search.querySelector(".vr-plugin-action-body").textContent, /No\. It only reads\./);
});

test("test connection, connect and disconnect buttons call their handlers", () => {
  const { container, calls } = renderDetail(github);
  const test = buttonByText(container, "Test connection");
  const connect = buttonByText(container, "Update credentials");
  const disconnect = buttonByText(container, "Disconnect");
  assert.ok(test && connect && disconnect);

  React.act(() => { test.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  React.act(() => { connect.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  React.act(() => { disconnect.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(calls.test, 1);
  assert.equal(calls.connect, 1);
  assert.equal(calls.disconnect, 1);
});

test("a test in flight disables the button and says what is happening", () => {
  const { container } = renderDetail(github, { testing: true });
  const test = buttonByText(container, "Testing…");
  assert.ok(test, "the button reports the running state");
  assert.equal(test.disabled, true);
});

test("an unconnected plugin offers Connect, no Test, and no Try it", () => {
  const { container } = renderDetail({
    ...github,
    installed: false,
    availability: "available",
    connection: "disconnected"
  });
  assert.ok(buttonByText(container, "Connect"));
  assert.equal(buttonByText(container, "Test connection"), null);
  assert.equal(container.querySelector(".vr-plugin-action-body button"), null);
  assert.match(container.textContent, /Connect this plugin to use the action/);
});

test("an unfinished adapter offers no connect action and no permissions", () => {
  const { container } = renderDetail(
    {
      ...github,
      tools: [],
      installed: false,
      availability: "in_development",
      connection: "disconnected"
    },
    { runDebug: async () => ({ result: {} }) }
  );
  assert.equal(buttonByText(container, "Connect"), null);
  assert.equal(buttonByText(container, "Test connection"), null);
  assert.match(container.textContent, /No working adapter in this build/);
  assert.match(container.textContent, /exposes no actions/);
});

test("a no-account plugin is turned on, not connected, and claims no write access", () => {
  const npmPlugin = {
    ...github,
    id: "npm",
    name: "npm Registry",
    auth: { type: "none", label: "No credentials required", fields: [] },
    tools: [
      { name: "search", description: "Search the npm registry for packages.", sensitive: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "package", description: "Read metadata for an npm package.", sensitive: false, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
    ],
    availability: "available",
    installed: false,
    connection: "disconnected"
  };
  const { container } = renderDetail(npmPlugin);
  assert.ok(buttonByText(container, "Turn on"));
  assert.equal(buttonByText(container, "Connect"), null);
  assert.match(container.textContent, /No account needed/);
  assert.match(container.textContent, /This integration reads public data/);
  assert.doesNotMatch(container.textContent, /Write access/);
  assert.match(container.textContent, /Turn on this plugin to use the action/);
  assert.match(container.textContent, /Search the npm registry for packages/);
  assert.doesNotMatch(container.textContent, /Find repositories|Create an issue/);
});

test("GitHub setup says a token is optional and names the narrowest access", () => {
  const { container } = renderDetail({ ...github, installed: false });
  const setup = container.querySelector(".vr-plugin-setup").textContent;
  assert.match(setup, /A token is optional/);
  assert.match(setup, /Works without signing in/);
  assert.match(setup, /Find repositories/);
  assert.match(setup, /Needs your access token/);
  assert.match(setup, /Issues: read and write/);
  assert.match(container.querySelector(".vr-plugin-setup a").getAttribute("href"), /github\.com\/settings\/tokens/);
});

function renderDialog(tool, onRun, plugin = github) {
  const container = render(
    React.createElement(ActionDialog, { plugin, tool, onClose: () => {}, onRun })
  );
  return container;
}

test("a read action runs from the form and shows the result without a review step", async () => {
  const calls = [];
  const onRun = async (tool, args, confirm) => {
    calls.push({ name: tool.name, args, confirm });
    return { result: { results: [{ fullName: "vitejs/vite" }] } };
  };
  const container = renderDialog(githubTools[0], onRun);
  assert.match(container.textContent, /READ-ONLY ACTION/);
  assert.equal(buttonByText(container, "Review"), null);

  setValue(labelInput(container, "Search words"), "vite");
  await React.act(async () => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { query: "vite" });
  assert.equal(calls[0].confirm, false);
  assert.match(container.textContent, /Nothing was changed on your account/);
  assert.match(container.textContent, /vitejs\/vite/);
});

test("a write action waits for review, sends nothing, then sends only after approval", async () => {
  const calls = [];
  const onRun = async (tool, args, confirm) => {
    calls.push({ name: tool.name, args, confirm });
    return { result: { number: 7, url: "https://github.com/acme/widgets/issues/7" } };
  };
  const container = renderDialog(githubTools[3], onRun);
  assert.match(container.textContent, /ACTION THAT CHANGES DATA/);

  setValue(labelInput(container, "Repository owner"), "acme");
  setValue(labelInput(container, "Repository name"), "widgets");
  setValue(labelInput(container, "Issue title"), "Printer jams");
  React.act(() => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  assert.equal(calls.length, 0, "review must not send the request");
  assert.match(container.textContent, /Nothing has been sent yet/);
  assert.match(container.textContent, /Printer jams/);

  await React.act(async () => {
    buttonByText(container, "Create an issue").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].confirm, true);
  assert.deepEqual(calls[0].args, { owner: "acme", repo: "widgets", title: "Printer jams" });
  assert.match(container.textContent, /Create an issue finished/);
});

test("cancelling at the review step never sends the request", () => {
  const calls = [];
  const container = renderDialog(githubTools[3], async (...args) => { calls.push(args); return { result: {} }; });
  setValue(labelInput(container, "Repository owner"), "acme");
  setValue(labelInput(container, "Repository name"), "widgets");
  setValue(labelInput(container, "Issue title"), "Printer jams");
  React.act(() => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  React.act(() => { buttonByText(container, "Cancel").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(calls.length, 0);
});

test("a refused write keeps the screen in review and shows a redacted error", async () => {
  const onRun = async () => {
    throw new Error("GitHub rejected the token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  };
  const container = renderDialog(githubTools[3], onRun);
  setValue(labelInput(container, "Repository owner"), "acme");
  setValue(labelInput(container, "Repository name"), "widgets");
  setValue(labelInput(container, "Issue title"), "Printer jams");
  React.act(() => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await React.act(async () => {
    buttonByText(container, "Create an issue").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert, "the failure is visible on the confirmation step");
  assert.match(alert.textContent, /GitHub rejected the token/);
  assert.ok(!alert.textContent.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(container.textContent, /Nothing has been sent yet/);
  assert.doesNotMatch(container.textContent, /finished/);
  assert.ok(buttonByText(container, "Create an issue"), "the approve button is still offered");
});

test("a failing read action reports the problem and shows no result", async () => {
  const onRun = async () => {
    throw new Error("Provider is unavailable.");
  };
  const container = renderDialog(githubTools[0], onRun);
  setValue(labelInput(container, "Search words"), "vite");
  await React.act(async () => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  assert.match(container.querySelector('[role="alert"]').textContent, /Provider is unavailable\./);
  assert.equal(container.querySelector(".vr-plugin-result"), null);
});

test("the missing-field message names the field and sends nothing", () => {
  const calls = [];
  const container = renderDialog(githubTools[3], async (...args) => { calls.push(args); return { result: {} }; });
  React.act(() => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(calls.length, 0);
  assert.match(container.querySelector('[role="alert"]').textContent, /Repository owner is needed\./);
});

test("while a request is in flight the primary button is disabled", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const container = renderDialog(githubTools[0], () => pending);
  setValue(labelInput(container, "Search words"), "vite");
  React.act(() => {
    container.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });

  const running = buttonByText(container, "Running…");
  assert.ok(running, "the button reports the running state");
  assert.equal(running.disabled, true);

  await React.act(async () => {
    release({ result: {} });
    await pending;
  });
});

test("the advanced facts never print a stored secret value", () => {
  const { container } = renderDetail({
    ...github,
    credentialsConfigured: { token: true },
    lastTestMessage: "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 accepted"
  });
  const advanced = container.querySelector(".vr-plugin-advanced").textContent;
  assert.match(advanced, /1 saved \(encrypted, never returned\)/);
  assert.ok(!advanced.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});
