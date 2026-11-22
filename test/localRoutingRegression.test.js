import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildRoutingPlan,
  buildStageMessages,
  planSummary
} from "../src/localai/localRouter.js";
import { runLocalCombo } from "../src/localai/localComboRun.js";
import {
  readLocalRouting,
  resetLocalRouting,
  saveLocalRouting
} from "../src/localai/localRoutingLog.js";

// The real installed set this machine reports through /api/tags, with the
// capability flags the runtime states for each model.
const MODELS = [
  { name: "gemma4:e4b", capabilities: ["completion", "tools", "vision", "audio", "thinking"] },
  { name: "qwen2.5vl:7b", capabilities: ["completion", "vision"] },
  { name: "qwen2.5-coder:7b", capabilities: ["completion", "tools", "insert", "coding"] },
  { name: "llama3.2:3b", capabilities: ["completion"] },
  { name: "qwen3:8b", capabilities: ["completion", "thinking"] }
];

const IMAGE = "data:image/png;base64,AAAA";
const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function planFor(task, extra = {}) {
  return buildRoutingPlan({ task, models: MODELS, ...extra });
}

function rolesOf(plan) {
  return plan.stages.map(stage => stage.role);
}

function modelsOf(plan) {
  return plan.stages.map(stage => stage.model);
}

test("RS-01 a text game request runs the coding model only", () => {
  const plan = planFor("Create a simple playable Snake game.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding");
  assert.equal(plan.deliverable, "code");
  assert.deepEqual(rolesOf(plan), ["coding"]);
  assert.deepEqual(modelsOf(plan), ["qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 1);
  assert.equal(plan.stages[0].final, true);
});

test("RS-02 a game request with a reference image runs vision then code", () => {
  const plan = planFor("Create a playable game with a similar visual design.", { images: [IMAGE] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-coding");
  assert.equal(plan.attachments.images, 1);
  assert.equal(plan.attachments.relevant, true);
  assert.deepEqual(rolesOf(plan), ["vision", "coding"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b", "qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 2, "Vision → Code is exactly two calls");
  assert.equal(plan.stages.at(-1).final, true);
  assert.match(plan.stages[0].detail, /reference image/i);
  assert.match(plan.stages[1].detail, /implementation/i);
});

test("RS-03 a question about the image runs the vision model", () => {
  const plan = planFor("What is this picture?", { images: [IMAGE] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-simple");
  assert.deepEqual(rolesOf(plan), ["vision"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b"]);
  assert.equal(plan.execution, 1);
});

test("RS-04 a website built from a screenshot runs vision then code", () => {
  const plan = planFor("Build this website from this screenshot.", { images: [IMAGE] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-coding");
  assert.equal(plan.attachments.essential, true, "the layout only exists in the screenshot");
  assert.deepEqual(rolesOf(plan), ["vision", "coding"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b", "qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 2);
});

test("RS-05 a chess game built from a screenshot runs vision then code", () => {
  const plan = planFor("Create a chess game from this screenshot.", { images: [IMAGE] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "image-coding");
  assert.equal(plan.attachments.essential, true);
  assert.deepEqual(rolesOf(plan), ["vision", "coding"]);
  assert.deepEqual(modelsOf(plan), ["gemma4:e4b", "qwen2.5-coder:7b"]);
});

test("RS-06 a JavaScript function runs code only", () => {
  const plan = planFor("Write a JavaScript function that reverses a string.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding");
  assert.deepEqual(rolesOf(plan), ["coding"]);
  assert.deepEqual(modelsOf(plan), ["qwen2.5-coder:7b"]);
});

test("RS-07 a complex app build runs reasoning then code", () => {
  const plan = planFor("Build a website and explain its architecture.");
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "coding-complex");
  assert.deepEqual(rolesOf(plan), ["reasoning", "coding"]);
  assert.deepEqual(modelsOf(plan), ["qwen3:8b", "qwen2.5-coder:7b"]);
  assert.equal(plan.execution, 2);
});

test("RS-08 a greeting with an irrelevant image stays a chat", () => {
  const plan = planFor("Hi", { images: [IMAGE] });
  assert.equal(plan.ok, true);
  assert.equal(plan.intent, "greeting");
  assert.equal(plan.attachments.relevant, false);
  assert.deepEqual(rolesOf(plan), ["chat"]);
  assert.deepEqual(modelsOf(plan), ["llama3.2:3b"]);
  assert.equal(plan.execution, 1);
  assert.ok(plan.notes.some(note => /image was not used/i.test(note)));
});

test("RS-09 a missing coding model is an honest error, never a vision-only fake", () => {
  const noCoderModels = MODELS.filter(model => model.name !== "qwen2.5-coder:7b");
  const text = planFor("Create a game.", { models: noCoderModels });
  assert.equal(text.ok, false);
  assert.equal(text.stages.length, 0);
  assert.match(text.error, /coding-capable model/i);

  const image = planFor("Create a game using this reference image.", {
    images: [IMAGE],
    models: noCoderModels
  });
  assert.equal(image.ok, false, "the vision model is not allowed to pretend it can implement the game");
  assert.equal(image.stages.length, 0);
  assert.match(image.error, /coding-capable model/i);
  assert.doesNotMatch(image.error, /^None of the selected installed local models can read images/);
});

test("RS-10 a missing vision model only blocks code when the image is essential", () => {
  const noVisionModels = MODELS.filter(
    model => model.name !== "gemma4:e4b" && model.name !== "qwen2.5vl:7b"
  );
  const reference = planFor("Create a playable game with a similar visual design.", {
    images: [IMAGE],
    models: noVisionModels
  });
  assert.equal(reference.ok, true, "the game can still be built from the text");
  assert.deepEqual(rolesOf(reference), ["coding"]);
  assert.deepEqual(modelsOf(reference), ["qwen2.5-coder:7b"]);
  assert.ok(reference.notes.some(note => /image was not used/i.test(note)));
  assert.match(reference.reason, /cannot read the image|No selected model can read the image/i);

  const essential = planFor("Build this website from this screenshot.", {
    images: [IMAGE],
    models: noVisionModels
  });
  assert.equal(essential.ok, false, "the layout is only in the screenshot");
  assert.equal(essential.stages.length, 0);
  assert.match(essential.error, /needs the attached image read/i);
  assert.match(essential.error, /vision model on the Local AI page/i);
});

test("RS-11 no plan repeats a model, adds a synthesis role, or runs the whole set", () => {
  const cases = [
    { task: "Hii" },
    { task: "What is this picture?", images: [IMAGE] },
    { task: "Explain this screenshot.", images: [IMAGE] },
    { task: "Compare the two dashboards and analyze their trade-offs.", images: [IMAGE] },
    { task: "Create a simple playable Snake game." },
    { task: "Create a playable game with a similar visual design.", images: [IMAGE] },
    { task: "Build this website from this screenshot.", images: [IMAGE] },
    { task: "Build a website and explain its architecture." },
    { task: "Debug this code using the attached screenshot.", images: [IMAGE] },
    { task: "Write a JavaScript function that reverses a string." },
    { task: "Plan a complex software architecture." },
    { task: "Generate a complex application with several requirements." }
  ];
  for (const entry of cases) {
    const plan = planFor(entry.task, { images: entry.images || [] });
    assert.equal(plan.ok, true, entry.task);
    const names = plan.models.map(name => name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `duplicate model: ${entry.task}`);
    assert.ok(!rolesOf(plan).includes("synthesis"), `no synthesis role: ${entry.task}`);
    assert.ok(plan.execution <= 3, `not every installed model: ${entry.task}`);
    assert.equal(plan.execution, plan.stages.length);
    assert.equal(plan.stages.filter(stage => stage.final).length, 1);
    assert.equal(plan.stages.at(-1).final, true);
  }
});

test("RS-12 stages run one at a time and only the final answer is returned", async () => {
  const plan = planFor("Create a playable game with a similar visual design.", { images: [IMAGE] });
  const calls = [];
  const events = [];
  let active = 0;
  let maxActive = 0;
  const result = await runLocalCombo({
    models: MODELS,
    task: "Create a playable game with a similar visual design.",
    images: [IMAGE],
    plan,
    callModel: async (name, { messages }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({
        name,
        sawImage: messages.some(message => Array.isArray(message.images) && message.images.length > 0)
      });
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (name === "gemma4:e4b") return "The reference shows a dark board with orange tiles.";
      return "```html index.html\n<!doctype html><html><body><canvas id=\"game\"></canvas></body></html>\n```";
    },
    onEvent: event => events.push(event)
  });
  assert.deepEqual(calls.map(call => call.name), ["gemma4:e4b", "qwen2.5-coder:7b"]);
  assert.equal(maxActive, 1, "no two stages are ever in flight together");
  assert.equal(calls.length, plan.execution, "one call per planned stage, with no synthesis request");
  assert.equal(calls[0].sawImage, true);
  assert.equal(calls[1].sawImage, false);
  assert.match(result.finalAnswer, /<canvas id="game">/);
  assert.deepEqual(result.usedModels, ["gemma4:e4b", "qwen2.5-coder:7b"]);
  assert.deepEqual(
    events.filter(event => event.type === "stage-start").map(event => event.role),
    ["vision", "coding"]
  );
  assert.equal(events.at(-1).type, "stage-done");
  assert.equal(events.at(-1).final, true);
});

test("RS-13 the image reaches only the vision stage", () => {
  const plan = planFor("Build this website from this screenshot.", { images: [IMAGE] });
  const prior = [];
  for (const stage of plan.stages) {
    const messages = buildStageMessages({
      stage,
      task: "Build this website from this screenshot.",
      images: [IMAGE],
      priorStages: prior
    });
    const taskMessage = messages.find(
      message => message.content === "Build this website from this screenshot."
    );
    if (stage.role === "vision") {
      assert.deepEqual(taskMessage.images, [IMAGE]);
    } else {
      assert.ok(messages.every(message => !message.images), `${stage.role} must not receive pixels`);
      assert.match(messages.at(-1).content, /earlier local steps/i);
      assert.match(messages.at(-1).content, /layout|orange|dark/i, "the coding stage sees the visual findings");
    }
    prior.push({ role: stage.role, model: stage.model, answer: "The reference shows a dark header with an orange CTA." });
  }
});

test("RS-14 the final stage keeps the original request and bounded findings", () => {
  const plan = planFor("Generate a complex application with several requirements.");
  const last = plan.stages.at(-1);
  const messages = buildStageMessages({
    stage: last,
    task: "Generate a complex application with several requirements.",
    history: Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history ${index} ${"h".repeat(2500)}`
    })),
    priorStages: [
      { role: "reasoning", model: "qwen3:8b", answer: "plan ".repeat(1200) }
    ]
  });
  const taskMessage = messages.find(
    message => message.content === "Generate a complex application with several requirements."
  );
  assert.ok(taskMessage, "the final stage receives the original request verbatim");
  const findings = messages.at(-1).content;
  assert.match(findings, /earlier local steps/i);
  assert.ok(findings.length < 4000, "earlier findings are bounded");
  assert.match(messages[0].content, /complete working source|fenced code block/i);
  assert.match(messages[0].content, /file path/i);
  const historyMessages = messages.filter(message => /^history \d+/.test(message.content));
  assert.equal(historyMessages.length, 12);
  assert.equal(historyMessages[0].content.length, 2000);
});

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => {
      entries.set(key, String(value));
    },
    removeItem: key => {
      entries.delete(key);
    }
  };
}

test("RS-15 the plan, stage details and saved answer survive a chat switch", () => {
  const previous = globalThis.window;
  const storage = memoryStorage();
  globalThis.window = { localStorage: storage };
  resetLocalRouting();
  try {
    const plan = planFor("Create a playable game with a similar visual design.", { images: [IMAGE] });
    assert.equal(plan.ok, true);
    const summary = planSummary(plan);
    assert.equal(summary.label, "Vision → Code");
    assert.equal(summary.objective.length > 0, true);
    assert.equal(summary.attachments.images, 1);
    assert.deepEqual(summary.stages.map(stage => stage.detail), [
      "Read the reference image",
      "Wrote the implementation"
    ]);
    assert.equal(saveLocalRouting("assistant-1", summary, { owner: "owner-a" }), true);
    const restored = readLocalRouting("assistant-1", "owner-a");
    assert.equal(restored.label, "Vision → Code");
    assert.equal(restored.stages.at(-1).detail, "Wrote the implementation");
    assert.equal(readLocalRouting("assistant-1", "owner-b"), null);
  } finally {
    resetLocalRouting();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }

  // The run is navigation-independent: the final answer is written to the
  // native store before the run is marked done, and the plan travels with it.
  const comboDone = chatPageSource.indexOf("const savedAnswer = useNativeStore", chatPageSource.indexOf("runLocalCombo"));
  const comboFinish = chatPageSource.indexOf("finishLocalRun(localConversationId", comboDone);
  assert.ok(comboDone > 0 && comboFinish > comboDone);
  const persisted = chatPageSource.slice(comboDone, comboFinish);
  assert.match(persisted, /appendNativeLocalChatMessage\(/);
  assert.match(persisted, /plan: routingSummary/);
  assert.match(chatPageSource, /serverOwnedTurnRef\.current = true;/);
});

test("the rest of the intent table routes exactly as specified", () => {
  const cases = [
    { task: "Explain this screenshot.", images: [IMAGE], intent: "image", roles: ["vision", "chat"] },
    { task: "Plan a complex software architecture.", intent: "planning", roles: ["reasoning", "chat"] },
    {
      task: "Generate a complex application with several requirements.",
      intent: "coding-complex",
      roles: ["reasoning", "coding"]
    },
    {
      task: "Analyze an image and answer a simple question.",
      images: [IMAGE],
      intent: "image",
      roles: ["vision", "chat"]
    },
    {
      task: "Create an app from this UI reference.",
      images: [IMAGE],
      intent: "image-coding",
      roles: ["vision", "reasoning", "coding"]
    },
    {
      task: "Debug this code using the attached screenshot.",
      images: [IMAGE],
      intent: "image-coding-complex",
      roles: ["vision", "reasoning", "coding"]
    },
    {
      task: "Compare the two dashboards in the screenshot and analyze the trade-offs.",
      images: [IMAGE],
      intent: "image",
      roles: ["vision", "reasoning", "chat"]
    }
  ];
  for (const entry of cases) {
    const plan = planFor(entry.task, { images: entry.images || [] });
    assert.equal(plan.ok, true, entry.task);
    assert.equal(plan.intent, entry.intent, entry.task);
    assert.deepEqual(rolesOf(plan), entry.roles, entry.task);
  }
});
