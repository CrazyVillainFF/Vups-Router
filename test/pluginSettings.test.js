import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const details = await import(pathToFileURL(path.join(root, "src", "plugins", "pluginDetails.js")).href);
const source = readFileSync(path.join(root, "src", "plugins", "pluginDetails.js"), "utf8").replace(/\r\n/g, "\n");

const github = {
  id: "github",
  name: "GitHub",
  category: "developer",
  description: "Search repositories, inspect issues, and create issues with an optional token.",
  auth: {
    type: "optional_api_key",
    label: "Optional access token",
    fields: [{ key: "token", label: "Access token (optional)", type: "password", required: false, secret: true }]
  },
  website: "https://github.com",
  permissions: ["Read public repositories and issues", "Create issues only when you explicitly confirm"],
  tools: [
    {
      name: "search_repositories",
      description: "Search GitHub repositories.",
      sensitive: false,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Repository search query." },
          limit: { type: "integer", description: "Number of results (1-10).", minimum: 1, maximum: 10 }
        },
        required: ["query"]
      }
    },
    {
      name: "repository",
      description: "Read metadata for one GitHub repository.",
      sensitive: false,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." }
        },
        required: ["owner", "repo"]
      }
    },
    {
      name: "list_issues",
      description: "List issues in a GitHub repository. Pull requests are excluded.",
      sensitive: false,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." },
          state: { type: "string", description: "Issue state: open, closed, or all.", enum: ["open", "closed", "all"] },
          limit: { type: "integer", description: "Number of issues (1-20).", minimum: 1, maximum: 20 }
        },
        required: ["owner", "repo"]
      }
    },
    {
      name: "create_issue",
      description: "Create an issue in a GitHub repository. Requires an access token and explicit confirmation.",
      sensitive: true,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner." },
          repo: { type: "string", description: "Repository name." },
          title: { type: "string", description: "Issue title." },
          body: { type: "string", description: "Issue body." }
        },
        required: ["owner", "repo", "title"]
      }
    }
  ],
  installed: false,
  connection: "disconnected",
  lastTestAt: null,
  lastTestStatus: "",
  lastTestMessage: "",
  lastError: ""
};

const npm = {
  ...github,
  id: "npm",
  name: "npm Registry",
  auth: { type: "none", label: "No credentials required", fields: [] },
  tools: [
    { name: "search", description: "Search the npm registry for packages.", sensitive: false, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "package", description: "Read metadata for an npm package.", sensitive: false, inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }
  ]
};

test("friendly labels replace the four technical tool names", () => {
  const labels = details.pluginActions(github).map(action => action.label);
  assert.deepEqual(labels, ["Find repositories", "View repository details", "View issues", "Create an issue"]);
  for (const action of details.pluginActions(github)) {
    assert.notEqual(action.label, action.name);
  }
});

test("other plugins get labels from their own descriptions, not GitHub's actions", () => {
  const labels = details.pluginActions(npm).map(action => action.label);
  assert.deepEqual(labels, ["Search the npm registry for packages", "Read metadata for an npm package"]);
  assert.ok(!labels.some(label => /issue|repositor/i.test(label)));
});

test("read access and write access are separate groups", () => {
  const groups = details.capabilityGroups(github);
  assert.equal(groups.reads.length, 3);
  assert.equal(groups.changes.length, 1);
  assert.equal(groups.changes[0].name, "create_issue");
  assert.equal(groups.changes[0].confirmation, "You approve this first");
  assert.ok(groups.reads.every(action => action.confirmation === "Not needed"));
  assert.equal(details.capabilityGroups(npm).changes.length, 0);
});

test("a write action is the only one that needs the optional token", () => {
  const actions = details.pluginActions(github);
  assert.equal(actions.find(action => action.name === "create_issue").needsToken, true);
  assert.equal(actions.find(action => action.name === "search_repositories").needsToken, false);
});

test("each action says what it does, what it touches and whether it changes data", () => {
  const create = details.pluginActions(github).find(action => action.name === "create_issue");
  assert.match(create.what, /Create an issue in a GitHub repository\./);
  assert.match(create.inputs, /repository owner/);
  assert.equal(create.changes, true);
  assert.match(create.effectLine, /^Changes /);

  const search = details.pluginActions(github).find(action => action.name === "search_repositories");
  assert.equal(search.changes, false);
  assert.match(search.effectLine, /changes nothing/);
});

test("connection copy follows the real status, not the presence of credentials", () => {
  const disconnected = details.connectionStatus(github);
  assert.equal(disconnected.label, "Not connected");
  assert.match(disconnected.sentence, /read-only/);

  const connected = details.connectionStatus({
    ...github,
    installed: true,
    connection: "connected",
    lastTestAt: "2026-10-29T10:00:00.000Z",
    lastTestStatus: "connected"
  });
  assert.equal(connected.label, "Connected");
  assert.match(connected.sentence, /answered its most recent connection check/);
  assert.ok(connected.lastSuccessAt);

  // A stored installation whose last check failed is not reported as connected.
  const failed = details.connectionStatus({
    ...github,
    installed: true,
    connection: "connected",
    lastTestAt: "2026-10-29T10:00:00.000Z",
    lastTestStatus: "failed",
    lastTestMessage: "Bad credentials: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    credentialsConfigured: { token: true }
  });
  assert.equal(failed.label, "Connection problem");
  assert.ok(!failed.sentence.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(failed.sentence, /\[redacted\]/);
});

test("connection problem copy uses the redacted provider message", () => {
  const status = details.connectionStatus({
    ...github,
    installed: true,
    connection: "needs_reconnection",
    lastTestAt: "2026-10-29T10:00:00.000Z",
    lastTestStatus: "failed",
    lastError: "Request failed: Authorization: Bearer abcdefgh12345678"
  });
  assert.equal(status.tone, "warn");
  assert.ok(!status.sentence.includes("abcdefgh12345678"));
  assert.match(status.sentence, /Bearer \[redacted\]/);
});

test("an unfinished adapter is never described as connectable", () => {
  const status = details.connectionStatus({ ...github, availability: "in_development", tools: [] });
  assert.equal(status.label, "Not available yet");
  const guidance = details.setupGuidance({ ...github, availability: "in_development", tools: [] });
  assert.equal(guidance.headline, "Nothing to connect yet");
  assert.equal(guidance.requiresCredentials, false);
});

test("GitHub setup explains the optional token and the narrowest scope", () => {
  const guidance = details.setupGuidance(github);
  assert.equal(guidance.headline, "A token is optional");
  assert.equal(guidance.requiresCredentials, false);
  assert.deepEqual(guidance.worksWithout, ["Find repositories", "View repository details", "View issues"]);
  assert.deepEqual(guidance.needsTokenFor, ["Create an issue"]);
  assert.match(guidance.minimumAccess, /Issues: read and write/);
  assert.match(guidance.minimumAccess, /public_repo/);
  assert.match(guidance.guidanceUrl, /github\.com\/settings\/tokens/);
});

test("a key-only plugin is not told that it works without credentials", () => {
  const guidance = details.setupGuidance({
    ...github,
    id: "unsplash",
    name: "Unsplash",
    auth: { type: "api_key", label: "Unsplash access key", fields: [{ key: "accessKey", label: "Access key", type: "password", required: true, secret: true }] }
  });
  assert.equal(guidance.headline, "A key is required");
  assert.equal(guidance.requiresCredentials, true);
  assert.deepEqual(guidance.worksWithout, []);
  assert.deepEqual(guidance.fields, ["Access key"]);
});

test("the request body only carries declared fields", () => {
  const fields = details.actionFields(github.tools[3]);
  const args = details.buildActionArgs(fields, {
    owner: "acme",
    repo: "widgets",
    title: "Printer jams",
    body: "",
    injected: "not allowed"
  });
  assert.deepEqual(args, { owner: "acme", repo: "widgets", title: "Printer jams" });

  const searchFields = details.actionFields(github.tools[0]);
  assert.deepEqual(details.buildActionArgs(searchFields, { query: "vite", limit: "5" }), { query: "vite", limit: 5 });
});

test("form validation names the missing or invalid field", () => {
  const fields = details.actionFields(github.tools[3]);
  assert.equal(details.validateActionValues(fields, { owner: "", repo: "x", title: "y" }), "Repository owner is needed.");
  assert.equal(details.validateActionValues(fields, { owner: "a", repo: "b", title: "c" }), "");

  const searchFields = details.actionFields(github.tools[0]);
  assert.equal(details.validateActionValues(searchFields, { query: "a", limit: "50" }), "How many results must be 10 or less.");
  assert.equal(details.validateActionValues(searchFields, { query: "a", limit: "2" }), "");
});

test("client redaction catches tokens in any displayed message", () => {
  assert.equal(
    details.redactSecrets("failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    "failed with [redacted]"
  );
  assert.equal(details.redactSecrets("token=abcdef123456 rejected"), "token=[redacted] rejected");
  assert.equal(details.redactSecrets(""), "");
});

test("every default label differs from the technical tool name", () => {
  assert.ok(github.tools.every(tool => details.friendlyActionLabel(tool) !== tool.name));
  assert.ok(npm.tools.every(tool => details.friendlyActionLabel(tool) !== tool.name));
});

const offeredSignIn = {
  pluginId: "github-oauth",
  label: "Connect with GitHub",
  configured: true,
  installed: false,
  connection: "disconnected",
  account: null,
  scopes: "",
  offeredScopes: "repo read:user",
  lastCheckAt: null,
  lastCheckStatus: "",
  lastError: ""
};

const patOnly = { ...github, installed: false };

test("the GitHub card carries a sign-in option beside its token option", () => {
  const offer = details.signInOffer({ ...patOnly, oauth: offeredSignIn });
  assert.equal(offer.pluginId, "github-oauth");
  assert.equal(offer.configured, true);
  assert.equal(offer.installed, false);
  assert.equal(offer.offeredScopes, "repo read:user");
  assert.equal(details.signInTarget({ ...patOnly, oauth: offeredSignIn }), "github-oauth");

  // A card with no companion row and no OAuth definition offers no sign-in.
  assert.equal(details.signInOffer(patOnly), null);
  assert.equal(details.signInTarget(patOnly), "");
  assert.equal(details.signInOffer(npm), null);
});

test("a row that is itself an OAuth connection normalizes from its own fields", () => {
  const bare = {
    ...github,
    id: "github-oauth",
    availability: "oauth_required",
    auth: { type: "oauth", label: "Connect with GitHub", fields: [] },
    installed: true,
    connection: "connected",
    config: { account: { login: "octocat", name: "The Octocat" }, scopes: "repo read:user" }
  };
  const offer = details.signInOffer(bare);
  assert.equal(offer.pluginId, "github-oauth");
  assert.equal(offer.installed, true);
  assert.equal(offer.scopes, "repo read:user");
  assert.equal(details.accountLabel(offer.account), "The Octocat (@octocat)");
  assert.equal(details.signInTarget(bare), "github-oauth");

  // An unfinished adapter never presents a sign-in as available.
  assert.equal(details.signInOffer({ ...bare, availability: "in_development" }), null);
});

test("account labels use the login, and a login equal to the name is not repeated", () => {
  assert.equal(details.accountLabel({ login: "octocat", name: "The Octocat" }), "The Octocat (@octocat)");
  assert.equal(details.accountLabel({ login: "octocat", name: "octocat" }), "@octocat");
  assert.equal(details.accountLabel({ login: "octocat" }), "@octocat");
  assert.equal(details.accountLabel({ name: "The Octocat" }), "");
  assert.equal(details.accountLabel(null), "");
});

test("a live sign-in is a real connection even when the token row is empty", () => {
  const signedIn = {
    ...patOnly,
    oauth: {
      ...offeredSignIn,
      installed: true,
      connection: "connected",
      account: { login: "octocat", name: "The Octocat" },
      scopes: "repo read:user",
      lastCheckAt: "2026-11-03T09:00:00.000Z",
      lastCheckStatus: "connected"
    }
  };
  const status = details.connectionStatus(signedIn);
  assert.equal(status.key, "connected");
  assert.equal(status.label, "Signed in");
  assert.match(status.sentence, /GitHub sign-in is active for The Octocat \(@octocat\)\./);

  // A sign-in the provider no longer accepts cannot read as an active one.
  const broken = {
    ...signedIn,
    oauth: {
      ...signedIn.oauth,
      connection: "needs_reconnection",
      lastCheckStatus: "failed",
      lastError: "GitHub rejected the stored sign-in: ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    }
  };
  const brokenStatus = details.connectionStatus(broken);
  assert.equal(brokenStatus.label, "Sign-in needs attention");
  assert.equal(brokenStatus.tone, "warn");
  assert.ok(!brokenStatus.sentence.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.match(brokenStatus.sentence, /\[redacted\]/);
  assert.doesNotMatch(brokenStatus.sentence, /is active/);

  // With neither credential present, the card still says it is not connected.
  assert.equal(details.connectionStatus(patOnly).label, "Not connected");
  assert.equal(details.connectionStatus({ ...patOnly, availability: "oauth_required" }).label, "Not connected");
});

test("GitHub setup names both connection options instead of hiding OAuth", () => {
  const guidance = details.setupGuidance({ ...patOnly, oauth: offeredSignIn });
  assert.equal(guidance.headline, "Two ways to connect");
  assert.match(guidance.sentence, /Signing in with GitHub/);
  assert.match(guidance.sentence, /personal access token/);
  assert.match(guidance.sentence, /either, or both/);
  assert.ok(guidance.signIn);
  assert.doesNotMatch(`${guidance.headline} ${guidance.sentence}`, /not available|not offered yet|no sign-in/i);

  // The token wording is untouched for a card with no sign-in beside it.
  assert.equal(details.setupGuidance(patOnly).headline, "A token is optional");
});

test("the scopes a sign-in will request come from server data, not invented text", () => {
  // A token row keeps its own narrowest-scope advice beside the sign-in option.
  const both = details.setupGuidance({ ...patOnly, oauth: offeredSignIn });
  assert.match(both.minimumAccess, /Issues: read and write/);
  assert.equal(both.signIn.offeredScopes, "repo read:user");

  // An OAuth-only row states the scope string the server actually offers.
  const bare = {
    ...github,
    id: "github-oauth",
    auth: { type: "oauth", label: "Connect with GitHub", fields: [] },
    availability: "oauth_required",
    installed: false,
    config: { scopes: "repo read:user" }
  };
  assert.equal(details.setupGuidance(bare).headline, "Sign in with the provider");
  assert.match(details.setupGuidance(bare).minimumAccess, /^This sign-in asks for: repo read:user\.$/);

  // With no scope string from the server it falls back to the general promise,
  // never to a claim that sign-in is unavailable.
  const scopeless = { ...bare, config: {}, oauth: undefined };
  assert.match(details.setupGuidance(scopeless).minimumAccess, /never receives your password/);
  assert.doesNotMatch(JSON.stringify(details.setupGuidance(scopeless)), /not available|not offered/i);
});

test("the landing query is read as fixed sentences and never echoed back", () => {
  assert.equal(details.oauthOutcomeNotice(""), null);
  assert.equal(details.oauthOutcomeNotice("?oauth=maybe"), null);
  assert.equal(details.oauthOutcomeNotice("?code=ghp_abcdefgh12345678"), null);

  const good = details.oauthOutcomeNotice("plugin=github&oauth=connected");
  assert.equal(good.tone, "ok");
  assert.equal(good.pluginId, "github");
  assert.match(good.message, /GitHub sign-in is connected/);

  for (const [reason, expected] of [
    ["cancelled", /You cancelled the GitHub sign-in/],
    ["invalid_state", /not started by this server/],
    ["replayed_state", /already been used/],
    ["exchange_failed", /did not accept the sign-in code/],
    ["not_configured", /no GitHub OAuth app configured/],
    ["unsupported_plugin", /does not use a GitHub sign-in/],
    ["provider_error", /GitHub reported a problem/]
  ]) {
    const outcome = details.oauthOutcomeNotice(`plugin=github&oauth=error&reason=${reason}`);
    assert.equal(outcome.tone, "error", reason);
    assert.match(outcome.message, expected, reason);
  }

  // An unrecognized reason says nothing more than that it did not finish.
  const unknown = details.oauthOutcomeNotice("plugin=github&oauth=error&reason=Something from GitHub");
  assert.match(unknown.message, /did not finish, so nothing was connected/);
  assert.ok(!unknown.message.includes("Something from GitHub"));
});

test("a failed sign-in start explains the real cause and keeps the token path", () => {
  assert.match(details.oauthStartFailureText("oauth_not_configured", "x"), /personal access token still works/);
  assert.match(details.oauthStartFailureText("adapter_not_available", "x"), /no working adapter/);
  assert.equal(details.oauthStartFailureText("", ""), "GitHub sign-in could not start.");
  assert.equal(
    details.oauthStartFailureText("", "rejected ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    "rejected [redacted]"
  );
  // The variable names are safe to print; nothing here can leak a value.
  assert.doesNotMatch(details.oauthStartFailureText("oauth_not_configured", "x"), /CLIENT_SECRET|Bearer/);
});
