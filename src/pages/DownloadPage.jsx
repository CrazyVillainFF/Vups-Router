import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Dialog, IconButton } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Globe2,
  LockKeyhole,
  MonitorDown,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X
} from "lucide-react";

import PageMeta from "../components/PageMeta.jsx";
import SiteHeader from "../components/SiteHeader.jsx";
import LandingFooter from "../components/LandingFooter.jsx";
import { Reveal, StaggerGroup, StaggerItem } from "../components/motion/primitives.jsx";
import PreviewVisual from "../download/PreviewVisual.jsx";
import usePwaInstall from "../download/usePwaInstall.js";
import { DOWNLOADS, PREVIEWS, WEBSITE_URL, statusFor } from "../download/releases.js";
import "../styles/download.css";

function StatusPill({ release }) {
  const status = statusFor(release);
  return <span className={`dl-status dl-status--${status.tone}`}><i aria-hidden="true" />{status.label}</span>;
}

function PlatformIcon({ platform }) {
  if (platform === "windows") return <MonitorDown size={22} />;
  if (platform === "android") return <Smartphone size={22} />;
  return <Globe2 size={22} />;
}

function DownloadCard({ id, platform, release, installButton }) {
  const hasArtifact = Boolean(release.downloadUrl);
  return (
    <StaggerItem as="article" className="dl-card" id={id}>
      <div className="dl-card__top">
        <span className="dl-card__icon"><PlatformIcon platform={platform} /></span>
        <StatusPill release={release} />
      </div>
      <h3>{release.title}</h3>
      <p>{release.description}</p>

      <dl className="dl-card__facts">
        <div><dt>Version</dt><dd>{release.version || "Not published"}</dd></div>
        <div><dt>Architecture</dt><dd>{release.architecture || "Pending build"}</dd></div>
        <div><dt>Format</dt><dd>{release.format || "Not published"}</dd></div>
        <div><dt>Size</dt><dd>{release.fileSize || "Not published"}</dd></div>
      </dl>

      <div className="dl-card__action">
        {installButton || (
          hasArtifact ? (
            <a className="dl-btn dl-btn--primary" href={release.downloadUrl} target="_blank" rel="noreferrer">
              <Download size={16} /> Download
            </a>
          ) : (
            <button className="dl-btn dl-btn--disabled" type="button" disabled>
              <X size={15} /> {release.status === "coming-soon" ? "Build not published yet" : "Unavailable"}
            </button>
          )
        )}
      </div>

      <div className="dl-card__notes">
        <span className="dl-mono dl-card__notes-title">INSTALL NOTES</span>
        <ul>
          {release.install.map(note => <li key={note}>{note}</li>)}
        </ul>
        {release.releaseNotesUrl
          ? <a className="dl-inline-link" href={release.releaseNotesUrl} target="_blank" rel="noreferrer">Release notes <ExternalLink size={13} /></a>
          : <span className="dl-card__muted">Release notes will be linked only after the artifact is published.</span>}
      </div>
      <span className="dl-card__target">{release.target}</span>
    </StaggerItem>
  );
}

export default function DownloadPage() {
  const [activePreview, setActivePreview] = useState(null);
  const [installMessage, setInstallMessage] = useState("");
  const { canInstall, installed, busy, install } = usePwaInstall();
  const windows = DOWNLOADS.windows;
  const android = DOWNLOADS.android;
  const web = DOWNLOADS.web;

  const installCopy = useMemo(() => {
    if (installed) return "VupsRouter is already installed on this device.";
    if (canInstall) return "Install the VupsRouter web app from this browser.";
    return "This browser has not offered an install prompt. Open the browser menu and choose Install app or Add to Home Screen.";
  }, [canInstall, installed]);

  async function handleInstall() {
    if (installed) {
      setInstallMessage("VupsRouter is already installed on this device.");
      return;
    }
    if (!canInstall) {
      setInstallMessage("Open your browser menu and choose Install app or Add to Home Screen. Safari uses Share > Add to Home Screen.");
      return;
    }
    const result = await install();
    if (result === "accepted") setInstallMessage("Installation accepted. VupsRouter will appear with your apps.");
    else if (result === "dismissed") setInstallMessage("Installation was dismissed. You can try again from this page or your browser menu.");
    else setInstallMessage("The install prompt is unavailable right now. Use your browser menu instead.");
  }

  return (
    <div className="dl-page">
      <PageMeta
        title="Download VupsRouter — Windows, Android, and Web"
        description="Download VupsRouter for Windows, get the Android app status, or install the VupsRouter web app. Release states are published honestly."
      />
      <SiteHeader />

      <main>
        <section className="dl-hero" aria-labelledby="download-title">
          <span className="dl-hero__grid" aria-hidden="true" />
          <span className="dl-hero__glow" aria-hidden="true" />
          <div className="dl-wrap">
            <Reveal className="dl-hero__copy">
              <div className="dl-kicker"><span /> DOWNLOAD CENTER <b>WEB · DESKTOP · ANDROID</b></div>
              <h1 id="download-title">
                Your AI workspace.<br />
                <em>Every device.</em> One experience.
              </h1>
              <p>
                Bring VupsRouter to your desktop, install it on your phone, and keep your AI workspace close wherever
                you work. Release states below are real, not decorative.
              </p>
              <div className="dl-hero__actions">
                <a className="dl-btn dl-btn--primary" href="#windows">
                  <MonitorDown size={17} /> Windows build status <ArrowRight size={15} />
                </a>
                <a className="dl-btn" href="#android">
                  <Smartphone size={17} /> Android build status
                </a>
                <button className="dl-btn dl-btn--quiet" type="button" onClick={handleInstall}>
                  <Globe2 size={17} /> {installed ? "Web app installed" : canInstall ? "Install web app" : "Web install steps"}
                </button>
              </div>
              <div className="dl-hero__meta" aria-label="Download availability">
                <span><i className="dl-dot dl-dot--ready" /> Web app available</span>
                <span><i className="dl-dot dl-dot--pending" /> Windows build pending</span>
                <span><i className="dl-dot dl-dot--pending" /> Android build pending</span>
              </div>
              <p className="dl-install-note" role="status" aria-live="polite">
                {installMessage || installCopy}
              </p>
            </Reveal>

            <Reveal className="dl-hero__signal" delay={0.08}>
              <div className="dl-signal-card">
                <span className="dl-mono">VUPSROUTER / RELEASE CHANNEL</span>
                <strong>Web first. Desktop next.</strong>
                <p>No fake installer links. A platform is marked available only when its artifact or install path exists.</p>
                <div className="dl-signal-card__rows">
                  <span><Check size={13} /> Same backend and account</span>
                  <span><LockKeyhole size={13} /> No keys in app bundles</span>
                  <span><ShieldCheck size={13} /> Verified artifacts only</span>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="dl-section dl-previews" id="inside" aria-labelledby="inside-title">
          <div className="dl-wrap">
            <Reveal as="header" className="dl-section__head">
              <div>
                <span className="dl-mono dl-eyebrow">02 / INTERFACE</span>
                <h2 id="inside-title">Inside <em>VupsRouter</em></h2>
              </div>
              <p>Explore the workspace before you install. Screenshot-backed previews and clearly labeled interface mockups.</p>
            </Reveal>

            <StaggerGroup className="dl-preview-grid" trigger="view" stagger={0.06}>
              {PREVIEWS.map(preview => (
                <StaggerItem as="article" className="dl-preview" key={preview.id}>
                  <button
                    className="dl-preview__frame"
                    type="button"
                    onClick={() => setActivePreview(preview)}
                    aria-label={`Enlarge ${preview.category} preview`}
                  >
                    <PreviewVisual id={preview.id} image={preview.image} alt={preview.alt} />
                    <span className="dl-preview__expand" aria-hidden="true"><ExternalLink size={14} /></span>
                  </button>
                  <div className="dl-preview__body">
                    <span className="dl-preview__category">{preview.category}</span>
                    <h3>{preview.title}</h3>
                    <p>{preview.description}</p>
                    <span className="dl-preview__source">{preview.source}</span>
                  </div>
                </StaggerItem>
              ))}
            </StaggerGroup>
          </div>
        </section>

        <section className="dl-section dl-downloads" id="downloads" aria-labelledby="downloads-title">
          <div className="dl-wrap">
            <Reveal as="header" className="dl-section__head">
              <div>
                <span className="dl-mono dl-eyebrow">03 / INSTALL</span>
                <h2 id="downloads-title">Choose your <em>surface.</em></h2>
              </div>
              <p>Three paths, one account. Web is available now. Windows and Android are configured, but no package is published from this page yet.</p>
            </Reveal>

            <StaggerGroup className="dl-card-grid" trigger="view" stagger={0.08}>
              <DownloadCard id="windows" platform="windows" release={windows} />
              <DownloadCard id="android" platform="android" release={android} />
              <DownloadCard
                id="web"
                platform="web"
                release={web}
                installButton={(
                  <div className="dl-card__button-stack">
                    <button className="dl-btn dl-btn--primary" type="button" onClick={handleInstall} disabled={busy || installed}>
                      <Download size={16} /> {installed ? "Installed on this device" : busy ? "Opening install…" : canInstall ? "Install Web App" : "See install steps"}
                    </button>
                    <a className="dl-btn" href={WEBSITE_URL} target="_blank" rel="noreferrer">
                      Open web app <ExternalLink size={14} />
                    </a>
                  </div>
                )}
              />
            </StaggerGroup>

            <Reveal className="dl-warning" role="note">
              <ShieldCheck size={18} />
              <div>
                <strong>No placeholder downloads.</strong>
                <p>Windows and Android will stay in a pending state until a real, tested package exists. The web app remains available and does not require an installer.</p>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="dl-section dl-closing" aria-labelledby="closing-title">
          <div className="dl-wrap dl-closing__inner">
            <Reveal>
              <span className="dl-mono dl-eyebrow">04 / SAME WORKSPACE</span>
              <h2 id="closing-title">Start on the web.<br /><em>Keep the thread.</em></h2>
              <p>Sessions, saved conversations, model routing, and provider keys stay on the existing VupsRouter backend. A new surface should never mean a separate product.</p>
              <div className="dl-hero__actions">
                <Link className="dl-btn dl-btn--primary" to="/chat">Open AI chat <ArrowRight size={15} /></Link>
                <Link className="dl-btn" to="/features">What is built</Link>
              </div>
            </Reveal>
            <Reveal className="dl-closing__mark" delay={0.08}>
              <span><Sparkles size={22} /></span>
              <b>One account.<br />More ways in.</b>
              <small>WEB · WINDOWS · ANDROID</small>
            </Reveal>
          </div>
        </section>
      </main>

      <LandingFooter />

      <Dialog
        open={Boolean(activePreview)}
        onClose={() => setActivePreview(null)}
        maxWidth="lg"
        fullWidth
        PaperProps={{ className: "dl-lightbox" }}
        aria-labelledby="dl-lightbox-title"
      >
        {activePreview && (
          <div className="dl-lightbox__inner">
            <div className="dl-lightbox__bar">
              <div>
                <span className="dl-mono">{activePreview.category}</span>
                <h2 id="dl-lightbox-title">{activePreview.title}</h2>
              </div>
              <IconButton aria-label="Close preview" onClick={() => setActivePreview(null)}>
                <CloseRoundedIcon />
              </IconButton>
            </div>
            <div className="dl-lightbox__body">
              <PreviewVisual
                id={activePreview.id}
                image={activePreview.image}
                alt={activePreview.alt}
                enlarged
              />
            </div>
            <p className="dl-lightbox__caption">
              <span>{activePreview.source}</span> {activePreview.description}
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
