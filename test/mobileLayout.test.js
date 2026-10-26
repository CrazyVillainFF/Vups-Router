import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chatReference, selectionFromRow } from "../src/chat/modelCatalog.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const LONG_OLLAMA_ID = "llama3.1:70b-instruct-q8_0-custom-very-long-identifier";

test("markdown tables scroll inside their wrapper and never stack characters vertically", () => {
  const css = read("src/chat.css");
  const page = read("src/ChatPage.jsx");
  assert.match(page, /className="vr-table-wrap" role="region" aria-label="Scrollable table" tabIndex=\{0\}/);
  assert.match(css, /\.vr-table-wrap\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.vr-msg-md table\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.vr-msg-md th,\s*\.vr-msg-md td\s*\{[^}]*min-width:\s*96px[^}]*word-break:\s*normal/s);
  assert.match(css, /\.vr-msg-md td a,[\s\S]*?overflow-wrap:\s*anywhere/);
});

test("fenced code scrolls locally and keeps its own copy control", () => {
  const css = read("src/chat.css");
  const page = read("src/ChatPage.jsx");
  assert.match(page, /className="vr-code-block"/);
  assert.match(page, /className="vr-code-copy"/);
  assert.match(page, /aria-label=\{copied \? "Copied" : "Copy code"\}/);
  assert.match(css, /\.vr-code-block\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(css, /\.vr-code-block pre\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.vr-code-lang\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.vr-code-copy\s*\{[^}]*flex:\s*none/s);
});

test("the chat shell fills the visual viewport without spilling the page", () => {
  const css = read("src/chat.css");
  assert.match(css, /\.vr-chat-layout\s*\{[^}]*height:\s*100svh;[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.vr-chat-main\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0/s);
  assert.match(css, /\.vr-sidebar\s*\{[^}]*height:\s*100svh;[^}]*height:\s*100dvh/s);
  assert.match(css, /\.vr-message-list\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.vr-chat-header\s*\{[^}]*padding:\s*env\(safe-area-inset-top, 0px\)/s);
});

test("the mobile drawer slides in, traps focus, and yields to Escape", () => {
  const css = read("src/chat.css");
  const page = read("src/ChatPage.jsx");
  assert.match(css, /\.vr-sidebar\s*\{[^}]*transform:\s*translateX\(-102%\)[^}]*visibility:\s*hidden/s);
  assert.match(css, /\.vr-sidebar--mobile-open\s*\{[^}]*transform:\s*none;[^}]*visibility:\s*visible/s);
  assert.match(page, /inert=\{mobileSidebarOpen \|\| undefined\}/);
  assert.match(page, /if \(event\.key === "Escape"\) setMobileSidebarOpen\(false\)/);
  assert.match(page, /aria-controls="vr-sidebar"/);
  assert.match(page, /aria-expanded=\{mobileSidebarOpen\}/);
  assert.match(page, /id="vr-sidebar"/);
});

test("the mobile composer is compact and hides helper text", () => {
  const css = read("src/chat.css");
  const bar = read("src/components/reactbits/PromptBar.css");
  assert.match(
    css,
    /@media \(max-width: 650px\)[\s\S]*?\.vr-composer\s*\{\s*padding:\s*6px 10px calc\(8px \+ env\(safe-area-inset-bottom, 0px\)\)/s
  );
  assert.match(css, /@media \(max-width: 650px\)[\s\S]*?\.vr-composer-hint\s*\{\s*display:\s*none/s);
  assert.match(css, /@media \(max-width: 650px\)[\s\S]*?\.vr-mode-switch__button\s*\{[^}]*padding:\s*4px 9px/s);
  assert.match(bar, /\.prompt-bar__field\s*\{[^}]*padding:\s*8px 10px;[^}]*gap:\s*4px/s);
  assert.match(bar, /\.prompt-bar__bar\s*\{[^}]*gap:\s*2px/s);
  assert.doesNotMatch(bar, /@media \(max-width: 560px\)/);
});

test("the model selector shrinks and truncates while send keeps its full size", () => {
  const css = read("src/components/reactbits/PromptBar.css");
  const page = read("src/components/reactbits/PromptBar.jsx");
  assert.match(css, /\.prompt-bar__bar\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.prompt-bar__pick\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.prompt-bar__pick span\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.prompt-bar__pick--model\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0/s);
  assert.match(css, /\.prompt-bar__pick > svg\s*\{\s*flex:\s*none/s);
  assert.match(css, /\.prompt-bar__send\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px/s);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*?\.prompt-bar__send\s*\{\s*width:\s*44px;\s*height:\s*44px/s);
  assert.match(css, /@media \(max-width: 380px\)[\s\S]*?\.prompt-bar__generate span,[\s\S]*?display:\s*none/s);
  assert.match(page, /aria-label=\{`Choose model, currently \$\{model\.name\}`\}/);
  assert.match(page, /title=\{model\.name\}/);
  assert.match(page, /<span title=\{model\.name\}>\{model\.name\}<\/span>/);
});

test("a long model name only truncates its label, never the id sent to the backend", () => {
  const page = read("src/components/reactbits/PromptBar.jsx");
  assert.match(page, /setModelKey\(row\.key\);\s*latest\.current\.onModelChange\?\.\(row\)/);
  const row = { name: "deepseek-v4.1-…", model: "deepseek-v4.1-flash:cloud", configId: "cfg-long", providerId: "prov" };
  assert.equal(selectionFromRow(row).model, "deepseek-v4.1-flash:cloud");
  assert.equal(chatReference(row).model, "deepseek-v4.1-flash:cloud");
  const ollama = { name: LONG_OLLAMA_ID.slice(0, 18), model: LONG_OLLAMA_ID, configId: "cfg-ollama" };
  assert.equal(selectionFromRow(ollama).model, LONG_OLLAMA_ID);
  assert.equal(chatReference(ollama).model, LONG_OLLAMA_ID);
  const chat = read("src/ChatPage.jsx");
  assert.match(chat, /const reference = chatReference\(activeRow\);\s*const modelKey = reference\.model/);
  assert.match(chat, /model: modelKey,/);
});

test("mobile inputs stay at 16px so the keyboard cannot hide the send button", () => {
  const css = read("src/chat.css");
  const bar = read("src/components/reactbits/PromptBar.css");
  assert.match(bar, /@media \(pointer: coarse\)[\s\S]*?\.prompt-bar__input\s*\{\s*font-size:\s*16px/s);
  const base = css.indexOf(".vr-prompt-bar .prompt-bar__input,");
  const coarse = css.indexOf("@media (pointer: coarse) and (max-width: 650px)");
  assert.ok(base >= 0 && coarse > base, "the 16px override must come after the 14px composer rule");
  assert.match(css.slice(coarse), /\.vr-prompt-bar \.prompt-bar__input\s*\{\s*font-size:\s*16px;/);
});

test("the composer grows with the prompt but caps its height", () => {
  const page = read("src/components/reactbits/PromptBar.jsx");
  assert.match(page, /const LINE = 22;/);
  assert.match(page, /const max = LINE \* maxRows;/);
  assert.match(page, /el\.style\.height = `\$\{Math\.min\(el\.scrollHeight, max\)\}px`/);
  assert.match(page, /el\.style\.overflowY = el\.scrollHeight > max \? 'auto' : 'hidden'/);
  assert.match(page, /if \(e\.key === 'Enter' && !e\.shiftKey && !e\.nativeEvent\.isComposing\)/);
});
