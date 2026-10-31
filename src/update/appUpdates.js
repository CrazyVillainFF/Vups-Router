import {
  LATEST_RELEASE_API_URL,
  RELEASE_ASSETS,
  RELEASES_PAGE_URL
} from "../download/releases.js";

export { LATEST_RELEASE_API_URL, RELEASES_PAGE_URL };

export const UPDATE_REPO_PREFIX = "https://github.com/CrazyVillainFF/Vups-Router/releases/download/";

export function parseVersion(value) {
  const raw = String(value ?? "").trim().replace(/^v/i, "").split("+")[0];
  if (!raw) return { parts: [0], prerelease: "" };
  const dash = raw.indexOf("-");
  const core = dash >= 0 ? raw.slice(0, dash) : raw;
  const prerelease = dash >= 0 ? raw.slice(dash + 1) : "";
  const parts = core.split(".").map(part => {
    const match = /^(\d+)/.exec(part.trim());
    return match ? Number(match[1]) : 0;
  });
  if (parts.length === 0) parts.push(0);
  return { parts, prerelease };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease > b.prerelease ? 1 : -1;
}

export function releaseVersion(release) {
  return typeof release?.tag_name === "string" ? release.tag_name.trim() : "";
}

export function displayVersion(value) {
  return String(value ?? "").trim().replace(/^v/i, "");
}

export function releaseDate(release) {
  const raw = release?.published_at || release?.created_at;
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function releaseNotes(release, limit = 320) {
  const body = typeof release?.body === "string" ? release.body : "";
  const text = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(
      line =>
        line &&
        !line.startsWith("<!--") &&
        !line.startsWith("|") &&
        !/^[-*_]{3,}$/.test(line)
    )
    .map(line => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "• ").replace(/`/g, ""))
    .join(" · ");
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// A release feed is only a pointer to bytes we already trust the repository
// for. Anything that is not a download URL on the official repository is
// ignored rather than followed.
export function isOfficialAssetUrl(url) {
  if (typeof url !== "string" || !url.startsWith(UPDATE_REPO_PREFIX)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

export function selectUpdateAsset(release, platform) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const names =
    platform === "android"
      ? [RELEASE_ASSETS.androidReleaseApk, RELEASE_ASSETS.androidDebugApk]
      : platform === "windows"
        ? [RELEASE_ASSETS.windowsInstaller]
        : [];
  for (const name of names) {
    const asset = assets.find(item => item?.name === name);
    if (!asset) continue;
    if (!isOfficialAssetUrl(asset.browser_download_url)) return null;
    return {
      name: asset.name,
      url: asset.browser_download_url,
      size: Number.isFinite(Number(asset.size)) ? Number(asset.size) : 0,
      debug: name === RELEASE_ASSETS.androidDebugApk
    };
  }
  return null;
}

export function updateAvailability({ currentVersion, latestVersion, platform, release }) {
  if (!latestVersion) {
    return { status: "error", message: "The release feed did not name a version." };
  }
  if (!currentVersion) {
    return { status: "info", latestVersion, asset: selectUpdateAsset(release, platform) };
  }
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { status: "current", latestVersion };
  }
  const asset = selectUpdateAsset(release, platform);
  if (!asset) {
    return {
      status: "available",
      latestVersion,
      asset: null,
      message: "A newer version exists, but no update package is published for this platform yet."
    };
  }
  return { status: "available", latestVersion, asset };
}

export async function checkLatestRelease({ fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(LATEST_RELEASE_API_URL, {
    signal,
    headers: { Accept: "application/vnd.github+json" }
  });
  if (response.status === 404) return { release: null };
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return { release: await response.json() };
}

export function updateErrorMessage(error) {
  const message = String(error?.message || "");
  if (/GitHub responded 403|rate limit/i.test(message)) {
    return "GitHub is rate-limiting update checks. Try again later.";
  }
  if (/GitHub responded 5\d\d/.test(message)) {
    return "The update service is unavailable right now. Try again later.";
  }
  if (/Failed to fetch|NetworkError|Network request failed/i.test(message)) {
    return "Unable to check for updates. Check your connection and try again.";
  }
  return "Unable to check for updates right now.";
}
