import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_LIMITS,
  artifactFromResponse,
  mergeContinuation,
  responseSummary,
  shouldCreateArtifact,
  streamingArtifact
} from "../src/chat/artifacts.js";
import { extractCodeFiles } from "../src/chat/codeFiles.js";

test("small examples and short snippets stay in normal chat", () => {
  const prose = artifactFromResponse("Use a semantic heading like this.\n\n```html\n<h1>Hi</h1>\n```");
  assert.equal(prose, null);
  assert.equal(shouldCreateArtifact(extractCodeFiles("```js\nconsole.log('hello')\n```")), false);
});

test("a long single file becomes an exact complete artifact with a concise summary", () => {
  const source = `<main>\n${"x".repeat(3200)}\n</main>`;
  const markdown = `Here is the page.\n\n\`\`\`html\n${source}\n\`\`\``;
  const artifact = artifactFromResponse(markdown);
  assert.ok(artifact);
  assert.equal(artifact.status, "complete");
  assert.equal(artifact.summary, "Here is the page.");
  assert.equal(artifact.files.length, 1);
  assert.equal(artifact.files[0].path, "index.html");
  assert.equal(artifact.files[0].content, `${source}\n`);
  assert.equal(artifact.files[0].complete, true);
});

test("streaming previews include an unclosed final file without claiming completion", () => {
  const markdown = [
    "I am building the app.",
    "FILE: index.html",
    "```html",
    "<main>Hello</main>",
    "```",
    "FILE: app.js",
    "```js",
    "const message = \"hello"
  ].join("\n");
  const streaming = streamingArtifact(markdown);
  assert.ok(streaming);
  assert.equal(streaming.status, "partial");
  assert.equal(streaming.files.length, 2);
  assert.equal(streaming.files[1].path, "app.js");
  assert.equal(streaming.files[1].complete, false);
  assert.equal(streaming.files[1].content, 'const message = "hello');

  const interrupted = artifactFromResponse(markdown, { status: "partial" });
  assert.equal(interrupted.files[1].content, 'const message = "hello');
});

test("continuation merges the missing tail exactly and does not duplicate text", () => {
  assert.equal(mergeContinuation("const a = 1;\nconst b = ", "2;\n", "app.js"), "const a = 1;\nconst b = 2;\n");
  assert.equal(
    mergeContinuation("const a = 1;\n", "const a = 1;\nconst b = 2;\n", "app.js"),
    "const a = 1;\nconst b = 2;\n"
  );
  assert.equal(mergeContinuation("const a = 1;", "```js\nconst b = 2;\n```", "app.js"), "const a = 1;const b = 2;");
});

test("artifact summaries are bounded and never expose source as commentary", () => {
  const files = [{ path: "app.js", content: "x".repeat(4000), complete: true }];
  const summary = responseSummary(`intro\n${"word ".repeat(5000)}\n\`\`\`js\n${"x".repeat(4000)}\n\`\`\``, files);
  assert.ok(summary.length <= ARTIFACT_LIMITS.maxSummaryChars + 1);
  assert.ok(!summary.includes("x".repeat(100)));
  assert.match(summary, /^intro/);
});
