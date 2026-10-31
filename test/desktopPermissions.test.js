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
const rustSource = readFileSync(new URL("../src-tauri/src/desktop_tools.rs", import.meta.url), "utf8");

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
  assert.equal(prompt.canPersist, false, "the client never invents persistence the native layer did not allow");

  // A prompt with no identity or no scope can never be answered, so it must not
  // open a card the user cannot act on.
  assert.equal(normalizeDesktopToolPrompt({ payload: { scopePath: "C:\\tmp" } }), null);
  assert.equal(normalizeDesktopToolPrompt({ payload: { requestId: "req-2" } }), null);
  assert.equal(normalizeDesktopToolPrompt({}), null);
});

test("write, launch and command prompts keep their exact target and never become standing grants", () => {
  const command = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-command",
      tool: "run_command",
      action: "command",
      scopePath: "C:\\project\\Vups Router",
      scopeName: "Vups Router",
      summary: "Run the client test suite",
      access: "execute",
      readOnly: false,
      modifiesData: true,
      command: "npm test",
      details: ["Shell: powershell", "Working folder: C:\\project\\Vups Router"],
      expiresAt: Date.now() + 60_000
    }
  });
  assert.equal(command.access, "execute");
  assert.equal(command.command, "npm test");
  assert.equal(command.readOnly, false);
  assert.equal(command.modifiesData, true);
  assert.equal(command.canPersist, false, "a command is never a standing permission");
  assert.deepEqual(command.details, ["Shell: powershell", "Working folder: C:\\project\\Vups Router"]);

  const write = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-write",
      tool: "write_file",
      action: "write",
      scopePath: "C:\\project\\Vups Router\\agent-test.txt",
      scopeName: "agent-test.txt",
      summary: "Write agent-test.txt",
      access: "write",
      readOnly: false,
      modifiesData: true
    }
  });
  assert.equal(write.canPersist, false, "a write is never converted into a standing permission");

  const terminate = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-terminate",
      tool: "close_app",
      action: "terminate",
      scopePath: "Process 4242",
      scopeName: "Process 4242",
      summary: "Force-terminate the VupsRouter-launched app",
      access: "launch",
      readOnly: false,
      destructive: true
    }
  });
  assert.equal(terminate.access, "launch", "force-terminate is app control, not a file read");
  assert.equal(terminate.destructive, true);
  assert.equal(terminate.canPersist, false);
});

test("only the native canPersist flag enables Allow Always, and it names one file", () => {
  const file = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-file",
      tool: "read_file",
      action: "contents",
      scopePath: "C:\\Users\\Vishnu\\Downloads\\notes.txt",
      scopeName: "notes.txt",
      summary: "Read notes.txt",
      access: "contents",
      readOnly: true,
      canPersist: true
    }
  });
  assert.equal(file.canPersist, true);
  assert.equal(file.access, "contents");
  assert.equal(file.scopePath, "C:\\Users\\Vishnu\\Downloads\\notes.txt");

  const launch = normalizeDesktopToolPrompt({
    payload: {
      requestId: "req-launch",
      tool: "launch_app",
      action: "launch",
      scopePath: "C:\\Program Files\\Blender\\blender.exe",
      scopeName: "Blender",
      summary: "Launch Blender",
      access: "launch",
      canPersist: true
    }
  });
  assert.equal(launch.canPersist, true);

  // A malformed payload cannot smuggle a truthy non-boolean into the card.
  const forged = normalizeDesktopToolPrompt({
    payload: { requestId: "req-forged", scopePath: "C:\\tmp\\a.txt", canPersist: "yes" }
  });
  assert.equal(forged.canPersist, false);
});

test("new capability results are summarized from native data and never invented", () => {
  const summary = localFilesystemSummary([
    {
      tool: "write_file",
      label: "Writing a local file",
      ok: true,
      data: { path: "C:\\tmp\\agent-test.txt", bytesWritten: 11, size: 11 }
    },
    {
      tool: "run_command",
      label: "Running a command",
      ok: true,
      data: { status: "exited", exitCode: 0, durationMs: 42, stdout: "5.1.22621.1\r\n", stderr: "" }
    },
    {
      tool: "launch_app",
      label: "Launching an app",
      ok: true,
      data: { name: "Blender", pid: 4242, running: true }
    },
    {
      tool: "start_command",
      label: "Starting a background command",
      ok: true,
      data: { processId: "proc-7", pid: 4243, running: true }
    },
    {
      tool: "command_output",
      label: "Reading command output",
      ok: true,
      data: { status: "running", running: true, stdout: "ready\n", stderr: "" }
    },
    {
      tool: "stop_command",
      label: "Stopping a background command",
      ok: true,
      data: { processId: "proc-7", alreadyExited: false }
    },
    {
      tool: "delete_path",
      label: "Deleting a local item",
      ok: true,
      data: { path: "C:\\tmp\\agent-test.txt", entriesDeleted: 1 }
    }
  ]);

  assert.match(summary, /11 bytes written/);
  assert.match(summary, /C:\\tmp\\agent-test\.txt/);
  assert.match(summary, /exit code 0/);
  assert.match(summary, /5\.1\.22621\.1/, "the real stdout is shown");
  assert.match(summary, /Blender launched \(PID 4242\), confirmed running/);
  assert.match(summary, /cannot interact with the app's window/);
  assert.match(summary, /processId `proc-7`, PID 4243\), running/);
  assert.match(summary, /ready/, "background output is shown");
  assert.match(summary, /stopped \(processId `proc-7`\)/);
  assert.match(summary, /permanently deleted/);
  assert.match(summary, /not moved to the Recycle Bin/);
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

test("the approval card is short, in-chat, and offers exactly three actions", () => {
  assert.match(cardSource, /className="vr-permission-card"/);
  assert.match(cardSource, /VupsRouter wants permission/);
  assert.match(cardSource, /request\.canPersist === true/, "native eligibility decides the third action");

  // The required fields are present and the old explanations are gone.
  assert.match(cardSource, /file: "File"/);
  assert.match(cardSource, /label: "Location"|>\s*Location\s*</);
  assert.match(cardSource, /<dt>Location<\/dt>/);
  assert.match(cardSource, /\{target\.location\}/, "the exact path is shown");
  assert.match(cardSource, /request\.scopePath/, "the location comes from the native scope");
  assert.match(cardSource, /Allow Once/);
  assert.match(cardSource, /Allow Always \(Only for This File\)/);
  assert.match(cardSource, /Deny/);
  assert.doesNotMatch(cardSource, /Access requested|Changes your data|scopeCopy|ACCESS_LINES|OPERATION_LINES/);

  // A warning appears only for a destructive or risky operation.
  assert.match(cardSource, /request\.destructive/);
  assert.match(cardSource, /This cannot be undone/);
  assert.match(cardSource, /This runs a command on your PC/);
  assert.match(cardSource, /This changes a file on your PC/);
  assert.match(cardSource, /role="note"/);

  // The button is visible for every request but only usable for one exact file
  // or app; when disabled the card says why in one line.
  assert.match(cardSource, /disabled=\{busy \|\| !canRemember\}/);
  assert.match(cardSource, /Only a single file or app can be remembered/);

  // Applying a decision is a transient state, not a result line.
  assert.match(cardSource, /Applying…/);
  assert.match(cardSource, /role="alert"/);

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
  assert.match(rustSource, /fn request\(&self, app: &AppHandle, owner: &str, prompt: &ApprovalPrompt\)/);
  assert.match(rustSource, /await_decision\(&joined,/);
  assert.match(rustSource, /That permission request was already answered/);
  assert.match(rustSource, /fn cancel_all/);
});

test("Allow Always is backed by an exact-resource grant in the native engine", () => {
  // The saved grant names one resource, not a folder.
  assert.match(rustSource, /struct ResourceGrant\b/);
  assert.match(rustSource, /fn valid_resource_grant\(grant: &ResourceGrant\)/);
  assert.match(rustSource, /grant\.kind == CONTENT_SCOPE \|\| grant\.kind == LAUNCH_SCOPE/);
  assert.match(rustSource, /fn covers\(&self, owner: &str, kind: &str, target: &Path\) -> bool/);
  assert.match(rustSource, /fn same_path\(left: &Path, right: &Path\) -> bool/);
  assert.match(rustSource, /canonical_for_policy/);

  // Eligibility is decided natively: only reading one existing file or
  // launching one existing executable can be saved. Folders, metadata, writes,
  // deletes, protected paths, network paths and symlinks cannot.
  assert.match(rustSource, /fn action_persistable\(action: &str\) -> bool/);
  assert.match(rustSource, /matches!\(action, "contents" \| "launch"\)/);
  assert.match(rustSource, /fn exact_resource_can_persist\(path: &Path\) -> bool/);
  assert.match(rustSource, /is_protected_system_path\(path\)/);
  assert.match(rustSource, /file_type\(\)\.is_symlink\(\)/);
  assert.match(rustSource, /is_network_path\(&path_text\(path\)\)/);

  // Every answer is revalidated when it is applied, and a decision to save a
  // resource is not silently turned into a broader one.
  assert.match(rustSource, /can_persist: bool/);
  assert.match(rustSource, /ApprovalDecision::AlwaysResource/);
  assert.match(rustSource, /if fresh && granted == ApprovalDecision::AlwaysResource \{\s*ApprovalDecision::Once\s*\}/);

  // The behaviours the UI depends on are pinned by native tests.
  for (const name of [
    "an_exact_file_grant_survives_and_is_revocable",
    "an_exact_file_grant_cannot_reach_another_file_a_folder_or_the_parent",
    "an_exact_file_grant_never_unlocks_its_folder_or_other_files",
    "folder_listings_metadata_writes_and_commands_cannot_be_saved",
    "legacy_folder_grants_are_dropped_instead_of_widened",
    "a_reparse_point_cannot_back_a_saved_file_grant",
    "full_access_still_asks_for_a_protected_system_file",
    "an_unanswered_request_expires_as_a_denial",
    "traversal_and_relative_paths_are_rejected",
    "a_junction_cannot_carry_a_read_outside_the_workspace",
    "a_symlink_cannot_carry_a_read_outside_the_workspace"
  ]) {
    assert.match(rustSource, new RegExp(`fn ${name}\\(`), name);
  }
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

  // Nowhere in the client copy does the app tell anyone to touch Windows ACLs.
  assert.doesNotMatch(desktopChat, /icacls|Security tab|Properties → Security|take ownership of|NTFS/i);
  assert.match(
    desktopChat,
    /made no permission, ownership or elevation changes/,
    "an access_denied result states what the app did not do"
  );

  // The matching server prompt rule is pinned by the server repository's own
  // suite (server/src/desktopTools.test.js): this file used to read
  // ../../server/src/desktopTools.js, which only exists in a two-repo local
  // checkout and failed every CI run of the client alone.

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

test("saved exact-file grants are inspectable and revocable from settings", () => {
  const pages = readFileSync(new URL("../src/desktop/DesktopPages.jsx", import.meta.url), "utf8");
  assert.match(pages, /<FolderAccessSection \/>/, "the section is mounted in Settings");
  assert.match(pages, /await revokeDesktopToolGrant\(id\)/);
  assert.match(pages, /await clearDesktopToolGrants\(\)/);
  assert.match(pages, /grant\.path/, "each row shows the file it covers");
  assert.match(pages, /grant\.kind === "contents"/);
  assert.match(pages, /Can read this exact file/);
  assert.match(pages, /Can launch this exact app/);
  assert.match(pages, /never its folder/);
  assert.match(pages, /Revoke all files/);
  assert.match(pages, /no keys/);
  assert.match(pages, /no file contents/);
  // The list is read from the native store, never from frontend memory.
  assert.match(pages, /setGrants\(await listDesktopToolGrants\(\)\)/);
  assert.match(bridgeSource, /export (?:async )?function listDesktopToolGrants/);
  assert.match(bridgeSource, /invoke\("desktop_tool_grant_revoke"/);

  assert.match(rustSource, /pub async fn desktop_tool_grant_revoke/, "revocation is a native command");
  const capabilities = readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8"
  );
  assert.match(capabilities, /desktop-tools/, "the grant commands are inside the app capability");
});
