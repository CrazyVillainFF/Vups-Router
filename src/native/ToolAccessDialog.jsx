import React from "react";
import { X } from "@phosphor-icons/react";
import { toolAccessRows } from "./toolAccessStatus.js";

export default function ToolAccessDialog({ open, onClose, status }) {
  if (!open) return null;
  const { rows, toolNames } = toolAccessRows(status);
  return (
    <div className="vr-modal-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <section className="vr-modal vr-tool-dialog" role="dialog" aria-modal="true" aria-labelledby="vr-tool-access-title">
        <header className="vr-modal-head">
          <div>
            <span className="vr-modal-kicker">TOOL ACCESS</span>
            <h2 id="vr-tool-access-title">What this chat can run</h2>
          </div>
          <button type="button" className="vr-icon-btn" onClick={onClose} aria-label="Close tool access">
            <X size={18} />
          </button>
        </header>

        <dl className="vr-tool-status">
          {rows.map(row => (
            <div key={row.key} className="vr-tool-status__row" data-tone={row.tone}>
              <dt>{row.label}</dt>
              <dd>
                <strong>{row.value}</strong>
                {row.hint ? <span>{row.hint}</span> : null}
              </dd>
            </div>
          ))}
        </dl>

        <details className="vr-tool-registry">
          <summary>Registered tool names ({toolNames.length})</summary>
          <ul>
            {toolNames.map(name => (
              <li key={name}><code>{name}</code></li>
            ))}
          </ul>
        </details>

        <p className="vr-file-note">
          The model chooses which tool to call; the permission mode, the folder boundary and Windows access
          rules decide what is allowed. API keys, tokens and file contents never appear here.
        </p>

        <footer className="vr-modal-foot">
          <span>Model-independent access</span>
          <div className="vr-modal-actions">
            <button type="button" className="vr-secondary-small" onClick={onClose}>Close</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
