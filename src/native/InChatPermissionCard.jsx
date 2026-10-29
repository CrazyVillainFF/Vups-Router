import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck, X } from "@phosphor-icons/react";

const ACCESS_LINES = {
  locate: ["Find where this folder is on this PC"],
  list: ["List the files and folders inside it", "Read names, sizes and dates needed for that list"],
  recent: ["List the files and folders inside it", "Read file dates and sizes to work out which are newest"],
  search: ["List the files and folders inside it", "Match file names against the search"],
  metadata: ["Read file dates and sizes for entries inside it"],
  read: ["List the files and folders inside it", "Read names, sizes and dates needed for that list"],
  contents: ["Read the contents of this one file"]
};

const FILE_ACTIONS = new Set(["contents"]);

function accessLines(request) {
  const exact = ACCESS_LINES[request.action] || ACCESS_LINES.read;
  return request.access === "contents" ? ACCESS_LINES.contents : exact;
}

const OPERATION_LINES = {
  locate: "Find where this folder is on this PC",
  list: "List filenames and read file metadata",
  recent: "List filenames and read file metadata",
  search: "List filenames and match file names",
  metadata: "Read file names, sizes and dates",
  read: "List filenames and read file metadata",
  contents: "Read the contents of one file"
};

function operationLine(request) {
  if (request.access === "contents") return OPERATION_LINES.contents;
  return OPERATION_LINES[request.action] || OPERATION_LINES.read;
}

function cardTitle(request) {
  const name = request.scopeName || (request.access === "contents" ? "a local file" : "a local folder");
  return `VupsRouter wants to access ${name}`;
}

export default function InChatPermissionCard({ request, busy, error, onRespond }) {
  const [expiresIn, setExpiresIn] = useState(null);
  const firstButtonRef = useRef(null);

  useEffect(() => {
    firstButtonRef.current?.focus({ preventScroll: true });
  }, [request.requestId]);

  useEffect(() => {
    if (!Number.isFinite(request.expiresAt)) {
      setExpiresIn(null);
      return undefined;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.round((request.expiresAt - Date.now()) / 1000));
      setExpiresIn(remaining);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [request.expiresAt]);

  const isFile = request.access === "contents" || FILE_ACTIONS.has(request.action);

  return (
    <section className="vr-permission-card" aria-labelledby={`permission-title-${request.requestId}`}>
      <div className="vr-permission-card__head">
        <ShieldCheck size={16} weight="fill" aria-hidden="true" />
        <h3 id={`permission-title-${request.requestId}`}>{cardTitle(request)}</h3>
        <span
          className={`vr-permission-card__status${busy ? " vr-permission-card__status--busy" : ""}`}
        >
          {busy ? "Applying your decision…" : "Waiting for approval"}
        </span>
        {expiresIn !== null ? (
          <span className="vr-permission-card__expiry">
            {expiresIn > 0 ? `Expires in ${expiresIn}s` : "Expired"}
          </span>
        ) : null}
      </div>

      <p className="vr-permission-card__purpose">{request.summary}</p>

      <div className="vr-permission-card__field">
        <span className="vr-permission-card__label">Operation</span>
        <span className="vr-permission-card__operation">{operationLine(request)}</span>
      </div>

      <div className="vr-permission-card__field">
        <span className="vr-permission-card__label">{isFile ? "File" : "Folder"}</span>
        <code className="vr-permission-card__path" title={request.scopePath}>
          {request.scopePath}
        </code>
      </div>

      <div className="vr-permission-card__field">
        <span className="vr-permission-card__label">Access requested</span>
        <ul className="vr-permission-card__access">
          {accessLines(request).map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <p className="vr-permission-card__scope">
        {isFile
          ? "Approving this covers the single file above. It does not open the folder it sits in, and it never allows modifying, deleting or running anything."
          : "Approving this covers the folder above and the entries listed inside it. It does not allow reading file contents, modifying, deleting or running anything."}
      </p>

      {error ? <p className="vr-permission-card__error" role="alert">{error}</p> : null}

      <div className="vr-permission-card__actions">
        <button
          ref={firstButtonRef}
          type="button"
          className="vr-permission-card__button vr-permission-card__button--allow"
          disabled={busy}
          onClick={() => onRespond("once")}
        >
          <Check size={14} aria-hidden="true" />
          Allow once
        </button>
        {!isFile ? (
          <button
            type="button"
            className="vr-permission-card__button"
            disabled={busy}
            onClick={() => onRespond("always")}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Always allow for this folder
          </button>
        ) : null}
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
