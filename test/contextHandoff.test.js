import test from "node:test";
import assert from "node:assert/strict";
import { buildContextHandoff, handoffTitle, HANDOFF_LIMITS } from "../src/chat/contextHandoff.js";

const messages = [
  { role: "user", content: "Build a responsive chess website with a board and move history." },
  { role: "assistant", content: "I'll create index.html, styles.css and app.js.\n\n```html\n<h1>full source that must not be copied</h1>\n```" },
  { role: "user", content: "Use vanilla JavaScript. Do not add a framework. Must support mobile." },
  { role: "assistant", content: "The board generation and move validation are implemented.", artifact: { status: "partial", files: [{ path: "index.html", language: "html", complete: true }, { path: "app.js", language: "js", complete: false }] } }
];

test("context handoff preserves the goal, requirements, constraints, files and next steps", () => {
  const handoff = buildContextHandoff(messages, { model: "gpt-oss:120b", title: "Chess site" });
  assert.match(handoff, /Goal:/);
  assert.match(handoff, /responsive chess website/i);
  assert.match(handoff, /vanilla JavaScript/i);
  assert.match(handoff, /Do not add a framework/i);
  assert.match(handoff, /index\.html/);
  assert.match(handoff, /app\.js/);
  assert.match(handoff, /incomplete/i);
  assert.match(handoff, /gpt-oss:120b/);
  assert.match(handoff, /Next steps:/);
});

test("handoff never copies complete source code and stays bounded", () => {
  const longSource = `\`\`\`html\n${"<div>source</div>\n".repeat(2000)}\`\`\``;
  const handoff = buildContextHandoff(
    [
      { role: "user", content: "Build a page" },
      { role: "assistant", content: `Here is the page.\n${longSource}` },
      ...Array.from({ length: 20 }, (_, index) => ({ role: "user", content: `Requirement ${index}: ${"detail ".repeat(200)}` }))
    ],
    { model: "some-model" }
  );
  assert.ok(handoff.length <= HANDOFF_LIMITS.maxChars + 120);
  assert.equal(handoff.includes("<div>source</div>\n".repeat(50)), false);
  assert.equal(handoff.length > 0, true);
});

test("handoff titles are concise and clearly marked as continued chats", () => {
  assert.equal(handoffTitle(messages), "Build a responsive chess website with a board and move history (continued)");
  const longTitle = handoffTitle([{ role: "user", content: "A".repeat(200) }]);
  assert.ok(longTitle.length <= 120);
  assert.match(longTitle, /\(continued\)$/);
  assert.equal(handoffTitle([]), "Continued chat");
});
