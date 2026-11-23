import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(path.resolve(here, "..", file), "utf8");

test("the semantic token layer names intent instead of repeating hex values", () => {
  const css = read("src/tokens.css");
  for (const token of [
    "--font-sans",
    "--text-2xs",
    "--text-3xl",
    "--leading-relaxed",
    "--tracking-caps",
    "--space-1",
    "--space-16",
    "--radius-xs",
    "--radius-pill",
    "--shadow-sm",
    "--duration-fast",
    "--duration-slow",
    "--ease-standard",
    "--text-primary",
    "--text-secondary",
    "--text-tertiary",
    "--surface-raised",
    "--surface-hover",
    "--success-soft",
    "--warning-soft",
    "--danger-soft",
    "--control-height"
  ]) {
    assert.match(css, new RegExp(`${token}\\s*:`), `${token} is missing from the token layer`);
  }
  // Colour roles must alias the existing primitives, not fork a second palette.
  assert.match(css, /--text-primary:\s*var\(--text\)/);
  assert.match(css, /--text-secondary:\s*var\(--muted\)/);
});

test("reduced motion is honoured globally without freezing progress indicators", () => {
  const css = read("src/styles.css");
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(block, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(block, /\[role="progressbar"\]/);
  assert.match(block, /animation-iteration-count:\s*infinite\s*!important/);
});

test("the chat welcome keeps only the free-model brand message", () => {
  const page = read("src/ChatPage.jsx");
  const css = read("src/chat.css");

  const welcome = page.slice(page.indexOf("function WelcomeScreen"), page.indexOf("function MessageList"));
  assert.match(welcome, /VupsRouter/);
  assert.match(welcome, /Connect Your/);
  assert.match(welcome, /Free Model/);
  assert.match(welcome, /100% Free/);
  assert.match(welcome, /Route every request to the best free AI model/);
  assert.doesNotMatch(welcome, /Ask once|The blocks are|START WITH A PROMPT|Explain a codebase|Draft a bug report|Plan a release/);
  assert.doesNotMatch(css, /\.vr-welcome-starters\s*\{/);
  assert.doesNotMatch(css, /\.vr-welcome-starter\b/);
});

test("the sidebar fold is signposted instead of slicing the last task", () => {
  const css = read("src/desktop/desktop.css");
  assert.match(css, /\.vr-sidebar-scroll::after\s*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.vr-sidebar-scroll::after\s*\{[^}]*linear-gradient\(to top/);
});

test("settings rows separate the destructive action from routine actions", () => {
  const page = read("src/SettingsPage.jsx");
  const css = read("src/settings.css");
  assert.match(page, /className="settings-remove-action"/);
  assert.match(css, /\.settings-saved-actions \.settings-remove-action\s*\{[^}]*margin-left:\s*auto/);
});
