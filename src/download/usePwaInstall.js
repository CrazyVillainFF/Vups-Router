import { useEffect, useState } from "react";

function detectStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
}

export default function usePwaInstall() {
  const [promptEvent, setPromptEvent] = useState(null);
  const [installed, setInstalled] = useState(detectStandalone);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onBeforeInstall(event) {
      event.preventDefault();
      setPromptEvent(event);
    }
    function onInstalled() {
      setInstalled(true);
      setPromptEvent(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!promptEvent || busy) return "unavailable";
    setBusy(true);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      setPromptEvent(null);
      return choice?.outcome === "accepted" ? "accepted" : "dismissed";
    } catch {
      return "unavailable";
    } finally {
      setBusy(false);
    }
  }

  return {
    canInstall: Boolean(promptEvent) && !installed,
    installed,
    busy,
    install
  };
}
