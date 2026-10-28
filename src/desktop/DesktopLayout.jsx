import React, { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Sidebar as SidebarIcon } from "@phosphor-icons/react";
import { useAuth } from "../context/AuthContext.jsx";
import { detectNativeShell } from "../native/shell.js";
import DesktopSidebar from "./DesktopSidebar.jsx";
import { usePreferences } from "./PreferencesContext.jsx";

export default function DesktopLayout() {
  const { user, signOut } = useAuth();
  const { preferences } = usePreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(preferences.startSidebarCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef(null);

  useEffect(() => {
    setCollapsed(preferences.startSidebarCollapsed);
  }, [preferences.startSidebarCollapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      document.querySelector("#vr-sidebar a, #vr-sidebar button")?.focus({ preventScroll: true });
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(frame);
      if (menuButtonRef.current && document.contains(menuButtonRef.current)) {
        menuButtonRef.current.focus({ preventScroll: true });
      }
    };
  }, [mobileOpen]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 651px)");
    const onChange = event => {
      if (event.matches) setMobileOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const handleSignOut = async () => {
    await signOut();
    navigate(detectNativeShell() === "windows" ? "/signin" : "/");
  };

  return (
    <div className="vr-chat-layout vr-app-layout">
      <button
        ref={menuButtonRef}
        className="vr-mobile-menu-btn"
        onClick={() => {
          setCollapsed(false);
          setMobileOpen(true);
        }}
        aria-label="Open sidebar"
        aria-controls="vr-sidebar"
        aria-expanded={mobileOpen}
      >
        <SidebarIcon size={20} />
      </button>

      <DesktopSidebar
        collapsed={collapsed}
        onToggle={() => {
          if (window.matchMedia("(max-width: 650px)").matches) {
            setMobileOpen(false);
            return;
          }
          setCollapsed(value => !value);
        }}
        onExpand={() => setCollapsed(false)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        user={user}
        onSignOut={handleSignOut}
      />

      <div className="vr-app-main" inert={mobileOpen || undefined}>
        <Outlet />
      </div>
    </div>
  );
}
