import React from "react";
import { Link } from "react-router-dom";
import VupsLogo from "./VupsLogo.jsx";

const COLUMNS = [
  {
    label: "Product",
    links: [
      { to: "/download", text: "Download apps" },
      { to: "/features", text: "What is built" },
      { to: "/about", text: "Why it exists" },
      { to: "/motion", text: "Motion lab" }
    ]
  },
  {
    label: "Workspace",
    links: [
      { to: "/chat", text: "AI chat" },
      { to: "/settings", text: "Provider settings" },
      { to: "/signup", text: "Create an account" },
      { to: "/signin", text: "Sign in" }
    ]
  },
  {
    label: "Policies",
    links: [
      { to: "/privacy-policy", text: "Privacy policy" },
      { to: "/terms", text: "Terms of service" },
      { to: "/cookie-policy", text: "Cookie policy" }
    ]
  }
];

export default function LandingFooter() {
  return (
    <footer className="vr-foot">
      <div className="vr-wrap">
        <div className="vr-foot__top">
          <div className="vr-foot__brand">
            <Link to="/" className="brand" aria-label="VupsRouter home">
              <span className="brand-mark"><VupsLogo /></span>
              <span>vups<span className="brand-light">router</span></span>
            </Link>
            <p>
              One chat workspace: the built-in Vups model, your own provider configurations, and the conversations in
              between. No fabricated numbers on this page — every figure is counted from the running registry.
            </p>
          </div>

          {COLUMNS.map(column => (
            <nav key={column.label} className="vr-foot__col" aria-label={`${column.label} links`}>
              <h3>{column.label}</h3>
              <ul>
                {column.links.map(link => (
                  <li key={link.to}>
                    <Link to={link.to}>{link.text}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="vr-foot__bar">
          <span>© {new Date().getFullYear()} VupsRouter</span>
          <span>Built by Vups</span>
          <span>Free shared models · limits apply</span>
        </div>
      </div>
    </footer>
  );
}
