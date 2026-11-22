import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LOCAL_RUN_DRAFT_KEY,
  LOCAL_RUN_STATES,
  beginLocalRun,
  clearLocalRun,
  clearLocalRunDraft,
  finishLocalRun,
  getLocalRun,
  getLocalRunSnapshot,
  isLocalRunActive,
  listLocalRuns,
  noteLocalRunStage,
  readLocalRunDraft,
  resetLocalRuns,
  setLocalRunOwner,
  stopLocalRun,
  subscribeLocalRuns
} from "../src/localai/localRunStore.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sidebarSource = readFileSync(new URL("../src/desktop/DesktopSidebar.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: key => {
      entries.delete(key);
    }
  };
}

function withBrowserStorage(fn) {
  const previous = globalThis.window;
  const storage = memoryStorage();
  globalThis.window = { localStorage: storage };
  resetLocalRuns();
  try {
    return fn(storage);
  } finally {
    resetLocalRuns();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

function controllerStub() {
  return {
    aborted: false,
    abort() {
      this.aborted = true;
    }
  };
}

test.beforeEach(() => {
  resetLocalRuns();
  setLocalRunOwner("owner-a");
});

test("a run begins under the conversation that owns it, not under a screen", () => {
  const controller = controllerStub();
  const record = beginLocalRun({
    conversationId: "conv-1",
    assistantId: "assistant-1",
    kind: "combo",
    label: "Local Combo AI",
    controller,
    ownerId: "owner-a"
  });
  assert.equal(record.status, LOCAL_RUN_STATES.RUNNING);
  assert.equal(getLocalRun("conv-1"), record);
  assert.equal(isLocalRunActive("conv-1"), true);
  assert.equal(isLocalRunActive("conv-2"), false);
  const snapshot = getLocalRunSnapshot();
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].assistantId, "assistant-1");
  assert.equal(snapshot.runs[0].stopRequested, false);
});

test("a draft written by the loop is readable without the component that started it", () => {
  withBrowserStorage(storage => {
    beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
    noteLocalRunStage("conv-1", "### 1/2 · llama3.2:3b\n\nPartial answer");
    const raw = JSON.parse(storage.getItem(LOCAL_RUN_DRAFT_KEY));
    const draft = raw["conv-1"];
    assert.equal(draft.owner, "owner-a");
    assert.equal(draft.assistantId, "assistant-1");
    assert.match(draft.stage, /Partial answer/);
    const read = readLocalRunDraft("conv-1", "owner-a");
    assert.equal(read.assistantId, "assistant-1");
    assert.match(read.stage, /Partial answer/);
    // Another account on the same machine never reads this draft.
    assert.equal(readLocalRunDraft("conv-1", "owner-b"), null);
  });
});

test("stage updates arrive during the run and the final settle is immediate", async () => {
  const events = [];
  const unsubscribe = subscribeLocalRuns(() => events.push(getLocalRunSnapshot().version));
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  noteLocalRunStage("conv-1", "first");
  assert.equal(getLocalRunSnapshot().runs[0].stage, "first");
  finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.DONE, content: "final answer", saved: true });
  assert.equal(getLocalRun("conv-1").status, LOCAL_RUN_STATES.DONE);
  assert.equal(getLocalRun("conv-1").content, "final answer");
  assert.equal(isLocalRunActive("conv-1"), false);
  await new Promise(resolve => setTimeout(resolve, 300));
  unsubscribe();
  assert.ok(events.length >= 1, "a subscriber that was attached saw the settle");
});

test("subscribing and unsubscribing does not own the run's lifetime", () => {
  const unsubscribe = subscribeLocalRuns(() => {});
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  unsubscribe();
  assert.equal(isLocalRunActive("conv-1"), true);
  noteLocalRunStage("conv-1", "still running");
  finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.DONE, content: "answer", saved: true });
  assert.equal(getLocalRun("conv-1").content, "answer");
});

test("Stop names the run's own controller, and the stop is visible before it settles", () => {
  const controller = controllerStub();
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller, ownerId: "owner-a" });
  assert.equal(stopLocalRun("conv-1"), true);
  assert.equal(controller.aborted, true);
  assert.equal(getLocalRun("conv-1").stopRequested, true);
  // A second press has nothing left to abort but is not an error either.
  assert.equal(stopLocalRun("conv-1"), true);
  finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.STOPPED, content: "kept draft", saved: true });
  assert.equal(getLocalRun("conv-1").status, LOCAL_RUN_STATES.STOPPED);
});

test("two conversations run independently, and one settling never ends the other", () => {
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  beginLocalRun({ conversationId: "conv-2", assistantId: "assistant-2", controller: controllerStub(), ownerId: "owner-a" });
  noteLocalRunStage("conv-1", "chat one");
  noteLocalRunStage("conv-2", "chat two");
  finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.DONE, content: "chat one answer", saved: true });
  assert.equal(isLocalRunActive("conv-2"), true);
  assert.equal(getLocalRun("conv-2").stage, "chat two");
  assert.equal(listLocalRuns().length, 2);
  clearLocalRun("conv-1", "assistant-1");
  assert.equal(getLocalRun("conv-1"), null);
  assert.equal(getLocalRun("conv-2").status, LOCAL_RUN_STATES.RUNNING);
});

test("a settled record survives briefly so a returning screen can paint it, then can be cleared by id", () => {
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.FAILED, content: "partial", error: "runtime closed", saved: true });
  const settled = getLocalRun("conv-1");
  assert.equal(settled.status, LOCAL_RUN_STATES.FAILED);
  assert.equal(settled.error, "runtime closed");
  // A settle for somebody else's answer cannot clear this record.
  assert.equal(clearLocalRun("conv-1", "assistant-9"), false);
  assert.equal(clearLocalRun("conv-1", "assistant-1"), true);
  assert.equal(getLocalRun("conv-1"), null);
});

test("the draft is kept when its answer could not be saved and dropped when it was", () => {
  withBrowserStorage(() => {
    beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
    noteLocalRunStage("conv-1", "unsaved draft");
    finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.FAILED, content: "unsaved draft", saved: false });
    assert.ok(readLocalRunDraft("conv-1", "owner-a"), "an unsaved answer stays recoverable");
    clearLocalRunDraft("conv-1");
    assert.equal(readLocalRunDraft("conv-1", "owner-a"), null);

    beginLocalRun({ conversationId: "conv-2", assistantId: "assistant-2", controller: controllerStub(), ownerId: "owner-a" });
    noteLocalRunStage("conv-2", "saved draft");
    finishLocalRun("conv-2", { status: LOCAL_RUN_STATES.DONE, content: "saved draft", saved: true });
    assert.equal(readLocalRunDraft("conv-2", "owner-a"), null);
  });
});

test("a different account is a different set of runs", () => {
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  setLocalRunOwner("owner-b");
  assert.equal(getLocalRun("conv-1"), null);
  assert.equal(getLocalRunSnapshot().runs.length, 0);
});

test("the snapshot is stable between changes and rebuilt after one", () => {
  beginLocalRun({ conversationId: "conv-1", assistantId: "assistant-1", controller: controllerStub(), ownerId: "owner-a" });
  const first = getLocalRunSnapshot();
  assert.equal(getLocalRunSnapshot(), first);
  noteLocalRunStage("conv-1", "progress");
  assert.notEqual(getLocalRunSnapshot(), first);
});

test("ChatPage registers both local branches with the store and restores them on load", () => {
  // Two entry points — Local Combo AI and a single local model — and both must
  // be owned by the store rather than by this screen.
  assert.equal((chatPageSource.match(/beginLocalRun\(/g) || []).length, 2);
  assert.equal((chatPageSource.match(/finishLocalRun\(/g) || []).length, 5);
  assert.ok((chatPageSource.match(/noteLocalRunStage\(/g) || []).length >= 2);
  // The settle happens after the final answer is appended, in both branches.
  const comboDone = chatPageSource.indexOf("const savedAnswer = useNativeStore", chatPageSource.indexOf("runLocalCombo"));
  const comboFinish = chatPageSource.indexOf("finishLocalRun(localConversationId", comboDone);
  assert.ok(comboDone > 0 && comboFinish > comboDone, "the combo answer is persisted before the run is marked done");
  const persisted = chatPageSource.slice(comboDone, comboFinish);
  assert.match(persisted, /appendNativeLocalChatMessage\(/, "the Windows store receives the final answer");
  assert.match(persisted, /appendConversationMessage\(localConversationId/, "the server path still saves the final answer");
  // A conversation being opened adopts a running run and settles a finished one.
  assert.match(chatPageSource, /if \(localRun\.status === LOCAL_RUN_STATES\.RUNNING\) \{\s*adoptLocalRunTurn\(localRun, history\);/);
  assert.match(chatPageSource, /const draft = readLocalRunDraft\(id, workspaceOwner\);/);
  // Stop routes through the store when a run is registered for this chat.
  assert.match(chatPageSource, /const storeRun = getLocalRun\(activeConvId\);/);
  assert.match(chatPageSource, /stopLocalRun\(activeConvId\);/);
  // A run that started before save-first finished still hears a Stop.
  assert.match(chatPageSource, /if \(localStopRequestedRef\.current\) controller\.abort\(\);/);
});

test("the sidebar shows a running local chat as thinking from the store", () => {
  assert.match(sidebarSource, /useSyncExternalStore\(subscribeLocalRuns, getLocalRunSnapshot, getLocalRunSnapshot\)/);
  assert.match(sidebarSource, /runningLocalChats\.has\(String\(task\.id\)\) \? \{ state: "running" \}/);
});
