import { apiClient } from "../services/api.js";

export class ComboApiError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "ComboApiError";
    this.status = status;
    this.code = code;
  }
}

function comboBaseURL() {
  const base = apiClient.defaults.baseURL;
  if (!base) {
    throw new ComboApiError("Set VITE_API_BASE_URL to your deployed backend API URL.");
  }
  return String(base).replace(/\/+$/, "");
}

function axiosError(error, fallback) {
  const status = error?.response?.status ?? null;
  const data = error?.response?.data;
  const message =
    (typeof data?.message === "string" && data.message.trim()) ||
    (typeof error?.message === "string" && error.message.trim()) ||
    fallback;
  const code = typeof data?.code === "string" ? data.code : null;
  return new ComboApiError(message, { status, code });
}

export async function fetchComboState() {
  try {
    const { data } = await apiClient.get("/combo");
    return data;
  } catch (error) {
    throw axiosError(error, "Could not load Vups Combo AI.");
  }
}

export async function saveComboState(payload) {
  try {
    const { data } = await apiClient.put("/combo", payload);
    return data;
  } catch (error) {
    throw axiosError(error, "Could not save Vups Combo AI settings.");
  }
}

export async function runComboAvailability({ force = false, keys = null, signal } = {}) {
  try {
    const { data } = await apiClient.post(
      "/combo/availability",
      { ...(force ? { force: true } : {}), ...(Array.isArray(keys) && keys.length > 0 ? { keys } : {}) },
      { signal, timeout: 90000 }
    );
    return data;
  } catch (error) {
    if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError") throw error;
    throw axiosError(error, "Could not check model availability.");
  }
}

// The server clamps a probe to settings.probeTimeoutMs, so the client has to be
// prepared to wait that long plus the round trip. It never cuts a running probe
// short, and it never keeps a spinner alive forever if the request dies.
export function comboTestTimeoutMs(probeTimeoutMs) {
  const probe = Math.max(5000, Math.min(60000, Number(probeTimeoutMs) || 20000));
  return probe + 15000;
}

export async function testComboModel({ key, timeoutMs = 35000, signal } = {}) {
  try {
    const { data } = await apiClient.post("/combo/test", { key }, { signal, timeout: timeoutMs });
    return data;
  } catch (error) {
    if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError") throw error;
    if (error?.code === "ECONNABORTED" || error?.type === "timeout") {
      throw new ComboApiError("The test took too long and was stopped. The model status is unchanged.", {
        code: "test_timeout"
      });
    }
    throw axiosError(error, "Could not test this model.");
  }
}

export function createComboEventParser(onEvent) {
  let buffer = "";
  let terminal = null;
  let lastError = null;
  let lastDone = null;
  let eventCount = 0;

  const dispatch = line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) return null;
    const raw = trimmed.slice(5).trim();
    if (!raw) return null;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
    eventCount += 1;
    if (event.type === "done") {
      terminal = "done";
      lastDone = event;
    }
    if (event.type === "error") {
      terminal = "error";
      lastError = {
        code: typeof event.code === "string" ? event.code : "combo_failed",
        message: typeof event.message === "string" ? event.message : "Vups Combo AI could not complete this run."
      };
    }
    try {
      onEvent?.(event);
    } catch {
      /* A rendering error in a listener must not corrupt stream parsing. */
    }
    return event;
  };

  return {
    push(chunk) {
      buffer += String(chunk || "");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) dispatch(line);
    },
    flush() {
      if (buffer) {
        dispatch(buffer);
        buffer = "";
      }
    },
    get terminal() {
      return terminal;
    },
    get eventCount() {
      return eventCount;
    },
    get lastError() {
      return lastError;
    },
    get lastDone() {
      return lastDone;
    }
  };
}

export async function streamComboChat({
  messages,
  conversationId,
  assistantMessageId,
  signal,
  onEvent
} = {}) {
  let response;
  const body = { messages };
  if (typeof conversationId === "string" && conversationId) body.conversationId = conversationId;
  if (typeof assistantMessageId === "string" && assistantMessageId) body.assistantMessageId = assistantMessageId;
  try {
    response = await fetch(`${comboBaseURL()}/combo/chat`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ComboApiError("Vups Combo AI could not reach the server. Check your connection and try again.");
  }

  if (!response.ok) {
    let message = "Vups Combo AI could not start this run.";
    let code = null;
    try {
      const data = await response.json();
      if (typeof data?.message === "string" && data.message.trim()) message = data.message;
      if (typeof data?.code === "string") code = data.code;
    } catch {
      /* Non-JSON error response. */
    }
    throw new ComboApiError(message, { status: response.status, code });
  }
  if (!response.body) {
    throw new ComboApiError("The Combo run returned an empty response.");
  }

  const parser = createComboEventParser(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.terminal === "done" || parser.terminal === "error") {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ComboApiError("The Combo progress stream was interrupted. Your selections are saved.");
  } finally {
    parser.flush();
  }

  return {
    done: parser.terminal === "done",
    donePayload: parser.lastDone,
    error: parser.lastError,
    events: parser.eventCount
  };
}
