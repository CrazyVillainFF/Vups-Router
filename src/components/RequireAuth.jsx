import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { CircularProgress } from "@mui/material";
import { useAuth } from "../context/AuthContext.jsx";

export default function RequireAuth({ children }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="auth-loading" role="status" aria-label="Checking your session">
        <CircularProgress size={30} />
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return children;
}
