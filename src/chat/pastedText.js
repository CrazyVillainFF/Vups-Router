/**
 * Long pasted prompts become compact "Pasted Text" attachments.
 *
 * The card is a normal text attachment (see attachments.js), so the existing
 * send pipeline keeps folding its `text` into the outgoing user message and
 * nothing about the wire format changes.
 */

import { generateAttachmentId } from "./attachments.js";

const envInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

export const PASTE_TYPE_LABEL = "Pasted Text";
export const PASTE_MIME_TYPE = "text/plain";

// Prompts below this stay ordinary composer text.
export const PASTE_MIN_BYTES = envInt(
  import.meta.env?.VITE_PASTE_ATTACHMENT_MIN_BYTES,
  4 * 1024
);

// Read-only preview render cap; the stored text is never truncated.
export const PASTE_PREVIEW_CHARS = 20000;

export function utf8ByteLength(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return new TextEncoder().encode(text).length;
}

export function formatPromptSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function isLongPaste(text, minBytes = PASTE_MIN_BYTES) {
  return (
    typeof text === "string" &&
    text.trim().length > 0 &&
    utf8ByteLength(text) >= minBytes
  );
}

export function pastedTextTitle(text) {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstLine) return "Pasted prompt";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return collapsed.length > 44 ? `${collapsed.slice(0, 43).trimEnd()}...` : collapsed;
}

export function isPastedTextAttachment(item) {
  return Boolean(item && typeof item === "object" && item.source === "paste" && item.kind === "text");
}

export function pastedTextAttachment(text, id = generateAttachmentId()) {
  const raw = typeof text === "string" ? text : "";
  const title = pastedTextTitle(raw);
  return {
    id,
    kind: "text",
    name: title,
    path: title,
    mimeType: PASTE_MIME_TYPE,
    size: utf8ByteLength(raw),
    text: raw,
    source: "paste",
    status: "ready"
  };
}

// Editing keeps the same id so the card is replaced in place instead of added.
export function withPastedTextContent(item, text) {
  const raw = typeof text === "string" ? text : "";
  const title = pastedTextTitle(raw);
  return { ...item, name: title, path: title, text: raw, size: utf8ByteLength(raw) };
}

export function pastedTextPreview(item) {
  const raw = typeof item?.text === "string" ? item.text : "";
  if (raw.length <= PASTE_PREVIEW_CHARS) return { text: raw, truncated: false };
  return { text: raw.slice(0, PASTE_PREVIEW_CHARS), truncated: true };
}
