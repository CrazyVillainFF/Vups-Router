import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_PERMISSION_MODE,
  WINDOWS_PERMISSION_MODES,
  loadPermissionMode,
  permissionModeInfo,
  savePermissionMode
} from "../src/native/permissions.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const chatPageSource = read("../src/ChatPage.jsx");
const controlsSource = read("../src/native/NativeChatControls.jsx");
const rustSource = read("../src-tauri/src/desktop_tools.rs");

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value))
  };
}

test("the three modes keep their ids and labels", () => {
  assert.deepEqual(
    WINDOWS_PERMISSION_MODES.map(mode => [mode.id, mode.label]),
    [
      ["ask", "Ask me every time"],
      ["workspace", "Agent (workspace)"],
      ["full", "Full access"]
    ]
  );
  assert.equal(DEFAULT_PERMISSION_MODE, "ask");
  assert.match(permissionModeInfo("workspace").description, /outside it is blocked/i);
  assert.match(permissionModeInfo("full").description, /protected system locations always ask/i);
  assert.match(permissionModeInfo("ask").description, /Allow once.*one call/i);
});

test("the selected mode is persisted and an unknown value falls back to ask", () => {
  const storage = memoryStorage();
  assert.equal(loadPermissionMode(storage), "ask");
  assert.equal(savePermissionMode(storage, "full"), "full");
  assert.equal(loadPermissionMode(storage), "full");
  assert.equal(savePermissionMode(storage, "root"), "ask");
  assert.equal(loadPermissionMode(storage), "full", "an invalid write never overwrites the saved mode");
  storage.setItem("vupsrouter.windows.permission-mode", "everything");
  assert.equal(loadPermissionMode(storage), "ask");
});

test("user-picked composer attachments are not a permission decision", () => {
  // The picker already names each file; routing it through the agent gate was
  // the duplicate card users reported. Only validation runs before send.
  assert.doesNotMatch(chatPageSource, /permissionDecision\(/);
  assert.doesNotMatch(chatPageSource, /requiresConfirmation/);
  const beforeSend = chatPageSource.slice(
    chatPageSource.indexOf("async function beforeComposerSend"),
    chatPageSource.indexOf("function preserveUnsyncedChat")
  );
  assert.match(beforeSend, /if \(!canSubmitComposer\(text, attachments\)\) return false;/);
  // The assistant's own tool calls still go through the native approval broker.
  assert.match(chatPageSource, /onDesktopToolApproval/);
});

test("the selector only moves after the native layer adopts the mode", () => {
  const apply = chatPageSource.slice(
    chatPageSource.indexOf("async function applyPermissionMode"),
    chatPageSource.indexOf("function changeWindowsPermissionMode")
  );
  assert.match(apply, /await setDesktopToolPolicy\(/);
  assert.match(apply, /setNativeToolBridgeError\(message\)/);
  assert.match(apply, /return false;/);
  // The state is written only after the bridge answered, never before.
  assert.ok(
    apply.indexOf("await setDesktopToolPolicy(") < apply.indexOf("setPermissionMode(savePermissionMode"),
    "the visible mode follows the native policy"
  );
  assert.match(chatPageSource, /permissionApplying/);
  assert.match(controlsSource, /applying = false/);
  assert.match(controlsSource, /Applying…/);
});

test("full access stays visibly marked and offers a one-click return to ask", () => {
  assert.match(controlsSource, /data-risk=\{selected\.id\}/);
  assert.match(controlsSource, /selected\.id === "full"/);
  assert.match(controlsSource, /Return to Ask me every time/);
  assert.match(controlsSource, /choose\("ask"\)/);
  assert.match(controlsSource, /WINDOWS_PERMISSION_MODES\.map\(\(item, index\)/);
});

test("a mode or workspace switch cancels the cards raised under the old policy", () => {
  const effect = chatPageSource.slice(
    chatPageSource.indexOf("const signature = `${workspaceOwner}|${permissionMode}|"),
    chatPageSource.indexOf("function beginRequest")
  );
  assert.match(effect, /policySyncRef\.current !== signature/);
  assert.match(effect, /cancelDesktopToolApprovals\(\)/);
  assert.match(effect, /clearApprovals\(\)/);
  // Task switching abandons a card that belongs to another conversation.
  const loadStart = chatPageSource.indexOf("async function loadTask");
  assert.ok(loadStart > -1, "loadTask is where tasks are switched");
  assert.match(chatPageSource.slice(loadStart, loadStart + 900), /cancelDesktopToolApprovals\(\)/);
});

test("the native layer, not the selector, decides every read", () => {
  // A crafted execute request cannot carry a mode: the stored policy decides.
  assert.match(rustSource, /struct ToolRequest \{\n    tool: String,/);
  // Every execution is stamped with the policy generation and rechecked.
  assert.match(rustSource, /generation\.load\(Ordering::SeqCst\) == started_at/);
  assert.match(rustSource, /fn execute_guarded\(/);
  assert.match(rustSource, /code: "policy_changed"|"policy_changed"/);
  assert.match(rustSource, /still_current/);
  // A one-time approval is answered but never stored; only an explicit
  // "Allow Always (Only for This File)" reaches the exact-resource store.
  assert.match(rustSource, /ApprovalDecision::Denied \| ApprovalDecision::Once => Ok\(\(\)\)/);
  assert.match(rustSource, /ApprovalDecision::AlwaysResource/);
  assert.match(rustSource, /fn action_persistable\(action: &str\) -> bool/);
  assert.doesNotMatch(rustSource, /scopes\.session\.reset\(\)/);
  assert.match(rustSource, /state\.broker\.cancel_all\(\)/);
  // Stop denies only the cards raised by the operation that was stopped.
  assert.match(rustSource, /fn cancel_operation\(&self, operation_id: &str\)/);
  assert.match(rustSource, /operation_id: String/);
  // A narrower mode also drops the saved exact-file grants.
  assert.match(rustSource, /transition\.revoke_grants/);
  assert.match(rustSource, /scopes\.grants\.clear\(&grant_owner\)/);
  assert.match(rustSource, /next\.mode\.breadth\(\) < existing\.mode\.breadth\(\)/);
  // Workspace mode blocks outside paths outright; no card can widen it.
  assert.match(rustSource, /policy\.mode == ToolMode::Workspace/);
  assert.match(rustSource, /outside_workspace/);
  assert.match(rustSource, /workspace_required/);
  assert.match(rustSource, /requires_fresh_approval/);
  // No policy stored means no tool access at all.
  assert.match(rustSource, /Choose a filesystem permission mode before using local tools/);
});
