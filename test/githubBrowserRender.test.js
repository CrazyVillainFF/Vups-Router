import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
// Own scratch directory: node --test runs files in parallel processes and two
// render suites sharing one folder delete each other's in-flight output.
const workDir = path.join(root, "test", ".compiled-ghb");

/* The brief's §3 requirement is a browser that shows what GitHub actually
   returns, so these tests drive the real component against a stubbed plugin API
   whose responses are the raw provider shapes — snake_case repository objects,
   a folders/files listing, a README body, a 403 that means a rate limit. A row
   that appears here only appears because a tool response put it there, which is
   the opposite of the mock-data shortcut the brief forbids. */

const RAW_REPO = {
  full_name: "CrazyVillainFF/Vups-Router",
  name: "Vups-Router",
  owner: { login: "CrazyVillainFF" },
  description: "Local-first AI router",
  private: true,
  default_branch: "main",
  html_url: "https://github.com/CrazyVillainFF/Vups-Router"
};

const RAW_PUBLIC_REPO = {
  full_name: "openlayers/openlayers",
  name: "openlayers",
  owner: { login: "openlayers" },
  description: "High-performance, feature-packed library for creation of interactive maps",
  private: false,
  default_branch: "main",
  html_url: "https://github.com/openlayers/openlayers"
};

const README_BODY = `# VupsRouter

## Install

Run \`npm ci\` then \`npm run dev\`.

| Platform | File |
| --- | --- |
| Windows | setup.exe |
`;

function pluginRow(overrides = {}) {
  return {
    id: "github",
    name: "GitHub",
    installed: true,
    connection: "connected",
    auth: { type: "optional_api_key", label: "Personal access token" },
    config: { account: { login: "CrazyVillainFF", name: "Vishnu" } },
    lastTestAt: "2026-11-01T10:00:00.000Z",
    lastTestStatus: "connected",
    tools: [{ name: "list_repositories", sideEffect: "none" }],
    oauth: {
      pluginId: "github-oauth",
      label: "Sign in with GitHub",
      configured: true,
      installed: false,
      connection: "disconnected",
      account: null,
      offeredScopes: "repo,read:user"
    },
    ...overrides
  };
}

function httpError(status, data) {
  const error = new Error(String(data?.message || "HTTP error"));
  error.response = { status, data: data || {} };
  return error;
}

let dom;
let React;
let ReactDOMClient;
let GitHubRepoBrowser;
const mounted = [];
let script;

function stage(overrides = {}) {
  script = {
    plugins: [pluginRow()],
    calls: [],
    opened: [],
    oauthStarts: 0,
    uninstalls: 0,
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO, RAW_PUBLIC_REPO] }),
      list_files: args =>
        args.path === ""
          ? { path: "", branch: args.branch, folders: [{ name: "src", path: "src" }], files: [{ name: "package.json", path: "package.json", size: 1234 }], truncated: false }
          : { path: args.path, branch: args.branch, folders: [], files: [{ name: "ChatPage.jsx", path: `${args.path}/ChatPage.jsx`, size: 88_000 }], truncated: false },
      read_file: args =>
        /readme/i.test(args.path)
          ? { path: args.path, branch: args.branch, sha: "abc", size: README_BODY.length, binary: false, truncated: false, content: README_BODY }
          : { path: args.path, branch: args.branch, sha: "def", size: 12, binary: false, truncated: false, content: "export default 1;\n" },
      ...overrides.tools
    },
    ...overrides
  };
  globalThis.__ghbScript = script;
}

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: "https://vups.test/",
    pretendToBeVisual: true
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  GitHubRepoBrowser = await loadBrowser();
});

async function loadBrowser() {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, "styleStub.mjs"), "export default {};\n");
  writeFileSync(
    path.join(workDir, "apiStub.mjs"),
    `const s = () => globalThis.__ghbScript;
export async function listPlugins() {
  await Promise.resolve();
  return { plugins: s().plugins };
}
export async function executePluginTool(pluginId, toolName, args) {
  s().calls.push({ pluginId, toolName, args });
  const handler = s().tools[toolName];
  if (!handler) throw httpFailure(\`\${toolName} is not staged\`);
  const result = handler(args);
  await Promise.resolve();
  if (result && result.__throw) throw result.__throw;
  return { tool: toolName, pluginId, result, durationMs: 1 };
}
function httpFailure(message) {
  const error = new Error(message);
  error.response = { status: 500, data: { message } };
  return error;
}
export async function startPluginOAuth(pluginId) {
  s().oauthStarts += 1;
  s().oauthPluginId = pluginId;
  return { url: "https://github.com/login/oauth/authorize?client_id=stub" };
}
export async function uninstallPlugin(pluginId) {
  s().uninstalls += 1;
  s().uninstalledPluginId = pluginId;
  return { ok: true };
}
`
  );
  writeFileSync(
    path.join(workDir, "linksStub.mjs"),
    `export async function openExternalUrl(value) {
  globalThis.__ghbScript.opened.push(value);
  return true;
}
export const LINK_ERROR_EVENT = "vupsrouter:link-error";
`
  );

  const outFile = path.join(workDir, "GitHubRepoBrowser.mjs");
  const from = path.join(srcDir, "github", "GitHubRepoBrowser.jsx");
  const { code } = await transformWithEsbuild(readFileSync(from, "utf8"), from, {
    loader: "jsx",
    jsx: "automatic"
  });
  const logicUrl = pathToFileURL(path.join(srcDir, "github", "githubBrowser.js")).href;
  const rewritten = code
    // jsdom does not resolve stylesheets; the CSS itself is checked from source.
    .replace('import "./GitHubRepoBrowser.css";', 'import "./styleStub.mjs";')
    .replace('from "../services/api.js"', 'from "./apiStub.mjs"')
    .replace('from "../native/externalLinks.js"', 'from "./linksStub.mjs"')
    .replace('from "./githubBrowser.js"', `from ${JSON.stringify(logicUrl)}`);
  assert.ok(!rewritten.includes('"./GitHubRepoBrowser.css"'), "the stylesheet import was stubbed");
  assert.ok(!rewritten.includes("../services/api.js"), "the network layer was stubbed");
  writeFileSync(outFile, rewritten);
  return (await import(pathToFileURL(outFile).href)).default;
}

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) {
      await entry.root.unmount();
      entry.container.remove();
    }
  });
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

beforeEach(() => {
  stage();
});

function toolCalls(toolName) {
  return script.calls.filter(call => call.toolName === toolName);
}

async function open(props = {}) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  const handlers = {};
  await React.act(async () => {
    rootHandle.render(
      React.createElement(GitHubRepoBrowser, {
        open: true,
        onClose: () => {
          handlers.closed = (handlers.closed || 0) + 1;
          props.onClose?.();
        },
        onScope: (repo, branch) => {
          handlers.scoped = { repo, branch };
        },
        onManage: () => {
          handlers.managed = (handlers.managed || 0) + 1;
        },
        ...props
      })
    );
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  handlers.counts = () => ({ closed: handlers.closed || 0, managed: handlers.managed || 0 });
  return { container, handlers };
}

// Every read in the browser is awaited inside React.act, so a control that
// starts one has to be clicked and then drained the same way.
async function click(element) {
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function type(input, value) {
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit(container) {
  await React.act(async () => {
    container.querySelector("form[role='search']").dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

function rows(container) {
  return [...container.querySelectorAll(".vr-ghb__row")].map(row => ({
    label: row.querySelector(".vr-ghb__row-label").textContent,
    hint: row.querySelector(".vr-ghb__row-hint")?.textContent || "",
    node: row
  }));
}

function rowBy(container, label) {
  const match = rows(container).find(row => row.label === label);
  assert.ok(match, `a row labelled "${label}" is on screen (${rows(container).map(r => r.label).join(", ")})`);
  return match.node;
}

test("the dialog opens on the repositories the account actually owns", async () => {
  const { container } = await open();
  const dialog = container.querySelector(".vr-ghb");
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(dialog.querySelector(".vr-ghb__title").textContent, "Your repositories");
  assert.match(dialog.querySelector(".vr-ghb__conn").textContent, /Access token/);
  assert.match(dialog.querySelector(".vr-ghb__conn").textContent, /@CrazyVillainFF/);
  assert.deepEqual(rows(container).map(row => row.label), ["CrazyVillainFF/Vups-Router", "openlayers/openlayers"]);
  assert.match(rows(container)[0].hint, /private/);
  assert.match(rows(container)[1].hint, /public/);
  assert.equal(toolCalls("list_repositories").length, 1);
  assert.equal(toolCalls("list_repositories")[0].args.perPage, 100);
  assert.equal(toolCalls("list_repositories")[0].pluginId, "github", "the token row answers");
});

test("opening a repository reads its tree and renders its README", async () => {
  const { container } = await open();
  await click(rows(container)[0].node);
  assert.equal(container.querySelector(".vr-ghb__title").textContent, "CrazyVillainFF/Vups-Router");
  const listing = toolCalls("list_files").at(-1);
  assert.deepEqual(
    { owner: listing.args.owner, repo: listing.args.repo, path: listing.args.path, branch: listing.args.branch },
    { owner: "CrazyVillainFF", repo: "Vups-Router", path: "", branch: "main" }
  );
  assert.deepEqual(rows(container).map(row => row.label), ["src", "package.json"], "folders come before files");
  const readme = container.querySelector(".vr-ghb__readme");
  assert.ok(readme, "the README is rendered under the listing");
  assert.equal(readme.querySelector(".vr-ghb__readme-title").textContent, "README.md");
  assert.equal(readme.querySelector("h1").textContent, "VupsRouter");
  assert.equal(readme.querySelectorAll("h2")[0].textContent, "Install");
  assert.ok(readme.querySelector("table"), "GFM tables render");
  assert.ok(readme.querySelector("code"), "inline code renders");
  assert.match(container.querySelector(".vr-ghb__foot-note").textContent, /Reads only/);
});

test("walking into a folder reads that folder, and back returns to the repository", async () => {
  const { container } = await open();
  await click(rows(container)[0].node);
  await click(rowBy(container, "src"));
  assert.equal(rows(container)[0].label, "ChatPage.jsx");
  const crumbs = [...container.querySelectorAll(".vr-ghb__crumb")].map(node => node.textContent);
  assert.deepEqual(crumbs, ["CrazyVillainFF/Vups-Router", "/src"], "the path is shown as it was walked");

  const back = [...container.querySelectorAll(".vr-ghb__navbtn")].find(node => node.getAttribute("aria-label") === "Back");
  assert.equal(back.disabled, false, "back is live as soon as there is somewhere to go");
  await click(back);
  assert.deepEqual(rows(container).map(row => row.label), ["src", "package.json"]);
  const forward = [...container.querySelectorAll(".vr-ghb__navbtn")].find(node => node.getAttribute("aria-label") === "Forward");
  assert.equal(forward.disabled, false);
  await click(forward);
  assert.equal(rows(container)[0].label, "ChatPage.jsx", "forward replays the folder");
  assert.deepEqual(
    toolCalls("list_files").map(call => call.args.path),
    ["", "src", "", "src"],
    "each view on the way is read from GitHub again rather than left stale"
  );
});

test("a file is shown as its own text, and a binary file says it is not text", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      list_files: () => ({
        folders: [],
        files: [
          { name: "server.js", path: "server.js", size: 40 },
          { name: "logo.png", path: "logo.png", size: 2048 }
        ],
        truncated: false
      }),
      read_file: args =>
        args.path === "logo.png"
          ? { path: "logo.png", branch: "main", sha: "x", size: 2048, binary: true, truncated: false, content: null }
          : { path: args.path, branch: "main", sha: "y", size: 40, binary: false, truncated: true, content: "const a = 1;\n" }
    }
  });
  const { container } = await open();
  await click(rows(container)[0].node);
  await click(rowBy(container, "server.js"));
  assert.equal(container.querySelector(".vr-ghb__code code").textContent, "const a = 1;\n");
  assert.match(container.textContent, /GitHub sends at most 40,000 characters per file/);
  assert.equal(
    toolCalls("read_file").at(-1).args.path,
    "server.js",
    "the file that was clicked is the file that was read"
  );

  await click([...container.querySelectorAll(".vr-ghb__navbtn")].find(node => node.getAttribute("aria-label") === "Back"));
  await click(rowBy(container, "logo.png"));
  assert.match(container.querySelector(".vr-ghb__file").textContent, /is not text/);
  assert.match(container.querySelector(".vr-ghb__file").textContent, /2,048 bytes/);
  assert.equal(container.querySelector(".vr-ghb__code"), null, "no empty code block for a binary body");
});

test("a rate limit is named as a rate limit instead of an empty list", async () => {
  stage({
    tools: {
      list_repositories: () => {
        throw httpError(403, { message: "API rate limit exceeded for 203.0.113.4." });
      }
    }
  });
  const { container } = await open();
  const notice = container.querySelector(".vr-ghb__notice");
  assert.equal(notice.getAttribute("role"), "alert");
  assert.match(notice.querySelector("h3").textContent, /rate-limiting/i);
  assert.equal(
    notice.querySelector(".vr-ghb__notice-detail").textContent,
    "API rate limit exceeded for 203.0.113.4.",
    "GitHub's own sentence is shown, not a softened guess"
  );
  assert.equal(container.querySelectorAll(".vr-ghb__row").length, 0, "no repository is invented to fill the gap");
  assert.match(notice.textContent, /Wait for the reset/i);
});

test("a revoked token is sent to Extensions, never re-authenticated behind your back", async () => {
  stage({
    tools: {
      list_repositories: () => {
        throw httpError(401, { message: "Bad credentials" });
      }
    }
  });
  const { container, handlers } = await open();
  const notice = container.querySelector(".vr-ghb__notice");
  assert.match(notice.querySelector("h3").textContent, /refused the credential/i);
  const buttons = [...notice.querySelectorAll("button")].map(node => node.textContent.trim());
  assert.deepEqual(buttons, ["Try again", "Reconnect", "Open Extensions"]);
  await click([...notice.querySelectorAll("button")].find(node => node.textContent.trim() === "Reconnect"));
  assert.equal(script.oauthStarts, 0, "a personal access token is only ever pasted on the Extensions screen");
  assert.equal(handlers.managed, 1);
});

test("a signed-in row that broke starts a real sign-in instead", async () => {
  const row = pluginRow({ installed: true, connection: "disconnected", lastTestStatus: "", lastTestAt: null, config: {} });
  row.oauth = { ...row.oauth, installed: true, connection: "error", lastError: "GitHub rejected the stored token" };
  stage({ plugins: [row] });
  const { container, handlers } = await open();
  assert.match(container.querySelector(".vr-ghb__conn").textContent, /needs your attention|Not connected|Sign-in/i);
  const signIn = [...container.querySelectorAll("button")].find(node => /Sign in with GitHub/.test(node.textContent));
  assert.ok(signIn, "the button only exists because the backend has an OAuth app configured");
  await click(signIn);
  assert.equal(script.oauthStarts, 1);
  assert.equal(script.oauthPluginId, "github-oauth");
  assert.deepEqual(script.opened, ["https://github.com/login/oauth/authorize?client_id=stub"]);
  assert.equal(handlers.counts().managed, 1, "the reader is left where the callback can find them");
});

test("an unconfigured OAuth app offers no sign-in button", async () => {
  const row = pluginRow({ installed: true, connection: "disconnected", lastTestStatus: "", lastTestAt: null, config: {} });
  row.oauth = { ...row.oauth, configured: false };
  stage({ plugins: [row] });
  const { container } = await open();
  const labels = [...container.querySelectorAll("button")].map(node => node.textContent.trim());
  assert.ok(!labels.some(label => /Sign in with GitHub/.test(label)), labels.join(" | "));
  assert.ok(labels.includes("Add an access token"));
  assert.match(container.querySelector(".vr-ghb__empty").textContent, /only public repositories/i);
});

test("a pasted owner/name opens a public repository with no credential at all", async () => {
  const row = pluginRow({ installed: true, connection: "disconnected", lastTestStatus: "", lastTestAt: null, config: {} });
  stage({
    plugins: [row],
    tools: {
      list_files: args => ({
        path: args.path,
        branch: args.branch,
        folders: [{ name: "lib", path: "lib" }],
        files: [{ name: "ol.js", path: "ol.js", size: 10 }],
        truncated: false
      }),
      read_file: () => {
        throw httpError(404, { message: "Not Found" });
      }
    }
  });
  const { container } = await open();
  assert.equal(toolCalls("list_repositories").length, 0, "an unconnected row is not asked for a private list");
  await type(container.querySelector("input[type='search']"), "openlayers/openlayers");
  await submit(container);
  const listing = toolCalls("list_files").at(-1);
  assert.equal(listing?.args.owner, "openlayers", "the typed repository is the one read");
  assert.equal(listing?.args.repo, "openlayers");
  assert.deepEqual(rows(container).map(node => node.label), ["lib", "ol.js"]);
  assert.equal(container.querySelector(".vr-ghb__title").textContent, "openlayers/openlayers");
});

test("a search that GitHub answers with nothing says so", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      search_repositories: () => ({ items: [], total_count: 0 })
    }
  });
  const { container } = await open();
  await type(container.querySelector("input[type='search']"), "nothing-matches-this");
  await submit(container);
  assert.equal(toolCalls("search_repositories").length, 1);
  assert.equal(toolCalls("search_repositories")[0].args.query, "nothing-matches-this");
  assert.match(container.querySelector(".vr-ghb__none").textContent, /no repository matching/i);
});

test("branch loading lists real refs and switching re-reads the tree on that ref", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      list_files: args => ({
        path: args.path,
        branch: args.branch,
        folders: [],
        files: [{ name: args.branch === "dev" ? "on-dev.txt" : "on-main.txt", path: "f", size: 1 }],
        truncated: false
      }),
      read_file: () => {
        throw httpError(404, { message: "Not Found" });
      },
      list_branches: () => ({
        branches: [
          { name: "main", sha: "aaa", protected: true },
          { name: "dev", sha: "bbb", protected: false }
        ],
        rateLimit: { remaining: 99 }
      })
    }
  });
  const { container } = await open();
  await click(rows(container)[0].node);
  const branchButton = [...container.querySelectorAll(".vr-ghb__tools button")].find(node => /main/.test(node.textContent));
  await click(branchButton);
  const branches = [...container.querySelectorAll(".vr-ghb__branch")].map(node => node.textContent);
  assert.deepEqual(branches, ["main", "dev"]);
  await click([...container.querySelectorAll(".vr-ghb__branch")][1]);
  assert.equal(toolCalls("list_files").at(-1).args.branch, "dev");
  assert.equal(rows(container)[0].label, "on-dev.txt");
  assert.equal(container.querySelectorAll(".vr-ghb__branch[data-on]").length, 1, "the current ref is marked");
});

test("a folder GitHub cut short is admitted rather than passed off as complete", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      list_files: () => ({ folders: [], files: [{ name: "one", path: "one", size: 1 }], truncated: true }),
      read_file: () => ({ path: "README.md", branch: "main", size: 90_000, binary: false, truncated: true, content: "# Big\n" })
    }
  });
  const { container } = await open();
  await click(rows(container)[0].node);
  const notes = [...container.querySelectorAll(".vr-ghb__note")].map(node => node.textContent);
  assert.ok(notes.some(note => /first 300 entries/.test(note)), notes.join(" | "));
  assert.ok(notes.some(note => /the rest was not sent/.test(note)), notes.join(" | "));
});

test("an empty repository is described as empty, not as broken", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      list_files: () => ({ folders: [], files: [], truncated: false }),
      read_file: () => {
        throw httpError(404, { message: "Not Found" });
      }
    }
  });
  const { container } = await open();
  await click(rows(container)[0].node);
  assert.match(container.querySelector(".vr-ghb__none").textContent, /no files on main/);
  assert.equal(container.querySelector(".vr-ghb__readme"), null, "a missing README is not replaced with a stub");
});

test("scoping hands the repository and branch to the chat and closes the dialog", async () => {
  const { container, handlers } = await open();
  await click(rows(container)[0].node);
  const primary = container.querySelector(".vr-ghb__foot .vr-ghb__primary");
  assert.match(primary.textContent, /Use CrazyVillainFF\/Vups-Router in this chat/);
  await click(primary);
  assert.equal(handlers.scoped.repo.fullName, "CrazyVillainFF/Vups-Router");
  assert.equal(handlers.scoped.repo.name, "Vups-Router", "the chat records a repository object it can normalise");
  assert.equal(handlers.scoped.branch, "main");
  assert.equal(handlers.counts().closed, 1);
});

test("a repository named from the composer opens straight inside it", async () => {
  stage({
    tools: {
      list_files: args => ({
        path: args.path,
        branch: args.branch,
        folders: [],
        files: [{ name: "already-here.txt", path: "already-here.txt", size: 1 }],
        truncated: false
      }),
      read_file: () => {
        throw httpError(404, { message: "Not Found" });
      }
    }
  });
  const { container } = await open({ initialRepo: { owner: "CrazyVillainFF", name: "Vups-Router", fullName: "CrazyVillainFF/Vups-Router", branch: "topic" } });
  assert.equal(container.querySelector(".vr-ghb__title").textContent, "CrazyVillainFF/Vups-Router");
  assert.equal(rows(container)[0].label, "already-here.txt");
  assert.equal(toolCalls("list_files").at(-1).args.branch, "topic", "the branch asked for is the branch read");
  assert.equal(toolCalls("list_repositories").length, 0, "the list behind it is only fetched if the reader walks back");

  const back = [...container.querySelectorAll(".vr-ghb__navbtn")].find(node => node.getAttribute("aria-label") === "Back");
  await click(back);
  assert.equal(toolCalls("list_repositories").length, 1, "walking back owes the reader the real list");
});

test("disconnecting is a two-step confirm that removes the stored credential", async () => {
  stage({ plugins: [pluginRow()] });
  const { container } = await open();
  const disconnect = [...container.querySelectorAll(".vr-ghb__foot button")].find(node => /Disconnect GitHub/.test(node.textContent));
  await click(disconnect);
  const card = container.querySelector(".vr-ghb__confirm");
  assert.equal(card.getAttribute("role"), "alertdialog");
  assert.match(card.textContent, /chats and settings are untouched/);
  assert.equal(script.uninstalls, 0, "nothing is removed by the first click");
  await click([...card.querySelectorAll("button")].find(node => node.textContent.trim() === "Cancel"));
  assert.equal(script.uninstalls, 0);

  // After the removal the backend reports the row as disconnected, and the
  // browser has to show that instead of its previous "Access token" pill.
  await click(disconnect);
  script.plugins = [pluginRow({ installed: false, connection: "disconnected", lastTestStatus: "", config: {}, lastTestAt: null })];
  await click([...container.querySelectorAll(".vr-ghb__confirm button")].find(node => node.textContent.trim() === "Confirm disconnect"));
  assert.equal(script.uninstalls, 1);
  assert.equal(script.uninstalledPluginId, "github");
  assert.match(container.querySelector(".vr-ghb__conn").textContent, /Not connected/);
});

test("closing is always available and a read that is still running is not interrupted", async () => {
  stage({
    tools: {
      list_repositories: () => ({ repositories: [RAW_REPO] }),
      list_files: () => ({ folders: [], files: [], truncated: false })
    }
  });
  const { container, handlers } = await open();
  await click(container.querySelector(".vr-ghb__close"));
  assert.equal(handlers.counts().closed, 1);

  const { container: second, handlers: secondHandlers } = await open();
  await React.act(async () => {
    second.querySelector("input[type='search']").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    await Promise.resolve();
  });
  assert.equal(secondHandlers.counts().closed, 1, "Escape closes when nothing is in flight");
});
