/**
 * Native Local Chats.
 *
 * The conversations themselves live in `Documents\VupsRouter\Local Chats`,
 * reached through Tauri commands. This module is only the client adapter; it
 * never writes chat content to the download manager's folders or to the cloud
 * conversation database.
 */

import { invoke } from "@tauri-apps/api/core";

import { NATIVE_SHELLS, detectNativeShell, isTauriRuntime } from "../native/shell.js";
import { isAndroidApp } from "../native/appInfo.js";

export const LOCAL_CHAT_ID_PREFIX = "lcn_";

export function nativeLocalChatsAvailable() {
  return (isTauriRuntime() && detectNativeShell() === NATIVE_SHELLS.windows) || isAndroidApp();
}

function androidStoragePlugin() {
  return isAndroidApp() ? window.Capacitor?.Plugins?.VupsStorage || null : null;
}

async function androidReadStore() {
  const plugin = androidStoragePlugin();
  if (!plugin?.read) throw new Error("Android Local Chat storage is unavailable.");
  const result = await plugin.read({ path: "LocalChats/local-chats-v1.json" });
  if (!result?.exists) return { version: 1, owners: {} };
  try {
    const parsed = JSON.parse(String(result.text || "{}"));
    return parsed && typeof parsed === "object" ? parsed : { version: 1, owners: {} };
  } catch { throw new Error("The Android Local Chat store is damaged and could not be read."); }
}

async function androidWriteStore(store) {
  const plugin = androidStoragePlugin();
  if (!plugin?.write) throw new Error("Android Local Chat storage is unavailable.");
  await plugin.write({ path: "LocalChats/local-chats-v1.json", text: JSON.stringify(store) });
}

async function androidCommand(command, payload = {}) {
  const store = await androidReadStore();
  store.version = 1;
  store.owners = store.owners && typeof store.owners === "object" ? store.owners : {};
  const owner = String(payload.owner || "");
  const chats = Array.isArray(store.owners[owner]) ? store.owners[owner] : [];
  const chatId = String(payload.chatId || payload.chat?.id || "");
  const index = chats.findIndex(chat => chat.id === chatId);
  if (command === "local_chats_list") return chats.map(chat => ({ ...chat, messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0 }));
  if (command === "local_chats_get") return index >= 0 ? chats[index] : null;
  if (command === "local_chats_storage_info") {
    const info = await androidStoragePlugin().initialize();
    return { path: `${info.root}/LocalChats/local-chats-v1.json`, chatCount: chats.length, messageCount: chats.reduce((count, chat) => count + (chat.messages?.length || 0), 0) };
  }
  if (command === "local_chats_create") {
    if (index < 0) chats.unshift({ ...payload.chat, messages: [], state: "running", error: "", updatedAt: payload.chat.createdAt || new Date().toISOString() });
  } else if (command === "local_chats_append_message") {
    if (index < 0) throw new Error("That Local Chat does not exist.");
    const chat = chats[index];
    const message = payload.message || {};
    const messageIndex = (chat.messages || []).findIndex(row => row.id === message.id);
    if (messageIndex < 0) chat.messages = [...(chat.messages || []), message];
    else chat.messages[messageIndex] = { ...chat.messages[messageIndex], ...message };
    chat.state = message.status === "complete" ? "completed" : (message.status || chat.state);
    chat.updatedAt = message.createdAt || new Date().toISOString();
  } else if (command === "local_chats_update") {
    if (index < 0) throw new Error("That Local Chat does not exist.");
    chats[index] = { ...chats[index], ...(payload.patch || {}), updatedAt: new Date().toISOString() };
  } else if (command === "local_chats_delete") {
    if (index >= 0) chats.splice(index, 1);
  } else if (command === "local_chats_import") {
    if (index < 0) chats.unshift(payload.chat);
  }
  store.owners[owner] = chats;
  await androidWriteStore(store);
  return index >= 0 ? chats[index] : payload.chat || null;
}

function nativeCommand(command, payload) {
  return isAndroidApp() ? androidCommand(command, payload) : invoke(command, payload);
}

function randomId() {
  try {
    return globalThis.crypto?.randomUUID?.().replace(/-/g, "") || "";
  } catch {
    return "";
  }
}

/** A new native conversation id. The prefix keeps it apart from cloud ids. */
export function newLocalChatId() {
  const random = randomId();
  return `${LOCAL_CHAT_ID_PREFIX}${random || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
}

/**
 * The id used for the first message's conversation. It is derived from the
 * message id so a retry after a failed handoff lands in the same local chat
 * instead of creating a second one.
 */
export function nativeChatIdForMessage(messageId) {
  const cleaned = String(messageId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 72);
  return cleaned.length >= 6 ? `${LOCAL_CHAT_ID_PREFIX}${cleaned}` : newLocalChatId();
}

export function isNativeLocalChatId(id) {
  return String(id || "").trim().startsWith(LOCAL_CHAT_ID_PREFIX);
}

function requireAvailable() {
  if (!nativeLocalChatsAvailable()) {
    throw new Error("Local Chats are only available in the Windows or Android app.");
  }
}

function requireOwner(owner) {
  const value = String(owner || "").trim();
  if (!value) throw new Error("Sign in before using Local Chats.");
  return value;
}

export async function listNativeLocalChats(owner) {
  if (!nativeLocalChatsAvailable()) return [];
  const who = requireOwner(owner);
  const rows = await nativeCommand("local_chats_list", { owner: who });
  return Array.isArray(rows) ? rows : [];
}

export async function getNativeLocalChat(owner, chatId) {
  requireAvailable();
  const who = requireOwner(owner);
  return (await nativeCommand("local_chats_get", { owner: who, chatId })) || null;
}

export async function createNativeLocalChat(owner, { id, title = "", model = "", combo = false, createdAt = "" } = {}) {
  requireAvailable();
  const who = requireOwner(owner);
  if (!id) throw new Error("A local chat needs an id.");
  return nativeCommand("local_chats_create", {
    owner: who,
    chat: { id, title, model, combo, createdAt }
  });
}

export async function appendNativeLocalChatMessage(
  owner,
  chatId,
  { id, role, content = "", status = "complete", plan = null, createdAt = "", final = false } = {}
) {
  requireAvailable();
  const who = requireOwner(owner);
  if (!id) throw new Error("A message needs a stable id.");
  return nativeCommand("local_chats_append_message", {
    owner: who,
    chatId,
    message: { id, role, content, status, plan: plan || null, createdAt, final: Boolean(final) }
  });
}

export async function updateNativeLocalChat(owner, chatId, patch = {}) {
  requireAvailable();
  const who = requireOwner(owner);
  return nativeCommand("local_chats_update", { owner: who, chatId, patch });
}

export async function deleteNativeLocalChat(owner, chatId) {
  requireAvailable();
  const who = requireOwner(owner);
  return nativeCommand("local_chats_delete", { owner: who, chatId });
}

export async function importNativeLocalChat(owner, chat) {
  requireAvailable();
  const who = requireOwner(owner);
  return nativeCommand("local_chats_import", { owner: who, chat });
}

export async function nativeLocalChatStorageInfo(owner) {
  if (!nativeLocalChatsAvailable()) return null;
  return nativeCommand("local_chats_storage_info", { owner: requireOwner(owner) });
}

/**
 * The two functions `saveChatMessageFirst` needs. A local conversation is
 * created before its first message is appended, and the message id makes both
 * steps safe to retry.
 */
export function nativeConversationApi(owner) {
  const who = requireOwner(owner);
  return {
    async createConversation({ handoff, title = "", messageId }) {
      const id = nativeChatIdForMessage(messageId);
      await createNativeLocalChat(who, {
        id,
        title: title || String(handoff || "").replace(/\s+/g, " ").trim().slice(0, 60),
        createdAt: new Date().toISOString()
      });
      await appendNativeLocalChatMessage(who, id, {
        id: messageId,
        role: "user",
        content: handoff,
        status: "complete",
        createdAt: new Date().toISOString()
      });
      return { id };
    },
    appendConversationMessage(chatId, { role, content, messageId }) {
      return appendNativeLocalChatMessage(who, chatId, {
        id: messageId,
        role,
        content,
        status: "complete",
        createdAt: new Date().toISOString()
      });
    }
  };
}
