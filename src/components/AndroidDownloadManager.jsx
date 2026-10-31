import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  BellSlash,
  CaretDown,
  CheckCircle,
  DownloadSimple,
  SpinnerGap,
  WarningCircle,
  X,
  XCircle
} from "@phosphor-icons/react";
import {
  androidDownloadsPlugin,
  androidNotificationsStatus,
  cancelAndroidDownload,
  clearFinishedAndroidDownloads,
  listAndroidDownloads,
  openAndroidDownload,
  requestAndroidNotifications,
  retryAndroidDownload,
  subscribeAndroidDownloadEvents
} from "../native/androidDownloads.js";
import {
  activeDownloadCount,
  applyDownloadEvent,
  downloadPercent,
  downloadProgressLabel,
  downloadStatusText,
  finishedDownloadCount,
  isActiveDownload,
  normalizeDownload
} from "../download/nativeDownloadState.js";
import "./AndroidDownloadManager.css";

function StatusIcon({ download }) {
  if (download.status === "completed") return <CheckCircle size={16} weight="fill" aria-hidden="true" />;
  if (download.status === "failed") return <XCircle size={16} weight="fill" aria-hidden="true" />;
  if (isActiveDownload(download)) return <SpinnerGap size={16} className="vr-downloads__spin" aria-hidden="true" />;
  return <WarningCircle size={16} weight="fill" aria-hidden="true" />;
}

export default function AndroidDownloadManager() {
  const plugin = useMemo(() => androidDownloadsPlugin(), []);
  const [downloads, setDownloads] = useState([]);
  const [permission, setPermission] = useState(null);
  const [open, setOpen] = useState(true);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!plugin) return undefined;
    let active = true;
    listAndroidDownloads()
      .then(list => {
        if (!active) return;
        setDownloads(
          list
            .map(normalizeDownload)
            .sort((left, right) => right.createdAt - left.createdAt)
        );
      })
      .catch(() => {});
    androidNotificationsStatus()
      .then(status => {
        if (active) setPermission(status);
      })
      .catch(() => {});
    const unsubscribe = subscribeAndroidDownloadEvents(event => {
      setDownloads(previous => applyDownloadEvent(previous, event));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [plugin]);

  const enableNotifications = useCallback(async () => {
    try {
      const status = await requestAndroidNotifications();
      setPermission(status);
      if (!status?.granted) {
        setNotice("Notifications are off. Downloads still continue and stay visible in this panel.");
      }
    } catch {
      setNotice("Android did not show the notification prompt. You can enable downloads notifications in system settings.");
    }
  }, []);

  const runAction = useCallback(async (action, failure) => {
    setNotice("");
    try {
      await action();
    } catch {
      setNotice(failure);
    }
  }, []);

  if (!plugin || downloads.length === 0) return null;

  const active = activeDownloadCount(downloads);
  const finished = finishedDownloadCount(downloads);
  const showPermissionHint = permission && permission.granted === false && permission.canRequest;

  return (
    <section className="vr-downloads" aria-label="Downloads">
      <header className="vr-downloads__head">
        <button
          type="button"
          className="vr-downloads__toggle"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          <DownloadSimple size={15} aria-hidden="true" />
          <span className="vr-downloads__title">
            Downloads{active > 0 ? ` · ${active} active` : ""}
          </span>
          <CaretDown
            size={13}
            weight="bold"
            className={`vr-downloads__chevron${open ? " is-open" : ""}`}
            aria-hidden="true"
          />
        </button>
        {finished > 0 ? (
          <button
            type="button"
            className="vr-downloads__clear"
            onClick={() =>
              runAction(async () => {
                await clearFinishedAndroidDownloads();
                setDownloads(previous => previous.filter(isActiveDownload));
              }, "Finished downloads could not be cleared.")
            }
          >
            Clear finished
          </button>
        ) : null}
      </header>

      {showPermissionHint ? (
        <div className="vr-downloads__permission" role="note">
          <BellSlash size={14} aria-hidden="true" />
          <span>Notifications are off. Downloads continue in the background, and progress stays here.</span>
          <button type="button" onClick={enableNotifications}>
            Enable
          </button>
        </div>
      ) : null}

      {notice ? (
        <p className="vr-downloads__notice" role="alert">{notice}</p>
      ) : null}

      {open ? (
        <ul className="vr-downloads__list">
          {downloads.map(download => {
            const percent = downloadPercent(download);
            const running = isActiveDownload(download);
            return (
              <li key={download.id} className="vr-downloads__row" data-status={download.status}>
                <span className="vr-downloads__icon"><StatusIcon download={download} /></span>
                <div className="vr-downloads__main">
                  <span className="vr-downloads__name" title={download.filename}>
                    {download.filename}
                  </span>
                  <span className="vr-downloads__meta">{downloadStatusText(download)}</span>
                  {running ? (
                    <div
                      className="vr-downloads__bar"
                      role="progressbar"
                      aria-label={`Downloading ${download.filename}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent == null ? undefined : percent}
                      aria-valuetext={downloadProgressLabel(download)}
                    >
                      <span
                        className={percent == null ? "is-indeterminate" : ""}
                        style={percent == null ? undefined : { width: `${percent}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                <span className="vr-downloads__actions">
                  {running ? (
                    <button
                      type="button"
                      aria-label={`Cancel ${download.filename}`}
                      title="Cancel download"
                      onClick={() =>
                        runAction(
                          () => cancelAndroidDownload(download.id),
                          "This download could not be cancelled."
                        )
                      }
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  {download.canRetry ? (
                    <button
                      type="button"
                      aria-label={`Retry ${download.filename}`}
                      title="Retry download"
                      onClick={() =>
                        runAction(
                          () => retryAndroidDownload(download.id),
                          "This download could not be retried. Start it again from the app."
                        )
                      }
                    >
                      <ArrowClockwise size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  {download.status === "completed" && download.canOpen ? (
                    <button
                      type="button"
                      aria-label={`Open ${download.filename}`}
                      title="Open file"
                      onClick={() =>
                        runAction(
                          () => openAndroidDownload(download.id),
                          "No app on this device can open this file."
                        )
                      }
                    >
                      <DownloadSimple size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
