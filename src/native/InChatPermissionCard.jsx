import { useEffect, useRef } from "react";
import { Check, ShieldCheck, X } from "@phosphor-icons/react";

const ACTION_TEXT = {
  locate: "Find a folder",
  list: "List a folder",
  recent: "List recent files",
  search: "Search a folder",
  metadata: "Read file details",
  read: "List folder contents",
  contents: "Read a file",
  search_contents: "Search inside text files",
  create: "Create a file or folder",
  write: "Write a file",
  append: "Add text to a file",
  edit: "Edit a file",
  rename: "Rename an item",
  move: "Move an item",
  copy: "Copy an item",
  delete: "Delete an item permanently",
  open: "Open an item",
  open_url: "Open a link",
  open_with: "Open a file with an app",
  launch: "Launch an app",
  close: "Close an app",
  terminate: "Force-close an app",
  command: "Run a command",
  start_command: "Start a command",
  stop_command: "Stop a command",
  command_output: "Read command output",
  app_list: "Read installed apps",
  app_find: "Find an installed app",
  process_list: "Read running processes"
};

const FALLBACK_ACTION = {
  read: "List folder contents",
  contents: "Read a file",
  write: "Change a file",
  delete: "Delete an item permanently",
  launch: "Open an item",
  execute: "Run a command",
  app: "Check an app",
  system: "Use Windows"
};

const FILE_TOOLS = new Set(["read_file", "write_file", "append_file", "edit_file", "open_with_app"]);
const FILE_ACTIONS = new Set(["contents", "write", "append", "edit"]);
const ITEM_ACTIONS = new Set(["metadata", "open", "rename", "move", "copy", "delete"]);
const PROCESS_ACTIONS = new Set(["close", "terminate", "stop_command", "command_output"]);
const COMMAND_ACTIONS = new Set(["command", "start_command"]);

function actionText(request) {
  return ACTION_TEXT[request.action] || FALLBACK_ACTION[request.access] || "Use a local item";
}

function splitPath(value) {
  const text = typeof value === "string" ? value : "";
  const cut = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  if (cut < 0) return { name: text, parent: "" };
  const parent = text.slice(0, cut);
  return {
    name: text.slice(cut + 1) || text,
    // `C:\file` must read as `C:\`, not `C:`.
    parent: /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
  };
}

function targetKind(request) {
  if (COMMAND_ACTIONS.has(request.action)) return "command";
  if (PROCESS_ACTIONS.has(request.action)) return "process";
  if (request.action === "open_url") return "link";
  if (request.action === "launch") return "app";
  // Creating a folder is the one write whose target is not a file.
  if (request.tool === "create_directory") return "folder";
  if (FILE_TOOLS.has(request.tool) || FILE_ACTIONS.has(request.action)) return "file";
  if (ITEM_ACTIONS.has(request.action)) return "item";
  return "folder";
}

const TARGET_LABELS = Object.freeze({
  command: "Command",
  process: "Process",
  link: "Link",
  app: "App",
  file: "File",
  item: "Item",
  folder: "Folder"
});

function targetDetails(request) {
  const kind = targetKind(request);
  const label = TARGET_LABELS[kind];
  if (kind === "command") {
    return { kind, label, value: request.command, location: request.scopePath, locationTitle: request.scopePath };
  }
  const leaf = splitPath(request.scopePath);
  // Files and executables are named by their real file name so the card and a
  // saved grant are unambiguous; other targets use the native display name.
  const value =
    kind === "app" || kind === "file"
      ? leaf.name || request.scopeName
      : request.scopeName || leaf.name;
  if (kind === "process" || kind === "link") {
    return { kind, label, value, location: "", locationTitle: "" };
  }
  if (kind === "folder") {
    return { kind, label, value, location: request.scopePath, locationTitle: request.scopePath };
  }
  return { kind, label, value, location: leaf.parent, locationTitle: leaf.parent };
}

function warningText(request) {
  if (request.destructive) return "This cannot be undone.";
  if (request.access === "execute") return "This runs a command on your PC.";
  if (request.access === "write") return "This changes a file on your PC.";
  if (request.modifiesData) return "This changes files on your PC.";
  return "";
}

export default function InChatPermissionCard({ request, busy, error, onRespond }) {
  const firstButtonRef = useRef(null);
  const target = targetDetails(request);
  const warning = warningText(request);
  // The native layer decides whether a saved grant is safe and meaningful. The
  // card never assumes it: a folder, command or write is always per call.
  const canRemember = request.canPersist === true;

  useEffect(() => {
    firstButtonRef.current?.focus({ preventScroll: true });
  }, [request.requestId]);

  return (
    <section className="vr-permission-card" aria-labelledby={`permission-title-${request.requestId}`}>
      <div className="vr-permission-card__head">
        <ShieldCheck size={16} weight="fill" aria-hidden="true" />
        <h3 id={`permission-title-${request.requestId}`}>VupsRouter wants permission</h3>
        {busy ? <span className="vr-permission-card__status">Applying…</span> : null}
      </div>

      <p className="vr-permission-card__action">{actionText(request)}</p>

      <dl className="vr-permission-card__rows">
        {target.value ? (
          <div className="vr-permission-card__row">
            <dt>{target.label}</dt>
            <dd
              className={`vr-permission-card__value${target.kind === "command" ? " vr-permission-card__value--mono" : ""}`}
              title={target.value}
            >
              {target.value}
            </dd>
          </div>
        ) : null}
        {target.location ? (
          <div className="vr-permission-card__row">
            <dt>Location</dt>
            <dd className="vr-permission-card__path" title={target.locationTitle}>
              {target.location}
            </dd>
          </div>
        ) : null}
      </dl>

      {warning ? (
        <p className="vr-permission-card__warning" role="note">
          {warning}
        </p>
      ) : null}

      {error ? (
        <p className="vr-permission-card__error" role="alert">
          {error}
        </p>
      ) : null}

      {!canRemember ? (
        <p className="vr-permission-card__hint">Only a single file or app can be remembered.</p>
      ) : null}

      <div className="vr-permission-card__actions">
        <button
          ref={firstButtonRef}
          type="button"
          className="vr-permission-card__button vr-permission-card__button--allow"
          disabled={busy}
          onClick={() => onRespond("once")}
        >
          <Check size={14} aria-hidden="true" />
          Allow Once
        </button>
        <button
          type="button"
          className="vr-permission-card__button vr-permission-card__button--always"
          disabled={busy || !canRemember}
          onClick={() => onRespond("always")}
        >
          <ShieldCheck size={14} aria-hidden="true" />
          Allow Always (Only for This File)
        </button>
        <button
          type="button"
          className="vr-permission-card__button vr-permission-card__button--deny"
          disabled={busy}
          onClick={() => onRespond("deny")}
        >
          <X size={14} aria-hidden="true" />
          Deny
        </button>
      </div>
    </section>
  );
}
