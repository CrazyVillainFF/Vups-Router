import { releaseDesktopToolPolicy } from "../native/desktopTools.js";
import { LEGACY_WINDOWS_PERMISSION_STORAGE_KEY } from "../native/permissions.js";

// Two kinds of per-account state live on this device, and signing out ends only
// one of them.
//
// Durable settings belong to the account and survive a sign-out: the native
// workspace registry and the project files in it, the folder this account last
// chose, the folder each of its chats is bound to, the Ask/Agent mode it saved,
// and any exact-file permission it granted (all revocable in Settings). Reading
// those again is what makes a restart and a re-sign-in land where the user left
// off, and every one of them is namespaced to its owner id.
//
// Session authorization ends with the sign-in: the live permission policy in
// the Windows app, the approval cards on screen, the in-memory chat-scoped
// answers, and the client map that names those scopes. The map is the only
// client key removed here, and losing it can only cause a re-ask.
const CHAT_SCOPE_STORAGE_PREFIX = "vupsrouter.desktop.chat-scope.v1";

export function chatScopeStorageKey(owner) {
  return `${CHAT_SCOPE_STORAGE_PREFIX}.${owner || "guest"}`;
}

export function accountSessionStorageKeys(owner) {
  return [chatScopeStorageKey(owner), LEGACY_WINDOWS_PERMISSION_STORAGE_KEY];
}

// Removes one account's session keys and nothing else. Another owner's
// namespaced keys, and every durable store, are left exactly where they are.
export function clearAccountSessionKeys(storage, owner) {
  if (!storage || !owner) return [];
  const removed = [];
  for (const key of accountSessionStorageKeys(owner)) {
    try {
      if (storage.getItem(key) !== null) removed.push(key);
      storage.removeItem(key);
    } catch {
      /* one unreadable key never blocks the rest of the cleanup */
    }
  }
  return removed;
}

/**
 * Ends an account's local-tool authorization.
 *
 * It runs before the sign-out request so the app is closed on the filesystem
 * first and only then asks the server to forget the session; a failed request
 * leaves local access revoked rather than half-ended. `desktop` is false on the
 * web, where no native engine exists to release.
 */
export async function endAccountSession({
  owner,
  storage = typeof window === "undefined" ? null : window.localStorage,
  desktop = false,
  releasePolicy = releaseDesktopToolPolicy
} = {}) {
  if (!owner) return { owner: "", removedKeys: [], toolAccessEnded: false, error: "" };
  const removedKeys = clearAccountSessionKeys(storage, owner);
  if (!desktop) {
    return { owner, removedKeys, toolAccessEnded: false, error: "" };
  }
  try {
    await releasePolicy(owner);
    return { owner, removedKeys, toolAccessEnded: true, error: "" };
  } catch (releaseError) {
    return {
      owner,
      removedKeys,
      toolAccessEnded: false,
      error: releaseError?.message || String(releaseError || "Local file access could not be ended.")
    };
  }
}
