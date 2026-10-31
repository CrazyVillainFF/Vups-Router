import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  NATIVE_SHELL_STORAGE_KEY,
  detectNativeShell,
  nativeChatPath,
  normalizeNativeShell,
  usesBrowserAuthHandoff
} from "../src/native/shell.js";
import {
  DEFAULT_PERMISSION_MODE,
  WINDOWS_PERMISSION_STORAGE_KEY,
  loadPermissionMode,
  savePermissionMode
} from "../src/native/permissions.js";
import {
  AUTH_ROUTE_PATHS,
  PRODUCTION_SITE_URL,
  assertApprovedAuthUrl,
  authUrl,
  openAuthPage
} from "../src/native/authLinks.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value))
  };
}

test("native shell detection persists a valid query and survives auth redirects", () => {
  const storage = memoryStorage();
  assert.equal(detectNativeShell("?native=windows", storage), "windows");
  assert.equal(storage.getItem(NATIVE_SHELL_STORAGE_KEY), "windows");
  assert.equal(detectNativeShell("native=windows", memoryStorage()), "windows");
  assert.equal(detectNativeShell("", storage), "windows");
  assert.equal(detectNativeShell("?native=android", storage), "android");
  assert.equal(detectNativeShell("?native=ios", memoryStorage()), null);
  assert.equal(normalizeNativeShell(" WINDOWS "), "windows");
  assert.equal(nativeChatPath("android"), "/chat?native=android");
  assert.equal(nativeChatPath("ios"), "/chat");
});

test("only the Windows shell hands account access to a browser", () => {
  assert.equal(usesBrowserAuthHandoff("windows"), true);
  assert.equal(usesBrowserAuthHandoff(" WINDOWS "), true, "matched the same way the shell is normalised elsewhere");
  assert.equal(usesBrowserAuthHandoff("android"), false);
  assert.equal(usesBrowserAuthHandoff("ios"), false);
  assert.equal(usesBrowserAuthHandoff(null), false);

  // Why the Android app cannot hand off: Capacitor leaves the WebView only for a
  // host outside the app's own, and the APK loads the same site the approval URL
  // points at. An Android handoff therefore navigates in place, the browser
  // never opens, and the ticket is never approved.
  const capacitor = JSON.parse(read("capacitor.config.json"));
  assert.equal(new URL(capacitor.server.url).host, new URL(PRODUCTION_SITE_URL).host);
});

test("native auth redirect preserves the direct-chat search and shell layout", () => {
  const requireAuth = read("src/components/RequireAuth.jsx");
  const app = read("src/App.jsx");
  assert.match(requireAuth, /from: `\$\{location\.pathname\}\$\{location\.search\}`/);
  assert.match(app, /const redirectTo = location\.state\?\.from \|\| "\/chat";/);
  assert.match(app, /detectNativeShell\(returnSearch \|\| undefined\)/);
  assert.match(app, /isTauriRuntime\(\) \? NATIVE_SHELLS\.windows : null/);
});

test("native shells launch directly into chat", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const capacitor = JSON.parse(read("capacitor.config.json"));
  const desktopServer = read("src-tauri/src/desktop_server.rs");
  const capability = JSON.parse(read("src-tauri/capabilities/desktop-local.json"));
  assert.deepEqual(tauri.app.windows, []);
  assert.match(desktopServer, /asset_resolver/);
  assert.match(desktopServer, /127\.0\.0\.1/);
  assert.match(desktopServer, /vups-router-be\.onrender\.com/);
  assert.ok(capability.permissions.some(item => item.identifier === "opener:allow-open-url"));
  assert.equal(capacitor.server.url, "https://vups-router-three.vercel.app/chat?native=android");
});

test("the desktop bundle rebuilds the frontend instead of packaging a stale dist", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(tauri.build.beforeBuildCommand, "npm run build");
  assert.equal(tauri.build.frontendDist, "../dist");
});

test("external auth helpers use only the verified production routes", () => {
  assert.equal(PRODUCTION_SITE_URL, "https://vups-router-three.vercel.app");
  assert.equal(authUrl("signin"), "https://vups-router-three.vercel.app/signin");
  assert.equal(authUrl("signup"), "https://vups-router-three.vercel.app/signup");
  assert.equal(authUrl("forgot"), "https://vups-router-three.vercel.app/forgot-password");
  assert.throws(() => authUrl("callback"), /Unknown authentication page/);
  assert.deepEqual(Object.keys(AUTH_ROUTE_PATHS).sort(), ["forgot", "signin", "signup"]);
});

test("external auth rejects any origin or scheme outside the approved allowlist", () => {
  assert.equal(assertApprovedAuthUrl(`${PRODUCTION_SITE_URL}/signin`), `${PRODUCTION_SITE_URL}/signin`);
  assert.throws(() => assertApprovedAuthUrl("http://vups-router-three.vercel.app/signin"), /must use HTTPS/);
  assert.throws(() => assertApprovedAuthUrl("https://evil.example/signin"), /only open the VupsRouter website/);
  assert.throws(() => assertApprovedAuthUrl("https://vups-router-three.vercel.app.evil.example/"), /only open the VupsRouter website/);
});

test("external auth opener uses Tauri in native mode and a browser fallback on the web", async () => {
  let opened = "";
  const nativeUrl = await openAuthPage("signin", {
    runtime: true,
    openUrl: async url => { opened = url; }
  });
  assert.equal(nativeUrl, "https://vups-router-three.vercel.app/signin");
  assert.equal(opened, nativeUrl);

  const web = await openAuthPage("signup", {
    runtime: false,
    openWindow: (url, target, features) => {
      assert.equal(target, "_blank");
      assert.equal(features, "noopener,noreferrer");
      return {};
    }
  });
  assert.equal(web, "https://vups-router-three.vercel.app/signup");
  await assert.rejects(
    () => openAuthPage("signup", { runtime: false, openWindow: () => null }),
    /blocked the VupsRouter page/
  );
});

test("Windows permission defaults to ask every time and persists", () => {
  const storage = memoryStorage();
  assert.equal(DEFAULT_PERMISSION_MODE, "ask");
  assert.equal(loadPermissionMode(storage), "ask");
  assert.equal(savePermissionMode(storage, "workspace"), "workspace");
  assert.equal(storage.getItem(WINDOWS_PERMISSION_STORAGE_KEY), "workspace");
  assert.equal(loadPermissionMode(storage), "workspace");
  assert.equal(savePermissionMode(storage, "invalid"), "ask");
});

test("composer file picks never raise a second permission card", () => {
  const chat = read("src/ChatPage.jsx");
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  assert.doesNotMatch(chat, /authorizeNativeAttachments/);
  assert.doesNotMatch(chat, /permissionDecision\(/);
  assert.doesNotMatch(chat, /pendingPermissionResolve/);
  const beforeSend = chat.slice(
    chat.indexOf("async function beforeComposerSend"),
    chat.indexOf("function preserveUnsyncedChat")
  );
  assert.match(beforeSend, /if \(!canSubmitComposer\(text, attachments\)\) return false;/);
  // A model that cannot read images blocks before the composer clears the draft.
  assert.match(beforeSend, /does not accept images\. Choose a vision-capable model/);
  // Folder picks use a dedicated composer command instead of the approval broker.
  assert.match(chat, /pickComposerFolder\(\)/);
  assert.match(prompt, /onPickFolder/);
  assert.doesNotMatch(prompt, /webkitdirectory/);
  // The assistant's own local operations still pass through the approval broker.
  assert.match(chat, /onDesktopToolApproval/);
});

test("new picks count what is already attached before applying limits", () => {
  const chat = read("src/ChatPage.jsx");
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  assert.match(chat, /async function pickAttachments\(files, \{ source, existing \} = \{\}\)/);
  assert.match(chat, /const prior = attachmentTotals\(existing\);/);
  assert.match(chat, /let imageCount = prior\.images;/);
  assert.match(chat, /let textCount = prior\.texts;/);
  assert.match(prompt, /existing: attachmentsRef\.current/);
  assert.match(prompt, /mergeSelectionSummary\(current, nextSummary\)/);
  // Live card counts keep the strip honest after removal or retry.
  assert.match(prompt, /const attachedCount = attachments\.filter\(item => item && item\.status !== 'error'\)\.length;/);
  assert.match(prompt, /const failedCount = failureRows\.length;/);
});

test("re-picking an attached file is reported, not duplicated", () => {
  const chat = read("src/ChatPage.jsx");
  assert.match(chat, /const originKey = fileIdentity\(file\);/);
  assert.match(chat, /skipped\.push\(skipRecord\(file, "Already attached to this message\."\)\);/);
  assert.match(chat, /if \(originKey\) seen\.add\(originKey\);/);
  assert.match(chat, /\.filter\(item => item && item\.status !== "error"\)/);
});

test("folder cards stay compact and keep opt-ins inline", () => {
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  assert.match(prompt, /const imageTotal = entries\.filter\(entry => entry\?\.kind === 'image'\)\.length;/);
  assert.match(prompt, /`\$\{plan\.images\.length\} of \$\{imageTotal\} images on send`/);
  // The card no longer expands a contents tree; skipped files stay in the
  // composer's Details summary instead of a list under the card.
  assert.doesNotMatch(prompt, /'Hide contents'|>Contents</);
  assert.match(prompt, /Includes hidden files/);
});

test("several folders are allowed with a 25 folder/file cap", () => {
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  const chat = read("src/ChatPage.jsx");
  assert.doesNotMatch(prompt, /Remove the current folder before adding another one/);
  assert.match(prompt, /folderFileCount >= 25/);
  assert.match(prompt, /onPickFolder\(\{ existing: attachmentsRef\.current \}\)/);
  assert.match(chat, /current >= ATTACHMENT_LIMITS\.folderFile/);
  assert.match(chat, /skipped: \[\]/, "folder picks do not report folder-level skips as file skips");
});

test("picking a folder includes secret and generated files without toggles", () => {
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  assert.doesNotMatch(prompt, /Include secret files/);
  assert.doesNotMatch(prompt, /Include generated folders/);
  assert.doesNotMatch(prompt, /onScanOptionsChange/);
  assert.doesNotMatch(prompt, /const rescanFolder = async/);
  const rust = read("src-tauri/src/composer_files.rs");
  assert.match(rust, /impl Default for ScanOptions[\s\S]*include_generated: true,[\s\S]*include_secrets: true,/);
  assert.doesNotMatch(rust, /composer_rescan_folder/);
});

test("workspace attachments keep their native provenance and relative path", () => {  const dialog = read("src/desktop/WorkspaceFilesDialog.jsx");
  assert.match(dialog, /workspaceTextFile\(result\.content, path\)/);
  assert.doesNotMatch(dialog, /new File\(\[result\.content\], path/);

  const chat = read("src/ChatPage.jsx");
  assert.match(
    chat,
    /const fileSource = source \|\| file\.attachmentSource \|\| \(file\.webkitRelativePath \? "folder" : "picker"\);/
  );
});

test("native UI wires direct chat, camera, folder access, and unavailable tools honestly", () => {
  const chat = read("src/ChatPage.jsx");
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  const controls = read("src/native/NativeChatControls.jsx");
  assert.match(chat, /showCamera=\{nativeShell === NATIVE_SHELLS\.android\}/);
  assert.match(chat, /onPickFolder=/);
  assert.match(chat, /NativePermissionDialog/);
  assert.match(prompt, /cameraInputRef/);
  assert.match(prompt, /onPickFolder/);
  assert.doesNotMatch(prompt, /folderInputRef|webkitdirectory/);
  assert.match(prompt, /capture="environment"/);
  // The access menu stays a plain selector; long explanations are not shown.
  assert.doesNotMatch(controls, /vr-permission__option-copy|These modes control/);
  assert.match(chat, /permissionControl=\{/);
  assert.match(chat, /<NativeChatControls/);
  assert.match(prompt, /permissionControl/);
  assert.match(controls, /role="listbox"/);
  assert.match(controls, /aria-expanded=\{open\}/);
  assert.match(controls, /ArrowDown/);
  assert.match(controls, /Escape/);
});

// The desktop window loads WebviewUrl::External(http://127.0.0.1:<port>), so only a
// capability with local:false + a matching remote URL grants IPC to that origin.
test("the capability governing the loopback origin grants every bridge command", () => {
  const capability = JSON.parse(read("src-tauri/capabilities/desktop-local.json"));
  assert.equal(capability.local, false);
  assert.deepEqual(capability.windows, ["main"]);
  assert.deepEqual(
    capability.remote.urls.filter(url => url.startsWith("http://127.0.0.1:")),
    ["http://127.0.0.1:*"]
  );

  const identifiers = capability.permissions.map(entry =>
    typeof entry === "string" ? entry : entry.identifier
  );
  for (const required of [
    "core:default",
    "allow-workspace-commands",
    "allow-desktop-tools",
    "allow-composer-files"
  ]) {
    assert.ok(identifiers.includes(required), `${required} missing from the loopback capability`);
  }

  const opener = capability.permissions.find(
    entry => typeof entry === "object" && entry.identifier === "opener:allow-open-url"
  );
  assert.ok(opener, "opener:allow-open-url missing from the loopback capability");
  // Guide links point at whatever provider the user configured, so the native
  // allowlist covers secure web and mail links only; the shared opener in
  // externalLinks.js rejects every other scheme before this command is called.
  assert.deepEqual(opener.allow.map(entry => entry.url).sort(), ["https://*", "mailto:*"]);
  assert.ok(
    opener.allow.some(entry => entry.url.startsWith("https://")),
    `the sign-in page at ${PRODUCTION_SITE_URL} stays openable`
  );
});

// Registering a command is not enough: the loopback window only receives the
// commands listed in its capability permission set. This caught the Stop
// command being registered but rejected at runtime as "Command not found".
test("every desktop tool command the window uses is allowed by its capability", () => {
  const allowed = new Set(
    [...read("src-tauri/permissions/desktop-tools.toml").matchAll(/"([a-z_]+)"/g)].map(
      match => match[1]
    )
  );
  const main = read("src-tauri/src/main.rs");
  const handlerStart = main.indexOf(".invoke_handler(");
  assert.ok(handlerStart >= 0, "the Tauri invoke handler is declared");
  const handlerEnd = main.indexOf("])", handlerStart);
  assert.ok(handlerEnd > handlerStart, "the invoke handler list is complete");
  const registered = [
    ...main
      .slice(handlerStart, handlerEnd)
      .matchAll(/desktop_tools::([a-z_]+)/g)
  ].map(match => match[1]);

  assert.ok(
    registered.includes("desktop_tool_cancel_operation"),
    "Stop calls this command, so it must be registered"
  );
  for (const command of registered) {
    assert.ok(
      allowed.has(command),
      `${command} is registered but not allowed by allow-desktop-tools`
    );
  }

  const client = read("src/native/desktopTools.js");
  const invoked = [
    ...client.matchAll(/invoke\("(desktop_tool_[a-z_]+)"/g)
  ].map(match => match[1]);
  assert.ok(invoked.includes("desktop_tool_cancel_operation"));
  for (const command of invoked) {
    assert.ok(
      allowed.has(command),
      `${command} is called by the client but not allowed by allow-desktop-tools`
    );
  }
});

