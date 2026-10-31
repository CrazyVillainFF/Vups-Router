const CHAT_BINDINGS_PREFIX = "vupsrouter.desktop.chat-workspace";
const CHAT_BINDINGS_LIMIT = 200;

export function chatBindingsKey(owner) {
  return `${CHAT_BINDINGS_PREFIX}.${owner || "guest"}.v1`;
}

function isId(value) {
  return typeof value === "string" && value !== "";
}

export function sanitizeChatBindings(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(([key, value]) => isId(key) && isId(value))
  );
}

export function readChatBindings(storage, owner) {
  try {
    const raw = storage?.getItem(chatBindingsKey(owner));
    return sanitizeChatBindings(raw ? JSON.parse(raw) : {});
  } catch {
    return {};
  }
}

// The map only remembers which folder a chat used; the native workspace
// registry still owns the real path and its access rules.
export function writeChatBindings(storage, owner, bindings) {
  try {
    if (!storage) return;
    const entries = Object.entries(sanitizeChatBindings(bindings)).slice(-CHAT_BINDINGS_LIMIT);
    storage.setItem(chatBindingsKey(owner), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage is best-effort */
  }
}

export function chatWorkspaceFor(workspaces, bindings, chatKey) {
  const key = typeof chatKey === "string" ? chatKey.trim() : "";
  if (!key) return null;
  const id = bindings?.[key];
  if (!id) return null;
  return (workspaces || []).find(workspace => workspace.id === id) || null;
}

export function setChatBinding(bindings, chatKey, workspaceId, workspaces) {
  const key = typeof chatKey === "string" ? chatKey.trim() : "";
  const current = bindings && typeof bindings === "object" ? { ...bindings } : {};
  if (!key) return current;
  const valid =
    Array.isArray(workspaces) && workspaces.some(workspace => workspace.id === workspaceId);
  if (valid) current[key] = workspaceId;
  else delete current[key];
  return current;
}

export function withoutWorkspace(bindings, workspaceId) {
  return Object.fromEntries(
    Object.entries(sanitizeChatBindings(bindings)).filter(([, value]) => value !== workspaceId)
  );
}
