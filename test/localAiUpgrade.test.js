import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LOCAL_COMBO_STORAGE_KEY,
  comboPlan,
  normalizeComboConfig,
  readLocalComboConfig,
  resetLocalComboCache,
  updateLocalComboConfig,
  writeLocalComboConfig
} from "../src/localai/localCombo.js";
import { runLocalCombo } from "../src/localai/localComboRun.js";
import { buildRoutingPlan } from "../src/localai/localRouter.js";
import {
  LOCAL_MODEL_LIBRARY,
  buildLibraryRows,
  fetchRegistrySize,
  fetchRegistrySizeBytes,
  libraryEntry
} from "../src/localai/localModelCatalog.js";
import {
  HARDWARE_SOURCES,
  HARDWARE_TIERS,
  classifyModelFit,
  detectHardware,
  hardwareSummary,
  modelFootprintBytes,
  readHardwareCache,
  tierForRamBytes,
  writeHardwareCache
} from "../src/localai/localHardware.js";
import {
  RECOMMENDATION_CATEGORIES,
  recommendModels
} from "../src/localai/localRecommendations.js";
import {
  LOCAL_CHATS_STORAGE_KEY,
  ensureLocalChatsFolder,
  isLocalChat,
  listLocalChats,
  markLocalChat,
  readLocalChats,
  resetLocalChatsCache,
  unmarkLocalChat,
  updateLocalChat
} from "../src/localai/localChats.js";
import { formatModelSize, removeLocalModel } from "../src/localai/localRuntime.js";
import { saveChatMessageFirst } from "../src/chat/messageOutbox.js";

const GIGABYTE = 1024 * 1024 * 1024;

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const localAiPageSource = readFileSync(new URL("../src/localai/LocalAiPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sidebarSource = readFileSync(new URL("../src/desktop/DesktopSidebar.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: key => {
      entries.delete(key);
    }
  };
}

function hardware({ ramGB = 16, vramGB = 0, freeGB = 120, source = HARDWARE_SOURCES.native, estimated = false } = {}) {
  return {
    source,
    cpu: "Test CPU",
    logicalCores: 8,
    totalRamBytes: Math.round(ramGB * GIGABYTE),
    availableRamBytes: Math.round((ramGB / 2) * GIGABYTE),
    storageTotalBytes: 512 * GIGABYTE,
    storageFreeBytes: Math.round(freeGB * GIGABYTE),
    gpus: vramGB > 0 ? [{ name: "Test GPU", vramBytes: Math.round(vramGB * GIGABYTE) }] : [],
    estimated
  };
}

function librarySizes() {
  return {
    "qwen2.5-coder:7b": Math.round(4.68 * GIGABYTE),
    "qwen2.5-coder:3b": Math.round(1.9 * GIGABYTE),
    "qwen2.5-coder:0.5b": Math.round(0.4 * GIGABYTE),
    "qwen3:8b": Math.round(5.23 * GIGABYTE),
    "deepseek-r1:7b": Math.round(4.7 * GIGABYTE),
    "llava:7b": Math.round(4.7 * GIGABYTE),
    "qwen2.5:32b": Math.round(20 * GIGABYTE),
    "llama3.2:3b": Math.round(2.02 * GIGABYTE)
  };
}

function installedQwen3() {
  return {
    name: "qwen3:8b",
    size: "5.2 GB",
    bytes: Math.round(5.23 * GIGABYTE),
    capability: "Reasoning",
    capabilities: ["chat", "thinking"],
    parameterSize: "8.2B",
    quantization: "Q4_K_M",
    contextLength: 40960,
    family: "qwen3",
    digest: "abc"
  };
}

// ── Local Combo configuration ───────────────────────────────────────────────
test("local combo config is trimmed, de-duplicated and off by default", () => {
  const config = normalizeComboConfig({ models: [" qwen3:8b", "QWEN3:8B", "", "llama3.2:3b"] });
  assert.deepEqual(config.models, ["qwen3:8b", "llama3.2:3b"]);
  assert.equal(config.enabled, false);
});

test("local combo uses its own storage, never the cloud combo settings", () => {
  const storage = memoryStorage();
  writeLocalComboConfig({ enabled: true, models: ["llama3.2:3b"] }, storage);
  assert.ok(storage.getItem(LOCAL_COMBO_STORAGE_KEY), "the local combo key holds the config");
  assert.equal(LOCAL_COMBO_STORAGE_KEY, "vupsrouter.localcombo.v1");
  const raw = JSON.parse(storage.getItem(LOCAL_COMBO_STORAGE_KEY));
  assert.equal(raw.enabled, true);
  assert.deepEqual(raw.models, ["llama3.2:3b"]);
  assert.ok(raw.updatedAt, "the config records when it changed");
  resetLocalComboCache();
  const restored = readLocalComboConfig(storage);
  assert.equal(restored.enabled, true);
});

test("two quick combo changes merge into the latest config instead of undoing each other", () => {
  // Reproduced live in the Windows app: enabling combo and selecting models in
  // the same tick made each click spread the config it had rendered with, so
  // the second selection wrote enabled:false back over the switch.
  const storage = memoryStorage();
  resetLocalComboCache();
  updateLocalComboConfig(current => ({ ...current, enabled: true }), storage);
  updateLocalComboConfig(current => ({ ...current, models: [...current.models, "llama3.2:3b"] }), storage);
  updateLocalComboConfig(current => ({ ...current, models: [...current.models, "qwen3:8b"] }), storage);

  const stored = readLocalComboConfig(storage);
  assert.equal(stored.enabled, true, "the switch stays on");
  assert.deepEqual(stored.models, ["llama3.2:3b", "qwen3:8b"], "both selections survive");
  resetLocalComboCache();
});

test("a device that cannot store combo settings still answers with a valid config", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    }
  };
  assert.deepEqual(readLocalComboConfig(broken), { enabled: false, models: [], updatedAt: "" });
  const written = writeLocalComboConfig({ enabled: true, models: ["x"] }, broken);
  assert.deepEqual(written.models, ["x"]);
  resetLocalComboCache();
});

test("the combo plan tells installed models apart from selected-but-missing ones", () => {
  const plan = comboPlan(
    { enabled: true, models: ["qwen3:8b", "llama3.2:3b", "gone:1b"] },
    [{ name: "Qwen3:8B" }, { name: "llama3.2:3b" }]
  );
  assert.deepEqual(plan.usable, ["Qwen3:8B", "llama3.2:3b"], "uses the runtime's exact names");
  assert.deepEqual(plan.missing, ["gone:1b"]);
  assert.deepEqual(plan.selected, ["qwen3:8b", "llama3.2:3b", "gone:1b"]);
});

// ── Routed execution: only the planned stages run ──────────────────────────
test("models run one at a time in plan order and the last stage answers", async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const order = [];
  const outcome = await runLocalCombo({
    models: [
      { name: "alpha:1b", capabilities: ["thinking"] },
      { name: "beta:3b", capabilities: ["chat"] }
    ],
    task: "Analyze the trade-offs between SQL and NoSQL for a small app.",
    callModel: async (name, { messages }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(name);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      assert.ok(messages.some(message => message.content.includes("trade-offs")));
      return `${name} answer`;
    },
    onEvent: event => events.push(event.type)
  });
  assert.deepEqual(order, ["alpha:1b", "beta:3b"], "the reasoning stage runs first, then the chat answer");
  assert.equal(maxActive, 1, "the device never loads two models at once");
  assert.ok(events.includes("plan"));
  assert.ok(events.includes("stage-start"));
  assert.ok(events.includes("stage-done"));
  assert.ok(!events.some(type => /synthes/i.test(type)), "there is no synthesis step");
  assert.equal(outcome.stages.length, 2);
  assert.equal(outcome.finalAnswer, "beta:3b answer");
});

test("earlier findings reach later stages and only the vision stage gets the picture", async () => {
  const seen = [];
  const image = "data:image/png;base64,AAAA";
  await runLocalCombo({
    models: [
      { name: "vision:2b", capabilities: ["vision"] },
      { name: "reason:3b", capabilities: ["thinking"] },
      { name: "chat:4b", capabilities: ["chat"] }
    ],
    task: "Compare the two charts in this screenshot and analyze which trend is stronger.",
    history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }],
    images: [image],
    callModel: async (name, { messages }) => {
      seen.push({ name, messages });
      return `${name} findings`;
    }
  });
  assert.deepEqual(seen.map(call => call.name), ["vision:2b", "reason:3b", "chat:4b"]);
  assert.deepEqual(seen[0].messages.find(message => message.images)?.images, [image], "the picture is sent to the vision model");
  assert.ok(seen[1].messages.every(message => !message.images), "the reasoning model never receives pixels");
  assert.ok(seen[2].messages.every(message => !message.images), "the chat model never receives pixels");
  assert.match(seen[2].messages.map(message => message.content).join("\n"), /vision:2b findings/, "the final stage sees the vision notes");
  assert.match(seen[2].messages.map(message => message.content).join("\n"), /reason:3b findings/, "the final stage sees the reasoning notes");
  assert.match(seen[2].messages.map(message => message.content).join("\n"), /Earlier answer/, "conversation history is carried");
  assert.doesNotMatch(seen[0].messages.map(message => message.content).join("\n"), /vision:2b findings/, "the first stage has no findings yet");
});

test("the final answer is the last stage's own output, with no combining call", async () => {
  const calls = [];
  const outcome = await runLocalCombo({
    models: [
      { name: "a:1b", capabilities: ["thinking"] },
      { name: "b:3b", capabilities: ["chat"] }
    ],
    task: "Analyze the advantages and disadvantages of static typing in depth.",
    callModel: async (name, { messages }) => {
      calls.push({ name, messages });
      return `${name} answer`;
    }
  });
  assert.equal(outcome.finalAnswer, "b:3b answer");
  assert.deepEqual(calls.map(call => call.name), ["a:1b", "b:3b"], "each model runs exactly once");
  assert.match(calls[1].messages[0].content, /final answering model/, "the last stage is asked for the answer, not a summary of drafts");
  assert.ok(!calls.some(call => call.messages.some(message => /final editor|combine the drafts/i.test(message.content))), "no combining prompt exists");
});

test("a repeated model is never queued twice", async () => {
  const calls = [];
  const outcome = await runLocalCombo({
    models: ["a:1b", "A:1B", " "],
    task: "Hi",
    callModel: async name => {
      calls.push(name);
      return "ok";
    }
  });
  assert.deepEqual(calls, ["a:1b"]);
  assert.equal(outcome.finalAnswer, "ok");
});

test("a failed middle stage does not discard the run or later answers", async () => {
  const outcome = await runLocalCombo({
    models: [
      { name: "broken:1b", capabilities: ["thinking"] },
      { name: "good:3b", capabilities: ["chat"] }
    ],
    task: "Analyze the trade-offs of microservices for a small team.",
    callModel: async name => {
      if (name === "broken:1b") throw new Error("model crashed");
      return "good answer";
    }
  });
  assert.deepEqual(outcome.usedModels, ["good:3b"]);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].model, "broken:1b");
  assert.equal(outcome.finalAnswer, "good answer");
});

test("a failed final stage reports the failure and keeps completed stage output", async () => {
  await assert.rejects(
    runLocalCombo({
      models: [
        { name: "a:1b", capabilities: ["thinking"] },
        { name: "b:3b", capabilities: ["chat"] }
      ],
      task: "Analyze the trade-offs of monorepos in depth.",
      callModel: async name => {
        if (name === "b:3b") throw new Error("chat unavailable");
        return "a:1b notes";
      }
    }),
    error => {
      assert.match(error.message, /could not finish/i);
      assert.equal(error.stageOutputs[0].answer, "a:1b notes", "completed findings are preserved");
      assert.equal(error.stages[0].status, "done");
      assert.equal(error.stages[1].status, "failed");
      assert.equal(error.plan.ok, true);
      return true;
    }
  );
});

test("a failed selected stage falls back to one compatible local model sequentially", async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const plan = buildRoutingPlan({
    task: "Compare the trade-offs and architecture of this complex system in detail, step by step.",
    models: [
      { name: "broken-reason:1b", capabilities: ["chat", "thinking"] },
      { name: "backup-reason:1b", capabilities: ["chat", "thinking"] },
      { name: "final-chat:1b", capabilities: ["chat"] }
    ]
  });
  const result = await runLocalCombo({
    models: [
      { name: "broken-reason:1b", capabilities: ["chat", "thinking"] },
      { name: "backup-reason:1b", capabilities: ["chat", "thinking"] },
      { name: "final-chat:1b", capabilities: ["chat"] }
    ],
    task: "Compare the trade-offs and architecture of this complex system in detail, step by step.",
    plan,
    callModel: async (model, { onChunk }) => {
      active += 1;
      peak = Math.max(peak, active);
      calls.push(model);
      try {
        if (model === "broken-reason:1b") throw new Error("offline");
        const text = model === "backup-reason:1b" ? "Reasoned findings" : "Final answer";
        onChunk?.(text);
        return text;
      } finally {
        active -= 1;
      }
    }
  });
  assert.deepEqual(calls, ["broken-reason:1b", "backup-reason:1b", "final-chat:1b"]);
  assert.equal(peak, 1);
  assert.equal(result.finalAnswer, "Final answer");
  assert.equal(result.failures[0].model, "broken-reason:1b");
});

test("a failed vision stage ends the run instead of guessing", async () => {
  await assert.rejects(
    runLocalCombo({
      models: [
        { name: "vision:2b", capabilities: ["vision"] },
        { name: "chat:4b", capabilities: ["chat"] }
      ],
      task: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      callModel: async name => {
        if (name === "vision:2b") throw new Error("vision crashed");
        return "guess";
      }
    }),
    error => /could not read the image/i.test(error.message)
  );
});

test("a run where every stage fails reports every failure", async () => {
  await assert.rejects(
    runLocalCombo({
      models: [
        { name: "a:1b", capabilities: ["thinking"] },
        { name: "b:3b", capabilities: ["chat"] }
      ],
      task: "Analyze the trade-offs of edge computing in depth.",
      callModel: async name => {
        throw new Error(`${name} failed`);
      }
    }),
    error => {
      assert.match(error.message, /a:1b failed/);
      assert.match(error.message, /b:3b failed/);
      assert.equal(error.failures.length, 2);
      return true;
    }
  );
});

test("a combo needs a request, at least one model and a caller", async () => {
  await assert.rejects(runLocalCombo({ models: ["a"], task: "  ", callModel: async () => "x" }), /request/i);
  await assert.rejects(runLocalCombo({ models: [], task: "x", callModel: async () => "x" }), /at least one/i);
  await assert.rejects(runLocalCombo({ models: ["a"], task: "x" }), /caller/i);
});

test("stopping a combo stops the plan and no later stage starts", async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(
    runLocalCombo({
      models: [
        { name: "a:1b", capabilities: ["thinking"] },
        { name: "b:3b", capabilities: ["chat"] }
      ],
      task: "Analyze the trade-offs of serverless in depth.",
      signal: controller.signal,
      callModel: async (name, { signal }) => {
        calls.push(name);
        assert.equal(signal, controller.signal);
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
    }),
    error => error.name === "AbortError"
  );
  assert.deepEqual(calls, ["a:1b"], "no later model starts after a stop");
  assert.equal(controller.signal.aborted, true);

  const already = new AbortController();
  already.abort();
  await assert.rejects(
    runLocalCombo({ models: ["a:1b"], task: "Go", signal: already.signal, callModel: async () => "x" }),
    error => error.name === "AbortError"
  );
});

test("finding context is bounded so one long answer cannot flood later models", async () => {
  const long = "x".repeat(5000);
  let second = null;
  const outcome = await runLocalCombo({
    models: [
      { name: "a:1b", capabilities: ["thinking"] },
      { name: "b:3b", capabilities: ["chat"] }
    ],
    task: "Analyze the trade-offs of on-device inference in depth.",
    callModel: async (name, { messages }) => {
      if (name === "b:3b") second = messages;
      return name === "a:1b" ? long : "done";
    }
  });
  assert.equal(outcome.finalAnswer, "done");
  const notes = second[second.length - 1].content;
  assert.ok(notes.includes("x".repeat(3000)), "bounded findings are passed forward");
  assert.ok(!notes.includes("x".repeat(3001)), "the earlier answer is truncated before it floods the next model");
});

// ── Sizes: real metadata only ───────────────────────────────────────────────
test("a catalogue row shows the registry download size and the runtime's installed size", () => {
  const rows = buildLibraryRows({
    installed: [installedQwen3()],
    sizes: librarySizes()
  });
  const coder = rows.find(row => row.name === "qwen2.5-coder:7b");
  assert.equal(coder.downloadSize, "4.7 GB");
  assert.equal(coder.installed, false, "a catalogue model is not installed until the runtime says so");
  assert.equal(coder.installedSize, "");
  const qwen3 = rows.find(row => row.name === "qwen3:8b");
  assert.equal(qwen3.installed, true);
  assert.equal(qwen3.installedSize, "5.2 GB", "the installed size comes from the runtime");
  assert.equal(qwen3.capabilitySource, "runtime");
});

test("a model whose size is unknown shows no invented size", () => {
  const rows = buildLibraryRows({ installed: [], sizes: {} });
  const row = rows.find(entry => entry.name === "llama3.2:1b");
  assert.equal(row.downloadBytes, 0);
  assert.equal(row.downloadSize, "");
  assert.equal(row.installedSize, "");
});

test("sizes are readable in MB, GB and TB", () => {
  assert.equal(formatModelSize(5 * 1024 * 1024), "5 MB");
  assert.equal(formatModelSize(1.5 * GIGABYTE), "1.5 GB");
  assert.equal(formatModelSize(2048 * GIGABYTE), "2.0 TB");
  assert.equal(formatModelSize(0), "");
});

test("the registry size sums every manifest layer and reports none when unavailable", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ layers: [{ size: 1000 }, { size: 500 }] })
    };
  };
  assert.equal(await fetchRegistrySizeBytes("qwen3:8b", { fetchImpl }), 1500);
  assert.match(requests[0].url, /registry\.ollama\.ai\/v2\/library\/qwen3\/manifests\/8b/);
  assert.equal(await fetchRegistrySize("qwen3:8b", { fetchImpl: async () => ({ ok: true, json: async () => ({ layers: [{ size: Math.round(1.5 * GIGABYTE) }] }) }) }), "1.5 GB");
  assert.equal(await fetchRegistrySizeBytes("qwen3:8b", { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }), 0);
  assert.equal(await fetchRegistrySize("qwen3:8b", { fetchImpl: async () => { throw new Error("offline"); } }), "");
});

test("the catalogue only contains identifiers the runtime can pull", () => {
  const names = LOCAL_MODEL_LIBRARY.map(entry => entry.name);
  assert.ok(names.length >= 50, "the catalogue is genuinely expanded");
  for (const name of names) {
    assert.match(name, /^[a-z0-9.-]+:[a-z0-9.-]+$/i, `${name} is a name:tag identifier`);
  }
  assert.ok(libraryEntry("qwen2.5-coder:7b"), "known entries resolve");
  assert.equal(libraryEntry("moondream:2b"), null, "a tag that does not resolve is not listed");
});

// ── Hardware tiers and compatibility ───────────────────────────────────────
test("tiers follow the detected RAM", () => {
  assert.equal(tierForRamBytes(8 * GIGABYTE), HARDWARE_TIERS.low);
  assert.equal(tierForRamBytes(16 * GIGABYTE), HARDWARE_TIERS.mid);
  assert.equal(tierForRamBytes(32 * GIGABYTE), HARDWARE_TIERS.high);
  assert.equal(tierForRamBytes(0), null);
  assert.equal(tierForRamBytes(Number.NaN), null);
});

test("the requirement includes runtime and context overhead, not just weights", () => {
  const weights = 4 * GIGABYTE;
  const footprint = modelFootprintBytes({ downloadBytes: weights });
  assert.ok(footprint > weights, "weights alone are not the whole requirement");
  assert.equal(modelFootprintBytes({ installedBytes: 2 * GIGABYTE, downloadBytes: 8 * GIGABYTE }), Math.round(2 * GIGABYTE * 1.15 + 1.25 * GIGABYTE));
  assert.equal(modelFootprintBytes({}), 0);
});

test("a download smaller than RAM is not automatically compatible", () => {
  const fit = classifyModelFit({ downloadBytes: Math.round(4.68 * GIGABYTE) }, hardware({ ramGB: 8 }));
  assert.equal(fit.level, "insufficient");
  assert.match(fit.detail, /8\.0 GB of RAM/);
});

test("a 16 GB machine is mid-end and fits a 7B model in system RAM without calling it VRAM", () => {
  const fit = classifyModelFit({ downloadBytes: Math.round(4.68 * GIGABYTE) }, hardware({ ramGB: 16 }));
  assert.equal(fit.level, "mid");
  assert.equal(fit.label, "Mid-end");
  assert.match(fit.detail, /system RAM/);
  assert.doesNotMatch(fit.detail, /VRAM/);
});

test("a GPU result is only reported from dedicated GPU memory", () => {
  const gpuFit = classifyModelFit({ downloadBytes: Math.round(4.68 * GIGABYTE) }, hardware({ ramGB: 16, vramGB: 8 }));
  assert.equal(gpuFit.level, "gpu");
  assert.equal(gpuFit.label, "High-end");
  assert.match(gpuFit.detail, /GPU memory/);
  assert.equal(gpuFit.estimated, false);
  const cpuOnly = classifyModelFit({ downloadBytes: Math.round(4.68 * GIGABYTE) }, hardware({ ramGB: 32 }));
  assert.equal(cpuOnly.level, "high");
  assert.doesNotMatch(cpuOnly.detail, /VRAM/);
});

test("unknown hardware is labelled honestly and estimated hardware says so", () => {
  const unknown = classifyModelFit({ downloadBytes: GIGABYTE }, { source: HARDWARE_SOURCES.none });
  assert.equal(unknown.level, "unknown");
  assert.match(unknown.detail, /could not be read/);
  const estimated = classifyModelFit(
    { downloadBytes: Math.round(2 * GIGABYTE) },
    hardware({ ramGB: 16, source: HARDWARE_SOURCES.browser, estimated: true })
  );
  assert.equal(estimated.estimated, true);
  assert.match(estimated.detail, /Estimated/);
});

test("native hardware is reported as measured, and the browser fallback as estimated", async () => {
  const storage = memoryStorage();
  const native = await detectHardware({
    storage,
    nativeInfo: async () => ({
      cpu: "Ryzen 7",
      logicalCores: 16,
      totalRamBytes: 32 * GIGABYTE,
      availableRamBytes: 20 * GIGABYTE,
      storageTotalBytes: 1000 * GIGABYTE,
      storageFreeBytes: 500 * GIGABYTE,
      gpus: [{ name: "RTX 4070", vramBytes: 12 * GIGABYTE }]
    })
  });
  assert.equal(native.source, HARDWARE_SOURCES.native);
  assert.equal(native.estimated, false);
  assert.equal(native.logicalCores, 16);
  assert.equal(native.gpus[0].vramBytes, 12 * GIGABYTE);
  const cached = await detectHardware({ storage });
  assert.equal(cached.cpu, "Ryzen 7", "a recent reading is reused");

  const fallbackStorage = memoryStorage();
  const fallback = await detectHardware({
    storage: fallbackStorage,
    nativeInfo: async () => {
      throw new Error("bridge missing");
    }
  });
  assert.equal(fallback.source, HARDWARE_SOURCES.browser);
  assert.equal(fallback.estimated, true);
  assert.match(fallback.reason, /VRAM is not visible/);
});

test("an expired hardware cache is not used", () => {
  const storage = memoryStorage();
  writeHardwareCache({ source: "native", totalRamBytes: 1 }, storage, Date.now() - 13 * 60 * 60 * 1000);
  assert.equal(readHardwareCache(storage), null);
  writeHardwareCache({ source: "native", totalRamBytes: 1 }, storage);
  assert.ok(readHardwareCache(storage));
});

test("the hardware summary never presents system RAM as GPU memory", () => {
  const summary = hardwareSummary(hardware({ ramGB: 16 }));
  assert.equal(summary.tier.id, "mid");
  assert.equal(summary.ram, "16.0 GB");
  assert.match(summary.gpu, /Not detected/);
  assert.match(summary.gpu, /system RAM/);
  const gpuSummary = hardwareSummary(hardware({ ramGB: 32, vramGB: 12 }));
  assert.match(gpuSummary.gpu, /12\.0 GB VRAM/);
  const browser = hardwareSummary(hardware({ ramGB: 8, source: HARDWARE_SOURCES.browser, estimated: true }));
  assert.match(browser.ram, /estimated/);
});

// ── Recommendations ────────────────────────────────────────────────────────
test("there are five recommendation categories", () => {
  assert.deepEqual(
    RECOMMENDATION_CATEGORIES.map(category => category.id),
    ["coding", "chat", "vision", "thinking", "reasoning"]
  );
});

test("recommendations follow real capabilities, and a model can serve several categories", () => {
  const rows = buildLibraryRows({ installed: [], sizes: librarySizes() });
  const categories = recommendModels(rows, hardware({ ramGB: 32, freeGB: 300 }));
  const picks = id => categories.find(category => category.id === id).picks;
  const names = id => picks(id).map(pick => pick.row.name);

  assert.ok(picks("coding").length > 0, "coding has at least one compatible model");
  assert.ok(picks("coding").every(pick => pick.row.capabilities.includes("coding")), "only code models are recommended for coding");
  assert.ok(picks("chat").length > 0, "chat always has a compatible model on a mid-range device");
  assert.ok(picks("vision").length > 0, "vision has a compatible model at 32 GB");
  assert.ok(picks("vision").every(pick => pick.row.capabilities.includes("vision")), "vision is only offered to vision models");
  assert.ok(picks("thinking").length > 0);
  assert.ok(picks("thinking").every(pick => pick.row.capabilities.includes("thinking")), "thinking comes from the runtime capability");
  assert.ok(picks("reasoning").length > 0);
  assert.ok(picks("reasoning").every(pick => pick.row.capabilities.includes("reasoning")), "reasoning comes from a reasoning family");
  assert.ok(names("thinking").every(name => name.startsWith("qwen3")), "thinking-capable qwen3 models carry the category");
  assert.ok(names("reasoning").every(name => /^(deepseek-r1|qwq)/.test(name)), "reasoning models carry their own category");
  assert.ok(!names("reasoning").some(name => name.startsWith("qwen3")), "a thinking model is not relabelled as reasoning");
  assert.ok(!names("thinking").some(name => name.startsWith("deepseek-r1")), "a reasoning model is not relabelled as thinking");
  assert.ok(categories.every(category => category.picks.length <= 2), "each category offers at most two picks");
  assert.equal(categories.find(category => category.id === "coding").picks[0].role, "Recommended");
});

test("a model that does not fit is never recommended and an empty category says so", () => {
  const rows = buildLibraryRows({ installed: [], sizes: librarySizes() });
  const tiny = recommendModels(rows, hardware({ ramGB: 2, freeGB: 100 }));
  assert.ok(tiny.every(category => category.picks.length === 0), "nothing heavy is recommended on 2 GB of RAM");
  const vision = tiny.find(category => category.id === "vision");
  assert.match(vision.empty, /No compatible vision model/);
  const roomy = recommendModels(rows, hardware({ ramGB: 16, freeGB: 100 }));
  const coding = roomy.find(category => category.id === "coding").picks.map(pick => pick.row.name);
  assert.ok(!coding.includes("qwen2.5-coder:32b"), "a 20 GB download is not recommended for 16 GB of RAM");
});

test("free storage limits installation recommendations", () => {
  const rows = buildLibraryRows({ installed: [], sizes: librarySizes() });
  const tight = recommendModels(rows, hardware({ ramGB: 32, freeGB: 1 }));
  const coding = tight.find(category => category.id === "coding").picks.map(pick => pick.row.name);
  assert.ok(!coding.includes("qwen2.5-coder:7b"), "a 4.7 GB download does not fit 1 GB of free storage");
});

// ── Local Chats folder and persistence ────────────────────────────────────
test("the Local Chats folder is created automatically and only once", () => {
  const storage = memoryStorage();
  assert.equal(readLocalChats(storage).createdAt, "");
  const first = ensureLocalChatsFolder(storage);
  assert.ok(first.createdAt);
  const second = ensureLocalChatsFolder(storage);
  assert.equal(second.createdAt, first.createdAt, "the folder is not recreated");
  assert.equal(storage.getItem(LOCAL_CHATS_STORAGE_KEY).includes("createdAt"), true);
});

test("a local conversation is marked, updated, listed and removed without touching other chats", () => {
  const storage = memoryStorage();
  ensureLocalChatsFolder(storage);
  markLocalChat({ id: "c1", title: "First", model: "llama3.2:3b" }, storage);
  markLocalChat({ id: "c2", title: "Second", model: "Local Combo AI", combo: true }, storage);
  assert.equal(isLocalChat("c1", storage), true);
  assert.equal(isLocalChat("c2", storage), true);
  updateLocalChat("c1", { title: "Renamed" }, storage);
  assert.equal(listLocalChats(storage).find(chat => chat.id === "c1").title, "Renamed");
  assert.equal(readLocalChats(storage).chats.c2.combo, true, "another chat keeps its assignment");
  const createdAt = readLocalChats(storage).chats.c1.createdAt;
  markLocalChat({ id: "c1", model: "qwen3:8b" }, storage);
  assert.equal(readLocalChats(storage).chats.c1.createdAt, createdAt, "marking again keeps the original time");
  unmarkLocalChat("c1", storage);
  assert.equal(isLocalChat("c1", storage), false);
  assert.equal(isLocalChat("c2", storage), true);
});

test("an unmarked draft id is not treated as a Local Chat", () => {
  const storage = memoryStorage();
  ensureLocalChatsFolder(storage);
  assert.equal(isLocalChat("local-draft-123", storage), false, "the marker decides, not the id prefix");
  assert.equal(isLocalChat("", storage), false);
});

test("the folder survives a reload because it lives in device storage", () => {
  const storage = memoryStorage();
  markLocalChat({ id: "c9", title: "Kept", model: "llama3.2:3b" }, storage);
  resetLocalChatsCache();
  assert.equal(isLocalChat("c9", storage), true);
  assert.equal(listLocalChats(storage)[0].title, "Kept");
});

// ── Save-first and retry durability in the local flow ─────────────────────
test("the user message is stored before a local model answers, and a failed answer keeps it", async () => {
  const storage = memoryStorage();
  let storedAtInference = false;
  const calls = [];
  await saveChatMessageFirst({
    storage,
    userId: "u1",
    content: "Write a haiku",
    messageId: "m1",
    createConversation: async ({ messageId, handoff }) => {
      calls.push({ handoff, messageId });
      storedAtInference = Boolean(storage.getItem("vupsrouter.chat.outbox.v1"));
      return { id: "conv-1" };
    },
    appendConversationMessage: async () => ({})
  });
  assert.equal(storedAtInference, true, "the outbox held the message before the backend call finished");
  assert.equal(calls[0].messageId, "m1");

  const retryStorage = memoryStorage();
  const backend = { created: [], appended: [] };
  const first = await saveChatMessageFirst({
    storage: retryStorage,
    userId: "u1",
    content: "Keep me",
    messageId: "m2",
    createConversation: async ({ messageId }) => {
      backend.created.push(messageId);
      throw new Error("offline");
    },
    appendConversationMessage: async () => ({})
  }).catch(error => error);
  assert.ok(first instanceof Error);
  assert.ok(retryStorage.getItem("vupsrouter.chat.outbox.v1").includes("m2"), "the failed message stays durable");

  const retried = await saveChatMessageFirst({
    storage: retryStorage,
    userId: "u1",
    content: "Keep me",
    messageId: "m2",
    createConversation: async ({ messageId }) => {
      backend.created.push(messageId);
      return { id: "conv-2" };
    },
    appendConversationMessage: async () => ({})
  });
  assert.equal(retried.conversationId, "conv-2");
  assert.deepEqual(backend.created, ["m2", "m2"], "the retry reuses the same message id");
});

// ── The Chat page wires the local path end to end ─────────────────────────
test("a local turn saves the message first, then marks the conversation as a Local Chat", () => {
  const saveFirst = chatPageSource.indexOf("const saved = await saveChatMessageFirst({");
  const mark = chatPageSource.indexOf("markLocalChat({");
  assert.ok(saveFirst > 0, "the local send path saves first");
  assert.ok(mark > saveFirst, "the conversation is marked after it exists");
  assert.ok(chatPageSource.includes("ensureLocalChatsFolder();"));
  assert.ok(chatPageSource.match(/appendConversationMessage\(localConversationId, \{\s*role: "assistant"/));
  assert.ok(chatPageSource.includes("_Stopped before the answer finished. The part above was kept._"));
  assert.ok(chatPageSource.includes("_Stopped before the run finished. Completed answers above were kept._"));
  assert.ok(chatPageSource.includes("could not be saved to this Local Chat."));
});

test("a refused cloud send in a Local Chat keeps the user's typed text", () => {
  // The composer clears its draft only after beforeComposerSend returns true.
  // A Local Chat with a cloud chip must be refused there, not only in the send
  // path where the text is already gone from the input.
  const start = chatPageSource.indexOf("async function beforeComposerSend");
  assert.ok(start > 0);
  const end = chatPageSource.indexOf("function preserveUnsyncedChat", start);
  const gate = chatPageSource.slice(start, end);
  const refusal = gate.indexOf("This is a Local Chat.");
  const firstSuccess = gate.search(/return (?:true;|await provisionTaskWorkspace\(text\);)/);
  assert.ok(refusal > 0 && firstSuccess > refusal, "the guard runs before the composer clears");
  assert.match(
    gate,
    /else if \(isLocalChat\(activeConvId\) \|\| isNativeLocalChatId\(activeConvId\)\) \{[\s\S]{0,400}?return false;/
  );
  assert.ok(gate.includes("Local chats take text for now."));
  assert.ok(gate.includes("Local Combo AI is off."));
  assert.ok(gate.includes("None of the selected local models is installed right now"));
});

test("Local Chats stay on the device path and cloud models cannot answer inside one", () => {
  assert.match(chatPageSource, /This is a Local Chat\./);
  assert.match(chatPageSource, /if \(selectedRow\?\.local\) \{[\s\S]*?runLocalAgent\(\{/);
  assert.match(
    chatPageSource,
    /if \(selectedRow\?\.local\) \{[\s\S]*?runLocalAgent\(\{[\s\S]{0,900}?chatLocalModelTurn\(/
  );
  assert.match(chatPageSource, /if \(selectedRow\?\.combined\) \{[\s\S]*?runLocalCombo\(\{/);
  assert.ok(chatPageSource.includes("Local chats take text for now."));
  assert.ok(chatPageSource.includes("Local Combo AI is off."));
  assert.match(chatPageSource, /if \(serverOwned && !localRun\) \{[\s\S]{0,400}?stopChatTurn\(targetId\)/);
  const comboRunSource = readFileSync(new URL("../src/localai/localComboRun.js", import.meta.url), "utf8");
  assert.doesNotMatch(comboRunSource, /fetch\(|fetchImpl|api\./i, "the runner has no cloud transport");
});

test("the chat waits for the device runtime before it restores a local selection", () => {
  // Reproduced live: opening Combined Local AI in chat restored the selection
  // before Ollama had answered, could not resolve the local row, and saved the
  // cloud default over the user's local choice.
  assert.match(chatPageSource, /const \[localModelsSettled, setLocalModelsSettled\] = useState\(false\);/);
  const restore = chatPageSource.slice(
    chatPageSource.indexOf("const stored = loadStoredSelection();"),
    chatPageSource.indexOf("const stored = loadStoredSelection();") + 700
  );
  assert.match(restore, /!localModelsSettled/);
  assert.match(restore, /localAiSupported\(nativeShell\)/);
  assert.match(restore, /stored\?\.kind === "saved"/);
  assert.match(restore, /!stored\.configId/);
  assert.match(restore, /return;/);
  assert.match(chatPageSource, /setLocalModelsSettled\(true\);/);
});

test("combo clicks merge into the latest config instead of a rendered snapshot", () => {
  assert.doesNotMatch(localAiPageSource, /writeLocalComboConfig\(\{ \.\.\.comboConfig/);
  assert.match(localAiPageSource, /updateLocalComboConfig\(current => \(\{ \.\.\.current, enabled: !current\.enabled \}\)\)/);
  assert.match(localAiPageSource, /updateLocalComboConfig\(current => \{/);
});

test("the Local AI page keeps the brief's structure and the real metadata labels", () => {
  const comboIndex = localAiPageSource.indexOf('aria-label="Local Combo AI"');
  const hardwareIndex = localAiPageSource.indexOf('aria-label="Hardware"');
  const recommendationsIndex = localAiPageSource.indexOf('aria-label="Recommendations"');
  const allModelsIndex = localAiPageSource.indexOf('aria-label="All local models"');
  const installedIndex = localAiPageSource.indexOf('aria-label="Installed models"');
  const chatsIndex = localAiPageSource.indexOf('aria-label="Local Chats"');
  assert.ok(comboIndex > 0 && comboIndex < hardwareIndex, "Local Combo AI is first");
  assert.ok(hardwareIndex < recommendationsIndex);
  assert.ok(recommendationsIndex < allModelsIndex);
  assert.ok(allModelsIndex < installedIndex);
  assert.ok(installedIndex < chatsIndex, "Local Chats closes the page");
  assert.ok(localAiPageSource.includes('"Size unavailable"'));
  assert.ok(localAiPageSource.includes("saveStoredSelection"));
  assert.match(localAiPageSource, /recommendModels\(rows, hardware\)/);
  assert.match(localAiPageSource, /detectLocalRuntime\(shell\)[\s\S]*?confirmed/);
});

test("the sidebar shows a separate Local Chats folder", () => {
  assert.match(sidebarSource, /useLocalChatsFolder/);
  assert.match(sidebarSource, /aria-label="Local chats"/);
  assert.match(sidebarSource, /localChatTasks\.slice\(0, 24\)\.map\(renderTaskRow\)/);
  assert.match(sidebarSource, /const otherTasks = useMemo\([\s\S]*?!localChatIds\.has/);
  assert.match(sidebarSource, /visibleTasks = searchMode \? results \|\| \[\] : otherTasks\.slice\(0, 24\)/);
});

// ── Removal goes through the runtime ──────────────────────────────────────
test("removing a local model asks the runtime, and a refusal is reported", async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    };
    let result = false;
    try {
      result = await removeLocalModel("llama3.2:3b");
    } catch {
      result = false;
    }
    assert.equal(result, true);
    assert.match(calls[0].url, /\/api\/delete$/);
    assert.equal(JSON.parse(calls[0].options.body).name, "llama3.2:3b");

    globalThis.fetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(removeLocalModel("broken:1b"), /could not remove/);
  } finally {
    globalThis.fetch = original;
    resetLocalComboCache();
    resetLocalChatsCache();
  }
});
