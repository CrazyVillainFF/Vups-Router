import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_IMAGE_TYPES,
  ATTACHMENT_LIMITS,
  IMAGE_LIMITS,
  SERVER_IMAGE_TYPES,
  TEXT_LIMITS,
  attachmentTotals,
  contentWithTextAttachments,
  fileIdentity,
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

test("the wire format stays on the four formats the backend sniffs", () => {
  assert.deepEqual(SERVER_IMAGE_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const type of SERVER_IMAGE_TYPES) assert.ok(ACCEPTED_IMAGE_TYPES.includes(type));
  for (const type of ["image/bmp", "image/svg+xml", "image/avif", "image/heic", "image/heif"]) {
    assert.ok(ACCEPTED_IMAGE_TYPES.includes(type), `${type} must be selectable and converted`);
  }
});

test("isImageFile detects images from mime type or file extension", () => {
  assert.equal(isImageFile({ type: "image/png" }), true);
  assert.equal(isImageFile({ name: "photo.PNG", type: "" }), true);
  assert.equal(isImageFile({ name: "scan.jpeg" }), true);
  assert.equal(isImageFile({ name: "notes.md", type: "" }), false);
  assert.equal(isImageFile({ type: "application/pdf" }), false);
  assert.equal(isImageFile(null), false);
});

test("fileIdentity keeps same-named files apart and detects re-picks", () => {
  const base = { name: "index.html", size: 120, lastModified: 1_700_000_000_000 };
  assert.equal(fileIdentity(base), "index.html|120|1700000000000");
  assert.equal(
    fileIdentity({ ...base, webkitRelativePath: "a/index.html" }),
    "a/index.html|120|1700000000000"
  );
  assert.notEqual(
    fileIdentity({ ...base, webkitRelativePath: "a/index.html" }),
    fileIdentity({ ...base, webkitRelativePath: "b/index.html" })
  );
  assert.notEqual(fileIdentity(base), fileIdentity({ ...base, size: 121 }));
  assert.notEqual(fileIdentity(base), fileIdentity({ ...base, lastModified: 1_700_000_000_001 }));
  assert.equal(
    fileIdentity({ name: "src\\index.html", webkitRelativePath: "src\\index.html", size: 1, lastModified: 2 }),
    "src/index.html|1|2"
  );
  assert.equal(fileIdentity(null), "");
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

test("attachmentTotals applies limits to the running composer total", () => {
  const totals = attachmentTotals([
    readyItem({ size: 100 }),
    readyItem({ id: "att-2", name: "two.jpg", size: 50 }),
    { id: "att-3", kind: "text", source: "picker", text: "abc", size: 3, status: "ready" },
    { id: "att-4", kind: "text", source: "paste", text: "a pasted prompt", size: 16, status: "ready" },
    { id: "att-5", kind: "image", name: "bad.png", status: "error", error: "no" },
    { id: "att-6", kind: "folder", status: "ready", fileCount: 10 }
  ]);
  assert.deepEqual(totals, {
    images: 2,
    imageBytes: 150,
    texts: 1,
    textBytes: 3,
    textChars: 3
  });
});

test("image limits default to ten images per message", () => {
  assert.equal(IMAGE_LIMITS.count, 10);
  assert.equal(IMAGE_LIMITS.bytes, 4 * 1024 * 1024);
  assert.equal(IMAGE_LIMITS.totalBytes, 24 * 1024 * 1024);
});

test("folder and file cards are limited to 25 per message", () => {
  assert.equal(ATTACHMENT_LIMITS.folderFile, 25);
  assert.equal(ATTACHMENT_LIMITS.images, 10);
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
  assert.equal(
    validateTextFile(textFile("empty.txt", "", { size: 0 })).ok,
    true,
    "size 0 is unknown on Android and is decided from the content"
  );
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

test("an empty text file fails with its own reason instead of disappearing", async () => {
  await assert.rejects(
    () => readTextAttachment(textFile("empty.txt", ""), "empty-1"),
    /appears to be empty/
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
