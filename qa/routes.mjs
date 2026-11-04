// Every renderable route in src/App.jsx, plus the 404 branch. `auth` marks the
// routes inside ProtectedAppLayout, which bounce to /signin without a session.
export const ROUTES = [
  { path: "/", name: "landing", auth: false },
  { path: "/features", name: "features", auth: false },
  { path: "/about", name: "about", auth: false },
  { path: "/download", name: "download", auth: false },
  { path: "/signin", name: "signin", auth: false },
  { path: "/signup", name: "signup", auth: false },
  { path: "/forgot-password", name: "forgot-password", auth: false },
  { path: "/privacy-policy", name: "privacy-policy", auth: false },
  { path: "/terms", name: "terms", auth: false },
  { path: "/cookie-policy", name: "cookie-policy", auth: false },
  { path: "/chat", name: "chat-home", auth: true },
  { path: "/combo", name: "combo", auth: true },
  { path: "/combo/settings", name: "combo-settings", auth: true },
  { path: "/automations", name: "automations", auth: true },
  { path: "/plugins", name: "plugins", auth: true },
  { path: "/help", name: "help", auth: true },
  { path: "/settings", name: "api-settings", auth: true },
  { path: "/app-settings", name: "app-settings", auth: true },
  { path: "/account", name: "account", auth: true },
  /* /motion is a real route in App.jsx and imports every vendored component, so
     the browser guards have to walk it: an unreachable page is not an exemption. */
  { path: "/motion", name: "motion-lab", auth: false },
  { path: "/this-route-does-not-exist", name: "not-found", auth: false }
];

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 }
];

// The home theme is the only theme switch the app has today; the light tokens
// hang on the same attribute.
export const THEMES = ["dark", "light"];

export const HOME_THEME_KEY = "vupsrouter.home.theme.v1";
