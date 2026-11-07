// The status the Rust side reports about the app's own folder. Windows names
// the Documents location, so nothing here may guess at it: every string shown
// comes from the response, and a value the app has never seen is reported as
// unknown rather than rounded to something reassuring.

const KNOWN_STATES = new Set(["folder", "link", "file", "missing"]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function rowsFrom(subdirs) {
  if (!Array.isArray(subdirs)) return [];
  return subdirs.map((entry) => ({
    name: text(entry?.name),
    state: KNOWN_STATES.has(entry?.kind) ? entry.kind : "unknown",
    path: text(entry?.path),
  }));
}

function describeCounts(version, rows, migrations) {
  const ready = rows.filter((row) => row.state === "folder").length;
  const parts = [`Layout version ${version ?? "unknown"}`, `${ready} of ${rows.length} folders ready`];
  if (migrations === 1) parts.push("migrated once");
  else if (migrations > 1) parts.push(`migrated ${migrations} times`);
  return parts.join(" · ");
}

export function storageView(status) {
  const source = status && typeof status === "object" ? status : {};
  const rows = rowsFrom(source.subdirs);
  const blocked = rows.filter((row) => row.state !== "folder");
  const present = source.present === true;
  const lastError = text(source.lastError);
  const migrations = Number.isFinite(source.migrationCount) ? source.migrationCount : 0;

  let tone = "warn";
  let label = "Needs a check";
  let error = "";

  if (source.status === "failed" || (lastError && !present)) {
    tone = "error";
    label = "Setup failed";
    error = lastError || "Windows could not report a Documents folder for this user.";
  } else if (!present) {
    tone = "warn";
    label = "Not set up";
    error = "The VupsRouter folder does not exist yet. Re-checking creates it.";
  } else if (blocked.length > 0) {
    tone = "warn";
    label = "Partly set up";
    error = `Not a usable folder: ${blocked
      .map((row) => `${row.name || "an unnamed entry"} (${row.state})`)
      .join(", ")}.`;
  } else if (source.status === "ready") {
    tone = "ok";
    label = "Ready";
    error = lastError;
  } else {
    error = lastError;
  }

  return {
    tone,
    label,
    path: text(source.rootPath) || text(source.documentsPath),
    documentsPath: text(source.documentsPath),
    otherLayout: text(source.previousRootPath),
    rows,
    detail: describeCounts(source.layoutVersion, rows, migrations),
    error,
    canOpen: present,
    logs: Array.isArray(source.recentLogLines) ? source.recentLogLines.map(text) : [],
    note: text(source.note),
    initialized: source.initialized === true,
  };
}
