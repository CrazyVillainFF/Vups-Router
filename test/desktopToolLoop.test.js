import test from "node:test";
import assert from "node:assert/strict";

import { apiClient } from "../src/services/api.js";
import { runDesktopToolChat } from "../src/services/desktopChat.js";

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for the loop to advance.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Outside the Tauri shell executeDesktopTool throws, which is exactly the
// shape of a real native tool failure: the answer is not allowed to skip it.
test("a failed local tool is reported to the model and the loop still finishes", async () => {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    if (calls.length === 1) {
      return {
        data: {
          type: "tool_calls",
          toolCalls: [toolCall("call_read", "read_file", { path: "C:\\Users\\test\\missing.txt" })],
          assistantMessage: { role: "assistant", content: null }
        }
      };
    }
    return {
      data: {
        type: "final",
        content: "I could not read C:\\Users\\test\\missing.txt: the Windows tool did not run.",
        conversationId: "conv-err",
        message: { messageId: "m-err" },
        finishReason: "stop"
      }
    };
  };

  try {
    const chunks = [];
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Read the missing file for me." }],
      onChunk: chunk => chunks.push(chunk)
    });

    assert.equal(calls.length, 2, "the tool failure does not end the turn");
    const toolResult = calls[1].body.messages.at(-1);
    assert.equal(toolResult.role, "tool");
    assert.equal(toolResult.tool_call_id, "call_read");
    assert.match(toolResult.content, /"ok":false/);
    assert.match(toolResult.content, /tool_execution_failed/);
    assert.match(toolResult.content, /Local Windows filesystem tools are available in the VupsRouter desktop app\./);

    assert.match(result.content, /could not read/i);
    assert.deepEqual(chunks, [result.content]);
    assert.equal(result.localSteps.length, 1);
    assert.equal(result.localSteps[0].ok, false, "the failed step is not counted as completed work");
  } finally {
    apiClient.post = original;
  }
});

test("a three-file request runs every dependent write before the final answer", async () => {
  const original = apiClient.post;
  const executed = [];
  const calls = [];
  const files = ["index.html", "style.css", "script.js"];
  apiClient.post = async (url, body) => {
    calls.push(body);
    if (calls.length <= files.length) {
      const file = files[calls.length - 1];
      return {
        data: {
          type: "tool_calls",
          toolCalls: [
            toolCall(`call_${file}`, "write_file", {
              path: `C:\\Users\\test\\site\\${file}`,
              content: `/* ${file} */`
            })
          ],
          assistantMessage: { role: "assistant", content: null }
        }
      };
    }
    return {
      data: {
        type: "final",
        content: "Created index.html, style.css and script.js in C:\\Users\\test\\site.",
        conversationId: "conv-3",
        message: { messageId: "m-3" },
        finishReason: "stop"
      }
    };
  };

  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "Create index.html, style.css and script.js in C:\\Users\\test\\site." }],
      executeTool: async (tool, args) => {
        executed.push({ tool, path: args.path });
        return { ok: true, data: { path: args.path, bytesWritten: 12 } };
      }
    });

    assert.deepEqual(
      executed.map(step => step.path.split("\\").pop()),
      files,
      "every requested file is written in order"
    );
    assert.equal(calls.length, 4, "three tool rounds and one final answer");
    assert.equal(calls.at(-1).messages.filter(message => message.role === "tool").length, 3);
    assert.equal(result.localSteps.length, 3);
    assert.ok(result.localSteps.every(step => step.ok));
    assert.match(result.content, /Created index\.html, style\.css and script\.js/);
  } finally {
    apiClient.post = original;
  }
});

test("cancelling during a tool round stops the loop without a fabricated final answer", async () => {
  const original = apiClient.post;
  const controller = new AbortController();
  const calls = [];
  const chunks = [];

  apiClient.post = async (url, body, config) => {
    calls.push({ url, body });
    if (calls.length === 1) {
      return {
        data: {
          type: "tool_calls",
          toolCalls: [toolCall("call_list", "list_directory", { path: "C:\\Users\\test" })],
          assistantMessage: { role: "assistant", content: null }
        }
      };
    }
    return new Promise((resolve, reject) => {
      config?.signal?.addEventListener("abort", () => {
        const error = new Error("canceled");
        error.name = "CanceledError";
        reject(error);
      });
    });
  };

  try {
    const run = runDesktopToolChat({
      messages: [{ role: "user", content: "List the files under C:\\Users\\test." }],
      signal: controller.signal,
      onChunk: chunk => chunks.push(chunk)
    });
    await waitFor(() => calls.length === 2);
    controller.abort();

    await assert.rejects(run, error => {
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.equal(calls.length, 2, "no request is sent after the cancellation");
    assert.deepEqual(chunks, [], "nothing is shown as the answer");
  } finally {
    apiClient.post = original;
  }
});
