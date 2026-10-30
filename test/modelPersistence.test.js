import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpers = await import(pathToFileURL(path.join(root, "src", "settings", "modelForm.js")).href);
const pageSource = readFileSync(path.join(root, "src", "SettingsPage.jsx"), "utf8").replace(/\r\n/g, "\n");

function qoderForm(overrides = {}) {
  return {
    provider: "Qoder Cloud",
    baseUrl: "https://api.qoder.com/api/v1/cloud",
    apiKey: "",
    model: "qfmodel",
    providerType: "qoder_cloud_agents",
    authMode: "service_account",
    openapiBaseUrl: "https://openapi.qoder.sh",
    ...overrides
  };
}

test("a save without a new key never asks the server to erase the stored one", () => {
  const payload = helpers.buildProviderSavePayload({
    form: qoderForm({ apiKey: "   " }),
    providerId: "qoder-cloud",
    selectedModels: ["qfmodel", "dfmodel"],
    defaultModel: "dfmodel"
  });
  assert.equal(payload.apiKey, "");
  assert.deepEqual(payload.models, ["qfmodel", "dfmodel"]);
  assert.equal(payload.defaultModel, "dfmodel");
  assert.equal(payload.providerId, "qoder-cloud", "the stable slug travels with the save");
});

test("an empty selection is omitted so discovery cannot be overwritten by a save", () => {
  const payload = helpers.buildProviderSavePayload({
    form: qoderForm(),
    providerId: "qoder-cloud",
    selectedModels: [],
    defaultModel: ""
  });
  assert.equal("models" in payload, false);
  assert.equal("defaultModel" in payload, false);
});

test("the default falls back to a saved model instead of pointing outside the catalogue", () => {
  const payload = helpers.buildProviderSavePayload({
    form: qoderForm(),
    providerId: "qoder-cloud",
    selectedModels: [" qfmodel ", "qfmodel", "", "dfmodel"],
    defaultModel: "removed-model"
  });
  assert.deepEqual(payload.models, ["qfmodel", "dfmodel"], "blank and duplicate IDs are dropped");
  assert.equal(payload.defaultModel, "qfmodel");
});

test("Qoder keeps its token mode and region; other providers do not send them", () => {
  const qoder = helpers.buildProviderSavePayload({
    form: qoderForm(),
    providerId: "qoder-cloud",
    selectedModels: ["qfmodel"],
    defaultModel: "qfmodel"
  });
  assert.equal(qoder.authMode, "service_account");
  assert.equal(qoder.openapiBaseUrl, "https://openapi.qoder.sh");

  const other = helpers.buildProviderSavePayload({
    form: qoderForm({ providerType: "openai_compatible", authMode: "service_account", openapiBaseUrl: "https://x" }),
    providerId: "openrouter",
    selectedModels: [],
    defaultModel: ""
  });
  assert.equal("authMode" in other, false);
  assert.equal("openapiBaseUrl" in other, false);
});

test("the client caps the catalogue the same way the server does", () => {
  const many = Array.from({ length: 620 }, (_, index) => `model-${index}`);
  const payload = helpers.buildProviderSavePayload({
    form: qoderForm({ providerType: "openai_compatible" }),
    providerId: "openrouter",
    selectedModels: many,
    defaultModel: "model-0"
  });
  assert.equal(payload.models.length, helpers.MAX_SAVED_MODELS);

  const long = `${"x".repeat(201)}`;
  const trimmed = helpers.uniqueModelIds([long, "kept-model"]);
  assert.deepEqual(trimmed, ["kept-model"], "an over-long ID is never sent to be silently truncated");
});

test("model identity is scoped to the configuration, not the display name", () => {
  const first = { configId: "c1", providerId: "openrouter" };
  const second = { configId: "c2", providerId: "openrouter" };
  assert.equal(helpers.modelIdentity(first, "gpt-4o"), "c1:gpt-4o");
  assert.notEqual(helpers.modelIdentity(first, "gpt-4o"), helpers.modelIdentity(second, "gpt-4o"));
  assert.equal(helpers.modelIdentity({ providerId: "deepseek" }, "deepseek-chat"), "deepseek:deepseek-chat");
  assert.equal(helpers.modelIdentity(null, "x"), "provider:x");
});

test("a legacy single-model row still reads as one saved model", () => {
  assert.deepEqual(helpers.savedModelIds({ models: ["a", "b"], defaultModel: "b" }), ["a", "b"]);
  assert.deepEqual(helpers.savedModelIds({ models: [], defaultModel: "", model: "solo-model" }), ["solo-model"]);
  assert.deepEqual(helpers.savedModelIds({ models: null, defaultModel: "fallback-model" }), ["fallback-model"]);
  assert.deepEqual(helpers.savedModelIds(undefined), []);
});

test("the settings form reads the catalogue back from the saved configuration", () => {
  assert.match(pageSource, /buildProviderSavePayload\(\{ form, providerId, selectedModels, defaultModel \}\)/);
  assert.match(pageSource, /setSelectedModels\(savedModelIds\(existingProvider\)\)/);
  assert.match(pageSource, /if \(Array\.isArray\(savedConfig\.models\)\) \{/);
  assert.doesNotMatch(pageSource, /setSelectedModels\(current => current\.map\(/, "no in-place mutation of another provider's list");
});

test("connection and model tests never send a model catalogue", () => {
  const testBlock = pageSource.slice(pageSource.indexOf("async function handleTest()"), pageSource.indexOf("async function handleTestModel()"));
  assert.doesNotMatch(testBlock, /models:/, "a connectivity check must not rewrite the saved list");
  const modelTestBlock = pageSource.slice(
    pageSource.indexOf("async function handleTestModel()"),
    pageSource.indexOf("async function handleSavedModelTest(")
  );
  assert.doesNotMatch(modelTestBlock, /models: selectedModels/);
});

test("editing from the directory targets the active configuration of that provider", () => {
  assert.match(
    pageSource,
    /const saved = savedConfigs\.find\(provider => provider\.active\) \|\| savedConfigs\[0\];/,
    "a second key must not steal the edit target"
  );
  assert.match(pageSource, /registryEntryForSavedProvider\(provider\)\?\.id === entry\.id/);
  assert.match(pageSource, /startConfigure\(registryEntry, provider\)/);
});

test("the models editor refuses a default outside the selection", () => {
  const block = pageSource.slice(
    pageSource.indexOf("async function handleSaveModels()"),
    pageSource.indexOf("async function handleActivate(")
  );
  assert.match(block, /if \(defaultModel && !selectedModels\.includes\(defaultModel\)\)/);
});
