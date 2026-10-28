import React from "react";
import { Link } from "react-router-dom";
import { Container } from "@mui/material";
import VupsLogo from "./VupsLogo.jsx";

export default function SiteFooter() {
  return <footer className="footer"><Container maxWidth="lg" className="footer-inner">
    <Link to="/" className="brand" aria-label="VupsRouter home"><span className="brand-mark"><VupsLogo /></span><span>vups<span className="brand-light">router</span></span></Link>
    <span className="footer-copy">VupsRouter AI, built by Vups.</span>
    <div className="footer-links">
      <Link to="/download">Download</Link>
      <Link to="/features">Features</Link>
      <Link to="/about">About</Link>
      <Link to="/motion">Motion lab</Link>
      <Link to="/chat">AI Chat</Link>
      <Link to="/settings">API settings</Link>
      <Link to="/privacy-policy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/cookie-policy">Cookies</Link>
    </div>
    <span className="copyright">© {new Date().getFullYear()} VupsRouter</span>
  </Container></footer>;
}
