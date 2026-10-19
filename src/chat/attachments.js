/**
 * Image attachment helpers for chat.
 *
 * The composer collects real File objects (picker, drag & drop, paste) and
 * these helpers turn them into normalized attachment items:
 *
 *   { id, name, mimeType, size, dataUrl, status: "ready" }
 *   { id, name, status: "error", error }
 *
 * The wire format sent to the backend only includes ready images and strips
 * the base64 data-URL prefix: { name, mimeType, data }.
 */

const envInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const ACCEPTED_IMAGE_ACCEPT_ATTR = ACCEPTED_IMAGE_TYPES.join(",");

export const IMAGE_LIMITS = {
  count: envInt(import.meta.env?.VITE_IMAGE_MAX_COUNT, 4),
  bytes: envInt(import.meta.env?.VITE_IMAGE_MAX_BYTES, 4 * 1024 * 1024),
  totalBytes: envInt(import.meta.env?.VITE_IMAGE_MAX_TOTAL_BYTES, 8 * 1024 * 1024)
};

let attachmentCounter = 0;

export function generateAttachmentId() {
  attachmentCounter += 1;
  return `att-${Date.now().toString(36)}-${attachmentCounter}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function isImageFile(file) {
  return Boolean(file && typeof file.type === "string" && file.type.startsWith("image/"));
}

export function validateImageFile(file, { remaining = IMAGE_LIMITS.count } = {}) {
  if (!file || typeof file !== "object") return { ok: false, error: "That file could not be read." };
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return { ok: false, error: "Images must be PNG, JPEG, WebP, or GIF." };
  }
  if (Number(file.size || 0) <= 0) return { ok: false, error: "That image appears to be empty." };
  if (Number(file.size) > IMAGE_LIMITS.bytes) {
    return { ok: false, error: `Each image must be ${formatBytes(IMAGE_LIMITS.bytes)} or smaller.` };
  }
  if (remaining <= 0) {
    return { ok: false, error: `You can attach up to ${IMAGE_LIMITS.count} images per message.` };
  }
  return { ok: true };
}

export function readImageAttachment(file, id = generateAttachmentId()) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.startsWith("data:image/")) {
        reject(new Error("unreadable"));
        return;
      }
      resolve({
        id,
        name: file.name || `${file.type.split("/")[1] || "image"}`,
        mimeType: file.type,
        size: file.size,
        dataUrl: reader.result,
        status: "ready"
      });
    };
    reader.onerror = () => reject(reader.error || new Error("unreadable"));
    reader.readAsDataURL(file);
  });
}

export function isErrorAttachment(item) {
  return Boolean(item && typeof item === "object" && item.status === "error");
}

export function readyAttachments(items) {
  return (Array.isArray(items) ? items : []).filter(
    item =>
      item &&
      typeof item === "object" &&
      item.status !== "error" &&
      typeof item.dataUrl === "string" &&
      item.dataUrl.startsWith("data:image/") &&
      typeof item.mimeType === "string" &&
      item.dataUrl.includes(",")
  );
}

export function toPayloadImages(items) {
  return readyAttachments(items).map(item => ({
    ...(item.name ? { name: item.name } : {}),
    mimeType: item.mimeType,
    data: item.dataUrl.slice(item.dataUrl.indexOf(",") + 1)
  }));
}
