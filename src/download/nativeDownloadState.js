import { fileSizeLabel } from "../chat/codeFiles.js";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const KNOWN_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "removed"]);

export function normalizeDownload(raw) {
  const status = KNOWN_STATUSES.has(raw?.status) ? raw.status : "failed";
  const bytes = Number.isFinite(Number(raw?.bytes)) ? Math.max(0, Number(raw.bytes)) : 0;
  const total = Number.isFinite(Number(raw?.total)) ? Number(raw.total) : -1;
  return {
    id: String(raw?.id || ""),
    filename: String(raw?.filename || "download"),
    mimeType: typeof raw?.mimeType === "string" ? raw.mimeType : "",
    status,
    bytes,
    total: total > 0 ? total : -1,
    speedBytesPerSecond:
      Number.isFinite(Number(raw?.speedBytesPerSecond)) && Number(raw.speedBytesPerSecond) > 0
        ? Number(raw.speedBytesPerSecond)
        : 0,
    error: typeof raw?.error === "string" ? raw.error : "",
    createdAt: Number.isFinite(Number(raw?.createdAt)) ? Number(raw.createdAt) : 0,
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : 0,
    canOpen: raw?.canOpen === true,
    canRetry: raw?.canRetry === true
  };
}

export function isActiveDownload(download) {
  return ACTIVE_STATUSES.has(download?.status);
}

export function applyDownloadEvent(downloads, event) {
  const list = Array.isArray(downloads) ? downloads : [];
  if (!event?.id) return list;
  if (event.status === "removed") return list.filter(download => download.id !== event.id);
  const next = list.filter(download => download.id !== event.id);
  next.push(normalizeDownload(event));
  return next.sort((left, right) => right.createdAt - left.createdAt);
}

export function downloadPercent(download) {
  if (!download || download.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((download.bytes * 100) / download.total)));
}

export function downloadSizeText(download) {
  if (!download) return "";
  const bytes = fileSizeLabel(download.bytes);
  if (download.status === "completed") return fileSizeLabel(download.total > 0 ? download.total : download.bytes);
  if (download.total > 0) return `${bytes} of ${fileSizeLabel(download.total)}`;
  return `${bytes} downloaded`;
}

export function downloadSpeedText(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${fileSizeLabel(bytesPerSecond)}/s`;
}

export function downloadStatusText(download) {
  if (!download) return "";
  const percent = downloadPercent(download);
  if (download.status === "queued") return "Waiting to start…";
  if (download.status === "running") {
    const size = downloadSizeText(download);
    const speed = downloadSpeedText(download.speedBytesPerSecond);
    const head = percent == null ? size : `${percent}% · ${size}`;
    return speed ? `${head} · ${speed}` : head;
  }
  if (download.status === "completed") return `Complete · ${downloadSizeText(download)}`;
  if (download.status === "cancelled") return "Cancelled";
  return download.error || "Download failed";
}

export function downloadProgressLabel(download) {
  if (!isActiveDownload(download)) return "";
  const percent = downloadPercent(download);
  if (percent == null) return "Downloading, size unknown";
  return `${percent}% downloaded`;
}

export function activeDownloadCount(downloads) {
  return (Array.isArray(downloads) ? downloads : []).filter(isActiveDownload).length;
}

export function finishedDownloadCount(downloads) {
  return (Array.isArray(downloads) ? downloads : []).filter(download => !isActiveDownload(download)).length;
}
