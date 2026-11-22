import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCurrentUser,
  getApiErrorMessage,
  isUnauthorizedError,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest
} from "../services/api.js";
import { setSettingsUser, invalidateSettings } from "../services/settingsCache.js";
import { isCloudOnline, useConnectivity } from "../connectivity/connectivity.js";
import {
  ensureLocalProfile,
  profileToUser,
  readAccountProfile,
  readLocalProfile,
  saveAccountProfile,
  clearAccountProfile
} from "../auth/localProfile.js";
import { endAccountSession } from "../desktop/accountSessionState.js";
import { isTauriRuntime } from "../native/shell.js";

const AuthContext = createContext(null);

/**
 * Offline boot is not a cached session and is deliberately not called one.
 *
 * - `authenticated` means the backend answered `/auth/me` in this run.
 * - `offline` means a previously verified account receipt is being shown while
 *   the backend cannot be reached. Cloud calls stay blocked until a later
 *   verification succeeds.
 * - `local` means the user is working under the device-local profile. It has no
 *   server authority at all.
 *
 * Only `authenticated` implies server authority.
 */
function initialAuth() {
  const browserOnline = typeof navigator === "undefined" || navigator.onLine !== false;
  const account = readAccountProfile();
  if (account) {
    return browserOnline
      ? { profile: null, status: "loading" }
      : { profile: profileToUser(account), status: "offline" };
  }
  // A device-local profile is a chosen mode, not a fallback: it stays in force
  // while the network is up so a reload cannot hand this device back to the
  // sign-in screen or let a server 401 eject the reader from their local work.
  const local = readLocalProfile();
  if (local) return { profile: profileToUser(local), status: "local" };
  if (!browserOnline) {
    return { profile: profileToUser(ensureLocalProfile() || readLocalProfile()), status: "local" };
  }
  return { profile: null, status: "loading" };
}

export function AuthProvider({ children }) {
  const connectivity = useConnectivity();
  const [initial] = useState(initialAuth);
  const [user, setUser] = useState(initial.profile);
  const [status, setStatus] = useState(initial.status);
  const [sessionError, setSessionError] = useState("");
  const userRef = useRef(initial.profile);
  const checkRef = useRef(0);
  const onlineRef = useRef(connectivity.online);
  const statusRef = useRef(initial.status);
  statusRef.current = status;

  const applyUser = useCallback(value => {
    userRef.current = value;
    setUser(value);
    setSettingsUser(value?.id || null);
  }, []);

  const enterLocalMode = useCallback(() => {
    const userValue = profileToUser(ensureLocalProfile() || readLocalProfile());
    checkRef.current += 1;
    applyUser(userValue);
    setSessionError("");
    setStatus("local");
    return userValue;
  }, [applyUser]);

  const useCachedIdentity = useCallback(
    (reason = "") => {
      const account = readAccountProfile();
      if (account) {
        applyUser(profileToUser(account));
        setSessionError("");
        setStatus("offline");
        return;
      }
      const local = readLocalProfile();
      if (local) {
        applyUser(profileToUser(local));
        setSessionError("");
        setStatus("local");
        return;
      }
      const created = ensureLocalProfile();
      applyUser(profileToUser(created));
      setSessionError(reason);
      setStatus("local");
    },
    [applyUser]
  );

  const refreshSession = useCallback(async ({ silent = false } = {}) => {
    if (!isCloudOnline()) {
      useCachedIdentity();
      return userRef.current || null;
    }
    const check = ++checkRef.current;
    if (!silent) {
      setStatus("loading");
      setSessionError("");
    }
    try {
      const current = await fetchCurrentUser();
      if (check !== checkRef.current) return null;
      applyUser(current);
      saveAccountProfile(current);
      setSessionError("");
      setStatus("authenticated");
      return current;
    } catch (error) {
      if (check !== checkRef.current) return null;
      if (isUnauthorizedError(error)) {
        clearAccountProfile();
        applyUser(null);
        setSessionError("");
        setStatus("anonymous");
        return null;
      }
      setSessionError(getApiErrorMessage(error));
      if (userRef.current) {
        setStatus("offline");
      } else {
        useCachedIdentity(getApiErrorMessage(error));
      }
      return userRef.current || null;
    }
  }, [applyUser, useCachedIdentity]);

  useEffect(() => {
    if (connectivity.online && initial.status !== "local") {
      refreshSession({ silent: initial.status !== "loading" });
    }
    return () => {
      checkRef.current += 1;
    };
    // The initial status decides once; later online transitions are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A transition must not remount the app or restart local work. Going offline
  // keeps the verified identity for local data access and marks it as offline;
  // coming back silently asks the server who this is before restoring cloud
  // authority.
  useEffect(() => {
    if (onlineRef.current === connectivity.online) return;
    onlineRef.current = connectivity.online;
    if (!connectivity.online) {
      checkRef.current += 1;
      if (statusRef.current === "authenticated" && userRef.current) {
        setStatus("offline");
      } else if (statusRef.current !== "local") {
        useCachedIdentity();
      }
      return;
    }
    // Reconnecting must not restart local work or ask the server who a
    // device-local reader is: local mode has no server session to restore.
    if (statusRef.current === "local") return;
    refreshSession({ silent: true });
  }, [connectivity.online, refreshSession, useCachedIdentity]);

  const signUp = useCallback(async payload => {
    const data = await signUpRequest(payload);
    checkRef.current += 1;
    applyUser(data.user);
    saveAccountProfile(data.user);
    setSessionError("");
    setStatus("authenticated");
    return data;
  }, [applyUser]);

  const signIn = useCallback(async payload => {
    const data = await signInRequest(payload);
    checkRef.current += 1;
    applyUser(data.user);
    saveAccountProfile(data.user);
    setSessionError("");
    setStatus("authenticated");
    return data;
  }, [applyUser]);

  const signOut = useCallback(async () => {
    checkRef.current += 1;
    // Sign-out ends the account's session authorization before the receipt is
    // cleared: the policy installed in this Windows app, the approval cards
    // raised under it, its in-memory chat-scoped answers, and the client map
    // naming those scopes. Durable data stays — the workspace registry, project
    // folders, chats, saved exact-file permissions, and this account's own
    // Ask/Agent mode, which is what makes a re-sign-in land where it left off.
    // No other owner's namespaced key is touched.
    const owner = String(userRef.current?.id || readAccountProfile()?.id || "");
    setSessionError("");
    const { error } = await endAccountSession({
      owner,
      desktop: isTauriRuntime()
    });
    if (error) setSessionError(error);
    try {
      await signOutRequest();
    } catch {
      // An offline sign-out still clears this device's account receipt; the
      // server session is cleared by the next successful sign-out or expiry.
    } finally {
      clearAccountProfile();
      applyUser(null);
      setStatus("anonymous");
      invalidateSettings();
    }
  }, [applyUser]);

  const value = useMemo(
    () => ({
      user,
      status,
      sessionError,
      isAuthenticated: status === "authenticated",
      hasLocalAccess: status === "authenticated" || status === "offline" || status === "local",
      isOffline: status === "offline",
      isLocalProfile: status === "local",
      cloudAvailable: status === "authenticated" && connectivity.online,
      enterLocalMode,
      refreshSession,
      signUp,
      signIn,
      signOut
    }),
    [
      user,
      status,
      sessionError,
      enterLocalMode,
      refreshSession,
      signUp,
      signIn,
      signOut,
      connectivity.online
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider.");
  return context;
}
