export const WINDOWS_PERMISSION_STORAGE_PREFIX = "vupsrouter.windows.permission-mode";
// The mode picker in older builds stored one device-wide value. It is removed on
// first read rather than handed to whichever account signs in next.
export const LEGACY_WINDOWS_PERMISSION_STORAGE_KEY = "vupsrouter.windows.permission-mode";
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
      "All supported local capabilities run without a repeated approval: file edits, deletes, app launches, links, and PowerShell or cmd commands with real output; switch back to Ask or Agent at any time. Protected system locations always ask, force-terminating an app always asks, every action is audited, and Full access never grants administrator rights or bypasses Windows access controls. It is authorized for this app session only: after a restart, or on another account, local access returns to Ask and the warning confirmation must be given again."
  }
]);

const MODE_IDS = new Set(WINDOWS_PERMISSION_MODES.map(mode => mode.id));

export function isPermissionMode(value) {
  return MODE_IDS.has(value);
}

export function permissionModeStorageKey(owner) {
  return `${WINDOWS_PERMISSION_STORAGE_PREFIX}.${owner || "guest"}.v1`;
}

function readStoredMode(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredMode(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* storage is best-effort */
  }
}

/**
 * The mode this account chose on this device, plus the value it was refused.
 *
 * `Ask me every time` and `Agent (workspace)` are settings, so they persist per
 * account. `Full access` is an authorization the user gave against a warning,
 * and nothing in this app stores a full-access consent, so a saved or inherited
 * `full` is never adopted: the account starts at Ask and `dropped` reports what
 * was refused, which is what lets the page say so out loud. The legacy
 * device-wide value is consumed once and then removed, so a second account on
 * this device cannot pick it up.
 */
export function readPermissionMode(storage, owner) {
  if (!storage) return { mode: DEFAULT_PERMISSION_MODE, dropped: "" };
  const stored = readStoredMode(storage, permissionModeStorageKey(owner));
  if (isPermissionMode(stored)) {
    return stored === "full"
      ? { mode: DEFAULT_PERMISSION_MODE, dropped: "full" }
      : { mode: stored, dropped: "" };
  }
  const legacy = readStoredMode(storage, LEGACY_WINDOWS_PERMISSION_STORAGE_KEY);
  if (legacy !== null) {
    writeStoredMode(storage, LEGACY_WINDOWS_PERMISSION_STORAGE_KEY, null);
    if (isPermissionMode(legacy) && legacy !== "full") {
      writeStoredMode(storage, permissionModeStorageKey(owner), legacy);
      return { mode: legacy, dropped: "" };
    }
    return {
      mode: DEFAULT_PERMISSION_MODE,
      dropped: legacy === "full" ? "full" : ""
    };
  }
  return { mode: DEFAULT_PERMISSION_MODE, dropped: "" };
}

export function loadPermissionMode(storage, owner) {
  return readPermissionMode(storage, owner).mode;
}

/**
 * Records the durable half of the choice. Full access answers for this session
 * only, so it is written out of the account's storage rather than saved: the
 * next launch has to meet the warning again.
 */
export function savePermissionMode(storage, owner, mode) {
  if (!isPermissionMode(mode)) return DEFAULT_PERMISSION_MODE;
  if (storage) {
    writeStoredMode(
      storage,
      permissionModeStorageKey(owner),
      mode === "full" ? null : mode
    );
  }
  return mode;
}

export function permissionModeInfo(mode) {
  return WINDOWS_PERMISSION_MODES.find(item => item.id === mode) || WINDOWS_PERMISSION_MODES[0];
}

// Composer picks are user-initiated: the OS picker already showed exactly what
// was selected, so they are never passed through the assistant's approval
// engine. That engine still gates every tool call the model makes on its own.
