import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_SELECTION_STORAGE_KEY,
  PERSONAL_GROUP,
  SHARED_GROUP,
  buildCatalog,
  chatReference,
  fallbackRow,
  loadStoredSelection,
  resolveSelection,
  saveStoredSelection,
  selectionFromRow
} from "../src/chat/modelCatalog.js";

function savedModel(configId, model, { provider = "DeepSeek", masked = "sk-…aaaa", providerId = "deepseek" } = {}) {
  return {
    id: model,
    name: model,
    ownedBy: provider,
    provider,
    providerId,
    configId,
    apiKeyMasked: masked,
    shared: false,
    saved: true,
    vision: null
  };
}

function sharedModel(id, { vision = false } = {}) {
  return { id, name: id, available: true, vision };
}

function sharedStatus(models) {
  return { enabled: true, available: true, model: models[0]?.id || "", models };
}

function groups(catalog) {
  return [...new Set(catalog.map((row) => row.group))];
}

function fakeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    dump: () => [...data.values()].join("\n")
  };
}

test("saved keys and free models are offered together", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")])
  });
  const models = catalog.map((row) => row.model);
  assert.ok(models.includes("deepseek-chat"), "saved model is missing");
  assert.ok(models.includes("gemma3:4b"), "free model is missing");
  assert.deepEqual(groups(catalog), [PERSONAL_GROUP, SHARED_GROUP]);
});

test("the full free catalogue is kept when the API already returns it", () => {
  const catalog = buildCatalog({
    models: [
      { id: "free/alpha", name: "Free Alpha", ownedBy: "Shared", shared: true, vision: false },
      { id: "free/beta", name: "Free Beta", ownedBy: "Shared", shared: true, vision: true },
      savedModel("cfg-a", "deepseek-chat")
    ],
    shared: sharedStatus([sharedModel("free/alpha"), sharedModel("free/beta", { vision: true })])
  });
  const free = catalog.filter((row) => row.shared).map((row) => row.model);
  assert.deepEqual(free, ["free/alpha", "free/beta"]);
  assert.equal(catalog.filter((row) => row.saved).length, 1);
});

test("free models stay visible when personal discovery returns nothing", () => {
  const catalog = buildCatalog({
    models: [],
    shared: sharedStatus([sharedModel("free/alpha"), sharedModel("free/beta")])
  });
  assert.deepEqual(
    catalog.map((row) => row.model),
    ["free/alpha", "free/beta"],
    "the whole shared catalogue must survive a failed personal discovery"
  );
});

test("with no saved keys the catalogue contains only free models", () => {
  const catalog = buildCatalog({
    models: [],
    shared: sharedStatus([sharedModel("free/alpha")])
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].shared, true);
  assert.equal(catalog[0].group, SHARED_GROUP);
});

test("saved models remain when the free catalogue is unavailable", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: { enabled: true, available: false, model: "gemma3:4b", models: [sharedModel("gemma3:4b")] }
  });
  assert.deepEqual(catalog.map((row) => row.model), ["deepseek-chat"]);
  assert.equal(catalog[0].group, PERSONAL_GROUP);
});

test("two keys for the same provider keep separate, distinguishable rows", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "deepseek-chat", { masked: "sk-…aaaa" }),
      savedModel("cfg-b", "deepseek-chat", { masked: "sk-…bbbb" })
    ],
    shared: null
  });
  const rows = catalog.filter((row) => row.model === "deepseek-chat");
  assert.equal(rows.length, 2, "both saved configurations must be listed");
  assert.notEqual(rows[0].key, rows[1].key, "duplicate model rows need distinct keys");
  assert.deepEqual(rows.map((row) => row.configId).sort(), ["cfg-a", "cfg-b"]);
  assert.match(rows[0].meta, /aaaa|bbbb/);
});

test("the same model on different providers is distinguishable", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "shared-model", { provider: "DeepSeek", providerId: "deepseek" }),
      savedModel("cfg-b", "shared-model", { provider: "Groq", providerId: "groq" })
    ],
    shared: null
  });
  assert.equal(catalog.length, 2);
  assert.notEqual(catalog[0].key, catalog[1].key);
  assert.deepEqual(catalog.map((row) => row.provider), ["DeepSeek", "Groq"]);
});

test("saved rows expose provider, masked key, and a saved marker", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat", { provider: "DeepSeek", masked: "sk-…1234" })],
    shared: null
  });
  const row = catalog[0];
  assert.equal(row.tag, "Saved model");
  assert.equal(row.provider, "DeepSeek");
  assert.equal(row.apiKeyMasked, "sk-…1234");
  assert.match(row.meta, /DeepSeek/);
  assert.match(row.meta, /sk-…1234/);
  assert.equal(row.configId, "cfg-a");
  assert.equal(row.saved, true);
});

test("a saved selection resolves to the exact configuration", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "deepseek-chat", { masked: "sk-…aaaa" }),
      savedModel("cfg-b", "deepseek-chat", { masked: "sk-…bbbb" })
    ],
    shared: sharedStatus([sharedModel("gemma3:4b")])
  });
  const row = resolveSelection(catalog, { kind: "saved", configId: "cfg-b", model: "deepseek-chat" });
  assert.ok(row);
  assert.equal(row.configId, "cfg-b");
  assert.equal(row.apiKeyMasked, "sk-…bbbb");
  assert.deepEqual(selectionFromRow(row), { kind: "saved", configId: "cfg-b", model: "deepseek-chat" });
});

test("a shared selection resolves without a configuration id", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")])
  });
  const row = resolveSelection(catalog, { kind: "shared", model: "gemma3:4b" });
  assert.ok(row);
  assert.equal(row.shared, true);
  assert.deepEqual(selectionFromRow(row), { kind: "shared", model: "gemma3:4b" });
});

test("a stale saved selection falls back to the free model", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")])
  });
  assert.equal(resolveSelection(catalog, { kind: "saved", configId: "deleted", model: "deepseek-chat" }), null);
  const fallback = fallbackRow(catalog);
  assert.ok(fallback);
  assert.equal(fallback.shared, true);
  assert.equal(fallback.model, "gemma3:4b");
});

test("the fallback uses a saved row only when no free model exists", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: { enabled: false, available: false, models: [] }
  });
  const fallback = fallbackRow(catalog);
  assert.equal(fallback.model, "deepseek-chat");
  assert.equal(fallback.configId, "cfg-a");
});

test("selection storage round-trips without ever storing a key", () => {
  const storage = fakeStorage();
  saveStoredSelection({ kind: "saved", configId: "cfg-a", model: "deepseek-chat" }, storage);
  assert.deepEqual(loadStoredSelection(storage), {
    kind: "saved",
    configId: "cfg-a",
    model: "deepseek-chat"
  });
  const raw = storage.dump();
  assert.ok(storage.getItem(MODEL_SELECTION_STORAGE_KEY), "selection is stored under the versioned key");
  assert.ok(!/sk-|apiKey|encrypted/i.test(raw), "storage must not contain key material");

  storage.setItem(MODEL_SELECTION_STORAGE_KEY, "{not json");
  assert.equal(loadStoredSelection(storage), null);
  storage.setItem(MODEL_SELECTION_STORAGE_KEY, JSON.stringify({ kind: "other", model: 42 }));
  assert.equal(loadStoredSelection(storage), null);
});

test("chat requests carry configId only for saved rows", () => {
  const saved = buildCatalog({ models: [savedModel("cfg-a", "deepseek-chat")], shared: null })[0];
  const free = buildCatalog({ models: [], shared: sharedStatus([sharedModel("gemma3:4b")]) })[0];
  assert.deepEqual(chatReference(saved), { model: "deepseek-chat", configId: "cfg-a" });
  assert.deepEqual(chatReference(free), { model: "gemma3:4b" });
});
