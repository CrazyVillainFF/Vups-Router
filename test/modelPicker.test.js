import test from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_MODEL_TYPE,
  FREE_MODEL_TYPE,
  GATEWAY_GROUP,
  MODEL_SELECTION_STORAGE_KEY,
  OMNIROUTE_SOURCE,
  PERSONAL_GROUP,
  SHARED_GROUP,
  SHARED_PAID_GROUP,
  VUPS_CAPABILITIES,
  VUPS_MODEL_ID,
  VUPS_MODELS_GROUP,
  buildCatalog,
  chatReference,
  fallbackRow,
  gatewayStatusLabel,
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

function sharedModel(id, { vision = false, free = true } = {}) {
  return { id, name: id, available: true, free, vision };
}

function sharedStatus(models) {
  return { enabled: true, available: true, model: models[0]?.id || "", models };
}

function gatewayModel(id, { provider = "OmniRoute", source = OMNIROUTE_SOURCE, vision = null } = {}) {
  return {
    id,
    name: id,
    ownedBy: "OmniRoute gateway",
    provider,
    source,
    gateway: true,
    shared: false,
    saved: false,
    vision
  };
}

function omnirouteStatus(overrides = {}) {
  return {
    provider: "OmniRoute",
    enabled: true,
    configured: true,
    available: true,
    status: "available",
    modelCount: 2,
    ...overrides
  };
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

test("model capability metadata drives picker labels and vision flags", () => {
  const known = {
    ...savedModel("cfg-a", "vision-model"),
    capabilities: { vision: true, tools: true, reasoning: true, contextLength: 128000 }
  };
  const unknown = savedModel("cfg-b", "unknown-model");
  const catalog = buildCatalog({ models: [known, unknown], shared: null });
  const vision = catalog.find((row) => row.model === "vision-model");
  const other = catalog.find((row) => row.model === "unknown-model");
  assert.deepEqual(vision.capabilityLabels, ["Vision", "Tools", "Reasoning"]);
  assert.equal(vision.vision, true);
  assert.deepEqual(other.capabilityLabels, []);
  assert.equal(other.vision, null);
});

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

test("explicitly allowlisted paid shared models are labeled and never marked free", () => {
  const catalog = buildCatalog({
    models: [{ id: "paid/alpha", name: "Paid Alpha", ownedBy: "Shared", shared: true, vision: false, free: false }],
    shared: sharedStatus([sharedModel("free/alpha"), sharedModel("paid/alpha", { free: false })])
  });
  const paid = catalog.find((row) => row.model === "paid/alpha");
  assert.equal(paid.group, SHARED_PAID_GROUP);
  assert.equal(paid.free, false);
  assert.equal(paid.tag, "Paid - shared server key");
  assert.match(paid.meta, /Paid model on the shared key/);
  assert.deepEqual(chatReference(paid), { model: "paid/alpha" });
  const free = catalog.find((row) => row.model === "free/alpha");
  assert.equal(free.group, SHARED_GROUP);
  assert.equal(free.free, true);
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

test("OpenCode restricted free models are shown as unavailable with a clear reason", () => {
  const entry = savedModel("cfg-zen", "deepseek-v4.1-flash-free", { provider: "OpenCode Zen", providerId: "opencode-zen" });
  entry.free = true;
  entry.restrictedProvider = true;
  const catalog = buildCatalog({ models: [entry], shared: null });
  const row = catalog[0];
  assert.equal(row.disabled, true);
  assert.match(row.tag, /OpenCode client only/);
  assert.match(row.tag, /not usable from VupsRouter/);
  assert.deepEqual(chatReference(row), {});
});

test("OpenRouter free models stay selectable and are labeled without being disabled", () => {
  const entry = savedModel("cfg-or", "free/alpha:free", { provider: "OpenRouter", providerId: "openrouter" });
  entry.free = true;
  const catalog = buildCatalog({ models: [entry], shared: null });
  const row = catalog[0];
  assert.equal(row.free, true);
  assert.equal(row.disabled, undefined);
  assert.match(row.tag, /Free model/);
  assert.ok(!/OpenCode client only/.test(row.tag));
  assert.deepEqual(chatReference(row), { model: "free/alpha:free", configId: "cfg-or", providerId: "openrouter" });
});

test("a personal OmniRoute provider stays saved and never becomes the shared gateway", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-omni", "gpt-4o-mini", { provider: "OmniRoute", providerId: "omniroute" })],
    shared: null,
    omniroute: omnirouteStatus()
  });
  const saved = catalog.find((row) => row.configId === "cfg-omni");
  assert.ok(saved, "personal OmniRoute model is missing");
  assert.equal(saved.group, PERSONAL_GROUP);
  assert.notEqual(saved.gateway, true);
  assert.equal(saved.source, undefined);
  assert.deepEqual(chatReference(saved), { model: "gpt-4o-mini", configId: "cfg-omni", providerId: "omniroute" });
  assert.equal(catalog.some((row) => row.gateway === true), false);
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

test("chat requests carry configId and provider identity only for saved rows", () => {
  const saved = buildCatalog({ models: [savedModel("cfg-a", "deepseek-chat")], shared: null })[0];
  const free = buildCatalog({ models: [], shared: sharedStatus([sharedModel("gemma3:4b")]) })[0];
  assert.deepEqual(chatReference(saved), { model: "deepseek-chat", configId: "cfg-a", providerId: "deepseek" });
  assert.deepEqual(chatReference(free), { model: "gemma3:4b" });
});

test("Vups v3 Galax is the built-in free default above user keys", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")]),
    vups: true
  });
  assert.equal(catalog[0].group, VUPS_MODELS_GROUP);
  const vups = catalog.find((row) => row.vups);
  assert.equal(vups.group, VUPS_MODELS_GROUP);
  assert.equal(vups.model, VUPS_MODEL_ID);
  assert.equal(vups.name, "Vups v3 Galax");
  assert.equal(vups.badge, "Pro");
  assert.equal(vups.tag, undefined);
  assert.equal(vups.meta, "First-party model");
  assert.equal(vups.free, true);
  assert.ok(!vups.configId, "built-in Vups has no user provider identity");
  assert.deepEqual(vups.capabilityChips, VUPS_CAPABILITIES);
  assert.deepEqual(VUPS_CAPABILITIES, [
    "Full-stack developer",
    "Motion design",
    "CSS design",
    "Image reading",
    "Complex problem solving"
  ]);
  assert.ok(catalog.some((row) => row.saved), "user-key models remain available");
  assert.equal(fallbackRow(catalog).vups, true);
  assert.deepEqual(chatReference(vups), { model: VUPS_MODEL_ID, vups: true });
});

test("Vups selection storage is versioned and preserves explicit non-default choices", () => {
  const storage = fakeStorage();
  assert.equal(loadStoredSelection(storage), null, "a new visitor gets the Vups fallback, not a written key");
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")]),
    vups: true
  });
  const vups = catalog.find((row) => row.vups);
  saveStoredSelection(selectionFromRow(vups), storage);
  assert.deepEqual(loadStoredSelection(storage), { kind: "vups", model: VUPS_MODEL_ID });
  assert.ok(!/sk-|apiKey|encrypted|https?:/i.test(storage.dump()));

  const savedSelection = { kind: "saved", configId: "cfg-a", model: "deepseek-chat" };
  const resolved = resolveSelection(catalog, savedSelection);
  assert.equal(resolved.configId, "cfg-a");
  assert.equal(resolved.vups, undefined, "an explicit saved choice is not replaced by the default");
});

test("gateway models appear in their own group without replacing saved or free rows", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "deepseek-chat"),
      gatewayModel("openai/gpt-5.2"),
      gatewayModel("anthropic/claude-sonnet-4-6")
    ],
    shared: sharedStatus([sharedModel("gemma3:4b")]),
    omniroute: omnirouteStatus()
  });
  const gateway = catalog.filter((row) => row.gateway);
  assert.equal(gateway.length, 2);
  assert.deepEqual(gateway.map((row) => row.group), [GATEWAY_GROUP, GATEWAY_GROUP]);
  assert.ok(gateway.every((row) => row.source === OMNIROUTE_SOURCE));
  assert.ok(gateway.every((row) => row.configId === ""), "gateway rows never reference a saved configuration");
  assert.ok(catalog.some((row) => row.saved), "saved rows survive");
  assert.ok(catalog.some((row) => row.shared), "free rows survive");
});

test("a gateway model already offered for free is not repeated", () => {
  const catalog = buildCatalog({
    models: [gatewayModel("gemma3:4b"), gatewayModel("openai/gpt-5.2")],
    shared: sharedStatus([sharedModel("gemma3:4b")]),
    omniroute: omnirouteStatus()
  });
  assert.deepEqual(catalog.filter((row) => row.gateway).map((row) => row.model), ["openai/gpt-5.2"]);
  assert.deepEqual(catalog.filter((row) => row.shared).map((row) => row.model), ["gemma3:4b"]);
});

test("a gateway selection resolves to a source-only chat reference", () => {
  const catalog = buildCatalog({
    models: [gatewayModel("openai/gpt-5.2"), gatewayModel("anthropic/claude-sonnet-4-6")],
    shared: null,
    omniroute: omnirouteStatus()
  });
  const row = resolveSelection(catalog, { kind: "gateway", source: OMNIROUTE_SOURCE, model: "openai/gpt-5.2" });
  assert.ok(row);
  assert.equal(row.gateway, true);
  assert.deepEqual(chatReference(row), { model: "openai/gpt-5.2", source: "omniroute" });
  assert.equal(resolveSelection(catalog, { kind: "gateway", source: OMNIROUTE_SOURCE, model: "unknown/model" }), null);

  const storage = fakeStorage();
  saveStoredSelection({ kind: "gateway", source: OMNIROUTE_SOURCE, model: "openai/gpt-5.2" }, storage);
  assert.deepEqual(loadStoredSelection(storage), {
    kind: "gateway",
    source: "omniroute",
    model: "openai/gpt-5.2"
  });
  assert.ok(!/sk-|apiKey|encrypted|https?:/i.test(storage.dump()), "gateway storage must not contain keys or URLs");
});

test("an intended but unavailable gateway adds exactly one disabled status row", () => {
  const catalog = buildCatalog({
    models: [],
    shared: null,
    omniroute: omnirouteStatus({ available: false, status: "unauthorized" })
  });
  assert.equal(catalog.length, 1);
  const row = catalog[0];
  assert.equal(row.group, GATEWAY_GROUP);
  assert.equal(row.disabled, true);
  assert.equal(row.gateway, true);
  assert.equal(row.model, "");
  assert.match(row.tag, /rejected/i);
  assert.deepEqual(chatReference(row), {}, "a disabled status row must never produce a chat reference");
  assert.equal(fallbackRow(catalog), null, "the fallback must skip the disabled status row");
  assert.equal(resolveSelection(catalog, { kind: "gateway", source: OMNIROUTE_SOURCE, model: "any" }), null);

  const withRows = buildCatalog({
    models: [gatewayModel("openai/gpt-5.2")],
    shared: null,
    omniroute: omnirouteStatus({ available: false, status: "timeout" })
  });
  assert.equal(withRows.length, 1);
  assert.equal(withRows[0].disabled, undefined, "real gateway rows are used instead of a status row");
  assert.equal(withRows[0].gateway, true);
});

test("a disabled or unconfigured gateway adds no rows at all", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "deepseek-chat")],
    shared: sharedStatus([sharedModel("gemma3:4b")]),
    omniroute: omnirouteStatus({ enabled: false, configured: false, available: false, status: "disabled" })
  });
  assert.equal(catalog.filter((row) => row.gateway).length, 0);
  assert.deepEqual(groups(catalog), [PERSONAL_GROUP, SHARED_GROUP]);
});

test("gateway status labels are human-readable for every upstream state", () => {
  assert.match(gatewayStatusLabel({ status: "unauthorized" }), /rejected/i);
  assert.match(gatewayStatusLabel({ status: "not_configured" }), /not configured/i);
  assert.match(gatewayStatusLabel({ status: "disabled" }), /disabled/i);
  assert.match(gatewayStatusLabel({ status: "timeout" }), /timed out/i);
  assert.match(gatewayStatusLabel({ status: "empty" }), /no models/i);
  assert.match(gatewayStatusLabel({ status: "unreachable" }), /unreachable/i);
});

test("custom model type keeps Vups, saved providers, and gateways but hides free catalogue rows", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "deepseek-chat"),
      { id: "gateway-model", name: "Gateway Model", source: OMNIROUTE_SOURCE, provider: "OmniRoute" }
    ],
    shared: sharedStatus([sharedModel("shared-free")]),
    omniroute: omnirouteStatus({ enabled: true, configured: true, available: true }),
    vups: true,
    modelType: CUSTOM_MODEL_TYPE,
    freeCatalog: {
      models: [
        { id: "shared-free", name: "Shared Free", shared: true, free: true },
        { id: "catalog-only", name: "Catalog Only", configId: "cfg-a", provider: "DeepSeek", free: true }
      ]
    }
  });
  assert.ok(catalog.some((row) => row.vups));
  assert.ok(catalog.some((row) => row.configId === "cfg-a" && row.model === "deepseek-chat"));
  assert.ok(catalog.some((row) => row.gateway));
  assert.equal(catalog.some((row) => row.model === "shared-free"), false);
  assert.equal(catalog.some((row) => row.model === "catalog-only"), false);
});

test("free model type shows only Vups and verified free rows, grouped as free", () => {
  const catalog = buildCatalog({
    models: [
      savedModel("cfg-a", "catalog-only"),
      savedModel("cfg-a", "paid-saved"),
      { id: "gateway-model", name: "Gateway Model", source: OMNIROUTE_SOURCE, provider: "OmniRoute" }
    ],
    shared: sharedStatus([sharedModel("shared-free"), sharedModel("shared-paid", { free: false })]),
    omniroute: omnirouteStatus({ enabled: true, configured: true, available: true }),
    vups: true,
    modelType: FREE_MODEL_TYPE,
    freeCatalog: {
      models: [
        { id: "shared-free", name: "Shared Free", shared: true, free: true },
        { id: "catalog-only", name: "Catalog Only", configId: "cfg-a", provider: "DeepSeek", free: true, freeSource: "provider_pricing" }
      ]
    }
  });
  assert.ok(catalog.some((row) => row.vups));
  assert.ok(catalog.some((row) => row.model === "shared-free"));
  const personal = catalog.find((row) => row.model === "catalog-only");
  assert.ok(personal);
  assert.equal(personal.configId, "cfg-a");
  assert.equal(personal.free, true);
  assert.equal(personal.group, SHARED_GROUP);
  assert.equal(catalog.some((row) => row.model === "paid-saved"), false);
  assert.equal(catalog.some((row) => row.model === "shared-paid"), false);
  assert.equal(catalog.some((row) => row.gateway), false);
});

test("a catalogue-only personal free model routes to its exact saved provider configuration", () => {
  const catalog = buildCatalog({
    models: [],
    vups: false,
    modelType: FREE_MODEL_TYPE,
    freeCatalog: {
      models: [{ id: "free-model", name: "Free Model", configId: "cfg-free", provider: "Provider A", free: true }]
    }
  });
  assert.equal(catalog.length, 1);
  const reference = chatReference(catalog[0]);
  assert.deepEqual(reference, { model: "free-model", configId: "cfg-free", providerId: undefined });
  assert.equal(resolveSelection(catalog, selectionFromRow(catalog[0]))?.model, "free-model");
});

test("a personal catalogue row that is already saved is not duplicated", () => {
  const catalog = buildCatalog({
    models: [{ ...savedModel("cfg-a", "free-saved"), free: true }],
    vups: false,
    modelType: FREE_MODEL_TYPE,
    freeCatalog: {
      models: [{ id: "free-saved", configId: "cfg-a", provider: "DeepSeek", free: true }]
    }
  });
  assert.equal(catalog.filter((row) => row.model === "free-saved").length, 1);
  assert.equal(catalog[0].key.startsWith("saved:"), true);
});

test("missing catalogue metadata cannot turn a model into free by name alone", () => {
  const catalog = buildCatalog({
    models: [savedModel("cfg-a", "totally-free-model")],
    vups: false,
    modelType: FREE_MODEL_TYPE,
    freeCatalog: null
  });
  assert.equal(catalog.length, 0);
});
