import { ArrowRight, Warning } from "@phosphor-icons/react";

export default function ContextLimitWarning({
  model,
  busy = false,
  error = "",
  onContinue,
  onChooseModel,
  onDismiss
}) {
  return (
    <section className="vr-context-limit" role="alert" aria-live="polite">
      <div className="vr-context-limit__icon" aria-hidden="true">
        <Warning size={18} weight="fill" />
      </div>
      <div className="vr-context-limit__body">
        <strong>This chat has reached the model's context limit</strong>
        <p>
          {model ? <>The conversation is too long for <code>{model}</code>. </> : "The conversation is too long for this model. "}
          Continue in a new chat with a concise handoff, or choose a model with a larger context window.
        </p>
        {error ? <p className="vr-context-limit__error" role="status">{error}</p> : null}
        <div className="vr-context-limit__actions">
          <button type="button" className="vr-context-limit__primary" onClick={onContinue} disabled={busy}>
            {busy ? <span className="vr-progress-step__spinner" aria-hidden="true" /> : null}
            {busy ? "Creating new chat…" : "Continue with new chat"}
            {!busy ? <ArrowRight size={14} weight="bold" aria-hidden="true" /> : null}
          </button>
          {onChooseModel ? (
            <button type="button" className="vr-context-limit__secondary" onClick={onChooseModel} disabled={busy}>
              Choose another model
            </button>
          ) : null}
          <button type="button" className="vr-context-limit__dismiss" onClick={onDismiss} disabled={busy}>
            Dismiss
          </button>
        </div>
      </div>
    </section>
  );
}
