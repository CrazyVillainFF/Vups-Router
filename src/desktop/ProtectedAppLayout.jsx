import React from "react";
import RequireAuth from "../components/RequireAuth.jsx";
import DesktopLayout from "./DesktopLayout.jsx";
import { PreferencesProvider } from "./PreferencesContext.jsx";
import { TaskProvider } from "./TaskContext.jsx";
import { WorkspaceProvider } from "./WorkspaceContext.jsx";
import "./desktop.css";

export default function ProtectedAppLayout() {
  return (
    <RequireAuth>
      <PreferencesProvider>
        <WorkspaceProvider>
          <TaskProvider>
            <DesktopLayout />
          </TaskProvider>
        </WorkspaceProvider>
      </PreferencesProvider>
    </RequireAuth>
  );
}
