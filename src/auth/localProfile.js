/**
 * The minimum identity needed to open this device's local data without the
 * server. A profile is a name and an id — never a password, session cookie,
 * access token or provider key. An account profile is written only after the
 * backend has just confirmed that account; a local profile is a separate,
 * clearly labelled identity for a device with no account.
 */

export const ACCOUNT_PROFILE_KEY = "vupsrouter.profile.account.v1";
export const LOCAL_PROFILE_KEY = "vupsrouter.profile.local.v1";
export const ACCOUNT_PROFILE_KIND = "account";
export const LOCAL_PROFILE_KIND = "local";
export const LOCAL_PROFILE_NAME = "Offline local profile";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

export function resolveProfileStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // A private profile can deny storage; the session still gets an identity.
  }
  return memoryStorage();
}

function cleanString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeProfile(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanString(value.id, 128);
  if (!id) return null;
  const kind = value.kind === LOCAL_PROFILE_KIND ? LOCAL_PROFILE_KIND : ACCOUNT_PROFILE_KIND;
  const name = cleanString(value.name, 80) || (kind === LOCAL_PROFILE_KIND ? LOCAL_PROFILE_NAME : "VupsRouter account");
  const email = kind === ACCOUNT_PROFILE_KIND ? cleanString(value.email, 254).toLowerCase() : "";
  const savedAt = cleanString(value.savedAt, 40);
  return Object.freeze({ id, kind, name, email, savedAt });
}

export function profileToUser(profile) {
  const normalized = normalizeProfile(profile);
  if (!normalized) return null;
  return {
    id: normalized.id,
    name: normalized.name,
    email: normalized.email || undefined,
    local: normalized.kind === LOCAL_PROFILE_KIND
  };
}

function read(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return normalizeProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Access without persistence is still better than blocking the device.
  }
}

function newLocalId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local-${crypto.randomUUID()}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createProfileStore(storage, { now = () => new Date().toISOString(), createId = newLocalId } = {}) {
  const store = resolveProfileStorage(storage);

  return {
    readAccountProfile() {
      const profile = read(store, ACCOUNT_PROFILE_KEY);
      return profile?.kind === ACCOUNT_PROFILE_KIND ? profile : null;
    },

    saveAccountProfile(user) {
      const profile = normalizeProfile({
        id: user?.id,
        kind: ACCOUNT_PROFILE_KIND,
        name: user?.name,
        email: user?.email,
        savedAt: now()
      });
      if (!profile) return null;
      write(store, ACCOUNT_PROFILE_KEY, profile);
      return profile;
    },

    clearAccountProfile() {
      try {
        store.removeItem(ACCOUNT_PROFILE_KEY);
      } catch {
        // Nothing to clear if storage refused the write in the first place.
      }
    },

    readLocalProfile() {
      const profile = read(store, LOCAL_PROFILE_KEY);
      return profile?.kind === LOCAL_PROFILE_KIND ? profile : null;
    },

    ensureLocalProfile() {
      const existing = read(store, LOCAL_PROFILE_KEY);
      if (existing?.kind === LOCAL_PROFILE_KIND) return existing;
      const profile = normalizeProfile({
        id: createId(),
        kind: LOCAL_PROFILE_KIND,
        name: LOCAL_PROFILE_NAME,
        savedAt: now()
      });
      if (profile) write(store, LOCAL_PROFILE_KEY, profile);
      return profile;
    }
  };
}

const defaultStore = createProfileStore();

export function readAccountProfile() {
  return defaultStore.readAccountProfile();
}

export function saveAccountProfile(user) {
  return defaultStore.saveAccountProfile(user);
}

export function clearAccountProfile() {
  defaultStore.clearAccountProfile();
}

export function readLocalProfile() {
  return defaultStore.readLocalProfile();
}

export function ensureLocalProfile() {
  return defaultStore.ensureLocalProfile();
}
