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
