import React from "react";
import { Link } from "react-router-dom";
import { Container } from "@mui/material";
import RouteRoundedIcon from "@mui/icons-material/RouteRounded";

export default function SiteFooter() {
  return <footer className="footer"><Container maxWidth="lg" className="footer-inner">
    <Link to="/" className="brand" aria-label="VupsRouter home"><span className="brand-mark"><RouteRoundedIcon /></span><span>vups<span className="brand-light">router</span></span></Link>
    <span className="footer-copy">A clearer route to free AI models.</span>
    <div className="footer-links">
      <a href="/#features">Free models</a>
      <Link to="/chat">Try AI</Link>
      <Link to="/settings">API settings</Link>
      <Link to="/signin">Sign in</Link>
      <Link to="/signup">Get started</Link>
      <Link to="/privacy-policy">Privacy</Link>
      <Link to="/terms">Terms</Link>
      <Link to="/cookie-policy">Cookies</Link>
    </div>
    <span className="copyright">© {new Date().getFullYear()} VupsRouter</span>
  </Container></footer>;
}
