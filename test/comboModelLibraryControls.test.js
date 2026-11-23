/**
 * The Combo AI Model Library: selection controls and the selection limit.
 *
 * Four things are checked here. The Vision-only checkbox is gone from the
 * library, and the two new controls sit where it used to be. Select All takes
 * the whole library, and Unselect Not Working keeps only the models a real
 * check proved are working. And the selection limit is 1000 on both sides of
 * the wire, while the depth of a single run stays where it was.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMBO_MAX_WORKING_MODELS,
  availabilityMap,
  selectAllModels,
  selectWorkingModels,
  selectionForSave,
  statusFor,
  toggleSelectedModel,
  unselectNotWorkingModels
} from "../src/combo/comboSelection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");
const comboPage = read("src/combo/ComboPage.jsx");
const comboCss = read("src/combo/combo.css");
const comboSelection = read("src/combo/comboSelection.js");
const serverConfig = read("../server/src/comboConfig.js");
const serverRoutes = read("../server/src/routes/combo.js");
const serverOrchestrator = read("../server/src/comboOrchestrator.js");

function libraryModel(index) {
  return {
    key: `saved:cfg-${index}:model-${index}`,
    kind: "saved",
    configId: `cfg-${index}`,
    providerId: `prov-${index}`,
    provider: "OpenAI",
    model: `model-${index}`,
    label: `Model ${index}`,
    vision: index % 2 === 0
  };
}

const LIBRARY = Array.from({ length: 5 }, (_, index) => libraryModel(index + 1));

// ─── 1. Vision only is gone ─────────────────────────────────────────────────

test("the Vision only checkbox is absent from the Model Library", () => {
  assert.ok(!/Vision only/.test(comboPage), "the label is gone");
  assert.ok(!/visionOnly/.test(comboPage), "the control and its state are gone");
  assert.ok(!/setVisionOnly/.test(comboPage));
  assert.ok(!/showVisionFilter/.test(comboPage));
  assert.ok(!/combo-filter-check/.test(comboPage), "no empty wrapper is left behind");
  assert.ok(!/combo-filter-check/.test(comboCss), "the checkbox styles are gone with the element");
  assert.ok(!/hasVisionModels/.test(comboSelection), "the helper that only served it is gone");
});

test("the library keeps its search and provider filters", () => {
  assert.match(comboPage, /placeholder="Search model or provider"/);
  assert.match(comboPage, /aria-label="Filter models by provider or status"/);
  assert.match(comboPage, /<option value="">All providers<\/option>/);
  assert.match(comboPage, /<option value=\{WORKING_MODELS_FILTER\}>Working Models<\/option>/);
  assert.match(comboPage, /\{providers\.map\(option => \(/);
  assert.equal((comboPage.match(/filterModels\(/g) || []).length, 1, "the library still filters in one place");
});

// ─── 2. Select All ──────────────────────────────────────────────────────────

test("Select All selects every model in the library, unavailable ones included", () => {
  const selected = selectAllModels([], LIBRARY);
  assert.equal(selected.length, LIBRARY.length);
  assert.deepEqual(selected.map(entry => entry.key), LIBRARY.map(model => model.key));
});

test("Select All keeps the stored identity of every model it selects", () => {
  const selected = selectAllModels([], LIBRARY);
  const third = selected.find(entry => entry.key === "saved:cfg-3:model-3");
  assert.equal(third.configId, "cfg-3", "the provider configuration is kept");
  assert.equal(third.providerId, "prov-3", "the provider id is kept");
  assert.equal(third.model, "model-3", "the model id is kept");
  assert.equal(third.provider, "OpenAI");
});

test("Select All keeps a model that is already selected and does not duplicate it", () => {
  const once = selectAllModels([], LIBRARY);
  const twice = selectAllModels(once, LIBRARY);
  assert.equal(twice.length, LIBRARY.length);
  assert.equal(new Set(twice.map(entry => entry.key)).size, LIBRARY.length, "no duplicates");
});

test("Select All reaches the models the library holds even when some are unavailable", () => {
  // Availability is not a condition: an unavailable model is still in the
  // library, so it is selected too.
  const availability = availabilityMap([
    { key: "saved:cfg-1:model-1", status: "not_working" },
    { key: "saved:cfg-2:model-2", status: "unknown" }
  ]);
  assert.equal(statusFor(availability, "saved:cfg-1:model-1"), "not_working");
  const selected = selectAllModels([], LIBRARY);
  assert.ok(selected.some(entry => entry.key === "saved:cfg-1:model-1"), "a Not Working model is still selected");
  assert.ok(selected.some(entry => entry.key === "saved:cfg-2:model-2"), "an unchecked model is still selected");
});

test("Select All takes the whole library, however large it is", () => {
  const many = Array.from({ length: 3000 }, (_, index) => libraryModel(index + 1));
  const selected = selectAllModels([], many);
  assert.equal(selected.length, 3000, "no model is left behind");
  assert.equal(new Set(selected.map(entry => entry.key)).size, 3000);
});

// ─── 3. Unselect Not Working ────────────────────────────────────────────────

test("Unselect Not Working deselects the models that are not working", () => {
  const selected = selectAllModels([], LIBRARY);
  const availability = availabilityMap([
    { key: "saved:cfg-1:model-1", status: "working" },
    { key: "saved:cfg-2:model-2", status: "not_working" },
    { key: "saved:cfg-3:model-3", status: "working" },
    { key: "saved:cfg-4:model-4", status: "not_working" },
    { key: "saved:cfg-5:model-5", status: "working" }
  ]);
  const kept = unselectNotWorkingModels(selected, availability);
  assert.deepEqual(
    kept.map(entry => entry.key),
    ["saved:cfg-1:model-1", "saved:cfg-3:model-3", "saved:cfg-5:model-5"],
    "only the working models survive"
  );
});

test("Unselect Not Working never mistakes an unchecked model for a working one", () => {
  const selected = selectAllModels([], LIBRARY);
  const availability = availabilityMap([
    { key: "saved:cfg-1:model-1", status: "working" },
    { key: "saved:cfg-2:model-2", status: "unknown" }
  ]);
  const kept = unselectNotWorkingModels(selected, availability);
  assert.deepEqual(
    kept.map(entry => entry.key),
    ["saved:cfg-1:model-1"],
    "a model nobody checked is not evidence of a working model, so it goes"
  );
});

test("Unselect Not Working with no availability record keeps nothing", () => {
  const selected = selectAllModels([], LIBRARY);
  assert.equal(unselectNotWorkingModels(selected, null).length, 0);
  assert.equal(unselectNotWorkingModels(selected, []).length, 0);
  assert.equal(unselectNotWorkingModels(selected, new Map()).length, 0);
});

test("Select All Working selects verified working models even when none were selected", () => {
  const availability = availabilityMap([
    { key: "saved:cfg-1:model-1", status: "working" },
    { key: "saved:cfg-2:model-2", status: "not_working" },
    { key: "saved:cfg-3:model-3", status: "working" },
    { key: "saved:cfg-4:model-4", status: "unknown" }
  ]);
  const selected = selectWorkingModels([], LIBRARY, availability);
  assert.deepEqual(selected.map(entry => entry.key), [
    "saved:cfg-1:model-1",
    "saved:cfg-3:model-3"
  ]);
});

test("Select All Working preserves selected order and never duplicates models", () => {
  const availability = availabilityMap(LIBRARY.map(model => ({ key: model.key, status: "working" })));
  const selected = selectWorkingModels([LIBRARY[2], LIBRARY[0], LIBRARY[2]], LIBRARY, availability);
  assert.deepEqual(selected.map(entry => entry.key), [
    LIBRARY[2].key,
    LIBRARY[0].key,
    LIBRARY[1].key,
    LIBRARY[3].key,
    LIBRARY[4].key
  ]);
});

test("Select All Working does not treat unchecked models as healthy", () => {
  const selected = selectWorkingModels([], LIBRARY, availabilityMap([
    { key: LIBRARY[0].key, status: "working" }
  ]));
  assert.deepEqual(selected.map(entry => entry.key), [LIBRARY[0].key]);
});

test("Unselect Not Working asks no model and reads the published availability", () => {
  const source = comboPage.slice(
    comboPage.indexOf("function unselectNotWorking()"),
    comboPage.indexOf("function retrySave()")
  );
  assert.match(source, /unselectNotWorkingModels\(selectedRef\.current, displayAvailability\)/);
  assert.ok(!/testComboModel|runComboAvailability/.test(source), "no test or availability request is made");
});

// ─── 4. The controls ────────────────────────────────────────────────────────

test("Select All and Unselect Not Working sit together in the controls area", () => {
  const actions = comboPage.slice(
    comboPage.indexOf("combo-selection-actions"),
    comboPage.indexOf("combo-panel__state")
  );
  assert.match(actions, />\s*Select All\s*</);
  assert.match(actions, />\s*Unselect Not Working\s*</);
  assert.match(actions, />\s*Select All Working\s*</);
  assert.match(actions, /onClick=\{selectAll\}/);
  assert.match(actions, /onClick=\{unselectNotWorking\}/);
  assert.match(actions, /onClick=\{selectAllWorking\}/);
});

test("both actions save through the existing selection persistence", () => {
  const selectAll = comboPage.slice(
    comboPage.indexOf("function selectAll()"),
    comboPage.indexOf("function unselectNotWorking()")
  );
  const unselect = comboPage.slice(
    comboPage.indexOf("function unselectNotWorking()"),
    comboPage.indexOf("function retrySave()")
  );
  const working = comboPage.slice(
    comboPage.indexOf("async function selectAllWorking()"),
    comboPage.indexOf("function unselectNotWorking()")
  );
  for (const source of [selectAll, unselect, working]) {
    assert.match(source, /persistSelection\(next/, "the selection is persisted");
  }
  // Selecting a model is not a reason to contact that model.
  assert.match(selectAll, /refreshAvailability: false/);
  assert.match(unselect, /refreshAvailability: false/);
  assert.match(working, /refreshAvailability: false/);
});

test("bulk selection saves against the complete fetched catalogue", () => {
  const selectAll = comboPage.slice(
    comboPage.indexOf("async function selectAll()"),
    comboPage.indexOf("async function selectAllWorking()")
  );
  const working = comboPage.slice(
    comboPage.indexOf("async function selectAllWorking()"),
    comboPage.indexOf("function unselectNotWorking()")
  );
  assert.match(selectAll, /persistSelection\(next, \{ refreshAvailability: false, catalog: models \}\)/);
  assert.match(working, /persistSelection\(next, \{ refreshAvailability: false, catalog: models \}\)/);
  assert.match(comboPage, /selectionForSave\(next, selectionCatalogForSave\(next, catalog\)\)/);
});

test("the controls are aligned, readable and responsive", () => {
  const css = comboCss.slice(
    comboCss.indexOf(".combo-selection-actions"),
    comboCss.indexOf(".combo-panel__state")
  );
  assert.match(css, /\.combo-selection-actions \{[\s\S]*?display: flex;/);
  assert.match(css, /\.combo-selection-actions \{[\s\S]*?align-items: center;/);
  assert.match(css, /\.combo-selection-actions \{[\s\S]*?flex-wrap: wrap;/, "the row wraps instead of overflowing");
  assert.match(css, /\.combo-selection-btn \{[\s\S]*?height: 32px;/, "one shared button height");
  assert.match(css, /\.combo-selection-btn \{[\s\S]*?white-space: nowrap;/);
  assert.match(css, /\.combo-selection-btn:focus-visible \{/, "the buttons are keyboard reachable");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no colour outside the token layer");
  const mobile = comboCss.slice(comboCss.indexOf("@media (max-width: 980px)"));
  assert.match(mobile, /\.combo-selection-btn \{[\s\S]*?height: 44px;/, "a 44px touch target on a narrow screen");
});

// ─── 5. The selection has no model-count cap ────────────────────────────────

test("the client has no model-count limit on the selection", () => {
  assert.ok(!/COMBO_MAX_SELECTED/.test(comboSelection), "the constant is gone");
  assert.ok(
    !/current\.length >= |next\.length >= /.test(comboSelection),
    "nothing refuses a model for being one too many"
  );
  assert.ok(!/supports up to .* selected models/.test(comboPage), "the old limit message is gone");
});

test("several thousand models can be selected and saved", () => {
  const library = Array.from({ length: 3000 }, (_, index) => libraryModel(index + 1));
  const selected = selectAllModels([], library);
  assert.equal(selected.length, 3000);
  const payload = selectionForSave(selected, library);
  assert.equal(payload.length, 3000, "every model is saved");
  assert.equal(new Set(payload.map(entry => entry.key)).size, 3000, "none are lost or duplicated");
});

test("toggling one more model never refuses it", () => {
  const library = Array.from({ length: 2500 }, (_, index) => libraryModel(index + 1));
  let selected = selectAllModels([], library);
  assert.equal(selected.length, 2500);
  selected = toggleSelectedModel(selected, libraryModel(2501));
  assert.equal(selected.length, 2501, "the selection grows as far as the user asks");
});

test("the server has no model-count limit on the selection", () => {
  assert.ok(!/COMBO_MAX_SELECTED_MODELS/.test(serverConfig), "the constant is gone");
  assert.ok(!/COMBO_MAX_SELECTED_MODELS/.test(serverRoutes), "the request no longer counts models");
  assert.ok(
    !/result\.length >= COMBO_MAX_SELECTED_MODELS/.test(serverConfig),
    "the stored selection is never truncated"
  );
  assert.ok(
    !/result\.length >= COMBO_MAX_SELECTED_MODELS \* 2/.test(serverConfig),
    "the availability cache is never truncated either"
  );
  // The only ceiling left is the size of the document that holds it, and that
  // is reported in bytes rather than as a made-up number of models.
  assert.match(serverConfig, /export const COMBO_CONFIG_BODY_LIMIT = "16mb";/);
  assert.match(serverRoutes, /isDocumentTooLarge\(error\)/);
  assert.match(serverRoutes, /selection_too_large/);
});

test("a run still tries a bounded number of models, so the fallback depth is unchanged", () => {
  assert.equal(COMBO_MAX_WORKING_MODELS, 32);
  assert.match(serverConfig, /export const COMBO_MAX_WORKING_MODELS = 32;/);
  assert.match(serverConfig, /maxWorkingModels: \{ min: 1, max: COMBO_MAX_WORKING_MODELS \}/);
  assert.match(serverConfig, /min: 1, max: COMBO_MAX_WORKING_MODELS \}/, "the stored setting keeps its own bound");
  assert.match(serverOrchestrator, /Math\.min\(COMBO_MAX_WORKING_MODELS, Number\(settings\.maxWorkingModels\)/);
  assert.ok(!/COMBO_MAX_SELECTED_MODELS/.test(serverOrchestrator), "the run depth no longer follows the selection size");
});

test("the settings screen still offers the same run depth", () => {
  const settings = read("src/combo/ComboSettingsPage.jsx");
  assert.match(settings, /length: COMBO_MAX_WORKING_MODELS/);
  assert.ok(!/COMBO_MAX_SELECTED/.test(settings), "the run depth does not follow the selection limit");
});

// ─── 6. Untouched behaviour ─────────────────────────────────────────────────

test("the chat model picker is not touched by this work", () => {
  const picker = read("src/components/reactbits/PromptBar.jsx");
  const catalog = read("src/chat/modelCatalog.js");
  assert.match(picker, /const openModelMenu = event => \{/);
  assert.match(picker, /stopPropagation\?\.\(\)/);
  assert.ok(!/selectAllModels|Unselect Not Working|COMBO_MAX_SELECTED/.test(picker), "the composer knows nothing about the library limit");
  assert.match(catalog, /export const COMBO_MODEL_ID = "vups-combo-apex"/, "the Combo identity is unchanged");
  assert.match(catalog, /if \(row\.combo\) return \{ model: COMBO_MODEL_ID, combo: true \}/);
});

test("the sequential fallback still asks one model at a time, in order", () => {
  assert.match(serverOrchestrator, /for \(let index = 0; index < working\.length; index \+= 1\)/);
  assert.match(serverOrchestrator, /const candidates = withImages/);
  assert.match(serverOrchestrator, /Trying \$\{working\.length\} models one at a time, in your order/);
});
