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

export const LOCAL_CHAT_ID_PREFIX = "lcn_";

export function nativeLocalChatsAvailable() {
  return isTauriRuntime() && detectNativeShell() === NATIVE_SHELLS.windows;
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
    throw new Error("Local Chats are only available in the Windows app.");
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
  const rows = await invoke("local_chats_list", { owner: who });
  return Array.isArray(rows) ? rows : [];
}

export async function getNativeLocalChat(owner, chatId) {
  requireAvailable();
  const who = requireOwner(owner);
  return (await invoke("local_chats_get", { owner: who, chatId })) || null;
}

export async function createNativeLocalChat(owner, { id, title = "", model = "", combo = false, createdAt = "" } = {}) {
  requireAvailable();
  const who = requireOwner(owner);
  if (!id) throw new Error("A local chat needs an id.");
  return invoke("local_chats_create", {
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
  return invoke("local_chats_append_message", {
    owner: who,
    chatId,
    message: { id, role, content, status, plan: plan || null, createdAt, final: Boolean(final) }
  });
}

export async function updateNativeLocalChat(owner, chatId, patch = {}) {
  requireAvailable();
  const who = requireOwner(owner);
  return invoke("local_chats_update", { owner: who, chatId, patch });
}

export async function deleteNativeLocalChat(owner, chatId) {
  requireAvailable();
  const who = requireOwner(owner);
  return invoke("local_chats_delete", { owner: who, chatId });
}

export async function importNativeLocalChat(owner, chat) {
  requireAvailable();
  const who = requireOwner(owner);
  return invoke("local_chats_import", { owner: who, chat });
}

export async function nativeLocalChatStorageInfo(owner) {
  if (!nativeLocalChatsAvailable()) return null;
  return invoke("local_chats_storage_info", { owner: requireOwner(owner) });
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
