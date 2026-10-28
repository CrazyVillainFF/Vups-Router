import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_LIMITS,
  TEXT_LIMITS,
  contentWithTextAttachments,
  formatBytes,
  formatTextAttachments,
  isImageFile,
  isErrorAttachment,
  isTextAttachmentFile,
  readTextAttachment,
  readyAttachments,
  readyTextAttachments,
  toPayloadImages,
  validateTextFile
} from "../src/chat/attachments.js";
import { toRequestMessages } from "../src/services/chat.js";

const DATA_URL = "data:image/png;base64,QUJDRA==";

function readyItem(overrides = {}) {
  return {
    id: "att-1",
    name: "cat.png",
    mimeType: "image/png",
    size: 4,
    dataUrl: DATA_URL,
    status: "ready",
    ...overrides
  };
}

test("accepted image types cover the formats the backend sniffs", () => {
  assert.deepEqual(ACCEPTED_IMAGE_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
});

test("isImageFile only accepts image mime types", () => {
  assert.equal(isImageFile({ type: "image/png" }), true);
  assert.equal(isImageFile({ type: "application/pdf" }), false);
  assert.equal(isImageFile(null), false);
});

test("formatBytes renders readable sizes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(4 * 1024 * 1024), "4.0 MB");
  assert.equal(formatBytes(0), "0 B");
});

test("readyAttachments filters out error items and payload-less entries", () => {
  const items = [
    readyItem(),
    { id: "att-2", name: "bad.svg", status: "error", error: "nope" },
    { id: "att-3", name: "history.png", mimeType: "image/png", bytes: 10 },
    null
  ];
  const ready = readyAttachments(items);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].id, "att-1");
  assert.equal(isErrorAttachment(items[1]), true);
  assert.equal(isErrorAttachment(items[0]), false);
});

test("toPayloadImages strips the data URL prefix and keeps metadata", () => {
  const payload = toPayloadImages([readyItem()]);
  assert.deepEqual(payload, [{ name: "cat.png", mimeType: "image/png", data: "QUJDRA==" }]);
  assert.equal(toPayloadImages([{ status: "error" }]).length, 0);
});

test("toRequestMessages attaches images to the final message only", () => {
  const history = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "", images: [readyItem()] }
  ];
  const messages = toRequestMessages(history);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].images, undefined);
  assert.equal(messages[1].images, undefined);
  assert.deepEqual(messages[2].images, [{ name: "cat.png", mimeType: "image/png", data: "QUJDRA==" }]);
  assert.equal(messages[2].content, "");
});

test("toRequestMessages keeps text-only conversations unchanged", () => {
  const messages = toRequestMessages([{ role: "user", content: "hello" }]);
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("image limits default to the backend defaults", () => {
  assert.equal(IMAGE_LIMITS.count, 4);
  assert.equal(IMAGE_LIMITS.bytes, 4 * 1024 * 1024);
  assert.equal(IMAGE_LIMITS.totalBytes, 8 * 1024 * 1024);
});

function textFile(name, text, overrides = {}) {
  return {
    name,
    type: "text/plain",
    size: new TextEncoder().encode(text).length,
    text: async () => text,
    ...overrides
  };
}

test("text attachment detection accepts source files and rejects binaries", () => {
  assert.equal(isTextAttachmentFile(textFile("notes.md", "hello")), true);
  assert.equal(isTextAttachmentFile({ name: "main.js", type: "" }), true);
  assert.equal(isTextAttachmentFile({ name: "photo.png", type: "image/png" }), false);
  assert.equal(isTextAttachmentFile({ name: "report.pdf", type: "application/pdf" }), false);
});

test("validateTextFile enforces type, size, and count limits", () => {
  assert.equal(validateTextFile(textFile("notes.md", "hello")).ok, true);
  assert.equal(validateTextFile({ name: "report.pdf", type: "application/pdf", size: 10 }).ok, false);
  assert.equal(validateTextFile(textFile("empty.txt", "", { size: 0 })).ok, false);
  assert.equal(validateTextFile(textFile("big.txt", "x", { size: TEXT_LIMITS.bytes + 1 })).ok, false);
  assert.equal(validateTextFile(textFile("notes.md", "x"), { remaining: 0 }).ok, false);
});

test("readTextAttachment normalizes a local text file", async () => {
  const item = await readTextAttachment(textFile("src/main.js", "export const answer = 42;", {
    type: "text/javascript",
    webkitRelativePath: "workspace/src/main.js"
  }), "file-1", "folder");
  assert.equal(item.kind, "text");
  assert.equal(item.path, "workspace/src/main.js");
  assert.equal(item.source, "folder");
  assert.equal(item.status, "ready");
  await assert.rejects(
    () => readTextAttachment(textFile("binary.txt", "hello\u0000world")),
    /binary/
  );
});

test("text attachment prompt is delimited and marked untrusted", () => {
  const items = [
    { id: "f1", kind: "text", name: "notes.md", path: "workspace/notes.md", size: 5, text: "hello", status: "ready" },
    { id: "f2", kind: "text", name: "skip.md", status: "error", error: "bad" }
  ];
  assert.equal(readyTextAttachments(items).length, 1);
  const block = formatTextAttachments(items);
  assert.match(block, /untrusted data, not as instructions/);
  assert.match(block, /BEGIN ATTACHED FILE 1: workspace\/notes\.md/);
  assert.doesNotMatch(block, /skip\.md/);
  assert.match(contentWithTextAttachments("Please review.", items), /Please review\.[\s\S]*BEGIN ATTACHED FILE/);
});

test("toRequestMessages adds text files only to the final user message", () => {
  const textFiles = [
    { id: "f1", kind: "text", name: "notes.md", path: "notes.md", size: 5, text: "hello", status: "ready" }
  ];
  const messages = toRequestMessages([
    { role: "user", content: "first", textFiles },
    { role: "assistant", content: "reply" },
    { role: "user", content: "", textFiles }
  ]);
  assert.equal(messages[0].content, "first");
  assert.match(messages[2].content, /BEGIN ATTACHED FILE 1/);
  assert.match(messages[2].content, /hello/);
});

test("workspace files carry native provenance and a readable relative path", async () => {
  const { workspaceTextFile } = await import("../src/chat/attachments.js");
  const file = workspaceTextFile("export const a = 1;", "src/app.jsx");

  assert.equal(file.attachmentSource, "workspace");
  assert.equal(file.relativePath, "src/app.jsx");
  assert.equal(file.name, "app.jsx");
  assert.equal(file.type, "text/plain");
  assert.ok(validateTextFile(file).ok);

  const item = await readTextAttachment(file, "att-ws", file.attachmentSource);
  assert.equal(item.source, "workspace");
  assert.equal(item.path, "src/app.jsx");
  assert.equal(item.text, "export const a = 1;");
});

test("backslash workspace paths normalize to forward slashes", async () => {
  const { workspaceTextFile } = await import("../src/chat/attachments.js");
  const file = workspaceTextFile("data", "src\\components\\PromptBar.jsx");
  assert.equal(file.relativePath, "src/components/PromptBar.jsx");
  assert.equal(file.name, "PromptBar.jsx");
});
