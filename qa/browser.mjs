import fs from "node:fs";
import { chromium } from "playwright-core";

// The QA account is a throwaway row in the local dev database, created by this
// script on first run. Its credentials come from the environment and are never
// written to a file or printed.
const QA_EMAIL = process.env.QA_EMAIL;
const QA_PASSWORD = process.env.QA_PASSWORD;

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

function browserPath() {
  if (process.env.QA_BROWSER_PATH) return process.env.QA_BROWSER_PATH;
  return CANDIDATES.find(candidate => fs.existsSync(candidate)) ?? null;
}

export function baseUrl() {
  return process.env.QA_BASE ?? "http://127.0.0.1:5173";
}

export async function launch() {
  const executablePath = browserPath();
  if (!executablePath) throw new Error("no local Chromium binary found; set QA_BROWSER_PATH");
  return chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check", "--hide-scrollbars"]
  });
}

// Signs in through the real endpoint so the session is whatever the app itself
// would accept, then hands back the cookie for the browser context.
export async function sessionCookie() {
  if (!QA_EMAIL || !QA_PASSWORD) {
    throw new Error("QA_EMAIL and QA_PASSWORD must be set for the authenticated routes");
  }
  const origin = baseUrl();
  const post = async (route, expectCreated) => {
    const response = await fetch(`${origin}/api/auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: QA_EMAIL,
        password: QA_PASSWORD,
        name: expectCreated ? "QA Baseline" : undefined
      })
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };

  let result = await post("signin", false);
  if (!result.ok) {
    const created = await post("signup", true);
    if (!created.ok && created.status !== 409) {
      throw new Error(`QA account bootstrap failed: signin ${result.status}, signup ${created.status}`);
    }
    if (created.ok) result = created;
    else result = await post("signin", false);
  }
  if (!result.ok) throw new Error(`QA sign-in failed with ${result.status}`);
  const token = result.body?.token;
  if (!token) throw new Error("sign-in returned no token");
  return { name: "vr_session", value: token };
}

export async function newContext(browser, { viewport, cookie = null, theme = "dark" }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (cookie) {
    await context.addCookies([{ ...cookie, url: baseUrl(), sameSite: "Lax" }]);
  }
  /* The stored value is the *setting* (system/dark/light) and data-theme is the
     resolved paint, exactly as src/home/homeTheme.js defines them. Setting both
     before the bootstrap script runs means a QA run cannot accidentally inherit
     the host OS preference. */
  await context.addInitScript(value => {
    try {
      localStorage.setItem("vupsrouter.home.theme.v1", value);
      document.documentElement.setAttribute("data-theme-setting", value);
      document.documentElement.setAttribute(
        "data-theme",
        value === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value
      );
    } catch {
      /* storage disabled: the default theme is fine for a screenshot */
    }
  }, theme);
  return context;
}
