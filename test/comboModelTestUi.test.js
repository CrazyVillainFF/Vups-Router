import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiClient } from "../src/services/api.js";
import { ComboApiError, comboTestTimeoutMs, testComboModel } from "../src/combo/comboApi.js";
import {
  WORKING_MODELS_FILTER,
  filterModels,
  isWorkingModelsFilter,
  libraryEmptyMessage,
  statusFor
} from "../src/combo/comboSelection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const comboPage = read("src/combo/ComboPage.jsx");
const comboCss = read("src/combo/combo.css");

const originalBase = apiClient.defaults.baseURL;
const originalAdapter = apiClient.defaults.adapter;
test.afterEach(() => {
  apiClient.defaults.baseURL = originalBase;
  apiClient.defaults.adapter = originalAdapter;
});

function models() {
  return [
    { key: "saved:a:gpt-4o", kind: "saved", model: "gpt-4o", provider: "OpenAI", label: "GPT-4o", vision: true },
    { key: "saved:a:gpt-4o-mini", kind: "saved", model: "gpt-4o-mini", provider: "OpenAI", label: "GPT-4o mini", vision: false },
    { key: "saved:b:llama", kind: "saved", model: "llama", provider: "Ollama", label: "Llama", vision: false },
    { key: "shared:deepseek", kind: "shared", model: "deepseek", provider: "OpenRouter", label: "DeepSeek", vision: false }
  ];
}

function availability(rows) {
  return new Map(rows.map(entry => [entry.key, entry]));
}

const VERIFIED = availability([
  { key: "saved:a:gpt-4o", status: "working" },
  { key: "saved:b:llama", status: "not_working" }
]);

test("the Working Models view keeps only models a real check proved", () => {
  const working = filterModels(models(), { workingOnly: true, availability: VERIFIED });
  assert.deepEqual(working.map(model => model.key), ["saved:a:gpt-4o"]);
  // gpt-4o-mini and deepseek were never checked; llama was checked and failed.
  // Neither group is allowed to look like a verified model.
  assert.ok(!working.some(model => model.key === "saved:a:gpt-4o-mini"));
  assert.ok(!working.some(model => model.key === "shared:deepseek"));
  assert.ok(!working.some(model => model.key === "saved:b:llama"));
});

test("a model with no availability record reads as unknown, never as working", () => {
  assert.equal(statusFor(VERIFIED, "shared:deepseek"), "unknown");
  assert.equal(statusFor(new Map(), "saved:a:gpt-4o"), "unknown");
  assert.equal(filterModels(models(), { workingOnly: true, availability: new Map() }).length, 0);
});

test("Working Models composes with search and with a provider, and All providers restores the list", () => {
  const all = filterModels(models(), {});
  assert.equal(all.length, 4);

  const searched = filterModels(models(), { query: "gpt", workingOnly: true, availability: VERIFIED });
  assert.deepEqual(searched.map(model => model.key), ["saved:a:gpt-4o"]);

  const noMatch = filterModels(models(), { query: "deepseek", workingOnly: true, availability: VERIFIED });
  assert.deepEqual(noMatch, [], "a working-only search must not fall back to unverified models");

  const byProvider = filterModels(models(), { provider: "Ollama" });
  assert.deepEqual(byProvider.map(model => model.key), ["saved:b:llama"]);

  const restored = filterModels(models(), { provider: "" });
  assert.equal(restored.length, all.length);
});

test("a provider filter keeps its old meaning when the availability map is supplied", () => {
  const withMap = filterModels(models(), { provider: "OpenAI", availability: VERIFIED });
  assert.deepEqual(withMap.map(model => model.key), ["saved:a:gpt-4o", "saved:a:gpt-4o-mini"]);
});

test("the Working option is a filter sentinel, not a provider name", () => {
  assert.equal(isWorkingModelsFilter(WORKING_MODELS_FILTER), true);
  assert.equal(isWorkingModelsFilter("OpenAI"), false);
  assert.equal(isWorkingModelsFilter(""), false);
  assert.equal(isWorkingModelsFilter(undefined), false);
});

test("the empty library says which filter produced it", () => {
  assert.match(libraryEmptyMessage({ workingOnly: true }), /Run Test/);
  assert.match(libraryEmptyMessage({ workingOnly: true, query: "zzz" }), /match this search/);
  assert.equal(libraryEmptyMessage({ query: "zzz" }), "No models match this search or filter.");
  assert.equal(libraryEmptyMessage({}), "No models match this filter.");
});

test("the client waits out the configured probe and never cuts it short early", () => {
  assert.equal(comboTestTimeoutMs(20000), 35000);
  assert.equal(comboTestTimeoutMs(5000), 20000);
  assert.equal(comboTestTimeoutMs(60000), 75000);
  assert.equal(comboTestTimeoutMs(120000), 75000, "an out-of-range setting is clamped, not trusted");
  assert.equal(comboTestTimeoutMs("nonsense"), 35000);
});

test("testComboModel posts only the model key to the test endpoint", async () => {
  const calls = [];
  apiClient.defaults.baseURL = "http://backend.test/api";
  apiClient.defaults.adapter = async config => {
    calls.push(config);
    return { data: { model: { key: "saved:a:gpt-4o", status: "working" } }, status: 200, headers: {}, config };
  };

  const data = await testComboModel({ key: "saved:a:gpt-4o", timeoutMs: 35000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "post");
  assert.match(calls[0].url, /\/combo\/test$/);
  assert.deepEqual(JSON.parse(calls[0].data), { key: "saved:a:gpt-4o" });
  assert.equal(calls[0].timeout, 35000);
  assert.equal(data.model.status, "working");
});

test("testComboModel passes the abort signal so a stopped test stops", async () => {
  const controller = new AbortController();
  apiClient.defaults.baseURL = "http://backend.test/api";
  apiClient.defaults.adapter = async config => {
    assert.equal(config.signal, controller.signal);
    const error = new Error("canceled");
    error.name = "CanceledError";
    error.code = "ERR_CANCELED";
    throw error;
  };
  await assert.rejects(
    () => testComboModel({ key: "k", signal: controller.signal }),
    error => error.code === "ERR_CANCELED"
  );
});

test("a client-side timeout is reported as a stopped test, not as a model verdict", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  apiClient.defaults.adapter = async () => {
    const error = new Error("timeout of 35000ms exceeded");
    error.code = "ECONNABORTED";
    throw error;
  };
  await assert.rejects(
    () => testComboModel({ key: "k" }),
    error => {
      assert.ok(error instanceof ComboApiError);
      assert.equal(error.code, "test_timeout");
      assert.match(error.message, /status is unchanged/);
      return true;
    }
  );
});

test("a provider failure keeps the server message and code", async () => {
  apiClient.defaults.baseURL = "http://backend.test/api";
  apiClient.defaults.adapter = async config => {
    const response = { status: 404, data: { message: "That model is no longer in your catalog.", code: "model_not_found" } };
    const error = new Error("Request failed with status code 404");
    error.response = response;
    error.config = config;
    throw error;
  };
  await assert.rejects(
    () => testComboModel({ key: "gone" }),
    error => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "model_not_found");
      assert.match(error.message, /no longer in your catalog/);
      return true;
    }
  );
});

// ---- page wiring -----------------------------------------------------------------
// These assertions read the real component source: the suite has no DOM, so the
// checks are limited to what a source read can prove without restating the markup.

test("every model row carries a Test control and a four-state status", () => {
  assert.match(comboPage, /className="combo-test"/);
  assert.match(comboPage, /onTest=\{testModel\}/);
  assert.match(comboPage, /testing \? "Testing" : statusLabel\(status\)/);
  assert.match(comboPage, /Stop the test for/);
  assert.match(comboPage, /Test \$\{modelTitle\(model\)\}/);
});

test("a test cannot change the selection, the chat model, or start a Combo run", () => {
  const body = comboPage.slice(comboPage.indexOf("function testModel"), comboPage.indexOf("useEffect(() => {\n    if (phase !== \"ready\""));
  assert.ok(body.length > 200, "the test handler should be readable in the source");
  assert.ok(!/setSelected\(/.test(body), "a test must not touch the selection");
  assert.ok(!/persistSelection/.test(body), "a test must not save a selection");
  assert.ok(!/streamComboChat/.test(body), "a test must not start orchestration");
  assert.match(body, /testComboModel\(/);
});

test("a result that names no status is refused instead of invented", () => {
  assert.match(comboPage, /result\?\.status !== "working" && result\?\.status !== "not_working"/);
  assert.match(comboPage, /without reporting a model status/);
});

test("duplicate tests on a row become a stop, and results merge into availability", () => {
  assert.match(comboPage, /if \(stopModelTest\(model\)\) return;/);
  assert.match(comboPage, /testControllers\.current\.set\(key, controller\)/);
  assert.match(comboPage, /next\.set\(key, \{/);
  assert.match(comboPage, /controller\.abort\(\)/);
});

test("the filter select offers All providers, Working Models, then the providers", () => {
  const all = comboPage.indexOf('<option value="">All providers</option>');
  const working = comboPage.indexOf("<option value={WORKING_MODELS_FILTER}>Working Models</option>");
  const perProvider = comboPage.indexOf("{providers.map(option =>");
  assert.ok(all >= 0 && working > all && perProvider > working, "Working Models must sit between All providers and the providers");
  assert.match(comboPage, /aria-label="Filter models by provider or status"/);
});

test("the working filter is applied to the same list the search and Vision toggle use", () => {
  const memo = comboPage.slice(comboPage.indexOf("const workingOnly = isWorkingModelsFilter"), comboPage.indexOf("function focusProviderInLibrary"));
  assert.match(memo, /workingOnly,\n\s+availability: displayAvailability/);
  assert.match(memo, /visionOnly \? list\.filter\(model => model\.vision === true\)/);
  assert.equal((comboPage.match(/filterModels\(/g) || []).length, 1, "the library must filter in exactly one place");
});

test("a test result is announced outside the canvas", () => {
  assert.match(comboPage, /role="status" aria-live="polite"/);
  assert.match(comboPage, /className="combo-test-notice"/);
  assert.match(comboPage, /is Working\./);
});

test("the Test control has mobile sizing and stops spinning under reduced motion", () => {
  const mobile = comboCss.slice(comboCss.indexOf("@media (max-width: 980px)"));
  assert.match(mobile, /\.combo-test \{\s*\n\s*min-width: 58px;\s*\n\s*height: 44px;/);
  const reduced = comboCss.slice(comboCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.combo-spin \{\s*\n\s*animation: none;/);
});
