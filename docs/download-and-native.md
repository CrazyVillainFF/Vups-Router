# Download center and native shells

## Web

- Route: `/download`
- Release data: `src/download/releases.js`
- Preview assets: `public/previews/`
- PWA manifest: `public/manifest.webmanifest`
- Service worker: `public/sw.js`
- Offline fallback: `public/offline.html`

The service worker only caches same-origin GET requests. It deliberately skips `/api/`, so authenticated conversations, settings, and credentials are never placed in the app cache. Navigations are network-first with a cached page or offline fallback.

The manifest and PWA use the production website. Installability still depends on browser support and HTTPS.

## Native entry, authentication, and attachments

- Windows opens `https://vups-router-three.vercel.app/chat?native=windows`.
- Android opens `https://vups-router-three.vercel.app/chat?native=android`.
- The `native` query is stored in session storage so it survives the `/signin` redirect. The native flag hides marketing navigation and keeps the app on chat and settings.
- Sign-in and account creation happen inside the same-origin WebView. That preserves the first-party HTTP-only session cookie. Opening sign-in in an external browser would not share that cookie with the app.
- The Windows composer adds individual-file and folder pickers. Files are read only after the operating-system picker returns them, and text contents remain in memory until the user sends the message.
- The Android composer adds a camera control using `<input type="file" accept="image/*" capture="environment">` plus the system file picker. Camera access is requested by Android only when the control is tapped; the app does not request broad storage permission.
- Images use the existing image payload. Text and source files are sent as delimited reference content in the final user message. Supported examples: `.txt`, `.md`, `.json`, `.js`, `.ts`, `.jsx`, `.tsx`, `.css`, `.html`, `.py`, `.go`, `.rs`, `.java`, `.sql`, `.yml`, `.yaml`, `.toml`, `.csv`, `.log`.

### Windows permission modes

The composer exposes `Ask me every time` (default), `Agent (workspace)`, and `Full access`.

- `Ask me every time` requires approval before any attached local file is sent.
- `Agent (workspace)` auto-sends files selected through the folder picker, but asks for individual file picks.
- `Full access` requires a separate warning confirmation before it is enabled, then sends any attached file without another prompt.

These modes currently control attached file contents only. This repository has no local shell, command-execution, or file-write tool bridge, and the backend has no local-tool loop. The native UI states that these capabilities are unavailable instead of pretending to enforce them. Implementing real agent execution would require a separate tool protocol, approvals, sandboxing, and backend support.

## Release truthfulness

`DOWNLOADS.windows` and `DOWNLOADS.android` are the honest "nothing verified yet" defaults: `downloadUrl: null`, pending status. The Download page overlays them with the live response from `https://api.github.com/repos/CrazyVillainFF/Vups-Router/releases/latest`, and a download button appears only when that release actually carries the expected asset. A 404 (no release) or a missing asset renders as "Not published yet"; a failed lookup offers a retry instead of inventing state. Asset URLs are only accepted when they are `https://github.com/CrazyVillainFF/Vups-Router/releases/download/...`, so a foreign URL in that payload can never become a link.

Release assets are named without the version — `VupsRouter-windows-x64-setup.exe`, `VupsRouter-windows-x64.msi`, `VupsRouter-android-test-debug.apk`, `VupsRouter-android-release.apk` — so `https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/<name>` stays a permanent link and the README, the app, and CI reference the same strings (a test compares all three).

To publish a release:

1. Commit the change, then push a `v<version>` tag at that commit. `native-builds.yml` runs the tests, builds the web bundle, builds the Windows NSIS + MSI installers and the Android debug APK, and publishes them as a GitHub Release with `SHA256SUMS.txt`. The notes are generated from the assets that actually attached, and a job that fails does not stop the other platform's artifact from being published.
2. `github-release` needs write access on the build token. If it fails with "Resource not accessible by integration", set **Settings → Actions → General → Workflow permissions → Read and write permissions**, then re-run the workflow from **Actions → Native builds → Run workflow** with the tag filled in (that input exists precisely so a release can be republished without a new tag).
3. Open the release, download each asset, and install it on a real machine (Windows: run the installer and sign in; Android: install the APK and launch `MainActivity`). Only the download page may change after this verification passes.
4. `src/download/releases.js` needs no per-release edits: it derives version, size, publish date, notes link, and download URL from the release. Unsigned installers must still say so in the UI, exactly as the README does.
5. Update the manifest screenshots or preview assets if the interface changed.
5. Run `npm test` and `npm run build`.

## Windows / Tauri

The Tauri configuration is in `src-tauri/`. The Windows window does not load the website: `desktop_server.rs` binds a loopback-only `127.0.0.1` server on a random port, serves the UI from the bundled `dist` through Tauri's asset resolver, proxies `/api/*` to the production backend origin, and opens `http://127.0.0.1:<port>/chat?native=windows`. That keeps `/api` same-origin so the HTTP-only `vr_session` cookie stays first-party inside the shell, and it means UI changes reach Windows only through a rebuilt installer. Android does the opposite and loads the live production URL (`capacitor.config.json` → `server.url`) for the same first-party-cookie reason.

Prerequisites:

- Node.js 22+
- Rust via `rustup`
- Visual Studio Build Tools with the Desktop development with C++ workload
- WebView2 runtime (included with current Windows releases)

Commands:

```powershell
npm ci
npm run build
npm run tauri:build
```

Outputs are produced under `src-tauri/target/release/bundle/`. Code signing is not configured. Production distribution should use a signed installer and should record the certificate identity and release notes before adding the URL to `releases.js`.

Current environment status: Rustup 1.29.1, Rust 1.99.1 MSVC, and the Visual Studio C++ workload are installed. `npm run tauri:build` produced NSIS and MSI installers and the app launched against the live production homepage before the direct-chat route was added. The installers are unsigned. Rebuild and re-test after deployment of the native chat UI.

## Android / Capacitor

The Capacitor project is in `android/`. It uses app id `com.vupsrouter.app` and the same production URL for the same session-cookie reason described above. This is a native Capacitor shell around the real VupsRouter interface, not an APK-labelled shortcut.

Prerequisites:

- JDK 21
- Android SDK with the required platform and build tools
- `JAVA_HOME` and `ANDROID_HOME` configured

Commands:

```powershell
npm ci
npm run build
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

Debug APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

CI publishes this file as `VupsRouter-android-test-debug.apk` and runs `apksigner verify --print-certs` on it first, so an unpublished or corrupt package cannot reach the release.

For a Play Store release, create a private keystore outside the repository and sign with it. `android/app/build.gradle` reads the release signing configuration from the `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` environment variables and stays unsigned when they are absent, so no build ever silently falls back to the debug key. Never commit a keystore, signing key, or password.

Release artifacts are published by `.github/workflows/native-builds.yml`: pushing a `v*` tag builds the Windows NSIS + MSI installers and the Android debug APK, then `github-release` creates the tag's Release with those assets under their version-free names plus a `SHA256SUMS.txt`. A signed `VupsRouter-android-release.apk` is added only when all four repository secrets — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — are set; the `signing-available` job reports presence without echoing any value and skips that build when they are not.

The Android jobs use the Android SDK that ships with the GitHub-hosted ubuntu image and install `platforms;android-35` / `build-tools;35.0.0` through the image's own `sdkmanager`, and the step prints `ANDROID_HOME`, the Java version, and the installed packages on failure. The third-party `android-actions/setup-android` step was removed after it failed the job before Gradle ever ran.

Current environment status: the debug APK builds with Gradle 8.11.1 and JDK 21. The emulator's DNS now resolves the production host, the APK installs, and `MainActivity` launches. Rendered in-app UI verification remains incomplete because qemu crashed during `adb screencap` and a system UI ANR overlay obscured the last captured state. Accessibility-based verification and a physical-device pass remain required.

## Offline and failure behaviour

- Web: cached navigations and an offline page; `/api/` stays uncached and fails visibly.
- Windows shell: the interface is local to the installer, but `/api` is proxied to the production backend, so chat and sign-in fail without a network connection. The WebView shows the request failure rather than a fabricated cached conversation.
- Android shell: it loads the live production URL, so offline shows the WebView network error rather than a fabricated cached conversation.
- No provider API key is embedded in the desktop or Android project.

## Update flow

- Web: service-worker cache version is in `public/sw.js`; bump it when cache semantics change. Hashed Vite assets are cached at runtime; navigation is network-first, so a new deployment is picked up online.
- Windows/Android: bump `package.json`, `src-tauri/tauri.conf.json`, and `android/app/build.gradle` (`versionName` and `versionCode`, which must increase or existing installs cannot upgrade), then push the matching `v*` tag. The published asset names do not change, so every `releases/latest/download/...` link starts serving the new build on its own; the README and the Download page need no edit per release.
