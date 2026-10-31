import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { matchLocalFileTask } from "../src/services/localFileTask.js";
import { runDesktopToolChat } from "../src/services/desktopChat.js";
import { apiClient } from "../src/services/api.js";

const KNOWN = {
  documents: "C:\\Users\\Vishnu\\Documents",
  desktop: "C:\\Users\\Vishnu\\Desktop",
  downloads: "C:\\Users\\Vishnu\\Downloads"
};
const QODER = "C:\\Users\\Vishnu\\Documents\\Qoder";

function recordingExecutor(handlers = {}) {
  const calls = [];
  const execute = async (tool, args) => {
    calls.push({ tool, args });
    const handler = handlers[tool];
    if (typeof handler === "function") return handler(args, calls);
    return { ok: false, error: { code: "tool_execution_failed", message: `No handler for ${tool}.` } };
  };
  return { calls, execute };
}

function knownFolderHandler(args) {
  const path = KNOWN[args.name];
  return path
    ? { ok: true, data: { name: args.name, path } }
    : { ok: false, error: { code: "known_folder_unavailable", message: `Windows did not report a ${args.name} folder.` } };
}

function unsupportedProviderError() {
  const error = new Error("Request failed with status code 400");
  error.response = {
    status: 400,
    data: {
      code: "tool_calling_unsupported",
      message: "This model's provider does not support tool calling in VupsRouter."
    }
  };
  return error;
}

function stubServer({ respond } = {}) {
  const original = apiClient.post;
  const posted = [];
  apiClient.post = async (url, body) => {
    posted.push({ url, body });
    if (respond) return respond(url, body, posted.length);
    throw unsupportedProviderError();
  };
  return {
    posted,
    restore() {
      apiClient.post = original;
    }
  };
}

test("folder and file name requests are matched to the existing local tools", () => {
  assert.deepEqual(matchLocalFileTask("Can you find my Qoder folder and give me that path?"), {
    kind: "locate_named",
    folder: "",
    query: "Qoder",
    intent: "Finding your Qoder folder"
  });
  assert.deepEqual(matchLocalFileTask("Where is my 'Vups Router' folder?"), {
    kind: "locate_named",
    folder: "",
    query: "Vups Router",
    intent: "Finding your Vups Router folder"
  });
  assert.equal(matchLocalFileTask("Find the folder named 'Meeting Notes'").query, "Meeting Notes");
  assert.equal(matchLocalFileTask("Find my Qoder folder in Downloads").folder, "downloads");

  const file = matchLocalFileTask("Find my file named quarterly report.pdf");
  assert.equal(file.kind, "find");
  assert.equal(file.query, "quarterly report.pdf");
  assert.equal(file.limit, 20);

  const direct = matchLocalFileTask("Where is notes.txt?");
  assert.equal(direct.kind, "find");
  assert.equal(direct.query, "notes.txt");

  // Judgement about file contents still belongs to the model.
  assert.equal(matchLocalFileTask("Find my Qoder folder and read the readme"), null);
  assert.equal(matchLocalFileTask("How is the weather?"), null);
});

test("a named folder lookup reaches the real native tools and answers with the absolute path", async (t) => {
  const { calls, execute } = recordingExecutor({
    get_windows_known_folder: knownFolderHandler,
    list_directory: (args) => ({
      ok: true,
      data: {
        path: args.path,
        entries:
          args.path === KNOWN.documents
            ? [
                { name: "Qoder", kind: "directory", path: QODER, modifiedAt: 1761724800000 },
                { name: "notes.txt", kind: "file", path: "C:\\Users\\Vishnu\\Documents\\notes.txt", size: 12 }
              ]
            : []
      }
    })
  });
  const server = stubServer();
  t.after(() => server.restore());

  const activity = [];
  const chunks = [];
  const result = await runDesktopToolChat({
    messages: [{ role: "user", content: "Can you find my Qoder folder and give me that path?" }],
    userText: "Can you find my Qoder folder and give me that path?",
    executeTool: execute,
    onActivity: (event) => activity.push(event.message),
    onChunk: (chunk) => chunks.push(chunk)
  });

  // The Qoder provider rejects tool definitions, so the verified local result
  // itself must become the answer instead of another model turn.
  assert.equal(server.posted.length, 1, "the rejected provider is asked at most once");
  assert.equal(result.localOnly, true);
  assert.match(result.content, /C:\\Users\\Vishnu\\Documents\\Qoder/);
  assert.doesNotMatch(result.content, /mnt\/data|find ~\/|2>\/dev\/null/);
  assert.deepEqual(chunks, [result.content]);
  assert.match(activity.join("\n"), /Finding your Qoder folder/);

  // Only the existing native tools ran, against the resolver-provided folder.
  assert.deepEqual(calls.map((call) => call.tool), ["get_windows_known_folder", "list_directory"]);
  assert.equal(calls[0].args.name, "documents");
  assert.equal(calls[1].args.path, KNOWN.documents);

  // A tool-capable model would have seen the same real result in its context.
  const sent = server.posted[0].body.messages;
  assert.equal(sent.at(-1).role, "tool");
  assert.equal(JSON.parse(sent.at(-1).content).data.entries[0].path, QODER);
});

test("a declined folder permission stops the lookup instead of prompting again", async (t) => {
  const decline = { ok: false, error: { code: "approval_denied", message: `You declined access to ${KNOWN.documents}.` } };
  const { calls, execute } = recordingExecutor({
    get_windows_known_folder: knownFolderHandler,
    list_directory: () => decline
  });
  const server = stubServer();
  t.after(() => server.restore());

  const result = await runDesktopToolChat({
    messages: [{ role: "user", content: "Can you find my Qoder folder and give me that path?" }],
    userText: "Can you find my Qoder folder and give me that path?",
    executeTool: execute
  });

  assert.equal(calls.filter((call) => call.tool === "list_directory").length, 1, "no second card after a denial");
  assert.equal(result.localOnly, true);
  assert.match(result.content, /Not completed/);
  assert.match(result.content, /You declined access/);
  assert.match(result.content, /Nothing was read/);
  assert.doesNotMatch(result.content, /Documents\\\\Qoder/, "a denial renders no path");
});

test("a file lookup searches the configured workspace first and keeps spaces in the real path", async (t) => {
  const workspace = "C:\\project\\Vups Router";
  const file = `${workspace}\\docs\\quarterly report.pdf`;
  const { calls, execute } = recordingExecutor({
    get_windows_known_folder: knownFolderHandler,
    search_files: (args) => ({
      ok: true,
      data: {
        root: args.root,
        entries:
          args.root === workspace
            ? [{ name: "quarterly report.pdf", path: file, size: 2048, modifiedAt: 1761724800000 }]
            : [],
        truncated: false,
        timedOut: false
      }
    })
  });
  const server = stubServer();
  t.after(() => server.restore());

  const result = await runDesktopToolChat({
    messages: [{ role: "user", content: "Find my file named quarterly report.pdf" }],
    userText: "Find my file named quarterly report.pdf",
    searchRoots: [workspace],
    executeTool: execute
  });

  assert.equal(calls[0].tool, "search_files", "the approved workspace is searched before any known folder");
  assert.equal(calls[0].args.root, workspace);
  assert.equal(calls[0].args.query, "quarterly report.pdf");
  assert.equal(calls[0].args.maxDepth, 4);
  assert.equal(calls[0].args.maxResults, 20);
  assert.equal(calls.filter((call) => call.tool === "search_files").length, 1);
  assert.equal(server.posted.length, 1);

  assert.equal(result.localOnly, true);
  assert.match(result.content, /C:\\project\\Vups Router\\docs\\quarterly report\.pdf/);
});

test("cancelling between fast-path tools stops without a fabricated answer", async () => {
  const controller = new AbortController();
  const { calls, execute } = recordingExecutor({
    get_windows_known_folder: knownFolderHandler,
    list_directory: (args) => {
      controller.abort();
      return { ok: true, data: { path: args.path, entries: [] } };
    }
  });
  const server = stubServer();
  try {
    await assert.rejects(
      () =>
        runDesktopToolChat({
          messages: [{ role: "user", content: "Can you find my Qoder folder and give me that path?" }],
          userText: "Can you find my Qoder folder and give me that path?",
          signal: controller.signal,
          executeTool: execute,
          onChunk: () => assert.fail("no chunk may be emitted after a cancellation")
        }),
      (error) => {
        assert.equal(error.name, "AbortError");
        return true;
      }
    );
    assert.equal(calls.filter((call) => call.tool === "list_directory").length, 1);
    assert.equal(server.posted.length, 0, "the model is not called after a cancellation");
  } finally {
    server.restore();
  }
});

test("a plain question on an unsupported provider still reports the real error", async (t) => {
  const { execute } = recordingExecutor({ get_windows_known_folder: knownFolderHandler });
  const server = stubServer();
  t.after(() => server.restore());

  await assert.rejects(
    () =>
      runDesktopToolChat({
        messages: [{ role: "user", content: "hii" }],
        userText: "hii",
        executeTool: execute
      }),
    (error) => {
      assert.equal(error.code, "tool_calling_unsupported");
      assert.equal(error.localSummary, undefined, "no local work happened, so nothing is claimed");
      return true;
    }
  );
  assert.equal(server.posted.length, 1);
});

test("the chat page hands configured workspace folders to the desktop tool run", () => {
  const source = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /const \{ activeWorkspace, workspaces, owner: workspaceOwner \} = useWorkspaces\(\);/);
  assert.match(source, /searchRoots: workspaces\.map\(\(workspace\) => workspace\?\.path\)\.filter\(Boolean\)/);
});

test("the fast path reuses the registered tool names, not new ones", () => {
  const source = readFileSync(new URL("../src/services/desktopChat.js", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../src/native/desktopTools.js", import.meta.url), "utf8");
  const rust = readFileSync(new URL("../src-tauri/src/desktop_tools.rs", import.meta.url), "utf8");
  for (const tool of ["get_windows_known_folder", "list_directory", "list_recent_files", "search_files"]) {
    assert.match(source, new RegExp(`"${tool}"`), `${tool} is used by the client`);
    assert.match(bridge, new RegExp(`${tool}:`), `${tool} has a native label`);
    assert.match(rust, new RegExp(`"${tool}" =>`), `${tool} is dispatched by the native layer`);
  }
  // No invented search tool and no shell command fallback.
  assert.doesNotMatch(source, /find ~\/|mnt\/data|child_process|spawn\(|exec\(/);
});
