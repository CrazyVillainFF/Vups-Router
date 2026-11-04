import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CursorClick,
  Globe,
  Keyboard,
  ListBullets,
  Play
} from "@phosphor-icons/react";
import { isTauriRuntime } from "../../native/shell.js";
import { usePanel } from "./PanelContext.jsx";
import { toBrowserBounds } from "./panelModel.js";
import {
  browserClick,
  browserGoBack,
  browserGoForward,
  browserInspect,
  browserReload,
  browserScreenshot,
  browserScroll,
  browserStatus,
  browserType,
  closeBrowserTab,
  createBrowserTab,
  navigateBrowserTab,
  setBrowserBounds
} from "../panelBrowserBridge.js";

const TAB_ID = "panel-main";

export default function BrowserPane() {
  const { activeTab, open, width } = usePanel();
  const active = open && activeTab === "browser";

  const stageRef = useRef(null);
  const createdRef = useRef(false);
  const [created, setCreated] = useState(false);
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState(null);
  const [page, setPage] = useState(null);
  const [shot, setShot] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [selector, setSelector] = useState("");
  const [typeText, setTypeText] = useState("");

  const currentBounds = useCallback(
    visible => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return toBrowserBounds(rect, visible);
    },
    []
  );

  const sync = useCallback(
    visible => {
      if (!isTauriRuntime() || !createdRef.current) return;
      const bounds = currentBounds(visible);
      if (bounds) setBrowserBounds(TAB_ID, bounds).catch(() => {});
    },
    [currentBounds]
  );

  const go = useCallback(
    target => {
      const url = String(target || "").trim();
      if (!url) return;
      setError("");
      setAddress(url);
      setBusy("navigate");
      const bounds = currentBounds(true) || { x: 0, y: 0, width: 1, height: 1, visible: true };
      const run = createdRef.current
        ? navigateBrowserTab(TAB_ID, url).then(() => {
            sync(true);
          })
        : createBrowserTab(TAB_ID, url, bounds).then(() => {
            createdRef.current = true;
            setCreated(true);
            sync(true);
          });
      run
        .then(() => browserStatus(TAB_ID).then(next => setStatus(next)).catch(() => {}))
        .catch(navError => setError(navError.message))
        .finally(() => setBusy(""));
    },
    [currentBounds, sync]
  );

  // Show or hide the native surface as this tab gains or loses focus.
  useEffect(() => {
    sync(active);
  }, [active, width, created, sync]);

  // Keep the surface glued to its container while the browser tab is visible.
  useEffect(() => {
    if (!active || !isTauriRuntime()) return undefined;
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => sync(true));
    observer.observe(node);
    const onResize = () => sync(true);
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [active, sync]);

  // Refresh the title/url read-out while the tab is open.
  useEffect(() => {
    if (!active || !createdRef.current) return undefined;
    let stopped = false;
    const poll = () => browserStatus(TAB_ID).then(next => !stopped && setStatus(next)).catch(() => {});
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active, created]);

  useEffect(
    () => () => {
      if (createdRef.current && isTauriRuntime()) closeBrowserTab(TAB_ID).catch(() => {});
    },
    []
  );

  const inspect = () => {
    if (!createdRef.current) return;
    setBusy("inspect");
    setError("");
    browserInspect(TAB_ID)
      .then(result => setPage(result))
      .catch(inspectError => setError(inspectError.message))
      .finally(() => setBusy(""));
  };

  const capture = () => {
    if (!createdRef.current) return;
    const bounds = currentBounds(true);
    if (!bounds) return;
    setBusy("shot");
    setError("");
    browserScreenshot(TAB_ID, bounds.x, bounds.y, bounds.width, bounds.height)
      .then(dataUrl => setShot(dataUrl))
      .catch(shotError => setError(shotError.message))
      .finally(() => setBusy(""));
  };

  const act = (kind, selector, extra) => {
    if (!createdRef.current || !selector) return;
    setBusy(kind);
    setError("");
    const run =
      kind === "click"
        ? browserClick(TAB_ID, selector)
        : kind === "type"
          ? browserType(TAB_ID, selector, extra.text, extra.submit)
          : browserScroll(TAB_ID, selector, extra?.delta || 300);
    run
      .then(() => browserStatus(TAB_ID).then(next => setStatus(next)).catch(() => {}))
      .catch(actError => setError(actError.message))
      .finally(() => setBusy(""));
  };

  if (!isTauriRuntime()) {
    return <div className="vr-pane-note">The browser tab is available in the Windows app.</div>;
  }

  return (
    <div className="vr-browser-pane">
      <form
        className="vr-browser-bar"
        onSubmit={event => {
          event.preventDefault();
          go(address);
        }}
      >
        <button type="button" className="vr-icon-btn" aria-label="Back" disabled={!created} onClick={() => browserGoBack(TAB_ID).catch(e => setError(e.message))}>
          <ArrowLeft size={15} />
        </button>
        <button type="button" className="vr-icon-btn" aria-label="Forward" disabled={!created} onClick={() => browserGoForward(TAB_ID).catch(e => setError(e.message))}>
          <ArrowRight size={15} />
        </button>
        <button type="button" className="vr-icon-btn" aria-label="Reload" disabled={!created} onClick={() => browserReload(TAB_ID).catch(e => setError(e.message))}>
          <Play size={13} />
        </button>
        <input
          type="text"
          value={address}
          onChange={event => setAddress(event.target.value)}
          placeholder="Enter a web address"
          aria-label="Web address"
          spellCheck={false}
        />
        <button type="submit" className="vr-panel-action" disabled={busy === "navigate"}>
          <Globe size={14} aria-hidden="true" /> {busy === "navigate" ? "Loading…" : "Go"}
        </button>
      </form>

      <div className="vr-browser-tools">
        <button type="button" className="vr-panel-action" disabled={!created || busy === "inspect"} onClick={inspect}>
          <ListBullets size={13} aria-hidden="true" /> Read page
        </button>
        <button type="button" className="vr-panel-action" disabled={!created || busy === "shot"} onClick={capture}>
          <Camera size={13} aria-hidden="true" /> Screenshot
        </button>
      </div>

      {error ? <div className="vr-inline-error">{error}</div> : null}
      {status?.title ? <div className="vr-browser-status" title={status.url}>{status.title}</div> : null}

      <div className="vr-browser-stage" ref={stageRef}>
        {!created ? (
          <div className="vr-pane-note">Type an address and press Go to open a real page in this tab.</div>
        ) : null}
      </div>

      {shot ? <img className="vr-browser-shot" src={shot} alt="Page screenshot" /> : null}

      {page ? (
        <div className="vr-browser-inspect">
          <h4>Structure</h4>
          {page.headings?.length ? (
            <ul className="vr-inspect-headings">
              {page.headings.map((h, i) => (
                <li key={`h-${i}`} data-level={h.level}>{h.text}</li>
              ))}
            </ul>
          ) : null}
          {page.links?.length ? (
            <div className="vr-inspect-links">
              <strong>Links</strong>
              <ul>
                {page.links.map((link, i) => (
                  <li key={`l-${i}`}>
                    <button type="button" className="vr-link-btn" onClick={() => go(link.href)}>
                      {link.text || link.href}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="vr-inspect-act">
            <input
              type="text"
              value={selector}
              onChange={event => setSelector(event.target.value)}
              placeholder="CSS selector"
              aria-label="Element selector"
              spellCheck={false}
            />
            <button type="button" className="vr-panel-action" disabled={!selector} onClick={() => act("click", selector)}>
              <CursorClick size={13} aria-hidden="true" /> Click
            </button>
            <button type="button" className="vr-panel-action" disabled={!selector} onClick={() => act("scroll", selector, { delta: 300 })}>
              Scroll
            </button>
          </div>
          <div className="vr-inspect-act">
            <input
              type="text"
              value={typeText}
              onChange={event => setTypeText(event.target.value)}
              placeholder="Text to enter"
              aria-label="Text to enter"
              spellCheck={false}
            />
            <button
              type="button"
              className="vr-panel-action"
              disabled={!selector}
              onClick={() => act("type", selector, { text: typeText, submit: false })}
            >
              <Keyboard size={13} aria-hidden="true" /> Type
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
