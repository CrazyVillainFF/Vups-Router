import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_PERMISSION_MODE,
  LEGACY_WINDOWS_PERMISSION_STORAGE_KEY,
  WINDOWS_PERMISSION_MODES,
  loadPermissionMode,
  permissionModeInfo,
  permissionModeStorageKey,
  readPermissionMode,
  savePermissionMode
} from "../src/native/permissions.js";
import { effectivePolicyProblem } from "../src/native/effectivePolicy.js";
import {
  accountSessionStorageKeys,
  chatScopeStorageKey,
  clearAccountSessionKeys,
  endAccountSession
} from "../src/desktop/accountSessionState.js";
import { chatBindingsKey } from "../src/desktop/chatWorkspaceBindings.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const chatPageSource = read("../src/ChatPage.jsx");
const controlsSource = read("../src/native/NativeChatControls.jsx");
const authSource = read("../src/context/AuthContext.jsx");
const rustSource = read("../src-tauri/src/desktop_tools.rs");

function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
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
  // The page has to say what Full access really is: an authorization for one
  // app session, not a setting that comes back on the next launch.
  assert.match(permissionModeInfo("full").description, /this app session only/i);
});

test("Ask and Agent persist per account and never cross to another one", () => {
  const storage = memoryStorage();
  assert.equal(loadPermissionMode(storage, "user_a"), "ask");
  assert.equal(savePermissionMode(storage, "user_a", "workspace"), "workspace");
  assert.equal(loadPermissionMode(storage, "user_a"), "workspace");
  assert.equal(loadPermissionMode(storage, "user_b"), "ask", "an account never reads another's mode");
  assert.equal(savePermissionMode(storage, "user_a", "root"), "ask");
  assert.equal(loadPermissionMode(storage, "user_a"), "workspace", "an invalid write never overwrites the saved mode");
  storage.setItem(permissionModeStorageKey("user_a"), "everything");
  assert.equal(loadPermissionMode(storage, "user_a"), "ask", "an unknown stored value falls back to ask");
});

test("Full access is a session authorization and is never restored", () => {
  const storage = memoryStorage();
  assert.equal(savePermissionMode(storage, "user_a", "full"), "full");
  assert.equal(storage.getItem(permissionModeStorageKey("user_a")), null, "full is never written out");
  assert.deepEqual(readPermissionMode(storage, "user_a"), { mode: "ask", dropped: "" });
  // Even a `full` that reached storage from an older build is refused, and the
  // refusal is reported so the UI can say the restart happened.
  storage.setItem(permissionModeStorageKey("user_a"), "full");
  assert.deepEqual(readPermissionMode(storage, "user_a"), { mode: "ask", dropped: "full" });
  assert.equal(storage.getItem(permissionModeStorageKey("user_a")), "full", "the refused value is not rewritten");
});

test("the legacy device-wide mode is consumed once and cannot reach the next account", () => {
  const storage = memoryStorage();
  storage.setItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY, "full");
  assert.deepEqual(readPermissionMode(storage, "user_a"), { mode: "ask", dropped: "full" });
  assert.equal(storage.getItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY), null);
  assert.deepEqual(readPermissionMode(storage, "user_b"), { mode: "ask", dropped: "" });
  // A durable half of the legacy value migrates to the reading account only, once.
  storage.setItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY, "workspace");
  assert.deepEqual(readPermissionMode(storage, "user_a"), { mode: "workspace", dropped: "" });
  assert.equal(storage.getItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY), null);
  assert.deepEqual(readPermissionMode(storage, "user_b"), { mode: "ask", dropped: "" });
  assert.equal(loadPermissionMode(storage, "user_a"), "workspace");
});

test("the page reads the mode under the owning account and reports what it refused", () => {
  const load = chatPageSource.slice(
    chatPageSource.indexOf("const { mode, dropped } = readPermissionMode"),
    chatPageSource.indexOf("useEffect(() => {\n    if (nativeShell !== NATIVE_SHELLS.windows || !workspaceOwner)")
  );
  assert.match(load, /readPermissionMode\(localBrowserStorage\(\), workspaceOwner\)/);
  assert.match(load, /setPermissionMode\(mode\)/);
  assert.match(load, /dropped/);
  assert.match(load, /was not restored/);
  // Nothing device-wide is adopted at mount, and no stale selector state is
  // trusted: the native reply is compared with what the chat asked for.
  assert.match(chatPageSource, /useState\(DEFAULT_PERMISSION_MODE\)/);
  assert.doesNotMatch(chatPageSource, /loadPermissionMode\(localBrowserStorage\(\)\)/);
  assert.match(chatPageSource, /effectivePolicyProblem\(status, \{/);
  assert.match(chatPageSource, /notice=\{permissionNotice\}/);
  assert.match(controlsSource, /notice = ""/);
  assert.match(controlsSource, /data-notice="dropped"/);
});

test("the effective policy is reconciled before local tools are treated as available", () => {
  const installed = { owner: "user_a", mode: "ask", label: "Ask me every time", workspaceRoot: null };
  assert.equal(effectivePolicyProblem(installed, { owner: "user_a", mode: "ask" }), "");
  // A policy that belongs to an account which signed out is not this chat's
  // access, even when the mode matches.
  assert.match(
    effectivePolicyProblem(installed, { owner: "user_b", mode: "ask" }),
    /belongs to another account/
  );
  assert.match(
    effectivePolicyProblem({ ...installed, mode: "full", label: "Full access" }, { owner: "user_a", mode: "ask" }),
    /running Full access, not the Ask me every time/
  );
  // Agent (workspace) is a boundary: with no resolved folder nothing is granted.
  assert.match(
    effectivePolicyProblem(
      { owner: "user_a", mode: "workspace", label: "Agent (workspace)", workspaceRoot: null },
      { owner: "user_a", mode: "workspace", workspaceId: "ws_1" }
    ),
    /no folder\s+to stay inside/
  );
  assert.equal(
    effectivePolicyProblem(
      { owner: "user_a", mode: "workspace", label: "Agent (workspace)", workspaceRoot: "C:\\work" },
      { owner: "user_a", mode: "workspace", workspaceId: "ws_1" }
    ),
    ""
  );
  // A missing or unreadable reply is reported, never treated as access.
  assert.match(effectivePolicyProblem(null, { owner: "user_a", mode: "ask" }), /no file access mode/);
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
  // A narrower mode drops saved exact-file grants and chat-scoped answers.
  assert.match(rustSource, /transition\.revoke_grants/);
  assert.match(rustSource, /fn clear\(&mut self, owner: &str\)/);
  assert.match(rustSource, /scopes\.clear\(&grant_owner\)/);
  assert.match(rustSource, /self\.chat_grants\.retain\(\|grant\| grant\.owner != owner\)/);
  assert.match(rustSource, /next\.mode\.breadth\(\) < existing\.mode\.breadth\(\)/);
  // Workspace mode blocks outside paths outright; no card can widen it.
  assert.match(rustSource, /policy\.mode == ToolMode::Workspace/);
  assert.match(rustSource, /outside_workspace/);
  assert.match(rustSource, /workspace_required/);
  assert.match(rustSource, /requires_fresh_approval/);
  // No policy stored means no tool access at all.
  assert.match(rustSource, /Choose a filesystem permission mode before using local tools/);
});

test("sign-out clears one account's session keys and leaves every durable store", () => {
  const storage = memoryStorage();
  storage.setItem(chatScopeStorageKey("user_a"), '{"chat_1":"scope_1"}');
  storage.setItem(chatScopeStorageKey("user_b"), '{"chat_2":"scope_2"}');
  storage.setItem(permissionModeStorageKey("user_a"), "workspace");
  storage.setItem(chatBindingsKey("user_a"), '{"chat_1":"ws_1"}');
  storage.setItem("vupsrouter.desktop.active-workspace.user_a.v1", "ws_1");
  storage.setItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY, "full");

  const removed = clearAccountSessionKeys(storage, "user_a");

  assert.deepEqual([...removed].sort(), [...accountSessionStorageKeys("user_a")].sort());
  assert.equal(storage.getItem(chatScopeStorageKey("user_a")), null);
  assert.equal(storage.getItem(LEGACY_WINDOWS_PERMISSION_STORAGE_KEY), null);
  assert.equal(
    storage.getItem(chatScopeStorageKey("user_b")),
    '{"chat_2":"scope_2"}',
    "another account's scope map is not this sign-out's to clear"
  );
  assert.equal(storage.getItem(permissionModeStorageKey("user_a")), "workspace");
  assert.equal(storage.getItem(chatBindingsKey("user_a")), '{"chat_1":"ws_1"}');
  assert.equal(storage.getItem("vupsrouter.desktop.active-workspace.user_a.v1"), "ws_1");
});

test("ending an account's session closes the desktop policy of exactly that account", async () => {
  const released = [];
  const result = await endAccountSession({
    owner: "user_a",
    storage: memoryStorage(),
    desktop: true,
    releasePolicy: async owner => {
      released.push(owner);
      return null;
    }
  });
  assert.deepEqual(released, ["user_a"], "only the leaving account's policy is released");
  assert.equal(result.toolAccessEnded, true);
  assert.equal(result.error, "");
});

test("a sign-out that cannot close local file access says so instead of throwing", async () => {
  const web = await endAccountSession({
    owner: "user_a",
    storage: memoryStorage(),
    releasePolicy: async () => {
      throw new Error("the web has no native engine");
    }
  });
  assert.equal(web.toolAccessEnded, false, "the website never calls the bridge");
  assert.equal(web.error, "");

  const failing = await endAccountSession({
    owner: "user_a",
    storage: memoryStorage(),
    desktop: true,
    releasePolicy: async () => {
      throw new Error("Could not end local file access for this account.");
    }
  });
  assert.equal(failing.toolAccessEnded, false);
  assert.match(failing.error, /Could not end local file access/, "a half-ended session is reported");

  const anonymous = await endAccountSession({
    storage: memoryStorage(),
    desktop: true,
    releasePolicy: async () => {
      throw new Error("must not run without an owner");
    }
  });
  assert.deepEqual(anonymous, { owner: "", removedKeys: [], toolAccessEnded: false, error: "" });
});

test("sign-out runs the cleanup for the leaving account before the server request", () => {
  const signOut = authSource.slice(
    authSource.indexOf("const signOut = useCallback"),
    authSource.indexOf("const value = useMemo")
  );
  // `desktop:` is what keeps a web sign-out from invoking a command the website
  // has no bridge for, and the helper has to be imported for the call to work.
  assert.match(authSource, /import \{ isTauriRuntime \} from "\.\.\/native\/shell\.js"/);
  assert.match(
    signOut,
    /const owner = String\(userRef\.current\?\.id \|\| readAccountProfile\(\)\?\.id \|\| ""\)/,
    "the cleanup targets the account that is signing out, including a device-local profile"
  );
  assert.match(signOut, /endAccountSession\(\{\s+owner,\s+desktop: isTauriRuntime\(\)\s+\}\)/);
  assert.match(signOut, /if \(error\) setSessionError\(error\)/);
  assert.ok(
    signOut.indexOf("await endAccountSession(") < signOut.indexOf("await signOutRequest()"),
    "local access is closed before the session receipt is dropped"
  );
  // The funnel delegates: it deletes no durable per-account state, and it holds
  // no key name of its own that could reach another owner.
  assert.doesNotMatch(signOut, /removeItem|setItem|permissionModeStorageKey|chatBindingsKey/);
});
