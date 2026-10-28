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

## Release truthfulness

`DOWNLOADS.windows` and `DOWNLOADS.android` remain `coming-soon` with `downloadUrl: null` until a tested package is published. Do not add an installer or APK URL before the artifact exists. The Download page and tests enforce this state.

To publish a release:

1. Build and test the artifact.
2. Publish it through GitHub Releases or another stable channel.
3. Put the real HTTPS URL and verified version, architecture, format, size, and release-notes URL in `src/download/releases.js`.
4. Update the manifest screenshots or preview assets if the interface changed.
5. Run `npm test` and `npm run build`.

## Windows / Tauri

The Tauri configuration is in `src-tauri/`. It opens the live production VupsRouter workspace in a dedicated window. This remote-shell choice is deliberate: the current authentication contract uses a first-party HTTP-only cookie at `https://vups-router-three.vercel.app`, and the API is served through the same-origin Vercel proxy. Loading a bundled `tauri://` origin would make `/api` relative to the app origin and break sessions.

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

Current environment status: Rust/Cargo are not installed, so the Windows installer was not built or tested.

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

For a Play Store release, create a private keystore outside the repository, configure `android/keystore.properties` locally, and run a signed release build or bundle. Never commit a keystore password, signing key, or `keystore.properties`.

Current environment status: the debug APK built successfully with Gradle 8.11.1 and JDK 21. The emulator launched the app, but the emulator had no working DNS/network (`ping` returned `unknown host`), so the remote workspace could not be runtime-verified there. Device/emulator testing on a working network remains required.

## Offline and failure behaviour

- Web: cached navigations and an offline page; `/api/` stays uncached and fails visibly.
- Android/Windows remote shells: they require a network connection because the release intentionally loads the live same-origin session surface. If offline, the operating system/WebView shows a network failure rather than a fabricated cached conversation.
- No provider API key is embedded in the desktop or Android project.

## Update flow

- Web: service-worker cache version is in `public/sw.js`; bump it when cache semantics change. Hashed Vite assets are cached at runtime; navigation is network-first, so a new deployment is picked up online.
- Windows/Android: update `tauri.conf.json` and `android/app/build.gradle` versions, rebuild, test, and publish the new signed artifact. The Download page should only change `releases.js` after the artifact is available.
