import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  PROVIDER_CATEGORIES,
  providerById,
  providersByCategory
} from "../src/providers/registry.js";
import {
  activateProvider,
  apiClient,
  createManagedProvider,
  fetchProviderModelsDetailed,
  listProviders,
  removeProvider,
  saveManagedProvider,
  saveProviderModels,
  testManagedProvider,
  testManagedProviderModel
} from "../src/services/api.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CATEGORY_IDS = new Set(PROVIDER_CATEGORIES.map(entry => entry.id));
const URL_FIELDS = ["baseUrl", "website", "keysUrl", "docsUrl", "pricingUrl"];

test("every provider entry has a unique, slug-safe id", () => {
  const seen = new Set();
  for (const entry of PROVIDERS) {
    assert.match(entry.id, SLUG, `bad id: ${entry.id}`);
    assert.ok(!seen.has(entry.id), `duplicate id: ${entry.id}`);
    seen.add(entry.id);
  }
});

test("every provider entry carries the fields the settings UI renders", () => {
  for (const entry of PROVIDERS) {
    assert.ok(entry.name && entry.name.length >= 2, `name missing for ${entry.id}`);
    assert.ok(CATEGORY_IDS.has(entry.category), `unknown category for ${entry.id}`);
    assert.ok(["hosted", "gateway", "local", "custom"].includes(entry.deployment), `deployment for ${entry.id}`);
    assert.ok(["openai", "anthropic", "azure", "watsonx", "other"].includes(entry.compatibility), `compatibility for ${entry.id}`);
    assert.ok(["supported", "listed"].includes(entry.status), `status for ${entry.id}`);
    assert.ok(entry.note && entry.note.length > 20, `note too short for ${entry.id}`);
    assert.ok(entry.cost && entry.cost.length > 5, `cost missing for ${entry.id}`);
  }
});

test("supported entries only promise adapters that exist", () => {
  for (const entry of PROVIDERS.filter(item => item.status === "supported")) {
    assert.ok(["openai", "anthropic", "azure", "watsonx"].includes(entry.compatibility), `${entry.id} is marked supported but needs a different adapter`);
  }
});

test("previously pending providers now resolve to a working adapter", () => {
  const expected = {
    "vercel-ai-gateway": ["openai", "https://ai-gateway.vercel.sh/v1"],
    "huggingface": ["openai", "https://router.huggingface.co/v1"],
    "cloudflare-workers-ai": ["openai", ""],
    "amazon-bedrock": ["openai", "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"],
    "azure-ai-foundry": ["azure", ""],
    "ibm-watsonx": ["watsonx", "https://us-south.ml.cloud.ibm.com"],
    "ai21": ["openai", "https://api.ai21.com/studio/v1"]
  };
  for (const [id, [compatibility, baseUrl]] of Object.entries(expected)) {
    const entry = providerById(id);
    assert.ok(entry, `${id} entry missing`);
    assert.equal(entry.status, "supported", `${id} should not show adapter pending`);
    assert.equal(entry.compatibility, compatibility, `${id} compatibility`);
    assert.equal(entry.baseUrl, baseUrl, `${id} baseUrl`);
  }
  assert.equal(PROVIDERS.filter(entry => entry.status !== "supported").length, 0);
});

test("external links are https, and base URLs are https or local http", () => {
  for (const entry of PROVIDERS) {
    for (const field of URL_FIELDS) {
      const value = entry[field];
      if (value === "") continue;
      if (field === "baseUrl" && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(value)) continue;
      assert.ok(typeof value === "string" && value.startsWith("https://"), `${entry.id}.${field} must be https`);
    }
  }
});

test("providers with a default base URL ship an absolute http(s) URL", () => {
  for (const entry of PROVIDERS.filter(item => item.baseUrl)) {
    assert.match(entry.baseUrl, /^https?:\/\//, `${entry.id}.baseUrl must be absolute`);
    assert.ok(!/\/chat\/completions\/?$/.test(entry.baseUrl), `${entry.id}.baseUrl should not include /chat/completions`);
  }
});

test("local gateway entries explain the localhost reachability rule", () => {
  for (const entry of providersByCategory("local")) {
    assert.equal(entry.deployment, "local");
    assert.match(entry.note, /localhost|tunnel|own machine/i, `${entry.id} must explain localhost limits`);
  }
});

test("FlagshipRouter is present with its documented localhost default", () => {
  const entry = providerById("flagshiprouter");
  assert.ok(entry, "flagshiprouter entry missing");
  assert.equal(entry.baseUrl, "http://localhost:20128/v1");
  assert.match(entry.note, /tunnel|localhost/i);
});

test("AgentRouter uses its documented OpenAI-compatible base URL and makes no unverified free-tier claim", () => {
  const entry = providerById("agentrouter");
  assert.ok(entry, "agentrouter entry missing");
  assert.equal(entry.category, "aggregator");
  assert.equal(entry.status, "supported");
  assert.equal(entry.compatibility, "openai");
  assert.equal(entry.baseUrl, "https://agentrouter.org/v1");
  assert.match(entry.docsUrl, /^https:\/\/www\.agentrouter\.org\/docs\//);
  assert.match(entry.cost, /no free tier is documented/i);
});

test("custom endpoints exist for both OpenAI and Anthropic shapes", () => {
  const openai = providerById("custom-openai");
  const anthropic = providerById("custom-anthropic");
  assert.equal(openai.status, "supported");
  assert.equal(openai.baseUrl, "");
  assert.equal(anthropic.compatibility, "anthropic");
  assert.equal(anthropic.status, "supported");
});

test("registry helpers return consistent subsets", () => {
  assert.equal(providerById("does-not-exist"), null);
  assert.equal(providerById("deepseek").name, "DeepSeek");
  const local = providersByCategory("local");
  assert.ok(local.length >= 5);
  assert.ok(local.every(entry => entry.category === "local"));
  assert.equal(providersByCategory("nope").length, 0);
});

function mockAdapter() {
  const requests = [];
  const originalBaseURL = apiClient.defaults.baseURL;
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.baseURL = "https://api.example.test/api";
  apiClient.defaults.adapter = async config => {
    requests.push({
      method: config.method,
      url: config.url,
      params: config.params,
      data: config.data ? JSON.parse(config.data) : undefined
    });
    return { data: { ok: true }, status: 200, statusText: "OK", headers: {}, config };
  };
  return {
    requests,
    restore() {
      apiClient.defaults.baseURL = originalBaseURL;
      apiClient.defaults.adapter = originalAdapter;
    }
  };
}

test("multi-provider API calls use the managed provider endpoints", async () => {
  const mock = mockAdapter();
  try {
    await listProviders();
    await saveManagedProvider("deepseek", { provider: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "k", model: "deepseek-chat" });
    await createManagedProvider({ providerId: "deepseek", provider: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKey: "sk-second", model: "deepseek-chat" });
    await activateProvider("deepseek");
    await testManagedProvider("deepseek", { baseUrl: "https://api.deepseek.com" });
    await testManagedProviderModel("deepseek", { model: "deepseek-chat" });
    await saveProviderModels("deepseek", { models: ["deepseek-chat"], defaultModel: "deepseek-chat" });
    await fetchProviderModelsDetailed("deepseek");
    await removeProvider("deepseek");

    assert.deepEqual(
      mock.requests.map(request => `${request.method} ${request.url}`),
      [
        "get /settings/providers",
        "put /settings/providers/deepseek",
        "post /settings/providers",
        "post /settings/providers/deepseek/activate",
        "post /settings/providers/deepseek/test",
        "post /settings/providers/deepseek/test-model",
        "put /settings/providers/deepseek/models",
        "get /settings/models",
        "delete /settings/providers/deepseek"
      ]
    );
    assert.equal(mock.requests[1].data.baseUrl, "https://api.deepseek.com");
    assert.equal(mock.requests[2].data.providerId, "deepseek");
    assert.equal(mock.requests[2].data.apiKey, "sk-second");
    assert.deepEqual(mock.requests[6].data, { models: ["deepseek-chat"], defaultModel: "deepseek-chat" });
    assert.deepEqual(mock.requests[7].params, { configId: "deepseek" });
  } finally {
    mock.restore();
  }
});

test("provider ids in API paths are URL-encoded", async () => {
  const mock = mockAdapter();
  try {
    await activateProvider("weird/id");
    assert.equal(mock.requests[0].url, "/settings/providers/weird%2Fid/activate");
  } finally {
    mock.restore();
  }
});
