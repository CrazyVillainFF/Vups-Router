import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { NATIVE_SHELLS } from "../src/native/shell.js";
import {
  LOCAL_PROJECT_SAVE_STORAGE_KEY,
  buildProjectSavePlan,
  joinProjectPath,
  readProjectSaveMap,
  readProjectSaveRecord,
  resetProjectSaves,
  saveDateFolder,
  saveGeneratedFiles,
  saveProjectSaveRecord,
  shouldAutoSaveProjectFiles,
  utf8Bytes,
  wantsDownloadDelivery
} from "../src/localai/localProjectSave.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const cardSource = readFileSync(new URL("../src/components/ProjectSaveCard.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const SNAKE = "Create a simple playable Snake game.";
const SNAKE_FILES = [
  { path: "index.html", content: "<!doctype html><canvas id=\"game\"></canvas><script src=\"script.js\"></script>" },
  { path: "styles.css", content: "body { margin: 0; background: #111; }" },
  { path: "script.js", content: "const canvas = document.getElementById('game');" }
];
const SUBMITTED = "2026-11-15T09:30:00.000";

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
}

// Mirrors the native contract: create refuses an existing file, read returns
// what is actually on disk.
function fakeBridge(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const calls = { create: [], reads: [] };
  return {
    disk,
    calls,
    async createFile(owner, workspaceId, path, content) {
      calls.create.push({ owner, workspaceId, path, content });
      if (disk.has(path)) throw new Error(`A file already exists at ${path}.`);
      disk.set(path, content);
      return { path, size: utf8Bytes(content) };
    },
    async readText(owner, workspaceId, path) {
      calls.reads.push(path);
      if (!disk.has(path)) throw new Error("File not found.");
      const content = disk.get(path);
      return { path, content, size: utf8Bytes(content), truncated: false };
    }
  };
}

function snakeSave(overrides = {}) {
  return saveGeneratedFiles({
    bridge: overrides.bridge || fakeBridge(),
    owner: "owner-1",
    workspaceId: "ws-1",
    workspacePath: "C:\\Users\\Vishnu\\Documents\\VupsRouter\\Files",
    task: SNAKE,
    files: overrides.files || SNAKE_FILES,
    submittedAt: overrides.submittedAt || SUBMITTED
  });
}

test("PS-01 the automatic save is Windows-only and needs real files", () => {
  assert.equal(shouldAutoSaveProjectFiles(NATIVE_SHELLS.windows, SNAKE_FILES), true);
  assert.equal(shouldAutoSaveProjectFiles(NATIVE_SHELLS.android, SNAKE_FILES), false);
  assert.equal(shouldAutoSaveProjectFiles(null, SNAKE_FILES), false);
  assert.equal(shouldAutoSaveProjectFiles(NATIVE_SHELLS.windows, []), false);
  assert.equal(
    shouldAutoSaveProjectFiles(NATIVE_SHELLS.windows, [{ path: "index.html", content: "   " }]),
    false
  );
  assert.equal(shouldAutoSaveProjectFiles(NATIVE_SHELLS.windows, null), false);
});

test("PS-02 the date folder is DD-MM-YYYY from the submission, not the save", () => {
  assert.equal(saveDateFolder(new Date(2026, 10, 15, 0, 5).toISOString()), "15-11-2026");
  // Submitted at 23:58 local and saved after midnight: the submission date stays.
  assert.equal(saveDateFolder(new Date(2026, 10, 14, 23, 58).toISOString()), "14-11-2026");
  assert.equal(saveDateFolder(new Date(2026, 0, 3, 12, 0).toISOString()), "03-01-2026");
  assert.match(saveDateFolder("not a date"), /^\d{2}-\d{2}-\d{4}$/);
});

test("PS-03 the snake answer lands in <active project>/<date>/<task name>/", async () => {
  const plan = buildProjectSavePlan({ task: SNAKE, files: SNAKE_FILES, submittedAt: SUBMITTED });
  assert.equal(plan.dateFolder, "15-11-2026");
  assert.equal(plan.projectFolder, "Playable-Snake-Game");
  assert.deepEqual(
    plan.entries.map(entry => entry.workspacePath),
    [
      "15-11-2026/Playable-Snake-Game/index.html",
      "15-11-2026/Playable-Snake-Game/styles.css",
      "15-11-2026/Playable-Snake-Game/script.js"
    ]
  );
  const result = await snakeSave();
  assert.equal(result.status, "saved");
  assert.equal(
    result.location,
    "C:\\Users\\Vishnu\\Documents\\VupsRouter\\Files\\15-11-2026\\Playable-Snake-Game"
  );
  assert.deepEqual(
    [...result.files.map(file => file.status)],
    ["created", "created", "created"]
  );
});

test("PS-04 a structure the model already made is kept and not repeated", () => {
  const plan = buildProjectSavePlan({
    task: SNAKE,
    submittedAt: SUBMITTED,
    files: [
      { path: "Snake-Game/index.html", content: "<canvas></canvas>" },
      { path: "Snake-Game\\assets\\style.css", content: "canvas { display: block; }" },
      { path: "snake-game/js/game.js", content: "// loop" }
    ]
  });
  assert.equal(plan.projectFolder, "Snake-Game");
  assert.deepEqual(
    plan.entries.map(entry => entry.workspacePath),
    [
      "15-11-2026/Snake-Game/index.html",
      "15-11-2026/Snake-Game/assets/style.css",
      "15-11-2026/Snake-Game/js/game.js"
    ]
  );
});

test("PS-05 nested folders are preserved when there is no shared root", () => {
  const plan = buildProjectSavePlan({
    task: SNAKE,
    submittedAt: SUBMITTED,
    files: [
      { path: "index.html", content: "<canvas></canvas>" },
      { path: "assets/style.css", content: "body{}" }
    ]
  });
  assert.equal(plan.projectFolder, "Playable-Snake-Game");
  assert.deepEqual(
    plan.entries.map(entry => entry.path),
    ["index.html", "assets/style.css"]
  );
  assert.equal(plan.entries[1].workspacePath, "15-11-2026/Playable-Snake-Game/assets/style.css");
});

test("PS-06 paths that would escape the project are never planned", async () => {
  const plan = buildProjectSavePlan({
    task: SNAKE,
    submittedAt: SUBMITTED,
    files: [
      { path: "../outside.js", content: "nope" },
      { path: "a/../../outside2.js", content: "nope" },
      { path: "..", content: "nope" },
      { path: "index.html", content: "<canvas></canvas>" }
    ]
  });
  assert.deepEqual(plan.entries.map(entry => entry.path), ["index.html"]);
  const bridge = fakeBridge();
  const result = await snakeSave({ bridge, files: plan.entries.map(entry => ({ path: entry.path, content: entry.content })) });
  assert.equal(result.status, "saved");
  assert.equal(bridge.calls.create.length, 1);
  assert.equal(bridge.calls.create[0].path.includes(".."), false);
});

test("PS-07 a duplicate target in one answer is written once", () => {
  const plan = buildProjectSavePlan({
    task: SNAKE,
    submittedAt: SUBMITTED,
    files: [
      { path: "index.html", content: "first" },
      { path: "./index.html", content: "second" }
    ]
  });
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].content, "first");
});

test("PS-08 an empty answer creates nothing", async () => {
  const bridge = fakeBridge();
  const result = await saveGeneratedFiles({
    bridge,
    owner: "owner-1",
    workspaceId: "ws-1",
    workspacePath: "C:\\proj",
    task: SNAKE,
    files: [],
    submittedAt: SUBMITTED
  });
  assert.equal(result.status, "empty");
  assert.deepEqual(result.files, []);
  assert.equal(bridge.calls.create.length, 0);
  assert.equal(bridge.calls.reads.length, 0);
});

test("PS-09 every write is verified by reading the file back", async () => {
  const bridge = fakeBridge();
  const result = await snakeSave({ bridge });
  assert.equal(result.status, "saved");
  const written = bridge.calls.create.map(call => call.path);
  assert.deepEqual(written, [
    "15-11-2026/Playable-Snake-Game/index.html",
    "15-11-2026/Playable-Snake-Game/styles.css",
    "15-11-2026/Playable-Snake-Game/script.js"
  ]);
  for (const call of bridge.calls.create) {
    assert.equal(bridge.disk.get(call.path), call.content);
    assert.ok(bridge.calls.reads.includes(call.path), `${call.path} was not read back`);
  }
  assert.deepEqual(
    bridge.disk.get("15-11-2026/Playable-Snake-Game/script.js"),
    SNAKE_FILES[2].content
  );
});

test("PS-10 an existing different file is reported, never overwritten", async () => {
  const target = "15-11-2026/Playable-Snake-Game/index.html";
  const bridge = fakeBridge({ [target]: "the user's own index.html" });
  const result = await snakeSave({ bridge });
  assert.equal(result.status, "conflict");
  assert.equal(bridge.disk.get(target), "the user's own index.html");
  const indexEntry = result.files.find(file => file.path === "index.html");
  assert.equal(indexEntry.status, "conflict");
  assert.match(indexEntry.message, /left untouched/);
  // The other two files still arrive.
  assert.equal(result.files.filter(file => file.status === "created").length, 2);
});

test("PS-11 retrying an identical save is a success and writes no duplicate", async () => {
  const bridge = fakeBridge();
  const first = await snakeSave({ bridge });
  assert.equal(first.status, "saved");
  const second = await snakeSave({ bridge });
  assert.equal(second.status, "saved");
  assert.deepEqual(second.files.map(file => file.status), ["unchanged", "unchanged", "unchanged"]);
  assert.equal(bridge.disk.size, 3);
  assert.equal(bridge.calls.create.length, 6);
});

test("PS-12 a short write is a failure, not a silent save", async () => {
  const bridge = fakeBridge();
  bridge.createFile = async (owner, workspaceId, path, content) => {
    bridge.calls.create.push({ path, content });
    bridge.disk.set(path, content.slice(0, 10));
    return { path, size: utf8Bytes(content.slice(0, 10)) };
  };
  const result = await snakeSave({ bridge });
  assert.equal(result.status, "failed");
  assert.ok(result.files.every(file => file.status === "failed"));
  assert.match(result.files[0].message, /bytes/);
});

test("PS-13 a write that does not read back exactly is a failure", async () => {
  const bridge = fakeBridge();
  const create = bridge.createFile.bind(bridge);
  bridge.createFile = async (owner, workspaceId, path, content) => {
    await create(owner, workspaceId, path, content);
    return { path, size: utf8Bytes(content) };
  };
  bridge.readText = async (owner, workspaceId, path) => ({
    path,
    content: "something else entirely",
    size: 10,
    truncated: false
  });
  const result = await snakeSave({ bridge });
  assert.equal(result.status, "failed");
  assert.match(result.files[0].message, /did not match/);
});

test("PS-14 receipts are owner-scoped, keyed by message and task id, and hold no file bodies", () => {
  const storage = memoryStorage();
  const record = {
    taskId: "msg-42",
    messageId: "msg-42",
    conversationId: "lcn_snake",
    task: SNAKE,
    submittedAt: SUBMITTED,
    dateFolder: "15-11-2026",
    projectFolder: "Playable-Snake-Game",
    folderPath: "15-11-2026/Playable-Snake-Game",
    workspaceId: "ws-1",
    workspacePath: "C:\\proj",
    location: "C:\\proj\\15-11-2026\\Playable-Snake-Game",
    status: "saved",
    files: [{ path: "index.html", status: "created", bytes: 10 }]
  };
  assert.equal(saveProjectSaveRecord(record, { owner: "owner-1", storage }), true);
  const read = readProjectSaveRecord("msg-42", "owner-1", storage);
  assert.equal(read.status, "saved");
  assert.equal(read.conversationId, "lcn_snake");
  assert.equal(read.task, SNAKE);
  assert.equal(read.location, "C:\\proj\\15-11-2026\\Playable-Snake-Game");
  assert.equal(readProjectSaveRecord("msg-42", "owner-2", storage), null);
  assert.equal(readProjectSaveMap("owner-2", storage).size, 0);
  assert.equal(readProjectSaveMap("owner-1", storage).get("msg-42").status, "saved");
  const stored = storage.map.get(LOCAL_PROJECT_SAVE_STORAGE_KEY);
  assert.equal(stored.includes("const canvas"), false);
  resetProjectSaves(storage);
  assert.equal(readProjectSaveRecord("msg-42", "owner-1", storage), null);
});

test("PS-15 receipts stay bounded", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 80; index += 1) {
    saveProjectSaveRecord(
      { messageId: `m-${index}`, status: "saved", at: index + 1 },
      { owner: "owner-1", storage }
    );
  }
  const log = JSON.parse(storage.map.get(LOCAL_PROJECT_SAVE_STORAGE_KEY));
  assert.equal(Object.keys(log).length, 60);
  assert.ok(log["m-79"]);
  assert.equal(log["m-0"], undefined);
});

test("PS-16 downloads only appear for an explicit delivery request", () => {
  assert.equal(wantsDownloadDelivery(SNAKE), false);
  assert.equal(wantsDownloadDelivery("Use export default in the module"), false);
  assert.equal(wantsDownloadDelivery("Give me a downloadable zip of the game"), true);
  assert.equal(wantsDownloadDelivery("Download the files"), true);
  assert.equal(wantsDownloadDelivery("Package it as an archive"), true);
  assert.equal(wantsDownloadDelivery("Show it as attachments"), true);
  const render = chatPageSource.slice(
    chatPageSource.indexOf("nativeWindows && (message.local || message.localPlan) ?"),
    chatPageSource.indexOf("nativeWindows && (message.local || message.localPlan) ?") + 700
  );
  assert.ok(render.includes("wantsDownloadDelivery(prompt) ? <GeneratedFiles"));
  assert.ok(render.includes("<ProjectSaveCard"));
});

test("PS-17 both local completion paths save before reporting done", () => {
  let cursor = 0;
  let checked = 0;
  while (true) {
    const marker = chatPageSource.indexOf("const saveArtifact = inlineRequested", cursor);
    if (marker === -1) break;
    const save = chatPageSource.indexOf("await persistLocalProjectFiles({", marker);
    const done = chatPageSource.indexOf("LOCAL_RUN_STATES.DONE", marker);
    assert.ok(save > marker, "a completion path does not save its files");
    assert.ok(done > save, "a completion path reports done before saving");
    const call = chatPageSource.slice(save, save + 260);
    assert.ok(call.includes("messageId: assistantId"));
    assert.ok(call.includes("conversationId: localConversationId"));
    assert.ok(call.includes("submittedAt: assistantAt"));
    cursor = save + 1;
    checked += 1;
  }
  assert.equal(checked, 2);
});

test("PS-18 retry uses the saved files and never asks a model again", () => {
  const start = chatPageSource.indexOf("async function retryProjectSave");
  const end = chatPageSource.indexOf("async function chooseProjectFolderForSave", start);
  assert.ok(start > -1 && end > start);
  const body = chatPageSource.slice(start, end);
  assert.ok(body.includes("artifactForTurn"));
  assert.ok(body.includes("persistLocalProjectFiles"));
  assert.equal(/chatLocalModel|runLocalCombo|chatModel\(/.test(body), false);
  assert.equal(/ollama|api\.(tags|chat)/i.test(body), false);
  assert.ok(body.includes("record?.submittedAt"), "retry must keep the original submission date");
});

test("PS-19 a missing project folder is offered, not invented", () => {
  const persistStart = chatPageSource.indexOf("async function persistLocalProjectFiles");
  const persistEnd = chatPageSource.indexOf("async function retryProjectSave", persistStart);
  const body = chatPageSource.slice(persistStart, persistEnd);
  assert.ok(body.includes('status: "needs-folder"'));
  assert.ok(body.includes('status: "pending"'));
  assert.equal(/Downloads|tempdir|temp_dir/i.test(body), false);

  const chooseStart = chatPageSource.indexOf("async function chooseProjectFolderForSave");
  const chooseEnd = chatPageSource.indexOf("async function provisionTaskWorkspace", chooseStart);
  const chooseBody = chatPageSource.slice(chooseStart, chooseEnd);
  assert.ok(chooseBody.includes("await addWorkspace()"), "the native folder picker must be reused");

  assert.ok(cardSource.includes("Choose project folder"));
  assert.ok(cardSource.includes("onChooseFolder"));
  assert.ok(cardSource.includes("record.location"));
  assert.equal(/<a\s[^>]*download/i.test(cardSource), false);
  assert.equal(/GeneratedFiles/.test(cardSource), false);
});

test("PS-20 the join keeps Windows and workspace separators honest", () => {
  assert.equal(
    joinProjectPath("C:\\Users\\Vishnu\\Documents\\VupsRouter\\Files", "15-11-2026/Snake-Game"),
    "C:\\Users\\Vishnu\\Documents\\VupsRouter\\Files\\15-11-2026\\Snake-Game"
  );
  assert.equal(joinProjectPath("15-11-2026", "Snake-Game"), "15-11-2026/Snake-Game");
  assert.equal(joinProjectPath("C:\\proj\\", "15-11-2026/a"), "C:\\proj\\15-11-2026\\a");
  assert.equal(joinProjectPath("", "15-11-2026/a"), "15-11-2026/a");
});
