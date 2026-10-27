import React, { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { AppBar, Button, CircularProgress, Container, IconButton } from "@mui/material";
import ArrowOutwardRoundedIcon from "@mui/icons-material/ArrowOutwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import VupsLogo from "./VupsLogo.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const LANDING_SECTION_LINKS = [
  { label: "Overview", hash: "#overview" },
  { label: "Interface", hash: "#showcase" },
  { label: "Features", hash: "#features" },
  { label: "Models", hash: "#models" },
  { label: "Privacy", hash: "#privacy" },
  { label: "FAQ", hash: "#faq" }
];

const APP_SECTION_LINKS = [
  { label: "Features", to: "/features" },
  { label: "About", to: "/about" }
];

const LANDING_SECTION_IDS = LANDING_SECTION_LINKS.map((link) => link.hash.slice(1));

function useActiveSection(ids, enabled) {
  const [active, setActive] = useState("");

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") {
      setActive("");
      return undefined;
    }
    const nodes = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) {
      setActive("");
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: [0, 0.25, 0.6] }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [enabled, ids]);

  return active;
}

export default function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { status, user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isLanding = pathname === "/";
  const activeSection = useActiveSection(
    LANDING_SECTION_LINKS.map((link) => link.hash.slice(1)),
    isLanding
  );

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  async function handleSignOut() {
    setMenuOpen(false);
    try {
      await signOut();
    } finally {
      navigate("/");
    }
  }

  const sectionLinks = isLanding ? LANDING_SECTION_LINKS : APP_SECTION_LINKS;

  return (
    <AppBar
      position="sticky"
      elevation={0}
      className={menuOpen && isLanding ? "topbar topbar--open" : "topbar"}
    >
      <Container maxWidth="lg" className="nav-wrap">
        <Link to="/" className="brand" aria-label="VupsRouter home">
          <span className="brand-mark"><VupsLogo /></span>
          <span>vups<span className="brand-light">router</span></span>
        </Link>
        <nav id="main-nav" className={menuOpen ? "nav-links nav-open" : "nav-links"} aria-label="Main navigation">
          {sectionLinks.map(({ label, hash, to }) =>
            hash ? (
              <a
                key={label}
                href={hash}
                className={activeSection === hash.slice(1) ? "nav-section nav-section-active" : "nav-section"}
                aria-current={activeSection === hash.slice(1) ? "true" : undefined}
                onClick={(event) => {
                  const target = document.getElementById(hash.slice(1));
                  if (!target) return;
                  event.preventDefault();
                  setMenuOpen(false);
                  target.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {label}
              </a>
            ) : (
              <NavLink key={label} to={to} onClick={() => setMenuOpen(false)}>
                {label}
              </NavLink>
            )
          )}
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
        <IconButton
          className="menu-toggle"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <CloseRoundedIcon /> : <MenuRoundedIcon />}
        </IconButton>
      </Container>
    </AppBar>
  );
}
