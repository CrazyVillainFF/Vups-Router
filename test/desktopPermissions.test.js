import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DESKTOP_TOOL_PERMISSION_EVENT,
  normalizeApprovalDecision,
  normalizeDesktopToolPrompt
} from "../src/native/desktopTools.js";
import { localFilesystemSummary, runDesktopToolChat } from "../src/services/desktopChat.js";
import { matchLocalFileTask } from "../src/services/localFileTask.js";
import { apiClient } from "../src/services/api.js";

const cardSource = readFileSync(new URL("../src/native/InChatPermissionCard.jsx", import.meta.url), "utf8");
const chatPageSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../src/native/desktopTools.js", import.meta.url), "utf8");

const recentResult = {
  path: "C:\\Users\\Vishnu\\Downloads",
  returned: 3,
  files: [
    { name: "setup-2.4.exe", path: "C:\\Users\\Vishnu\\Downloads\\setup-2.4.exe", size: 4821034, modifiedAt: 1761724800000 },
    { name: "notes from meeting.txt", path: "C:\\Users\\Vishnu\\Downloads\\notes.txt", size: 812, modifiedAt: 1761638400000 },
    { name: "clip.mp4", path: "C:\\Users\\Vishnu\\Downloads\\clip.mp4", size: 1048576, modifiedAt: 1761552000000 }
  ]
};

test("the native prompt is normalized before it can reach the UI", () => {
  const prompt = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-1",
      approvalKey: "u1|read|c:\\users\\vishnu\\downloads",
      tool: "list_recent_files",
      action: "recent",
      scopePath: "C:\\Users\\Vishnu\\Downloads",
      scopeName: "Downloads",
      summary: "List the most recent files in C:\\Users\\Vishnu\\Downloads (newest 5 files)",
      access: "read",
      readOnly: true,
      expiresAt: Date.now() + 60_000
    }
  });
  assert.equal(prompt.requestId, "req-1");
  assert.equal(prompt.approvalKey, "u1|read|c:\\users\\vishnu\\downloads");
  assert.equal(prompt.scopeName, "Downloads");
  assert.equal(prompt.access, "read");

  // A prompt with no identity or no scope can never be answered, so it must not
  // open a card the user cannot act on.
  assert.equal(normalizeDesktopToolPrompt({ payload: { scopePath: "C:\\tmp" } }), null);
  assert.equal(normalizeDesktopToolPrompt({ payload: { requestId: "req-2" } }), null);
  assert.equal(normalizeDesktopToolPrompt({}), null);
});

test("only the three real decisions can leave the bridge", () => {
  assert.equal(normalizeApprovalDecision("once"), "once");
  assert.equal(normalizeApprovalDecision("always"), "always");
  assert.equal(normalizeApprovalDecision("deny"), "deny");
  for (const junk of ["allow", "ALWAYS", "", null, undefined, "full", true]) {
    assert.equal(normalizeApprovalDecision(junk), "deny", String(junk));
  }
});

test("the approval bridge is a named event and never a browser dialog", () => {
  assert.equal(DESKTOP_TOOL_PERMISSION_EVENT, "desktop-tool:approval");
  assert.match(bridgeSource, /export function onDesktopToolApproval/);
  assert.match(bridgeSource, /invoke\("desktop_tool_respond"/);
  // The decision is sent by id; the card holds no authority of its own.
  assert.doesNotMatch(bridgeSource, /alert\(|confirm\(/);
  assert.doesNotMatch(cardSource, /alert\(|confirm\(|window\.confirm/);
});

test("the permission card is an in-chat region with the three scoped actions", () => {
  assert.match(cardSource, /className="vr-permission-card"/);
  assert.match(cardSource, /VupsRouter wants to access \$\{name\}/);
  assert.match(cardSource, /\{request\.summary\}/);
  assert.match(cardSource, /Access requested/);
  assert.match(cardSource, /Allow once/);
  assert.match(cardSource, /Always allow for this folder/);
  assert.match(cardSource, /\{request\.scopePath\}/, "the exact path is shown");

  // The card names the operation and the state, so "waiting" is never read as
  // "already allowed".
  assert.match(cardSource, /List filenames and read file metadata/);
  assert.match(cardSource, /Waiting for approval/);
  assert.match(cardSource, /Applying your decision/);

  // A file-contents request must not offer a folder-wide grant.
  assert.match(cardSource, /\{!isFile \? \(*/);
  assert.match(cardSource, /it never allows modifying, deleting or running anything/);

  // Mounted inside the conversation, above the composer, not as a modal window.
  assert.match(chatPageSource, /<InChatPermissionCard/);
  assert.match(chatPageSource, /className="vr-permission-slot"/);
  const mount = chatPageSource.slice(
    chatPageSource.indexOf('className="vr-permission-slot"'),
    chatPageSource.indexOf('<footer className="vr-composer"')
  );
  assert.ok(mount.length > 0 && mount.length < 900, "the card sits in the chat column");
  assert.doesNotMatch(cardSource, /role="dialog"|aria-modal/);
});

test("one pending approval produces one card and dedup is not left to the UI alone", () => {
  const dedup = chatPageSource.slice(
    chatPageSource.indexOf("return onDesktopToolApproval(prompt => {"),
    chatPageSource.indexOf("function forgetApproval")
  );
  assert.match(dedup, /seenApprovalKeys\.current\.has\(prompt\.approvalKey\)/);
  assert.match(dedup, /entry\.requestId === prompt\.requestId/);
  assert.match(dedup, /Waiting for approval to read/);

  // Enforcement lives in the native layer: identical concurrent requests join
  // one pending approval instead of opening a second.
  const rust = readFileSync(
    new URL("../src-tauri/src/desktop_tools.rs", import.meta.url),
    "utf8"
  );
  assert.match(rust, /fn request\(&self, app: &AppHandle, owner: &str, prompt: &ApprovalPrompt\)/);
  assert.match(rust, /await_decision\(&joined/);
  assert.match(rust, /That permission request was already answered/);
  assert.match(rust, /fn cancel_all/);
});

test("the five-latest-files request is matched to one local enumeration", () => {
  assert.deepEqual(matchLocalFileTask("Find my five latest downloaded files and show their names, dates, sizes"), {
    kind: "recent",
    folder: "downloads",
    limit: 5,
    intent: "Listing the 5 most recent files in your downloads folder"
  });
  assert.equal(matchLocalFileTask("what are the 3 newest files in my Documents folder?").kind, "recent");
  assert.equal(matchLocalFileTask("what are the 3 newest files in my Documents folder?").folder, "documents");
  assert.equal(matchLocalFileTask("Find my Download folder and give me the path.").kind, "locate");
  assert.equal(matchLocalFileTask("List the files on my Desktop").kind, "list");

  // Anything that needs judgement stays with the model.
  assert.equal(matchLocalFileTask("Read the latest file in my Downloads folder"), null);
  assert.equal(matchLocalFileTask("Summarise my recent documents"), null);
  assert.equal(matchLocalFileTask("How is the weather?"), null);
  assert.equal(matchLocalFileTask(""), null);
});

test("the fast path runs the tool before any model call and sends one request", async () => {
  const original = apiClient.post;
  const calls = [];
  apiClient.post = async (url, body) => {
    calls.push({ url, body });
    return { data: { type: "final", content: "Here you go.", conversationId: "c-1", message: { messageId: "m-1" } } };
  };
  const activity = [];
  try {
    const result = await runDesktopToolChat({
      messages: [{ role: "user", content: "find my 5 latest downloaded files" }],
      userText: "find my 5 latest downloaded files",
      onActivity: event => activity.push(event.message)
    });
    assert.equal(result.content, "Here you go.");
    assert.equal(calls.length, 1, "the model is asked once, to phrase results it did not have to fetch");
    const sent = calls[0].body.messages;
    assert.equal(sent.at(-1).role, "tool", "the real tool result is already in the context");
    assert.match(
      JSON.stringify(sent),
      /"name":"get_windows_known_folder"/,
      "the folder came from the Windows resolver, not a guessed path"
    );
    assert.match(activity.join("\n"), /Listing the 5 most recent files in your downloads folder/);
  } finally {
    apiClient.post = original;
  }
});

test("local results are rendered from real tool data and nothing else", () => {
  const summary = localFilesystemSummary([
    { tool: "get_windows_known_folder", label: "Finding the Windows folder", ok: true, data: { name: "downloads", path: "C:\\Users\\Vishnu\\Downloads" } },
    { tool: "list_recent_files", label: "Finding the newest local files", ok: true, data: recentResult },
    { tool: "read_file", label: "Reading a local file", ok: true, data: { path: "C:\\Users\\Vishnu\\Downloads\\notes.txt", content: "secret body" } }
  ]);
  assert.match(summary, /setup-2\.4\.exe/);
  assert.match(summary, /4\.6 MB/);
  assert.match(summary, /clip\.mp4/);
  assert.match(summary, /C:\\Users\\Vishnu\\Downloads/);
  assert.match(summary, /contents not shown/);
  assert.doesNotMatch(summary, /secret body/, "file bytes never reach the transcript");

  // A failed step invents no rows, but it is never dropped either: the reason
  // the operation stopped has to reach the user without another model call.
  const denied = localFilesystemSummary([
    {
      tool: "list_recent_files",
      label: "Finding the newest local files",
      ok: false,
      data: null,
      error: { code: "approval_denied", message: "You declined access to C:\\Users\\Vishnu\\Downloads." }
    }
  ]);
  assert.match(denied, /Not completed/);
  assert.match(denied, /You declined access/);
  assert.match(denied, /Nothing was read/);
  assert.doesNotMatch(denied, /newest first/, "a denial renders no file list");

  const missing = localFilesystemSummary([
    {
      tool: "list_recent_files",
      label: "Finding the newest local files",
      ok: false,
      data: null,
      error: {
        code: "path_not_found",
        message:
          "That path does not exist for the signed-in Windows user. Windows reported: The system cannot find the file specified. (os error 2). Path: D:\\Nope"
      }
    }
  ]);
  assert.match(missing, /os error 2/, "the Windows detail survives to the user");
  assert.match(missing, /D:\\Nope/);

  assert.equal(localFilesystemSummary([]), "");
});

test("a genuine OS failure is never dressed up as a permission problem", () => {
  const desktopChat = readFileSync(new URL("../src/services/desktopChat.js", import.meta.url), "utf8");
  const serverTools = readFileSync(
    new URL("../../server/src/desktopTools.js", import.meta.url),
    "utf8"
  );

  // Nowhere in the client copy does the app tell anyone to touch Windows ACLs.
  assert.doesNotMatch(desktopChat, /icacls|Security tab|Properties → Security|take ownership of|NTFS/i);
  assert.match(
    desktopChat,
    /made no permission, ownership or elevation changes/,
    "an access_denied result states what the app did not do"
  );

  // The model is told the same, and only the native code may call something a
  // Windows access problem.
  assert.match(serverTools, /Never tell the user to change NTFS permissions/);
  assert.match(serverTools, /code "access_denied" may be described as a Windows access problem/);

  // Progress states name the lifecycle instead of implying a grant.
  assert.match(desktopChat, /— running/);
  assert.match(desktopChat, /— completed/);
  assert.match(desktopChat, /— failed \(\$\{code\}\)/);
  assert.match(
    chatPageSource,
    /Access granted — \$\{request\.summary/,
    "the resume line is recorded after the native layer accepts the decision"
  );
});

test("a model failure after tool work carries the local results with it", () => {
  const source = chatPageSource.replace(/\r\n/g, "\n");
  assert.match(source, /error\.localSummary/);
  assert.match(source, /const preservedLocal = typeof error\.localSummary === "string"/);
  assert.match(source, /content: fallbackContent/);
  const desktopChat = readFileSync(new URL("../src/services/desktopChat.js", import.meta.url), "utf8");
  assert.match(desktopChat, /function attachLocalResults\(error, steps\)/);
  assert.match(desktopChat, /error\.filesystemCompleted = true/);
  assert.match(desktopChat, /await cancelDesktopToolApprovals\(\)/);
});

test("saved folder grants are inspectable and revocable from settings", () => {
  const pages = readFileSync(new URL("../src/desktop/DesktopPages.jsx", import.meta.url), "utf8");
  assert.match(pages, /<FolderAccessSection \/>/, "the section is mounted in Settings");
  assert.match(pages, /await revokeDesktopToolGrant\(id\)/);
  assert.match(pages, /await clearDesktopToolGrants\(\)/);
  assert.match(pages, /grant\.path/, "each row shows the folder it covers");
  assert.match(pages, /no keys/);
  assert.match(pages, /no file contents/);
  // The list is read from the native store, never from frontend memory.
  assert.match(pages, /setGrants\(await listDesktopToolGrants\(\)\)/);
  assert.match(bridgeSource, /export (?:async )?function listDesktopToolGrants/);
  assert.match(bridgeSource, /invoke\("desktop_tool_grant_revoke"/);

  const rust = readFileSync(new URL("../src-tauri/src/desktop_tools.rs", import.meta.url), "utf8");
  assert.match(rust, /pub async fn desktop_tool_grant_revoke/, "revocation is a native command");
  const capabilities = readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8"
  );
  assert.match(capabilities, /desktop-tools/, "the grant commands are inside the app capability");
});
