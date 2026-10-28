import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import App from "./App.jsx";
import { isTauriRuntime } from "./native/shell.js";
import "./styles.css";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#6c9bff", contrastText: "#081018" },
    secondary: { main: "#9aa8bd" },
    error: { main: "#e08585" },
    warning: { main: "#e0b46c" },
    success: { main: "#7dbf9a" },
    divider: "rgba(148,163,184,.16)",
    background: { default: "#070b14", paper: "#0d1524" },
    text: { primary: "#e9eef7", secondary: "#9aa8bd" }
  },
  typography: { fontFamily: '"Outfit", "Avenir Next", system-ui, sans-serif', button: { textTransform: "none", fontWeight: 650 } },
  shape: { borderRadius: 14 },
  components: {
    MuiButton: { styleOverrides: { root: { borderRadius: 999, padding: "11px 19px", transition: "transform .25s ease, box-shadow .25s ease" } } },
    MuiTextField: { defaultProps: { fullWidth: true, variant: "outlined", size: "medium" } }
  }
});

createRoot(document.getElementById("root")).render(
  <React.StrictMode><ThemeProvider theme={theme}><CssBaseline /><BrowserRouter><App /></BrowserRouter></ThemeProvider></React.StrictMode>
);

if (import.meta.env.PROD && !isTauriRuntime() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then(registration => {
      if (registration.waiting) registration.waiting.postMessage("SKIP_WAITING");
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage("SKIP_WAITING");
          }
        });
      });
    }).catch(() => {
      // A failed service-worker registration must never block the app.
    });
  });
}