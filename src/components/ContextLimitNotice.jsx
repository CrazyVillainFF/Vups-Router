import { useId } from "react";
import { ArrowBendDownRight, GearSix, Key, SpinnerGap } from "@phosphor-icons/react";
import { contextHandoffGoal } from "../chat/contextLimit.js";
import {
  CONTINUE_NEW_CHAT_ACTION,
  REQUEST_BLOCKED_MESSAGE,
  REQUEST_BLOCKED_TITLE
} from "../chat/chatErrors.js";
import "./ContextLimit.css";

export function ContextHandoffCard({ message }) {
  const handoff = message?.handoff && typeof message.handoff === "object" ? message.handoff : {};
  const goal = handoff.goal || contextHandoffGoal(message?.content) || "Previous conversation";
  const files = Array.isArray(handoff.files) ? handoff.files : [];

  return (
    <section className="vr-handoff" aria-label="Context carried over from the previous chat" tabIndex={-1}>
      <div className="vr-handoff__head">
        <ArrowBendDownRight size={14} weight="bold" aria-hidden="true" />
        <span>Context carried over</span>
        {handoff.model ? (
          <code className="vr-handoff__model" title={handoff.model}>{handoff.model}</code>
        ) : null}
      </div>
      <p className="vr-handoff__goal">{goal}</p>
      <p className="vr-handoff__meta">
        {files.length > 0
          ? `${files.length} generated ${files.length === 1 ? "file" : "files"} listed in the summary`
          : "Summary of the previous conversation"}
      </p>
      {message?.content ? (
        <details className="vr-handoff__details">
          <summary>View handoff summary</summary>
          <pre tabIndex={0} aria-label="Handoff summary">{message.content}</pre>
        </details>
      ) : null}
      <p className="vr-handoff__note">The previous chat and its files are unchanged.</p>
    </section>
  );
}

/**
 * An edge firewall (for example Render's WAF) rejects some message content
 * before it ever reaches the backend. No provider setting or model change can
 * resolve it, so the only safe action is to continue in a new chat.
 */
export function RequestBlockedNotice({ busy = false, error = "", onContinue }) {
  return (
    <section
      className="vr-context vr-context--limit vr-context--blocked"
      role="alert"
      aria-label={REQUEST_BLOCKED_TITLE}
      data-busy={busy ? "" : undefined}
    >
      <div className="vr-context__body">
        <h3>{REQUEST_BLOCKED_TITLE}</h3>
        <p className="vr-context__message">{REQUEST_BLOCKED_MESSAGE}</p>
      </div>
      <button
        type="button"
        className="vr-context__primary"
        onClick={onContinue}
        disabled={busy || !onContinue}
        aria-busy={busy}
      >
        {busy ? (
          <SpinnerGap size={14} weight="bold" className="vr-context__spin" aria-hidden="true" />
        ) : null}
        {busy ? "Preparing new chat\u2026" : error ? "Try again" : CONTINUE_NEW_CHAT_ACTION}
      </button>
      {error ? <p className="vr-context__error" role="status">{error}</p> : null}
    </section>
  );
}

/**
 * Context-window failures are not credential failures. This alert deliberately
 * carries only the explanation and the one recovery action.
 */
export function ContextLimitNotice({ busy = false, error = "", onContinue }) {
  return (
    <section
      className="vr-context vr-context--limit"
      role="alert"
      aria-label="This chat is too long"
      data-busy={busy ? "" : undefined}
    >
      <p className="vr-context__message">
        This chat is too long. Continue in a new chat to keep going.
      </p>
      {error ? <p className="vr-context__error" role="status">{error}</p> : null}
      <button
        type="button"
        className="vr-context__primary"
        onClick={onContinue}
        disabled={busy || !onContinue}
        aria-busy={busy}
      >
        {busy ? (
          <SpinnerGap size={14} weight="bold" className="vr-context__spin" aria-hidden="true" />
        ) : null}
        {busy ? "Preparing new chat\u2026" : error ? "Try again" : CONTINUE_NEW_CHAT_ACTION}
      </button>
    </section>
  );
}

/**
 * Missing provider key. A new chat cannot fix this, so Settings is primary and
 * the limitation is stated explicitly even though the handoff action remains
 * available for continuing elsewhere.
 */
export function ApiKeyNotice({
  model = "",
  busy = false,
  error = "",
  onOpenSettings,
  onChooseModel,
  onContinueNewChat
}) {
  const titleId = useId();

  return (
    <section
      className="vr-context vr-context--key"
      role="alert"
      aria-labelledby={titleId}
      data-busy={busy ? "" : undefined}
    >
      <span className="vr-context__icon" aria-hidden="true">
        <Key size={17} weight="fill" />
      </span>
      <div className="vr-context__body">
        <h3 id={titleId}>API key required</h3>
        <p>
          {model ? (
            <>
              The selected model (<code>{model}</code>) requires an API key.
            </>
          ) : (
            "This provider requires an API key."
          )}{" "}
          Add or update the provider&rsquo;s API key in Settings, or choose another model.
        </p>
        {error ? <p className="vr-context__error" role="status">{error}</p> : null}
        <div className="vr-context__actions">
          {onOpenSettings ? (
            <button type="button" className="vr-context__primary" onClick={onOpenSettings} disabled={busy}>
              <GearSix size={14} weight="bold" aria-hidden="true" />
              Open Settings
            </button>
          ) : null}
          {onChooseModel ? (
            <button
              type="button"
              className="vr-context__secondary"
              onClick={onChooseModel}
              disabled={busy}
            >
              Try another model
            </button>
          ) : null}
          {onContinueNewChat ? (
            <button
              type="button"
              className="vr-context__tertiary"
              onClick={onContinueNewChat}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? (
                <SpinnerGap size={14} weight="bold" className="vr-context__spin" aria-hidden="true" />
              ) : null}
              {busy ? "Preparing new chat\u2026" : CONTINUE_NEW_CHAT_ACTION}
            </button>
          ) : null}
        </div>
        <p className="vr-context__note">
          Starting a new chat won&rsquo;t fix a missing key. The selected model still needs an API key.
        </p>
      </div>
    </section>
  );
}

export default ContextLimitNotice;
