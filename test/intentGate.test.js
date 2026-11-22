import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyRequestIntent,
  requestAllowsTools,
  toolAllowedForRequest,
  toolCallSignature,
  toolDenial
} from "../src/localai/intentGate.js";
import { runLocalAgent } from "../src/localai/localAgent.js";
import { runDesktopToolChat } from "../src/services/desktopChat.js";
import { apiClient } from "../src/services/api.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function call(name, args) {
  return [{ function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args || {}) } }];
}

// ── The classification itself ───────────────────────────────────────────────

test("greetings, explanations and ordinary code requests need no tool at all", () => {
  const noAction = [
    "Hii",
    "Hello",
    "hey there",
    "thanks",
    "ok",
    "Explain Python",
    "What is React?",
    "How do I open OpenCode in a terminal?",
    "Help me understand this error",
    "Write a simple JavaScript function",
    "Build a REST API for me",
    "Describe how closures work",
    "Compare the trade-offs and architecture of this complex system step by step",
    "Analyze the design and summarize the result",
    "Calculate 25 multiplied by 48",
    ""
  ];
  for (const request of noAction) {
    assert.equal(classifyRequestIntent(request), "none", JSON.stringify(request));
    assert.equal(requestAllowsTools(request), false, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("open_terminal", request), false, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("read_file", request), false, JSON.stringify(request));
  }
});

test("an explicit local action is allowed every tool it needs", () => {
  const actions = [
    "Open OpenCode in my project",
    "Open Windows Terminal.",
    "Create a file in my project",
    "Run my project",
    "Open C:\\work\\demo",
    "Create index.html, style.css and script.js in C:\\Users\\test\\site.",
    "List the files under C:\\Users\\test.",
    "Read the missing file for me.",
    "Take a look at the folder for me.",
    "find my 5 latest downloaded files",
    "Can you find my Qoder folder and give me that path?",
    "Run write_file."
  ];
  for (const request of actions) {
    assert.equal(classifyRequestIntent(request), "action", JSON.stringify(request));
    assert.equal(toolAllowedForRequest("open_terminal", request), true, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("write_file", request), true, JSON.stringify(request));
  }
});

test("a question about something on disk may read it but may not start or change anything", () => {
  const inspect = [
    "What files are in my project folder?",
    "Where is my project?",
    "Which folder holds the repository?"
  ];
  for (const request of inspect) {
    assert.equal(classifyRequestIntent(request), "inspect", JSON.stringify(request));
    assert.equal(toolAllowedForRequest("read_file", request), true, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("list_directory", request), true, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("open_terminal", request), false, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("run_command", request), false, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("write_file", request), false, JSON.stringify(request));
    assert.equal(toolAllowedForRequest("delete_path", request), false, JSON.stringify(request));
  }
});

test("the refusal names the tool and says nothing was run", () => {
  const denial = toolDenial("open_terminal", "Hii");
  assert.equal(denial.code, "not_requested");
  assert.match(denial.message, /open_terminal/);
  assert.match(denial.message, /does not ask for any action/);

  const question = toolDenial("open_terminal", "What files are in my project folder?");
  assert.equal(question.code, "not_requested");
  assert.match(question.message, /only asks a question/);
});

test("a failed attempt keeps one signature no matter how the keys are ordered", () => {
  assert.equal(
    toolCallSignature("open_terminal", { program: "opencode", cwd: "C:\\x" }),
    toolCallSignature("open_terminal", { cwd: "C:\\x", program: "opencode" })
  );
  assert.notEqual(
    toolCallSignature("open_terminal", { program: "opencode" }),
    toolCallSignature("open_terminal", { program: "code" })
  );
});

// ── The local agent loop ────────────────────────────────────────────────────

async function agentTurn(request, { onExecute, replies = [] } = {}) {
  const executed = [];
  const modelCalls = [];
  const queue = [...replies];
  const result = await runLocalAgent({
    model: "llama3.2:3b",
    messages: [{ role: "user", content: request }],
    task: request,
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      if (onExecute) return await onExecute(tool, args);
      return { ok: true, data: {} };
    },
    callModel: async (name, options) => {
      modelCalls.push(options);
      if (queue.length) return queue.shift();
      // A stub model that wants a terminal whatever it was asked.
      return { content: "", toolCalls: call("open_terminal", { program: "opencode" }) };
    }
  });
  return { result, executed, modelCalls };
}

test("a greeting is not offered the tool list and never runs a tool", async () => {
  const { executed, modelCalls } = await agentTurn("Hii", {
    replies: [{ content: "Hello! How can I help you today?" }]
  });

  assert.equal(modelCalls[0].tools, undefined, "a greeting is not offered any tool");
  assert.equal(executed.length, 0, "no native call is made");
});

test("an explanation or a plain code request runs no tool either", async () => {
  for (const request of ["Explain Python", "Write a simple JavaScript function", "Help me understand this error"]) {
    const { executed, modelCalls } = await agentTurn(request, {
      replies: [{ content: "Here is the answer." }]
    });
    assert.equal(modelCalls[0].tools, undefined, request);
    assert.equal(executed.length, 0, request);
  }
});

test("a model that calls a terminal for a greeting is refused before the native layer", async () => {
  const { executed, result } = await agentTurn("Hello", {
    onExecute: async () => {
      throw new Error("the native layer must not be reached");
    },
    replies: [
      { content: "", toolCalls: call("open_terminal", { program: "opencode" }) },
      { content: "Hello! What can I do for you?" }
    ]
  });

  assert.equal(executed.length, 0, "the native layer was never called");
  assert.match(result.content, /What can I do for you/);
  assert.doesNotMatch(result.content, /Tool result/);
});

test("an explicit terminal request still runs the real tool", async () => {
  const { executed } = await agentTurn("Open OpenCode in terminal.", {
    replies: [
      { content: "", toolCalls: call("open_terminal", { program: "opencode" }) },
      { content: "OpenCode is open." }
    ],
    onExecute: async () => ({ ok: true, data: { terminal: "Windows Terminal", name: "OpenCode" } })
  });

  assert.deepEqual(
    executed.map(entry => entry.tool),
    ["open_terminal"]
  );
});

test("the same failing call is not executed a second time in one run", async () => {
  const executed = [];
  const replies = [
    { content: "", toolCalls: call("open_terminal", { program: "opencode" }) },
    { content: "", toolCalls: call("open_terminal", { program: "opencode" }) },
    { content: "It could not open." }
  ];
  const result = await runLocalAgent({
    model: "llama3.2:3b",
    messages: [{ role: "user", content: "Open OpenCode in terminal." }],
    task: "Open OpenCode in terminal.",
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return { ok: false, error: { code: "no_workspace", message: "No project folder is selected for this chat." } };
    },
    callModel: async () => replies.shift()
  });

  assert.equal(executed.length, 1, "the broken attempt runs once");
  assert.equal(result.steps.length, 2, "the second attempt is still answered, with a refusal");
  assert.equal(result.steps[1].ok, false);
  assert.equal(result.steps[1].result.error.code, "repeat_blocked");
  assert.match(result.steps[1].result.error.message, /already failed/);
});

// ── The cloud tool loop ─────────────────────────────────────────────────────

function stubServer(replies) {
  const posted = [];
  const original = apiClient.post;
  apiClient.post = async (url, body) => {
    posted.push({ url, body });
    const reply = replies[posted.length - 1];
    if (!reply) throw new Error(`unexpected request ${posted.length}`);
    return { data: reply };
  };
  return {
    posted,
    restore: () => {
      apiClient.post = original;
    }
  };
}

const TERMINAL_ROUND = {
  type: "tool_calls",
  toolCalls: [{ id: "c1", type: "function", function: { name: "open_terminal", arguments: '{"program":"opencode"}' } }],
  assistantMessage: { role: "assistant", content: null }
};

test("a greeting sent through the cloud tool loop never starts a terminal", async () => {
  const server = stubServer([TERMINAL_ROUND, { type: "final", content: "Hello!", message: { messageId: "m1" } }]);
  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Hii" }],
      userText: "Hii",
      executeTool: async () => {
        throw new Error("the native layer must not be reached");
      }
    });

    assert.equal(server.posted.length, 2, "the turn still finishes");
    const toolMessage = server.posted[1].body.messages.at(-1);
    assert.equal(toolMessage.role, "tool");
    assert.match(toolMessage.content, /not_requested/);
    assert.equal(result.localSteps, undefined, "no operation ran, so no step is recorded");
    assert.equal(result.content, "Hello!");
  } finally {
    server.restore();
  }
});

test("the cloud tool loop refuses the same failed call instead of running it twice", async () => {
  const executed = [];
  const server = stubServer([
    TERMINAL_ROUND,
    TERMINAL_ROUND,
    { type: "final", content: "It could not open.", message: { messageId: "m2" } }
  ]);
  try {
    await runDesktopToolChat({
      messages: [{ role: "user", content: "Open OpenCode in terminal." }],
      userText: "Open OpenCode in terminal.",
      executeTool: async (tool, args) => {
        executed.push({ tool, args });
        return { ok: false, error: { code: "no_workspace", message: "No project folder is selected for this chat." } };
      }
    });

    assert.equal(executed.length, 1, "the native layer is asked once");
    const second = server.posted[1].body.messages.at(-1);
    assert.equal(second.role, "tool");
    assert.match(second.content, /repeat_blocked/);
  } finally {
    server.restore();
  }
});

// ── The wiring cannot silently drift back ───────────────────────────────────

test("both tool loops import the same deterministic gate", () => {
  const agentSource = read("../src/localai/localAgent.js");
  const chatSource = read("../src/services/desktopChat.js");

  assert.match(agentSource, /requestAllowsTools\(requestText\)/);
  assert.match(agentSource, /toolAllowedForRequest\(tool, requestText\)/);
  assert.match(agentSource, /const intents = gateAllows \? matchDesktopIntents/);

  assert.match(chatSource, /toolAllowedForRequest\(name, gateText\)/);
  assert.match(chatSource, /toolCallSignature\(name, args\)/);
  assert.doesNotMatch(chatSource, /isSimpleText/, "the old one-line text sniff is gone");
});

test("the gate is pure and never touches the network, the DOM or the model", () => {
  const source = read("../src/localai/intentGate.js");
  assert.doesNotMatch(source, /fetch|localStorage|window\.|document\./);
  assert.equal(classifyRequestIntent("Hii"), classifyRequestIntent("Hii"));
});
