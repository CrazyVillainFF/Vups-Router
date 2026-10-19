import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_IMAGE_TYPES,
  IMAGE_LIMITS,
  formatBytes,
  isImageFile,
  isErrorAttachment,
  readyAttachments,
  toPayloadImages
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
