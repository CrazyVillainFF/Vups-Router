import { apiClient, getApiErrorMessage } from "../services/api.js";
import { PRODUCTION_SITE_URL } from "./authLinks.js";
import { openExternalUrl } from "./externalLinks.js";

export const DESKTOP_SIGNIN_STORAGE_KEY = "vupsrouter.desktop-signin";
export const DESKTOP_SIGNIN_POLL_MS = 2500;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loopback(url) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

// Production always uses the deployed HTTPS site. A loopback override exists
// only so a QA desktop build can be exercised against a local site.
export function siteBaseUrl(env = import.meta.env ?? {}) {
  const configured = String(env.VITE_SITE_URL || "").trim();
  try {
    const url = new URL(configured || PRODUCTION_SITE_URL);
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback(url))) return url.origin;
  } catch {
    /* fall through to production */
  }
  return new URL(PRODUCTION_SITE_URL).origin;
}

export async function createVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeForVerifier(verifier) {
  if (!crypto.subtle) {
    throw new Error("This device cannot start a secure sign-in. Sign in from the VupsRouter website instead.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function approvalUrl(transaction, env) {
  const url = new URL("/desktop-auth", siteBaseUrl(env));
  url.searchParams.set("ticket", transaction.ticket);
  url.searchParams.set("client", transaction.client || "windows");
  if (transaction.mode === "signup") url.searchParams.set("mode", "signup");
  return url.toString();
}

export class DesktopSignInError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "DesktopSignInError";
    this.reason = reason;
  }
}

function isTransaction(value) {
  return Boolean(
    value &&
      typeof value.ticket === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.ticket) &&
      typeof value.verifier === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(value.verifier) &&
      Number.isFinite(value.expiresAt)
  );
}

export function savePendingSignIn(transaction, storage) {
  storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!storage) return;
  try {
    storage.setItem(DESKTOP_SIGNIN_STORAGE_KEY, JSON.stringify(transaction));
  } catch {
    /* storage is best-effort; the in-memory transaction still works */
  }
}

export function readPendingSignIn(storage, now = Date.now()) {
  storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(DESKTOP_SIGNIN_STORAGE_KEY) || "null");
    if (!isTransaction(parsed) || parsed.expiresAt <= now) {
      storage.removeItem(DESKTOP_SIGNIN_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingSignIn(storage) {
  storage = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  try {
    storage?.removeItem(DESKTOP_SIGNIN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// A packaged app can outlive the backend it ships against: a missing route must
// read as "the service is not available yet", never as a raw axios status.
function startFailure(error) {
  if (error?.response?.status === 404) {
    return "The VupsRouter backend does not offer app sign-in yet. Sign in on the website, or update the backend.";
  }
  return getApiErrorMessage(error);
}

export async function beginDesktopSignIn({ client = "windows", mode = "signin", env } = {}) {
  const verifier = await createVerifier();
  const challenge = await challengeForVerifier(verifier);
  let data;
  try {
    ({ data } = await apiClient.post("/auth/desktop/start", { challenge, client }));
  } catch (error) {
    throw new DesktopSignInError(startFailure(error), "start_failed");
  }
  const expiresAt = Date.parse(data?.expiresAt || "");
  const transaction = {
    ticket: String(data?.ticket || ""),
    verifier,
    mode,
    client,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60 * 1000
  };
  if (!isTransaction(transaction)) {
    throw new DesktopSignInError("The app could not start a sign-in request. Try again.", "invalid");
  }
  savePendingSignIn(transaction);
  const url = approvalUrl(transaction, env);
  await openExternalUrl(url);
  return { transaction, url };
}

export async function reopenDesktopSignIn(transaction, env) {
  const url = approvalUrl(transaction, env);
  await openExternalUrl(url);
  return url;
}

export async function pollDesktopSignIn(transaction) {
  const response = await apiClient.post(
    "/auth/desktop/poll",
    { ticket: transaction.ticket, verifier: transaction.verifier },
    { validateStatus: status => status === 200 || status === 202 || status === 400 || status === 410 }
  );
  const data = response.data || {};
  if (response.status === 200 && data.status === "approved") {
    return { status: "approved", user: data.user || null };
  }
  if (response.status === 202 || data.status === "pending") return { status: "pending" };
  return { status: data.status || "expired", message: data.message || "This sign-in request expired." };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForDesktopSignIn(transaction, { signal, intervalMs = DESKTOP_SIGNIN_POLL_MS } = {}) {
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await pollDesktopSignIn(transaction);
    if (result.status === "approved") {
      clearPendingSignIn();
      return result;
    }
    if (result.status === "pending") {
      await delay(intervalMs, signal);
      continue;
    }
    clearPendingSignIn();
    throw new DesktopSignInError(result.message || "This sign-in request expired. Start again.", result.status);
  }
}
