import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  readImageAttachment,
  readTextAttachment,
  readyAttachments,
  readyTextAttachments,
  toPayloadImages,
  validateTextFile
} from "../src/chat/attachments.js";
import { toRequestMessages } from "../src/services/chat.js";

const DATA_URL = "data:image/png;base64,QUJDRA==";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("camera-sized images retry decode with a scaled bitmap before failing", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  const calls = [];
  const bitmap = { width: 4032, height: 3024, close() {} };
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
      drawImage() {}
    }),
    toDataURL: () => "data:image/jpeg;base64,QUJDRA=="
  });
  globalThis.createImageBitmap = async (_blob, options) => {
    calls.push(options);
    if (!options) throw new Error("full-size decode failed");
    return bitmap;
  };
  globalThis.document = { createElement: () => canvas() };
  globalThis.Image = undefined;
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = new File([bytes], "camera.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 });
    const item = await readImageAttachment(file, "camera-1");
    assert.equal(item.status, "ready");
    assert.equal(item.mimeType, "image/jpeg");
    assert.equal(calls[0], undefined);
    assert.equal(calls[1]?.resizeWidth, 2048);
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
  }
});

// A camera photo is decoded at the size it will be used at, so the renderer
// never holds a full-resolution bitmap. This is the difference between a
// twelve megabyte picture costing forty six megabytes of pixels and costing
// twelve: on a phone the larger figure is what kills the renderer.
test("a camera photo is decoded at the size it will be used at, never whole", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  const originalUrl = globalThis.URL;
  const calls = [];
  globalThis.createImageBitmap = async (_blob, options) => {
    calls.push(options);
    return { width: options?.resizeWidth || 4032, height: options?.resizeHeight || 3024, close() {} };
  };
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "",
        drawImage() {}
      }),
      toDataURL: () => "data:image/jpeg;base64,QUJDRA=="
    })
  };
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 4032;
      this.naturalHeight = 3024;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.(), 0);
    }
  };
  globalThis.URL = { createObjectURL: () => "blob:test", revokeObjectURL: () => {} };
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = new File([bytes], "camera.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 });
    await readImageAttachment(file, "bounded");
    assert.ok(calls.length >= 1, "the image was decoded");
    const first = calls[0];
    assert.ok(first && first.resizeWidth, "the first decode is a bounded one");
    assert.equal(first.resizeWidth, 2048, "the decode is capped at the render size");
    assert.equal(first.resizeHeight, 1536, "the height follows the picture's own shape");
    assert.ok(
      first.resizeWidth * first.resizeHeight < 4032 * 3024,
      "the renderer never holds the whole photograph"
    );
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
    if (originalUrl === undefined) delete globalThis.URL;
    else globalThis.URL = originalUrl;
  }
});

test("a small picture is never blown up to the render size", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  const originalUrl = globalThis.URL;
  const calls = [];
  globalThis.createImageBitmap = async (_blob, options) => {
    calls.push(options);
    return { width: options?.resizeWidth || 500, height: options?.resizeHeight || 400, close() {} };
  };
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "",
        drawImage() {}
      }),
      toDataURL: () => "data:image/jpeg;base64,QUJDRA=="
    })
  };
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 500;
      this.naturalHeight = 400;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.(), 0);
    }
  };
  globalThis.URL = { createObjectURL: () => "blob:test", revokeObjectURL: () => {} };
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = new File([bytes], "small.jpg", { type: "image/jpeg" });
    // Big enough to be re-encoded, so the decode path is the one under test.
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 });
    await readImageAttachment(file, "small");
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].resizeWidth, 500, "a small picture keeps its own size");
    assert.equal(calls[0].resizeHeight, 400);
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
    if (originalUrl === undefined) delete globalThis.URL;
    else globalThis.URL = originalUrl;
  }
});

test("the encoder hands the browser a turn instead of blocking it back to back", () => {
  const source = readFileSync(path.join(root, "src/chat/attachments.js"), "utf8");
  const render = source.slice(source.indexOf("async function renderImage("), source.indexOf("async function readFileBuffer("));
  assert.match(render, /await yieldToTheBrowser\(\);/, "each attempt lets the composer paint");
  assert.match(source, /function yieldToTheBrowser\(\)/);
});

test("an encoded image is small enough to travel inside one request", () => {
  const source = readFileSync(path.join(root, "src/chat/attachments.js"), "utf8");
  assert.match(source, /export const MAX_TRANSMITTED_IMAGE_BYTES = 512 \* 1024;/);
  // The budget has to bound the whole ladder, not just the first attempt.
  const render = source.slice(source.indexOf("async function renderImage("), source.indexOf("async function readFileBuffer("));
  assert.match(render, /const budget = Math\.min\(IMAGE_LIMITS\.bytes, MAX_TRANSMITTED_IMAGE_BYTES\);/);
  assert.match(render, /if \(bytes <= budget\) break;/);
  assert.match(render, /if \(best && best\.bytes <= budget\) break;/);
});

test("the composer keeps the message when the submission fails", () => {
  const bar = readFileSync(path.join(root, "src/components/reactbits/PromptBar.jsx"), "utf8");
  const send = bar.slice(bar.indexOf("latest.current.onSend?.("), bar.indexOf("} catch {", bar.indexOf("latest.current.onSend?.(")));
  assert.match(send, /submission\.catch\(/, "a failed submission is handled");
  assert.match(send, /setDraft\(current => \(current \? current : draft\.trim\(\)\)\)/, "the typed text comes back");
  assert.match(send, /setAttachments\(current => \(current\.length \? current : outgoing\)\)/, "the picture comes back");
  assert.match(send, /setAttachError\(/, "the failure is shown in the composer");
});

test("the chat page marks a submission that never reached the server", () => {
  const page = readFileSync(path.join(root, "src/ChatPage.jsx"), "utf8");
  assert.match(page, /submissionFailedRef\.current = true;/, "a refused submission is marked");
  assert.match(
    page,
    /if \(submissionFailedRef\.current\) \{\s*submissionFailedRef\.current = false;\s*throw error;/,
    "the composer is told to keep the message"
  );
});

test("image decode closes the bitmap it created", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  let closed = 0;
  const bitmap = { width: 4032, height: 3024, close() { closed += 1; } };
  const canvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "",
      drawImage() {}
    }),
    toDataURL: () => "data:image/jpeg;base64,QUJDRA=="
  });
  globalThis.createImageBitmap = async () => bitmap;
  globalThis.document = { createElement: () => canvas() };
  globalThis.Image = undefined;
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const file = new File([bytes], "camera.jpg", { type: "image/jpeg" });
    Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 });
    const item = await readImageAttachment(file, "camera-2");
    assert.equal(item.status, "ready");
    assert.equal(closed, 1);
  } finally {
    if (originalCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalImage === undefined) delete globalThis.Image;
    else globalThis.Image = originalImage;
  }
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
