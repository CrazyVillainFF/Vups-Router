import { useCallback, useEffect, useState } from "react";
import { LATEST_RELEASE_API_URL } from "./releases.js";

// Reads the newest published GitHub Release. A 404 is the honest answer for
// "nothing published yet", so it is reported as `none` instead of an error.
export default function useGitHubRelease() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ release: null, status: "loading", error: null });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setState(current => ({ ...current, status: "loading", error: null }));

    fetch(LATEST_RELEASE_API_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(response => {
        if (response.status === 404) return { kind: "none" };
        if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
        return response.json().then(release => ({ kind: "release", release }));
      })
      .then(result => {
        if (cancelled) return;
        setState(
          result.kind === "none"
            ? { release: null, status: "none", error: null }
            : { release: result.release, status: "ready", error: null }
        );
      })
      .catch(error => {
        if (cancelled || error?.name === "AbortError") return;
        setState({ release: null, status: "error", error: error?.message || "Release lookup failed" });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt(value => value + 1), []);

  return { ...state, retry };
}
