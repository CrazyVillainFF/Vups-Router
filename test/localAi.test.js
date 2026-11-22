import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCatalog, chatReference, resolveSelection, LOCAL_MODELS_GROUP } from "../src/chat/modelCatalog.js";
import {
  LOCAL_AI_STATES,
  detectLocalRuntime,
  formatModelSize,
  installedModel,
  localAiSupported,
  pullLocalModel
} from "../src/localai/localRuntime.js";
import { buildLibraryRows, libraryCapability } from "../src/localai/localModelCatalog.js";

const sidebarSource = readFileSync(new URL("../src/desktop/DesktopSidebar.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    body: null
  };
}

// The runtime is the only source of truth about what is installed.
function runtimePayload() {
  return {
    models: [
      {
        name: "llama3.2:3b",
        model: "llama3.2:3b",
        size: 2019393189,
        digest: "abc",
        details: { family: "llama", parameter_size: "3.2B" },
        capabilities: ["completion", "tools"]
      },
      {
        name: "qwen2.5vl:7b",
        model: "qwen2.5vl:7b",
        size: 5969245856,
        digest: "def",
        details: { family: "qwen2vl", parameter_size: "8.3B" },
        capabilities: ["completion", "vision"]
      }
    ]
  };
}

// ── The runtime is discovered, never assumed ────────────────────────────────
test("a browser build has no local runtime to talk to", async () => {
  assert.equal(localAiSupported(null), false);
  const state = await detectLocalRuntime(null);
  assert.equal(state.state, LOCAL_AI_STATES.unsupported);
  assert.deepEqual(state.models, []);
});

test("Android reports honestly that it has no local runtime yet", async () => {
  const state = await detectLocalRuntime("android");
  assert.equal(state.state, LOCAL_AI_STATES.unsupported);
  assert.match(state.reason, /Android/i);
});

test("a runtime that cannot be reached is unavailable, not a list of missing models", async () => {
  const state = await detectLocalRuntime("windows", {
    fetchImpl: async () => {
      throw new Error("connection refused");
    }
  });
  assert.equal(state.state, LOCAL_AI_STATES.unavailable);
  assert.deepEqual(state.models, [], "a runtime that is down has no models to install");
});

test("the installed models are the ones the runtime reports", async () => {
  const state = await detectLocalRuntime("windows", { fetchImpl: async () => jsonResponse(runtimePayload()) });
  assert.equal(state.state, LOCAL_AI_STATES.ready);
  assert.deepEqual(state.models.map(model => model.name), ["llama3.2:3b", "qwen2.5vl:7b"]);
  assert.equal(state.models[0].size, "1.9 GB");
  assert.equal(state.models[1].size, "5.6 GB");
});

// ── Capabilities are derived from what the runtime reports ─────────────────
test("a model that can see is a vision model", () => {
  const model = installedModel(runtimePayload().models[1]);
  assert.equal(model.capability, "Vision");
});

test("a model that can think is a reasoning model", () => {
  const model = installedModel({
    name: "qwen3:8b",
    details: { family: "qwen3", parameter_size: "8.2B" },
    capabilities: ["completion", "thinking"]
  });
  assert.equal(model.capability, "Reasoning");
});

test("a coding model is a code model", () => {
  const model = installedModel({
    name: "qwen2.5-coder:7b",
    details: { family: "qwen2", parameter_size: "7.6B" },
    capabilities: ["completion", "tools"]
  });
  assert.equal(model.capability, "Code");
});

test("a small model is the fast one", () => {
  const model = installedModel({
    name: "qwen2.5:0.5b",
    details: { family: "qwen2", parameter_size: "0.5B" },
    capabilities: ["completion"]
  });
  assert.equal(model.capability, "Fast");
});

test("an ordinary model is a chat model", () => {
  const model = installedModel({
    name: "llama3.2:3b",
    details: { family: "llama", parameter_size: "3.2B" },
    capabilities: ["completion"]
  });
  assert.equal(model.capability, "Chat");
});

test("a model with no known size shows no size", () => {
  assert.equal(formatModelSize(0), "");
  assert.equal(formatModelSize(Number.NaN), "");
  assert.equal(formatModelSize(1024 * 1024 * 5), "5 MB");
});

// ── The library ─────────────────────────────────────────────────────────────
test("the library offers every model once", () => {
  const rows = buildLibraryRows({ installed: [] });
  const names = rows.map(row => row.name);
  assert.equal(new Set(names).size, names.length, "no model is offered twice");
});

test("a model the runtime has is listed once, as installed", () => {
  const installed = [installedModel(runtimePayload().models[0])];
  const rows = buildLibraryRows({ installed });
  const matching = rows.filter(row => row.name === "llama3.2:3b");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].installed, true);
});

test("a model installed outside the library is still listed as installed", () => {
  const installed = [
    installedModel({
      name: "my-own-model:latest",
      size: 1024 * 1024 * 100,
      details: { family: "custom", parameter_size: "7B" },
      capabilities: ["completion"]
    })
  ];
  const rows = buildLibraryRows({ installed });
  const row = rows.find(entry => entry.name === "my-own-model:latest");
  assert.ok(row, "the user's own model is not hidden");
  assert.equal(row.installed, true);
});

test("the capability of a library entry comes from the model's own family", () => {
  assert.equal(libraryCapability({ name: "qwen2.5-coder:7b", family: "qwen2" }), "Code");
  assert.equal(libraryCapability({ name: "qwen2.5vl:3b", family: "qwen2vl" }), "Vision");
  assert.equal(libraryCapability({ name: "deepseek-r1:7b", family: "deepseek2" }), "Reasoning");
  assert.equal(libraryCapability({ name: "llama3.2:3b", family: "llama" }), "Chat");
});

// ── The model picker ────────────────────────────────────────────────────────
test("an installed local model appears in the picker as a local model", () => {
  const catalog = buildCatalog({
    models: [{ id: "cloud-model", configId: "cfg-1", provider: "Repro", providerId: "p1" }],
    vups: true,
    localModels: [{ name: "llama3.2:3b", capability: "Chat" }]
  });
  const local = catalog.find(row => row.local);
  assert.ok(local, "the local model is in the picker");
  assert.equal(local.group, LOCAL_MODELS_GROUP);
  assert.equal(local.model, "llama3.2:3b");
  assert.equal(local.badge, "Local");
});

test("the cloud models keep their place when a local model is added", () => {
  const withoutLocal = buildCatalog({
    models: [{ id: "cloud-model", configId: "cfg-1", provider: "Repro", providerId: "p1" }],
    vups: true
  });
  const withLocal = buildCatalog({
    models: [{ id: "cloud-model", configId: "cfg-1", provider: "Repro", providerId: "p1" }],
    vups: true,
    localModels: [{ name: "llama3.2:3b", capability: "Chat" }]
  });
  const cloud = row => `${row.key}|${row.group}|${row.model}`;
  assert.deepEqual(withLocal.slice(0, withoutLocal.length).map(cloud), withoutLocal.map(cloud));
});

test("a local model is sent to the device, not to a cloud provider", () => {
  const reference = chatReference({ local: true, localModel: "llama3.2:3b", model: "llama3.2:3b" });
  assert.equal(reference.model, "llama3.2:3b");
  assert.equal(reference.source, "local");
});

test("a local model carries no cloud provider identity", () => {
  const catalog = buildCatalog({ localModels: [{ name: "llama3.2:3b" }] });
  const local = catalog.find(row => row.local);
  assert.equal(local.configId, "");
  assert.equal(local.providerId, "");
});

test("the free-plan picker keeps installed local models and the combined row", () => {
  const catalog = buildCatalog({
    vups: true,
    modelType: "free",
    localModels: [{ name: "llama3.2:3b", capability: "Chat" }, { name: "qwen3:8b", capability: "Chat" }]
  });
  const local = catalog.find(row => row.local && !row.combined);
  const combined = catalog.find(row => row.combined);
  assert.ok(local, "an installed model survives the Free filter");
  assert.ok(combined, "the combined local row survives the Free filter");
});

test("a saved Combined Local AI choice resolves on a free-plan account", () => {
  const catalog = buildCatalog({
    vups: true,
    modelType: "free",
    localModels: [{ name: "llama3.2:3b" }, { name: "qwen3:8b" }]
  });
  const resolved = resolveSelection(catalog, { kind: "saved", configId: "", model: "combined-local" });
  assert.ok(resolved, "the combined local row is found instead of falling back to the cloud default");
  assert.equal(resolved.key, "local:combined");
});

// ── The navigation ──────────────────────────────────────────────────────────
test("Local AI is in the app navigation for the native apps only", () => {
  assert.match(sidebarSource, /localAiAvailable/);
  assert.match(sidebarSource, /nativeShell === "windows" \|\| nativeShell === "android"/);
  assert.match(sidebarSource, /to="\/local-ai"/);
  assert.match(sidebarSource, /title="Local AI"/);
});

// ── The download reports the runtime's own progress ─────────────────────────
test("a download reports the progress the runtime reported", async () => {
  const events = [];
  const lines = [
    JSON.stringify({ status: "pulling manifest" }),
    JSON.stringify({ status: "pulling 3b8a1f", total: 1000, completed: 250 })
  ];
  const body = {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= lines.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(`${lines[index]}\n`);
          index += 1;
          return { done: false, value };
        }
      };
    }
  };
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, body });
  try {
    await pullLocalModel("llama3.2:3b", { onProgress: event => events.push(event) });
    assert.equal(events.length, 2);
    assert.equal(events[1].completed, 250);
    assert.equal(events[1].total, 1000);
  } finally {
    globalThis.fetch = original;
  }
});
