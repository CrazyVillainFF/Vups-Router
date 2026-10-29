// Everything the plugin screens say is derived here from what the server
// actually exposes for that plugin: its tool list, its auth definition, and its
// declared permissions. Nothing in this file assumes that two plugins do the
// same things.

// The four GitHub actions the product names explicitly. Every other tool falls
// back to its own server-authored description.
const TOOL_LABELS = Object.freeze({
  search_repositories: "Find repositories",
  repository: "View repository details",
  list_issues: "View issues",
  create_issue: "Create an issue"
});

const FIELD_LABELS = Object.freeze({
  owner: "Repository owner",
  repo: "Repository name",
  title: "Issue title",
  body: "Issue description",
  query: "Search words",
  state: "Which issues",
  limit: "How many results",
  name: "Name",
  namespace: "Namespace",
  tag: "Tag",
  text: "Text to work with",
  targetLang: "Translate into",
  sourceLang: "Translate from"
});

const REQUIRED_TOKEN_FOR = Object.freeze({
  create_issue: true
});

const GITHUB_TOKEN_GUIDANCE =
  "Use a fine-grained token limited to Issues: read and write on the repositories you choose, or a classic token with only the public_repo scope. This app never asks for your password and uses nothing beyond that.";

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
    if (plugin?.availability === "oauth_required") {
      return {
        key: "disconnected",
        label: "Not connected",
        tone: "muted",
        sentence: `${name} signs in with its own account service, which this build does not offer yet. Nothing has been shared with ${name}.`,
        lastSuccessAt: null,
        lastAttempt: null
      };
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

  if (plugin?.availability === "in_development" || plugin?.availability === "oauth_required") {
    return {
      key: "unavailable",
      headline: "Nothing to connect yet",
      sentence:
        plugin?.availability === "oauth_required"
          ? `${name} needs a sign-in app configured on the server. Until that exists, no connection is offered and no permissions are requested.`
          : `${name} is listed for transparency. There is no working connection to set up in this version.`,
      requiresCredentials: false,
      worksWithout: [],
      needsTokenFor: [],
      minimumAccess: "",
      guidanceUrl: ""
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
      headline: "A token is optional",
      sentence: readLabels.length
        ? `${readLabels.length} read-only ${readLabels.length === 1 ? "action works" : "actions work"} without a token.${changeLabels.length ? ` ${changeLabels.join(" and ")} needs one so the change is made as you.` : ""}`
        : `A token is optional for ${name}.`,
      requiresCredentials: false,
      worksWithout: readLabels,
      needsTokenFor: changeLabels,
      minimumAccess: plugin?.id === "github" ? GITHUB_TOKEN_GUIDANCE : "",
      guidanceUrl: plugin?.id === "github" ? "https://github.com/settings/tokens" : "",
      guidanceLabel: "Create a token"
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
    headline: "Sign-in is not available yet",
    sentence: `${name} uses an account sign-in that this build does not offer. No permission is requested and no data is shared.`,
    requiresCredentials: false,
    worksWithout: [],
    needsTokenFor: [],
    minimumAccess: "",
    guidanceUrl: ""
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
