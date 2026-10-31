import React, { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Container from "@mui/material/Container";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";

import PageMeta from "../components/PageMeta.jsx";
import { QuantumLoader } from "../components/LoadingVisuals.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { apiClient, getApiErrorMessage } from "../services/api.js";

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

function appLabel(client) {
  if (client === "android") return "VupsRouter for Android";
  if (client === "windows") return "VupsRouter for Windows";
  return "the VupsRouter app";
}

export default function DesktopAuthPage() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const ticket = params.get("ticket") || "";
  const mode = params.get("mode") === "signup" ? "signup" : "signin";
  const app = appLabel(params.get("client"));
  const { status, user } = useAuth();
  const [phase, setPhase] = useState("idle");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  const redirectTarget = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (status !== "authenticated" || started.current) return;
    if (!TICKET_RE.test(ticket)) {
      setPhase("error");
      setMessage("This sign-in link is incomplete. Start again from the app.");
      return;
    }
    started.current = true;
    setPhase("working");
    setMessage("");
    apiClient
      .post("/auth/desktop/approve", { ticket })
      .then(() => setPhase("done"))
      .catch(error => {
        setPhase("error");
        setMessage(getApiErrorMessage(error));
      });
  }, [status, ticket]);

  if (status === "loading") {
    return (
      <Box sx={{ minHeight: "70svh", display: "grid", placeItems: "center" }}>
        <QuantumLoader label="Checking your session" />
      </Box>
    );
  }

  if (status === "anonymous") {
    return (
      <Navigate
        to={mode === "signup" ? "/signup" : "/signin"}
        state={{ from: redirectTarget }}
        replace
      />
    );
  }

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 6, md: 10 } }}>
      <PageMeta title="Connect the VupsRouter app" />
      <Paper elevation={0} sx={{ p: { xs: 3, md: 5 }, borderRadius: 3, border: "1px solid rgba(120, 140, 180, 0.22)" }}>
        <Typography variant="overline" sx={{ letterSpacing: "0.18em", color: "#8ea3c4" }}>
          APP SIGN-IN
        </Typography>
        <Typography variant="h4" component="h1" sx={{ mt: 1, mb: 2 }}>
          Connect {app}
        </Typography>
        {phase === "working" ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <CircularProgress size={20} />
            <Typography>Approving this browser session…</Typography>
          </Box>
        ) : phase === "done" ? (
          <>
            <Alert severity="success" sx={{ mb: 2 }}>
              Signed in as {user?.email || "your account"}. Return to the app — it finishes signing in automatically.
            </Alert>
            <Typography color="text.secondary">You can close this tab. Nothing else is needed here.</Typography>
          </>
        ) : phase === "error" ? (
          <>
            <Alert severity="error" sx={{ mb: 2 }}>{message}</Alert>
            <Button variant="outlined" component="a" href="/chat">Continue on the website</Button>
          </>
        ) : (
          <CircularProgress size={20} />
        )}
      </Paper>
    </Container>
  );
}
