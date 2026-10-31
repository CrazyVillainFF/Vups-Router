import { formatBytes } from "../chat/attachments.js";

export const WINDOWS_PERMISSION_STORAGE_KEY = "vupsrouter.windows.permission-mode";
export const DEFAULT_PERMISSION_MODE = "ask";

export const WINDOWS_PERMISSION_MODES = Object.freeze([
  {
    id: "ask",
    label: "Ask me every time",
    shortLabel: "Ask",
    risk: "Review",
    description:
      "Every protected local operation waits for an in-chat card that names the action, target and risk: file reads and writes, deletes, app launches, opening links, and commands. \"Allow Once\" covers that one call and is never converted automatically into a permanent permission; \"Allow Always (Only for This File)\" saves only the exact file or executable and stays revocable in Settings. Switching here from a broader mode clears those saved grants first."
  },
  {
    id: "workspace",
    label: "Agent (workspace)",
    shortLabel: "Workspace",
    risk: "Scoped",
    description:
      "File work stays inside the authorized project folders, resolved against the real path, so the assistant can inspect code, create and edit files, and run builds without a card for each ordinary change. Deleting still asks, and app launches, opening files or links, and terminal commands ask once with the exact target. A path outside it is blocked with a clear reason and is never prompted into a wider grant. Switching here from Full access clears saved file permissions."
  },
  {
    id: "full",
    label: "Full access",
    shortLabel: "Full",
    risk: "Broad",
    description:
      "All supported local capabilities without a repeated approval: reads, file creation and edits, renames, moves, copies, deletes, app discovery and launch, opening files and links, and PowerShell or cmd commands with real output and exit codes. Protected system locations always ask, sensitive file names still ask, force-terminating an app always asks, and every action is audited. Full access is not administrator rights: UAC prompts and Windows access controls still apply. Switch back to Ask or Agent at any time."
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
