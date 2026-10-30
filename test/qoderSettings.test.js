import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helpers = await import(pathToFileURL(path.join(root, "src", "settings", "qoderForm.js")).href);
const pageSource = readFileSync(path.join(root, "src", "SettingsPage.jsx"), "utf8").replace(/\r\n/g, "\n");
const registrySource = readFileSync(path.join(root, "src", "providers", "registry.js"), "utf8").replace(/\r\n/g, "\n");

test("both documented Qoder regions resolve from business and OpenAPI hosts", () => {
  assert.equal(helpers.qoderRegionFor("https://api.qoder.com/api/v1/cloud"), "global");
  assert.equal(helpers.qoderRegionFor("https://www.api.qoder.com/api/v1/cloud"), "global");
  assert.equal(helpers.qoderRegionFor("https://openapi.qoder.sh"), "global");
  assert.equal(helpers.qoderRegionFor("https://api.qoder.com.cn/api/v1/cloud"), "cn");
  assert.equal(helpers.qoderRegionFor("https://openapi.qoder.com.cn"), "cn");
  assert.equal(helpers.qoderRegionFor("https://qoder-proxy.example.com/api/v1/cloud"), "custom");
  assert.equal(helpers.qoderRegionFor(""), "global");
});

test("region presets pair each business endpoint with its own OpenAPI host", () => {
  const global = helpers.QODER_REGIONS.find(region => region.id === "global");
  const cn = helpers.QODER_REGIONS.find(region => region.id === "cn");
  assert.equal(global.businessUrl, "https://api.qoder.com/api/v1/cloud");
  assert.equal(global.openapiUrl, "https://openapi.qoder.sh");
  assert.equal(cn.businessUrl, "https://api.qoder.com.cn/api/v1/cloud");
  assert.equal(cn.openapiUrl, "https://openapi.qoder.com.cn");
});

test("editing the endpoint, protocol, auth mode, or OpenAPI host invalidates a saved result", () => {
  const saved = {
    baseUrl: "https://api.qoder.com/api/v1/cloud",
    providerType: "qoder_cloud_agents",
    authMode: "pat",
    openapiBaseUrl: "https://openapi.qoder.sh"
  };
  const base = { ...saved };
  assert.equal(helpers.formDiffersFromSaved(base, saved), false);
  assert.equal(helpers.formDiffersFromSaved({ ...base, baseUrl: "https://api.qoder.com.cn/api/v1/cloud" }, saved), true);
  assert.equal(helpers.formDiffersFromSaved({ ...base, authMode: "service_account" }, saved), true);
  assert.equal(helpers.formDiffersFromSaved({ ...base, openapiBaseUrl: "https://openapi.qoder.com.cn" }, saved), true);
  assert.equal(helpers.formDiffersFromSaved({ ...base, providerType: "openai_compatible" }, saved), true);
  assert.equal(helpers.formDiffersFromSaved(null, saved), false);
  assert.equal(helpers.formDiffersFromSaved(base, null), false);
});

test("trailing slashes and blank values do not count as edits", () => {
  const saved = {
    baseUrl: "https://api.qoder.com/api/v1/cloud/",
    providerType: "qoder_cloud_agents",
    authMode: "service_account",
    openapiBaseUrl: "https://openapi.qoder.sh/"
  };
  assert.equal(
    helpers.formDiffersFromSaved(
      {
        baseUrl: "https://api.qoder.com/api/v1/cloud",
        providerType: "qoder_cloud_agents",
        authMode: "service_account",
        openapiBaseUrl: "https://openapi.qoder.sh"
      },
      saved
    ),
    false
  );
  const legacy = { baseUrl: "https://api.example.com/v1", providerType: "openai_compatible" };
  assert.equal(
    helpers.formDiffersFromSaved({ ...legacy, authMode: "service_account", openapiBaseUrl: "https://openapi.qoder.sh" }, legacy),
    false,
    "non-Qoder providers ignore Qoder-only fields"
  );
});

test("the settings form sends the Qoder mode and OpenAPI host on save, test, and model test", () => {
  const saveBlock = pageSource.slice(pageSource.indexOf("async function handleSave"), pageSource.indexOf("async function handleTest"));
  assert.match(saveBlock, /buildProviderSavePayload\(\{ form, providerId, selectedModels, defaultModel \}\)/);
  const formSource = readFileSync(path.join(root, "src", "settings", "modelForm.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(formSource, /payload\.authMode = form\?\.authMode \|\| "pat"/);
  assert.match(formSource, /payload\.openapiBaseUrl = String\(form\?\.openapiBaseUrl \|\| ""\)\.trim\(\)/);
  assert.match(formSource, /if \(payload\.providerType === "qoder_cloud_agents"\)/);
  const testBlock = pageSource.slice(pageSource.indexOf("async function handleTest("), pageSource.indexOf("async function handleTestModel"));
  assert.match(testBlock, /authMode: form\.authMode \|\| "pat"/);
  assert.match(testBlock, /openapiBaseUrl: form\.openapiBaseUrl\.trim\(\)/);
  const modelBlock = pageSource.slice(pageSource.indexOf("async function handleTestModel"), pageSource.indexOf("async function handleSavedModelTest"));
  assert.match(modelBlock, /authMode: form\.authMode \|\| "pat"/);
  assert.match(modelBlock, /openapiBaseUrl: form\.openapiBaseUrl\.trim\(\)/);
});

test("saved Qoder settings are restored into the form", () => {
  assert.match(pageSource, /authMode: provider\?\.authMode \|\| "pat"/);
  assert.match(pageSource, /openapiBaseUrl: provider\?\.openapiBaseUrl \|\| ""/);
  assert.match(pageSource, /authMode: savedConfig\.authMode \|\| current\.authMode/);
  assert.match(pageSource, /openapiBaseUrl: savedConfig\.openapiBaseUrl \?\? current\.openapiBaseUrl/);
});

test("the form exposes region and authentication selectors for Qoder only", () => {
  assert.match(pageSource, /label="Qoder region"/);
  assert.match(pageSource, /label="Qoder authentication"/);
  assert.match(pageSource, /label="Qoder OpenAPI base URL"/);
  assert.match(pageSource, /isQoderForm &&/);
  assert.match(pageSource, /applyQoderRegion/);
});

test("unsaved edits replace a stale saved test result in the UI", () => {
  assert.match(pageSource, /formDirty && savedProvider\?\.lastTest/);
  assert.match(pageSource, /Unsaved changes — retest needed/);
  assert.match(pageSource, /label: "Last test: authentication failed"/);
  assert.match(pageSource, /label: "Last test: permission or scope insufficient"/);
  assert.match(pageSource, /label: "Last test: endpoint and region do not match"/);
  assert.match(pageSource, /label: "Last test: endpoint not found — check region and base URL"/);
  assert.match(pageSource, /label: "Last test: invalid response from Qoder"/);
  assert.match(pageSource, /label: "Last test: rate limited — try again shortly"/);
  assert.match(pageSource, /label: "Last test: Qoder service unavailable"/);
  assert.match(pageSource, /label: "Last test: network or DNS error"/);
  assert.match(pageSource, /label: "Last test: timed out"/);
});

test("Qoder help text names both regions and both authentication modes", () => {
  const help = pageSource.slice(pageSource.indexOf('if (type === "qoder_cloud_agents")'), pageSource.indexOf('if (type === "local_gateway")'));
  assert.match(help, /Global/);
  assert.match(help, /China mainland/);
  assert.match(help, /Personal Access Token/);
  assert.match(help, /service account key/);
  assert.match(help, /short-lived access token/);
  assert.doesNotMatch(help, /keep the base URL https:\/\/api\.qoder\.com/);
});

test("the provider directory describes both Qoder regions and auth modes", () => {
  const entry = registrySource.slice(registrySource.indexOf('id: "qoder"'), registrySource.indexOf("// ─── Direct model providers"));
  assert.match(entry, /api\.qoder\.com\.cn/);
  assert.match(entry, /openapi\.qoder\.sh/);
  assert.match(entry, /service account key/);
});

test("a saved card shows the stored failure sentence, not only its label", () => {
  assert.match(pageSource, /provider\.lastTest && provider\.lastTest\.status !== "connected" && provider\.lastTest\.message/);
  assert.match(pageSource, /<p className="settings-provider-issue">\{provider\.lastTest\.message\}<\/p>/);
});

test("the Qoder help text describes one session per conversation", () => {
  const help = pageSource.slice(pageSource.indexOf('if (type === "qoder_cloud_agents")'), pageSource.indexOf('if (type === "local_gateway")'));
  assert.match(help, /One chat conversation keeps one Qoder session/);
  assert.doesNotMatch(help, /Each chat message starts a new Qoder session/, "the adapter reuses the session");
});
