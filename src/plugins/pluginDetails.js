// Everything the plugin screens say is derived here from what the server
// actually exposes for that plugin: its tool list, its auth definition, and its
// declared permissions. Nothing in this file assumes that two plugins do the
// same things.

// The GitHub actions the product names explicitly. Every other tool falls
// back to its own server-authored description.
const TOOL_LABELS = Object.freeze({
  search_repositories: "Find repositories",
  list_repositories: "List your repositories",
  repository: "View repository details",
  list_files: "List folder contents",
  read_file: "Read a file",
  list_branches: "List branches",
  list_commits: "Read commit history",
  compare_refs: "Compare two branches",
  search_code: "Search code",
  list_issues: "View issues",
  create_issue: "Create an issue",
  list_pull_requests: "View pull requests",
  read_pull_request: "Read a pull request with its diff",
  create_branch: "Create a branch",
  write_file: "Write a file to a branch",
  delete_file: "Delete a file from a branch",
  create_pull_request: "Open a pull request"
});

const FIELD_LABELS = Object.freeze({
  owner: "Repository owner",
  repo: "Repository name",
  path: "Path inside the repository",
  branch: "Branch",
  from: "Starting branch, tag, or commit",
  base: "Base branch",
  head: "Branch with your changes",
  message: "Commit message",
  content: "File contents",
  number: "Number",
  draft: "Draft",
  title: "Issue title",
  body: "Issue description",
  query: "Search words",
  state: "Which items",
  page: "Page",
  perPage: "Items per page",
  limit: "How many results",
  allowDefaultBranch: "Allow the default branch",
  name: "Name",
  namespace: "Namespace",
  tag: "Tag",
  text: "Text to work with",
  targetLang: "Translate into",
  sourceLang: "Translate from"
});

const REQUIRED_TOKEN_FOR = Object.freeze({
  create_issue: true,
  search_code: true
});

const GITHUB_TOKEN_GUIDANCE =
  "Use a fine-grained token limited to Issues: read and write on the repositories you choose, or a classic token with only the public_repo scope. This app never asks for your password and uses nothing beyond that.";

const GITHUB_SIGNIN_GUIDANCE =
  "GitHub sign-in asks only for the access the server is configured for — normally repo and read:user. That lets this app see your repositories and act as you on the changes you approve. It never receives your password, and revoking the sign-in from GitHub ends the connection here too.";

// The server callback tells the app which connection finished and why it failed.
// Nothing from the provider is echoed here: only these fixed sentences.
const OAUTH_REASON_TEXT = Object.freeze({
  cancelled: "You cancelled the GitHub sign-in, so no connection was made.",
  invalid_state: "That sign-in was not started by this server, so nothing was connected.",
  replayed_state: "That sign-in attempt had already been used, so nothing was connected twice.",
  exchange_failed: "GitHub did not accept the sign-in code, so nothing was connected.",
  not_configured:
    "This server has no GitHub OAuth app configured yet, so sign-in cannot start. A personal access token still works.",
  unsupported_plugin: "That connection does not use a GitHub sign-in.",
  provider_error: "GitHub reported a problem with the sign-in, so nothing was connected.",
  failed: "The GitHub sign-in did not finish, so nothing was connected."
});

export function accountLabel(account) {
  const login = String(account?.login || "").trim();
  if (!login) return "";
  const name = String(account?.name || "").trim();
  return name && name !== login ? `${name} (@${login})` : `@${login}`;
}

// The GitHub card covers two credentials at once: the token row it is built from
// and the sign-in row hanging off it. Everything the UI says about sign-in comes
// from this normalized view of what the server reported. A row that is itself an
// OAuth connection normalizes from its own fields.
export function signInOffer(plugin) {
  if (!plugin) return null;
  const offer = plugin.oauth;
  if (offer?.pluginId) {
    return {
      pluginId: offer.pluginId,
      label: offer.label || "Sign in with the provider",
      configured: Boolean(offer.configured),
      installed: Boolean(offer.installed),
      connection: offer.connection || "disconnected",
      account: offer.account || null,
      scopes: offer.scopes || "",
      // The scope string is public by design — it travels in the authorization
      // URL — so the app can say what the sign-in asks for before it asks.
      offeredScopes: offer.offeredScopes || "",
      lastCheckAt: offer.lastCheckAt || null,
      lastCheckStatus: offer.lastCheckStatus || "",
      lastError: redactSecrets(offer.lastError || "")
    };
  }
  if (plugin.auth?.type !== "oauth" || plugin.availability === "in_development") return null;
  return {
    pluginId: plugin.id,
    label: plugin.auth.label || "Sign in with the provider",
    configured: true,
    installed: Boolean(plugin.installed),
    connection: plugin.connection || "disconnected",
    account: plugin.config?.account || null,
    scopes: plugin.config?.scopes || "",
    offeredScopes: "",
    lastCheckAt: plugin.lastTestAt || null,
    lastCheckStatus: plugin.lastTestStatus || "",
    lastError: redactSecrets(plugin.lastError || plugin.lastTestMessage || "")
  };
}

// Which id a sign-in button starts: this row's own id when it is itself the
// OAuth connection, otherwise the companion that carries it.
export function signInTarget(plugin) {
  return signInOffer(plugin)?.pluginId || "";
}

export function signInStatus(offer) {
  if (!offer?.installed) return null;
  const who = accountLabel(offer.account) || "your GitHub account";
  if (offer.connection === "connected") {
    return { key: "connected", label: "Signed in", tone: "ok", sentence: `GitHub sign-in is active for ${who}.` };
  }
  if (offer.connection === "needs_reconnection" || offer.connection === "error") {
    return {
      key: "problem",
      label: "Sign-in needs attention",
      tone: "warn",
      sentence: offer.lastError
        ? `GitHub rejected the saved sign-in: ${offer.lastError}`
        : `The sign-in for ${who} no longer works. Connect with GitHub again.`
    };
  }
  if (offer.connection === "disabled") {
    return { key: "disabled", label: "Sign-in turned off", tone: "muted", sentence: `The GitHub sign-in for ${who} is turned off.` };
  }
  return {
    key: "disconnected",
    label: "Sign-in not connected",
    tone: "muted",
    sentence: `The GitHub sign-in for ${who} is saved but not connected. Connect with GitHub again.`
  };
}

const OAUTH_CONNECTED_TEXT = "GitHub sign-in is connected. Your repositories are available to the tools you approve.";

// Only the browser hand-off knows which outcome the server reported.
export function oauthOutcomeNotice(search) {
  const params = new URLSearchParams(String(search || ""));
  const outcome = params.get("oauth");
  if (outcome !== "connected" && outcome !== "error") return null;
  if (outcome === "connected") {
    return { tone: "ok", pluginId: params.get("plugin") || "", message: OAUTH_CONNECTED_TEXT };
  }
  const reason = params.get("reason") || "";
  return {
    tone: "error",
    pluginId: params.get("plugin") || "",
    message: OAUTH_REASON_TEXT[reason] || OAUTH_REASON_TEXT.failed
  };
}

// A start failure is either a missing server setting, an expired session, or a
// real backend message. Naming the environment variables is safe; their values
// are never known to this side.
export function oauthStartFailureText(code, message) {
  if (code === "oauth_not_configured") return OAUTH_REASON_TEXT.not_configured;
  if (code === "adapter_not_available") return "This integration has no working adapter yet, so there is nothing to sign in to.";
  return redactSecrets(message || "GitHub sign-in could not start.");
}

export function humanizeKey(key) {
  const spaced = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!spaced) return "Value";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function sentence(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function shorten(text, max = 70) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 30 ? cut.slice(0, boundary) : cut).replace(/[,.;:]$/, "")}…`;
}

export function friendlyActionLabel(tool) {
  if (!tool?.name) return "Action";
  if (TOOL_LABELS[tool.name]) return TOOL_LABELS[tool.name];
  const description = String(tool.description || "").replace(/\s+/g, " ").trim();
  if (!description) return humanizeKey(tool.name);
  // Drop trailing sentences that only repeat the confirmation rule; the UI
  // shows that rule next to the action itself.
  const primary = description.split(/(?<=\.)\s+/)[0].replace(/\.$/, "");
  const label = shorten(primary, 64);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function actionEffect(tool) {
  return tool?.sensitive ? "change" : "read";
}

export function actionFields(tool) {
  const properties = tool?.inputSchema?.properties || {};
  const required = new Set(tool?.inputSchema?.required || []);
  return Object.entries(properties).map(([key, field]) => {
    const type = field?.enum
      ? "select"
      : field?.type === "integer" || field?.type === "number"
        ? "number"
        : /^(body|description|text)$/i.test(key)
          ? "textarea"
          : "text";
    return {
      key,
      label: FIELD_LABELS[key] || humanizeKey(key),
      hint: String(field?.description || "").replace(/\s+/g, " ").trim(),
      type,
      options: Array.isArray(field?.enum) ? field.enum : null,
      required: required.has(key),
      minimum: Number.isFinite(field?.minimum) ? field.minimum : null,
      maximum: Number.isFinite(field?.maximum) ? field.maximum : null,
      placeholder: field?.placeholder || ""
    };
  });
}

export function initialActionValues(tool) {
  const values = {};
  for (const [key, field] of Object.entries(tool?.inputSchema?.properties || {})) {
    if (field?.default !== undefined) values[key] = field.default;
    else if (field?.enum?.length) values[key] = field.enum[0];
    else if (field?.type === "integer" || field?.type === "number") values[key] = "";
    else values[key] = "";
  }
  return values;
}

// The advanced console starts from a runnable example rather than an empty
// object, so a debugging round trip does not begin with a validation error.
export function exampleDebugArgs(tool) {
  const values = {};
  for (const [key, field] of Object.entries(tool?.inputSchema?.properties || {})) {
    if (field?.default !== undefined) values[key] = field.default;
    else if (field?.enum?.length) values[key] = field.enum[0];
    else if (field?.type === "integer" || field?.type === "number") values[key] = field.minimum ?? 1;
    else if (field?.type === "boolean") values[key] = false;
    else if (field?.type === "array") values[key] = [];
    else if (field?.type === "object") values[key] = {};
    else values[key] = "";
  }
  return values;
}

export function validateActionValues(fields, values) {
  for (const field of fields || []) {
    const raw = values?.[field.key];
    const empty = raw === undefined || raw === null || String(raw).trim() === "";
    if (field.required && empty) return `${field.label} is needed.`;
    if (empty) continue;
    if (field.type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) return `${field.label} must be a number.`;
      if (field.minimum !== null && number < field.minimum) return `${field.label} must be at least ${field.minimum}.`;
      if (field.maximum !== null && number > field.maximum) return `${field.label} must be ${field.maximum} or less.`;
    }
  }
  return "";
}

// The request body is built from the fields the schema declares, so an extra
// key typed into the advanced console can never reach the provider through a
// friendly form.
export function buildActionArgs(fields, values) {
  const args = {};
  for (const field of fields || []) {
    const raw = values?.[field.key];
    if (raw === undefined || raw === null) continue;
    if (String(raw).trim() === "") continue;
    args[field.key] = field.type === "number" ? Number(raw) : raw;
  }
  return args;
}

function schemaFieldSummary(tool) {
  const fields = actionFields(tool);
  if (!fields.length) return "";
  return fields.map(field => field.label.toLowerCase()).join(", ");
}

export function describeAction(tool) {
  const changes = actionEffect(tool) === "change";
  const inputs = schemaFieldSummary(tool);
  return {
    name: tool?.name || "",
    label: friendlyActionLabel(tool),
    what: sentence(tool?.description),
    inputs,
    changes,
    confirmation: changes ? "You approve this first" : "Not needed",
    effectLine: changes
      ? `Changes ${inputs || "data on the provider"} and sends what you fill in.`
      : `Reads ${inputs || "public data"} and changes nothing.`
  };
}

export function pluginActions(plugin) {
  const tools = Array.isArray(plugin?.tools) ? plugin.tools : [];
  return tools.map(tool => {
    const action = describeAction(tool);
    return {
      ...action,
      needsToken: Boolean(REQUIRED_TOKEN_FOR[tool.name]) || (action.changes && plugin?.auth?.type === "optional_api_key")
    };
  });
}

export function capabilityGroups(plugin) {
  const actions = pluginActions(plugin);
  return {
    reads: actions.filter(action => !action.changes),
    changes: actions.filter(action => action.changes),
    actions
  };
}

export function connectionStatus(plugin) {
  const name = plugin?.name || "This plugin";
  const groups = capabilityGroups(plugin);
  const readCount = groups.reads.length;
  const changeCount = groups.changes.length;
  const authType = plugin?.auth?.type || "none";

  if (!plugin?.installed) {
    if (plugin?.availability === "in_development") {
      return {
        key: "unavailable",
        label: "Not available yet",
        tone: "muted",
        sentence: `${name} is listed so the catalog is honest about what is planned. It has no working connection in this version, so nothing is sent anywhere.`,
        lastSuccessAt: null,
        lastAttempt: null
      };
    }
    // A card can be connected through its sign-in row while its own token row is
    // empty, which is a real connection and must not read as "Not connected".
    const signIn = signInStatus(signInOffer(plugin));
    if (!signIn && plugin?.availability === "oauth_required") {
      return {
        key: "disconnected",
        label: "Not connected",
        tone: "muted",
        sentence: `${name} connects by signing in with the provider. Until you do, nothing has been shared with ${name}.`,
        lastSuccessAt: null,
        lastAttempt: null
      };
    }
    if (signIn) {
      return { ...signIn, lastSuccessAt: null, lastAttempt: signInOffer(plugin).lastCheckAt };
    }
    const sentence =
      authType === "optional_api_key"
        ? `${name} is not connected. Its ${readCount} read-only ${readCount === 1 ? "action works" : "actions work"} without signing in${changeCount ? `; creating an issue needs your access token` : ""}.`
        : authType === "none"
          ? `${name} is not connected yet. It needs no account, so connecting only turns on the public actions below.`
          : `${name} needs its key before any of its actions can run.`;
    return { key: "disconnected", label: "Not connected", tone: "muted", sentence, lastSuccessAt: null, lastAttempt: null };
  }

  const connection = plugin.connection;
  const lastSuccessAt = plugin.lastTestStatus === "connected" ? plugin.lastTestAt || null : null;
  const lastAttempt = plugin.lastTestAt || null;
  const lastCheckFailed = plugin.lastTestStatus === "failed";

  if (connection === "connected" && !lastCheckFailed) {
    return {
      key: "connected",
      label: "Connected",
      tone: "ok",
      sentence: lastSuccessAt
        ? `${name} answered its most recent connection check.`
        : `${name} was verified when you saved this connection.`,
      lastSuccessAt,
      lastAttempt
    };
  }
  if (connection === "needs_reconnection" || connection === "error" || lastCheckFailed) {
    const detail = redactSecrets(plugin.lastTestMessage || plugin.lastError || "");
    return {
      key: "problem",
      label: "Connection problem",
      tone: "warn",
      sentence: detail
        ? `The last check did not succeed: ${sentence(detail)}`
        : `The last check did not succeed. Test the connection to see the current error.`,
      lastSuccessAt,
      lastAttempt
    };
  }
  if (connection === "disabled") {
    return {
      key: "disabled",
      label: "Turned off",
      tone: "muted",
      sentence: `${name} is installed but turned off, so the assistant cannot call its actions.`,
      lastSuccessAt,
      lastAttempt
    };
  }
  return {
    key: "disconnected",
    label: "Not connected",
    tone: "muted",
    sentence: `${name} is installed but not connected. Test the connection or update its credentials.`,
    lastSuccessAt,
    lastAttempt
  };
}

export function setupGuidance(plugin) {
  const name = plugin?.name || "this plugin";
  const groups = capabilityGroups(plugin);
  const authType = plugin?.auth?.type || "none";
  const readLabels = groups.reads.map(action => action.label);
  const changeLabels = groups.changes.map(action => action.label);
  const signIn = signInOffer(plugin);
  const oauthScopes = signIn?.offeredScopes || plugin?.config?.scopes || "";

  if (plugin?.availability === "in_development") {
    return {
      key: "unavailable",
      headline: "Nothing to connect yet",
      sentence: `${name} is listed for transparency. There is no working connection to set up in this version.`,
      requiresCredentials: false,
      worksWithout: [],
      needsTokenFor: [],
      minimumAccess: "",
      guidanceUrl: ""
    };
  }

  if (authType === "oauth") {
    return {
      key: "oauth",
      headline: "Sign in with the provider",
      sentence: `${name} connects when you authorize on the provider's own site. This app never sees your password, and no permission is requested until you press Connect.`,
      requiresCredentials: false,
      worksWithout: [],
      needsTokenFor: changeLabels,
      minimumAccess: oauthScopes ? `This sign-in asks for: ${oauthScopes}.` : GITHUB_SIGNIN_GUIDANCE,
      guidanceUrl: "",
      signIn
    };
  }

  if (authType === "none") {
    return {
      key: "none",
      headline: "No account needed",
      sentence: `This integration reads public data. Connecting only records that you turned it on; no account, key, or personal data is requested.`,
      requiresCredentials: false,
      worksWithout: readLabels,
      needsTokenFor: changeLabels,
      minimumAccess: "",
      guidanceUrl: plugin?.website || ""
    };
  }

  if (authType === "optional_api_key") {
    return {
      key: "optional",
      headline: signIn ? "Two ways to connect" : "A token is optional",
      sentence: signIn
        ? `Signing in with GitHub is the fuller option: it reads the repositories your account can see. A personal access token is the narrower option and keeps working on its own — you can use either, or both.`
        : readLabels.length
          ? `${readLabels.length} read-only ${readLabels.length === 1 ? "action works" : "actions work"} without a token.${changeLabels.length ? ` ${changeLabels.join(" and ")} needs one so the change is made as you.` : ""}`
          : `A token is optional for ${name}.`,
      requiresCredentials: false,
      worksWithout: readLabels,
      needsTokenFor: changeLabels,
      minimumAccess: plugin?.id === "github" ? GITHUB_TOKEN_GUIDANCE : "",
      guidanceUrl: plugin?.id === "github" ? "https://github.com/settings/tokens" : "",
      guidanceLabel: "Create a token",
      signIn
    };
  }

  if (authType === "api_key") {
    const fields = (plugin?.auth?.fields || []).map(field => field.label || humanizeKey(field.key));
    return {
      key: "required",
      headline: "A key is required",
      sentence: `${name} does not offer public access, so none of its actions work until a key is saved. This app sends the key only to ${name}.`,
      requiresCredentials: true,
      worksWithout: [],
      needsTokenFor: groups.actions.map(action => action.label),
      fields,
      minimumAccess:
        "Create a key for this app alone, with the narrowest access the actions above need. Rotate it if it is ever exposed.",
      guidanceUrl: plugin?.website || "",
      guidanceLabel: plugin?.website ? "Open the provider site" : ""
    };
  }

  return {
    key: "oauth",
    headline: "Sign in with the provider",
    sentence: `${name} connects through its own account sign-in. No permission is requested until you press Connect.`,
    requiresCredentials: false,
    worksWithout: [],
    needsTokenFor: changeLabels,
    minimumAccess: oauthScopes ? `This sign-in asks for: ${oauthScopes}.` : "",
    guidanceUrl: "",
    signIn
  };
}

export function formatPluginDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
}

const REDACTED = "[redacted]";

const REDACTION_PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED],
  [/\b(Bearer|Token|Basic|DeepL-Auth-Key)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/([?&](?:access_key|api_key|apikey|client_id|client_secret|key|token)=)[^&\s"']+/gi, `$1${REDACTED}`],
  [
    /((?:"|')?(?:api_?key|access_?token|refresh_?token|token|secret|password)(?:"|')?\s*[:=]\s*(?:"|')?)[^"',\s}]{6,}/gi,
    `$1${REDACTED}`
  ]
];

// The server redacts too; this keeps a stale backend or a future provider error
// from putting a token on screen.
export function redactSecrets(text) {
  let output = String(text ?? "");
  if (!output) return output;
  for (const [pattern, replacement] of REDACTION_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}
