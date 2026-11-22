import { apiClient } from "../services/api.js";

/**
 * The permission lines of the task log.
 *
 * These sentences are a copy of APPROVAL_ROWS in the backend's taskEvents.js and
 * have to stay identical to it: the app paints a line the moment it observes the
 * transition, and the server's stored row is the same line replayed after a
 * reload. Two wordings for one fact read as two events.
 *
 * Nothing here describes an operation the app did not watch happen. The eight
 * states are all raised from a real observation point - the native card arriving,
 * a decision the native layer accepted, a native cancel that reported the ids it
 * withdrew, the deadline the native layer put on the card.
 */
export const APPROVAL_ROWS = Object.freeze({
  requested: { status: "running", message: "The app asked permission for a local operation." },
  waiting: { status: "running", message: "Waiting for approval." },
  granted: { status: "completed", message: "Approval granted." },
  denied: { status: "cancelled", message: "Approval declined - nothing was run." },
  expired: { status: "cancelled", message: "The approval request expired unanswered." },
  cancelled: { status: "cancelled", message: "The approval request was withdrawn." },
  resumed: { status: "completed", message: "Execution resumed after approval." },
  stopped: { status: "cancelled", message: "Execution stopped after the denial." }
});

export const APPROVAL_STATES = Object.freeze(Object.keys(APPROVAL_ROWS));

// The two states that say what became of the paused call rather than how the
// user voted. They carry their own key so they do not repaint the decision line.
const OUTCOME_STATES = new Set(["resumed", "stopped"]);

const APPROVAL_REQUEST_ID = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * The identity of one permission line, built exactly the way the backend builds
 * it, so the line the app raised and the line the server stored are one line.
 */
export function approvalRowKey(requestId, state = "") {
  const id = String(requestId ?? "").trim();
  if (!APPROVAL_REQUEST_ID.test(id)) return "";
  return OUTCOME_STATES.has(String(state)) ? `approvalex:${id}` : `approval:${id}`;
}

/**
 * A progress row in the shape the task log already uses, or null when the state
 * is not one the app is allowed to claim. `path` is the native request's own
 * target, shown as the row's chip; no other text about the operation travels.
 */
export function approvalProgressRow({ requestId, state = "", path = "" } = {}) {
  const row = APPROVAL_ROWS[String(state)];
  const key = approvalRowKey(requestId, state);
  if (!row || !key) return null;
  return {
    key,
    phase: "approval",
    status: row.status,
    code: `approval:${state}`,
    message: row.message,
    path: String(path ?? "").trim().slice(0, 200)
  };
}

/**
 * Store one permission transition against the run that raised it.
 *
 * The call is the durable half of the line: a row that only lives in this
 * page's state is gone after a reload, which is exactly the gap this closes.
 * Every argument is something the app observed, and the server re-derives the
 * wording from its own table, so nothing typed here becomes stored text.
 *
 * Failure is silent by design. A permission line is a record of what already
 * happened, so a rejected write must not change how the turn itself responds,
 * and the locally painted row still shows the user what they just decided.
 */
export async function reportApprovalEvent({
  runId,
  requestId,
  state = "",
  tool = "",
  path = "",
  conversationId = ""
} = {}) {
  const local = approvalProgressRow({ requestId, state, path });
  const id = String(runId ?? "").trim();
  if (!local || !id) return [];
  try {
    const response = await apiClient.post("/chat/desktop-tools/approvals", {
      runId: id,
      requestId: String(requestId ?? "").trim(),
      state,
      ...(tool ? { tool: String(tool).slice(0, 60) } : {}),
      ...(path ? { path: String(path).slice(0, 200) } : {}),
      ...(conversationId ? { conversationId: String(conversationId) } : {})
    });
    const events = response?.data?.events;
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/**
 * A transition the app saw, painted now and stored when the backend agrees.
 *
 * `paint` puts a row straight into the open turn so the reader does not wait on
 * a network round trip to see the line move; the rows the server confirms then
 * merge onto the same identity, and an unchanged line does not repaint.
 */
export async function trackApprovalTransition(prompt, state, { runId, paint, conversationId = "" } = {}) {
  const local = approvalProgressRow({
    requestId: prompt?.requestId,
    state,
    path: prompt?.scopePath
  });
  if (local) paint([local]);
  const stored = await reportApprovalEvent({
    runId,
    requestId: prompt?.requestId,
    state,
    tool: prompt?.tool,
    path: prompt?.scopePath,
    conversationId
  });
  if (stored.length > 0) paint(stored);
  return stored;
}
