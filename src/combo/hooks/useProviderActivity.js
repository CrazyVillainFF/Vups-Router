import { useMemo } from "react";
import { providerActivityFor, providerStatusFor, providerSummaryFor } from "../comboProviders.js";

// PART of the visualization contract: every visual state must come from something
// the orchestrator actually reported. There is no invented run object here - the
// page already owns two real sources, `availability` (the credential checks the
// server cached) and `activity` (the live per-model map the chat stream writes
// through comboLive), and this hook only joins them per provider.

const LIVE_TO_STATE = {
  queued: "starting",
  working: "running",
  done: "completed",
  failed: "failed"
};

export function providerVisualState(live) {
  return LIVE_TO_STATE[live] || "idle";
}

export default function useProviderActivity({ providers, availability, activity }) {
  return useMemo(() => {
    const list = Array.isArray(providers) ? providers : [];
    const statusById = new Map();
    const liveById = new Map();
    const stateById = new Map();
    const counts = { linked: list.length, running: 0, starting: 0, completed: 0, failed: 0 };
    const runningIds = [];
    const startingIds = [];
    const completedIds = [];
    const failedIds = [];

    for (const provider of list) {
      const live = providerActivityFor(provider, activity);
      const state = providerVisualState(live);
      statusById.set(provider.id, providerStatusFor(provider, availability));
      liveById.set(provider.id, live);
      stateById.set(provider.id, state);
      if (state === "running") {
        counts.running += 1;
        runningIds.push(provider.id);
      } else if (state === "starting") {
        counts.starting += 1;
        startingIds.push(provider.id);
      } else if (state === "completed") {
        counts.completed += 1;
        completedIds.push(provider.id);
      } else if (state === "failed") {
        counts.failed += 1;
        failedIds.push(provider.id);
      }
    }

    const summary = providerSummaryFor(list, availability);
    return {
      statusById,
      liveById,
      stateById,
      counts,
      summary,
      runningIds,
      startingIds,
      completedIds,
      failedIds,
      runActive: list.some(provider => Boolean(liveById.get(provider.id))),
      liveWorking: counts.running
    };
  }, [providers, availability, activity]);
}
