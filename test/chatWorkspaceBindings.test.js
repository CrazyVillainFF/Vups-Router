import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  chatBindingsKey,
  chatWorkspaceFor,
  readChatBindings,
  sanitizeChatBindings,
  setChatBinding,
  withoutWorkspace,
  writeChatBindings
} from "../src/desktop/chatWorkspaceBindings.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    dump: () => Object.fromEntries(map)
  };
}

const folders = [
  { id: "ws-alpha", path: "C:\\work\\alpha" },
  { id: "ws-beta", path: "D:\\work\\beta" },
  { id: "ws-gamma", path: "C:\\work\\gamma" }
];

test("a chat folder binding is private to its chat", () => {
  let bindings = setChatBinding({}, "chat-1", "ws-alpha", folders);
  bindings = setChatBinding(bindings, "chat-2", "ws-beta", folders);

  assert.equal(chatWorkspaceFor(folders, bindings, "chat-1")?.id, "ws-alpha");
  assert.equal(chatWorkspaceFor(folders, bindings, "chat-2")?.id, "ws-beta");
  assert.equal(chatWorkspaceFor(folders, bindings, "chat-3"), null);
  assert.equal(chatWorkspaceFor(folders, bindings, ""), null);
  assert.equal(chatWorkspaceFor(folders, bindings, "   "), null);
});

test("replacing and detaching one chat never touches another", () => {
  let bindings = setChatBinding({}, "chat-1", "ws-alpha", folders);
  bindings = setChatBinding(bindings, "chat-2", "ws-beta", folders);

  const replaced = setChatBinding(bindings, "chat-1", "ws-gamma", folders);
  assert.equal(chatWorkspaceFor(folders, replaced, "chat-1")?.id, "ws-gamma");
  assert.equal(chatWorkspaceFor(folders, replaced, "chat-2")?.id, "ws-beta");

  const detached = setChatBinding(replaced, "chat-2", "", folders);
  assert.equal(chatWorkspaceFor(folders, detached, "chat-2"), null);
  assert.equal(chatWorkspaceFor(folders, detached, "chat-1")?.id, "ws-gamma");
});

test("a binding to an unregistered folder detaches instead of guessing", () => {
  const bindings = setChatBinding({}, "chat-1", "ws-removed", folders);
  assert.equal(chatWorkspaceFor(folders, bindings, "chat-1"), null);
  assert.equal(bindings["chat-1"], undefined);
});

test("bindings survive a reload and corrupt storage cannot attach a folder", () => {
  const storage = memoryStorage();
  let bindings = setChatBinding({}, "chat-1", "ws-alpha", folders);
  bindings = setChatBinding(bindings, "chat-2", "ws-beta", folders);
  writeChatBindings(storage, "user-1", bindings);

  const reloaded = readChatBindings(storage, "user-1");
  assert.deepEqual(reloaded, { "chat-1": "ws-alpha", "chat-2": "ws-beta" });
  assert.equal(chatWorkspaceFor(folders, reloaded, "chat-1")?.id, "ws-alpha");

  assert.deepEqual(readChatBindings(memoryStorage({ [chatBindingsKey("user-1")]: "{" }), "user-1"), {});
  assert.deepEqual(readChatBindings(memoryStorage({ [chatBindingsKey("user-1")]: '["ws-alpha"]' }), "user-1"), {});
  assert.deepEqual(
    sanitizeChatBindings({ "chat-1": "ws-alpha", "chat-2": "", "chat-3": null, "": "ws-beta" }),
    { "chat-1": "ws-alpha" }
  );
  assert.deepEqual(readChatBindings(null, "user-1"), {});
});

test("bindings are scoped to the signed-in owner", () => {
  const storage = memoryStorage();
  writeChatBindings(storage, "user-1", { "chat-1": "ws-alpha" });
  writeChatBindings(storage, "user-2", { "chat-1": "ws-beta" });

  assert.notEqual(chatBindingsKey("user-1"), chatBindingsKey("user-2"));
  assert.notEqual(chatBindingsKey(""), chatBindingsKey("user-1"));
  assert.equal(chatWorkspaceFor(folders, readChatBindings(storage, "user-1"), "chat-1")?.id, "ws-alpha");
  assert.equal(chatWorkspaceFor(folders, readChatBindings(storage, "user-2"), "chat-1")?.id, "ws-beta");
  assert.deepEqual(readChatBindings(storage, "guest"), {});
});

test("the oldest bindings are dropped past the cap", () => {
  const storage = memoryStorage();
  const many = Array.from({ length: 205 }, (_, index) => ({
    id: `ws-${index}`,
    path: `C:\\work\\${index}`
  }));
  const bindings = Object.fromEntries(many.map((workspace, index) => [`chat-${index}`, workspace.id]));
  writeChatBindings(storage, "user-1", bindings);

  const stored = readChatBindings(storage, "user-1");
  assert.equal(Object.keys(stored).length, 200);
  assert.equal(stored["chat-0"], undefined, "the oldest entries are evicted");
  assert.equal(stored["chat-204"], "ws-204", "the newest entry is kept");
});

test("removing a folder detaches every chat that used it and no one else", () => {
  const bindings = {
    "chat-1": "ws-alpha",
    "chat-2": "ws-beta",
    "chat-3": "ws-alpha"
  };
  const remaining = withoutWorkspace(bindings, "ws-alpha");
  assert.deepEqual(remaining, { "chat-2": "ws-beta" });
  assert.equal(bindings["chat-1"], "ws-alpha", "the original map is not mutated");
});

test("the chat page only ever reads the chat's own folder", () => {
  const source = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(
    source,
    /const chatWorkspace = boundChatWorkspace \|\| \(draftChat \? activeWorkspace : null\);/,
    "a saved chat cannot borrow the global active folder"
  );
  assert.match(
    source,
    /if \(draftChat && chatWorkspace\?\.id && chatScopeId\) \{\s*bindChatWorkspace\(chatScopeId, chatWorkspace\.id\);/,
    "a draft claims its folder only when the user sends"
  );
  assert.match(source, /const warnAboutSkippedTools = Boolean\(chatWorkspace\?\.id\);/);
  assert.match(source, /workspaceId: permissionMode === "workspace" \? chatWorkspace\?\.id \|\| null : null/);
  assert.doesNotMatch(source, /workspaceId: permissionMode === "workspace" \? activeWorkspace/);
  assert.match(source, /searchRoots: chatWorkspace\?\.path \? \[chatWorkspace\.path\] : \[\]/);
  assert.doesNotMatch(source, /searchRoots: workspaces\.map/);
});
