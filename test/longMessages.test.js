import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MESSAGE_WORD_LIMIT,
  collapseMessageText,
  countWords
} from "../src/chat/messageText.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const words = (count, prefix = "word") =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(" ");

test("messages at or under 70 words stay fully visible", () => {
  assert.equal(MESSAGE_WORD_LIMIT, 70);
  for (const count of [0, 1, 50, 70]) {
    const text = words(count);
    const result = collapseMessageText(text);
    assert.equal(result.truncated, false);
    assert.equal(result.display, text);
    assert.equal(result.text, text);
    assert.equal(result.totalWords, count);
  }
});

test("a 71-word message initially shows only the first 70 words", () => {
  const text = words(71);
  const result = collapseMessageText(text);
  assert.equal(result.truncated, true);
  assert.equal(result.totalWords, 71);
  assert.ok(result.display.endsWith("\u2026"));
  const visible = result.display.replace(/\u2026$/, "");
  assert.equal(countWords(visible), 70);
  assert.equal(visible, words(70));
});

test("collapsing keeps the original whitespace inside the visible prefix", () => {
  const text = `${words(70)}\n\nRemaining details ${words(10, "extra")}`;
  const result = collapseMessageText(text);
  assert.equal(result.truncated, true);
  assert.equal(result.display, `${words(70)}\u2026`);
});

test("the full message is never rewritten by the display helper", () => {
  const text = `${words(120)} end`;
  const result = collapseMessageText(text);
  assert.equal(result.text, text);
  assert.equal(result.totalWords, 121);
  assert.notEqual(result.display, text);
});

test("the chat collapses user bubbles at the display layer only", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /import \{ collapseMessageText \} from "\.\/chat\/messageText\.js";/);
  assert.match(page, /const collapsedMessage = useMemo\(/);
  assert.match(page, /aria-expanded=\{expanded\}/);
  assert.match(page, /aria-controls=\{textId\}/);
  assert.match(page, />\s*Show more\s*</);
  assert.match(page, />\s*Show less\s*</);
  // The toggle carries a directional caret so the affordance reads as expand/collapse.
  assert.match(
    page,
    /<CaretDown[^>]*aria-hidden="true"\s*\/>\s*Show more/
  );
  assert.match(page, /<CaretUp[^>]*aria-hidden="true"\s*\/>\s*Show less/);
  assert.match(page, /import \{[^}]*CaretDown[^}]*\} from "@phosphor-icons\/react";/s);
  const css = read("src/chat.css");
  assert.match(
    css,
    /\.vr-msg-expand\s*\{[^}]*display:\s*inline-flex/,
  );
  assert.match(css, /\.vr-msg-expand\s*\{[^}]*align-items:\s*center/);
  assert.match(page, /key=\{msg\.id\}/);
  // The submitted history and restored conversations keep the whole string.
  assert.match(page, /const entry = \{ role: message\.role, content: message\.content \};/);
  assert.match(page, /content: message\.content,/);
  assert.doesNotMatch(page, /setMessages\([\s\S]{0,160}collapseMessageText/);
});

test("each long message keeps its own expanded state", () => {
  const page = read("src/ChatPage.jsx");
  const messageSection = page.slice(page.indexOf("function Message({"), page.indexOf("function WelcomeScreen"));
  assert.match(messageSection, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(messageSection, /setExpanded\(\(value\) => !value\)/);
  assert.match(
    messageSection,
    /isUser && !message\.handoff \? collapseMessageText\(message\.content\) : null/
  );
});
