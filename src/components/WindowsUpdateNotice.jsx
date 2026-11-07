import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  SpinnerGap,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { displayVersion } from "../update/appUpdates.js";
import {
  checkWindowsUpdate,
  createUpdaterProgress,
  isWindowsUpdaterAvailable,
  restartWindowsApp,
  updaterErrorMessage
} from "../native/windowsUpdater.js";
import "./WindowsUpdateNotice.css";

const DISMISSED_KEY = "vupsrouter.updates.dismissedWindowsVersion";

// Boot leaves the network to the auth round trip, the model catalog and the
// first paint; the background check waits until the app has settled.
export const STARTUP_DELAY_MS = 20000;

function readDismissedVersion() {
  try {
    return String(window.localStorage.getItem(DISMISSED_KEY) || "");
  } catch {
    return "";
  }
}

function storeDismissedVersion(version) {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* a private profile keeps the notice once per session, which is acceptable */
  }
}

export default function WindowsUpdateNotice() {
  const available = isWindowsUpdaterAvailable();
  const [update, setUpdate] = useState(null);
  const [phase, setPhase] = useState("idle");
  const [percent, setPercent] = useState(null);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    if (!available) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      checkWindowsUpdate()
        .then(found => {
          if (!active || !found) return;
          if (displayVersion(found.version) === readDismissedVersion()) return;
          setUpdate(found);
        })
        .catch(() => {
          // A background check never interrupts the app. Settings > Application
          // updates stays the path that reports failures out loud.
        });
    }, STARTUP_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [available]);

  const dismiss = useCallback(() => {
    if (update) storeDismissedVersion(displayVersion(update.version));
    setUpdate(null);
    setPhase("idle");
    setPercent(null);
    setError("");
  }, [update]);

  const install = useCallback(async () => {
    if (!update || busyRef.current) return;
    busyRef.current = true;
    setError("");
    setPhase("installing");
    setPercent(null);
    const progress = createUpdaterProgress();
    try {
      await update.downloadAndInstall(event => {
        const state = progress(event);
        if (state.percent != null) setPercent(state.percent);
      });
      setPercent(100);
      setPhase("installed");
    } catch (caught) {
      setPhase("error");
      setError(updaterErrorMessage(caught));
    } finally {
      busyRef.current = false;
    }
  }, [update]);

  const restart = useCallback(async () => {
    setError("");
    try {
      await restartWindowsApp();
    } catch {
      setError(
        "The app could not be restarted automatically. Close and reopen VupsRouter to finish the update."
      );
    }
  }, []);

  if (!update) return null;
  const version = displayVersion(update.version);

  return (
    <section className="vr-update-notice" aria-label="Application update" data-phase={phase}>
      <header className="vr-update-notice__head">
        <DownloadSimple size={15} aria-hidden="true" />
        <span className="vr-update-notice__title">VupsRouter {version} is available</span>
        <button
          type="button"
          className="vr-update-notice__close"
          onClick={dismiss}
          disabled={phase === "installing"}
          aria-label="Dismiss the update notice"
          title="Not now"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {update.notes && phase !== "installed" ? (
        <p className="vr-update-notice__notes">{update.notes}</p>
      ) : null}

      {phase === "installing" ? (
        <div
          className="vr-update-notice__bar"
          role="progressbar"
          aria-label={`Installing VupsRouter ${version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent == null ? undefined : percent}
        >
          <span
            className={percent == null ? "is-indeterminate" : ""}
            style={percent == null ? undefined : { width: `${percent}%` }}
          />
        </div>
      ) : null}

      {phase === "installed" ? (
        <p className="vr-update-notice__done" role="status">
          <CheckCircle size={14} weight="fill" aria-hidden="true" />
          Version {version} is installed. Restart VupsRouter to finish.
        </p>
      ) : null}

      {error ? (
        <p className="vr-update-notice__error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <footer className="vr-update-notice__actions">
        {phase === "installed" ? (
          <button type="button" className="vr-primary-small" onClick={restart}>
            <ArrowClockwise size={14} aria-hidden="true" />
            Restart now
          </button>
        ) : phase === "installing" ? (
          <button type="button" className="vr-primary-small" disabled>
            <SpinnerGap size={14} className="vr-update-notice__spin" aria-hidden="true" />
            Installing…
          </button>
        ) : (
          <button type="button" className="vr-primary-small" onClick={install}>
            {phase === "error" ? (
              <ArrowClockwise size={14} aria-hidden="true" />
            ) : (
              <DownloadSimple size={14} aria-hidden="true" />
            )}
            {phase === "error" ? "Try again" : `Update to ${version}`}
          </button>
        )}
      </footer>
    </section>
  );
}
