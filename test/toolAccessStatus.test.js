import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { toolAccessRows } from "../src/native/toolAccessStatus.js";

const rowsByKey = result => Object.fromEntries(result.rows.map(row => [row.key, row]));

test("the diagnostics show the live session, model, mode and folder", () => {
  const ready = rowsByKey(
    toolAccessRows({
      windowsShell: true,
      tauriAvailable: true,
      serverToolEndpoint: true,
      model: "claude-sonnet-4",
      provider: "Anthropic",
      permissionMode: "ask",
      workspace: { id: "ws-1", title: "demo", path: "C:\\work\\demo" },
      bridgeError: "",
      waitingApprovals: 0
    })
  );

  assert.equal(ready.session.value, "Windows app");
  assert.equal(ready.session.tone, "ok");
  assert.equal(ready.server.value, "Available");
  assert.equal(ready.model.value, "claude-sonnet-4 · Anthropic");
  assert.equal(ready.permission.value, "Ask me every time");
  assert.equal(ready.workspace.value, "demo");
  assert.equal(ready.workspace.hint, "C:\\work\\demo");
  assert.equal(ready.tools.value, "27 tools");
  assert.equal(ready.approvals.value, "None");
  assert.equal(ready.failure.value, "None this session");
  assert.match(ready.model.hint, /every model and provider uses this same registry/i);
});

test("missing pieces are reported, never assumed", () => {
  const web = rowsByKey(toolAccessRows({ windowsShell: false, tauriAvailable: false, model: "", workspace: null }));
  assert.equal(web.session.value, "Not available on this platform");
  assert.equal(web.session.tone, "off");
  assert.equal(web.workspace.value, "No folder attached");
  assert.equal(web.workspace.tone, "off");
  assert.equal(web.model.value, "No model selected");

  const noEngine = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: false }));
  assert.equal(noEngine.session.value, "Engine not reachable");
  assert.equal(noEngine.session.tone, "off");

  const staleServer = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: true, serverToolEndpoint: false }));
  assert.equal(staleServer.server.value, "Missing");
  assert.equal(staleServer.server.tone, "warn");

  const waiting = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: true, waitingApprovals: 2 }));
  assert.equal(waiting.approvals.value, "2 waiting");
  assert.equal(waiting.approvals.tone, "warn");

  const failure = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: true, bridgeError: "The engine refused the call." }));
  assert.equal(failure.failure.value, "The engine refused the call.");
  assert.equal(failure.failure.tone, "warn");
});

test("full access is called out as the broad mode", () => {
  const full = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: true, permissionMode: "full" }));
  assert.equal(full.permission.value, "Full access");
  assert.equal(full.permission.tone, "warn");
  const workspace = rowsByKey(toolAccessRows({ windowsShell: true, tauriAvailable: true, permissionMode: "workspace" }));
  assert.equal(workspace.permission.value, "Agent (workspace)");
  assert.equal(workspace.permission.tone, "ok");
});

test("the displayed registry matches the native dispatch list exactly", () => {
  const rust = readFileSync(
    new URL("../src-tauri/src/desktop_tools.rs", import.meta.url),
    "utf8"
  );
  const block = rust.match(/const DESKTOP_TOOL_NAMES: \[&str; \d+\] = \[([\s\S]*?)\];/);
  assert.ok(block, "the native registry list is declared");
  const nativeNames = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]);
  const shown = toolAccessRows({}).toolNames;
  assert.deepEqual(shown, nativeNames, "the dialog shows exactly the names the native layer dispatches");
  assert.equal(shown.length, 27);
});

test("diagnostics never include credential or file-body fields", () => {
  const result = toolAccessRows({
    windowsShell: true,
    tauriAvailable: true,
    model: "model-x",
    provider: "provider-y",
    workspace: { title: "demo", path: "C:\\work\\demo" }
  });
  const text = JSON.stringify(result.rows);
  assert.doesNotMatch(text, /apiKey|api_key|bearer|sk-[a-z0-9]/i);
  assert.doesNotMatch(text, /baseUrl|base_url/i);
  assert.doesNotMatch(text, /content/i, "no file bodies are carried into diagnostics");
});

test("the chat header opens the live tool status and passes only real state", () => {
  const source = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(source, /import ToolAccessDialog from "\.\/native\/ToolAccessDialog\.jsx";/);
  assert.match(source, /aria-label="Tool access status"/);
  assert.match(source, /<ToolAccessDialog\n\s+open=\{toolAccessOpen\}/);
  assert.match(source, /tauriAvailable: isTauriRuntime\(\)/);
  assert.match(source, /serverToolEndpoint: !serverLacksToolEndpoint/);
  assert.match(source, /waitingApprovals: approvalRequests\.length/);
  assert.match(source, /bridgeError: nativeToolBridgeError/);
  assert.match(source, /workspace: chatWorkspace/);
  assert.match(source, /provider: activeRow\?\.provider \|\| ""/);
});
