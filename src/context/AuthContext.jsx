import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  fetchCurrentUser,
  signIn as signInRequest,
  signOut as signOutRequest,
  signUp as signUpRequest
} from "../services/api.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser()
      .then(current => {
        if (cancelled) return;
        setUser(current);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signUp = useCallback(async payload => {
    const data = await signUpRequest(payload);
    setUser(data.user);
    setStatus("authenticated");
    return data;
  }, []);

  const signIn = useCallback(async payload => {
    const data = await signInRequest(payload);
    setUser(data.user);
    setStatus("authenticated");
    return data;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await signOutRequest();
    } finally {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, isAuthenticated: status === "authenticated", signUp, signIn, signOut }),
    [user, status, signUp, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider.");
  return context;
}
