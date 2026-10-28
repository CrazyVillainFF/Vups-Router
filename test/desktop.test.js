import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  updatePreference
} from "../src/desktop/preferences.js";
import {
  AUTOMATION_SCHEDULES,
  automationError,
  automationStorageKey,
  loadAutomations,
  normalizeAutomation,
  saveAutomations
} from "../src/desktop/automations.js";
import { isTauriRuntime, listWorkspaces } from "../src/desktop/workspaceBridge.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    dump: () => Object.fromEntries(data)
  };
}

test("desktop preferences normalize invalid values and round-trip safely", () => {
  const storage = memoryStorage();
  const saved = savePreferences(storage, {
    sendShortcut: "modifier",
    showTaskTimestamps: false,
    startSidebarCollapsed: true,
    reducedMotion: true
  });
  assert.deepEqual(saved, {
    sendShortcut: "modifier",
    showTaskTimestamps: false,
    startSidebarCollapsed: true,
    reducedMotion: true
  });
  assert.deepEqual(loadPreferences(storage), saved);
  assert.deepEqual(normalizePreferences({ sendShortcut: "nope" }), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
  assert.equal(updatePreference(saved, "showTaskTimestamps", "yes").showTaskTimestamps, true);
  assert.equal(updatePreference(saved, "reducedMotion", false).reducedMotion, false);
});

test("desktop preferences fail closed without usable storage", () => {
  assert.deepEqual(loadPreferences(null), DEFAULT_PREFERENCES);
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    }
  };
  assert.deepEqual(loadPreferences(broken), DEFAULT_PREFERENCES);
  assert.deepEqual(savePreferences(broken, DEFAULT_PREFERENCES), DEFAULT_PREFERENCES);
  assert.equal(PREFERENCES_STORAGE_KEY, "vupsrouter.desktop.preferences.v1");
});

test("automations are owner-scoped, bounded, and never scheduled by accident", () => {
  assert.equal(automationStorageKey("user_1"), "vupsrouter.desktop.automations.user_1.v1");
  assert.equal(automationStorageKey(""), "vupsrouter.desktop.automations.guest.v1");
  assert.deepEqual(
    AUTOMATION_SCHEDULES.map(item => item.value),
    ["manual", "daily", "weekdays"]
  );

  const normalized = normalizeAutomation({
    name: "  Weekly   release  ",
    prompt: "  Review risks.  ",
    schedule: "daily",
    time: "08:30"
  });
  assert.equal(normalized.name, "Weekly release");
  assert.equal(normalized.prompt, "Review risks.");
  assert.equal(normalized.schedule, "daily");
  assert.equal(normalized.time, "08:30");

  const invalid = normalizeAutomation({ schedule: "hourly", time: "99:99" });
  assert.equal(invalid.schedule, "manual");
  assert.equal(invalid.time, "09:00");
  assert.equal(automationError({ name: "", prompt: "x" }), "Enter a name for this automation.");
  assert.equal(automationError({ name: "x", prompt: "" }), "Enter the task to run.");
  assert.equal(automationError({ name: "x", prompt: "a".repeat(4001) }).includes("4000"), true);
});

test("automation storage drops blank drafts and survives damaged data", () => {
  const storage = memoryStorage();
  const saved = saveAutomations(storage, "user_1", [
    { name: "One", prompt: "First task", schedule: "manual" },
    { name: " ", prompt: "Missing name" },
    { name: "Two", prompt: " " }
  ]);
  assert.equal(saved.length, 1);
  assert.equal(loadAutomations(storage, "user_1")[0].name, "One");
  assert.deepEqual(loadAutomations(storage, "other"), []);
  storage.setItem(automationStorageKey("user_1"), "{broken");
  assert.deepEqual(loadAutomations(storage, "user_1"), []);
});

test("workspace bridge fails closed when the Tauri runtime is absent", async () => {
  assert.equal(isTauriRuntime(), false);
  await assert.rejects(listWorkspaces("user_1"), /Windows app/);
});
