import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");

import {
  BROWSE_LIMIT,
  EMPTY_HISTORY,
  README_CANDIDATES,
  displayName,
  errorState,
  filterRepos,
  folderOf,
  githubCard,
  goBack,
  goForward,
  ownerRepoFrom,
  pushView,
  repoLabel,
  repoScopeMessage,
  resolveConnection,
  sortEntries
} from "../src/github/githubBrowser.js";

/* The three rows GitHub can arrive as. These are the shapes the backend actually
   sends — the token row carries `connection`, the sign-in row hangs off it under
   `oauth` — because the bug this file guards against is a browser that opens on
   a credential nobody holds. */
function tokenRow(overrides = {}) {
  return {
    id: "github",
    name: "GitHub",
    installed: true,
    connection: "connected",
    auth: { type: "optional_api_key", label: "Personal access token" },
    config: { account: { login: "CrazyVillainFF", name: "Vishnu" } },
    lastTestAt: "2026-11-01T10:00:00.000Z",
    lastTestStatus: "connected",
    tools: [
      { name: "list_repositories", sideEffect: "none" },
      { name: "read_file", sideEffect: "none" }
    ],
    oauth: {
      pluginId: "github-oauth",
      label: "Sign in with GitHub",
      configured: true,
      installed: false,
      connection: "disconnected",
      account: null,
      offeredScopes: "repo,read:user"
    },
    ...overrides
  };
}

function signedInRow(overrides = {}) {
  const row = tokenRow({ installed: false, connection: "disconnected", lastTestStatus: "", lastTestAt: null });
  row.oauth = { ...row.oauth, installed: true, connection: "connected", account: { login: "CrazyVillainFF" } };
  return { ...row, ...overrides };
}

test("the token row answers first when both credentials are alive", () => {
  const connection = resolveConnection([tokenRow()]);
  assert.equal(connection.state, "token");
  assert.equal(connection.pluginId, "github");
  assert.equal(connection.account, "@CrazyVillainFF");
  assert.equal(displayName(connection), "Access token");
});

test("a broken token never shadows a working sign-in", () => {
  const row = signedInRow({ installed: true, connection: "needs_reconnection", lastTestMessage: "Bad credentials" });
  const connection = resolveConnection([row]);
  assert.equal(connection.state, "oauth", "the sign-in row is the one that actually works");
  assert.equal(connection.pluginId, "github-oauth");
  assert.equal(connection.account, "@CrazyVillainFF");
  assert.equal(displayName(connection), "GitHub sign-in");
});

test("a working token outranks a sign-in that needs attention", () => {
  const row = tokenRow();
  row.oauth = { ...row.oauth, installed: true, connection: "error", lastError: "Token revoked" };
  const connection = resolveConnection([row]);
  assert.equal(connection.state, "token");
});

test("nothing connected still opens public repositories", () => {
  const row = tokenRow({ installed: true, connection: "disconnected", lastTestStatus: "", config: {}, lastTestAt: null });
  const connection = resolveConnection([row]);
  assert.equal(connection.state, "public_only");
  assert.equal(connection.pluginId, "github");
  assert.equal(connection.account, "");
  assert.match(connection.sentence, /only public repositories/i);
});

test("the OAuth offer travels with the state so the sign-in button is never decoration", () => {
  const unconfigured = tokenRow();
  unconfigured.oauth = { ...unconfigured.oauth, configured: false };
  assert.equal(resolveConnection([tokenRow()]).oauthConfigured, true);
  assert.equal(resolveConnection([unconfigured]).oauthConfigured, false, "no button for an app the server has not set up");
  assert.equal(resolveConnection([]).oauthConfigured, false);
  assert.equal(resolveConnection(undefined).oauthConfigured, false);
});

test("a connection that failed says so and names the way back", () => {
  const row = tokenRow({ connection: "needs_reconnection", lastTestMessage: "Bad credentials" });
  const connection = resolveConnection([row]);
  assert.equal(connection.state, "attention");
  assert.equal(connection.reconnectVia, "token");
  assert.match(connection.sentence, /did not succeed/i);

  const signInOnly = signedInRow({ installed: true, connection: "disconnected" });
  signInOnly.oauth = { ...signInOnly.oauth, connection: "error", lastError: "GitHub rejected the token" };
  const viaOAuth = resolveConnection([signInOnly]);
  assert.equal(viaOAuth.state, "attention");
  assert.equal(viaOAuth.reconnectVia, "oauth");
});

test("githubCard and resolveConnection survive garbage without throwing", () => {
  for (const value of [undefined, null, [], [null], [{}], "github", [{ id: 42 }]]) {
    assert.doesNotThrow(() => resolveConnection(value));
    const connection = resolveConnection(value);
    assert.ok(typeof connection.state === "string");
    assert.ok(typeof connection.sentence === "string" && connection.sentence.length > 0);
  }
  assert.equal(githubCard([{ id: "other" }, { id: "github" }]).id, "github");
  assert.equal(githubCard(undefined), null);
});

test("every failure GitHub can return maps to the state the brief asks to show", () => {
  const cases = [
    [{ response: { status: 401, data: { message: "Bad credentials" } } }, "revoked"],
    [{ response: { status: 429, data: { message: "You have exceeded a secondary rate limit" } } }, "rate_limited"],
    [{ response: { status: 403, data: { message: "API rate limit exceeded for 1.2.3.4" } } }, "rate_limited"],
    [{ response: { status: 403, data: { message: "Resource not accessible by personal access token" } } }, "forbidden"],
    [{ response: { status: 404, data: { message: "Not Found" } } }, "not_found"],
    [{ code: "file_not_found" }, "not_found"],
    [{ code: "unknown_ref" }, "not_found"],
    [{ code: "plugin_not_installed" }, "not_connected"],
    [{ code: "plugin_not_connected" }, "attention"],
    [{ code: "token_required", message: "A token is needed for this repository" }, "no_token"],
    [{ code: "cancelled", message: "Request cancelled" }, "cancelled"],
    [{ response: { status: 499 } }, "cancelled"],
    [{ name: "TypeError", message: "fetch failed" }, "offline"],
    [{ response: { status: 500, data: { message: "Server Error" } } }, "failed"]
  ];
  for (const [error, key] of cases) {
    const state = errorState(error);
    assert.equal(state.key, key, `${JSON.stringify(error)} → ${key} (got ${state.key})`);
    assert.ok(state.message, "a state always carries the provider's own sentence");
  }
});

test("a 404 is not dressed up as a permissions verdict", () => {
  // GitHub answers identically for a repository that does not exist and one the
  // account cannot see, so the only honest answer is "not found".
  const state = errorState({ response: { status: 404, data: { message: "Not Found" } } });
  assert.equal(state.key, "not_found");
  assert.ok(!/private|no access|forbidden/i.test(state.message));
});

test("a rate limit keeps the retry window when GitHub gives one", () => {
  const withWindow = errorState({ response: { status: 429, data: { message: "Too many requests", retryAfter: 30_000 } } });
  assert.equal(withWindow.retryAfter, 30_000);
  assert.equal(errorState({ response: { status: 429, data: { message: "Too many requests" } } }).retryAfter, 0);
});

test("a provider message can never put a credential on screen", () => {
  const leaked = errorState({
    message:
      "Rejected token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for api_key=supersecretvalue github_pat_11ABCDEFGHIJ0123456789_klmnopqrstuvwxyz0123456789ABCDEF"
  });
  assert.ok(!leaked.message.includes("ghp_"), leaked.message);
  assert.ok(!leaked.message.includes("github_pat_"), leaked.message);
  assert.ok(!leaked.message.includes("supersecretvalue"), leaked.message);
  assert.match(leaked.message, /\[redacted\]/);
});

test("a missing provider message still reads as a sentence", () => {
  assert.equal(errorState(undefined).key, "offline");
  assert.match(errorState({}).message, /did not answer/i);
});

test("the path history walks back and forward through what the user actually saw", () => {
  const repos = { level: "repos" };
  const root2 = { level: "tree", repo: { owner: "a", name: "b" }, path: "" };
  const nested = { level: "tree", repo: { owner: "a", name: "b" }, path: "src/github" };
  const file = { level: "file", path: "src/github/browser.js" };

  let history = EMPTY_HISTORY;
  assert.equal(goBack(history), history, "back at the start is a no-op");
  history = pushView(history, repos);
  history = pushView(history, root2);
  history = pushView(history, nested);
  history = pushView(history, file);
  assert.equal(history.present, file);
  assert.deepEqual(history.past, [repos, root2, nested]);
  assert.deepEqual(history.future, []);

  history = goBack(history);
  assert.equal(history.present, nested);
  assert.deepEqual(history.future, [file]);
  history = goBack(history);
  assert.equal(history.present, root2);
  history = goForward(history);
  assert.equal(history.present, nested, "forward replays the step just undone");
  history = goForward(goForward(history));
  assert.equal(history.present, file);
  assert.deepEqual(history.future, []);
});

test("pushing a new view discards the forward branch, like a browser", () => {
  let history = pushView(pushView(EMPTY_HISTORY, { level: "repos" }), { level: "tree", path: "" });
  history = goBack(history);
  assert.equal(history.future.length, 1);
  history = pushView(history, { level: "tree", path: "docs" });
  assert.deepEqual(history.future, [], "a new branch of navigation cannot be replayed");
});

test("the back stack is capped so a long session cannot grow unbounded", () => {
  let history = EMPTY_HISTORY;
  for (let index = 0; index < 40; index += 1) {
    history = pushView(history, { level: "tree", path: `dir-${index}` });
  }
  assert.equal(history.past.length, 24);
  assert.equal(history.past[history.past.length - 1].path, "dir-38");
});

test("folderOf and sortEntries do the boring path work correctly", () => {
  assert.equal(folderOf("src/github/browser.js"), "src/github");
  assert.equal(folderOf("README.md"), "");
  assert.equal(folderOf("src/nested/"), "src");
  assert.equal(folderOf(""), "");
  assert.equal(folderOf(undefined), "");

  const sorted = sortEntries([
    { name: "z-last", type: "file" },
    { name: "component10", type: "dir" },
    { name: "component2", type: "dir" },
    { name: "a-first", type: "file" }
  ]);
  assert.deepEqual(sorted.map(e => e.name), ["component2", "component10", "a-first", "z-last"]);
  assert.deepEqual(sortEntries(undefined), []);
  assert.equal(BROWSE_LIMIT, 100);
});

test("the search box matches on the fields a user would type", () => {
  const repos = [
    { fullName: "CrazyVillainFF/Vups-Router", name: "Vups-Router", owner: { login: "CrazyVillainFF" }, description: "Local-first AI router" },
    { fullName: "CrazyVillainFF/notes", name: "notes", owner: { login: "CrazyVillainFF" }, description: "GSAP experiments" }
  ];
  assert.deepEqual(filterRepos(repos, "vups").map(r => r.fullName), ["CrazyVillainFF/Vups-Router"]);
  assert.deepEqual(filterRepos(repos, "GSAP").map(r => r.fullName), ["CrazyVillainFF/notes"]);
  assert.deepEqual(filterRepos(repos, "crazyvillainff").length, 2, "the owner alone matches");
  assert.equal(filterRepos(repos, "").length, 2, "an empty query is not a filter");
  assert.deepEqual(filterRepos(undefined, "x"), []);
  assert.deepEqual(filterRepos([{ name: null }], "x"), []);
});

test("ownerRepoFrom takes a repository out of whatever the user pasted", () => {
  // The result has to serve both spellings: the tools are called with
  // {owner, repo}, while every repository object in the app is read by `name`.
  // A result missing `name` made "/repo CrazyVillainFF/Vups-Router" a silent no-op.
  const expected = { owner: "CrazyVillainFF", repo: "Vups-Router", name: "Vups-Router" };
  assert.deepEqual(ownerRepoFrom("CrazyVillainFF/Vups-Router"), expected);
  assert.deepEqual(ownerRepoFrom("  https://github.com/CrazyVillainFF/Vups-Router  "), expected);
  assert.deepEqual(ownerRepoFrom("github.com/CrazyVillainFF/Vups-Router.git"), expected);
  assert.deepEqual(ownerRepoFrom("/CrazyVillainFF/Vups-Router/tree/main"), expected);
  for (const value of ["CrazyVillainFF/Vups-Router", "not a repository"]) {
    const named = ownerRepoFrom(value);
    if (!named) continue;
    assert.equal(typeof named.name, "string", "`name` is present for the repository-shaped readers");
    assert.equal(named.name, named.repo, "the two spellings never disagree");
  }
  for (const junk of ["", "vups-router", undefined, "not a repo at all", "github.com"]) {
    assert.equal(ownerRepoFrom(junk), null, `${JSON.stringify(junk)} is not a repository`);
  }
});

test("the scope a chat records states the repository, the ref and the effect", () => {
  const repo = { owner: "CrazyVillainFF", name: "Vups-Router", fullName: "CrazyVillainFF/Vups-Router", description: "Local-first AI router", defaultBranch: "main" };
  const message = repoScopeMessage(repo, "feature/browser");
  assert.ok(message.includes("GitHub scope: CrazyVillainFF/Vups-Router"));
  assert.ok(message.includes("Branch: feature/browser"), "the branch chosen is the branch announced");
  assert.ok(message.includes("Description: Local-first AI router"));
  assert.ok(/unless I say otherwise/i.test(message));
  assert.ok(message.includes("\n"), "it reads as lines in the transcript, not one run-on sentence");

  const fallback = repoScopeMessage({ owner: "a", name: "b" });
  assert.ok(fallback.includes("Branch: its default branch"), "no invented ref when nothing was picked");
  assert.ok(!fallback.includes("Description:"));
});

test("repoLabel is the one string every screen uses for a repository", () => {
  assert.equal(repoLabel({ fullName: "a/b" }), "a/b");
  assert.equal(repoLabel({ owner: { login: "a" }, name: "b" }), "a/b");
  assert.equal(repoLabel({ owner: "a", name: "b" }), "a/b");
  assert.equal(repoLabel(null), "");
});

test("README lookup only asks for the spellings GitHub actually holds", () => {
  assert.deepEqual(README_CANDIDATES.slice(0, 2), ["README.md", "readme.md"]);
  for (const name of README_CANDIDATES) assert.match(name, /^README/i);
});

test("the browser is wired to the six real read-only tools and nothing else", () => {
  const browser = readFileSync(path.join(srcDir, "github", "GitHubRepoBrowser.jsx"), "utf8");
  for (const tool of ["list_repositories", "search_repositories", "list_files", "read_file", "list_branches"]) {
    assert.ok(browser.includes(`"${tool}"`), `${tool} is called through the plugin API`);
  }
  assert.ok(browser.includes("executePluginTool"), "the calls go to the real endpoint");
  assert.ok(browser.includes("uninstallPlugin"), "disconnect removes the stored credential");
  assert.ok(browser.includes("openExternalUrl"), "open-on-github uses the platform's own browser");
  assert.doesNotMatch(browser, /mock|fixture|dummy|fakeRepos|sampleRepos/i, "no simulated data in the browser");
});

test("every state the brief lists has copy the browser can show", () => {
  const browser = readFileSync(path.join(srcDir, "github", "GitHubRepoBrowser.jsx"), "utf8");
  // Whatever errorState can conclude, the reader gets a sentence about it: the
  // notice map is keyed by that conclusion, so a missing key is a silent failure.
  const noticeKeys = new Set(
    [...browser.matchAll(/^  ([a-z_]+): \{/gm)].map(match => match[1])
  );
  const produced = new Set([
    errorState({ response: { status: 401 } }).key,
    errorState({ response: { status: 429 } }).key,
    errorState({ response: { status: 403 } }).key,
    errorState({ response: { status: 404 } }).key,
    errorState({ code: "plugin_not_installed" }).key,
    errorState({ code: "plugin_not_connected" }).key,
    errorState({ code: "token_required" }).key,
    errorState({ code: "cancelled" }).key,
    errorState({ response: { status: 500 } }).key,
    errorState({ message: "fetch failed" }).key
  ]);
  for (const key of produced) {
    assert.ok(noticeKeys.has(key), `a notice exists for "${key}"`);
  }
  assert.equal(noticeKeys.has("not_connected"), true, "the not-connected state is one the browser can spell");
  assert.match(browser, /role="dialog"/);
  assert.match(browser, /aria-modal/);
  assert.match(browser, /ReactMarkdown/, "README files are rendered, not dumped");
  assert.match(browser, / rehypeHighlight/, "code blocks are highlighted");
  assert.match(browser, /GitHub is not connected/, "the public-only state says what it can still do");
});

test("the browser stylesheet is token-only", () => {
  const css = readFileSync(path.join(srcDir, "github", "GitHubRepoBrowser.css"), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no raw colour literal outside tokens.css");
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /!important/);
  for (const required of ["vr-ghb__crumbs", "vr-ghb__notice", "vr-ghb__readme", "vr-ghb__branches", "vr-ghb__confirm"]) {
    assert.ok(css.includes(required), `.${required} is defined`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-theme="light"\]/);
});
