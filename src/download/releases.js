export const WEBSITE_URL = "https://vups-router-three.vercel.app/";

export const RELEASE_REPO = "CrazyVillainFF/Vups-Router";
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPO}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_PAGE_URL}/latest`;
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

// These names must match the *_ASSET values in
// .github/workflows/native-builds.yml; they are what makes releases/latest
// downloadable without knowing the version.
export const RELEASE_ASSETS = {
  windowsInstaller: "VupsRouter-windows-x64-setup.exe",
  windowsMsi: "VupsRouter-windows-x64.msi",
  androidReleaseApk: "VupsRouter-android-release.apk",
  androidDebugApk: "VupsRouter-android-test-debug.apk"
};

export const RELEASE_STATUS = {
  available: { label: "Available", tone: "ready" },
  "test-build": { label: "Test build · debug-signed", tone: "pending" },
  "coming-soon": { label: "Coming soon", tone: "pending" },
  "not-published": { label: "Build not published yet", tone: "pending" },
  unsupported: { label: "Unsupported on this device", tone: "muted" }
};

export const DOWNLOADS = {
  windows: {
    status: "coming-soon",
    title: "VupsRouter for Windows",
    description: "Your AI workspace in a dedicated desktop app.",
    version: null,
    architecture: null,
    format: null,
    fileSize: null,
    downloadUrl: null,
    releaseNotesUrl: null,
    target: "No published release asset verified yet",
    install: [
      "The Windows app is a Tauri shell that serves the bundled client and calls the hosted VupsRouter API.",
      "Pushing a version tag builds and attaches both installers in CI; this page reads that release live.",
      "Until the release asset is verified, no installer link is shown here."
    ]
  },
  android: {
    status: "coming-soon",
    title: "VupsRouter for Android",
    description: "Access your AI workspace from your Android device.",
    version: null,
    architecture: null,
    format: null,
    fileSize: null,
    downloadUrl: null,
    releaseNotesUrl: null,
    target: "No published release asset verified yet",
    install: [
      "The Android app is a Capacitor shell around the live VupsRouter site.",
      "CI publishes whatever the signing secrets allow: a release APK when configured, otherwise a debug test build.",
      "Android asks you to allow installs from this source when you sideload an APK outside Google Play."
    ]
  },
  web: {
    status: "available",
    title: "VupsRouter Web App",
    description: "Install the web experience on supported devices.",
    version: "1.0.0",
    architecture: "Web",
    format: "PWA",
    fileSize: null,
    downloadUrl: WEBSITE_URL,
    releaseNotesUrl: null,
    target: "Works in current desktop and mobile browsers",
    install: [
      "Choose Install Web App when your browser offers the install prompt.",
      "Otherwise open the browser menu and choose Install app or Add to Home Screen.",
      "The web app uses the same VupsRouter backend and does not need a separate installer."
    ]
  }
};

export const PREVIEWS = [
  {
    id: "home",
    category: "Home",
    title: "Your AI workspace.",
    description: "The real VupsRouter landing page, with the same dark navy system and blue accents.",
    source: "Live product screenshot",
    image: "/previews/home-desktop.png",
    alt: "Screenshot of the live VupsRouter home page hero and navigation."
  },
  {
    id: "chat",
    category: "AI Chat",
    title: "Chat with your models.",
    description: "A focused conversation surface with the active model, composer, and reply state in view.",
    source: "Conceptual interface preview",
    alt: "Conceptual preview of the VupsRouter chat workspace."
  },
  {
    id: "routing",
    category: "Model Routing",
    title: "Choose how you work.",
    description: "Saved provider keys and free models stay visible together, with the active route called out.",
    source: "Conceptual interface preview",
    alt: "Conceptual preview of the VupsRouter model chooser."
  },
  {
    id: "threads",
    category: "Saved Threads",
    title: "Pick up where you left off.",
    description: "Saved conversations stay in the workspace so a previous task is never a dead end.",
    source: "Conceptual interface preview",
    alt: "Conceptual preview of saved VupsRouter conversations."
  },
  {
    id: "desktop",
    category: "Desktop",
    title: "The workspace, in its own window.",
    description: "A Windows frame around the live interface, built as a Tauri desktop shell.",
    source: "Desktop mockup — real website content",
    image: "/previews/home-desktop.png",
    alt: "Desktop mockup showing the live VupsRouter website inside a Windows application frame."
  },
  {
    id: "android",
    category: "Android",
    title: "Close at hand.",
    description: "A phone-sized view of the live responsive interface, wrapped by the Capacitor app.",
    source: "Mobile mockup — live responsive UI",
    image: "/previews/home-mobile.png",
    alt: "Phone mockup showing the live responsive VupsRouter website."
  }
];

export function statusFor(release) {
  return RELEASE_STATUS[release.status] || RELEASE_STATUS["not-published"];
}

// --- live release data -------------------------------------------------------
// The static DOWNLOADS map above is the honest "nothing verified yet" state.
// GitHub's release API is merged over it at runtime, so the page, the README,
// and the published artifacts can never drift apart.

export function latestAssetDownloadUrl(assetName) {
  return `${LATEST_RELEASE_URL}/download/${assetName}`;
}

export function formatReleaseSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  const mb = value / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function releaseVersion(release) {
  const tag = String(release?.tag_name || "").trim();
  return tag ? tag.replace(/^v/i, "") : null;
}

export function releasePublishedDate(release) {
  const date = new Date(release?.published_at || release?.created_at || "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function releasePageUrl(release) {
  const url = String(release?.html_url || "");
  return url.startsWith(`${RELEASES_PAGE_URL}/`) ? url : null;
}

// Release payloads are remote input. Accept a download only when it is this
// repository's own release asset with the expected file name.
export function verifiedAsset(release, assetName) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find(item => item?.name === assetName);
  const url = String(asset?.browser_download_url || "");
  if (!url.startsWith(`https://github.com/${RELEASE_REPO}/releases/download/`)) return null;
  return { downloadUrl: url, fileSize: formatReleaseSize(asset.size) };
}

function pendingRelease(base, release, target) {
  return {
    ...base,
    status: release ? "not-published" : base.status,
    releaseNotesUrl: releasePageUrl(release),
    target: release ? target : base.target
  };
}

export function windowsRelease(release, base = DOWNLOADS.windows) {
  const asset = verifiedAsset(release, RELEASE_ASSETS.windowsInstaller);
  if (!asset) {
    return pendingRelease(base, release, `Not attached to ${releaseVersion(release) || "the latest release"} yet`);
  }
  const version = releaseVersion(release);
  return {
    ...base,
    status: "available",
    version,
    architecture: "Windows 10/11 · x64",
    format: "NSIS installer",
    fileSize: asset.fileSize,
    downloadUrl: asset.downloadUrl,
    releaseNotesUrl: releasePageUrl(release),
    publishedAt: releasePublishedDate(release),
    target: `One-click installer for 64-bit Windows`,
    install: [
      `Download VupsRouter-windows-x64-setup.exe (release ${version || "latest"}) and run it.`,
      "The installers are unsigned, so SmartScreen shows \"Windows protected your PC\": choose More info → Run anyway.",
      "Compare the file against the release's SHA256SUMS.txt before installing.",
      "The app appears in Start → VupsRouter and signs in on first launch; it needs internet for the API.",
      "Uninstall from Settings → Apps → VupsRouter."
    ]
  };
}

export function androidRelease(release, base = DOWNLOADS.android) {
  const signed = verifiedAsset(release, RELEASE_ASSETS.androidReleaseApk);
  const debug = verifiedAsset(release, RELEASE_ASSETS.androidDebugApk);
  const asset = signed || debug;
  if (!asset) {
    return pendingRelease(base, release, `No APK attached to ${releaseVersion(release) || "the latest release"} yet`);
  }
  const version = releaseVersion(release);
  return {
    ...base,
    status: signed ? "available" : "test-build",
    title: signed ? "VupsRouter for Android" : "VupsRouter for Android — test build",
    description: signed
      ? "Access your AI workspace from your Android device."
      : "A debug-signed APK for trying VupsRouter on a real device. Not a Play Store release.",
    version,
    architecture: "Android 6.0+ (API 23)",
    format: signed ? "APK · release-signed" : "APK · debug-signed",
    fileSize: asset.fileSize,
    downloadUrl: asset.downloadUrl,
    releaseNotesUrl: releasePageUrl(release),
    publishedAt: releasePublishedDate(release),
    target: signed
      ? "Release-signed APK for Android 6.0 and newer"
      : "Test build only: signed with the Android debug key, no Play listing",
    install: signed
      ? [
          `Download the APK from release ${version || "latest"} and open it on the device.`,
          "Android asks you to allow installs from this source; confirm once and the app installs.",
          "The app opens the live VupsRouter site, so it needs internet and always shows the current UI."
        ]
      : [
          "This APK is debug-signed: it is for testing, is not Play-Store eligible, and may be replaced by a signed build later.",
          `Download it from release ${version || "latest"}, open it, and allow installs from this source once.`,
          "Prefer no sideload? Use Chrome → Add to Home Screen on the web app instead.",
          "The APK opens the live VupsRouter site, so it always shows the current web UI."
        ]
  };
}

export function mergeLiveReleases(base, release) {
  return {
    windows: windowsRelease(release, base.windows),
    android: androidRelease(release, base.android),
    web: base.web
  };
}
