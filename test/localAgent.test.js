import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_AGENT_TOOLS,
  claimsUnverifiedSuccess,
  desktopRequestOpensTerminal,
  looksLikeDesktopActionRequest,
  matchDesktopIntents,
  runLocalAgent
} from "../src/localai/localAgent.js";
import { chatLocalModel, chatLocalModelTurn } from "../src/localai/localRuntime.js";

const encoder = new TextEncoder();

function ndjsonResponse(events) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      }
    })
  };
}

function call(names) {
  return names.map(entry => ({ function: entry }));
}

// ── The app-side intent router ──────────────────────────────────────────────

test("the six brief requests route to the real native tool", () => {
  const one = request => matchDesktopIntents(request);

  assert.deepEqual(one("Heyy, open OpenCode in terminal."), [
    { tool: "open_terminal", args: { program: "OpenCode" }, reason: "Open OpenCode in a terminal" }
  ]);
  assert.deepEqual(one("Open Windows Terminal."), [
    { tool: "open_terminal", args: {}, reason: "Open a terminal window" }
  ]);
  assert.deepEqual(one("Open Notepad."), [
    { tool: "launch_app", args: { name: "Notepad" }, reason: "Launch Notepad" }
  ]);
  assert.deepEqual(one("Open Calculator."), [
    { tool: "launch_app", args: { name: "Calculator" }, reason: "Launch Calculator" }
  ]);
  assert.deepEqual(one("Open VS Code."), [
    {
      tool: "launch_app",
      args: { name: "Visual Studio Code" },
      reason: "Launch Visual Studio Code"
    }
  ]);
});

test("a current-project request carries the real workspace path into cwd", () => {
  const [intent] = matchDesktopIntents("Open OpenCode in terminal in my current project.", {
    workspaceRoot: "C:\\project\\Vups Router\\client"
  });
  assert.equal(intent.tool, "open_terminal");
  assert.deepEqual(intent.args, {
    program: "OpenCode",
    cwd: "C:\\project\\Vups Router\\client"
  });
});

test("paths and links are opened by the tools that accept them", () => {
  assert.deepEqual(matchDesktopIntents("Open C:\\work\\demo\\app.tsx"), [
    { tool: "open_path", args: { path: "C:\\work\\demo\\app.tsx" }, reason: "Open C:\\work\\demo\\app.tsx" }
  ]);
  assert.deepEqual(matchDesktopIntents("Open https://example.com"), [
    { tool: "open_url", args: { url: "https://example.com" }, reason: "Open https://example.com" }
  ]);
});

test("questions and vague requests are not turned into native calls", () => {
  assert.deepEqual(matchDesktopIntents("What is a terminal?"), []);
  assert.deepEqual(matchDesktopIntents("How do I open OpenCode in a terminal?"), []);
  assert.deepEqual(looksLikeDesktopActionRequest("Explain how Windows Terminal works."), false);
});

test("several explicit actions in one message are all routed", () => {
  const intents = matchDesktopIntents("Open Notepad and then open Calculator.");
  assert.deepEqual(
    intents.map(intent => intent.tool),
    ["launch_app", "launch_app"]
  );
  assert.deepEqual(
    intents.map(intent => intent.args.name),
    ["Notepad", "Calculator"]
  );
});

test("the advertised local tool list only names real native tools", () => {
  const names = LOCAL_AGENT_TOOLS.map(tool => tool.function.name);
  assert.ok(names.includes("open_terminal"));
  assert.ok(names.includes("launch_app"));
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    assert.match(name, /^[a-z0-9_]+$/);
  }
});

// ── The agent loop ──────────────────────────────────────────────────────────

const openTerminalResult = {
  ok: true,
  data: {
    terminal: "Windows Terminal",
    name: "OpenCode",
    resolvedExecutable: "C:\\Users\\tester\\AppData\\Roaming\\npm\\opencode.cmd",
    cwd: "C:\\work\\demo",
    programStarted: true,
    status: "opened"
  }
};

test("a model that only claims success still gets the real terminal call", async () => {
  const executed = [];
  const modelCalls = [];
  const replies = [
    { content: "Opened OpenCode successfully." },
    { content: "OpenCode is running in a new Windows Terminal window." }
  ];
  const result = await runLocalAgent({
    model: "llama3.2:3b",
    messages: [{ role: "user", content: "Heyy, open OpenCode in terminal." }],
    task: "Heyy, open OpenCode in terminal.",
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async (name, options) => {
      modelCalls.push(options);
      return replies.shift() || { content: "" };
    }
  });

  assert.equal(executed.length, 1);
  assert.equal(executed[0].tool, "open_terminal");
  assert.deepEqual(executed[0].args, { program: "OpenCode" });
  assert.equal(modelCalls[0].tools.length, LOCAL_AGENT_TOOLS.length);
  const toolMessage = modelCalls[1].messages.find(message => message.role === "tool");
  assert.ok(toolMessage, "the model is given the native result before it answers");
  assert.equal(JSON.parse(toolMessage.content).ok, true);
  assert.equal(result.usedRouter, true);
  assert.match(result.content, /Tool result — Opening a terminal:/);
  assert.match(result.content, /OpenCode/);
});

test("a structured tool call is executed and its result is fed back", async () => {
  const executed = [];
  const modelCalls = [];
  const replies = [
    { content: "", toolCalls: call([{ name: "open_terminal", arguments: '{"program":"opencode"}' }]) },
    { content: "OpenCode is open." }
  ];
  const result = await runLocalAgent({
    model: "qwen2.5:7b",
    messages: [{ role: "user", content: "Open OpenCode in terminal." }],
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async (name, options) => {
      modelCalls.push(options);
      return replies.shift() || { content: "" };
    }
  });

  assert.deepEqual(executed, [{ tool: "open_terminal", args: { program: "opencode" } }]);
  const assistant = modelCalls[1].messages.find(
    message => message.role === "assistant" && Array.isArray(message.tool_calls)
  );
  assert.ok(assistant, "the call is recorded as an assistant tool_calls turn");
  assert.equal(result.steps[0].ok, true);
  assert.match(result.content, /Tool result — Opening a terminal:/);
});

test("an invented home folder never reaches the native layer as cwd", async () => {
  const executed = [];
  let calls = 0;
  const result = await runLocalAgent({
    model: "gemma4:e4b",
    messages: [{ role: "user", content: "Heyy, open OpenCode in terminal." }],
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          toolCalls: call([
            {
              name: "open_terminal",
              arguments:
                '{"program":"opencode","cwd":"C:\\\\Users\\\\username\\\\Documents\\\\Current Project"}'
            }
          ])
        };
      }
      return { content: "OpenCode is open." };
    }
  });

  assert.deepEqual(executed, [{ tool: "open_terminal", args: { program: "opencode" } }]);
  assert.equal(result.steps[0].ok, true);
});

test("a current-project request uses the bound folder, not a guessed one", async () => {
  const executed = [];
  let calls = 0;
  const workspaceRoot = "C:\\project\\Vups Router\\client";
  await runLocalAgent({
    model: "gemma4:e4b",
    messages: [{ role: "user", content: "Open OpenCode in terminal in my current project." }],
    workspaceRoot,
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          toolCalls: call([
            {
              name: "open_terminal",
              arguments:
                '{"program":"opencode","cwd":"C:\\\\Users\\\\username\\\\Documents\\\\Current Project"}'
            }
          ])
        };
      }
      return { content: "OpenCode is open." };
    }
  });

  assert.deepEqual(executed, [{ tool: "open_terminal", args: { program: "opencode", cwd: workspaceRoot } }]);
});

test("a folder the user typed is kept for the terminal", async () => {
  const executed = [];
  let calls = 0;
  await runLocalAgent({
    model: "gemma4:e4b",
    messages: [{ role: "user", content: "Open OpenCode in terminal in C:\\work\\demo" }],
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          toolCalls: call([
            { name: "open_terminal", arguments: '{"program":"opencode","cwd":"C:\\\\work\\\\demo"}' }
          ])
        };
      }
      return { content: "OpenCode is open." };
    }
  });

  assert.deepEqual(executed, [{ tool: "open_terminal", args: { program: "opencode", cwd: "C:\\work\\demo" } }]);
});

test("a plain terminal request in a bound chat runs in the bound folder", async () => {
  const executed = [];
  let calls = 0;
  const workspaceRoot = "C:\\Users\\Vishnu\\Documents\\VupsRouter\\games";
  await runLocalAgent({
    model: "gemma4:e4b",
    messages: [{ role: "user", content: "Open OpenCode in terminal." }],
    workspaceRoot,
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          toolCalls: call([{ name: "open_terminal", arguments: '{"program":"opencode"}' }])
        };
      }
      return { content: "OpenCode is open." };
    }
  });

  assert.deepEqual(executed, [
    { tool: "open_terminal", args: { program: "opencode", cwd: workspaceRoot } }
  ]);
});

test("the folder prompt is requested only for a terminal action", () => {
  assert.equal(desktopRequestOpensTerminal("Heyy, open OpenCode in terminal."), true);
  assert.equal(desktopRequestOpensTerminal("Open Windows Terminal."), true);
  assert.equal(desktopRequestOpensTerminal("Open Notepad."), false);
  assert.equal(desktopRequestOpensTerminal("How do I open OpenCode in a terminal?"), false);
});

test("a runtime without tool support is routed by the app, not given up on", async () => {
  const executed = [];
  const modelCalls = [];
  const unsupported = new Error("This model does not support tool calls.");
  unsupported.code = "tool_calling_unsupported";
  const result = await runLocalAgent({
    model: "llama2:7b",
    messages: [{ role: "user", content: "Open Windows Terminal." }],
    executeTool: async (tool, args) => {
      executed.push({ tool, args });
      return openTerminalResult;
    },
    callModel: async (name, options) => {
      modelCalls.push(options);
      if (modelCalls.length === 1) throw unsupported;
      return { content: "A terminal window was opened." };
    }
  });

  assert.equal(modelCalls[0].tools.length, LOCAL_AGENT_TOOLS.length);
  assert.equal(modelCalls[1].tools, undefined);
  assert.deepEqual(executed, [{ tool: "open_terminal", args: {} }]);
  assert.match(result.content, /Tool result — Opening a terminal:/);
});

test("a fabricated success after a real failure is replaced by the failure", async () => {
  const replies = [
    { content: "Opened OpenCode successfully." },
    { content: "Opened successfully." }
  ];
  const result = await runLocalAgent({
    model: "llama3.2:3b",
    messages: [{ role: "user", content: "Open OpenCode in terminal." }],
    executeTool: async () => ({
      ok: false,
      error: { code: "program_not_found", message: "opencode was not found on PATH." }
    }),
    callModel: async () => replies.shift() || { content: "" }
  });

  assert.match(result.content, /^I did not run that action/);
  assert.match(result.content, /program_not_found|not found on PATH/);
  assert.doesNotMatch(result.content, /^Opened successfully/);
  assert.equal(result.steps[0].ok, false);
});

test("the guard recognizes the success sentences this bug produced", () => {
  assert.equal(claimsUnverifiedSuccess("Opened successfully."), true);
  assert.equal(claimsUnverifiedSuccess("I have successfully opened OpenCode in the terminal."), true);
  assert.equal(claimsUnverifiedSuccess("The terminal has been opened."), true);
  assert.equal(claimsUnverifiedSuccess("Here is how to open a terminal."), false);
});

test("an endless tool loop is stopped instead of running forever", async () => {
  let executed = 0;
  await assert.rejects(
    runLocalAgent({
      model: "llama3.2:3b",
      messages: [{ role: "user", content: "Open Notepad." }],
      maxSteps: 2,
      executeTool: async () => {
        executed += 1;
        return { ok: true, data: { name: "Notepad", pid: 10, running: true } };
      },
      callModel: async () => ({
        content: "",
        toolCalls: call([{ name: "launch_app", arguments: { name: "Notepad" } }])
      })
    }),
    error => error.code === "local_agent_step_limit"
  );
  assert.equal(executed, 2);
});

test("stop aborts before another native call is made", async () => {
  const controller = new AbortController();
  controller.abort();
  let executed = 0;
  await assert.rejects(
    runLocalAgent({
      model: "llama3.2:3b",
      messages: [{ role: "user", content: "Open Notepad." }],
      signal: controller.signal,
      executeTool: async () => {
        executed += 1;
        return { ok: true, data: {} };
      },
      callModel: async () => ({ content: "" })
    }),
    error => error.name === "AbortError"
  );
  assert.equal(executed, 0);
});

// ── The Ollama transport ────────────────────────────────────────────────────

test("tool calls are parsed from the runtime stream and tools are sent", async () => {
  const toolCalls = [{ function: { name: "open_terminal", arguments: { program: "opencode" } } }];
  let sent = null;
  const turn = await chatLocalModelTurn("llama3.2:3b", {
    messages: [{ role: "user", content: "Open OpenCode." }],
    tools: [{ type: "function", function: { name: "open_terminal", parameters: {} } }],
    request: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return ndjsonResponse([
        { message: { content: "", tool_calls: toolCalls } },
        { message: { content: "" }, done: true }
      ]);
    }
  });

  assert.equal(sent.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(sent.body.tools.length, 1);
  assert.deepEqual(turn.toolCalls, toolCalls);
  assert.equal(turn.content, "");
});

test("a runtime that rejects tools is reported as tool_calling_unsupported", async () => {
  await assert.rejects(
    chatLocalModelTurn("llama2:7b", {
      messages: [{ role: "user", content: "Open OpenCode." }],
      tools: [{ type: "function", function: { name: "open_terminal", parameters: {} } }],
      request: async () => ({
        ok: false,
        status: 400,
        text: async () => "registry.ollama.ai/library/llama2:latest does not support tools"
      })
    }),
    error => error.code === "tool_calling_unsupported"
  );
});

test("an invalid local model keeps the runtime's useful error", async () => {
  await assert.rejects(
    chatLocalModelTurn("missing:latest", {
      messages: [{ role: "user", content: "hello" }],
      request: async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: "model 'missing:latest' not found" })
      })
    }),
    error => error.message === "model 'missing:latest' not found"
  );
});

test("a plain turn still returns text and sends no tools field", async () => {
  let body = null;
  const answer = await chatLocalModel("llama3.2:3b", {
    messages: [{ role: "user", content: "hello" }],
    request: async (url, init) => {
      body = JSON.parse(init.body);
      return ndjsonResponse([{ message: { content: "hi" } }, { message: { content: " there" } }]);
    }
  });
  assert.equal(answer, "hi there");
  assert.equal(body.tools, undefined);
});

test("slow reasoning records thinking progress without leaking it into the answer", async () => {
  const thoughts = [];
  const chunks = [];
  const answer = await chatLocalModel("qwen3:8b", {
    messages: [{ role: "user", content: "Reply exactly READY" }],
    onThought: piece => thoughts.push(piece),
    onChunk: piece => chunks.push(piece),
    request: async () => ndjsonResponse([
      { message: { role: "assistant", content: "", thinking: "first" } },
      { message: { role: "assistant", content: "", thinking: " second" } },
      { message: { role: "assistant", content: "READY" }, done: true }
    ])
  });
  assert.deepEqual(thoughts, ["first", " second"]);
  assert.deepEqual(chunks, ["READY"]);
  assert.equal(answer, "READY");
});

test("the local transport flushes an Ollama record that has no trailing newline", async () => {
  const answer = await chatLocalModel("llama3.2:3b", {
    messages: [{ role: "user", content: "hello" }],
    request: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "hello" }, done: true })));
          controller.close();
        }
      })
    })
  });
  assert.equal(answer, "hello");
});
