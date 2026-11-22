/**
 * The Local Chats folder.
 *
 * Native Windows conversations are stored by the app in its own data
 * directory. This module keeps the device-local folder view (and the legacy
 * account-conversation markers created before native storage existed) so the
 * sidebar and Local AI page can list local chats without asking the cloud
 * conversation list what is local.
 */

import { useSyncExternalStore } from "react";

export const LOCAL_CHATS_STORAGE_KEY = "vupsrouter.localchats.v1";
export const LOCAL_CHATS_MIGRATED_KEY = "vupsrouter.localchats.migrated.v1";

const listeners = new Set();
let cached = null;
let nativeChats = new Map();
let nativeCreatedAt = "";

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeChat(value) {
  const id = String(value?.id || "").trim();
  if (!id) return null;
  return {
    id,
    title: String(value?.title || "").trim().slice(0, 120),
    model: String(value?.model || "").trim(),
    combo: Boolean(value?.combo),
    state: String(value?.state || "").trim(),
    error: String(value?.error || "").trim(),
    messageCount: Number(value?.messageCount) || 0,
    createdAt: String(value?.createdAt || value?.updatedAt || ""),
    updatedAt: String(value?.updatedAt || value?.createdAt || "")
  };
}

function normalizeFolder(raw) {
  const chats = {};
  const source = raw && typeof raw.chats === "object" && !Array.isArray(raw.chats) ? raw.chats : {};
  for (const [key, value] of Object.entries(source)) {
    const chat = normalizeChat({ ...value, id: value?.id || key });
    if (chat) chats[chat.id] = chat;
  }
  return {
    version: 1,
    createdAt: String(raw?.createdAt || ""),
    chats
  };
}

function readLegacyFolder(storage = browserStorage()) {
  try {
    return normalizeFolder(JSON.parse(storage?.getItem(LOCAL_CHATS_STORAGE_KEY) || "null"));
  } catch {
    return normalizeFolder(null);
  }
}

function mergeFolder(legacy) {
  const chats = { ...legacy.chats };
  for (const [id, chat] of nativeChats) chats[id] = chat;
  const createdAt =
    legacy.createdAt ||
    nativeCreatedAt ||
    [...nativeChats.values()].map(chat => chat.createdAt).filter(Boolean).sort()[0] ||
    "";
  return { version: 1, createdAt, chats };
}

function persistLegacy(folder, storage = browserStorage()) {
  try {
    storage?.setItem(LOCAL_CHATS_STORAGE_KEY, JSON.stringify(folder));
  } catch {
    /* The conversation itself is already saved; the folder is best-effort. */
  }
  cached = null;
  listeners.forEach(listener => listener());
  return folder;
}

function notify() {
  cached = null;
  listeners.forEach(listener => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  if (!cached) cached = mergeFolder(readLegacyFolder());
  return cached;
}

export function resetLocalChatsCache() {
  cached = null;
}

/** Replaces the native rows shown in Local Chats. Called after a native list read or write. */
export function syncNativeLocalChats(rows = []) {
  nativeChats = new Map();
  let earliest = "";
  for (const row of Array.isArray(rows) ? rows : []) {
    const chat = normalizeChat(row);
    if (!chat) continue;
    nativeChats.set(chat.id, chat);
    if (chat.createdAt && (!earliest || chat.createdAt < earliest)) earliest = chat.createdAt;
  }
  nativeCreatedAt = earliest;
  notify();
  return snapshot();
}

export function nativeLocalChatIds() {
  return new Set(nativeChats.keys());
}

export function readLocalChats(storage = browserStorage()) {
  return mergeFolder(readLegacyFolder(storage));
}

export function readLegacyLocalChats(storage = browserStorage()) {
  return readLegacyFolder(storage);
}

/** The folder exists from the first local model on; this creates the legacy marker. */
export function ensureLocalChatsFolder(storage = browserStorage()) {
  const folder = readLegacyFolder(storage);
  if (folder.createdAt) return folder;
  const next = { ...folder, createdAt: new Date().toISOString() };
  persistLegacy(next, storage);
  return next;
}

export function markLocalChat({ id, title = "", model = "", combo = false } = {}, storage = browserStorage()) {
  const chatId = String(id || "").trim();
  if (!chatId) return null;
  const folder = readLegacyFolder(storage);
  const now = new Date().toISOString();
  const previous = folder.chats[chatId];
  const chat = {
    id: chatId,
    title: String(title || previous?.title || "").trim().slice(0, 120),
    model: String(model || previous?.model || "").trim(),
    combo: Boolean(combo || previous?.combo),
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };
  const next = {
    ...folder,
    createdAt: folder.createdAt || now,
    chats: { ...folder.chats, [chatId]: chat }
  };
  persistLegacy(next, storage);
  return chat;
}

export function updateLocalChat(id, patch = {}, storage = browserStorage()) {
  const chatId = String(id || "").trim();
  if (!chatId) return null;
  const folder = readLegacyFolder(storage);
  const previous = folder.chats[chatId];
  if (!previous) return null;
  const chat = {
    ...previous,
    ...(patch.title ? { title: String(patch.title).trim().slice(0, 120) } : {}),
    ...(patch.model ? { model: String(patch.model).trim() } : {}),
    ...(typeof patch.combo === "boolean" ? { combo: patch.combo } : {}),
    updatedAt: new Date().toISOString()
  };
  const next = { ...folder, chats: { ...folder.chats, [chatId]: chat } };
  persistLegacy(next, storage);
  return chat;
}

export function unmarkLocalChat(id, storage = browserStorage()) {
  const chatId = String(id || "").trim();
  const folder = readLegacyFolder(storage);
  if (!chatId || !folder.chats[chatId]) return folder;
  const chats = { ...folder.chats };
  delete chats[chatId];
  return persistLegacy({ ...folder, chats }, storage);
}

export function isLocalChat(id, storage = browserStorage()) {
  const chatId = String(id || "").trim();
  if (!chatId) return false;
  return nativeChats.has(chatId) || Boolean(readLegacyFolder(storage).chats[chatId]);
}

export function listLocalChats(storage = browserStorage()) {
  return Object.values(readLocalChats(storage).chats).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
}

/** Server conversations copied into native storage; with the legacy marker gone, the cloud list hides them. */
export function readMigratedLocalChatIds(storage = browserStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_CHATS_MIGRATED_KEY) || "{}");
    return new Set(
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : []
    );
  } catch {
    return new Set();
  }
}

export function markLocalChatMigrated(id, storage = browserStorage()) {
  const chatId = String(id || "").trim();
  if (!chatId) return;
  const current = storage?.getItem(LOCAL_CHATS_MIGRATED_KEY);
  let parsed = {};
  try {
    const value = JSON.parse(current || "{}");
    parsed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    parsed = {};
  }
  parsed[chatId] = Date.now();
  const kept = Object.entries(parsed)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 300);
  try {
    storage?.setItem(LOCAL_CHATS_MIGRATED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* Without the marker the old cloud row stays visible; nothing is lost. */
  }
}

export function useLocalChatsFolder() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
