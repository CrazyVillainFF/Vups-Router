import { buildContextHandoff } from "./contextLimit.js";

const MAX_TITLE_CHARS = 60;
const TITLE_PREFIX = "Continue: ";

export function continuationTitle(goal = "") {
  const text = String(goal || "").replace(/\s+/g, " ").trim();
  if (!text) return "Continued chat";
  return `${TITLE_PREFIX}${text}`.slice(0, MAX_TITLE_CHARS).trim();
}

/**
 * Builds the bounded handoff and persists it as the first user turn of a new
 * conversation. Copies are withheld from the new chat until persistence
 * succeeds; callers must keep the source conversation intact on failure.
 */
export async function prepareContinuation({
  messages = [],
  sourceId = "",
  modelLabel = "",
  error = null,
  createConversation,
  isUnavailable = () => false
} = {}) {
  if (typeof createConversation !== "function") {
    throw new Error("continuation_unavailable");
  }
  const handoff = buildContextHandoff({ messages, modelLabel, error, sourceId });
  if (!handoff.content.trim()) {
    throw new Error("continuation_empty");
  }
  const title = continuationTitle(handoff.goal);

  let conversation = null;
  try {
    const created = await createConversation({ handoff: handoff.content, title });
    if (!created || typeof created.id !== "string" || !created.id) {
      throw new Error("continuation_not_persisted");
    }
    conversation = created;
  } catch (createError) {
    // Deployments that predate the create endpoint still get the handoff in
    // the first model request, which is persisted with that turn.
    if (!isUnavailable(createError)) throw createError;
  }

  return { handoff, title, conversation };
}

/**
 * A synchronous flag is set before the first await so repeated clicks cannot
 * persist two conversations.
 */
export function createContinuationGuard() {
  let running = false;

  return {
    isRunning() {
      return running;
    },
    async run(task) {
      if (running) return { started: false, value: undefined };
      running = true;
      try {
        return { started: true, value: await task() };
      } finally {
        running = false;
      }
    }
  };
}
