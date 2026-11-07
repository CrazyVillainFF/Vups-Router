import React from "react";
import { Warning } from "@phosphor-icons/react";
import "./AppBoundary.css";

/* A throw anywhere inside the wrapped tree used to take the whole document with
   it: React unmounted, the page background was all that remained, and on Windows
   and Android that looks like a black screen with no way out. The boundary keeps
   everything outside it standing and puts a real action where the crash was.

   Recovery is a remount, not a promise. Chat submissions are durable on the
   server before the model is called, so re-rendering the screen reloads the
   conversation instead of losing it. */
export default class AppBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[vupsrouter] screen failed to render", error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const isPage = this.props.variant === "page";
    // The provider's own sentence is the only diagnostic worth showing, and it
    // never carries a key or token. Stack traces stay in the console above.
    const detail = String(error?.message || "").slice(0, 240);
    return (
      <div className={isPage ? "vr-boundary vr-boundary--page" : "vr-boundary"} role="alert">
        <div className="vr-boundary__head">
          <Warning className="vr-boundary__icon" size={22} weight="duotone" aria-hidden="true" />
          <h2 className="vr-boundary__title">
            {isPage ? "VupsRouter could not open this screen" : "This screen stopped responding"}
          </h2>
        </div>
        <p className="vr-boundary__copy">
          {isPage
            ? "Your account, chats and settings are stored on the server. Nothing you sent has been lost."
            : "Your conversation is saved. Trying again reloads it from the server."}
        </p>
        {detail ? (
          <details className="vr-boundary__detail">
            <summary>What went wrong</summary>
            <code>{detail}</code>
          </details>
        ) : null}
        <div className="vr-boundary__actions">
          <button type="button" className="vr-boundary__primary" onClick={this.reset}>
            Try again
          </button>
          {isPage ? (
            <button
              type="button"
              className="vr-boundary__secondary"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}
