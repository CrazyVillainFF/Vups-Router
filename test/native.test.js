import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  NATIVE_SHELL_STORAGE_KEY,
  detectNativeShell,
  nativeChatPath,
  normalizeNativeShell
} from "../src/native/shell.js";
import {
  DEFAULT_PERMISSION_MODE,
  WINDOWS_PERMISSION_STORAGE_KEY,
  attachmentPermissionDetails,
  loadPermissionMode,
  permissionDecision,
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

function attachment(overrides = {}) {
  return {
    id: "att-1",
    name: "notes.md",
    size: 2048,
    status: "ready",
    kind: "text",
    source: "picker",
    ...overrides
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

test("permission modes are enforced from actual attachment provenance", () => {
  assert.deepEqual(permissionDecision("ask", []), {
    allowed: true,
    requiresConfirmation: false,
    items: []
  });
  assert.equal(permissionDecision("ask", [attachment()]).requiresConfirmation, true);
  assert.equal(
    permissionDecision("workspace", [attachment({ source: "folder" })]).requiresConfirmation,
    false
  );
  assert.equal(
    permissionDecision("workspace", [attachment({ source: "workspace" })]).requiresConfirmation,
    false,
    "files already read through the native workspace bridge are in scope"
  );
  assert.equal(
    permissionDecision("workspace", [
      attachment({ id: "att-1", source: "workspace" }),
      attachment({ id: "att-2", source: "picker" })
    ]).requiresConfirmation,
    true,
    "one out-of-scope attachment still requires confirmation"
  );
  assert.equal(
    permissionDecision("ask", [attachment({ source: "workspace" })]).requiresConfirmation,
    true,
    "Ask mode confirms workspace files too"
  );
  assert.equal(
    permissionDecision("workspace", [attachment({ source: "picker" })]).requiresConfirmation,
    true
  );
  assert.equal(permissionDecision("full", [attachment()]).requiresConfirmation, false);
  assert.equal(permissionDecision("full", [attachment({ status: "error" })]).items.length, 0);
});

test("permission dialog details never expose file contents", () => {
  const details = attachmentPermissionDetails([
    attachment({ text: "secret contents" }),
    attachment({ id: "att-2", name: "photo.png", source: "folder", size: 1024 }),
    attachment({ id: "att-3", name: "app.jsx", source: "workspace", path: "src/app.jsx" })
  ]);
  assert.equal(details.length, 3);
  assert.equal(details[0].name, "notes.md");
  assert.equal(details[0].source, "File pick");
  assert.equal(details[1].source, "Folder pick");
  assert.equal(details[2].source, "Workspace file");
  assert.doesNotMatch(JSON.stringify(details), /secret contents/);
});

test("workspace attachments keep their native provenance and relative path", () => {
  const dialog = read("src/desktop/WorkspaceFilesDialog.jsx");
  assert.match(dialog, /workspaceTextFile\(result\.content, path\)/);
  assert.doesNotMatch(dialog, /new File\(\[result\.content\], path/);

  const chat = read("src/ChatPage.jsx");
  assert.match(
    chat,
    /const source = file\.attachmentSource \|\| \(file\.webkitRelativePath \? "folder" : "picker"\);/
  );
});

test("a dropped permission request still settles so the composer cannot hang", () => {
  const chat = read("src/ChatPage.jsx");
  const body = chat.slice(
    chat.indexOf("function authorizeNativeAttachments"),
    chat.indexOf("async function beforeComposerSend")
  );
  assert.ok(body.length > 0, "authorizeNativeAttachments must exist");
  assert.match(body, /pendingPermissionResolve\.current\?\.\(false\);/, "a superseded request must settle");
  assert.match(body, /resolve: allowed => pendingPermissionResolve\.current\?\.\(allowed\)/);
  assert.match(
    chat,
    /useEffect\(\(\) => \(\) => pendingPermissionResolve\.current\?\.\(false\), \[\]\);/,
    "unmount must settle a pending request"
  );
});

test("native UI wires direct chat, camera, folder access, and unavailable tools honestly", () => {
  const chat = read("src/ChatPage.jsx");
  const prompt = read("src/components/reactbits/PromptBar.jsx");
  const controls = read("src/native/NativeChatControls.jsx");
  assert.match(chat, /showCamera=\{nativeShell === NATIVE_SHELLS\.android\}/);
  assert.match(chat, /showFolder=\{nativeShell === NATIVE_SHELLS\.windows\}/);
  assert.match(chat, /NativePermissionDialog/);
  assert.match(prompt, /cameraInputRef/);
  assert.match(prompt, /folderInputRef/);
  assert.match(prompt, /capture="environment"/);
  assert.match(controls, /Shell, file-write, and administrator actions are not available/);
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
  for (const required of ["core:default", "allow-workspace-commands", "allow-desktop-tools"]) {
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

