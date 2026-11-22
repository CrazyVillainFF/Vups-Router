import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LOCAL_ROUTER_LIMITS,
  buildRoutingPlan,
  buildStageMessages,
  classifyLocalIntent,
  planSummary
} from "../src/localai/localRouter.js";
import {
  LOCAL_ROUTING_STORAGE_KEY,
  readLocalRouting,
  readLocalRoutingMap,
  resetLocalRouting,
  saveLocalRouting
} from "../src/localai/localRoutingLog.js";
import {
  LOCAL_RUN_STATES,
  beginLocalRun,
  finishLocalRun,
  getLocalRun,
  noteLocalRunStage,
  readLocalRunDraft,
  resetLocalRuns
} from "../src/localai/localRunStore.js";

// The real installed set this machine reports through /api/tags, with the
// capability flags the runtime states for each model.
const MODELS = [
  { name: "gemma4:e4b", capabilities: ["completion", "tools", "vision", "audio", "thinking"] },
  { name: "qwen2.5vl:7b", capabilities: ["completion", "vision"] },
  { name: "qwen2.5-coder:7b", capabilities: ["completion", "tools", "insert", "coding"] },
  { name: "llama3.2:3b", capabilities: ["completion"] },
  { name: "qwen3:8b", capabilities: ["completion", "thinking"] }
];

const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const localAiPageSource = readFileSync(new URL("../src/localai/LocalAiPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const routerSource = readFileSync(new URL("../src/localai/localRouter.js", import.meta.url), "utf8");

function planFor(task, extra = {}) {
  return buildRoutingPlan({ task, models: MODELS, ...extra });
}

function rolesOf(plan) {
  return plan.stages.map(stage => stage.role);
}

function modelsOf(plan) {
  return plan.stages.map(stage => stage.model);
}

test("a greeting runs one chat model even when every kind of model is selected", () => {
  for (const greeting of ["Hi", "Hii", "Hello!", "Hey", "Thanks"]) {
    const plan = planFor(greeting);
    assert.equal(plan.ok, true);
    assert.equal(plan.intent, "greeting");
    assert.equal(plan.execution, 1, `${greeting} must not run every model`);
    assert.deepEqual(rolesOf(plan), ["chat"]);
    assert.deepEqual(modelsOf(plan), ["llama3.2:3b"]);
    assert.equal(plan.label, "Chat model");
    assert.match(plan.reason, /greeting/i);
  }
});

test("simple questions and calculations stay on the chat model alone", () => {
  for (const task of [
    "What is HTML?",
    "What is 2+2?",
    "Explain closures briefly.",
    "What does HTTP stand for?"
  ]) {
    const plan = planFor(task);
    assert.equal(plan.ok, true);
    assert.equal(plan.intent, "simple", `${task} should route as simple`);
    assert.equal(plan.execution, 1);
    assert.deepEqual(rolesOf(plan), ["chat"]);
    assert.deepEqual(modelsOf(plan), ["llama3.2:3b"]);
  }
});

test("a complex question runs reasoning first, then the chat answer", () => {
  const plan = planFor("Compare the trade-offs of REST and GraphQL for a small team, including caching and versioning.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "complex");
  assert.deepEqual(rolesOf(plan), ["reasoning", "chat"]);
  assert.deepEqual(modelsOf(plan), ["qwen3:8b", "llama3.2:3b"]);
  assert.equal(plan.label, "Reasoning → Chat");
  assert.equal(plan.execution, 2);
  assert.equal(plan.stages.at(-1).final, true);
  assert.equal(plan.stages[0].final, false);
});

test("planning gets a reasoning pass before the plan is written", () => {
  const plan = planFor("Make a study plan for learning Spanish in 30 days.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "planning");
  assert.deepEqual(rolesOf(plan), ["reasoning", "chat"]);
  assert.equal(plan.execution, 2);
});

test("coding goes to the coding model alone", () => {
  const plan = planFor("Write a function that debounces an input in JavaScript.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding");
  assert.deepEqual(rolesOf(plan), ["coding"]);
  assert.deepEqual(modelsOf(plan), ["qwen2.5-coder:7b"]);
  assert.equal(plan.label, "Code model");
  assert.equal(plan.execution, 1);
});

test("app and website development also uses the coding model", () => {
  const plan = planFor("Build a landing page for my app with HTML and CSS.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding");
  assert.deepEqual(modelsOf(plan), ["qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 1);
});

test("complex debugging gets one reasoning pass then the coding model", () => {
  const plan = planFor("My React app crashes when I debug the useEffect hook; why does it fail with a stack trace?");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding-complex");
  assert.deepEqual(rolesOf(plan), ["reasoning", "coding"]);
  assert.deepEqual(modelsOf(plan), ["qwen3:8b", "qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 2);
});

test("a simple image description is answered by the vision model only", () => {
  const image = "data:image/png;base64,AAAA";
  const plan = planFor("Describe this image.", { images: [image] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-simple");
  assert.deepEqual(rolesOf(plan), ["vision"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b"]);
  assert.equal(plan.execution, 1);
  assert.equal(plan.stages[0].final, true);
});

test("an image with an empty caption is still one vision pass", () => {
  const plan = planFor("", { images: ["data:image/png;base64,AAAA"] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-simple");
  assert.deepEqual(rolesOf(plan), ["vision"]);
  assert.equal(plan.taskPreview, "Describe this image.");
});

test("image analysis runs vision, then reasoning and chat with distinct models", () => {
  const image = "data:image/jpeg;base64,BBBB";
  const plan = planFor(
    "Compare the two dashboards in the screenshot and analyze which one presents the trend more clearly, including the trade-offs.",
    { images: [image] }
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image");
  assert.deepEqual(rolesOf(plan), ["vision", "reasoning", "chat"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b", "qwen3:8b", "llama3.2:3b"]);
  assert.equal(plan.label, "Vision → Reasoning → Chat");
  assert.equal(plan.execution, 3);
  assert.equal(new Set(plan.models.map(name => name.toLowerCase())).size, 3, "no model is bound twice");
});

test("an image with no installed vision model is refused, not sent to the cloud", () => {
  const plan = buildRoutingPlan({
    task: "Describe this image.",
    images: ["data:image/png;base64,AAAA"],
    models: MODELS.filter(model => model.name !== "gemma4:e4b" && model.name !== "qwen2.5vl:7b")
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.stages.length, 0);
  assert.equal(plan.execution, 0);
  assert.match(plan.error, /vision model on the Local AI page/i);
  assert.doesNotMatch(plan.error, /cloud/i, "the refusal offers no cloud fallback");
});

test("missing roles fall back to the selected models with an honest note", () => {
  const onlyChat = buildRoutingPlan({
    task: "Compare the trade-offs of REST and GraphQL for a small team.",
    models: [{ name: "llama3.2:3b", capabilities: ["chat"] }]
  });
  assert.deepEqual(rolesOf(onlyChat), ["chat"]);
  assert.equal(onlyChat.execution, 1, "one model is not run twice to fake a reasoning stage");
  assert.equal(onlyChat.notes.length, 1);
  assert.match(onlyChat.notes[0], /no reasoning model/i);

  const onlyThinking = buildRoutingPlan({
    task: "Compare the trade-offs of REST and GraphQL for a small team.",
    models: [{ name: "qwen3:8b", capabilities: ["chat", "thinking"] }]
  });
  assert.deepEqual(rolesOf(onlyThinking), ["chat"]);
  assert.equal(onlyThinking.execution, 1);
  assert.match(onlyThinking.notes[0], /runs once/i);

  const noCoder = buildRoutingPlan({
    task: "Write a function that debounces an input in JavaScript.",
    models: [{ name: "llama3.2:3b", capabilities: ["chat"] }]
  });
  assert.equal(noCoder.ok, false, "a chat model is not passed off as the coding model");
  assert.deepEqual(rolesOf(noCoder), []);
  assert.match(noCoder.error, /coding-capable model/i);
});

test("no plan binds the same model twice across the intent matrix", () => {
  const cases = [
    { task: "Hii" },
    { task: "What is HTML?" },
    { task: "Compare the trade-offs of REST and GraphQL for a small team." },
    { task: "Make a study plan for learning Spanish in 30 days." },
    { task: "Write a function that debounces an input in JavaScript." },
    { task: "My React app crashes when I debug the useEffect hook; why does it fail?" },
    { task: "Describe this image.", images: ["data:image/png;base64,AAAA"] },
    {
      task: "Compare the two dashboards in the screenshot and analyze which trend is stronger, including trade-offs.",
      images: ["data:image/png;base64,AAAA"]
    }
  ];
  for (const entry of cases) {
    const plan = planFor(entry.task, { images: entry.images || [] });
    assert.equal(plan.ok, true, entry.task);
    const names = plan.models.map(name => name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `duplicate model in plan for: ${entry.task}`);
    assert.ok(plan.execution <= 3, "a plan never runs the whole installed set");
  }
});

test("the intent classifier is deterministic on the same request", () => {
  const first = classifyLocalIntent({ task: "What is 2+2?" });
  const second = classifyLocalIntent({ task: "What is 2+2?", history: [{ role: "user", content: "hi" }] });
  assert.equal(first.kind, "simple");
  assert.equal(second.kind, "simple");
});

test("routing is synchronous and does no I/O", () => {
  assert.doesNotMatch(routerSource, /\basync\b|\bawait\b/, "no asynchronous work in the router");
  assert.doesNotMatch(routerSource, /fetch\(|XMLHttpRequest|localStorage|setTimeout|navigator\./);
  const startedAt = Date.now();
  planFor("Hii");
  assert.ok(Date.now() - startedAt < 1000, "planning does not wait on anything");
});

test("planSummary stores only what is shown and bounded", () => {
  const plan = planFor("a".repeat(200));
  assert.equal(plan.ok, true);
  assert.equal(plan.taskPreview.length, LOCAL_ROUTER_LIMITS.maxTaskPreview);
  assert.ok(plan.taskPreview.endsWith("…"));
  const summary = planSummary(plan);
  assert.deepEqual(Object.keys(summary).sort(), [
    "attachments",
    "deliverable",
    "execution",
    "intent",
    "label",
    "notes",
    "objective",
    "reason",
    "skills",
    "stages",
    "taskPreview"
  ]);
  assert.ok(!("ok" in summary) && !("models" in summary) && !("error" in summary));
  assert.deepEqual(summary.stages.map(stage => stage.final), [true]);
  assert.equal(typeof summary.stages[0].detail, "string");
  assert.equal(summary.objective.length > 0, true);
  assert.equal(summary.attachments.images, 0);
  assert.equal(planSummary(null), null);
  assert.equal(planSummary({ ok: false }), null);
});

test("stage messages send the picture only to the vision stage", () => {
  const image = "data:image/png;base64,AAAA";
  const plan = planFor(
    "Compare the two dashboards in the screenshot and analyze which trend is stronger, including trade-offs.",
    { images: [image] }
  );
  const prior = [];
  for (const stage of plan.stages) {
    const messages = buildStageMessages({ stage, task: plan.taskPreview, images: [image], priorStages: prior });
    const userMessage = messages.find(message => message.content === plan.taskPreview);
    if (stage.role === "vision") {
      assert.deepEqual(userMessage.images, [image]);
    } else {
      assert.ok(messages.every(message => !message.images), `${stage.role} must not receive pixels`);
      assert.match(messages[0].content, /results|findings|earlier local step/i);
    }
    prior.push({ role: stage.role, model: stage.model, answer: `${stage.model} output` });
  }
});

test("stage messages bound history and earlier findings", () => {
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index} ${"h".repeat(3000)}`
  }));
  const messages = buildStageMessages({
    stage: { role: "chat", final: true },
    task: "The task",
    history,
    priorStages: [{ role: "reasoning", model: "r:1b", answer: "y".repeat(500) }],
    maxPriorChars: 100
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /final answering model/);
  const historyMessages = messages.filter(message => /^message \d+/.test(message.content));
  assert.equal(historyMessages.length, LOCAL_ROUTER_LIMITS.maxHistoryMessages);
  assert.equal(historyMessages[0].content.length, LOCAL_ROUTER_LIMITS.maxHistoryChars);
  assert.match(historyMessages.at(-1).content, /^message 19/);
  const notes = messages.at(-1).content;
  assert.ok(notes.includes("y".repeat(100)));
  assert.ok(!notes.includes("y".repeat(101)));
});

test("a task that is already the trailing history message is not sent twice", () => {
  const messages = buildStageMessages({
    stage: { role: "chat", final: true },
    task: "Same task",
    history: [{ role: "user", content: "Same task" }]
  });
  assert.equal(messages.length, 2, "system + the task once");
});

test("ChatPage routes combined local runs through the plan and restores the receipt", () => {
  assert.match(chatPageSource, /const combinedRouting = selectedRow\?\.combined\s*\? buildRoutingPlan\(\{/);
  assert.match(chatPageSource, /if \(combinedRouting && !combinedRouting\.ok\) \{/);
  assert.match(chatPageSource, /plan: routing,/);
  assert.match(chatPageSource, /saveLocalRouting\(assistantId, routingSummary, \{ owner: workspaceOwner \}\);/);
  const saveRouting = chatPageSource.indexOf("saveLocalRouting(assistantId");
  const begin = chatPageSource.indexOf("beginLocalRun({", saveRouting);
  assert.ok(saveRouting > 0 && begin > saveRouting, "the receipt is written before the run starts");
  assert.match(chatPageSource, /<LocalRoutingDetails plan=\{message\.localPlan\} \/>/);
  assert.match(chatPageSource, /const localPlan = routingMap\.get\(String\(message\.messageId\)\);/);
  assert.match(chatPageSource, /localPlan: routingSummary/);
  assert.match(
    chatPageSource,
    /const routingPreview = buildRoutingPlan\(\{[\s\S]*?if \(!routingPreview\.ok\) \{[\s\S]*?setNotice\(routingPreview\.error\);/,
    "the composer refuses only what the plan says cannot run"
  );
  assert.doesNotMatch(
    chatPageSource,
    /if \(images\.length > 0 && !localComboVision\)/,
    "an image alone no longer blocks a combined run"
  );
  assert.doesNotMatch(
    chatPageSource,
    /if \(imagePayload\.length > 0 && !localComboVision\)/,
    "the send path lets the router decide which models run"
  );
  assert.match(chatPageSource, /stage\.detail \? <span className="vr-msg-routing__detail">\{stage\.detail\}<\/span> : null/);
  assert.ok(chatPageSource.includes("Local chats take text for now."), "single local models stay text-only");
});

test("the Local AI page explains routing with the required wording and role chips", () => {
  assert.ok(
    localAiPageSource.includes(
      "Automatically selects the right installed local model for each task. Uses multiple models only when necessary."
    )
  );
  assert.ok(localAiPageSource.includes("Roles available here"));
  for (const role of ["Chat", "Reasoning", "Code", "Vision"]) {
    assert.ok(localAiPageSource.includes(`>${role}<`) || localAiPageSource.includes(`"${role}"`), `${role} is previewed`);
  }
});

// ── Persistence of the routing receipt ─────────────────────────────────────
function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: key => {
      entries.delete(key);
    },
    size: () => entries.size
  };
}

function withBrowserStorage(fn) {
  const previous = globalThis.window;
  const storage = memoryStorage();
  globalThis.window = { localStorage: storage };
  resetLocalRouting();
  resetLocalRuns();
  try {
    return fn(storage);
  } finally {
    resetLocalRouting();
    resetLocalRuns();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("the routing receipt survives a reload, is owner-scoped and bounded", () => {
  withBrowserStorage(() => {
    const plan = planFor("Compare the trade-offs of REST and GraphQL for a small team.");
    const summary = planSummary(plan);
    assert.equal(saveLocalRouting("assistant-1", summary, { owner: "owner-a" }), true);
    const restored = readLocalRouting("assistant-1", "owner-a");
    assert.equal(restored.intent, "complex");
    assert.equal(restored.label, "Reasoning → Chat");
    assert.deepEqual(restored.stages.map(stage => stage.model), ["qwen3:8b", "llama3.2:3b"]);
    assert.ok(restored.at > 0);
    assert.equal(restored.ok, undefined, "unshown internals are not stored");
    assert.equal(readLocalRouting("assistant-1", "owner-b"), null, "another account cannot read it");
    assert.equal(readLocalRoutingMap("owner-b").size, 0);

    for (let index = 0; index < 130; index += 1) {
      saveLocalRouting(`bulk-${index}`, summary, { owner: "owner-a" });
    }
    const raw = JSON.parse(globalThis.window.localStorage.getItem(LOCAL_ROUTING_STORAGE_KEY));
    assert.equal(Object.keys(raw).length, 120, "the log keeps a bounded number of receipts");
    assert.equal(readLocalRoutingMap("owner-a").size, 120);
    assert.equal(saveLocalRouting("", summary), false);
    assert.equal(saveLocalRouting("assistant-2", null), false);
  });
});

test("the run store carries the plan into its live record and its draft", () => {
  withBrowserStorage(() => {
    const plan = planSummary(planFor("Compare the trade-offs of REST and GraphQL for a small team."));
    const controller = { aborted: false, abort() { this.aborted = true; } };
    beginLocalRun({
      conversationId: "conv-1",
      assistantId: "assistant-1",
      label: plan.label,
      plan,
      controller,
      ownerId: "owner-a"
    });
    assert.deepEqual(getLocalRun("conv-1").plan, plan);
    noteLocalRunStage("conv-1", "partial answer");
    const draft = readLocalRunDraft("conv-1", "owner-a");
    assert.deepEqual(draft.plan, plan, "the draft a reopened document reads keeps the routing decision");
    assert.equal(draft.stage, "partial answer");
    assert.equal(readLocalRunDraft("conv-1", "owner-b"), null);

    finishLocalRun("conv-1", { status: LOCAL_RUN_STATES.DONE, content: "final", saved: true });
    assert.equal(readLocalRunDraft("conv-1", "owner-a"), null, "a saved answer clears the draft");
    assert.deepEqual(getLocalRun("conv-1").plan, plan, "the settled record still names the models");
  });
});
