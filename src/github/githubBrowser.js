/* Pure logic for the repository browser: which credential the calls go through,
   what a failed call actually means, and how the path history moves. Keeping it
   out of the component is what makes the honest error states testable — a
   provider message is never rewritten into optimism here. */

import { connectionStatus, redactSecrets, signInOffer, signInStatus } from "../plugins/pluginDetails.js";

export const BROWSE_LIMIT = 100;

export function githubCard(plugins) {
  const list = Array.isArray(plugins) ? plugins : [];
  return list.find(plugin => plugin?.id === "github") || null;
}

/* Both connection methods drive the same tools, but they are different rows on
   the server, and which one answers decides whether the call uses a saved
   personal access token or the signed-in OAuth token. A stale token must not
   shadow a working sign-in, so the row reporting "connected" wins; when both
   work the token row stays first because it is the older, documented contract. */
/* Whether GitHub's OAuth app is configured on the backend decides if "Sign in
   with GitHub" is a real button or decoration, so it travels with every state
   instead of being read back off the raw plugin row. */
export function resolveConnection(plugins) {
  const plugin = githubCard(plugins);
  if (!plugin) {
    return {
      state: "missing",
      pluginId: "",
      oauthConfigured: false,
      sentence: "GitHub is not available in this build."
    };
  }
  const offer = signInOffer(plugin);
  const signIn = signInStatus(offer);
  const token = connectionStatus(plugin);
  const oauthConfigured = Boolean(offer?.configured);

  if (token.key === "connected") {
    return {
      state: "token",
      pluginId: plugin.id,
      oauthConfigured,
      account: plugin.config?.account?.login ? `@${plugin.config.account.login}` : "",
      sentence: token.sentence
    };
  }
  if (signIn?.key === "connected") {
    return {
      state: "oauth",
      pluginId: offer.pluginId,
      oauthConfigured,
      account: accountHandle(offer.account),
      sentence: signIn.sentence
    };
  }
  if (token.key === "problem" || signIn?.key === "problem") {
    return {
      state: "attention",
      pluginId: token.key === "problem" ? plugin.id : offer.pluginId,
      oauthConfigured,
      account: accountHandle(offer?.account),
      sentence: (token.key === "problem" ? token.sentence : signIn.sentence) ||
        "GitHub rejected the saved connection.",
      // Reconnect means starting a new sign-in or re-testing the token; which
      // one is offered depends on the row that is broken.
      reconnectVia: token.key === "problem" ? "token" : "oauth"
    };
  }
  // Nothing is connected. Public repositories can still be opened, because the
  // token row reads them without any credential — so this is not a dead end.
  return {
    state: "public_only",
    pluginId: plugin.id,
    oauthConfigured,
    account: "",
    sentence: "GitHub is not connected, so only public repositories can be opened."
  };
}

function accountHandle(account) {
  if (!account) return "";
  const login = typeof account === "string" ? account : account.login || "";
  return login ? `@${String(login).replace(/^@/, "")}` : "";
}

export function displayName(connection) {
  if (connection?.state === "oauth") return "GitHub sign-in";
  if (connection?.state === "token") return "Access token";
  return "Not connected";
}

/* GitHub reports a rate limit as 403 and a revoked grant as 401, while the
   plugin layer collapses both into "upstream_error"; the HTTP status is the
   only machine-readable discriminator that survives. A 404 is deliberately not
   split: GitHub answers the same way for a repository that does not exist and
   one the account cannot see, and guessing would be a lie about permissions. */
export function errorState(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const code = String(error?.response?.data?.code || error?.code || "");
  const message = redactSecrets(
    String(error?.response?.data?.message || error?.message || "GitHub did not answer.")
  );

  if (code === "cancelled" || status === 499) return { key: "cancelled", message };
  if (status === 401) return { key: "revoked", message };
  if (status === 429) return { key: "rate_limited", message, retryAfter: retryAfterMs(error) };
  if (status === 403 && looksLikeRateLimit(message)) {
    return { key: "rate_limited", message, retryAfter: retryAfterMs(error) };
  }
  if (status === 403) return { key: "forbidden", message };
  if (status === 404 || code === "file_not_found" || code === "unknown_ref") {
    return { key: "not_found", message };
  }
  if (code === "plugin_not_installed") return { key: "not_connected", message };
  if (code === "plugin_not_connected") return { key: "attention", message };
  if (code === "token_required") return { key: "no_token", message };
  if (!status) return { key: "offline", message };
  return { key: "failed", message };
}

function looksLikeRateLimit(message) {
  return /rate limit|secondary rate limit|abuse detection/i.test(String(message || ""));
}

function retryAfterMs(error) {
  const value = Number(error?.response?.data?.retryAfter || error?.retryAfter || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Navigation is a stack the user can walk back through, so "back" must land on
// the repository list they actually saw rather than re-fetching from scratch.
export function pushView(history, view) {
  const past = history.present ? [...history.past, history.present] : history.past;
  return { past: past.slice(-24), present: view, future: [] };
}

export function goBack(history) {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: history.present ? [history.present, ...history.future] : history.future
  };
}

export function goForward(history) {
  if (history.future.length === 0) return history;
  const next = history.future[0];
  return {
    past: history.present ? [...history.past, history.present] : history.past,
    present: next,
    future: history.future.slice(1)
  };
}

export const EMPTY_HISTORY = { past: [], present: null, future: [] };

export function folderOf(path) {
  const value = String(path || "").replace(/\/+$/, "");
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

/* GitHub's contents endpoint is case-sensitive for the path, while the file
   people mean is the same thing spelled three ways. This only ever asks the
   server; nothing is invented when all of them miss. */
export const README_CANDIDATES = ["README.md", "readme.md", "README.MD", "Readme.md", "README.rst", "README"];

export function sortEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""), "en", { numeric: true });
  });
}

export function filterRepos(repositories, query) {
  const needle = String(query || "").trim().toLowerCase();
  const list = Array.isArray(repositories) ? repositories : [];
  if (!needle) return list;
  return list.filter(repo =>
    [repo?.fullName, repo?.name, repo?.owner?.login, repo?.description]
      .filter(Boolean)
      .some(value => String(value).toLowerCase().includes(needle))
  );
}

export function ownerRepoFrom(text) {
  const value = String(text || "")
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    // A pasted "github.com/owner/repo" has no scheme, and typing it without one
    // is how most people paste a repository, so the host is stripped either way.
    .replace(/^github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  if (!/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
  // Both spellings travel: `owner`/`repo` are the argument names the tools take,
  // while `name` is the field every repository object in this app is read from.
  // Returning only the first silently disabled "/repo owner/name".
  return { owner: parts[0], repo: parts[1], name: parts[1] };
}

/* The message the conversation records when a repository becomes this chat's
   scope. It is an ordinary turn the user can see and quote back, which is why
   the sentence states the effect instead of pretending a hidden setting. */
export function repoScopeMessage(repo, branch) {
  const ref = branch || repo?.defaultBranch || "its default branch";
  return [
    `GitHub scope: ${repo?.fullName || `${repo?.owner}/${repo?.name}`}`,
    `Branch: ${ref}`,
    repo?.description ? `Description: ${repo.description}` : "",
    "Use the GitHub tools against this repository for this chat unless I say otherwise."
  ]
    .filter(Boolean)
    .join("\n");
}

export function repoLabel(repo) {
  if (!repo) return "";
  return repo.fullName || `${repo.owner?.login || repo.owner || ""}/${repo.name || ""}`;
}
