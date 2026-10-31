import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  DownloadSimple,
  SpinnerGap,
  WarningCircle
} from "@phosphor-icons/react";
import {
  RELEASES_PAGE_URL,
  checkLatestRelease,
  displayVersion,
  isOfficialAssetUrl,
  releaseDate,
  releaseNotes,
  releaseVersion,
  updateAvailability,
  updateErrorMessage
} from "../update/appUpdates.js";
import {
  appInfoPlugin,
  installedAppInfo,
  installAndroidUpdate,
  isAndroidApp
} from "../native/appInfo.js";
import {
  androidDownloadsPlugin,
  cancelAndroidDownload,
  enqueueAndroidDownload,
  listAndroidDownloads,
  retryAndroidDownload,
  subscribeAndroidDownloadEvents
} from "../native/androidDownloads.js";
import {
  downloadPercent,
  downloadProgressLabel,
  downloadSizeText,
  downloadStatusText,
  isActiveDownload,
  normalizeDownload
} from "../download/nativeDownloadState.js";
import { openExternalUrl } from "../native/externalLinks.js";
import "./ApplicationUpdates.css";

const UPDATE_DOWNLOAD_KEY = "vupsrouter.updates.androidDownload";

function readStoredDownload() {
  try {
    const raw = window.localStorage.getItem(UPDATE_DOWNLOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.id === "string" && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

function storeDownload(record) {
  try {
    if (record) window.localStorage.setItem(UPDATE_DOWNLOAD_KEY, JSON.stringify(record));
    else window.localStorage.removeItem(UPDATE_DOWNLOAD_KEY);
  } catch {
    /* private mode or quota errors must not break the settings page */
  }
}

function cleanPluginError(error) {
  const message = String(error?.message || "").replace(/^VupsAppInfo\.\w+:\s*/i, "");
  return message || "The update could not be installed on this device.";
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function platformLabel(platform) {
  if (platform === "windows") return "Windows app";
  if (platform === "android") return "Android app";
  if (platform === "web") return "Web app";
  return "This device";
}

export default function ApplicationUpdates() {
  const downloadsPlugin = useMemo(() => androidDownloadsPlugin(), []);
  const infoPlugin = useMemo(() => appInfoPlugin(), []);
  const android = Boolean(downloadsPlugin) || isAndroidApp();

  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState(null);
  const [release, setRelease] = useState(null);
  const [download, setDownload] = useState(null);
  const [downloadError, setDownloadError] = useState("");
  const [installState, setInstallState] = useState("idle");
  const [installError, setInstallError] = useState("");
  const [actionError, setActionError] = useState("");

  const checkingRef = useRef(false);
  const downloadingRef = useRef("");
  const downloadStartingRef = useRef(false);
  const installingRef = useRef(false);

  useEffect(() => {
    let active = true;
    installedAppInfo().then(result => {
      if (active) setInfo(result);
    });
    return () => {
      active = false;
    };
  }, [infoPlugin]);

  useEffect(() => {
    if (!downloadsPlugin) return undefined;
    let active = true;
    const stored = readStoredDownload();
    if (stored?.id) {
      downloadingRef.current = stored.id;
      listAndroidDownloads()
        .then(list => {
          if (!active) return;
          const raw = list.find(item => item?.id === stored.id);
          if (!raw) {
            downloadingRef.current = "";
            storeDownload(null);
            return;
          }
          setDownload(normalizeDownload(raw));
        })
        .catch(() => {});
    }
    const unsubscribe = subscribeAndroidDownloadEvents(event => {
      if (!event?.id || event.id !== downloadingRef.current) return;
      if (event.status === "removed") {
        downloadingRef.current = "";
        storeDownload(null);
        setDownload(null);
        return;
      }
      setDownload(normalizeDownload(event));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [downloadsPlugin]);

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setActionError("");
    try {
      const current = await installedAppInfo();
      setInfo(current);
      const result = await checkLatestRelease();
      if (!result.release) {
        setRelease(null);
        setAvailability({
          status: "info",
          latestVersion: "",
          message: "No published release was found yet, so this build cannot check for updates."
        });
        return;
      }
      setRelease(result.release);
      const latestVersion = releaseVersion(result.release);
      setAvailability(
        updateAvailability({
          currentVersion: current.version,
          latestVersion,
          platform: current.platform,
          release: result.release
        })
      );
    } catch (error) {
      setRelease(null);
      setAvailability({ status: "error", latestVersion: "", message: updateErrorMessage(error) });
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, []);

  const openReleases = useCallback(async () => {
    setActionError("");
    try {
      await openExternalUrl(RELEASES_PAGE_URL);
    } catch {
      setActionError(
        "The release page could not be opened. Visit github.com/CrazyVillainFF/Vups-Router/releases in a browser."
      );
    }
  }, []);

  const startDownload = useCallback(async () => {
    const asset = availability?.asset;
    if (!asset || downloadStartingRef.current) return;
    if (!isOfficialAssetUrl(asset.url)) {
      setDownloadError("The release feed did not provide a safe download for this app.");
      return;
    }
    downloadStartingRef.current = true;
    setDownloadError("");
    setInstallError("");
    setInstallState("idle");
    try {
      const result = await enqueueAndroidDownload({
        url: asset.url,
        filename: asset.name,
        mimeType: "application/vnd.android.package-archive"
      });
      const id = String(result?.id || "");
      if (!id) throw new Error("The download could not be started.");
      downloadingRef.current = id;
      storeDownload({ id, version: availability.latestVersion, filename: asset.name });
      setDownload(
        normalizeDownload({
          id,
          filename: asset.name,
          mimeType: "application/vnd.android.package-archive",
          status: "queued",
          bytes: 0,
          total: asset.size > 0 ? asset.size : -1,
          createdAt: Date.now()
        })
      );
      const list = await listAndroidDownloads().catch(() => []);
      const raw = list.find(item => item?.id === id);
      if (raw) setDownload(normalizeDownload(raw));
    } catch (error) {
      setDownloadError(String(error?.message || "The update could not be downloaded."));
    } finally {
      downloadStartingRef.current = false;
    }
  }, [availability]);

  const retryDownload = useCallback(async () => {
    if (!download?.id || downloadStartingRef.current) return;
    setDownloadError("");
    try {
      await retryAndroidDownload(download.id);
      setDownload(previous => (previous ? { ...previous, status: "queued", error: "" } : previous));
    } catch (error) {
      setDownloadError(String(error?.message || "The download could not be retried."));
    }
  }, [download]);

  const cancelDownload = useCallback(async () => {
    if (!download?.id) return;
    try {
      await cancelAndroidDownload(download.id);
    } catch {
      setDownloadError("The update download could not be cancelled.");
    }
  }, [download]);

  const startInstall = useCallback(async () => {
    if (!download?.id || installingRef.current) return;
    installingRef.current = true;
    setInstallError("");
    setInstallState("opening");
    try {
      await installAndroidUpdate(download.id);
      setInstallState("opened");
    } catch (error) {
      setInstallState("error");
      setInstallError(cleanPluginError(error));
    } finally {
      installingRef.current = false;
    }
  }, [download]);

  const platform = info?.platform || (android ? "android" : "web");
  const latestVersion = displayVersion(availability?.latestVersion || "");
  const released = formatDate(releaseDate(release));
  const notes = releaseNotes(release);
  const installed = info?.version
    ? `Version ${displayVersion(info.version)}${info.build ? ` · build ${info.build}` : ""}`
    : platform === "web"
      ? "Always the deployed build"
      : "Not reported by this build";

  let statusTone = "muted";
  let statusText = "Not checked yet.";
  if (checking) {
    statusTone = "pending";
    statusText = "Checking the official release feed…";
  } else if (availability?.status === "current") {
    statusTone = "ok";
    statusText = `Up to date — ${latestVersion || "this release"} is the newest published version.`;
  } else if (availability?.status === "available") {
    statusTone = availability.asset ? "ready" : "pending";
    statusText =
      availability.message ||
      (availability.asset
        ? `Update available — ${latestVersion} is ready to ${platform === "android" ? "download" : "get"}.`
        : `Update available — ${latestVersion} is published without a package for this platform.`);
  } else if (availability?.status === "info") {
    statusTone = "muted";
    statusText =
      availability.message ||
      (platform === "android"
        ? "This build does not report its installed version, so the newest release cannot be compared."
        : "There is no installed version to compare on this device.");
  } else if (availability?.status === "error") {
    statusTone = "error";
    statusText = availability.message;
  }

  const canDownload =
    platform === "android" &&
    availability?.status === "available" &&
    Boolean(availability.asset) &&
    !download;
  const downloadActive = download ? isActiveDownload(download) : false;
  const downloadFailed = download?.status === "failed" || download?.status === "cancelled";
  const downloadReady = download?.status === "completed";
  const percent = download ? downloadPercent(download) : null;

  return (
    <section className="vr-settings-group vr-updates" aria-labelledby="vr-updates-title">
      <h2 id="vr-updates-title">Application updates</h2>
      <p className="vr-setting-hint">
        Checks the official GitHub release for {platformLabel(platform)}. Nothing is downloaded or installed until you
        choose it.
      </p>

      <div className="vr-setting-row">
        <span className="vr-setting-copy">
          <strong>Installed version</strong>
          <span>{installed}</span>
        </span>
        <span className="vr-setting-badge">{platformLabel(platform)}</span>
      </div>

      <div className="vr-setting-row">
        <span className="vr-setting-copy">
          <strong>Latest version</strong>
          <span>{latestVersion || "Not checked"}</span>
        </span>
        {released ? (
          <span className="vr-updates__released">
            Released <time dateTime={releaseDate(release)}>{released}</time>
          </span>
        ) : null}
      </div>

      <div className="vr-setting-row">
        <span className="vr-setting-copy">
          <strong>Update status</strong>
          <span className="vr-updates__status" data-tone={statusTone} role="status" aria-live="polite">
            {statusText}
          </span>
        </span>
        <button type="button" className="vr-secondary-small" onClick={runCheck} disabled={checking}>
          {checking ? <SpinnerGap size={14} className="vr-updates__spin" aria-hidden="true" /> : null}
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      {notes ? (
        <div className="vr-updates__notes">
          <strong>Latest release notes</strong>
          <p>{notes}</p>
          <button type="button" className="vr-updates__link" onClick={openReleases}>
            <ArrowSquareOut size={13} aria-hidden="true" />
            View release on GitHub
          </button>
        </div>
      ) : null}

      {downloadActive ? (
        <div className="vr-updates__download">
          <div className="vr-updates__download-head">
            <span>{downloadStatusText(download)}</span>
            <button type="button" className="vr-secondary-small" onClick={cancelDownload}>
              Cancel
            </button>
          </div>
          <div
            className="vr-updates__bar"
            role="progressbar"
            aria-label="Downloading the application update"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent == null ? undefined : percent}
            aria-valuetext={downloadProgressLabel(download)}
          >
            <span className={percent == null ? "is-indeterminate" : ""} style={percent == null ? undefined : { width: `${percent}%` }} />
          </div>
          <span className="vr-setting-hint">{download.filename}</span>
        </div>
      ) : null}

      {downloadReady ? (
        <div className="vr-updates__ready">
          <div className="vr-updates__download-head">
            <span>
              <CheckCircle size={14} weight="fill" aria-hidden="true" /> Update package ready · {download.filename} ·{" "}
              {downloadSizeText(download)}
            </span>
            <button
              type="button"
              className="vr-primary-small"
              onClick={startInstall}
              disabled={installState === "opening"}
            >
              {installState === "opening" ? "Opening installer…" : "Install update"}
            </button>
          </div>
          <span className="vr-setting-hint">
            Android checks the package name, signing certificate, and version before its installer opens. Nothing is
            installed without your confirmation.
          </span>
        </div>
      ) : null}

      {downloadFailed ? (
        <div className="vr-updates__failure" role="alert">
          <span>
            <WarningCircle size={14} weight="fill" aria-hidden="true" /> Update download failed
            {download.error ? `: ${download.error}` : "."}
          </span>
          <button type="button" className="vr-secondary-small" onClick={retryDownload}>
            <ArrowClockwise size={14} aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : null}

      {downloadError ? (
        <p className="vr-updates__error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          {downloadError}
        </p>
      ) : null}

      {installError ? (
        <p className="vr-updates__error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          Update installation failed: {installError}
        </p>
      ) : null}

      {installState === "opened" ? (
        <p className="vr-updates__success" role="status">
          <CheckCircle size={14} weight="fill" aria-hidden="true" />
          Android&apos;s installer is open. Confirm the update there to finish.
        </p>
      ) : null}

      {canDownload ? (
        <div className="vr-updates__action">
          <button type="button" className="vr-primary-small" onClick={startDownload}>
            <DownloadSimple size={14} aria-hidden="true" />
            Download update
          </button>
          <span className="vr-setting-hint">
            The package is fetched from the official release and verified by Android before installation.
          </span>
        </div>
      ) : null}

      {platform === "android" && availability?.asset?.debug && availability?.status === "available" ? (
        <p className="vr-setting-hint">
          This release only publishes a debug-signed test build. An app installed with the release key cannot be
          updated by it, and VupsRouter will refuse rather than replace the install.
        </p>
      ) : null}

      {platform === "windows" && availability?.status === "available" ? (
        <div className="vr-updates__action">
          <button type="button" className="vr-primary-small" onClick={openReleases}>
            <ArrowSquareOut size={14} aria-hidden="true" />
            Open release page
          </button>
          <span className="vr-setting-hint">
            Automatic installation is not configured in this Windows build: it needs the Tauri updater plugin with a
            signed update manifest. Use the official installer; saved models and preferences stay in place.
          </span>
        </div>
      ) : null}

      {platform === "android" &&
      availability?.status !== "available" &&
      release &&
      !download ? (
        <div className="vr-updates__action">
          <button type="button" className="vr-secondary-small" onClick={openReleases}>
            <ArrowSquareOut size={14} aria-hidden="true" />
            Open release page
          </button>
          {availability?.status === "info" ? (
            <span className="vr-setting-hint">
              Install this build once from the release page to enable in-app version checks.
            </span>
          ) : null}
        </div>
      ) : null}

      {platform === "web" ? (
        <p className="vr-setting-hint">
          The web app always runs the latest deployed build and updates when the page reloads. There is no separate
          package to install here.
        </p>
      ) : null}

      {actionError ? (
        <p className="vr-updates__error" role="alert">
          <WarningCircle size={14} weight="fill" aria-hidden="true" />
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
