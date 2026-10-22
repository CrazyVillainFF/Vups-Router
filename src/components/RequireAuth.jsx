import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Alert, Button, CircularProgress } from "@mui/material";
import { useAuth } from "../context/AuthContext.jsx";

export default function RequireAuth({ children }) {
  const { status, sessionError, refreshSession } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="auth-loading" role="status" aria-label="Checking your session">
        <CircularProgress size={30} />
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="auth-loading" role="status">
        <Alert
          severity="warning"
          sx={{ maxWidth: 560, mx: 2 }}
          action={
            <Button color="inherit" size="small" onClick={refreshSession}>
              Retry
            </Button>
          }
        >
          {sessionError || "Could not check your session. Check your connection and try again."}
        </Alert>
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return children;
}
