import test from "node:test";
import assert from "node:assert/strict";
import {
  availabilityMap,
  COMBO_MAX_SELECTED,
  comboCatalogState,
  comboModelKey,
  filterModels,
  formatCheckedAt,
  hasVisionModels,
  mergeSelectedModels,
  moveSelectedModel,
  normalizeSelectedModel,
  providerOptions,
  removeSelectedModel,
  runPoolSummary,
  selectionForSave,
  statusFor,
  statusLabel,
  summaryFor,
  toggleSelectedModel,
  withStaleSelected
} from "../src/combo/comboSelection.js";

const CATALOG = [
  {
    key: "saved:cfg-1:claude-sonnet-4",
    kind: "saved",
    configId: "cfg-1",
    providerId: "prov-1",
    provider: "Anthropic",
    providerType: "openai_compatible",
    model: "claude-sonnet-4",
    label: "Claude Sonnet 4",
    vision: true
  },
  {
    key: "saved:cfg-2:gpt-5",
    kind: "saved",
    configId: "cfg-2",
    providerId: "prov-2",
    provider: "OpenAI",
    providerType: "openai_compatible",
    model: "gpt-5",
    label: "GPT-5",
    vision: false
  },
  {
    key: "shared:llama-3.3-70b",
    kind: "shared",
    configId: "",
    providerId: "",
    provider: "OpenRouter",
    providerType: "openai_compatible",
    model: "llama-3.3-70b",
    label: "Llama 3.3 70B",
    vision: false
  },
  {
    key: "vups:vups-v3-galax",
    kind: "vups",
    configId: "",
    providerId: "",
    provider: "Vups",
    providerType: "openai_compatible",
    model: "vups-v3-galax",
    label: "Vups v3 Galax",
    vision: false
  }
];

test("model keys are stable for every kind", () => {
  assert.equal(comboModelKey({ kind: "saved", configId: "cfg-1", model: "m1" }), "saved:cfg-1:m1");
  assert.equal(comboModelKey({ kind: "shared", model: "m2" }), "shared:m2");
  assert.equal(comboModelKey({ kind: "vups", model: "m3" }), "vups:m3");
  assert.equal(comboModelKey({ kind: "saved", model: "m1" }), "saved::m1");
});

test("normalizeSelectedModel rejects incomplete saved models", () => {
  assert.equal(normalizeSelectedModel({ kind: "saved", model: "m1" }), null);
  assert.equal(normalizeSelectedModel({ kind: "saved", configId: "c1" }), null);
  assert.equal(normalizeSelectedModel(null), null);
  const shared = normalizeSelectedModel({ kind: "shared", model: "m2", provider: "OpenRouter" });
  assert.equal(shared.key, "shared:m2");
  assert.equal(shared.configId, "");
  assert.equal(shared.provider, "OpenRouter");
});

test("selection toggles add, remove, and enforce the cap", () => {
  const first = toggleSelectedModel([], CATALOG[0]);
  assert.equal(first.length, 1);
  assert.equal(first[0].key, CATALOG[0].key);

  const second = toggleSelectedModel(first, CATALOG[1]);
  assert.equal(second.length, 2);

  const removed = toggleSelectedModel(second, CATALOG[0]);
  assert.deepEqual(removed.map(entry => entry.key), [CATALOG[1].key]);

  let full = [];
  for (let index = 0; index < COMBO_MAX_SELECTED; index += 1) {
    full = toggleSelectedModel(full, { kind: "shared", model: `model-${index}`, label: `Model ${index}` });
  }
  assert.equal(full.length, COMBO_MAX_SELECTED);
  const unchanged = toggleSelectedModel(full, { kind: "shared", model: "one-too-many" });
  assert.equal(unchanged, full);
});

test("search and provider filters preserve selections independently", () => {
  const selected = toggleSelectedModel(toggleSelectedModel([], CATALOG[0]), CATALOG[1]);
  assert.equal(filterModels(CATALOG, { query: "claude" }).length, 1);
  assert.equal(filterModels(CATALOG, { query: "anthropic" }).length, 1);
  assert.equal(filterModels(CATALOG, { query: "gpt" }).length, 1);
  assert.equal(filterModels(CATALOG, { query: "" }).length, 4);
  assert.equal(filterModels(CATALOG, { provider: "OpenAI" }).length, 1);
  assert.equal(filterModels(CATALOG, { provider: "OpenAI", query: "claude" }).length, 0);
  assert.equal(selected.length, 2);
  assert.deepEqual(
    providerOptions(CATALOG).map(option => option.provider),
    ["Anthropic", "OpenAI", "OpenRouter", "Vups"]
  );
  assert.equal(hasVisionModels(CATALOG), true);
  assert.equal(hasVisionModels(CATALOG.slice(1)), false);
});

test("removal and priority moves keep the original selection order", () => {
  let selected = [];
  for (const model of CATALOG) selected = toggleSelectedModel(selected, model);
  assert.deepEqual(selected.map(entry => entry.key), CATALOG.map(model => model.key));

  const movedDown = moveSelectedModel(selected, CATALOG[0].key, 1);
  assert.deepEqual(movedDown.map(entry => entry.key), [CATALOG[1].key, CATALOG[0].key, CATALOG[2].key, CATALOG[3].key]);
  assert.deepEqual(moveSelectedModel(selected, CATALOG[0].key, -1), selected);
  assert.deepEqual(moveSelectedModel(selected, CATALOG[3].key, 1), selected);

  const removed = removeSelectedModel(selected, CATALOG[1].key);
  assert.equal(removed.length, 3);
  assert.equal(removed.some(entry => entry.key === CATALOG[1].key), false);
});

test("status labels expose the exact two-word availability text", () => {
  assert.equal(statusLabel("working"), "Working");
  assert.equal(statusLabel("not_working"), "Not Working");
  assert.equal(statusLabel("unknown"), "Not checked");
  assert.equal(statusLabel(undefined), "Not checked");
  assert.equal(statusLabel("something-else"), "Not checked");
});

test("availability map and summary follow real entries", () => {
  const selected = CATALOG.map(model => normalizeSelectedModel(model));
  const map = availabilityMap([
    { key: selected[0].key, status: "working", checkedAt: new Date().toISOString() },
    { key: selected[1].key, status: "not_working", checkedAt: new Date().toISOString() }
  ]);
  assert.equal(statusFor(map, selected[0].key), "working");
  assert.equal(statusFor(map, selected[1].key), "not_working");
  assert.equal(statusFor(map, selected[2].key), "unknown");
  assert.equal(statusFor(null, selected[0].key), "unknown");
  assert.deepEqual(summaryFor(selected, map), {
    selected: 4,
    working: 1,
    notWorking: 1,
    unknown: 2
  });
});

test("critical scenario: four selected, two working, two unavailable", () => {
  const selected = CATALOG.map(model => normalizeSelectedModel(model));
  assert.equal(selected.length, 4);

  const map = availabilityMap([
    { key: selected[0].key, status: "working" },
    { key: selected[1].key, status: "working" },
    { key: selected[2].key, status: "not_working" },
    { key: selected[3].key, status: "not_working" }
  ]);

  const summary = summaryFor(selected, map);
  assert.deepEqual(summary, { selected: 4, working: 2, notWorking: 2, unknown: 0 });
  assert.equal(statusLabel(statusFor(map, selected[2].key)), "Not Working");
  assert.equal(statusLabel(statusFor(map, selected[3].key)), "Not Working");
  // Selections are never trimmed by availability.
  assert.equal(selectionForSave(selected, CATALOG).length, 4);
});

test("mergeSelectedModels attaches catalog rows without losing saved entries", () => {
  const selected = [normalizeSelectedModel(CATALOG[0]), normalizeSelectedModel({ kind: "shared", model: "retired-model" })];
  const merged = mergeSelectedModels(selected, CATALOG);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].catalog?.key, CATALOG[0].key);
  assert.equal(merged[1].catalog, null);
  assert.equal(merged[1].label, "retired-model");
});

test("withStaleSelected marks catalog-missing selections as Not Working without overriding probes", () => {
  const selected = [
    { ...normalizeSelectedModel(CATALOG[0]), catalog: CATALOG[0] },
    { ...normalizeSelectedModel({ kind: "shared", model: "retired-model" }), catalog: null }
  ];
  const map = withStaleSelected(selected, new Map());
  assert.equal(statusFor(map, selected[0].key), "unknown");
  assert.equal(statusFor(map, selected[1].key), "not_working");
  assert.equal(statusLabel(statusFor(map, selected[1].key)), "Not Working");

  const probed = withStaleSelected(selected, availabilityMap([
    { key: selected[1].key, status: "working" }
  ]));
  assert.equal(statusFor(probed, selected[1].key), "working");
});

test("selectionForSave drops entries that no longer exist in the catalog", () => {
  const selected = [
    normalizeSelectedModel(CATALOG[0]),
    normalizeSelectedModel({ kind: "shared", model: "retired-model" })
  ];
  const payload = selectionForSave(selected, CATALOG);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].key, CATALOG[0].key);
  assert.equal(payload[0].configId, "cfg-1");
  assert.equal(selectionForSave([{ key: "bad" }], CATALOG).length, 0);
  assert.deepEqual(selectionForSave(null, CATALOG), []);
});

test("runPoolSummary reports the real active and excluded counts", () => {
  assert.equal(runPoolSummary(null), null);
  assert.deepEqual(
    runPoolSummary({ active: [{ key: "a" }, { key: "b" }], excluded: [{ key: "c" }], deferredCount: 1, selectedCount: 4 }),
    { active: 2, excluded: 1, deferred: 1, selected: 4 }
  );
  assert.deepEqual(
    runPoolSummary({ active: [], excluded: [] }),
    { active: 0, excluded: 0, deferred: 0, selected: 0 }
  );
});

test("formatCheckedAt renders relative timestamps and tolerates bad input", () => {
  assert.equal(formatCheckedAt(null), "");
  assert.equal(formatCheckedAt("not-a-date"), "");
  assert.equal(formatCheckedAt(new Date()), "Checked just now");
  assert.equal(
    formatCheckedAt(new Date(Date.now() - 5 * 60 * 1000)),
    "Checked 5 minutes ago"
  );
});

test("comboCatalogState feeds the chat picker only counts a real check proved", () => {
  const selected = CATALOG.map(model => normalizeSelectedModel(model));
  assert.equal(selected.length, 4);

  // Never checked: a count, not "0 working", which would read as a failed check.
  assert.deepEqual(comboCatalogState({ selected }), {
    enabled: true,
    selectedCount: 4,
    workingCount: null
  });

  const halfWorking = {
    selected,
    availability: [
      { key: "saved:cfg-1:claude-sonnet-4", status: "working" },
      { key: "saved:cfg-2:gpt-5", status: "working" },
      { key: "shared:llama-3.3-70b", status: "not_working" },
      { key: "vups:vups-v3-galax", status: "not_working" }
    ]
  };
  assert.deepEqual(comboCatalogState(halfWorking), { enabled: true, selectedCount: 4, workingCount: 2 });

  // A check that proved nothing works must say zero, not hide the result.
  assert.equal(
    comboCatalogState({
      selected,
      availability: [{ key: "saved:cfg-1:claude-sonnet-4", status: "not_working" }]
    }).workingCount,
    0
  );

  // An untested entry in a partly checked set stays uncounted, not "working".
  assert.equal(
    comboCatalogState({
      selected,
      availability: [
        { key: "saved:cfg-1:claude-sonnet-4", status: "working" },
        { key: "saved:cfg-2:gpt-5", status: "unknown" }
      ]
    }).workingCount,
    1
  );

  assert.equal(comboCatalogState({ enabled: false, selected }).enabled, false);
  assert.deepEqual(comboCatalogState(undefined), { enabled: true, selectedCount: 0, workingCount: null });
  assert.deepEqual(comboCatalogState({ selected: [], availability: [{ key: "ghost", status: "working" }] }), {
    enabled: true,
    selectedCount: 0,
    workingCount: null
  });
});
