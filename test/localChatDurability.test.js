import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chatPageSource = readFileSync(path.join(root, "src", "ChatPage.jsx"), "utf8");
const taskContextSource = readFileSync(path.join(root, "src", "desktop", "TaskContext.jsx"), "utf8");
const chatStoreSource = readFileSync(path.join(root, "src", "localai", "localChatStore.js"), "utf8");
const rustRoot = readFileSync(path.join(root, "src-tauri", "src", "vups_root.rs"), "utf8");
const rustStore = readFileSync(path.join(root, "src-tauri", "src", "local_chats.rs"), "utf8");
const rustMain = readFileSync(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
const desktopDir = path.join(root, "src", "desktop");

function sliceBetween(source, startMarker, endMarker = "") {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} exists`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : -1;
  return source.slice(start, end > start ? end : undefined);
}

test("the physical store lives in Documents\\VupsRouter\\Local Chats, not AppData", () => {
  assert.match(rustRoot, /pub const LOCAL_CHATS_SUBDIR: &str = "Local Chats";/);
  assert.match(
    rustRoot,
    /pub const LAYOUT_SUBDIRS: \[&str; 7\] = \[[^\]]*LOCAL_CHATS_SUBDIR\]/,
    "Local Chats is one of the seven folders the layout guarantees"
  );
  assert.match(
    rustStore,
    /crate::vups_root::local_chats_directory_in\(&crate::vups_root::documents_directory\(\)\?\)\?/,
    "the store path is derived from the Documents root, not from the app data folder"
  );
  assert.equal(
    (rustStore.match(/app_data_dir\(\)/g) || []).length,
    1,
    "AppData is read only to hand a legacy file to the migration, never as a live store"
  );
  assert.doesNotMatch(chatStoreSource, /localStorage|sessionStorage/, "the client adapter never substitutes browser storage");
});

test("the Windows shell registers every native local-chat command", () => {
  assert.match(rustMain, /mod local_chats;/, "the local-chat module is compiled into the shell");
  for (const command of [
    "local_chats_list",
    "local_chats_get",
    "local_chats_create",
    "local_chats_append_message",
    "local_chats_update",
    "local_chats_delete",
    "local_chats_import",
    "local_chats_storage_info"
  ]) {
    assert.match(rustMain, new RegExp(`local_chats::${command}`), `${command} is exposed to the WebView`);
  }
});

test("the Windows shell manages the state required by native local-chat commands", () => {
  assert.match(rustMain, /\.manage\(local_chats::LocalChatState::default\(\)\)/);
});

test("a legacy AppData store is copied before it is archived, and never overwrites Documents", () => {
  const migration = sliceBetween(rustStore, "fn migrate_store_files", "\nfn ");
  assert.match(migration, /!legacy\.exists\(\) \|\| target\.exists\(\)/, "an existing Documents store wins");
  const written = migration.indexOf("write_store_at(target, &store)?");
  const archived = migration.indexOf("fs::rename(legacy, &archived)");
  assert.ok(written > 0 && archived > written, "the copy lands before the old file is renamed away");
  assert.match(migration, /local-chats-v1\.migrated-/, "the old file is archived, not deleted");
  assert.match(rustStore, /fn a_legacy_store_is_copied_into_documents_then_archived\(\)/);
  assert.match(rustStore, /fn an_existing_documents_store_wins_over_a_stale_legacy_file\(\)/);
});

test("a final answer replaces a longer streaming placeholder in the native store", () => {
  assert.match(rustStore, /#\[serde\(default, rename = "final"\)\]\s*pub is_final: bool/);
  assert.match(
    rustStore,
    /if new\.is_final\s*\|\|\s*content\.chars\(\)\.count\(\) >= existing\.content\.chars\(\)\.count\(\) \{\s*existing\.content = content;/,
    "the unconditional replace is what stops a placeholder from winning"
  );
  assert.match(rustStore, /fn a_final_answer_replaces_a_longer_streaming_placeholder\(\)/);
});

test("the client bridge sends final=false while streaming and final=true for a terminal write", async () => {
  const seen = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        seen.push({ command, args });
        return null;
      }
    },
    location: { search: "?native=windows" }
  };
  try {
    const store = await import(pathToFileURL(path.join(root, "src", "localai", "localChatStore.js")).href);
    await store.appendNativeLocalChatMessage("owner-a", "lcn_1", {
      id: "m1",
      role: "assistant",
      content: "partial",
      status: "streaming"
    });
    await store.appendNativeLocalChatMessage("owner-a", "lcn_1", {
      id: "m1",
      role: "assistant",
      content: "answer",
      status: "complete",
      final: true
    });
    assert.deepEqual(seen.map(entry => entry.command), ["local_chats_append_message", "local_chats_append_message"]);
    assert.equal(seen[0].args.message.final, false, "a stream snapshot is never marked final");
    assert.equal(seen[1].args.message.final, true, "the terminal answer is marked final");
    assert.equal(seen[1].args.owner, "owner-a");
    assert.equal(seen[1].args.chatId, "lcn_1");
  } finally {
    delete globalThis.window;
  }
});

test("a progress line can be painted but is never stored as the assistant reply", () => {
  const paintStream = sliceBetween(chatPageSource, "const paintStream = () => {", "try {\n          status =");
  assert.match(paintStream, /content: answer \|\| status/, "the UI may still show a status line");
  assert.match(
    paintStream,
    /if \(useNativeStore && answer\) \{\s*const now = Date\.now\(\);[\s\S]*?appendNativeLocalChatMessage\([\s\S]*?content: answer,/,
    "the native write happens only once real model output exists"
  );
});

test("every terminal native write is final, and no streaming write pretends to be", () => {
  const terminalStatuses = [
    'status: "complete"',
    'status: "stopped"',
    'status: "failed"',
    'status: "interrupted"',
    'status: stopped ? "stopped" : "failed"'
  ];
  let cursor = 0;
  let terminalCalls = 0;
  let streamingCalls = 0;
  while (true) {
    const at = chatPageSource.indexOf("appendNativeLocalChatMessage(", cursor);
    if (at < 0) break;
    cursor = at + 1;
    const block = chatPageSource.slice(at, at + 420);
    if (block.includes('status: "streaming"')) {
      streamingCalls += 1;
      assert.doesNotMatch(block, /final: true/, "a streaming snapshot must not claim to be the final answer");
    } else if (terminalStatuses.some(status => block.includes(status))) {
      terminalCalls += 1;
      assert.match(block, /final: true/, "every terminal write replaces the streamed text");
    }
  }
  assert.equal(streamingCalls, 4, "two starting rows and two streaming snapshots stay non-final");
  assert.equal(terminalCalls, 7, "combo and single-model completion, stop, failure, interruption and recovery");
  assert.equal(terminalCalls + streamingCalls, 11, "every native append in the page is accounted for");
});

test("an answer that could not be stored is reported instead of completed silently", () => {
  assert.match(chatPageSource, /savedAnswer \? "completed" : "failed"/);
  assert.match(chatPageSource, /The answer is on screen but could not be saved to this Local Chat\./);
});

test("reopening a settled run shows the run's own answer, not a longer placeholder", () => {
  const settledLive = sliceBetween(
    chatPageSource,
    "const liveText = String(live.content || live.stage || \"\");",
    "queueMicrotask(() => clearLocalRun(id, live.assistantId));"
  );
  assert.match(settledLive, /liveText\.trim\(\)/, "non-empty live text wins");
  assert.match(settledLive, /content: liveText/);
  assert.doesNotMatch(settledLive, /\.length/, "no length comparison may reinstate the placeholder");
});

test("a saved draft is recovered exactly once without asking any model again", () => {
  const recovery = sliceBetween(
    chatPageSource,
    "// A draft that outlived its run while the record already settled",
    "loadingConversationRef.current = \"\";"
  );
  assert.match(recovery, /answerAlreadyStored/);
  assert.match(recovery, /No model was run again\./);
  assert.match(recovery, /final: true/);
  assert.match(recovery, /clearLocalRunDraft\(id\);/, "the recovered draft is consumed");
  assert.doesNotMatch(recovery, /runLocalCombo\(|chatLocalModel\(/, "recovery never re-runs a model");
});

test("a chat left marked running by a closed app becomes interrupted at startup", () => {
  assert.match(taskContextSource, /import \{ isLocalRunActive \} from "\.\.\/localai\/localRunStore\.js";/);
  const effect = sliceBetween(taskContextSource, "const staleRunsChecked = useRef(false);", "}, [workspaceOwner]);");
  assert.match(effect, /row\.state === "running" && !isLocalRunActive\(row\.id\)/, "only runs this document does not own are repaired");
  assert.match(effect, /state: "interrupted"/);
  assert.match(effect, /The app closed before this local run finished\./);
  assert.match(effect, /syncNativeLocalChats\(await listNativeLocalChats\(workspaceOwner\)/);
  assert.match(effect, /refreshConversationsRef\.current\?\.\(\)/);
});

test("the client never fakes the folder; it asks the native root to create it", () => {
  assert.match(chatStoreSource, /Documents\\VupsRouter\\Local Chats/, "the adapter documents the real location");
  const bridge = readFileSync(path.join(desktopDir, "workspaceBridge.js"), "utf8");
  assert.match(bridge, /vups_root_ensure/);
});
