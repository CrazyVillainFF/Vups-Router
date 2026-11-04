import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./tokens.css";
import App from "./App.jsx";
import { isTauriRuntime } from "./native/shell.js";
import { initHomeTheme } from "./home/homeTheme.js";
import { useHomeTheme } from "./home/useHomeTheme.js";
import { paletteFor, token } from "./tokens.js";
import "./styles.css";

// Painted before the first render so the app shell never flashes one palette
// while the stored preference is read.
initHomeTheme();

/* Mobile browsers tint their chrome from <meta name="theme-color">, and that
   element cannot read a custom property. Filling it from the token table keeps
   one source of truth and leaves no colour literal in the HTML. */
function syncThemeColor(theme) {
  const meta = document.head.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", token("bg", paletteFor(theme)));
}

/* MUI owns the dialogs, menus and text fields the product sheets do not cover.
   Its palette is derived from the same token table the CSS uses, so the widget
   library and the hand-written screens can never disagree about what "surface"
   or "accent" mean — and it re-derives when the theme changes. */
function buildTheme(theme) {
  const p = paletteFor(theme);
  return createTheme({
    palette: {
      mode: theme,
      primary: { main: p.accent, contrastText: p.onAccent },
      secondary: { main: p.muted, contrastText: p.text },
      error: { main: p.error, contrastText: p.text },
      warning: { main: p.warn, contrastText: p.text },
      success: { main: p.ok, contrastText: p.onAccent },
      info: { main: p.muted, contrastText: p.text },
      divider: p.border,
      background: { default: p.bg, paper: p.surface },
      text: { primary: p.text, secondary: p.muted, disabled: p.muted }
    },
    typography: {
      fontFamily: "Geist, system-ui, -apple-system, 'Segoe UI', sans-serif",
      button: { textTransform: "none", fontWeight: 500, fontSize: 14 }
    },
    shape: { borderRadius: 6 },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            padding: "9px 16px",
            transition: "transform .12s ease, background-color .12s ease, border-color .12s ease"
          }
        }
      },
      MuiTextField: { defaultProps: { fullWidth: true, variant: "outlined", size: "medium" } },
      MuiTooltip: {
        defaultProps: { arrow: false },
        styleOverrides: {
          tooltip: {
            background: p.surface2,
            border: `1px solid ${p.borderStrong}`,
            borderRadius: 6,
            color: p.text,
            fontSize: 12,
            boxShadow: "none"
          },
          arrow: { color: p.surface2 }
        }
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiBackdrop: { styleOverrides: { root: { backdropFilter: "none" } } }
    }
  });
}

function ThemedApp() {
  const { theme } = useHomeTheme();
  React.useEffect(() => syncThemeColor(theme), [theme]);
  return (
    <ThemeProvider theme={buildTheme(theme)}>
      <CssBaseline />
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>
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
