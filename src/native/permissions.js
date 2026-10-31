export const WINDOWS_PERMISSION_STORAGE_KEY = "vupsrouter.windows.permission-mode";
export const DEFAULT_PERMISSION_MODE = "ask";

export const WINDOWS_PERMISSION_MODES = Object.freeze([
  {
    id: "ask",
    label: "Ask me every time",
    shortLabel: "Ask",
    risk: "Review",
    description:
      "Every protected local operation waits for an in-chat card naming the action, target and risk; switching here from a broader mode clears saved grants first. \"Allow Once\" covers that one call, and \"Allow Always (Only for This Chat)\" answers repeats for that target in the same chat only, held in memory until the chat or app ends. Deletes, shell commands, process control and links always ask; exact-file grants stay revocable in Settings."
  },
  {
    id: "workspace",
    label: "Agent (workspace)",
    shortLabel: "Workspace",
    risk: "Scoped",
    description:
      "File reads and edits stay inside the authorized project folders, resolved against the real path. Deleting, app launches, opening files or links, and terminal commands ask once with the exact target; a path outside it is blocked with a clear reason and is never prompted into a wider grant, and switching here from Full access clears saved file permissions."
  },
  {
    id: "full",
    label: "Full access",
    shortLabel: "Full",
    risk: "Broad",
    description:
      "All supported local capabilities run without a repeated approval: file edits, deletes, app launches, links, and PowerShell or cmd commands with real output; switch back to Ask or Agent at any time. Protected system locations always ask, force-terminating an app always asks, every action is audited, and Full access never grants administrator rights or bypasses Windows access controls."
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

// Composer picks are user-initiated: the OS picker already showed exactly what
// was selected, so they are never passed through the assistant's approval
// engine. That engine still gates every tool call the model makes on its own.
