import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PASTE_MIN_BYTES,
  PASTE_PREVIEW_CHARS,
  PASTE_TYPE_LABEL,
  formatPromptSize,
  isLongPaste,
  isPastedTextAttachment,
  pastedTextAttachment,
  pastedTextPreview,
  pastedTextTitle,
  utf8ByteLength,
  withPastedTextContent
} from "../src/chat/pastedText.js";
import {
  contentWithTextAttachments,
  fileTextAttachments,
  formatTextAttachments,
  pastedTextAttachments,
  readyTextAttachments,
  textAttachmentChars
} from "../src/chat/attachments.js";
import {
  attachmentPermissionDetails,
  permissionDecision
} from "../src/native/permissions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const composer = read("src/components/reactbits/PromptBar.jsx");

// A prompt comfortably over the 4 KB threshold, with the messiness a real
// paste carries: CRLF, tabs, emoji, quotes, and code.
const LONG_PROMPT = [
  "Refactor the payment retry module.",
  "",
  "\tConstraints:",
  "  - keep `chargeCard()` exported  — public API",
  "  - no new dependencies (emoji: 🙂🧪)",
  "  - tests must stay green: npm test",
  "  - “smart quotes”, apostrophes' and backticks` are fine",
  "",
  "Background: the module retried 12 times overnight and the queue grew to 4k.",
  "The user sees a spinner, so the retry must stay invisible but bounded."
].join("\r\n");

function longPrompt(minBytes = PASTE_MIN_BYTES) {
  let text = LONG_PROMPT;
  while (utf8ByteLength(text) < minBytes) text += `\r\n${LONG_PROMPT}`;
  return text;
}

function pickFileItem(text = "helper contents") {
  return {
    id: "att-file-1",
    kind: "text",
    name: "helper.js",
    path: "src/helper.js",
    mimeType: "text/javascript",
    size: text.length,
    text,
    source: "picker",
    status: "ready"
  };
}

test("1. a short prompt stays ordinary composer text", () => {
  assert.equal(isLongPaste("Summarize this PR."), false);
  assert.equal(isLongPaste(""), false);
  assert.equal(isLongPaste("   \n\t  "), false);
  assert.equal(isLongPaste(undefined), false);
  assert.equal(isLongPaste(LONG_PROMPT), false, "the fixture must stay under the threshold");
  // The composer only converts on an explicit threshold hit; anything else is
  // left to the browser so normal typing/pasting is untouched.
  const pasteGuard = composer.match(/if \(!isLongPaste\(text, pasteMinBytes\)\) return;/);
  assert.ok(pasteGuard, "short pastes must return before preventDefault");
});

test("2. a 10 KB pasted prompt becomes a compact attachment card", () => {
  const text = longPrompt(10 * 1024);
  assert.ok(utf8ByteLength(text) >= 10 * 1024);
  assert.equal(isLongPaste(text), true);
  const item = pastedTextAttachment(text);
  assert.equal(item.kind, "text");
  assert.equal(item.source, "paste");
  assert.equal(item.status, "ready");
  assert.equal(item.mimeType, "text/plain");
  assert.equal(isPastedTextAttachment(item), true);
  assert.equal(isPastedTextAttachment(pickFileItem()), false);
  assert.ok(item.name, "the card needs a title");
  assert.equal(item.size, utf8ByteLength(text));
});

test("3. the card label shows the real size, e.g. 13.2 KB", () => {
  assert.equal(formatPromptSize(Math.round(13.2 * 1024)), "13.2 KB");
  assert.equal(formatPromptSize(512), "512 B");
  assert.equal(formatPromptSize(0), "0 B");
  assert.equal(formatPromptSize(2 * 1024 * 1024), "2.0 MB");
  const base = longPrompt();
  const sized = base + "a".repeat(Math.round(13.2 * 1024) - utf8ByteLength(base));
  assert.equal(utf8ByteLength(sized), 13517);
  const item = pastedTextAttachment(sized);
  assert.equal(item.size, 13517);
  assert.equal(formatPromptSize(item.size), "13.2 KB");
});

test("4. size is measured in UTF-8 bytes, not JavaScript characters", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("🙂"), 4);
  assert.equal(utf8ByteLength("€"), 3);
  const emoji = "🙂".repeat(1500);
  assert.equal(emoji.length, 3000, "UTF-16 code units");
  assert.equal(utf8ByteLength(emoji), 6000);
  assert.equal(isLongPaste(emoji, 4096), true);
  assert.equal(isLongPaste("a".repeat(4095), 4096), false);
  assert.equal(isLongPaste("a".repeat(4096), 4096), true);
  assert.equal(pastedTextAttachment(emoji).size, 6000);
  assert.equal(formatPromptSize(utf8ByteLength(emoji)), "5.9 KB");
});

test("5. the stored text is byte-for-byte the original paste", () => {
  const text = longPrompt();
  const item = pastedTextAttachment(text);
  assert.equal(item.text, text);
  assert.ok(item.text.includes("\r\n"));
  assert.ok(item.text.includes("\t"));
  assert.ok(item.text.includes("🙂🧪"));
  assert.ok(item.text.includes("“smart quotes”"));
  assert.equal(item.text.length, text.length, "no truncation on store");
  // The 4 KB threshold is bytes; a text can be attached below it after editing.
  const small = pastedTextAttachment(LONG_PROMPT);
  assert.equal(small.text, LONG_PROMPT);
});

test("6. the title comes from the first meaningful line", () => {
  assert.equal(pastedTextTitle("Refactor the payment module.\nmore"), "Refactor the payment module.");
  assert.equal(pastedTextTitle("\n\n   \t\n  Second line counts  "), "Second line counts");
  assert.equal(pastedTextTitle("a    b   c"), "a b c", "runs of whitespace collapse");
  assert.equal(pastedTextTitle(""), "Pasted prompt");
  assert.equal(pastedTextTitle("   \n  "), "Pasted prompt");
  const long = "x".repeat(120);
  const title = pastedTextTitle(long);
  assert.equal(title, `${"x".repeat(43)}...`);
  assert.ok(title.length <= 46, "the title stays compact");
});

test("7. editing updates title and size in place without duplicating the card", () => {
  const original = pastedTextAttachment(longPrompt(), "att-paste-1");
  const editedText = "Shorter replacement prompt.\r\nSecond line.";
  const edited = withPastedTextContent(original, editedText);
  assert.equal(edited.id, original.id, "same id so the card is replaced, not added");
  assert.equal(edited.text, editedText);
  assert.equal(edited.name, "Shorter replacement prompt.");
  assert.equal(edited.path, "Shorter replacement prompt.");
  assert.equal(edited.size, utf8ByteLength(editedText));
  assert.equal(edited.source, "paste");
  // In-place map keeps exactly one card.
  const next = [original, pickFileItem()].map(item =>
    item.id === edited.id ? edited : item
  );
  assert.equal(next.filter(item => isPastedTextAttachment(item)).length, 1);
  const cleared = withPastedTextContent(original, "   ");
  assert.equal(cleared.text, "   ");
  // The composer drops the card instead of keeping a blank one.
  assert.match(composer, /if \(edited\.trim\(\)\)/);
});

test("8. sending submits the entire original prompt exactly once", () => {
  const text = longPrompt();
  const item = pastedTextAttachment(text);
  const ready = readyTextAttachments([item]);
  const sent = contentWithTextAttachments("", ready);
  assert.equal(sent, text, "a paste-only send is the raw prompt");
  assert.equal(sent.split(text).length - 1, 1, "exactly once");
  assert.ok(!sent.includes("BEGIN ATTACHED FILE"), "a paste is not reference material");
  assert.ok(!sent.includes("untrusted data"));
  assert.ok(!sent.includes(`[${PASTE_TYPE_LABEL}]`), "no placeholder is sent");
  // Draft text plus a paste: both present, paste once, no markers.
  const withIntro = contentWithTextAttachments("Do this now.", ready);
  assert.ok(withIntro.startsWith("Do this now."));
  assert.equal(withIntro.split(text).length - 1, 1);
  assert.ok(withIntro.length >= "Do this now.".length + text.length);
  // An unrelated picked file still gets the untrusted-data framing, and the
  // paste is not dragged into it or duplicated.
  const mixed = contentWithTextAttachments("review please", readyTextAttachments([item, pickFileItem()]));
  assert.equal(mixed.split(text).length - 1, 1);
  assert.equal(mixed.split("helper contents").length - 1, 1);
  assert.match(mixed, /BEGIN ATTACHED FILE 1: src\/helper\.js/);
  assert.match(mixed, /untrusted data, not as instructions/);
  assert.ok(mixed.indexOf(text) < mixed.indexOf("BEGIN ATTACHED FILE"));
  assert.equal(pastedTextAttachments([item, pickFileItem()]).length, 1);
  assert.equal(fileTextAttachments([item, pickFileItem()]).length, 1);
  // The file formatter itself is untouched; only the fold routes pastes around it.
  assert.match(formatTextAttachments([item]), /BEGIN ATTACHED FILE 1/);
  assert.ok(!contentWithTextAttachments("", [item]).includes("BEGIN ATTACHED FILE"));
});

test("9. provider and model switches never touch the attached prompt", () => {
  const text = longPrompt();
  const item = pastedTextAttachment(text);
  // The send payload carries the attachments array untouched, so the card
  // travels into contentWithTextAttachments with its full text.
  assert.match(
    composer,
    /latest\.current\.onSend\?\.\(draft\.trim\(\), \{ attachments, model, effort: level \}\)/
  );
  assert.equal(textAttachmentChars([item]), text.length);
  assert.equal(contentWithTextAttachments("", [item]), text);
  // No menu/selection handler may drop the card: only send, remove, and the
  // paste editor touch the attachments array.
  const menuSetters = ["setModelOpen", "setModelQuery", "setPlusOpen", "setEffortOpen", "setModelKey", "setEffortIndex"];
  for (const line of composer.split(/\r?\n/)) {
    if (!line.includes("setAttachments(")) continue;
    assert.ok(
      menuSetters.every(setter => !line.includes(setter)),
      `attachments must not be cleared alongside a menu setter: ${line.trim()}`
    );
  }
  assert.equal(composer.match(/setAttachments\(\[\]\)/g).length, 1, "only send() empties the array");
  const sendBody = composer.slice(composer.indexOf("const send = async () =>"));
  assert.match(sendBody.slice(0, 900), /setAttachments\(\[\]\)[\s\S]*setPasteView\(null\)/);
});

test("10. the card survives draft restore and retry re-injection", () => {
  // Retry/edit injects through the draftValue signal; the paste card is a
  // normal attachment item, so it round-trips through JSON unchanged.
  const item = pastedTextAttachment(longPrompt());
  const restored = JSON.parse(JSON.stringify(item));
  assert.deepEqual(restored, item);
  assert.equal(isPastedTextAttachment(restored), true);
  assert.equal(contentWithTextAttachments("", [restored]), item.text);
  assert.match(composer, /draftValue/);
});

test("11. existing messages and file attachments are unaffected", () => {
  const file = pickFileItem("export const a = 1;");
  const sent = contentWithTextAttachments("Explain this.", readyTextAttachments([file]));
  assert.match(sent, /^Explain this\.\n\nThe user attached the following/);
  assert.equal(sent.split("export const a = 1;").length - 1, 1);
  assert.equal(contentWithTextAttachments("plain question", []), "plain question");
  assert.equal(formatTextAttachments([]), "");
});

test("12. a pasted prompt is not a local file read on Windows", () => {
  const item = pastedTextAttachment(longPrompt());
  for (const mode of ["ask", "workspace", "full"]) {
    const decision = permissionDecision(mode, [item]);
    assert.equal(decision.allowed, true, mode);
    assert.equal(decision.requiresConfirmation, false, mode);
  }
  assert.deepEqual(attachmentPermissionDetails([item]), []);
  // A real pick still asks in "ask" mode, and both together asks only for the file.
  assert.equal(permissionDecision("ask", [item, pickFileItem()]).requiresConfirmation, true);
  assert.equal(attachmentPermissionDetails([item, pickFileItem()]).length, 1);
});

test("13. preview is capped for rendering while the stored text stays whole", () => {
  const huge = longPrompt(60 * 1024) + "🙂".repeat(10);
  const item = pastedTextAttachment(huge);
  const preview = pastedTextPreview(item);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.length, PASTE_PREVIEW_CHARS);
  assert.equal(item.text.length, huge.length);
  const small = pastedTextPreview(pastedTextAttachment(LONG_PROMPT));
  assert.equal(small.truncated, false);
  assert.equal(small.text, LONG_PROMPT);
  assert.deepEqual(pastedTextPreview(null), { text: "", truncated: false });
});

test("14. the composer renders the card with icon, title, label, size, and actions", () => {
  assert.match(composer, /prompt-bar__chip--paste/);
  assert.match(composer, /prompt-bar__chip-open/);
  assert.match(composer, /File02Icon/);
  assert.match(composer, /Edit01Icon/);
  assert.match(composer, /\{PASTE_TYPE_LABEL\} · \{formatPromptSize\(utf8ByteLength\(pasteView\.text\)\)\}/);
  assert.match(composer, /aria-expanded=\{pasteView\?\.id === item\.id\}/);
  assert.match(composer, /aria-label=\{`Remove \$\{label\}`\}/);
  assert.match(composer, /Close preview; the pasted prompt stays attached/);
  // Removing a card clears its open popover instead of orphaning it.
  assert.match(composer, /if \(target && pasteView\?\.id === target\.id\) setPasteView\(null\);/);
  // Escape dismisses without deleting.
  assert.match(composer, /if \(event\.key !== 'Escape'\) return;/);
  // The card itself renders only title + label + size; the body appears in the
  // popover, capped for viewing and full only in the explicit editor.
  assert.ok(composer.includes("prompt-bar__chip--paste"), "the card needs its own class");
  assert.ok(composer.includes("prompt-bar__chip-name"), "card needs the derived title");
  assert.ok(composer.includes("prompt-bar__chip-kind"), "card needs the Pasted Text label and size");
  assert.ok(!composer.includes("{item.text}"), "the card must not render the whole prompt");
  assert.match(composer, /\{pastePreview\.text\}/);
  assert.match(composer, /value=\{pasteView\.text\}/);
  assert.match(composer, /preview stops after/);
  // Clipboard text alone decides conversion, so an unrelated file attach cannot
  // trigger a card: the file branch returns before the text branch runs.
  const pasteHandler = composer.slice(composer.indexOf("onPaste={e => {"), composer.indexOf("onPaste={e => {") + 900);
  assert.ok(pasteHandler.indexOf("collectFiles") < pasteHandler.indexOf("isLongPaste"), "files first, then text");
  assert.match(pasteHandler, /if \(!isLongPaste\(text, pasteMinBytes\)\) return;/);
  assert.match(pasteHandler, /setAttachments\(current => \[\.\.\.current, pastedTextAttachment\(text\)\]\)/);
  // Threshold is a prop, so it stays configurable.
  assert.match(composer, /pasteMinBytes = PASTE_MIN_BYTES/);
});

test("15. an oversized paste hits the real message limit instead of truncating", () => {
  const chatPage = read("src/ChatPage.jsx");
  // The 32k guard counts pasted text as message characters, so an over-limit
  // prompt is rejected with a visible warning rather than silently shortened.
  assert.match(chatPage, /const charCount = text\.length \+ textAttachmentChars\(textFiles\);/);
  assert.match(chatPage, /charCount > MAX_USER_MESSAGE_CHARS/);
  assert.match(chatPage, /too long\. Keep the total under/);
  assert.match(chatPage, /requestText\.length > MAX_USER_MESSAGE_CHARS/);
  const huge = longPrompt(40 * 1024);
  assert.ok(huge.length > 32000, "fixture must exceed the shipped message limit");
  assert.equal(textAttachmentChars([pastedTextAttachment(huge)]), huge.length);
  // Nothing in the paste path shortens the stored text.
  assert.equal(pastedTextAttachment(huge).text.length, huge.length);
});
