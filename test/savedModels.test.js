import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  MODEL_FILTERS,
  SAVED_MODELS_STORAGE_KEY,
  filterEmptyMessage,
  filterModelRows,
  isModelSaved,
  loadSavedModelIds,
  matchesModelQuery,
  missingSavedModelCount,
  normalizeSavedModelIds,
  savedModelId,
  saveSavedModelIds,
  toggleSavedModel
} from "../src/chat/savedModels.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

function fakeStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    raw: key => data.get(key)
  };
}

const rows = [
  {
    key: "vups",
    vups: true,
    name: "Vups v3 Galax",
    model: "vups-v3-galax",
    provider: "Vups",
    free: true
  },
  {
    key: "shared:free/a",
    shared: true,
    name: "Free Alpha",
    model: "free/a",
    provider: "Shared",
    free: true
  },
  {
    key: "gateway:x/paid",
    gateway: true,
    source: "omniroute",
    name: "Paid Beta",
    model: "x/paid",
    provider: "OmniRoute",
    free: false
  },
  {
    key: "saved:cfg-1/paid-model",
    name: "Paid Model",
    model: "paid-model",
    configId: "cfg-1",
    providerId: "openrouter",
    provider: "OpenRouter",
    free: false
  },
  {
    key: "status",
    gateway: true,
    name: "OmniRoute",
    model: "",
    provider: "OmniRoute",
    disabled: true
  }
];

test("saved identities keep the provider configuration and exact model id", () => {
  assert.equal(savedModelId(rows[0]), "vups:vups-v3-galax");
  assert.equal(savedModelId(rows[1]), "shared:free/a");
  assert.equal(savedModelId(rows[2]), "gateway:omniroute:x/paid");
  assert.equal(savedModelId(rows[3]), "custom:cfg-1:paid-model");
  assert.equal(savedModelId({ ...rows[3], name: "Renamed Model" }), "custom:cfg-1:paid-model");
  assert.equal(savedModelId({ model: "m", provider: "P" }), "custom:P:m");
  assert.equal(savedModelId({ shared: true, model: "m" }), "shared:m");
  assert.equal(savedModelId(null), "");
});

test("saved ids persist across restarts and survive display changes", () => {
  const storage = fakeStorage();
  assert.deepEqual(loadSavedModelIds(storage), []);

  const first = toggleSavedModel(rows[1], []);
  assert.deepEqual(first, { ids: ["shared:free/a"], saved: true });
  saveSavedModelIds(first.ids, storage);

  const restarted = loadSavedModelIds(storage);
  assert.deepEqual(restarted, ["shared:free/a"]);
  assert.equal(isModelSaved(rows[1], restarted), true);
  assert.equal(isModelSaved({ ...rows[1], name: "Renamed", tag: "Free model - new" }, restarted), true);

  const removed = toggleSavedModel(rows[1], restarted);
  assert.deepEqual(removed, { ids: [], saved: false });
  saveSavedModelIds(removed.ids, storage);
  assert.equal(storage.raw(SAVED_MODELS_STORAGE_KEY), undefined, "an empty list clears storage");
});

test("saved storage ignores malformed payloads instead of crashing", () => {
  const storage = fakeStorage();
  storage.setItem(SAVED_MODELS_STORAGE_KEY, "{not json");
  assert.deepEqual(loadSavedModelIds(storage), []);

  storage.setItem(SAVED_MODELS_STORAGE_KEY, JSON.stringify({ models: ["a", "a", 5, "", " b "] }));
  assert.deepEqual(loadSavedModelIds(storage), ["a", "b"]);

  storage.setItem(SAVED_MODELS_STORAGE_KEY, JSON.stringify(["x", null, "y"]));
  assert.deepEqual(loadSavedModelIds(storage), ["x", "y"]);

  assert.deepEqual(normalizeSavedModelIds(undefined), []);
});

test("filters never invent a free model or a saved model", () => {
  assert.deepEqual(MODEL_FILTERS.map(filter => filter.id), ["all", "free", "saved"]);

  assert.deepEqual(filterModelRows(rows, "all", []).map(row => row.key), rows.map(row => row.key));

  const free = filterModelRows(rows, "free", []);
  assert.deepEqual(free.map(row => row.key), ["vups", "shared:free/a"]);
  assert.ok(free.every(row => row.free === true));
  assert.ok(!free.some(row => row.key === "status"), "disabled status rows are not models");

  const saved = filterModelRows(rows, "saved", ["custom:cfg-1:paid-model", "shared:free/a", "gone:model"]);
  assert.deepEqual(saved.map(row => row.key), ["shared:free/a", "saved:cfg-1/paid-model"]);

  assert.deepEqual(filterModelRows(rows, "saved", []), []);
  assert.deepEqual(filterModelRows(null, "free", []), []);
});

test("removed saved models are counted instead of silently misrouted", () => {
  assert.equal(missingSavedModelCount(rows, ["shared:free/a", "gone:model"]), 1);
  assert.equal(missingSavedModelCount(rows, []), 0);
  assert.equal(missingSavedModelCount([], ["gone:model", "gone:other"]), 2);
});

test("search runs inside the active filter", () => {
  assert.equal(matchesModelQuery(rows[1], "free"), true);
  assert.equal(matchesModelQuery(rows[1], "Shared"), true);
  assert.equal(matchesModelQuery(rows[1], "paid"), false);
  assert.equal(matchesModelQuery(rows[1], ""), true);
});

test("empty states explain which filter is empty", () => {
  assert.match(filterEmptyMessage("saved", { savedCount: 0 }), /No saved models yet/);
  assert.match(filterEmptyMessage("saved", { savedCount: 2 }), /not in the current catalogue/);
  assert.match(filterEmptyMessage("saved", { savedCount: 2, query: "zzz" }), /No saved models match/);
  assert.match(filterEmptyMessage("free", {}), /No free models/);
  assert.match(filterEmptyMessage("all", { query: "zzz" }), /No models match/);
});

test("the picker renders compact filters and a save control", () => {
  const picker = read("src/components/reactbits/PromptBar.jsx");
  assert.match(picker, /MODEL_FILTERS/);
  assert.match(picker, /aria-label="Filter models"/);
  assert.match(picker, /className="prompt-bar__model-filter"/);
  assert.match(picker, /filterModelRows\(models, modelFilter, savedIds\)/);
  assert.match(picker, /className="prompt-bar__model-star"/);
  assert.match(picker, /saveSavedModelIds\(next\.ids\)/);
  assert.match(picker, /Missing|savedMissing/);

  const css = read("src/components/reactbits/PromptBar.css");
  assert.match(css, /\.prompt-bar__model-filters/);
  assert.match(css, /\.prompt-bar__model-filter\[aria-pressed='true'\]/);
  assert.match(css, /\.prompt-bar__model-star\[data-on\]/);
});
