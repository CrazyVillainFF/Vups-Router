import React, { useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import {
  actionFields,
  buildActionArgs,
  describeAction,
  initialActionValues,
  redactSecrets,
  validateActionValues
} from "./pluginDetails.js";

// One dialog for every plugin action. Read actions run from the form; anything
// marked sensitive adds an explicit review step that restates exactly what will
// be sent before the request leaves the app.
export default function PluginActionDialog({ plugin, tool, onClose, onRun }) {
  const action = useMemo(() => describeAction(tool), [tool]);
  const fields = useMemo(() => actionFields(tool), [tool]);
  const [values, setValues] = useState(() => initialActionValues(tool));
  const [step, setStep] = useState("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    // Captured so Escape closes this dialog first and does not also close the
    // plugin detail modal underneath it.
    const onKeyDown = event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const args = buildActionArgs(fields, values);
  const summaryRows = fields
    .filter(field => args[field.key] !== undefined)
    .map(field => ({ label: field.label, value: String(args[field.key]) }));

  function update(key, value) {
    setValues(current => ({ ...current, [key]: value }));
  }

  function review(event) {
    event.preventDefault();
    if (busy) return;
    const problem = validateActionValues(fields, values);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    if (action.changes) setStep("confirm");
    else execute(false);
  }

  async function execute(confirm) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await onRun(tool, args, confirm);
      setResult(response?.result ?? response ?? {});
      setStep("result");
    } catch (runError) {
      setError(redactSecrets(runError?.message || "That action did not run."));
      setStep(action.changes && confirm ? "confirm" : "form");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="vr-plugin-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="vr-plugin-modal vr-plugin-action-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vr-plugin-action-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className="vr-plugin-modal-head">
          <div>
            <span className="vr-page-kicker">{action.changes ? "ACTION THAT CHANGES DATA" : "READ-ONLY ACTION"}</span>
            <h2 id="vr-plugin-action-title">{action.label}</h2>
            <p>{plugin.name}</p>
          </div>
        </header>

        <div className="vr-plugin-modal-body">
          {step === "form" ? (
            <form className="vr-plugin-action-form" onSubmit={review}>
              <p className="vr-plugin-action-intro">{action.effectLine}</p>
              {fields.map(field => (
                <label key={field.key}>
                  <span>
                    {field.label}
                    {field.required ? "" : " (optional)"}
                  </span>
                  {field.type === "select" ? (
                    <select
                      className="vr-select"
                      value={values[field.key] ?? ""}
                      onChange={event => update(field.key, event.target.value)}
                    >
                      {field.options.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "textarea" ? (
                    <textarea
                      rows={5}
                      value={values[field.key] ?? ""}
                      onChange={event => update(field.key, event.target.value)}
                    />
                  ) : (
                    <input
                      type={field.type === "number" ? "number" : "text"}
                      min={field.minimum ?? undefined}
                      max={field.maximum ?? undefined}
                      value={values[field.key] ?? ""}
                      onChange={event => update(field.key, event.target.value)}
                      placeholder={field.placeholder}
                    />
                  )}
                  {field.hint ? <small>{field.hint}</small> : null}
                </label>
              ))}
              {error ? <div className="vr-inline-error" role="alert">{error}</div> : null}
              <div className="vr-plugin-modal-actions">
                <button type="button" className="vr-secondary-small" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="submit" className="vr-primary-small" disabled={busy}>
                  {action.changes ? "Review" : (
                    <>
                      {busy ? <CircleNotch size={14} className="vr-spin" /> : null} {busy ? "Running…" : "Run"}
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : null}

          {step === "confirm" ? (
            <div className="vr-plugin-confirm-step">
              <div className="vr-callout vr-callout--warning">
                <WarningCircle size={18} />
                <div>
                  <strong>This changes your {plugin.name} data</strong>
                  <span>
                    Nothing has been sent yet. Check the details below, then approve to {action.label.toLowerCase()}.
                  </span>
                </div>
              </div>
              <dl className="vr-plugin-confirm-list">
                {summaryRows.map(row => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {error ? <div className="vr-inline-error" role="alert">{error}</div> : null}
              <div className="vr-plugin-modal-actions">
                <button type="button" className="vr-secondary-small" onClick={() => setStep("form")} disabled={busy}>
                  Back
                </button>
                <button type="button" className="vr-secondary-small" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="vr-primary-small" onClick={() => execute(true)} disabled={busy}>
                  {busy ? <CircleNotch size={14} className="vr-spin" /> : <ShieldCheck size={14} />}
                  {busy ? "Sending…" : action.label}
                </button>
              </div>
            </div>
          ) : null}

          {step === "result" ? (
            <div className="vr-plugin-result-step">
              <div className="vr-plugin-result-head">
                <ShieldCheck size={17} />
                <div>
                  <strong>{action.changes ? "Done" : "Result"}</strong>
                  <span>{action.changes ? `${action.label} finished.` : "Nothing was changed on your account."}</span>
                </div>
              </div>
              <pre className="vr-plugin-result" aria-label="Action result">{JSON.stringify(result, null, 2)}</pre>
              <div className="vr-plugin-modal-actions">
                <button type="button" className="vr-primary-small" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
