import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  SLASH_COMMANDS,
  classifySlash,
  commandForAction,
  helpText,
  slashMenuItems
} from "../src/chat/slashCommands.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

/* §2 and §3 together make a promise about the composer that is easy to break by
   accident: a known command runs an action, anything else is sent exactly as the
   user typed it, and a lone slash never crashes and never vanishes. These rules
   are pure, so they are tested here rather than through a browser. */

test("each documented command is recognised and carries a real action", () => {
  for (const name of ["/github", "/repo", "/help"]) {
    const entry = classifySlash(name);
    assert.equal(entry.kind, "command", `${name} is a command`);
    assert.equal(entry.command.name, name);
    assert.ok(entry.command.action, `${name} is wired to an action`);
  }
  assert.deepEqual(
    SLASH_COMMANDS.map(command => command.name),
    ["/github", "/repo", "/help"],
    "the menu and the grammar are the same list"
  );
});

test("arguments after a command are handed to the action", () => {
  const entry = classifySlash("/repo CrazyVillainFF/Vups-Router");
  assert.equal(entry.kind, "command");
  assert.equal(entry.args, "CrazyVillainFF/Vups-Router");
  assert.equal(classifySlash("  /help  ").args, "");
});

test("a command name is matched case-insensitively and only at the start", () => {
  assert.equal(classifySlash("/GitHub").command.action, "github");
  assert.equal(classifySlash("please /repo now").kind, "none", "a slash mid-sentence is ordinary text");
  assert.equal(classifySlash("C:/project Vups").kind, "none", "a Windows path is not a command");
  assert.equal(classifySlash("hello there").kind, "none");
});

test("a lone slash is kept, not sent and not a crash", () => {
  for (const draft of ["/", "/ ", "/  "]) {
    const entry = classifySlash(draft);
    assert.equal(entry.kind, "literal", `${JSON.stringify(draft)} is never sent as a command`);
    assert.equal(entry.reason, "empty");
    assert.equal(entry.text, draft, "the draft the user typed is returned unchanged");
  }
});

test("an unknown command stays literal text the model actually receives", () => {
  const entry = classifySlash("/summon the deploy script");
  assert.equal(entry.kind, "literal");
  assert.equal(entry.reason, "unknown");
  assert.equal(entry.text, "/summon the deploy script", "the leading slash is preserved, not eaten");
});

test("empty and unknown drafts do not resolve to a command object", () => {
  assert.equal(classifySlash("").kind, "none");
  assert.equal(classifySlash(undefined).kind, "none");
  assert.equal(classifySlash(null).kind, "none");
  assert.equal(classifySlash(12).kind, "none");
});

test("the menu items describe every action the grammar accepts", () => {
  const items = slashMenuItems();
  assert.deepEqual(items.map(item => item.name), SLASH_COMMANDS.map(command => command.name));
  for (const item of items) {
    assert.ok(item.description, `${item.name} says what pressing it does`);
    assert.ok(item.key);
    assert.equal(item.name[0], "/", "PromptBar matches on the name without the slash");
  }
  assert.equal(commandForAction("repo").name, "/repo");
  assert.equal(commandForAction("nonsense"), null);
});

test("/help states each command and that anything else is sent verbatim", () => {
  const text = helpText();
  for (const command of SLASH_COMMANDS) {
    assert.ok(text.includes(command.name), `${command.name} is listed`);
  }
  assert.match(text, /sent to the model exactly as you typed it/i, "the unknown-command rule is told, not hidden");
});

/* Wiring guards: the grammar is worthless if the composer never asks it, and the
   check has to happen before anything that can reject the send, so a command
   works even when no model is chosen. */
test("the composer is given the command list and consults it before sending", () => {
  const chat = readFileSync(path.join(srcDir, "ChatPage.jsx"), "utf8");
  assert.match(chat, /commands=\{COMPOSER_COMMANDS\}/, "PromptBar is handed the slash menu");
  assert.match(chat, /const COMPOSER_COMMANDS = slashMenuItems\(\);/);

  const gate = chat.slice(chat.indexOf("async function beforeComposerSend"), chat.indexOf("const images = (Array.isArray"));
  assert.ok(gate.includes("classifySlash(text)"), "the send path classifies the draft");
  assert.ok(gate.includes('entry.kind === "command"'), "a command runs its action instead of sending");
  assert.ok(gate.includes('entry.reason === "empty"'), "a lone slash is refused with a message");
  assert.ok(
    gate.indexOf("classifySlash") < gate.indexOf("availabilityBlocker(selectedRow)"),
    "commands work even before a model is chosen"
  );
});

test("the three actions are real: browser, repository scope, help notice", () => {
  const chat = readFileSync(path.join(srcDir, "ChatPage.jsx"), "utf8");
  const runner = chat.slice(chat.indexOf("function runSlashCommand"), chat.indexOf("async function beforeComposerSend"));
  assert.match(runner, /setRepoBrowserOpen\(true\)/, "/github and bare /repo open the browser");
  assert.match(runner, /setRepoBrowserTarget/, "/github owner/name opens inside that repository");
  assert.match(runner, /scopeRepo\(/, "/repo owner/name scopes this chat");
  assert.match(runner, /setComposerWarning\(helpText\(\)\)/, "/help answers in the composer strip");
  assert.match(runner, /is not a repository/, "an unparseable argument says so instead of doing nothing");
  assert.match(chat, /<GitHubRepoBrowser/, "the browser is rendered by the chat page");
  assert.match(chat, /className="vr-chat-repo"/, "a scoped repository shows as a chip above the composer");
});
