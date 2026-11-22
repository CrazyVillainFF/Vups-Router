/**
 * The Combo AI Model Library: a large catalogue and a controlled checker.
 *
 * The library may hold thousands of models. Two things have to hold for that:
 * the page draws a page of models at a time rather than thousands of rows, and
 * every availability check goes through one queue with a hard ceiling, so the
 * provider is never asked more than ten questions at once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  availabilityMap,
  selectAllModels,
  statusFor
} from "../src/combo/comboSelection.js";
import { MODEL_CHECK_CONCURRENCY } from "../src/combo/modelCheckQueue.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");
const comboPage = read("src/combo/ComboPage.jsx");
const comboCss = read("src/combo/combo.css");
const comboConfig = read("src/combo/comboSelection.js");
const serverRoute = read("../server/src/routes/combo.js");
const serverConfig = read("../server/src/comboConfig.js");
const serverOrchestrator = read("../server/src/comboOrchestrator.js");
const picker = read("src/components/reactbits/PromptBar.jsx");

function libraryModel(index) {
  return {
    key: `saved:cfg-${index}:model-${index}`,
    kind: "saved",
    configId: `cfg-${index}`,
    providerId: `prov-${index}`,
    provider: "OpenAI",
    model: `model-${index}`,
    label: `Model ${index}`
  };
}

// ─── The selection has no model count ─────────────────────────────────────────

test("no stale model-count selection limit is left in the client", () => {
  assert.ok(!/COMBO_MAX_SELECTED/.test(comboConfig), "the client has no model-count constant");
  assert.ok(!/supports up to .* selected models/.test(comboPage), "the old limit message is gone");
});

test("no stale model-count selection limit is left on the server", () => {
  assert.ok(!/COMBO_MAX_SELECTED_MODELS/.test(serverConfig), "the server has no model-count constant");
  assert.ok(!/COMBO_MAX_SELECTED_MODELS/.test(serverRoute), "the request no longer counts models");
  assert.match(serverConfig, /export const COMBO_CONFIG_BODY_LIMIT = "16mb";/, "the only ceiling is the document size");
});

test("several thousand models can be selected", () => {
  const library = Array.from({ length: 3000 }, (_, index) => libraryModel(index + 1));
  const selected = selectAllModels([], library);
  assert.equal(selected.length, 3000);
  assert.equal(new Set(selected.map(entry => entry.key)).size, 3000);
});

// ─── The page browses a large catalogue ──────────────────────────────────────

test("the library scrolls inside its own panel", () => {
  assert.match(comboCss, /\.combo-layout \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(comboCss, /\.combo-panel \{[\s\S]*?overflow: hidden;/);
  assert.match(comboCss, /\.combo-list \{[\s\S]*?overflow-y: auto;/);
});

test("the page draws a page of models, never the whole library", () => {
  assert.match(comboPage, /const LIBRARY_PAGE_SIZE = 100;/);
  assert.match(comboPage, /const visibleModels = filtered\.slice\(0, LIBRARY_PAGE_SIZE\);/);
  assert.match(comboPage, /\{visibleModels\.map\(model => \{/);
  assert.ok(!/\{filtered\.map\(model => \{/.test(comboPage), "the whole library is never drawn");
});

test("the counts that matter are still shown", () => {
  const summary = comboPage.slice(
    comboPage.indexOf('className="combo-summary"'),
    comboPage.indexOf('className="combo-search"')
  );
  assert.match(summary, /data-state="total"/, "the library size");
  assert.match(summary, /data-state="selected"/, "the selected count");
  assert.match(summary, /data-state="working"/, "the working count");
  assert.match(summary, /data-state="not_working"/, "the not working count");
  assert.match(summary, /data-state="unknown"/, "the not checked count");
});

test("the redundant explanations are gone", () => {
  assert.ok(!/Selected models stay saved even when unavailable/.test(comboPage));
  assert.ok(!/combo-panel__desc/.test(comboPage));
});

// ─── Checking is bounded and shared ─────────────────────────────────────────

test("every availability check goes through one queue with a ceiling of ten", () => {
  assert.equal(MODEL_CHECK_CONCURRENCY, 10);
  assert.match(comboPage, /concurrency: MODEL_CHECK_CONCURRENCY/);
  assert.match(comboPage, /function testModel\(model\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
  assert.match(comboPage, /function testAll\(\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
  assert.match(comboPage, /function recheckSelected\(\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
});

test("Test All checks the whole library, not only the selection", () => {
  const handler = comboPage.slice(
    comboPage.indexOf("function testAll()"),
    comboPage.indexOf("function recheckSelected()")
  );
  assert.match(handler, /catalog\.keys\.length > 0 \? catalog\.keys : catalogModels\.map\(model => model\.key\)/, "every library model is a candidate");
  assert.ok(!/selectedRef\.current\.map/.test(handler), "the selection is not the scope");
  assert.match(handler, /statusFor\(displayAvailability, key\) === "unknown"/, "a model with a result is left alone");
  assert.ok(!/setSelected\(/.test(handler), "Test All does not alter the selection");
  assert.ok(!/persistSelection/.test(handler), "Test All does not save a selection");
  assert.ok(!/runComboTurn|streamChatResponse|runComboChat/.test(handler), "Test All runs no chat task");
});

test("the progress is compact and counts what is happening", () => {
  assert.match(comboPage, /Checked \$\{checkProgress\.completed\.toLocaleString\(\)\} of/);
  assert.match(comboPage, /Working: \{librarySummary\.working\.toLocaleString\(\)\}/);
  assert.match(comboPage, /Not Working: \{librarySummary\.notWorking\.toLocaleString\(\)\}/);
  assert.match(comboPage, /Checking: \{checkProgress\.active\.toLocaleString\(\)\}/);
  assert.match(comboPage, /Not Checked: \{librarySummary\.unknown\.toLocaleString\(\)\}/);
});

test("a model that nobody checked stays unchecked", () => {
  const availability = availabilityMap([
    { key: "a", status: "working", checkedAt: new Date().toISOString() },
    { key: "b", status: "unknown", checkedAt: null }
  ]);
  assert.equal(statusFor(availability, "a"), "working");
  assert.equal(statusFor(availability, "b"), "unknown", "a model nobody checked stays unchecked");
});

// ─── Untouched behaviour ────────────────────────────────────────────────────

test("the chat model picker is untouched", () => {
  assert.match(picker, /const openModelMenu = event => \{/);
  assert.match(picker, /stopPropagation\?\.\(\)/);
  assert.ok(!/Test All|Select All|MODEL_CHECK/.test(picker), "the composer knows nothing about the library");
});

test("the run still tries one model at a time, with a depth of 32", () => {
  assert.match(serverOrchestrator, /for \(let index = 0; index < working\.length; index \+= 1\)/);
  assert.match(serverOrchestrator, /const candidates = withImages/);
  assert.match(serverOrchestrator, /Math\.min\(COMBO_MAX_WORKING_MODELS, Number\(settings\.maxWorkingModels\)/);
  assert.match(serverConfig, /export const COMBO_MAX_WORKING_MODELS = 32;/);
});

test("an availability check never answers a chat", () => {
  const route = serverRoute.slice(
    serverRoute.indexOf('router.post("/availability"'),
    serverRoute.indexOf("// One in-flight test per account and model")
  );
  assert.ok(!/runComboChat/.test(route), "checking availability runs no chat");
  assert.match(route, /runAvailabilityChecks\(/, "it uses the availability engine");
  const handler = comboPage.slice(
    comboPage.indexOf("function testAll()"),
    comboPage.indexOf("function recheckSelected()")
  );
  assert.ok(!/onSend|handleSend/.test(handler), "the library never sends a message");
});

test("selecting every model still keeps each model's identity", () => {
  const library = Array.from({ length: 40 }, (_, index) => libraryModel(index + 1));
  const selected = selectAllModels([], library);
  assert.equal(selected.length, 40);
  for (const entry of selected) {
    assert.ok(entry.configId, "the provider configuration is kept");
    assert.ok(entry.providerId, "the provider id is kept");
    assert.ok(entry.model, "the model id is kept");
  }
});
