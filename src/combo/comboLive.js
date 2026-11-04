// A Combo run is driven from the chat composer, while the provider network is
// drawn on the Vups Combo AI page. This holds the last events the live
// orchestration reported so the network can show real execution state instead
// of a decorative animation. It carries no credentials and no message bodies.
const EMPTY = () => ({ running: false, stage: null, pool: null, activity: new Map(), meta: null });

let state = EMPTY();
const listeners = new Set();

function notify(listener) {
  try {
    listener(state);
  } catch {
    /* A render error in a subscriber must not break the run. */
  }
}

function emit() {
  for (const listener of listeners) notify(listener);
}

function statusFor(event) {
  if (event.status === "started") return "working";
  if (event.status === "finished") return "done";
  if (event.status === "failed") return "failed";
  return null;
}

export function startComboRun() {
  state = { ...EMPTY(), running: true };
  emit();
}

export function reportComboEvent(event) {
  if (!state.running || !event || typeof event !== "object") return;
  if (event.type === "stage") {
    state = { ...state, stage: { phase: event.phase || "working", message: event.message || "" } };
  } else if (event.type === "pool") {
    const activity = new Map();
    for (const model of Array.isArray(event.active) ? event.active : []) {
      if (model?.key) activity.set(model.key, "queued");
    }
    state = {
      ...state,
      pool: {
        active: Array.isArray(event.active) ? event.active : [],
        excluded: Array.isArray(event.excluded) ? event.excluded : [],
        deferredCount: Number(event.deferredCount) || 0,
        selectedCount: Number(event.selectedCount) || 0
      },
      activity
    };
  } else if (event.type === "model") {
    const status = statusFor(event);
    if (!event.key || !status) return;
    const activity = new Map(state.activity);
    activity.set(event.key, status);
    state = { ...state, activity };
  } else if (event.type === "done") {
    state = { ...state, meta: event, stage: null };
  } else {
    return;
  }
  emit();
}

export function endComboRun() {
  // A finished run is not live processing. Leaving its activity behind would keep
  // the core hot while the page says it is idle, so the network returns to the
  // steady state that availability actually proves.
  state = EMPTY();
  emit();
}

export function currentComboRun() {
  return state;
}

export function subscribeComboRun(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  notify(listener);
  return () => {
    listeners.delete(listener);
  };
}
