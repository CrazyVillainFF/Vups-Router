import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchCurrentUser,
  getApiErrorMessage,
  isUnauthorizedError,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest
} from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading");
  const [sessionError, setSessionError] = useState("");
  const checkRef = useRef(0);

  const refreshSession = useCallback(async () => {
    const check = ++checkRef.current;
    setStatus("loading");
    setSessionError("");
    try {
      const current = await fetchCurrentUser();
      if (check !== checkRef.current) return;
      setUser(current);
      setStatus("authenticated");
    } catch (error) {
      if (check !== checkRef.current) return;
      if (isUnauthorizedError(error)) {
        setUser(null);
        setStatus("anonymous");
        return;
      }
      setUser(null);
      setSessionError(getApiErrorMessage(error));
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    refreshSession();
    return () => {
      checkRef.current += 1;
    };
  }, [refreshSession]);

  const signUp = useCallback(async payload => {
    const data = await signUpRequest(payload);
    checkRef.current += 1;
    setUser(data.user);
    setSessionError("");
    setStatus("authenticated");
    return data;
  }, []);

  const signIn = useCallback(async payload => {
    const data = await signInRequest(payload);
    checkRef.current += 1;
    setUser(data.user);
    setSessionError("");
    setStatus("authenticated");
    return data;
  }, []);

  const signOut = useCallback(async () => {
    checkRef.current += 1;
    try {
      await signOutRequest();
    } finally {
      setUser(null);
      setSessionError("");
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      sessionError,
      isAuthenticated: status === "authenticated",
      refreshSession,
      signUp,
      signIn,
      signOut
    }),
    [user, status, sessionError, refreshSession, signUp, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider.");
  return context;
}
