import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import JSZip from "jszip";

import {
  artifactForTurn,
  codingIntent,
  continueArtifact,
  projectTitle,
  responseSummary,
  streamingArtifact,
  wantsInlineCode,
  artifactFromResponse
} from "../src/chat/artifacts.js";
import { extractCodeFiles, mimeForFile, safeFilePath } from "../src/chat/codeFiles.js";
import { buildProjectZip, downloadGeneratedFile, projectZipName } from "../src/chat/downloads.js";
import { settleTurnFromError } from "../src/chat/turnOutcome.js";
import { createAssistantTurn, TURN_STATUS } from "../src/chat/turnLifecycle.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const websiteMarkdown = [
  "Here is a responsive landing page with a working form.",
  "The layout uses CSS grid and the script validates the form.",
  "",
  "FILE: index.html",
  "```html",
  "<!doctype html>",
  "<html lang=\"en\">",
  "  <head>",
  "    <meta charset=\"utf-8\" />",
  "    <link rel=\"stylesheet\" href=\"style.css\" />",
  "  </head>",
  "  <body>",
  "    <main id=\"app\"></main>",
  "    <script src=\"script.js\"></script>",
  "  </body>",
  "</html>",
  "```",
  "",
  "FILE: style.css",
  "```css",
  ":root {",
  "  --gap: 12px;",
  "}",
  "main {",
  "  display: grid;",
  "  gap: var(--gap);",
  "}",
  "```",
  "",
  "FILE: script.js",
  "```js",
  "const form = document.querySelector('form');",
  "form?.addEventListener('submit', event => {",
  "  event.preventDefault();",
  "});",
  "```"
].join("\n");

test("a code flood becomes a complete artifact with prose-only chat", () => {
  const artifact = artifactForTurn({ content: websiteMarkdown, status: "complete" });
  assert.ok(artifact);
  assert.equal(artifact.status, "complete");
  assert.deepEqual(artifact.files.map(file => file.path), ["index.html", "style.css", "script.js"]);
  assert.ok(artifact.files.every(file => file.complete));
  assert.match(artifact.summary, /responsive landing page/);
  assert.doesNotMatch(artifact.summary, /<!doctype|<main|:root/);
});

test("CSS and JavaScript keep their own files and exact source", () => {
  const files = extractCodeFiles(websiteMarkdown);
  const css = files.find(file => file.path === "style.css");
  const js = files.find(file => file.path === "script.js");
  assert.ok(css && js);
  assert.equal(css.language, "css");
  assert.equal(js.language, "js");
  assert.equal(css.content, ":root {\n  --gap: 12px;\n}\nmain {\n  display: grid;\n  gap: var(--gap);\n}\n");
  assert.equal(js.content, "const form = document.querySelector('form');\nform?.addEventListener('submit', event => {\n  event.preventDefault();\n});\n");
});

test("a multi-file project exposes a usable project title", () => {
  const project = [
    "FILE: my-site/index.html",
    "```html",
    "<h1>Hi</h1>",
    "```",
    "FILE: my-site/css/style.css",
    "```css",
    "h1 { color: red; }",
    "```",
    "FILE: my-site/js/app.js",
    "```js",
    "console.log('ready');",
    "```"
  ].join("\n");
  const artifact = artifactForTurn({ content: project });
  assert.ok(artifact);
  assert.equal(projectTitle(artifact.files), "my-site");
  assert.deepEqual(artifact.files.map(file => file.path), [
    "my-site/index.html",
    "my-site/css/style.css",
    "my-site/js/app.js"
  ]);
});

test("finishing a turn keeps the artifact when the backend sends no artifact event", () => {
  const committed = artifactForTurn({ artifact: null, content: websiteMarkdown, status: "complete" });
  assert.ok(committed, "the final text must become the artifact instead of disappearing");
  assert.equal(committed.files.length, 3);
  const page = read("src/ChatPage.jsx");
  assert.match(page, /artifactForTurn\(\{ content: finalContent, status: "complete" \}\)/);
  assert.match(page, /artifact: committedArtifact/);
});

test("a structured backend artifact wins over a re-parse", () => {
  const backend = {
    status: "complete",
    files: [{ path: "main.py", content: "print('hi')\n", language: "py", bytes: 11, complete: true }]
  };
  const artifact = artifactForTurn({ artifact: backend, content: "ignored" });
  assert.deepEqual(artifact.files, backend.files);
  assert.equal(artifact.status, "complete");
  assert.equal(artifact.summary, "ignored");
});

test("short snippets stay inline and explicit show-code asks are honored", () => {
  assert.equal(artifactFromResponse("```js\nconsole.log('hello')\n```"), null);
  assert.equal(wantsInlineCode("build a responsive website"), false);
  assert.equal(wantsInlineCode("show me the full code here"), true);
  assert.equal(wantsInlineCode("print the source in your reply"), true);
  const page = read("src/ChatPage.jsx");
  assert.match(page, /const inlineRequested = wantsInlineCode\(text\)/);
  assert.match(page, /inlineRequested \? null : artifactForTurn/);
});

test("code written mid-stream is withheld from chat without dropping the prose", () => {
  const partial = `${websiteMarkdown.split("FILE: style.css")[0]}FILE: style.css\n\`\`\`css\nbody {`;
  const summary = responseSummary(partial, []);
  assert.match(summary, /responsive landing page/);
  assert.doesNotMatch(summary, /<!doctype|body \{/);
  const page = read("src/ChatPage.jsx");
  assert.match(page, /const streamingCode =/);
  assert.match(page, /responseSummary\(message\.content, artifact\?\.files \|\| \[\]\)/);
});

test("streaming and final artifacts never duplicate the source", () => {
  const openMarkdown = websiteMarkdown.replace("});\n```", "});");
  const live = streamingArtifact(openMarkdown);
  assert.ok(live);
  const final = artifactForTurn({ content: websiteMarkdown, status: "complete" });
  const liveJs = live.files.find(file => file.path === "script.js");
  const finalJs = final.files.find(file => file.path === "script.js");
  assert.equal(liveJs.complete, false);
  assert.equal(finalJs.complete, true);
  assert.equal(finalJs.content, `${liveJs.content}\n`);
  assert.equal(finalJs.content.split("const form =").length - 1, 1);
  assert.equal(live.status, "partial");
});

test("coding intent only treats real build requests as artifacts", () => {
  assert.equal(codingIntent("What is a closure?"), "");
  assert.equal(codingIntent("Build a responsive website"), "website");
});

test("an interrupted artifact keeps its valid files and Continue merges the tail once", () => {
  const openMarkdown = websiteMarkdown.replace("});\n```", "});\nconst b = ");
  const partial = artifactFromResponse(openMarkdown, { status: "partial" });
  assert.ok(partial);
  const base = partial.files.find(file => file.path === "script.js").content;
  assert.equal(partial.files.find(file => file.path === "script.js").complete, false);
  const merged = continueArtifact(partial, "2;\n", "script.js");
  const script = merged.files.find(file => file.path === "script.js");
  assert.equal(merged.status, "complete");
  assert.equal(script.complete, true);
  assert.equal(script.content, `${base}2;\n`);
  assert.equal(script.content.split("const form =").length - 1, 1);
  const stillPartial = continueArtifact(partial, "2;\n", "script.js", { status: "partial" });
  assert.equal(stillPartial.status, "partial");
  assert.equal(stillPartial.files.find(file => file.path === "script.js").complete, false);
});

test("continued text preserves the seam without duplicating prose", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /mergeTextContinuation\(target\.content, backendContent\)/);
  assert.match(page, /continueArtifact\(targetArtifact, continuationText \|\| backendContent, targetFile/);
});

test("a failed generation stops the working state exactly once", () => {
  const page = read("src/ChatPage.jsx");
  assert.match(page, /setStreamingId\(null\)/);
  assert.match(page, /settleTurnFromError\(prev, assistantId/);
  const failed = settleTurnFromError(
    [{ ...createAssistantTurn({ id: "a1" }), status: TURN_STATUS.STREAMING }],
    "a1",
    { error: { code: "stream_error", message: "The provider failed." }, content: "" }
  );
  assert.equal(failed.messages[0].status, TURN_STATUS.FAILED);
  assert.equal(failed.messages[0].artifact, null);
});

test("a save warning keeps the code and its download actions available", () => {
  const artifact = artifactForTurn({ content: websiteMarkdown });
  const messages = [
    {
      ...createAssistantTurn({ id: "a1" }),
      status: TURN_STATUS.STREAMING,
      content: websiteMarkdown
    }
  ];
  const settled = settleTurnFromError(messages, "a1", {
    error: { code: "artifact_persist_failed", message: "The generated code could not be saved to your history." },
    content: websiteMarkdown,
    artifact
  });
  assert.equal(settled.outcome, "save-warning");
  assert.equal(settled.messages[0].status, TURN_STATUS.COMPLETED);
  assert.equal(settled.messages[0].artifact.files.length, 3);
  assert.ok(settled.messages[0].saveWarning);
});

test("post-completion failures cannot remove a committed artifact", () => {
  const artifact = artifactForTurn({ content: websiteMarkdown });
  const completed = [
    {
      ...createAssistantTurn({ id: "a1" }),
      status: TURN_STATUS.COMPLETED,
      content: websiteMarkdown,
      artifact
    }
  ];
  const after = settleTurnFromError(completed, "a1", {
    error: { code: "stream_error", message: "late" },
    content: ""
  });
  assert.equal(after.messages[0].artifact, artifact);
  assert.equal(after.messages[0].status, TURN_STATUS.COMPLETED);
});

test("generated files render as compact real download rows", () => {
  const source = read("src/components/GeneratedFiles.jsx");
  assert.match(source, /files\.length === 0\) return null/);
  assert.match(source, /const actionsReady = !hasIncomplete/);
  assert.match(source, /artifact\?\.status !== "complete"/);
  assert.match(source, /artifact\?\.status !== "complete" \|\| files\.some\(file => file\.complete === false\)/);
  assert.match(source, /file\.complete === false/);
  assert.match(source, /aria-label=\{`Download \$\{file\.path\}`\}/);
  assert.match(source, /downloadGeneratedFile\(file, urlsRef\.current\)/);
  assert.match(source, /buildProjectZip\(files\)/);
  assert.match(source, /Could not prepare the ZIP/);
  assert.doesNotMatch(source, /href="#"/);
  assert.doesNotMatch(source, /Available when generation finishes|Open code|Download all \(\.zip\)/);
  const page = read("src/ChatPage.jsx");
  assert.equal(page.match(/<GeneratedFiles/g)?.length, 1);
  assert.match(page, /artifact && !isStreaming \? <GeneratedFiles artifact=\{artifact\} \/> : null/);
  assert.doesNotMatch(page, /CodeArtifact|MessageDownloads|ThoughtLine/);
});

test("individual downloads use the real filename, MIME type, and exact source", async () => {
  const originalDocument = globalThis.document;
  const originalBlob = globalThis.Blob;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let captured = null;
  let createdBlob = null;
  let revoked = [];
  class TestBlob extends originalBlob {
    constructor(parts, options) {
      super(parts, options);
      this.parts = parts;
      createdBlob = this;
    }
  }
  globalThis.Blob = TestBlob;
  globalThis.document = {
    createElement: () => {
      const link = {
        style: {},
        click() {
          captured = { href: link.href, download: link.download };
        },
        remove() {}
      };
      return link;
    },
    body: { appendChild() {} }
  };
  URL.createObjectURL = () => "blob:test-download";
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const content = "<!doctype html>\n<h1>Hello</h1>\n";
    downloadGeneratedFile({ path: "index.html", content }, new Set());
    assert.equal(captured.download, "index.html");
    assert.equal(await createdBlob.text(), content);
    assert.match(createdBlob.type, /^text\/html;charset=utf-8$/);
    assert.equal(mimeForFile("style.css"), "text/css;charset=utf-8");
    assert.equal(mimeForFile("script.js"), "text/javascript;charset=utf-8");
    assert.ok(revoked.length === 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.Blob = originalBlob;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("download object URLs are released", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let revoked = [];
  globalThis.document = {
    createElement: () => ({ style: {}, click() {}, remove() {} }),
    body: { appendChild() {} }
  };
  URL.createObjectURL = () => "blob:release-me";
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    downloadGeneratedFile({ path: "a.js", content: "ok" }, new Set());
    assert.deepEqual(revoked, []);
    t.mock.timers.tick(10000);
    assert.deepEqual(revoked, ["blob:release-me"]);
  } finally {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("Download all produces a valid ZIP with every generated file intact", async () => {
  const files = extractCodeFiles(websiteMarkdown);
  const blob = await buildProjectZip(files);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), [
    "vups-website/",
    "vups-website/index.html",
    "vups-website/script.js",
    "vups-website/style.css"
  ]);
  for (const file of files) {
    assert.equal(await zip.file(`vups-website/${file.path}`).async("string"), file.content);
  }
  assert.match(projectZipName(new Date("2026-10-26T12:00:00Z")), /^vups-website-2026-10-26\.zip$/);
});

test("ZIP and individual downloads stay safe for unicode and long names", async () => {
  const longName = `${"a".repeat(140)}-übersicht.css`;
  const path = safeFilePath(longName);
  assert.ok(path);
  assert.ok(path.length <= 104);
  assert.ok(path.endsWith(".css"));
  const files = [
    { path, content: "body { margin: 0; }\n", language: "css", bytes: 19 },
    { path: "skript-日本語.js", content: "console.log('ok');\n", language: "js", bytes: 18 }
  ];
  const zip = await JSZip.loadAsync(await (await buildProjectZip(files)).arrayBuffer());
  assert.equal(await zip.file(`vups-website/${path}`).async("string"), files[0].content);
  assert.equal(await zip.file("vups-website/skript-日本語.js").async("string"), files[1].content);
});

test("empty artifacts expose no actions and never report a false success", async () => {
  assert.equal(artifactForTurn({ content: "```html\n\n```" }), null);
  await assert.rejects(() => buildProjectZip([]), /no generated files/i);
  await assert.rejects(
    () => buildProjectZip([{ path: "index.html", content: "   " }]),
    /no generated files/i
  );
  assert.equal(shouldAvoidEmptyActions(), true);
});

function shouldAvoidEmptyActions() {
  const source = read("src/components/GeneratedFiles.jsx");
  return /files\.length === 0\) return null/.test(source) && !/downloadBlob\([^)]*""/.test(source);
}

test("long filenames and download actions stay usable on mobile", () => {
  const css = read("src/components/GeneratedFiles.css");
  assert.match(css, /\.vr-files__name\s*\{[^}]*min-width: 0/s);
  assert.match(css, /\.vr-files__name\s*\{[^}]*text-overflow: ellipsis/s);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.vr-files__download,\s*\.vr-files__zip\s*\{[^}]*width: 40px/s);
  assert.match(css, /\.vr-files__row\s*\{[^}]*min-height: 48px/s);
  assert.match(css, /prefers-reduced-motion/);
  const activity = read("src/components/AgentActivity.css");
  assert.match(activity, /\.vr-activity__file\s*\{[^}]*text-overflow: ellipsis/s);
  assert.match(activity, /prefers-reduced-motion/);
});
