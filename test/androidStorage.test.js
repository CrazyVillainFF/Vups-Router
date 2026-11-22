import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Android storage is private, organized, and does not request broad storage permission", () => {
  const plugin = read("android/app/src/main/java/com/vupsrouter/app/storage/VupsStoragePlugin.java");
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  const activity = read("android/app/src/main/java/com/vupsrouter/app/MainActivity.java");
  for (const directory of ["Projects", "LocalChats", "Plugins", "Skills", "Data", "Backups"]) {
    assert.match(plugin, new RegExp(`\\"${directory}\\"`));
  }
  assert.match(plugin, /getFilesDir\(\)/);
  assert.match(plugin, /getFD\(\)\.sync\(\)/);
  assert.match(plugin, /\.tmp/);
  assert.doesNotMatch(manifest, /MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
  assert.match(activity, /registerPlugin\(VupsStoragePlugin\.class\)/);
});

test("Android Local Chats use the native store and stable message ids", () => {
  const adapter = read("src/localai/localChatStore.js");
  assert.match(adapter, /isAndroidApp\(\)/);
  assert.match(adapter, /LocalChats\/local-chats-v1\.json/);
  assert.match(adapter, /messageIndex/);
  assert.match(adapter, /nativeCommand\("local_chats_append_message"/);
});

test("Android task reconnect polls durable backend work when the app resumes", () => {
  const tracker = read("src/tasks/TaskTrackerContext.jsx");
  assert.match(tracker, /appStateChange/);
  assert.match(tracker, /state\?\.isActive/);
  assert.match(tracker, /pollTaskTrackerOnce\(\)/);
});
