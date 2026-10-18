import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import App from "./App.jsx";
import "./styles.css";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#d4ff3f", contrastText: "#11140a" },
    background: { default: "#090b0d", paper: "#111416" },
    text: { primary: "#f2f4ef", secondary: "#9ca39c" }
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