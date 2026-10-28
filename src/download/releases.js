export const WEBSITE_URL = "https://vups-router-three.vercel.app/";

export const RELEASE_STATUS = {
  available: { label: "Available", tone: "ready" },
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
    target: "Windows desktop build in progress",
    install: [
      "The Windows build is configured around the existing VupsRouter web client.",
      "When a signed installer is published, this page will link the verified artifact and release notes.",
      "No executable is linked until it has actually been built and published."
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
    target: "Android package not yet published",
    install: [
      "The Android project uses Capacitor around the same React client.",
      "When an APK or Play listing is published, this page will link the verified release.",
      "Android may ask you to allow installs from the download source if you install an APK outside Google Play."
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
    description: "A Windows frame around the live interface. The packaged installer is not published yet.",
    source: "Desktop mockup — real website content",
    image: "/previews/home-desktop.png",
    alt: "Desktop mockup showing the live VupsRouter website inside a Windows application frame."
  },
  {
    id: "android",
    category: "Android",
    title: "Close at hand.",
    description: "A phone-sized view of the live responsive interface. The Android package is not published yet.",
    source: "Mobile mockup — live responsive UI",
    image: "/previews/home-mobile.png",
    alt: "Phone mockup showing the live responsive VupsRouter website."
  }
];

export function statusFor(release) {
  return RELEASE_STATUS[release.status] || RELEASE_STATUS["not-published"];
}
