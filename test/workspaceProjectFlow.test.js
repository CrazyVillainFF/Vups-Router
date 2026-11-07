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
const workDir = path.join(root, "test", ".compiled-project-flow");

const requestModule = pathToFileURL(path.join(desktopDir, "workspaceRequest.js")).href;

let dialogDom;
let React;
let ReactDOMClient;
let loadDialog;
const mounted = [];
const workspaceValue = { current: null };

before(async () => {
  dialogDom = new JSDOM('<!doctype html><html><body></body></html>', { url: "https://vups.test/" });
  for (const [key, value] of Object.entries({
    window: dialogDom.window,
    document: dialogDom.window.document,
    navigator: dialogDom.window.navigator,
    HTMLElement: dialogDom.window.HTMLElement,
    Element: dialogDom.window.Element,
    Node: dialogDom.window.Node,
    Event: dialogDom.window.Event,
    MouseEvent: dialogDom.window.MouseEvent,
    KeyboardEvent: dialogDom.window.KeyboardEvent,
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
    path.join(workDir, "stubContext.mjs"),
    "export function useWorkspaces() { return globalThis.__workspaceValue.current; }\n"
  );
  globalThis.__workspaceValue = workspaceValue;
  const sourcePath = path.join(desktopDir, "WorkspaceSetupDialog.jsx");
  const { code } = await transformWithEsbuild(readFileSync(sourcePath, "utf8"), sourcePath, {
    loader: "jsx",
    jsx: "automatic"
  });
  const outFile = path.join(workDir, "WorkspaceSetupDialog.mjs");
  writeFileSync(
    outFile,
    code
      .replace(/from "\.\/WorkspaceContext\.jsx"/g, 'from "./stubContext.mjs"')
      .replace(/from "\.\/workspaceRequest\.js"/g, `from ${JSON.stringify(requestModule)}`)
  );
  loadDialog = async () => (await import(pathToFileURL(outFile).href)).default;
});

after(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

afterEach(async () => {
  await React.act(async () => {
    for (const entry of mounted.splice(0)) await entry.root.unmount();
  });
});

async function render(element) {
  const container = dialogDom.window.document.createElement("div");
  dialogDom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  await React.act(async () => {
    rootHandle.render(element);
  });
  return container;
}

function buttons(container) {
  return [...container.querySelectorAll("button")];
}

function buttonWith(container, label) {
  return buttons(container).find(node =>
    `${node.textContent} ${node.getAttribute("aria-label") || ""}`.includes(label)
  );
}

function click(node) {
  return React.act(async () => {
    node.dispatchEvent(new dialogDom.window.MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dialogDom.window.HTMLInputElement.prototype, "value").set;
  return React.act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dialogDom.window.Event("input", { bubbles: true }));
  });
}

const CREATED = { id: "ws-new", title: "Demo Site", path: "C:\\Projects\\Demo Site" };

function harness(overrides = {}, options = {}) {
  const calls = [];
  // Paths the fake native layer accepts. Anything else fails the way
  // `workspace_add_path` does when the directory is not on disk.
  const existing = Array.isArray(options.existing) ? options.existing : null;
  workspaceValue.current = {
    supported: true,
    busy: "",
    error: "",
    addWorkspace: async () => {
      calls.push("add");
      return CREATED;
    },
    pickProjectLocation: async () => {
      calls.push("parent");
      return "C:\\Projects";
    },
    createProject: async (parent, name) => {
      calls.push(`create:${parent}\\${name}`);
      return CREATED;
    },
    openFolderPath: async target => {
      calls.push(`open:${target}`);
      if (existing && !existing.includes(target)) {
        throw new Error("That folder does not exist on this PC.");
      }
      return { ...CREATED, path: target, title: "existing" };
    },
    ...overrides
  };
  return calls;
}

test("a new project needs a name and a chosen parent before anything is created", async () => {
  const calls = harness();
  const Dialog = await loadDialog();
  const ready = [];
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "Build me a React website",
      suggestedPath: "",
      onClose: () => {},
      onReady: workspace => ready.push(workspace)
    })
  );

  const create = buttonWith(container, "Create project folder");
  assert.ok(create, "the create action exists");
  assert.equal(create.disabled, true, "nothing can be created before a parent folder is chosen");
  // The suggestion comes from the prompt, so the user edits a real name instead
  // of starting from blank.
  const nameInput = container.querySelector('input[aria-label="Project name"]');
  assert.equal(nameInput.value, "React Website");

  await click(buttonWith(container, "Choose location"));
  assert.deepEqual(calls, ["parent"], "the native parent picker is the only thing that ran");

  await click(buttonWith(container, "Create project folder"));
  assert.deepEqual(calls, ["parent", "create:C:\\Projects\\React Website"]);
  assert.deepEqual(ready, [CREATED], "the created folder is handed back to the chat");
});

test("an illegal project name is refused before any native call", async () => {
  const calls = harness();
  const Dialog = await loadDialog();
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "",
      suggestedPath: "",
      onClose: () => {},
      onReady: () => calls.push("ready")
    })
  );
  await click(buttonWith(container, "Choose location"));
  await typeInto(container.querySelector('input[aria-label="Project name"]'), "bad:name?");
  const form = container.querySelector("form");
  await React.act(async () => {
    form.dispatchEvent(new dialogDom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.ok(
    container.querySelector(".vr-inline-error")?.textContent.includes("cannot contain"),
    "the dialog states why the name is refused"
  );
  assert.deepEqual(calls, ["parent"], "no folder is created for a name Windows rejects");
});

test("an existing folder is registered through the native picker, not typed", async () => {
  const calls = harness();
  const Dialog = await loadDialog();
  const ready = [];
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "",
      suggestedPath: "",
      onClose: () => {},
      onReady: workspace => ready.push(workspace)
    })
  );
  await click(buttonWith(container, "Choose an existing folder"));
  assert.deepEqual(calls, ["add"], "the native folder picker is what selects the directory");
  assert.deepEqual(ready, [CREATED]);
});

test("a folder path named in chat is opened exactly as written", async () => {
  const calls = harness({}, { existing: ["C:\\project\\api"] });
  const Dialog = await loadDialog();
  const ready = [];
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "Edit C:\\project\\api and fix the tests",
      suggestedPath: "C:\\project\\api and fix the tests",
      onClose: () => {},
      onReady: workspace => ready.push(workspace)
    })
  );
  assert.match(container.textContent, /Open the folder you named/);
  assert.ok(buttonWith(container, "Open"), "the typed path is offered as its own choice");
  await click(buttonWith(container, "Open"));
  // Every attempt is a prefix of what the user typed, longest first, until the
  // native layer confirms a real directory.
  assert.deepEqual(calls, [
    "open:C:\\project\\api and fix the tests",
    "open:C:\\project\\api and fix the",
    "open:C:\\project\\api and fix",
    "open:C:\\project\\api and",
    "open:C:\\project\\api"
  ]);
  assert.equal(ready[0].path, "C:\\project\\api", "the chat gets the folder that really exists");
});

test("a typed path that exists nowhere is refused, never replaced", async () => {
  const calls = harness({}, { existing: [] });
  const Dialog = await loadDialog();
  const ready = [];
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "work in C:\\nothing\\here",
      suggestedPath: "C:\\nothing\\here",
      onClose: () => {},
      onReady: workspace => ready.push(workspace)
    })
  );
  await click(buttonWith(container, "Open"));
  assert.deepEqual(calls, ["open:C:\\nothing\\here"]);
  assert.deepEqual(ready, [], "no other directory is substituted");
  assert.equal(
    container.querySelector(".vr-inline-error")?.textContent,
    "That folder does not exist on this PC."
  );
});

test("a failed native call is shown, not swallowed", async () => {
  const calls = harness({
    createProject: async () => {
      calls.push("create-failed");
      throw new Error("That folder already exists.");
    }
  });
  const Dialog = await loadDialog();
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "",
      suggestedPath: "",
      onClose: () => {},
      onReady: () => calls.push("ready")
    })
  );
  await click(buttonWith(container, "Choose location"));
  await typeInto(container.querySelector('input[aria-label="Project name"]'), "Demo");
  const form = container.querySelector("form");
  await React.act(async () => {
    form.dispatchEvent(new dialogDom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(calls, ["parent", "create-failed"]);
  assert.equal(container.querySelector(".vr-inline-error")?.textContent, "That folder already exists.");
  assert.ok(!calls.includes("ready"), "a failed creation does not continue the task");
});

test("without the native runtime the dialog says so instead of pretending", async () => {
  harness({ supported: false });
  const Dialog = await loadDialog();
  const container = await render(
    React.createElement(Dialog, {
      open: true,
      prompt: "Build me a React website",
      onClose: () => {},
      onReady: () => assert.fail("nothing is ready without a native folder")
    })
  );
  assert.match(container.textContent, /Project folders are created by the Windows app/);
  assert.equal(buttonWith(container, "Create project folder"), undefined);
});

// â”€â”€ the decision rules that decide whether a message interrupts the user â”€â”€

test("project intents are detected and trivial questions are not", async () => {
  const { looksLikeProjectTask, projectTaskReason } = await import(requestModule);
  for (const text of [
    "Build me a React website",
    "create a landing page with tailwind",
    "fix the login bug in auth.ts",
    "edit this project and add a /health route",
    "npm install and run the tests",
    "Open C:\\project\\api and fix the tests"
  ]) {
    assert.equal(looksLikeProjectTask(text), true, `${text} is a project task`);
  }
  for (const text of [
    "hi",
    "thanks!",
    "what is react",
    "how do I test a rust program?",
    "explain this error",
    "what can you do"
  ]) {
    assert.equal(looksLikeProjectTask(text), false, `${text} is a question, not a task`);
    assert.equal(projectTaskReason(text), "");
  }
  assert.equal(projectTaskReason("Build me a React website"), "task");
  assert.equal(projectTaskReason("please work in C:\\project\\api"), "path");
});

test("a typed Windows path is extracted whole and walked back to what exists", async () => {
  const { extractFolderPath, pathCandidates } = await import(requestModule);
  // Folder names may contain spaces, so the match runs to the end of the sentence
  // and the caller tries the candidates longest-first against the real filesystem.
  assert.equal(extractFolderPath("Edit C:\\project\\api and fix it"), "C:\\project\\api and fix it");
  assert.equal(extractFolderPath("work in C:/project/api, run tests"), "C:/project/api, run tests");
  assert.equal(extractFolderPath("use \\\\server\\share\\code please"), "\\\\server\\share\\code please");
  assert.equal(extractFolderPath("C:\\projects."), "C:\\projects");
  assert.equal(extractFolderPath("the letter C: is fine"), "", "a bare drive label is not a path");
  assert.equal(extractFolderPath("\\\\onlyhost"), "", "a UNC root without a share is not a path");
  assert.deepEqual(pathCandidates("work in C:/project/api, run tests"), [
    "C:/project/api, run tests",
    "C:/project/api, run",
    "C:/project/api"
  ]);
  assert.deepEqual(pathCandidates("Edit C:\\project\\api and fix it"), [
    "C:\\project\\api and fix it",
    "C:\\project\\api and fix",
    "C:\\project\\api and",
    "C:\\project\\api"
  ]);
  assert.deepEqual(pathCandidates("no folder here"), []);
});

test("project names are checked the way Windows checks them", async () => {
  const { validateProjectName, MAX_PROJECT_NAME_CHARS, suggestProjectName } = await import(requestModule);
  assert.equal(validateProjectName("Demo Site"), "");
  assert.equal(validateProjectName("app.v2"), "");
  for (const bad of ["", "   ", "a/b", "a:b", 'a*b', "a?c", "a|d", "e<f", "g>h", "nul", "COM1", ".", "..", "trailing."]) {
    assert.notEqual(validateProjectName(bad), "", `${JSON.stringify(bad)} must be refused`);
  }
  assert.notEqual(validateProjectName("x".repeat(MAX_PROJECT_NAME_CHARS + 1)), "");
  assert.equal(suggestProjectName("Build me a React website for a bakery"), "React Website Bakery");
  assert.equal(suggestProjectName("Open C:\\project\\api"), "api");
  assert.equal(suggestProjectName(""), "", "a manual setup starts with an empty name field");
});

// â”€â”€ the JS â†” Rust contract: command names and arguments must match the native
//    registration exactly, or every call fails at runtime only â”€â”€

test("the bridge calls the real Tauri commands with the arguments Rust expects", async () => {
  const seen = [];
  dialogDom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      seen.push({ command, args });
      if (command === "workspace_pick_container") return "C:\\Projects";
      if (command === "workspace_add_path") return { id: "w1", title: "api", path: args.path };
      return { id: "w2", title: args.name || "folder", path: `${args.parent}\\${args.name || ""}` };
    }
  };
  const bridge = await import(pathToFileURL(path.join(desktopDir, "workspaceBridge.js")).href);
  assert.equal(await bridge.pickContainerFolder(), "C:\\Projects");
  await bridge.createWorkspaceFolder("owner-1", "C:\\Projects", "Demo");
  await bridge.addWorkspacePath("owner-1", "C:\\project\\api");
  await bridge.makeWorkspaceDirectory("owner-1", "w1", "src/lib");
  await bridge.createWorkspaceFile("owner-1", "w1", "src/app.jsx", "export default 1;");
  await bridge.deleteWorkspacePath("owner-1", "w1", "src/app.jsx");
  await bridge.renameWorkspacePath("owner-1", "w1", "a.txt", "b.txt");
  const commands = seen.map(entry => entry.command);
  assert.deepEqual(commands, [
    "workspace_pick_container",
    "workspace_create",
    "workspace_add_path",
    "workspace_make_directory",
    "workspace_create_file",
    "workspace_delete_path",
    "workspace_rename_path"
  ]);
  assert.deepEqual(seen[1].args, { owner: "owner-1", parent: "C:\\Projects", name: "Demo" });
  assert.deepEqual(seen[2].args, { owner: "owner-1", path: "C:\\project\\api", title: null });
  assert.deepEqual(seen[4].args, { owner: "owner-1", id: "w1", path: "src/app.jsx", content: "export default 1;" });
  assert.deepEqual(seen[6].args, { owner: "owner-1", id: "w1", path: "a.txt", newName: "b.txt" });
  delete dialogDom.window.__TAURI_INTERNALS__;
});

test("every native workspace command the bridge calls is registered and permitted", () => {
  const main = readFileSync(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
  const permissions = readFileSync(path.join(root, "src-tauri", "permissions", "workspace.toml"), "utf8");
  const capabilities = ["default", "desktop-local"].map(name =>
    readFileSync(path.join(root, "src-tauri", "capabilities", `${name}.json`), "utf8")
  );
  const bridge = readFileSync(path.join(desktopDir, "workspaceBridge.js"), "utf8");
  const invoked = [...bridge.matchAll(/tauriInvoke\("([a-z_]+)"/g)].map(match => match[1]);
  assert.ok(invoked.length >= 19, `the bridge covers the whole workspace surface (${invoked.length})`);
  for (const command of invoked) {
    assert.ok(main.includes(`${command},`), `${command} is in generate_handler!`);
    assert.ok(permissions.includes(`"${command}"`), `${command} is allowed by the permission set`);
  }
  for (const capability of capabilities) {
    assert.match(capability, /allow-workspace-commands/);
  }
});

// -- the chat wiring: a project task gets its folder from the app-owned
//    Documents root, and the send never stops to ask where to put it --

test("a project task is created in the app's own Projects folder without asking", async () => {
  const seen = [];
  dialogDom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      seen.push({ command, args });
      return { id: "w-auto", title: args.name, path: "C:\\Users\\tester\\Documents\\VupsRouter\\Projects\\" + args.name };
    }
  };
  const bridge = await import(pathToFileURL(path.join(desktopDir, "workspaceBridge.js")).href);
  const workspace = await bridge.createTaskProject("owner-1", "React Site");
  assert.deepEqual(seen.map(entry => entry.command), ["vups_root_project"]);
  assert.deepEqual(seen[0].args, { owner: "owner-1", name: "React Site" });
  assert.equal(workspace.id, "w-auto");
  await assert.rejects(() => bridge.createTaskProject("", "React Site"), /owner/i, "an owner is required");
  delete dialogDom.window.__TAURI_INTERNALS__;
});

test("the send never pauses for a folder decision on Windows", () => {
  const source = readFileSync(path.join(root, "src", "ChatPage.jsx"), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(source, /workspaceSetupReason/, "the pause reason is gone with the pause");
  assert.doesNotMatch(source, /setWorkspaceSetup\(/, "no state can hold a paused message");
  assert.doesNotMatch(source, /prompt=\{workspaceSetup/, "the dialog is never fed the paused task");
  assert.doesNotMatch(
    source,
    /disabled=\{loading \|\| Boolean\(workspaceSetup\)\}/,
    "the composer is never disabled by a folder decision"
  );
  assert.match(
    source,
    /await provisionTaskWorkspace\(text\);\n\s*return true;/,
    "the task's folder is made before the message goes out"
  );
  assert.match(
    source,
    /onSend=\{\(text, meta\) => handleSend\(text, null, meta, provisionedWorkspaceRef\.current\)\}/,
    "the folder created this tick still reaches the request"
  );
  assert.match(
    source,
    /if \(!nativeWorkspaces \|\| nativeShell !== NATIVE_SHELLS\.windows\) return null;/,
    "the website keeps sending with no folder at all"
  );
  assert.match(source, /<WorkspaceSetupDialog\s+open=\{projectDialogOpen\}\s+onClose=/, "creating a folder stays an action the user takes");
});

test("the folder affordance is visible on Windows before any folder exists", () => {
  const source = readFileSync(path.join(root, "src", "ChatPage.jsx"), "utf8").replace(/\r\n/g, "\n");
  const bar = source.slice(
    source.indexOf('{nativeShell === NATIVE_SHELLS.windows && nativeWorkspaces'),
    source.indexOf('{nativeShell === NATIVE_SHELLS.windows && nativeWorkspaces') + 4000
  );
  assert.ok(bar.startsWith('{nativeShell === NATIVE_SHELLS.windows && nativeWorkspaces ? ('), bar.slice(0, 80));
  assert.match(bar, /Set up project folder/);
  assert.match(
    bar,
    /runs in Documents/,
    "a chat with no attached folder is told where its work actually happens"
  );
  assert.doesNotMatch(bar, /when you send it/, "the bar never makes a folder sound like a step to take");
  assert.doesNotMatch(source, /nativeShell === NATIVE_SHELLS\.windows && \(chatWorkspace \|\| workspaces\.length > 0\)/);
  assert.match(source, /workspaces\.length > 0 \? \(\s*<select/);
});
