export const WINDOWS_PERMISSION_STORAGE_PREFIX = "vupsrouter.windows.permission-mode";
// The mode picker in older builds stored one device-wide value. It is removed on
// first read rather than handed to whichever account signs in next.
export const LEGACY_WINDOWS_PERMISSION_STORAGE_KEY = "vupsrouter.windows.permission-mode";
export const DEFAULT_PERMISSION_MODE = "ask";

export const WINDOWS_PERMISSION_MODES = Object.freeze([
  {
    id: "ask",
    label: "Ask for approval",
    shortLabel: "Ask",
    risk: "Review",
    description: "Request my permission before protected file operations."
  },
  {
    id: "workspace",
    label: "Approve for me",
    shortLabel: "Approve",
    risk: "Scoped",
    description: "Automatically approve eligible operations within your authorized workspace."
  },
  {
    id: "full",
    label: "Full access",
    shortLabel: "Full",
    risk: "Broad",
    description: "Allow file operations within your configured workspace without repeated approval."
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
 * All three choices persist per account. The native engine still revalidates
 * the selected policy on every launch; Full access remains workspace-scoped,
 * audited, and subject to its protected-location and destructive-operation
 * safeguards. The legacy device-wide value is consumed once and then removed,
 * so a second account on this device cannot pick it up.
 */
export function readPermissionMode(storage, owner) {
  if (!storage) return { mode: DEFAULT_PERMISSION_MODE, dropped: "" };
  const stored = readStoredMode(storage, permissionModeStorageKey(owner));
  if (isPermissionMode(stored)) {
    return { mode: stored, dropped: "" };
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
      dropped: ""
    };
  }
  return { mode: DEFAULT_PERMISSION_MODE, dropped: "" };
}

export function loadPermissionMode(storage, owner) {
  return readPermissionMode(storage, owner).mode;
}

/**
 * Records the account's selected mode. Native policy installation still
 * validates the owner and workspace on every launch before local tools run.
 */
export function savePermissionMode(storage, owner, mode) {
  if (!isPermissionMode(mode)) return DEFAULT_PERMISSION_MODE;
  if (storage) {
    writeStoredMode(
      storage,
      permissionModeStorageKey(owner),
      mode
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
