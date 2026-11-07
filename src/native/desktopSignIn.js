import { apiClient, getApiErrorMessage } from "../services/api.js";
import { PRODUCTION_SITE_URL } from "./authLinks.js";
import { openExternalUrl } from "./externalLinks.js";
import { isTauriRuntime } from "./shell.js";

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

function loopbackOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" && loopback(url);
  } catch {
    return false;
  }
}

// The approval page must talk to the same backend that issued the ticket. A
// debug desktop app can point at a local QA backend while the built site still
// names the production deployment; opening that site would send the approval to
// a backend that never saw the ticket. When both the API and the app page are
// loopback, keep the handoff on the app's own local origin instead.
export function approvalBaseUrl(env = import.meta.env ?? {}, { apiOrigin = "", pageOrigin = "" } = {}) {
  if (loopbackOrigin(apiOrigin) && loopbackOrigin(pageOrigin)) {
    return new URL(pageOrigin).origin;
  }
  return siteBaseUrl(env);
}

export async function resolveApprovalBaseUrl(env = import.meta.env ?? {}) {
  if (!isTauriRuntime()) return siteBaseUrl(env);
  try {
    const response = await fetch("/__desktop/runtime", {
      cache: "no-store",
      credentials: "omit"
    });
    const runtime = await response.json();
    const apiOrigin = String(runtime?.apiOrigin || "");
    const pageOrigin = typeof window !== "undefined" ? window.location?.origin || "" : "";
    return approvalBaseUrl(env, { apiOrigin, pageOrigin });
  } catch {
    return siteBaseUrl(env);
  }
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

export function approvalUrl(transaction, env, baseUrl) {
  const url = new URL("/desktop-auth", baseUrl || siteBaseUrl(env));
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
  const url = approvalUrl(transaction, env, await resolveApprovalBaseUrl(env));
  await openExternalUrl(url);
  return { transaction, url };
}

export async function reopenDesktopSignIn(transaction, env) {
  const url = approvalUrl(transaction, env, await resolveApprovalBaseUrl(env));
  await openExternalUrl(url);
  return url;
}

export async function pollDesktopSignIn(transaction, { signal } = {}) {
  let response;
  try {
    response = await apiClient.post(
      "/auth/desktop/poll",
      { ticket: transaction.ticket, verifier: transaction.verifier },
      {
        signal,
        validateStatus: status => status === 200 || status === 202 || status === 400 || status === 410
      }
    );
  } catch (error) {
    // axios reports cancellation as CanceledError; callers only understand the
    // DOMException name, so translate before it reaches the UI.
    if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw error;
  }
  const data = response.data || {};
  if (response.status === 200 && data.status === "approved") {
    return { status: "approved", user: data.user || null };
  }
  // A consumed transaction is a sign-in that already finished; the session
  // landed on the winning response, so this one carries no cookie by design.
  if (response.status === 200 && data.status === "completed") return { status: "completed" };
  if (response.status === 202 || data.status === "pending") return { status: "pending" };
  if (data.status === "invalid") return { status: "invalid", message: data.message || "The sign-in request could not be verified." };
  return { status: data.status || "expired", message: data.message || "This sign-in request expired." };
}

// One polling owner per ticket, process-wide. A remount, the mount-time resume
// and an explicit sign-in click all target the same ticket; letting two of them
// poll lets the loser read the winner's consumed transaction and report failure
// for a sign-in that actually succeeded. The newest caller takes ownership.
const pollOwners = new Map();

function claimPollOwner(ticket, controller) {
  pollOwners.get(ticket)?.abort();
  pollOwners.set(ticket, controller);
}

function releasePollOwner(ticket, controller) {
  if (pollOwners.get(ticket) === controller) pollOwners.delete(ticket);
}

export function abortPendingPoll(ticket) {
  const owner = pollOwners.get(ticket);
  if (owner) {
    pollOwners.delete(ticket);
    owner.abort();
  }
}

export function hasActivePoll(ticket) {
  return pollOwners.has(ticket);
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

const POLL_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransportFailure(error) {
  if (!error) return false;
  if (!error.response) return error.code !== "ERR_CANCELED" && error.name !== "AbortError";
  return POLL_RETRYABLE_STATUSES.has(error.response.status);
}

export async function waitForDesktopSignIn(transaction, { signal, intervalMs = DESKTOP_SIGNIN_POLL_MS, maxTransportRetries = 3 } = {}) {
  const owner = new AbortController();
  const onCallerAbort = () => owner.abort();
  if (signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  claimPollOwner(transaction.ticket, owner);

  let transportFailures = 0;
  try {
    for (;;) {
      if (owner.signal.aborted) throw new DOMException("Aborted", "AbortError");
      // The ticket is dead locally, so stop before asking the server about it.
      if (transaction.expiresAt <= Date.now()) {
        clearPendingSignIn();
        throw new DesktopSignInError("This sign-in request expired. Start again.", "expired");
      }
      let result;
      try {
        result = await pollDesktopSignIn(transaction, { signal: owner.signal });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        if (!isTransportFailure(error)) throw error;
        transportFailures += 1;
        if (transportFailures > maxTransportRetries) {
          throw new DesktopSignInError(
            "Could not reach the VupsRouter sign-in service. Check your connection and try again.",
            "network"
          );
        }
        await delay(intervalMs, owner.signal);
        continue;
      }
      transportFailures = 0;
      if (result.status === "approved" || result.status === "completed") {
        clearPendingSignIn();
        return result;
      }
      if (result.status === "pending") {
        await delay(intervalMs, owner.signal);
        continue;
      }
      clearPendingSignIn();
      throw new DesktopSignInError(result.message || "This sign-in request expired. Start again.", result.status);
    }
  } finally {
    signal?.removeEventListener("abort", onCallerAbort);
    releasePollOwner(transaction.ticket, owner);
  }
}
