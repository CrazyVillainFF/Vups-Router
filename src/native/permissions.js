import { formatBytes } from "../chat/attachments.js";

export const WINDOWS_PERMISSION_STORAGE_KEY = "vupsrouter.windows.permission-mode";
export const DEFAULT_PERMISSION_MODE = "ask";

export const WINDOWS_PERMISSION_MODES = Object.freeze([
  {
    id: "ask",
    label: "Ask me every time",
    shortLabel: "Ask",
    risk: "Review",
    description: "Approve every local filesystem read and attachment before it is used."
  },
  {
    id: "workspace",
    label: "Agent (workspace)",
    shortLabel: "Workspace",
    risk: "Scoped",
    description: "Allow reads inside the selected workspace; ask before reading anything outside it."
  },
  {
    id: "full",
    label: "Full access",
    shortLabel: "Full",
    risk: "Broad",
    description: "Allow broad read-only filesystem tools, with native approval for protected system locations. No shell, writes, admin rights, or Windows permission bypass."
  }
]);

const MODE_IDS = new Set(WINDOWS_PERMISSION_MODES.map(mode => mode.id));

export function isPermissionMode(value) {
  return MODE_IDS.has(value);
}

export function loadPermissionMode(storage) {
  if (!storage) return DEFAULT_PERMISSION_MODE;
  try {
    const stored = storage.getItem(WINDOWS_PERMISSION_STORAGE_KEY);
    return isPermissionMode(stored) ? stored : DEFAULT_PERMISSION_MODE;
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

export function savePermissionMode(storage, mode) {
  if (!storage || !isPermissionMode(mode)) return DEFAULT_PERMISSION_MODE;
  try {
    storage.setItem(WINDOWS_PERMISSION_STORAGE_KEY, mode);
  } catch {
    /* storage is best-effort */
  }
  return mode;
}

export function permissionModeInfo(mode) {
  return WINDOWS_PERMISSION_MODES.find(item => item.id === mode) || WINDOWS_PERMISSION_MODES[0];
}

// Pasted text never touched the filesystem, so it is not a local read and must
// not raise the file-access prompt.
export function readyLocalAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).filter(
    item =>
      item &&
      typeof item === "object" &&
      item.status !== "error" &&
      item.source !== "paste"
  );
}

export function permissionDecision(mode, attachments) {
  const items = readyLocalAttachments(attachments);
  if (items.length === 0) {
    return { allowed: true, requiresConfirmation: false, items };
  }
  const resolvedMode = isPermissionMode(mode) ? mode : DEFAULT_PERMISSION_MODE;
  if (resolvedMode === "full") {
    return { allowed: true, requiresConfirmation: false, items };
  }
  if (resolvedMode === "workspace" && items.every(item => item.source === "folder" || item.source === "workspace")) {
    return { allowed: true, requiresConfirmation: false, items };
  }
  return { allowed: false, requiresConfirmation: true, items };
}

const SOURCE_LABELS = Object.freeze({ workspace: "Workspace file", folder: "Folder pick" });

function sourceLabel(item) {
  if (SOURCE_LABELS[item.source]) return SOURCE_LABELS[item.source];
  if (item.kind === "image" || item.dataUrl) return "Image pick";
  return "File pick";
}

export function attachmentPermissionDetails(attachments) {
  return readyLocalAttachments(attachments).map(item => ({
    id: item.id,
    name: item.name || item.path || "file",
    size: item.size,
    sizeLabel: formatBytes(item.size),
    source: sourceLabel(item)
  }));
}
