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

- `Ask me every time` requires approval before any attached local file is sent, and asks again for each local filesystem read. A folder the user marked `Always allow` on a card is the one standing exception; it is listed and revocable in Settings.
- `Agent (workspace)` auto-sends files selected through the folder picker, but asks for individual file picks. Tool reads inside the selected workspace run without a card; any path outside it asks, even a folder allowed in an earlier mode.
- `Full access` requires a separate warning confirmation before it is enabled, then sends any attached file without another prompt. Protected system locations (`C:\Windows`, `Program Files`, `ProgramData`, drive roots, UNC paths) still ask on every call and never get a standing grant.

Enforcement lives in `src-tauri/src/desktop_tools.rs`, not in the selector:

- Every tool call re-reads the stored policy. A request payload cannot carry a mode or owner — `ToolRequest` deserializes only `tool` and `args`, and unknown fields are ignored.
- `desktop_tool_set_policy` is the only way to change the mode. A real change (mode, workspace, or account) bumps a generation counter, denies every card on screen, and clears the task's one-time approvals. A change to a narrower mode also deletes every standing `Always allow` grant for that account, so `Full access` → `Ask me every time` cannot inherit a folder approved a moment earlier. Re-sending the current mode changes nothing.
- Each `desktop_tool_execute` captures the generation before it runs and checks it before the card, after the answer, and immediately before touching the disk. A switch that lands while a card is open returns `policy_changed` instead of reading under the old mode.
- The selector updates only after the native layer has adopted the new mode; a failed switch leaves the previous mode in force and shows the reason. No stored policy (fresh launch before the page installs the saved mode) is a refusal, not a default.
- A workspace that is missing or unreadable is stored as workspace mode with no root, so every path keeps asking; it is never treated as permission for the whole disk.
- Reads stay read-only in all three modes: no shell, writes, deletion, registry access, elevation, or Windows permission bypass exists in the tool set. `workspace_read` (Attach workspace files) is a separate, user-initiated command that only reads inside a workspace the user picked in a native dialog, rejects traversal and symlinks, and never gives the model a new path.

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

### Windows in-app updates

The desktop shell can install the next version from **Settings → Updates** without opening a browser. It is the Tauri v2 updater plugin (`tauri-plugin-updater` + `@tauri-apps/plugin-updater`), configured in `src-tauri/tauri.conf.json` (`plugins.updater`) and wired through `src/native/windowsUpdater.js`. The JS layer only calls the plugin; the manifest fetch and the download happen in Rust, so no update URL is subject to the WebView CSP and no update traffic touches `/api`.

It reads a static JSON manifest published as a release asset:

```text
https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/latest.json
```

The manifest names the version and pairs the installer URL with a **minisign** signature over the exact published bytes. This signature is a second identity, separate from Authenticode: Authenticode (`WINDOWS_CERT_*` / `AZURE_TRUSTED_CERT_*`) is what removes the SmartScreen prompt, while the updater minisign key is what lets the app trust an update. The public half is embedded in `tauri.conf.json` and ships inside the app; only the holder of the private half can publish a manifest the installed app accepts. Losing that private key means every existing install can no longer be updated in place, exactly like the Android release keystore.

Because Authenticode signing rewrites the executable, the updater signature must be made **after** it, over the final bytes — otherwise the app verifies the manifest against a file that no longer matches. So `native-builds.yml` builds with `createUpdaterArtifacts` disabled, runs Authenticode, then a separate step signs the finished installer with `tauri signer sign --app-version <v>` and generates `latest.json` via `scripts/make-updater-manifest.mjs`. The `.sig`, the installer and the manifest are all checksummed after signing, so the publish gate still requires a build-time record for every attached asset.

Two secrets drive it, both read by the `windows` job; either absent means the step is skipped and the app behaves as before (it reports that in-app install is unavailable and offers the release page — no manifest is published, nothing is fabricated):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater **private** key file (`~/.tauri/vupsrouter_updater.key`), stored as a literal string |
| secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password that key was generated with (empty only if the key is unencrypted) |

The matching keypair was generated locally; its **public** key is already committed in `tauri.conf.json`. No private key, password, or signature value is committed or printed anywhere — the workflow reads them as env only and the manifest script logs just the version and output path.

Because the updater ships inside the app, only installs built from the first updater-enabled release onward can update themselves; a desktop build published before this feature has no updater code, so its users install that first updater-enabled build once by hand. `createUpdaterArtifacts` is `false` in the committed config so a plain `npm run tauri:build` works with no key present; CI never enables it, and the manifest signature is produced by the separate post-Authenticode step.

The window permission set that actually applies is the one that owns the window's **origin**, and this app's origin is not the bundled one: `src-tauri/src/desktop_server.rs` binds a loopback listener and opens the window at `http://127.0.0.1:<random port>`, which Tauri treats as a *remote* URL. `capabilities/default.json` is local-only (`"local": true`, no `remote`), so on its own it grants nothing at runtime — that is why `updater:default` and `process:allow-restart` are repeated in `capabilities/desktop-local.json`, the capability whose `remote.urls` match `http://127.0.0.1:*`. A packaged 2.1.0 build that had them only in `default.json` reported `Command plugin:updater|check not allowed by ACL` when **Check for updates** was pressed, while every JS test stayed green because the tests stub the plugin. Test 12 of `test/appUpdates.test.js` now asserts both files, including `local: false` and the loopback URL pattern, so the permission cannot be parked in the file that never applies again. The same audit applied to the 42 commands in `generate_handler!` found no other gap: every one of them is granted by a permission set that `desktop-local.json` already lists, so only the two plugin command groups were affected. After rebuilding and reinstalling, the identical click in the installed app returned `Could not fetch a valid release JSON from the remote` — the updater reached GitHub and reported the real state (no manifest on the newest published release), and `plugin:process|restart` was accepted and the app relaunched itself, which is what **Restart now** does after an install.

Current environment status: the updater is wired and its tests pass, but `TAURI_SIGNING_PRIVATE_KEY` is **not yet configured** on the repository, so `latest.json` is not being published and installed Windows apps cannot update in place yet. It becomes live on the first release built after those two secrets are added. The signing chain itself has been run by hand against the production key: the 2.1.0 installer was signed with `tauri signer sign --app-version 2.1.0`, turned into a manifest by `scripts/make-updater-manifest.mjs`, and re-verified by an independent Node check (self-tested against minisign's reference vector, rejecting a tampered payload) — the signature covers the installer bytes and the `version:2.1.0` trusted comment, the key id matches the pubkey in `tauri.conf.json`, and the manifest carries exactly that signature and version. That same installer was then run over the installed 2.0.1 on this machine: `HKCU\...\Uninstall` `DisplayVersion` became 2.1.0, and the app data under `%APPDATA%\com.vupsrouter.desktop` was byte-identical before and after (same SHA-256 for `workspaces-v1.json` and `desktop-tool-grants.json`, unchanged audit log size). What is still unproven is the *in-app* download-and-install click, because it needs a published manifest for a version newer than the installed one.

### What the installed 2.1.0 app was shown doing

Green tests only prove the code agrees with itself, so on 2026-11-04 the freshly reinstalled 2.1.0 setup was driven over CDP to confirm the behaviour in the artifact users actually run (launch the installed executable with `--remote-debugging-port` **and** a scratch `WEBVIEW2_USER_DATA_FOLDER`; the port never binds against the shared profile). Signed in with a real account, a new task was submitted from the composer: the user bubble rendered immediately, the assistant turn reached the completed state (`vr-msg vr-msg--assistant vr-msg--completed`) carrying the reply, and no error boundary mounted — the black screen on send is not present in the packaged app, which is where the persist-before-load ordering and the turn lifecycle fixes had to be proven rather than unit-tested. Typing `/` as the first token opened the real slash menu with the three commands (`/github`, `/repo`, `/help`), so the GitHub browser entry points ship inside the installer and not only on the website. The mark the packaged shell serves is the new one: `GET /vups-logo-transparent.png` from the app's own loopback origin returned 25709 bytes with SHA-256 `81df82480f5ad1646945bbf5115fe9baa8781931887894e962478510ef03fd0e`, byte-identical to the repository asset. This is one app on one machine; it does not stand in for the updater-manifest step above, which still needs a published release newer than what is installed.

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

Release artifacts are published by `.github/workflows/native-builds.yml`: pushing a `v*` tag builds the Windows installers and the Android APKs, then `github-release` creates the tag's Release with those assets under their version-free names plus a `SHA256SUMS.txt`. Each build job uploads a second, `*-checks` artifact holding the SHA-256 taken after signing and a small record of what was verified. Before anything is attached, the publish job re-hashes every downloaded file against those checksums and fails if any attached file has no build-time record, so an unsigned or stale artifact left on the tag cannot survive a re-run. A signed `VupsRouter-android-release.apk` is built by CI when all four repository secrets — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` — are set; the `signing-available` job reports presence without echoing any value and skips that build when they are not. Those secrets are not configured today, so the v2.0.1 signed APK was built locally with the same fixed keystore, verified with `apksigner`/`aapt`, and attached to the release; when this happens, `SHA256SUMS.txt` must be regenerated over every attached asset.

The Android jobs use the Android SDK that ships with the GitHub-hosted ubuntu image and install `platforms;android-35` / `build-tools;35.0.0` through the image's own `sdkmanager`, and the step prints `ANDROID_HOME`, the Java version, and the installed packages on failure. The third-party `android-actions/setup-android` step was removed after it failed the job before Gradle ever ran.

Current environment status: the v2.0.1 release-signed APK (`versionCode 14`) builds locally with Gradle and JDK 21, passes every check above, and is attached to the `v2.0.1` release. The update path was re-verified end to end on an Android 15 emulator on 2026-11-04 against real artifacts rather than a hand-edited manifest: the baseline install was the published v2.0.1 APK (verified against that release's `SHA256SUMS.txt`), the upgrade was a locally built release-signed 2.1.0 (`versionCode 15`) that passed the pre-publish gate including the pinned certificate SHA-256, and `adb install -r` returned `Success` with the same uid and an unchanged `firstInstallTime` while `lastUpdateTime` advanced and a marker file under `/sdcard/Android/data/com.vupsrouter.app/files` survived — Android applied it over the existing install and kept its data. The negative paths were exercised too: a copy re-signed with the debug key was refused with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` and an older build with `INSTALL_FAILED_VERSION_DOWNGRADE`, each leaving the existing install and its data untouched, which is what the native pre-check in `VupsAppInfoPlugin.java` surfaces in plain language before Android's generic "app not installed". A physical-device pass and the in-app prompt (which needs a published release newer than what is installed, over a website deployment the shell loads remotely) remain outstanding.

## Offline and failure behaviour

- Web: cached navigations and an offline page; `/api/` stays uncached and fails visibly.
- Windows shell: the interface is local to the installer, but `/api` is proxied to the production backend, so chat and sign-in fail without a network connection. The WebView shows the request failure rather than a fabricated cached conversation.
- Android shell: it loads the live production URL, so offline shows the WebView network error rather than a fabricated cached conversation.
- No provider API key is embedded in the desktop or Android project.
- Bundled UI against an older API: the installer ships a client that may call routes the deployed backend does not have. Verified on 2026-10-29 against `https://vups-router-be.onrender.com`, `POST /api/chat/desktop-tools` and `GET /api/auth/usage` both returned `404 {"message":"That API route does not exist."}` because they exist only on the undeployed backend branch. Chat degrades to a plain streaming turn (see "Windows permission modes"), and the sidebar says "Daily usage is not tracked by this server" instead of inventing numbers or showing a permanent error — a 404 there stops the per-minute and per-turn re-requests, because retrying cannot fix a missing route. Either deploy the backend branch or rebuild the installer from a matching pair; a shipped client must never be ahead of the production API in a way that turns a feature gap into "Something went wrong".

## Update flow

- Web: service-worker cache version is in `public/sw.js`; bump it when cache semantics change. Hashed Vite assets are cached at runtime; navigation is network-first, so a new deployment is picked up online.
- Windows/Android: bump `package.json`, `src-tauri/tauri.conf.json`, `android/app/build.gradle` (`versionName` and `versionCode`, which must increase or existing installs cannot upgrade), and the web card version in `src/download/releases.js`, then push the matching `v*` tag. Test 13 of `test/releaseAssets.test.js` fails if those four stop agreeing, so one release number is enforced rather than remembered. The published asset names do not change, so every `releases/latest/download/...` link starts serving the new build on its own; the README and the Download page need no edit per release.
- Android keeps the shell pointed at the live site, so only the UI ever changes between installs; the APK itself updates in place by downloading the release-signed APK and opening the system installer (see the Android release identity above). Windows updates in place only when `latest.json` was published, which requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (see "Windows in-app updates"); without them the desktop app falls back to linking the release page.
