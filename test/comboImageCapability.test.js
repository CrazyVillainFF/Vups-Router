import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { comboCatalogState, mergeSelectedModels, normalizeSelectedModel } from "../src/combo/comboSelection.js";

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function selected(entries) {
  return entries.map(entry => ({
    key: entry.key,
    kind: entry.kind || "shared",
    configId: entry.configId || "",
    providerId: "",
    provider: entry.provider || "Shared",
    providerType: "openai_compatible",
    model: entry.model,
    label: entry.label || entry.model,
    vision: entry.vision
  }));
}

// Case A: every configured model can see.
test("Combo AI knows when every configured model can read a picture", () => {
  const state = comboCatalogState({
    enabled: true,
    selected: selected([
      { key: "a", model: "vision-a", vision: true },
      { key: "b", model: "vision-b", vision: true }
    ])
  });
  assert.equal(state.visionCapableCount, 2);
});

// Case B: only some of them can.
test("Combo AI counts only the models that can read a picture", () => {
  const state = comboCatalogState({
    enabled: true,
    selected: selected([
      { key: "a", model: "vision-a", vision: true },
      { key: "b", model: "text-only", vision: false }
    ])
  });
  assert.equal(state.visionCapableCount, 1);
});

// Case C: none of them can.
test("Combo AI reports when no configured model can read a picture", () => {
  const state = comboCatalogState({
    enabled: true,
    selected: selected([
      { key: "a", model: "text-only", vision: false },
      { key: "b", model: "text-only-2", vision: false }
    ])
  });
  assert.equal(state.visionCapableCount, 0);
});

// Case D: the capability is unknown, so the model is not counted.
test("a model whose capability is unknown is never counted as able to see", () => {
  const state = comboCatalogState({
    enabled: true,
    selected: selected([
      { key: "a", model: "mystery", vision: null },
      { key: "b", model: "vision-b", vision: true }
    ])
  });
  assert.equal(state.visionCapableCount, 1);
});

// The capability travels with the model when it is saved.
test("a model's picture capability is kept when it is saved", () => {
  const saved = normalizeSelectedModel({
    kind: "shared",
    model: "nvidia/nemotron-3.5-super-vl:free",
    label: "Nemotron",
    vision: true
  });
  assert.equal(saved.vision, true);
});

test("an unknown capability stays unknown when it is saved", () => {
  const saved = normalizeSelectedModel({ kind: "shared", model: "mystery" });
  assert.equal(saved.vision, null);
});

test("the catalogue fills in a capability the selection did not carry", () => {
  const merged = mergeSelectedModels(
    [{ key: "shared:x", kind: "shared", model: "x" }],
    [{ key: "shared:x", model: "x", vision: true }]
  );
  assert.equal(merged[0].vision, true);
});

// The composer decides on the real capability, not on a blanket rule.
test("the composer allows a picture when a configured model can read one", () => {
  const branch = chatPageSource.slice(
    chatPageSource.indexOf("if (selectedRow?.combo && imagePayload.length > 0)"),
    chatPageSource.indexOf("if (sendingRef.current) return;")
  );
  assert.ok(branch.length > 0, "the composer has a Combo picture rule");
  assert.match(branch, /comboState\?\.visionCapableCount/, "the rule uses the real capability");
  assert.match(branch, /if \(eligible === 0\)/, "the message is only held back when no model can read one");
  assert.equal(
    branch.includes("Remove the images to run this task on Combo"),
    false,
    "the blanket refusal is gone"
  );
});

test("the composer keeps the picture and the text when no model can read one", () => {
  const branch = chatPageSource.slice(
    chatPageSource.indexOf("if (selectedRow?.combo && imagePayload.length > 0)"),
    chatPageSource.indexOf("if (sendingRef.current) return;")
  );
  assert.match(branch, /None of the models in Vups Combo AI can read images/);
  assert.match(branch, /return;/, "the send stops before the message is dropped");
  // The composer still holds the attachment: the rule returns before the
  // draft is cleared.
  const send = chatPageSource.slice(chatPageSource.indexOf("async function handleSend("));
  const ruleIndex = send.indexOf("if (selectedRow?.combo && imagePayload.length > 0)");
  const paintIndex = send.indexOf("createAssistantTurn({ id: assistantId })");
  assert.ok(ruleIndex >= 0 && paintIndex > ruleIndex, "the rule runs before the turn is painted or sent");
});
