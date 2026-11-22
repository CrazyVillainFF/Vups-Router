import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteConversation,
  fetchUsage,
  getConversation,
  listConversations,
  renameConversation
} from "../services/api.js";
import { getTaskTrackerSnapshot, subscribeToTaskTracker } from "../tasks/taskTracker.js";
import { useWorkspaces } from "./WorkspaceContext.jsx";
import {
  LOCAL_CHAT_ID_PREFIX,
  deleteNativeLocalChat,
  importNativeLocalChat,
  isNativeLocalChatId,
  listNativeLocalChats,
  nativeLocalChatsAvailable,
  updateNativeLocalChat
} from "../localai/localChatStore.js";
import {
  markLocalChatMigrated,
  readLegacyLocalChats,
  readMigratedLocalChatIds,
  syncNativeLocalChats,
  unmarkLocalChat
} from "../localai/localChats.js";
import { readLocalRoutingMap } from "../localai/localRoutingLog.js";
import { isLocalRunActive } from "../localai/localRunStore.js";
import { isCloudOnline, useConnectivity } from "../connectivity/connectivity.js";

const TaskContext = createContext(null);

function legacyNativeChatId(serverId) {
  const cleaned = String(serverId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 72);
  return cleaned ? `${LOCAL_CHAT_ID_PREFIX}legacy_${cleaned}` : "";
}

function migratedMessages(conversation, routingMap) {
  const at = String(conversation.updatedAt || conversation.createdAt || new Date().toISOString());
  return (Array.isArray(conversation.messages) ? conversation.messages : [])
    .map((message, index) => {
      const messageId = String(message.messageId || message.id || `legacy-${index}`);
      return {
        id: messageId,
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || ""),
        status: message.status === "failed" ? "failed" : "complete",
        plan: message.messageId ? routingMap.get(String(message.messageId)) || null : null,
        createdAt: String(message.createdAt || at),
        updatedAt: String(message.updatedAt || at)
      };
    })
    .filter(message => message.content || message.plan);
}

export function TaskProvider({ children }) {
  const { owner: workspaceOwner } = useWorkspaces();
  const { online } = useConnectivity();
  const [conversations, setConversations] = useState([]);
  const [localChats, setLocalChats] = useState([]);
  const [usage, setUsage] = useState(null);
  const [taskError, setTaskError] = useState("");
  const [usageError, setUsageError] = useState("");
  const [usageUnsupported, setUsageUnsupported] = useState(false);
  const usageUnsupportedRef = useRef(false);
  const [draftRequest, setDraftRequest] = useState(null);
  const localChatsRef = useRef(new Map());
  const knownConversations = useRef(new Set());
  const listRefreshInFlight = useRef(false);
  const legacyMigrationOwner = useRef("");
  const refreshConversationsRef = useRef(null);
  // Two list requests can be in flight at once, and the one that was asked for
  // first is not the one that answers first. A list read before the server
  // saved a conversation would drop that conversation from the sidebar if it
  // were applied after a newer list, so a superseded answer is discarded
  // instead of overwriting the newer one.
  const listRequestSeq = useRef(0);
  const appliedListSeq = useRef(0);

  const refreshConversations = useCallback(async () => {
    const seq = ++listRequestSeq.current;
    let nativeError = "";
    let nativeRows = null;
    if (nativeLocalChatsAvailable() && workspaceOwner) {
      try {
        nativeRows = await listNativeLocalChats(workspaceOwner);
        syncNativeLocalChats(nativeRows);
      } catch (error) {
        nativeError = error.message || "Could not load Local Chats from this device.";
        nativeRows = [];
        syncNativeLocalChats([]);
      }
    }
    if (!isCloudOnline()) {
      // The cloud list that is already on screen stays; going offline must not
      // erase history the reader can still open. Device-local rows are the one
      // thing this call is allowed to add without the server.
      if (nativeRows) {
        setConversations(current => {
          const merged = new Map(current.map(row => [String(row.id), row]));
          for (const row of nativeRows) merged.set(String(row.id), { ...row, local: true });
          return [...merged.values()].sort((left, right) =>
            String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
          );
        });
      }
      setTaskError(nativeError);
      return nativeRows;
    }
    try {
      const list = await listConversations();
      if (seq < appliedListSeq.current) return null;
      appliedListSeq.current = seq;
      // Local chats that were copied out of the cloud database are no longer
      // listed there. Their server records are left untouched.
      const migrated = readMigratedLocalChatIds();
      const cloud = list.filter(item => {
        const id = String(item?.id || "");
        return !migrated.has(id) && !isNativeLocalChatId(id);
      });
      if (nativeRows) {
        const byId = new Map();
        for (const row of cloud) byId.set(String(row.id), row);
        for (const row of nativeRows) {
          byId.set(String(row.id), { ...row, local: true });
        }
        setConversations(
          [...byId.values()].sort((left, right) =>
            String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
          )
        );
      } else {
        setConversations(cloud);
      }
      setTaskError(nativeError);
      return list;
    } catch (error) {
      setTaskError(error.message || "Could not load task history.");
      // Device-local chats do not depend on the cloud list. A server that is
      // unreachable must not hide the conversations this app already holds.
      if (nativeRows) {
        setConversations(
          nativeRows
            .map(row => ({ ...row, local: true }))
            .sort((left, right) =>
              String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
            )
        );
        return nativeRows;
      }
      throw error;
    }
  }, [workspaceOwner]);

  refreshConversationsRef.current = refreshConversations;

  /**
   * A conversation the server has already confirmed.
   *
   * It belongs in the list the moment it is named, not after the next list
   * request: the reader must be able to open it even when the screen that
   * sent the message has already moved on to another chat.
   */
  const upsertConversation = useCallback(conversation => {
    if (!conversation?.id) return null;
    const id = String(conversation.id);
    const row = {
      ...conversation,
      id,
      ...(isNativeLocalChatId(id) ? { local: true, updatedAt: conversation.updatedAt || new Date().toISOString() } : {})
    };
    setConversations(current => {
      const index = current.findIndex(item => String(item.id) === row.id);
      if (index < 0) return [row, ...current];
      const next = current.slice();
      // The server names a conversation. A title this screen guessed for a chat
      // that already has one must not overwrite the name the server holds.
      next[index] = { ...next[index], ...row, title: next[index].title || row.title };
      return next;
    });
    return row;
  }, []);

  const refreshUsage = useCallback(async () => {
    if (usageUnsupportedRef.current) return null;
    if (!isCloudOnline()) return null;
    try {
      const next = await fetchUsage();
      setUsage(next);
      setUsageError("");
      return next;
    } catch (error) {
      if (error?.response?.status === 404) {
        // A server with no usage endpoint at all. Retrying every minute or after
        // every turn cannot fix that, so stop asking and say so plainly instead
        // of leaving a permanent "unavailable" error on screen.
        usageUnsupportedRef.current = true;
        setUsageUnsupported(true);
        setUsageError("This server does not report daily usage.");
        return null;
      }
      setUsageError(error.message || "Could not load usage.");
      return null;
    }
  }, []);

  useEffect(() => {
    refreshConversations().catch(() => {});
    refreshUsage();
  }, [refreshConversations, refreshUsage, online]);

  useEffect(() => {
    knownConversations.current = new Set(conversations.map(task => String(task.id)));
  }, [conversations]);

  // Local chats created before native storage existed were ordinary account
  // conversations plus a device marker. Copy each one into the native store
  // once, then stop showing the cloud row here. The server copy is never
  // deleted, so signing in elsewhere still shows the history it always had.
  useEffect(() => {
    if (!workspaceOwner || !nativeLocalChatsAvailable()) return undefined;
    if (!isCloudOnline()) return undefined;
    if (legacyMigrationOwner.current === workspaceOwner) return undefined;
    legacyMigrationOwner.current = workspaceOwner;
    let cancelled = false;
    (async () => {
      const folder = readLegacyLocalChats();
      const migrated = readMigratedLocalChatIds();
      const markers = Object.values(folder.chats || {})
        .filter(chat => {
          const id = String(chat?.id || "");
          return id && !id.startsWith("local-") && !isNativeLocalChatId(id) && !migrated.has(id);
        })
        .slice(0, 20);
      if (markers.length === 0) return;
      let changed = false;
      for (const marker of markers) {
        if (cancelled) return;
        try {
          const conversation = await getConversation(marker.id);
          if (!conversation) continue;
          const chatId = legacyNativeChatId(marker.id);
          if (!chatId) continue;
          const routingMap = readLocalRoutingMap(workspaceOwner);
          const at = String(conversation.updatedAt || conversation.createdAt || new Date().toISOString());
          await importNativeLocalChat(workspaceOwner, {
            id: chatId,
            title: conversation.title || marker.title || "Local chat",
            model: marker.model || "",
            combo: Boolean(marker.combo),
            state: "completed",
            error: "",
            createdAt: String(conversation.createdAt || marker.createdAt || at),
            updatedAt: at,
            messages: migratedMessages(conversation, routingMap),
            plan: null
          });
          markLocalChatMigrated(marker.id);
          unmarkLocalChat(marker.id);
          changed = true;
        } catch {
          // Leave the marker in place: the server conversation stays visible
          // until a later launch can copy it safely.
        }
      }
      if (changed && !cancelled) {
        await refreshConversationsRef.current?.().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceOwner, online]);

  // A local run's loop lives in this document, not in the record on disk. A
  // chat this document started still has its run in memory; a chat left marked
  // running by a process that is gone does not. Repairing that once at start
  // keeps the sidebar from showing a dead run as thinking until it is opened.
  const staleRunsChecked = useRef(false);
  useEffect(() => {
    if (!workspaceOwner || !nativeLocalChatsAvailable()) return undefined;
    if (staleRunsChecked.current) return undefined;
    staleRunsChecked.current = true;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listNativeLocalChats(workspaceOwner);
        const stale = rows.filter(row => row.state === "running" && !isLocalRunActive(row.id));
        for (const row of stale) {
          if (cancelled) return;
          await updateNativeLocalChat(workspaceOwner, row.id, {
            state: "interrupted",
            error: "The app closed before this local run finished.",
            updatedAt: new Date().toISOString()
          }).catch(() => {});
        }
        if (stale.length > 0 && !cancelled) {
          syncNativeLocalChats(await listNativeLocalChats(workspaceOwner).catch(() => []));
          refreshConversationsRef.current?.().catch(() => {});
        }
      } catch {
        // The chat still repairs itself when it is opened.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceOwner]);

  // This provider mounts outside TaskTrackerProvider, so the tracker module is
  // the only submit signal that reaches it without remounting the whole shell.
  useEffect(
    () =>
      subscribeToTaskTracker(() => {
        if (listRefreshInFlight.current) return;
        const unseen = getTaskTrackerSnapshot().tasks.some(
          task => task?.conversationId && !knownConversations.current.has(String(task.conversationId))
        );
        if (!unseen) return;
        listRefreshInFlight.current = true;
        refreshConversations()
          .catch(() => {})
          .finally(() => {
            listRefreshInFlight.current = false;
          });
      }),
    [refreshConversations]
  );

  useEffect(() => {
    if (!online) return undefined;
    const timer = window.setInterval(() => {
      refreshUsage();
      // The list carries each chat's persisted task state, so a task started on
      // another device has to arrive here without this client doing anything.
      refreshConversations().catch(() => {});
    }, 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshUsage();
        refreshConversations().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshUsage, refreshConversations, online]);

  const saveLocalChat = useCallback((entry, messages) => {
    if (!entry?.id) return;
    localChatsRef.current.set(entry.id, { entry, messages: Array.isArray(messages) ? messages : [] });
    setLocalChats(current => [entry, ...current.filter(chat => chat.id !== entry.id)]);
  }, []);

  const getLocalChat = useCallback(id => localChatsRef.current.get(id) || null, []);

  const renameTask = useCallback(
    async (id, title) => {
      if (String(id).startsWith("local-")) {
        const existing = localChatsRef.current.get(id);
        if (!existing) throw new Error("This local task is no longer available.");
        const entry = { ...existing.entry, title, updatedAt: new Date().toISOString() };
        localChatsRef.current.set(id, { ...existing, entry });
        setLocalChats(current => current.map(chat => (chat.id === id ? entry : chat)));
        return entry;
      }
      if (isNativeLocalChatId(id)) {
        if (!workspaceOwner) throw new Error("Sign in before renaming Local Chats.");
        await updateNativeLocalChat(workspaceOwner, id, {
          title,
          updatedAt: new Date().toISOString()
        });
        setConversations(current =>
          current.map(task =>
            task.id === id ? { ...task, title, updatedAt: new Date().toISOString() } : task
          )
        );
        syncNativeLocalChats(
          await listNativeLocalChats(workspaceOwner).catch(() => [])
        );
        return { id, title };
      }
      const updated = await renameConversation(id, title);
      setConversations(current => current.map(task => (task.id === id ? { ...task, ...updated } : task)));
      return updated;
    },
    [workspaceOwner]
  );

  const removeTask = useCallback(async id => {
    if (String(id).startsWith("local-")) {
      localChatsRef.current.delete(id);
      setLocalChats(current => current.filter(chat => chat.id !== id));
      return;
    }
    if (isNativeLocalChatId(id)) {
      if (!workspaceOwner) throw new Error("Sign in before deleting Local Chats.");
      await deleteNativeLocalChat(workspaceOwner, id);
      setConversations(current => current.filter(task => task.id !== id));
      syncNativeLocalChats(await listNativeLocalChats(workspaceOwner).catch(() => []));
      return;
    }
    await deleteConversation(id);
    setConversations(current => current.filter(task => task.id !== id));
  }, [workspaceOwner]);

  const requestDraft = useCallback(text => {
    const value = String(text || "");
    if (!value.trim()) return;
    setDraftRequest({ text: value, key: Date.now() });
  }, []);

  const tasks = useMemo(() => {
    const known = new Set(conversations.map(task => task.id));
    const local = localChats.filter(task => !known.has(task.id));
    return local.length > 0 ? [...local, ...conversations] : conversations;
  }, [conversations, localChats]);

  const value = useMemo(
    () => ({
      conversations,
      setConversations,
      tasks,
      localChats,
      saveLocalChat,
      getLocalChat,
      refreshConversations,
      upsertConversation,
      renameTask,
      removeTask,
      taskError,
      usage,
      usageError,
      usageUnsupported,
      refreshUsage,
      draftRequest,
      requestDraft
    }),
    [
      conversations,
      tasks,
      localChats,
      saveLocalChat,
      getLocalChat,
      refreshConversations,
      upsertConversation,
      renameTask,
      removeTask,
      taskError,
      usage,
      usageError,
      usageUnsupported,
      refreshUsage,
      draftRequest,
      requestDraft
    ]
  );

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTasks() {
  const context = useContext(TaskContext);
  if (!context) throw new Error("useTasks must be used inside a TaskProvider.");
  return context;
}
