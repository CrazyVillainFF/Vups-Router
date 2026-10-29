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

The Windows composer adds a read-only filesystem tool loop: `get_windows_known_folder`, `list_directory`, `list_recent_files`, `read_file`, `search_files`, and `read_file_metadata`, driven by `POST /api/chat/desktop-tools` in `src/services/desktopChat.js`. There is no local shell, command-execution, or file-write tool, so "agent execution" means the model reading files the permission mode allows — not running anything on the machine.

### Inline folder approval

A protected read pauses in the native layer and opens a card in the chat column (`src/native/InChatPermissionCard.jsx`) titled `VupsRouter wants to access <folder>`, naming the operation (`List filenames and read file metadata`), the exact folder path, and `Waiting for approval` until a button is pressed. The three actions are `Allow once`, `Always allow for this folder`, and `Deny`; the contents of a single file only ever offers `Allow once`, because a file read must not widen into a folder grant. The same request arriving twice joins the pending approval instead of opening a second card, and the native layer resolves each request exactly once (`src-tauri/src/desktop_tools.rs`).

- Nothing is granted by the UI. `respond_desktop_tool_approval` carries the decision by request id, the tool operation resumes from the blocked call inside the same task, and only its result message sets `Running` → `Completed` / `Failed` in the progress line. Denial cancels the operation before it touches the filesystem.
- `Always allow` persists a folder path plus a `read` scope in `desktop-tool-grants.json` under the app data dir — no keys, no file contents — and is listed with a `Revoke` action per row in **Settings → Folder access**. Revoking also clears the in-memory grants inside that folder.
- Folder containment compares canonical paths component by component, case-insensitively, so a sibling or parent of an approved folder is never treated as covered.
- Unanswered requests expire after 120 seconds, and closing the composer or stopping the turn cancels pending approvals natively instead of leaving them live.

Known folders come from the Windows shell (`dirs` → `SHGetKnownFolderPath`), so a redirected or OneDrive-moved Downloads resolves to the real location instead of a hardcoded `C:\Users\<name>\Downloads`. Windows verbatim prefixes (`\\?\…`) produced by `fs::canonicalize` are stripped before any path reaches a card, a tool result, or the transcript.

### Failure codes are not permission prompts

`io_failure()` keeps the operating-system description in the message the model and the user see (for example `Access is denied. (os error 5)`) and logs kind, raw OS error and detail to stderr — never file contents. The code decides the wording: `path_not_found`, `access_denied`, `invalid_path`, `not_a_directory`, `not_a_file`, `sensitive_file`, `network_path_rejected`, `symlink_rejected`, `approval_denied`, `grant_store_failed`, `filesystem_error`.

An app-level consent decision and a Windows ACL are different things, and the product never blurs them: no string in the client or in `DESKTOP_TOOL_PROMPT` tells anyone to open folder Properties → Security, change NTFS permissions, take ownership, elevate, or disable a protection. Only the `access_denied` code may be described as a Windows refusal, and it states that the app made no permission changes. `path_not_found` is reported as a missing folder, `approval_denied` as the user's own decision, and the server prompt additionally forbids re-running a tool whose answer is already in the conversation.

If the model call fails after the filesystem work succeeded, `attachLocalResults()` keeps the real rows (`error.localSummary`) and the turn renders them instead of discarding the listing; a run made only of failures is never marked as a completed read.

That endpoint only exists in the backend source on `feat/backend-plugins-and-openrouter`. A server build without it answers `404 "That API route does not exist."`, which `requestError()` reports as `desktop_tools_unavailable`; the chat page then resends the same prompt and model through the normal streaming endpoint instead of failing the turn. The skipped-tools notice is only shown when a project folder was selected, because that is the only case where tools were the point of the message — a plain question on a server without the endpoint sends no warning card at all. The first such 404 is remembered in `sessionStorage` (`vr.desktopToolsMissing`), so later turns in the same app session go straight to the streaming endpoint; the next launch probes again, which means a redeployed backend starts using tools without the user clearing anything. The published backend must still be redeployed for the tools themselves to work — see the note under "Offline and failure behaviour".

## Release truthfulness

`DOWNLOADS.windows` and `DOWNLOADS.android` are the honest "nothing verified yet" defaults: `downloadUrl: null`, pending status. The Download page overlays them with the live response from `https://api.github.com/repos/CrazyVillainFF/Vups-Router/releases/latest`, and a download button appears only when that release actually carries the expected asset. A 404 (no release) or a missing asset renders as "Not published yet"; a failed lookup offers a retry instead of inventing state. Asset URLs are only accepted when they are `https://github.com/CrazyVillainFF/Vups-Router/releases/download/...`, so a foreign URL in that payload can never become a link.

Release assets are named without the version — `VupsRouter-windows-x64-setup.exe`, `VupsRouter-windows-x64.msi`, `VupsRouter-android-test-debug.apk`, `VupsRouter-android-release.apk` — so `https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/<name>` stays a permanent link and the README, the app, and CI reference the same strings (a test compares all three).

To publish a release:

1. Commit the change, then push a `v<version>` tag at that commit. `native-builds.yml` runs the tests, builds the web bundle, builds the Windows NSIS + MSI installers and the Android debug APK, and publishes them as a GitHub Release with `SHA256SUMS.txt`. The notes are generated from the assets that actually attached, and a job that fails does not stop the other platform's artifact from being published.
2. `github-release` needs write access on the build token. If it fails with "Resource not accessible by integration", set **Settings → Actions → General → Workflow permissions → Read and write permissions**, then re-run the workflow from **Actions → Native builds → Run workflow** with the tag filled in (that input exists precisely so a release can be republished without a new tag).
3. Open the release, download each asset, and install it on a real machine (Windows: run the installer and sign in; Android: install the APK and launch `MainActivity`). Only the download page may change after this verification passes.
4. `src/download/releases.js` needs no per-release edits: it derives version, size, publish date, notes link, and download URL from the release. Unsigned installers must still say so in the UI, exactly as the README does.
5. Update the manifest screenshots or preview assets if the interface changed.
6. Run `npm test` and `npm run build`.

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

Outputs are produced under `src-tauri/target/release/bundle/`.

### Windows code signing

Signing is wired up and gated, but **no certificate is configured yet**, so every installer published to date is unsigned. Nothing in this repository generates, self-signs, or implies a publisher identity: the workflow only signs when real credentials exist, and the release notes describe the actual result.

Two options, either of which the `windows` job picks up automatically:

**Azure Artifact Signing** (formerly Trusted Signing; needs an Azure subscription and a verified publisher identity — an OV certificate is issued by a CA after business validation):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `AZURE_TRUSTED_CERT_TENANT_ID` | Entra tenant of the app registration |
| secret | `AZURE_TRUSTED_CERT_CLIENT_ID` | App (client) ID, federated to this repo |
| secret | `AZURE_TRUSTED_CERT_SUBSCRIPTION_ID` | Subscription containing the signing account |
| variable | `AZURE_TRUSTED_CERT_ACCOUNT` | Signing account name |
| variable | `AZURE_TRUSTED_CERT_PROFILE` | Certificate profile name |
| variable | `AZURE_TRUSTED_CERT_ENDPOINT` | Optional; defaults to `https://eus.codesigning.azure.net/` and **must match the account's region** |

**A classic Authenticode certificate exported as PFX** (from any public CA):

| Kind | Name |
| --- | --- |
| secret | `WINDOWS_CERT_PFX_BASE64` |
| secret | `WINDOWS_CERT_PASSWORD` |
| variable | `WINDOWS_CERT_TIMESTAMP_URL` — optional, defaults to `http://timestamp.acs.microsoft.com` |

The `windows-signing-available` job reports which mode it found, by presence only; it never echoes a value. Whichever mode is active, the installers are signed on the staged bytes, then `signtool verify /pa /v` and `Get-AuthenticodeSignature` must both report a valid signature before anything is uploaded, and the SHA-256 is taken **after** signing so the published checksum describes the file users actually receive. A signing failure stops the job.

Setting the repository variable `WINDOWS_SIGNING_REQUIRED=true` turns "no credentials" into a build failure instead of a documented unsigned build, and `github-release` refuses to publish when it is set and the artifacts are not signed. Leave it unset while the certificate is still being procured — unsigned builds keep shipping, labelled as unsigned.

Signing removes the "unknown publisher" part of SmartScreen's warning, not necessarily the warning itself: SmartScreen also weighs how much download history a certificate has, so a brand-new certificate can still warn for a while.

The desktop shell serves the bundled UI from a loopback server with its own CSP in `desktop_server.rs`. `connect-src` there has to list every origin the client reaches directly, which today is `api.github.com` for the release lookup on `/download`; `/api` is same-origin through the proxy. The web app's equivalent lives in `vercel.json`. A test compares both against `LATEST_RELEASE_API_URL`, because the two files drift silently otherwise and only the packaged build breaks.

Current environment status: Rustup 1.29.1, Rust 1.99.1 MSVC, and the Visual Studio C++ workload are installed. `npm run tauri:build` produces `VupsRouter_1.0.1_x64-setup.exe` and `VupsRouter_1.0.1_x64_en-US.msi`. The installers are unsigned until one of the two credential sets above exists.

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

CI publishes this file as `VupsRouter-android-test-debug.apk` after `scripts/verify-android-artifact.mjs` has run the official tools against it: `unzip -t` for entry CRCs, `aapt dump badging` for the package id, versionCode, launchable activity and SDK levels, `apksigner verify --verbose --print-certs` for the v1/v2 signature and signer subject, and `zipalign -c -v 4` for alignment. A failure in any of them stops the job — there is no "tool missing, check skipped" path. `scripts/check-capacitor-bundle.mjs` runs after `cap sync` and before Gradle, so a shell that would load a dev host, allow mixed content, or leave the WebView debuggable cannot be packaged at all.

The same script runs on the release build with the opposite certificate expectation: the debug job requires the Android debug key, the release job rejects it. That distinction is the point — a debug-signed APK renamed to look like a release build is exactly how the earlier "app not installed" reports were produced.

For a Play Store release, create a private keystore outside the repository and sign with it. `android/app/build.gradle` reads the release signing configuration from the `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` environment variables and stays unsigned when they are absent, so no build ever silently falls back to the debug key. Never commit a keystore, signing key, or password.

The release identity is fixed and must not change: package `com.vupsrouter.app`, signer `CN=VupsRouter, OU=Releases, O=VupsRouter, C=US`, certificate SHA-256 `486cf30b77ea2cba1ba397b07740fbef62244a8663cc20f91f7c21cd90e2eeb1`. Android resolves an update by package name **and** signing certificate, so installing this build over one signed with any other key — a debug key, or an earlier CI build whose keystore was regenerated — fails with "app not installed" rather than a signature error. The release job passes this SHA-256 to `verify-android-artifact.mjs`, so a rotated or wrong keystore fails before upload instead of shipping an APK existing users cannot install. The keystore lives outside the repository; losing it means losing the ability to update existing installs.

Release artifacts are published by `.github/workflows/native-builds.yml`: pushing a `v*` tag builds the Windows installers and the Android APKs, then `github-release` creates the tag's Release with those assets under their version-free names plus a `SHA256SUMS.txt`. Each build job uploads a second, `*-checks` artifact holding the SHA-256 taken after signing and a small record of what was verified. Before anything is attached, the publish job re-hashes every downloaded file against those checksums and fails if any attached file has no build-time record, so an unsigned or stale artifact left on the tag cannot survive a re-run. A signed `VupsRouter-android-release.apk` is added only when all four repository secrets — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — are set; the `signing-available` job reports presence without echoing any value and skips that build when they are not.

The Android jobs use the Android SDK that ships with the GitHub-hosted ubuntu image and install `platforms;android-35` / `build-tools;35.0.0` through the image's own `sdkmanager`, and the step prints `ANDROID_HOME`, the Java version, and the installed packages on failure. The third-party `android-actions/setup-android` step was removed after it failed the job before Gradle ever ran.

Current environment status: the release-signed APK builds locally with Gradle and JDK 21, passes every check above, installs on a clean Android 15 emulator (`adb install` → `Success`, `versionCode=2`, `signatures=[450b20e]`), and `MainActivity` renders the production sign-in page. The debug APK published earlier was verified to be a structurally valid package too — the "package appears to be invalid" report was an update conflict against a differently-signed install of the same package id, not a corrupt file. A physical-device pass remains outstanding.

## Offline and failure behaviour

- Web: cached navigations and an offline page; `/api/` stays uncached and fails visibly.
- Windows shell: the interface is local to the installer, but `/api` is proxied to the production backend, so chat and sign-in fail without a network connection. The WebView shows the request failure rather than a fabricated cached conversation.
- Android shell: it loads the live production URL, so offline shows the WebView network error rather than a fabricated cached conversation.
- No provider API key is embedded in the desktop or Android project.
- Bundled UI against an older API: the installer ships a client that may call routes the deployed backend does not have. Verified on 2026-10-29 against `https://vups-router-be.onrender.com`, `POST /api/chat/desktop-tools` and `GET /api/auth/usage` both returned `404 {"message":"That API route does not exist."}` because they exist only on the undeployed backend branch. Chat degrades to a plain streaming turn (see "Windows permission modes"), and the sidebar says "Daily usage is not tracked by this server" instead of inventing numbers or showing a permanent error — a 404 there stops the per-minute and per-turn re-requests, because retrying cannot fix a missing route. Either deploy the backend branch or rebuild the installer from a matching pair; a shipped client must never be ahead of the production API in a way that turns a feature gap into "Something went wrong".

## Update flow

- Web: service-worker cache version is in `public/sw.js`; bump it when cache semantics change. Hashed Vite assets are cached at runtime; navigation is network-first, so a new deployment is picked up online.
- Windows/Android: bump `package.json`, `src-tauri/tauri.conf.json`, and `android/app/build.gradle` (`versionName` and `versionCode`, which must increase or existing installs cannot upgrade), then push the matching `v*` tag. The published asset names do not change, so every `releases/latest/download/...` link starts serving the new build on its own; the README and the Download page need no edit per release.
