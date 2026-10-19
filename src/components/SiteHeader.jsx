import React, { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { AppBar, Button, CircularProgress, Container, IconButton } from "@mui/material";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import { useAuth } from "../context/AuthContext.jsx";

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { status, user, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    setMenuOpen(false);
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  }

  return (
    <AppBar position="sticky" elevation={0} className="topbar">
      <Container maxWidth="lg" className="nav-wrap">
        <Link to="/" className="brand" aria-label="VupsRouter home">
          <span className="brand-mark"><RouteRoundedIcon /></span>
          <span>vups<span className="brand-light">router</span></span>
        </Link>
        <nav id="main-nav" className={menuOpen ? "nav-links nav-open" : "nav-links"} aria-label="Main navigation">
          <a href="/#features" onClick={() => setMenuOpen(false)}>Free models</a>
          <a href="/#how-it-works" onClick={() => setMenuOpen(false)}>How to choose</a>
          <NavLink
            to="/chat"
            onClick={() => setMenuOpen(false)}
            className={({ isActive }) => `nav-chat${isActive ? " nav-chat-active" : ""}`}
          >
            <ChatBubbleOutlineRoundedIcon fontSize="small" /> AI Chat
          </NavLink>
          {status === "authenticated" && (
            <NavLink to="/settings" onClick={() => setMenuOpen(false)}>API settings</NavLink>
          )}
          {status === "loading" ? (
            <CircularProgress size={18} className="nav-spinner" />
          ) : status === "authenticated" ? (
            <span className="nav-account">
              <span className="nav-user" title={user?.email}>{user?.name}</span>
              <Button
                variant="outlined"
                startIcon={<SettingsRoundedIcon />}
                component={Link}
                to="/settings"
                onClick={() => setMenuOpen(false)}
              >
                Settings
              </Button>
              <Button
                variant="contained"
                startIcon={<LogoutRoundedIcon />}
                onClick={handleSignOut}
              >
                Sign out
              </Button>
            </span>
          ) : (
            <>
              <NavLink to="/signin" onClick={() => setMenuOpen(false)}>Sign in</NavLink>
              <Button
                component={Link}
                to="/signup"
                variant="contained"
                endIcon={<ArrowOutwardRoundedIcon />}
                onClick={() => setMenuOpen(false)}
              >
                Get started
              </Button>
            </>
          )}
        </nav>
        <IconButton className="menu-toggle" aria-label="Toggle navigation" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen(!menuOpen)}>
          <MenuRoundedIcon />
        </IconButton>
      </Container>
    </AppBar>
  );
}
