import React from "react";
import RequireAuth from "../components/RequireAuth.jsx";
import DesktopLayout from "./DesktopLayout.jsx";
import { PreferencesProvider } from "./PreferencesContext.jsx";
import { TaskProvider } from "./TaskContext.jsx";
import { TaskTrackerProvider } from "../tasks/TaskTrackerContext.jsx";
import { WorkspaceProvider } from "./WorkspaceContext.jsx";
import { PanelProvider } from "./panel/PanelContext.jsx";
import "./desktop.css";

export default function ProtectedAppLayout() {
  return (
    <RequireAuth>
      <PreferencesProvider>
        <WorkspaceProvider>
          <TaskProvider>
            {/* The tracker outlives every page inside the app: a task keeps
                being read while the user is on Settings, Combo or no page at
                all. It is reset only when the protected app itself ends. */}
            <TaskTrackerProvider>
              <PanelProvider>
                <DesktopLayout />
              </PanelProvider>
            </TaskTrackerProvider>
          </TaskProvider>
        </WorkspaceProvider>
      </PreferencesProvider>
    </RequireAuth>
  );
}
