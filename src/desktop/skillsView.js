// What the Skills screen is allowed to say. Every string here is a projection of
// a field the Rust engine returned: a package the engine called invalid is never
// rendered as working, a count it never scanned is never written as zero, and the
// folder it resolved is shown as it was given, because this layer has no way to
// know where Windows put it.

const KNOWN_STATES = new Set(["ready", "disabled", "invalid", "conflict"]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim());
}

function count(value) {
  return Number.isFinite(value) ? value : null;
}

function plural(value, word) {
  return `${value} ${word}${value === 1 ? "" : "s"}`;
}

function describeIntegrity(value) {
  const integrity = text(value).trim();
  if (integrity === "verified") return "Verified against the digests this package declares";
  if (integrity === "not declared") return "This package declares no digests, so none were checked";
  if (integrity === "not checked") return "Not checked: the package was rejected before reading its files";
  return integrity ? `The engine reported integrity as ${integrity}` : "";
}

function stateOf(record) {
  const status = text(record?.status).trim() || "unknown";
  if (status !== "ready") return KNOWN_STATES.has(status) ? status : "unknown";
  return record?.enabled === false ? "disabled" : "ready";
}

function rowFrom(record) {
  const source = record && typeof record === "object" ? record : {};
  const status = text(source.status).trim() || "unknown";
  const state = stateOf(source);
  return {
    id: text(source.id),
    name: text(source.name) || text(source.id) || "An unnamed package",
    version: text(source.version),
    description: text(source.description),
    author: text(source.author),
    path: text(source.path),
    status,
    enabled: source.enabled === true,
    state,
    usable: status === "ready" && source.enabled !== false,
    permissions: list(source.permissions),
    capabilities: list(source.capabilities),
    references: list(source.references),
    instructionsPath: text(source.instructionsPath),
    bytes: Number.isFinite(source.bytes) ? source.bytes : 0,
    integrity: text(source.integrity),
    integrityLabel: describeIntegrity(source.integrity),
    errorCode: text(source.errorCode),
    errors: list(source.errors),
    installedAt: Number.isFinite(source.installedAt) ? source.installedAt : null,
    sourceKind: text(source.sourceKind)
  };
}

function summarize(summary) {
  const source = summary && typeof summary === "object" ? summary : null;
  if (!source) return null;
  const folders = count(source.folders);
  const note = text(source.note).trim();
  const body = [
    folders === null ? "folder count unread" : plural(folders, "folder"),
    `${count(source.ready) ?? "?"} usable`,
    `${count(source.invalid) ?? "?"} rejected`,
    `${count(source.disabled) ?? "?"} switched off`
  ].join(" · ");
  return {
    counts: {
      folders: count(source.folders),
      ready: count(source.ready),
      invalid: count(source.invalid),
      disabled: count(source.disabled)
    },
    body,
    line: `${body}${note ? ` — ${note}` : ""}`,
    at: count(source.at)
  };
}

export function skillsView(status) {
  const source = status && typeof status === "object" ? status : {};
  const rows = Array.isArray(source.skills) ? source.skills.map(rowFrom) : [];
  const usable = rows.filter(row => row.usable);
  const disabled = rows.filter(row => row.state === "disabled");
  const invalid = rows.filter(row => row.state === "invalid");
  const conflict = rows.filter(row => row.state === "conflict");
  const scan = summarize(source.scan);
  const lastScan = summarize(source.lastScan);
  const rootPath = text(source.rootPath);
  const corrupted = source.stateCorrupted === true;
  const action = source.action && typeof source.action === "object" ? source.action : null;

  let tone = "ok";
  let label = [
    `${usable.length} usable`,
    disabled.length ? `${disabled.length} switched off` : "",
    invalid.length ? `${invalid.length} rejected` : "",
    conflict.length ? `${conflict.length} conflicting` : ""
  ].filter(Boolean).join(" · ");
  let error = "";

  if (!rootPath) {
    tone = "error";
    label = "No Skills folder";
    error = "VupsRouter has not reported a Skills folder for this user yet.";
  } else if (corrupted) {
    tone = "error";
    label = "State needs a check";
    error =
      "VupsRouter could not read its skills state file, so it started a new one. " +
      "A package that was switched off may be switched on again.";
  } else if (rows.length === 0) {
    tone = "empty";
    label = "No skills installed";
  } else if (invalid.length > 0 || conflict.length > 0) {
    tone = "warn";
    error = [
      invalid.length ? `${plural(invalid.length, "package")} could not be used` : "",
      conflict.length ? `${plural(conflict.length, "package")} declare an identifier another package already has` : ""
    ].filter(Boolean).join(", ") + ":";
  } else if (usable.length === 0) {
    tone = "warn";
    error = "Every installed skill is switched off, so the assistant has none it may load.";
  }

  const blocked = [...invalid, ...conflict];
  return {
    tone,
    label,
    rootPath,
    statePath: text(source.statePath),
    manifestVersion: count(source.manifestVersion),
    rows,
    usable,
    disabled,
    invalid,
    conflict,
    blocked,
    counts: scan ? scan.counts : { folders: null, ready: null, invalid: null, disabled: null },
    scanLine: scan ? scan.line : "Not scanned yet — VupsRouter has no counts for this folder.",
    lastScanLine: lastScan ? `Previous scan: ${lastScan.body}` : "",
    detail: `Manifest version ${count(source.manifestVersion) ?? "unknown"} · ${plural(rows.length, "package")} found here`,
    error,
    corrupted,
    note: text(source.note),
    action: action ? text(action.message) : "",
    actionKind: action ? text(action.kind) : "",
    actionSkill: action && action.skill ? rowFrom(action.skill) : null
  };
}
