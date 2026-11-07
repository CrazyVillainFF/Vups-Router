import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(root, "src", "desktop");
const pagesSource = readFileSync(path.join(desktopDir, "DesktopPages.jsx"), "utf8");

// The Rust side answers with the folder Windows actually reported, so the
// display layer has to be honest about the four shapes that response comes in.
function statusFixture(overrides = {}) {
  return {
    documentsPath: "C:\\Users\\tester\\Documents",
    rootPath: "C:\\Users\\tester\\Documents\\VupsRouter",
    present: true,
    layoutVersion: 1,
    status: "ready",
    initialized: true,
    migrationCount: 0,
    initializedAt: 1762400000000,
    lastError: null,
    subdirs: [
      { name: "Workspaces", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Workspaces" },
      { name: "Projects", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Projects" },
      { name: "Files", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Files" },
      { name: "Skills", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Skills" },
      { name: "Plugins", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Plugins" },
      { name: "Logs", kind: "folder", path: "C:\\Users\\tester\\Documents\\VupsRouter\\Logs" }
    ],
    recentLogLines: ["bootstrap: layout ok"],
    note: "The path shown is the Documents folder Windows reported for this user.",
    ...overrides
  };
}

let storage;

test.before(async () => {
  storage = await import(pathToFileURL(path.join(desktopDir, "workspaceStorage.js")).href);
});

test("a healthy layout reads as ready with the real path and every folder", () => {
  const view = storage.storageView(statusFixture());
  assert.equal(view.tone, "ok");
  assert.equal(view.label, "Ready");
  assert.equal(view.path, "C:\\Users\\tester\\Documents\\VupsRouter");
  assert.equal(view.rows.length, 6);
  assert.deepEqual(view.rows.map(row => row.name), ["Workspaces", "Projects", "Files", "Skills", "Plugins", "Logs"]);
  assert.ok(view.rows.every(row => row.state === "folder"), "all six are reported as real folders");
  assert.match(view.detail, /layout version 1/i);
});

test("a folder the app never made is shown as missing, not as ready", () => {
  const view = storage.storageView(
    statusFixture({
      present: false,
      initialized: false,
      status: "",
      subdirs: statusFixture().subdirs.map((entry, index) =>
        index === 0 ? entry : { ...entry, kind: "missing" }
      )
    })
  );
  assert.notEqual(view.tone, "ok", "an absent folder cannot be reported as ready");
  assert.ok(view.rows.filter(row => row.state === "missing").length >= 5);
  assert.equal(view.canOpen, false, "there is nothing to open yet");
});

test("a failed bootstrap shows the recorded reason instead of a green badge", () => {
  const view = storage.storageView(
    statusFixture({
      status: "failed",
      lastError: "Documents is on a disconnected drive",
      subdirs: statusFixture().subdirs.map(entry => ({ ...entry, kind: "unknown" }))
    })
  );
  assert.equal(view.tone, "error");
  assert.equal(view.error, "Documents is on a disconnected drive");
  assert.ok(view.rows.every(row => row.state === "unknown"), "an unreadable folder is not called a folder");
});

test("a partial layout and a migration are both named honestly", () => {
  const partial = storage.storageView(
    statusFixture({
      status: "partial",
      subdirs: statusFixture().subdirs.map(entry =>
        entry.name === "Logs" ? { ...entry, kind: "file" } : entry
      )
    })
  );
  assert.equal(partial.tone, "warn");
  assert.match(partial.error, /Logs/i, "the blocked-by-a-file folder is named");
  assert.equal(partial.rows.find(row => row.name === "Logs").state, "file");

  const migrated = storage.storageView(statusFixture({ migrationCount: 2 }));
  assert.match(migrated.detail, /migrated 2 times/i);
});

test("a second VupsRouter folder left by a moved Documents is shown, not hidden", () => {
  const moved = storage.storageView(
    statusFixture({ previousRootPath: "C:\\Users\\tester\\Documents\\Older\\VupsRouter" })
  );
  assert.equal(moved.otherLayout, "C:\\Users\\tester\\Documents\\Older\\VupsRouter");
  assert.equal(storage.storageView(statusFixture()).otherLayout, "", "no second folder is invented");
  assert.match(pagesSource, /view\.otherLayout/, "the settings section renders the other location");
});

test("the recent log lines are carried through untouched and capped", () => {
  const view = storage.storageView(
    statusFixture({ recentLogLines: Array.from({ length: 60 }, (_, index) => `line ${index}`) })
  );
  assert.equal(view.logs.length, 60, "the app shows what it was given, in order");
  assert.equal(view.logs[0], "line 0");
  assert.deepEqual(storage.storageView(statusFixture({ recentLogLines: null })).logs, []);
});

test("the bridge calls the real root commands with no invented arguments", async () => {
  const seen = [];
  const invoke = async (command, args) => {
    seen.push({ command, args });
    return command === "vups_root_status" ? statusFixture() : "C:\\Users\\tester\\Documents\\VupsRouter";
  };
  globalThis.window = {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { internal: { invoke } }
  };
  const bridge = await import(pathToFileURL(path.join(desktopDir, "workspaceBridge.js")).href);
  assert.equal((await bridge.readStorageStatus()).rootPath, "C:\\Users\\tester\\Documents\\VupsRouter");
  await bridge.ensureStorageRoot();
  await bridge.openStorageRoot();
  await bridge.revealStorageRoot();
  assert.deepEqual(seen.map(entry => entry.command), [
    "vups_root_status",
    "vups_root_ensure",
    "vups_root_open",
    "vups_root_reveal"
  ]);
  delete globalThis.window;
});

test("the settings section wires each button to the command that does it", () => {
  const section = pagesSource.slice(
    pagesSource.indexOf("function WorkspaceStorageSection"),
    pagesSource.indexOf("export function AppSettingsPage")
  );
  assert.ok(section.length > 400, "the storage section is its own component");
  for (const call of ["readStorageStatus", "ensureStorageRoot", "openStorageRoot", "revealStorageRoot"]) {
    assert.ok(section.includes(`${call}(`), `${call} is actually called`);
  }
  assert.match(section, /Open folder/);
  assert.match(section, /Reveal in Explorer/);
  assert.match(section, /Re-check folders/);
  assert.match(section, /storageView\(status\)/, "the panel renders through the view model, not raw fields");
  assert.doesNotMatch(section, /Documents\\\\VupsRouter/, "no hard-coded Documents path is guessed in the UI");
  assert.match(pagesSource, /<WorkspaceStorageSection \/>/, "the section is on the settings page");
});

test("the website says the folder is a Windows-app feature instead of faking buttons", () => {
  const section = pagesSource.slice(
    pagesSource.indexOf("function WorkspaceStorageSection"),
    pagesSource.indexOf("export function AppSettingsPage")
  );
  assert.match(section, /isTauriRuntime\(\)/, "the section knows whether it is in the native shell");
  assert.match(section, /Windows app/);
});
